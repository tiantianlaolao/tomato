// 商店层（P4，2026-09-02 商业化 v2）：界面只认这一层，后端两种——
//   mock：浏览器 / 没有内购插件的包。买＝直接落账（tx 空），只在「显示购买（开发）」打开时露出 ¥ 按钮。
//   ios ：StoreKit 2 插件（plugin:iap）。products/purchase/restore 三个命令；成功后拿交易号落账。
// 🔴 落账永远走内核 reward_purchase（幂等），界面不自己改状态；恢复购买＝把商店返回的每个商品再落一遍。
// 🔴 主题锁只在 enforce() 为真时生效：有真商店，或开发开关打开。否则（现在的内测包）日系照旧免费。
(function () {
'use strict';

const T = window.__TAURI__;
const HAS_BRIDGE = !!(T && T.core);
const inv = (cmd, args) => T.core.invoke(cmd, args);
const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);

let backend = 'mock', products = {};   // sku -> {price, displayPrice}

const Store = window.Store = {
  backend: () => backend,
  available: () => backend === 'ios',
  canBuy: () => backend === 'ios' || RW.showBuy(),
  enforce: () => backend === 'ios' || RW.showBuy(),

  // 探测一次：有插件且能拉到商品才算真商店；失败静默回 mock
  async init() {
    if (!HAS_BRIDGE || !isIOS) return backend;
    try {
      const skus = allSkus();
      const r = await inv('plugin:iap|products', { ids: skus });
      (r && r.products || []).forEach(p => { products[p.id] = p; });
      if (Object.keys(products).length) backend = 'ios';
    } catch (e) { backend = 'mock'; }
    return backend;
  },

  // 显示价：真商店用苹果给的本地化价；mock 按语言给 ¥ / $
  price(item) {
    const p = item && item.sku && products[item.sku];
    if (p && p.displayPrice) return p.displayPrice;
    if (!item) return '';
    return (window.I18N && I18N.lang === 'en') ? ('$' + (item.price_usd || 0.99)) : ('¥' + (item.price_cny || 6));
  },

  // 买：kind = theme | towel | prop | visitor；item 来自目录（要有 sku）
  async buy(kind, item, theme) {
    theme = theme || RW.theme;
    if (backend === 'ios') {
      const r = await inv('plugin:iap|purchase', { id: item.sku });
      if (!r || r.state !== 'purchased') throw new Error(r && r.state === 'cancelled' ? '已取消' : '购买没有完成');
      return RW.purchase(kind, item.id, r.transactionId || '', theme);
    }
    return RW.purchase(kind, item.id, '', theme);
  },

  // 恢复购买：商店给回已拥有的商品 id 列表 → 逐个落账（幂等）
  async restore() {
    if (backend !== 'ios') throw new Error('没有可恢复的购买');
    const r = await inv('plugin:iap|restore', {});
    const ids = (r && r.products) || [];
    let n = 0;
    for (const sku of ids) { const m = bySku(sku); if (m) { await RW.purchase(m.kind, m.id, '', m.theme); n++; } }
    return n;
  },
};

function allSkus() {
  const v = RW.view; if (!v) return [];
  const out = [];
  (v.themes || []).forEach(t => t.sku && out.push(t.sku));
  ['towels', 'props', 'visitors'].forEach(k => (v.catalog[k] || []).forEach(x => x.sku && out.push(x.sku)));
  return out;
}
function bySku(sku) {
  // com.tybbtech.capyroom.<theme>.<kind>.<id> / com.tybbtech.capyroom.theme.<id>
  const m = /capyroom\.(theme)\.([\w-]+)$/.exec(sku) || /capyroom\.(\w+)\.(towel|prop|visitor)\.([\w-]+)$/.exec(sku);
  if (!m) return null;
  return m[1] === 'theme' ? { kind: 'theme', id: m[2], theme: RW.theme } : { theme: m[1], kind: m[2], id: m[3] };
}
})();
