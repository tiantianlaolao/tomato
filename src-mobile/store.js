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
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

let backend = 'mock', products = {};   // sku -> {id, displayPrice, price, name}

const Store = window.Store = {
  backend: () => backend,
  available: () => backend === 'ios',
  canBuy: () => backend === 'ios' || RW.showBuy(),
  enforce: () => backend === 'ios' || RW.showBuy(),

  // 探测一次：有插件且能拉到商品才算真商店；失败静默回 mock。
  // 有真商店就顺手把苹果这边已拥有的静默落账（换机/重装/家人共享不用等人点"恢复购买"；幂等）。
  async init() {
    if (!HAS_BRIDGE || !isIOS) return backend;
    try {
      const skus = allSkus();
      const r = await inv('plugin:iap|products', { ids: skus });
      (r && r.products || []).forEach(p => { products[p.id] = p; });
      if (Object.keys(products).length) backend = 'ios';
    } catch (e) { backend = 'mock'; }
    if (backend === 'ios') {
      try { await applyOwned(await inv('plugin:iap|entitlements', {})); } catch (e) { console.warn('iap entitlements', e); }
    }
    return backend;
  },

  // 显示价：真商店用苹果给的本地化价；mock 按语言给 ¥ / $
  price(item) {
    const p = item && item.sku && products[item.sku];
    if (p && p.displayPrice) return p.displayPrice;
    if (!item) return '';
    return (window.I18N && I18N.lang === 'en') ? ('$' + (item.price_usd || 0.99)) : ('¥' + (item.price_cny || 6));
  },

  // 买：kind = theme | towel | towelset | prop | visitor；item 来自目录（要有 sku）
  async buy(kind, item, theme) {
    theme = theme || RW.theme;
    if (backend === 'ios') {
      const r = await inv('plugin:iap|purchase', { id: item.sku });
      if (!r || r.state !== 'purchased') {
        throw new Error(r && r.state === 'cancelled' ? '已取消' : (r && r.state === 'pending' ? '等待批准后自动到账' : '购买没有完成'));
      }
      return RW.purchase(kind, item.id, r.transactionId || '', theme);
    }
    return RW.purchase(kind, item.id, '', theme);
  },

  // 恢复购买：AppStore.sync（会弹 Apple ID）→ 当前凭证 → 逐个落账（幂等）。返回落账条数
  async restore() {
    if (backend !== 'ios') throw new Error('没有可恢复的购买');
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
