// 商店层（P4，2026-09-02 商业化 v2；9-4 接上真商店；9-29 加安卓两条：Play 结算 + 国内支付宝）：界面只认这一层，后端四种——
//   mock  ：浏览器 / 没有商店的包。买＝直接落账（tx 空），只在「显示购买（开发）」打开时露出 ¥ 按钮。
//   ios   ：StoreKit 2 插件（plugins/tauri-plugin-iap，plugin:iap）。products/purchase/restore/entitlements 四个命令；成功后拿交易号落账。
//   play  ：同一个插件的安卓半边（Google Play Billing 7），四条命令同名同形 —— Play 海外包（IS_OVERSEAS）走这条。
//   alipay：国内安卓官网包。买＝服务端建单 → 系统浏览器打开支付宝收银台 → 回 App 轮询到账 → 落账；权益也记在账号上（换机靠 /api/entitlements）。
// 🔴 落账永远走内核 reward_purchase（幂等），界面不自己改状态；恢复购买＝把商店/服务端返回的每个商品再落一遍。
// 🔴 主题锁只在 enforce() 为真时生效：有真商店（iOS / Play / 支付宝），或开发开关打开。否则（没接商店的包）日系照旧免费。
// 🔴 sku 必须能反解成 目录 id（bySku）：商店里的 productId 与 rewards_catalog.json 的 sku 一字不差，
//    否则恢复购买/静默对账落不了账（9-4 发现 ASC 里 stonelamp/cushion2 两个旧 id 对不上目录的 censer/stool）。
// 🔴 支付宝那条：到账只认服务端（notify 验签 / 主动反查），支付宝跳回来那页只是给人看的，不参与判断。
(function () {
'use strict';

const T = window.__TAURI__;
const HAS_BRIDGE = !!(T && T.core);
const inv = (cmd, args) => T.core.invoke(cmd, args);
// 🔴 判 iOS 不能只看 UA（9-18 第二次被拒：审核员用 iPad Air/iPadOS 27）：iPad 上 WKWebView 默认报桌面 UA
//    （"Macintosh"，没有 iPad 字样）→ 旧写法判成"不是 iOS"→ 从不去问苹果、价格按钮全藏、「重连」点了原样不变。
//    src-mobile 只跑在手机壳里：有 Tauri 桥又不是安卓＝iOS。
const isAndroid = HAS_BRIDGE && /Android/i.test(navigator.userAgent);
const isIOS = HAS_BRIDGE ? !isAndroid : /iPhone|iPad|iPod/i.test(navigator.userAgent);
// 安卓分两条：Play 海外包（account.js 的 WEB_BASE 被 CI 换成美服 → IS_OVERSEAS）走 Play 结算；国内官网包走支付宝。
// account.js 在 store.js 之后加载，所以这里现取现用，不在顶层读。
const overseas = () => !!(window.Account && Account.IS_OVERSEAS);
const lane = () => isIOS ? 'ios' : (isAndroid ? (overseas() ? 'play' : 'alipay') : 'mock');
const SKU_PREFIX = 'com.tybbtech.capyroom.';
const TIMEOUT_MS = 15000;
// 商店那边不回话不能让界面一直等（9-18 被拒原文："the app is unresponsive after we tapped the 重连 button"）
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('商店没有回应（' + (ms / 1000) + ' 秒超时）')), ms))]);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let backend = 'mock', products = {};   // sku -> {id, displayPrice, price, name}
let diag = { backend: 'mock', why: '还没探测' };   // init 的结果，调汤里显示
let probing = null;   // 探测进行中的那个 Promise：并发调用共用一次，不叠请求

// 支付宝挂着的订单：付款前记下订单号（裸键、不进同步 —— 它是这台设备这一次的事）
const PAY_K = 'capy_payOrder';
function pendingOrder() { try { const p = JSON.parse(localStorage.getItem(PAY_K) || 'null'); return p && p.no ? p : null; } catch (_) { return null; } }
function savePending(p) { try { if (p) localStorage.setItem(PAY_K, JSON.stringify(p)); else localStorage.removeItem(PAY_K); } catch (_) {} }

const Store = window.Store = {
  lane,
  backend: () => backend,
  available: () => backend === 'ios' || backend === 'play' || backend === 'alipay',
  // 🔴 iOS 壳里价格按钮一律显示，不依赖启动探测（9-16 第一次被拒＝审核员找不到内购：探测没成就整体隐藏）。
  //    价没拉到就显示目录价，点买时插件的 purchase 自己再拉那一件。Play / 支付宝同理：包是哪条线就按哪条线锁。
  canBuy: () => lane() !== 'mock' || RW.showBuy(),
  enforce: () => lane() !== 'mock' || RW.showBuy(),
  onChange: null,   // 探测结果变了（后台重试成功等）→ main.js 刷界面
  onPaid: null,     // 支付宝到账（回前台轮询到 PAID）→ main.js 提示一句

  // 探测：有插件且能拉到商品才算真商店；失败回 mock（按钮照样在，只是用目录价）。
  // tries：启动时 3 次（间隔 2s/5s），「重连」1 次；每次最多等 15 秒。
  // 有真商店就顺手把商店那边已拥有的静默落账（换机/重装/家人共享不用等人点"恢复购买"；幂等）。
  init(tries) {
    if (!probing) probing = this._probe(tries || 3).finally(() => { probing = null; });
    return probing;
  },
  async _probe(tries) {
    const L = lane();
    if (L === 'mock') { diag = { backend, why: HAS_BRIDGE ? '没有商店' : '浏览器' }; return backend; }
    if (L === 'alipay') {
      // 支付宝没有"商品列表"可探：价从目录来。这里只做两件事：查挂着的单、登录了就对一遍服务端权益
      backend = 'alipay'; diag = { backend, why: '' };
      await this.checkPending().catch(() => {});
      await this.refreshEntitlements().catch(() => {});
      if (this.onChange) { try { this.onChange(); } catch (e) {} }
      return backend;
    }
    const skus = allSkus();
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(i === 1 ? 2000 : 5000);
      diag = { backend: 'mock', requested: skus.length, got: 0, why: '' };
      try {
        const r = await withTimeout(inv('plugin:iap|products', { ids: skus }), TIMEOUT_MS);
        (r && r.products || []).forEach(p => { products[p.id] = p; });
        diag.got = Object.keys(products).length;
        if (diag.got) backend = L; else diag.why = (L === 'play' ? 'Google 返回 0 件（商品在 Play Console 没生效 / 这台机不是许可测试账号 / 没装 Play 商店）' : '苹果返回 0 件（商品在 ASC 没生效 / 沙盒未就绪 / 这台机连不上沙盒）');
      } catch (e) {
        // 🔴 拒绝原文必须留下来（9-4 真机"拉不到价格"）：是 ACL 拦了、插件没挂上、还是商店那边报错，三种只能靠这句分
        diag.why = String(e && (e.message || e.code) || e).slice(0, 200);
      }
      if (backend === L) break;
    }
    diag.backend = backend;
    if (backend === L) {
      try { await applyOwned(await withTimeout(inv('plugin:iap|entitlements', {}), TIMEOUT_MS)); } catch (e) { console.warn('iap entitlements', e); }
    }
    if (this.onChange) { try { this.onChange(); } catch (e) {} }
    return backend;
  },
  // 诊断（调汤里显示）：{backend, requested, got, why}
  diag: () => diag,
  // 重连：重新拉一次商品（沙盒登录后、网络恢复后用）。已拿到的价先不清，探测成功才覆盖
  async reconnect() { if (probing) return probing; return this.init(1); },

  // 显示价：真商店用商店给的本地化价；支付宝用目录人民币价；mock 按语言给 ¥ / $
  // 🔴 iOS / Play 壳里商店价没拉到就返回空串（界面显示「买下」不带价）：目录里大多没有美元价，编一个 $0.99 给审核员看＝价签对不上付款面板
  price(item) {
    const p = item && item.sku && products[item.sku];
    if (p && p.displayPrice) return p.displayPrice;
    if (!item) return '';
    const L = lane();
    if (L === 'alipay') return '¥' + (item.price_cny || 0);
    if (L === 'ios' || L === 'play') return '';
    return (window.I18N && I18N.lang === 'en') ? ('$' + (item.price_usd || 0.99)) : ('¥' + (item.price_cny || 6));
  },

  // 买：kind = theme | towel | towelset | prop | visitor；item 来自目录（要有 sku）
  // 返回内核视图；支付宝那条返回 {pending:true}（已打开收银台，到账另走 checkPending → onPaid）
  async buy(kind, item, theme) {
    theme = theme || RW.theme;
    const L = lane();
    // 有商店的包绝不走 mock 落账（按钮现在一律露出，没有 sku 的也不能白给）
    if (L === 'ios' || L === 'play') {
      if (!item || !item.sku) throw new Error('购买没有完成');
      const r = await inv('plugin:iap|purchase', { id: item.sku });
      if (!r || r.state !== 'purchased') {
        throw new Error(r && r.state === 'cancelled' ? '已取消' : (r && r.state === 'pending' ? '等待批准后自动到账' : '购买没有完成'));
      }
      if (backend !== L) this.init(1).catch(() => {});   // 买成了说明商店是通的，顺手把价补齐
      return RW.purchase(kind, item.id, r.transactionId || '', theme);
    }
    if (L === 'alipay') {
      if (!item || !item.sku) throw new Error('购买没有完成');
      if (!window.Account || !Account.isLoggedIn()) throw new Error('先在「账号」里登录，买过的才找得回来');
      const r = await Account.net.payCreate(Account.account.token, skuToProduct(item.sku), 'alipay_wap');
      if (!r) throw new Error('网络不通，稍后再试');
      if (r.http === 501) throw new Error('支付还没开通，稍后再试');
      if (r.http === 401) throw new Error('登录过期了，重新登录再试');
      if (r.http !== 200 || !r.payUrl) throw new Error('没能建单，稍后再试');
      savePending({ no: r.orderNo, at: Date.now(), kind, id: item.id, theme });
      try { await inv('plugin:opener|open_url', { url: r.payUrl }); }
      catch (e) { savePending(null); throw new Error('打不开支付页：' + String(e && (e.message || e) || '').slice(0, 120)); }
      return { pending: true, orderNo: r.orderNo };
    }
    return RW.purchase(kind, item.id, '', theme);
  },

  // 恢复购买：iOS = AppStore.sync（会弹 Apple ID）→ 当前凭证；Play = queryPurchases（不弹）；支付宝 = 服务端权益。逐个落账（幂等）。返回落账条数
  async restore() {
    const L = lane();
    if (L === 'alipay') {
      if (!window.Account || !Account.isLoggedIn()) throw new Error('先在「账号」里登录，买过的才找得回来');
      const n = await this.refreshEntitlements();
      if (n === null) throw new Error('网络不通，稍后再试');
      return n;
    }
    if (L !== 'ios' && L !== 'play') throw new Error('没有可恢复的购买');
    return applyOwned(await inv('plugin:iap|restore', {}));
  },

  // ---- 支付宝：回前台 / 开机 / 登录后查挂着的单 ----
  // 到账 → 落账 + onPaid；关单或查无此单 → 清掉。最多试四次（0/1.5/3/5 秒）：支付宝 notify 通常付完一两秒就到，服务端查单时还会主动反查一次。
  _checking: false,
  async checkPending() {
    const p = pendingOrder();
    if (!p || this._checking) return false;
    if (Date.now() - (p.at || 0) > 2 * 3600e3) { savePending(null); return false; }   // 两小时没下文 = 放弃了
    if (!window.Account || !Account.isLoggedIn()) return false;
    this._checking = true;
    try {
      for (const wait of [0, 1500, 3000, 5000]) {
        if (wait) await sleep(wait);
        const r = await Account.net.payOrder(Account.account.token, p.no);
        if (!r) return false;                                            // 网不通，下次再说
        if (r.http === 404 || r.status === 'CLOSED') { savePending(null); return false; }
        if (r.http === 200 && r.status === 'PAID') {
          savePending(null);
          await RW.purchase(p.kind, p.id, r.tradeNo || p.no, p.theme);
          if (this.onPaid) { try { this.onPaid(p); } catch (e) {} }
          if (this.onChange) { try { this.onChange(); } catch (e) {} }
          return true;
        }
      }
      return false;
    } finally { this._checking = false; }
  },
  // 服务端权益 → 逐条落账（幂等）。返回落账条数；网不通返回 null。登录后 / 开机 / 恢复购买都走这条
  async refreshEntitlements() {
    if (lane() !== 'alipay' || !window.Account || !Account.isLoggedIn()) return 0;
    const r = await Account.net.entitlements(Account.account.token);
    if (!r) return null;
    if (r.http !== 200) return 0;
    let n = 0;
    for (const it of (r.items && r.items.length ? r.items : (r.products || []).map(p => ({ product: p, orderNo: '' })))) {
      const m = bySku(SKU_PREFIX + it.product);
      if (!m) { if (it.product !== 'test001') console.warn('pay: 目录里没有这个商品', it.product); continue; }
      await RW.purchase(m.kind, m.id, it.orderNo || '', m.theme); n++;
    }
    if (n) RW.load().catch(() => {});
    return n;
  },
  hasPending: () => !!pendingOrder(),
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

// 回到前台：iOS/Play 还没连上就再探一次（审核员/用户可能刚登了沙盒账户、刚连上网）；支付宝查挂着的单
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !HAS_BRIDGE || !window.RW || !RW.view) return;
  const L = lane();
  if (L === 'alipay') { Store.checkPending().catch(() => {}); return; }
  if ((L === 'ios' || L === 'play') && backend !== L && !probing) Store.init(1).catch(() => {});
});

function allSkus() {
  const v = RW.view; if (!v) return [];
  const out = [];
  (v.themes || []).forEach(t => t.sku && out.push(t.sku));
  ['towels', 'props', 'visitors'].forEach(k => (v.catalog[k] || []).forEach(x => x.sku && out.push(x.sku)));
  if (v.catalog.towel_set && v.catalog.towel_set.sku) out.push(v.catalog.towel_set.sku);
  return out;
}
// 服务端商品 id = sku 去掉前缀（theme.onsen）
const skuToProduct = sku => String(sku || '').startsWith(SKU_PREFIX) ? sku.slice(SKU_PREFIX.length) : sku;
function bySku(sku) {
  // com.tybbtech.capyroom.theme.<id> / com.tybbtech.capyroom.<theme>.towelset / com.tybbtech.capyroom.<theme>.<kind>.<id>
  let m;
  if ((m = /capyroom\.theme\.([\w-]+)$/.exec(sku))) return { kind: 'theme', id: m[1], theme: RW.theme };
  if ((m = /capyroom\.(\w+)\.towelset$/.exec(sku))) return { kind: 'towelset', id: 'set', theme: m[1] };
  if ((m = /capyroom\.(\w+)\.(towel|prop|visitor)\.([\w-]+)$/.exec(sku))) return { theme: m[1], kind: m[2], id: m[3] };
  return null;
}
})();
