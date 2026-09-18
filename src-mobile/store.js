// 商店层（P4，2026-09-02 商业化 v2；9-4 接上真商店）：界面只认这一层，后端两种——
//   mock：浏览器 / 没有内购插件的包。买＝直接落账（tx 空），只在「显示购买（开发）」打开时露出 ¥ 按钮。
//   ios ：StoreKit 2 插件（plugins/tauri-plugin-iap，plugin:iap）。products/purchase/restore/entitlements 四个命令；
//         成功后拿交易号落账。
// 🔴 落账永远走内核 reward_purchase（幂等），界面不自己改状态；恢复购买＝把商店返回的每个商品再落一遍。
// 🔴 主题锁只在 enforce() 为真时生效：有真商店，或开发开关打开。否则（没接商店的包）日系照旧免费。
// 🔴 sku 必须能反解成 目录 id（bySku）：ASC 里的 productId 与 rewards_catalog.json 的 sku 一字不差，
//    否则恢复购买/静默对账落不了账（9-4 发现 ASC 里 stonelamp/cushion2 两个旧 id 对不上目录的 censer/stool）。
(function () {
'use strict';

const T = window.__TAURI__;
const HAS_BRIDGE = !!(T && T.core);
const inv = (cmd, args) => T.core.invoke(cmd, args);
// 🔴 判 iOS 不能只看 UA（9-18 第二次被拒：审核员用 iPad Air/iPadOS 27）：iPad 上 WKWebView 默认报桌面 UA
//    （"Macintosh"，没有 iPad 字样）→ 旧写法判成"不是 iOS"→ 从不去问苹果、价格按钮全藏、「重连」点了原样不变。
//    src-mobile 只跑在手机壳里：有 Tauri 桥又不是安卓＝iOS。
const isIOS = HAS_BRIDGE ? !/Android/i.test(navigator.userAgent) : /iPhone|iPad|iPod/i.test(navigator.userAgent);
const TIMEOUT_MS = 15000;
// 苹果那边不回话不能让界面一直等（9-18 被拒原文："the app is unresponsive after we tapped the 重连 button"）
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('苹果没有回应（' + (ms / 1000) + ' 秒超时）')), ms))]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let backend = 'mock', products = {};   // sku -> {id, displayPrice, price, name}
let diag = { backend: 'mock', why: '还没探测' };   // init 的结果，调汤里显示
let probing = null;   // 探测进行中的那个 Promise：并发调用共用一次，不叠请求

const Store = window.Store = {
  backend: () => backend,
  available: () => backend === 'ios',
  // 🔴 iOS 壳里价格按钮一律显示，不依赖启动探测（9-16 第一次被拒＝审核员找不到内购：探测没成就整体隐藏）。
  //    价没拉到就显示目录价，点买时 Swift 的 purchase 自己再拉那一件。
  canBuy: () => backend === 'ios' || isIOS || RW.showBuy(),
  enforce: () => backend === 'ios' || isIOS || RW.showBuy(),
  onChange: null,   // 探测结果变了（后台重试成功等）→ main.js 刷界面

  // 探测：有插件且能拉到商品才算真商店；失败回 mock（iOS 上按钮照样在，只是用目录价）。
  // tries：启动时 3 次（间隔 2s/5s），「重连」1 次；每次最多等 15 秒。
  // 有真商店就顺手把苹果这边已拥有的静默落账（换机/重装/家人共享不用等人点"恢复购买"；幂等）。
  init(tries) {
    if (!probing) probing = this._probe(tries || 3).finally(() => { probing = null; });
    return probing;
  },
  async _probe(tries) {
    if (!HAS_BRIDGE || !isIOS) { diag = { backend, why: HAS_BRIDGE ? '不是 iOS' : '浏览器' }; return backend; }
    const skus = allSkus();
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(i === 1 ? 2000 : 5000);
      diag = { backend: 'mock', requested: skus.length, got: 0, why: '' };
      try {
        const r = await withTimeout(inv('plugin:iap|products', { ids: skus }), TIMEOUT_MS);
        (r && r.products || []).forEach(p => { products[p.id] = p; });
        diag.got = Object.keys(products).length;
        if (diag.got) backend = 'ios'; else diag.why = '苹果返回 0 件（商品在 ASC 没生效 / 沙盒未就绪 / 这台机连不上沙盒）';
      } catch (e) {
        // 🔴 拒绝原文必须留下来（9-4 真机"拉不到价格"）：是 ACL 拦了、插件没挂上、还是苹果那边报错，三种只能靠这句分
        diag.why = String(e && (e.message || e.code) || e).slice(0, 200);
      }
      if (backend === 'ios') break;
    }
    diag.backend = backend;
    if (backend === 'ios') {
      try { await applyOwned(await withTimeout(inv('plugin:iap|entitlements', {}), TIMEOUT_MS)); } catch (e) { console.warn('iap entitlements', e); }
    }
    if (this.onChange) { try { this.onChange(); } catch (e) {} }
    return backend;
  },
  // 诊断（调汤里显示）：{backend, requested, got, why}
  diag: () => diag,
  // 重连：重新拉一次商品（沙盒登录后、网络恢复后用）。已拿到的价先不清，探测成功才覆盖
  async reconnect() { if (probing) return probing; return this.init(1); },

  // 显示价：真商店用苹果给的本地化价；mock 按语言给 ¥ / $
  // 🔴 iOS 壳里苹果价没拉到就返回空串（界面显示「买下」不带价）：目录里大多没有美元价，编一个 $0.99 给审核员看＝价签对不上付款面板
  price(item) {
    const p = item && item.sku && products[item.sku];
    if (p && p.displayPrice) return p.displayPrice;
    if (!item || (HAS_BRIDGE && isIOS)) return '';
    return (window.I18N && I18N.lang === 'en') ? ('$' + (item.price_usd || 0.99)) : ('¥' + (item.price_cny || 6));
  },

  // 买：kind = theme | towel | towelset | prop | visitor；item 来自目录（要有 sku）
  async buy(kind, item, theme) {
    theme = theme || RW.theme;
    // iOS 壳：探测没成也直接走苹果（Swift purchase 自己按 sku 拉商品），不因为启动时没拉到价就只能假买
    // 🔴 iOS 壳上绝不走 mock 落账（按钮现在一律露出，没有 sku 的也不能白给）
    if (backend === 'ios' || isIOS) {
      if (!item || !item.sku) throw new Error('购买没有完成');
      const r = await inv('plugin:iap|purchase', { id: item.sku });
      if (!r || r.state !== 'purchased') {
        throw new Error(r && r.state === 'cancelled' ? '已取消' : (r && r.state === 'pending' ? '等待批准后自动到账' : '购买没有完成'));
      }
      if (backend !== 'ios') this.init(1).catch(() => {});   // 买成了说明商店是通的，顺手把价补齐
      return RW.purchase(kind, item.id, r.transactionId || '', theme);
    }
    return RW.purchase(kind, item.id, '', theme);
  },

  // 恢复购买：AppStore.sync（会弹 Apple ID）→ 当前凭证 → 逐个落账（幂等）。返回落账条数
  async restore() {
    if (backend !== 'ios' && !isIOS) throw new Error('没有可恢复的购买');
    return applyOwned(await inv('plugin:iap|restore', {}));
  },
};

// 把插件回的 {products:[sku], items:[{productId, transactionId}]} 逐条落账；认不出的 sku 跳过
async function applyOwned(r) {
  const items = (r && r.items && r.items.length) ? r.items
    : ((r && r.products) || []).map(sku => ({ productId: sku, transactionId: '' }));
  let n = 0;
  for (const it of items) {
    const m = bySku(it.productId);
    if (!m) { console.warn('iap: 目录里没有这个 sku', it.productId); continue; }
    await RW.purchase(m.kind, m.id, it.transactionId || '', m.theme); n++;
  }
  if (n) RW.load().catch(() => {});
  return n;
}

// 回到前台还没连上就再探一次（审核员/用户可能刚登了沙盒账户、刚连上网）
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && isIOS && HAS_BRIDGE && backend !== 'ios' && !probing && window.RW && RW.view) Store.init(1).catch(() => {});
});

function allSkus() {
  const v = RW.view; if (!v) return [];
  const out = [];
  (v.themes || []).forEach(t => t.sku && out.push(t.sku));
  ['towels', 'props', 'visitors'].forEach(k => (v.catalog[k] || []).forEach(x => x.sku && out.push(x.sku)));
  if (v.catalog.towel_set && v.catalog.towel_set.sku) out.push(v.catalog.towel_set.sku);
  return out;
}
function bySku(sku) {
  // com.tybbtech.capyroom.theme.<id> / com.tybbtech.capyroom.<theme>.towelset / com.tybbtech.capyroom.<theme>.<kind>.<id>
  let m;
  if ((m = /capyroom\.theme\.([\w-]+)$/.exec(sku))) return { kind: 'theme', id: m[1], theme: RW.theme };
  if ((m = /capyroom\.(\w+)\.towelset$/.exec(sku))) return { kind: 'towelset', id: 'set', theme: m[1] };
  if ((m = /capyroom\.(\w+)\.(towel|prop|visitor)\.([\w-]+)$/.exec(sku))) return { theme: m[1], kind: m[2], id: m[3] };
  return null;
}
})();
