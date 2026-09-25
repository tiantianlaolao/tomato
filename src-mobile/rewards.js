// P3 奖励载体 · 前端数据层（2026-09-02；9-25 改商业化 v3：物件不卖、四条线解锁，见 商业化方案说明书v3.md）
//
// 只做三件事：①从内核取视图（账本/状态/目录）②把解锁/摆放/挂巾转发给内核 ③给完成卡片一句进度。
// 浏览器验收（无桥）走 DEMO：从同一份 rewards_catalog.json 读目录，账本和状态是编的，
// 改起来只能改这里，别在页面里散写假数据。
//
// 🔴 规矩：工作段不显示任何奖励进度（红线一）——本模块不管画面，只管数据；谁调用谁负责时机。
(function () {
'use strict';

const T = window.__TAURI__;
const HAS_BRIDGE = !!(T && T.core);
const inv = (cmd, args) => T.core.invoke(cmd, args);

const RW = window.RW = {
  theme: 'ink',
  view: null,            // {ledger, state, catalog}
  listeners: [],
  showBuy() { try { return localStorage.getItem('capy_dev_buy') === '1' || new URLSearchParams(location.search).get('buy') === '1'; } catch (e) { return false; } },
  setShowBuy(on) { try { localStorage.setItem('capy_dev_buy', on ? '1' : '0'); } catch (e) {} },

  onChange(fn) { this.listeners.push(fn); },
  _set(v) { this.view = v; this.listeners.forEach(f => { try { f(v); } catch (e) {} }); return v; },

  async load(theme) {
    if (theme) this.theme = theme;
    if (HAS_BRIDGE) return this._set(await inv('get_rewards', { theme: this.theme }));
    return this._set(await demoView(this.theme));
  },
  async unlock(kind, id, via) {
    if (HAS_BRIDGE) return this._set(await inv('reward_unlock', { theme: this.theme, kind, id, via }));
    return this._set(demoUnlock(this.view, kind, id, via));
  },
  async place(slot, id) {
    if (HAS_BRIDGE) return this._set(await inv('reward_place', { theme: this.theme, slot, id }));
    return this._set(demoPlace(this.view, slot, id));
  },
  async hang(id) {
    if (HAS_BRIDGE) return this._set(await inv('reward_hang', { theme: this.theme, id }));
    this.view.state.hung = id; return this._set(this.view);
  },
  // P4 真钱落账（幂等）：kind = theme | towel | prop | visitor；tx = 商店交易号
  async purchase(kind, id, tx, theme) {
    theme = theme || this.theme;
    if (HAS_BRIDGE) return this._set(await inv('reward_purchase', { theme, kind, id, tx: tx || '' }));
    if (kind === 'theme') { if (!this.view.owned_themes.includes(id)) this.view.owned_themes.push(id); return this._set(this.view); }
    if (kind === 'towelset') {   // 老的整套购买（9-25 起不再卖，恢复购买仍认）：八条逐条按 buy 落账，已有的跳过（与内核同语义）
      (this.view.catalog.towels || []).forEach(t => { try { demoUnlock(this.view, 'towel', t.id, 'buy'); } catch (e) {} });
      return this._set(this.view);
    }
    try { return this._set(demoUnlock(this.view, kind, id, 'buy')); } catch (e) { return this.view; }
  },
  // 内测包专属：全部解锁 / 撤回（交易号 internal，不碰攒来的和真买的）。浏览器 DEMO 里也能演。
  internal: (function () { try { return new URLSearchParams(location.search).get('internal') === '1'; } catch (e) { return false; } })(),   // boot 时由内核告知（CAPY_INTERNAL 编进包），浏览器可用 ?internal=1
  async grantAll() {
    if (HAS_BRIDGE) return this._set(await inv('reward_grant_all', { theme: this.theme }));
    const v = this.view, cat = v.catalog;
    (v.themes || []).forEach(t => { if (t.paid && !v.owned_themes.includes(t.id)) v.owned_themes.push(t.id); });
    [['towel', 'towels'], ['prop', 'props'], ['visitor', 'visitors']].forEach(([k, l]) => (cat[l] || []).forEach(x => { try { demoUnlock(v, k, x.id, 'buy'); } catch (e) {} }));
    return this._set(v);
  },
  async revokeInternal() {
    if (HAS_BRIDGE) return this._set(await inv('reward_revoke_internal', { theme: this.theme }));
    return this.load();
  },
  ownsTheme(id) { const t = this.themeInfo(id); return !t || !t.paid || (this.view && (this.view.owned_themes || []).includes(id)); },
  themeInfo(id) { return ((this.view && this.view.themes) || []).find(t => t.id === id) || null; },

  // 目录小工具
  cat(list, id) { const c = this.view && this.view.catalog; return ((c && c[list]) || []).find(x => x.id === id) || null; },
  owned(kind, id) {
    const s = this.view && this.view.state; if (!s) return false;
    const arr = kind === 'towel' ? s.towels : kind === 'prop' ? s.props : s.visitors;
    return (arr || []).includes(id);
  },
  placedAt(slot) { const s = this.view && this.view.state; return (s && s.placed && s.placed[slot]) || ''; },

  // ── 9-25 商业化 v3：四条线解锁（与内核 rewards.rs gap() 同口径；这里给暗色物件显示"还差什么"用）──
  //   gift 见面礼 / focus 累计专注分钟 / rest 累计实际休息分钟 / days 来访天数 / long 单场专注≥60 分钟的次数
  gap(item) {
    const L = (this.view && this.view.ledger) || {}, n = item.n || 0;
    const hm = (m) => m >= 60 ? (Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '')) : (m + ' 分钟');
    switch (item.line) {
      case 'gift': return '';
      case 'focus': return (L.total_min || 0) >= n ? '' : '再专注 ' + hm(n - (L.total_min || 0));
      case 'rest': return (L.rest_min || 0) >= n ? '' : '再好好休息 ' + hm(n - (L.rest_min || 0));
      case 'days': return (L.visit_days || 0) >= n ? '' : '再来 ' + (n - (L.visit_days || 0)) + ' 天';
      case 'long': return (L.long_count || 0) >= n ? '' : '再来 ' + (n - (L.long_count || 0)) + ' 次 60 分钟以上的长专注';
      default: return '还没到解锁条件';
    }
  },
  // 物件的四种状态：placed 摆着/挂着 · own 已领 · ready 能领 · locked 还没到
  stateOf(kind, item) {
    const s = (this.view && this.view.state) || {};
    if (kind === 'towel' ? s.hung === item.id : Object.values(s.placed || {}).includes(item.id)) return 'placed';
    if (this.owned(kind, item.id)) return 'own';
    return this.gap(item) ? 'locked' : 'ready';
  },
  // 能领还没领的（手拭巾 + 小物）
  claimable() {
    const c = (this.view && this.view.catalog) || {};
    return [...(c.towels || []).map(x => ['towel', x]), ...(c.props || []).map(x => ['prop', x])]
      .filter(([k, x]) => this.stateOf(k, x) === 'ready').map(([k, x]) => ({ kind: k, item: x }));
  },
  // 休息开始时的轻提示：同一批只提示一次（按主题记已提示过的 id；本机便利，读写失败就当没提示过）
  unnoticed() {
    let seen = [];
    try { seen = JSON.parse(localStorage.getItem('capy_rw_noticed_' + this.theme) || '[]'); } catch (e) {}
    return this.claimable().filter(c => !seen.includes(c.item.id));
  },
  markNoticed(list) {
    try {
      const k = 'capy_rw_noticed_' + this.theme, seen = JSON.parse(localStorage.getItem(k) || '[]');
      list.forEach(c => { if (!seen.includes(c.item.id)) seen.push(c.item.id); });
      localStorage.setItem(k, JSON.stringify(seen));
    } catch (e) {}
  },

  // 完成卡片那一句：有能领的就说"新到"；没有就说离下一条手拭巾还差多少。没有目录就不说话（别许愿）。
  progressLine() {
    const v = this.view; if (!v || !v.catalog) return '';
    const ready = this.claimable();
    if (ready.length) return '新到：' + ready.slice(0, 3).map(c => c.item.name).join('、') + (ready.length > 3 ? ' 等 ' + ready.length + ' 件' : '');
    const next = (v.catalog.towels || []).find(t => this.stateOf('towel', t) === 'locked');
    return next ? ('手拭巾·' + next.name + ' ' + this.gap(next)) : '';
  },
};

// ── 无桥 DEMO ──────────────────────────────────────
let catalogAll = null;
async function catalog() {
  if (catalogAll) return catalogAll;
  try { catalogAll = await (await fetch('assets/rewards_catalog.json')).json(); }
  catch (e) { catalogAll = {}; }
  return catalogAll;
}
// 按天分钟表（汤札周牌/小牌墙用）：近 300 天里约六成的日子有记录，分钟 25/50/75 轮着来（确定性，截图稳定）
function demoDays() {
  const out = {}, t = new Date(); t.setHours(0, 0, 0, 0);
  for (let i = 0; i < 300; i++) {
    const d = new Date(t); d.setDate(d.getDate() - i);
    if ((i * 7 + 3) % 10 < 6) out[d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')] = 25 * (1 + (i % 3));
  }
  return out;
}
async function demoView(theme) {
  const all = await catalog();
  const cat = all[theme] || { slots: [], towels: [], props: [], visitors: [] };
  const q = new URLSearchParams(location.search);
  const empty = q.get('rw') === 'empty';
  const ledger = empty
    ? { total_min: 0, spent_min: 0, avail_min: 0, sessions_done: 0, visit_days: 0, rest_min: 0, long_count: 0, month: '2026-09', month_days: [] }
    : { total_min: 400, spent_min: 0, avail_min: 400, sessions_done: 17, visit_days: 9, rest_min: 45, long_count: 1, month: '2026-09', month_days: [1, 2, 3, 5, 8, 9, 12, 15, 16], days: demoDays() };
  const full = q.get('rw') === 'full';   // 五个槽位全摆满，看位置用
  const full2 = q.get('rw') === 'full2'; // 另一组（茶盘/蒲团/锦鲤/梅枝巾），每个槽位两件轮着看
  const state = empty
    ? { towels: [], hung: '', props: [], placed: {}, visitors: [], purchases: [] }
    : full
    ? { towels: ['t01', 't02', 't03'], hung: 't03', props: ['windbell', 'orchid', 'censer', 'lotus', 'tibi'],
        placed: { willow: 'windbell', lamp_side: 'orchid', pool_edge: 'censer', water_near: 'lotus', wall: 'tibi' }, visitors: ['v01'], purchases: [] }
    : full2
    ? { towels: ['t06', 't08'], hung: 't06', props: ['windbell', 'stool', 'teatray', 'censer', 'koi', 'tibi'],
        placed: { willow: 'windbell', lamp_side: 'stool', floor_mid: 'teatray', pool_edge: 'censer', water_near: 'koi', wall: 'tibi' }, visitors: [], purchases: [] }
    : { towels: ['t01', 't02'], hung: 't02', props: ['windbell', 'teatray'], placed: { willow: 'windbell', floor_mid: 'teatray' }, visitors: [], purchases: [] };   // 默认：还有几件"能领"（兰/题壁字/荷花/缠枝莲/鱼戏）
  return { ledger, state, catalog: cat, owned_themes: q.get('rw') === 'owned' ? ['onsen'] : [], themes: all.themes || [] };
}
function demoUnlock(v, kind, id, via) {
  const s = v.state, L = v.ledger;
  const list = kind === 'towel' ? s.towels : kind === 'prop' ? s.props : s.visitors;
  if (list.includes(id)) throw new Error('已经有了');
  const item = RW.cat(kind === 'towel' ? 'towels' : kind === 'prop' ? 'props' : 'visitors', id);
  if (via === 'earn') {
    const g = RW.gap(item); if (g) throw new Error(g);   // 与内核 gap() 同口径
  } else s.purchases.push({ sku: kind + '.' + id, at: Date.now() });
  list.push(id);
  if (kind === 'towel' && !s.hung) s.hung = id;
  if (kind === 'prop' && item.slot && !s.placed[item.slot]) s.placed[item.slot] = id;   // 槽位空着→自动摆上
  return v;
}
function demoPlace(v, slot, id) {
  const s = v.state;
  if (!id) { delete s.placed[slot]; return v; }
  for (const k in s.placed) if (s.placed[k] === id) delete s.placed[k];
  s.placed[slot] = id; return v;
}
})();
