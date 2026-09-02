// P3 奖励载体 · 前端数据层（2026-09-02，定案见 P3奖励载体玩法定义.md）
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
  showBuy() { try { return localStorage.getItem('capy_dev_buy') === '1'; } catch (e) { return false; } },
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

  // 目录小工具
  cat(list, id) { const c = this.view && this.view.catalog; return ((c && c[list]) || []).find(x => x.id === id) || null; },
  owned(kind, id) {
    const s = this.view && this.view.state; if (!s) return false;
    const arr = kind === 'towel' ? s.towels : kind === 'prop' ? s.props : s.visitors;
    return (arr || []).includes(id);
  },
  placedAt(slot) { const s = this.view && this.view.state; return (s && s.placed && s.placed[slot]) || ''; },

  // 完成卡片那一句：下一条手拭巾还差多少；全拿到了就说小物。没有目录就不说话（别许愿）。
  progressLine() {
    const v = this.view; if (!v || !v.catalog) return '';
    const L = v.ledger;
    const next = (v.catalog.towels || []).find(t => !this.owned('towel', t.id));
    if (next) {
      const gap = next.min - L.total_min;
      return gap > 0 ? ('手拭巾·' + next.name + ' 还差 ' + gap + ' 分钟') : ('手拭巾·' + next.name + ' 可以领了');
    }
    return '可用 ' + L.avail_min + ' 分钟';
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
async function demoView(theme) {
  const all = await catalog();
  const cat = all[theme] || { slots: [], towels: [], props: [], visitors: [] };
  const q = new URLSearchParams(location.search);
  const empty = q.get('rw') === 'empty';
  const ledger = empty
    ? { total_min: 0, spent_min: 0, avail_min: 0, sessions_done: 0, visit_days: 0, month: '2026-09', month_days: [] }
    : { total_min: 400, spent_min: 120, avail_min: 280, sessions_done: 17, visit_days: 9, month: '2026-09', month_days: [1, 2, 3, 5, 8, 9, 12, 15, 16] };
  const state = empty
    ? { towels: [], hung: '', props: [], placed: {}, visitors: [], purchases: [] }
    : { towels: ['t01', 't02'], hung: 't02', props: ['windbell', 'orchid'], placed: { willow: 'windbell' }, visitors: [], purchases: [] };
  return { ledger, state, catalog: cat };
}
function demoUnlock(v, kind, id, via) {
  const s = v.state, L = v.ledger;
  const list = kind === 'towel' ? s.towels : kind === 'prop' ? s.props : s.visitors;
  if (list.includes(id)) throw new Error('已经有了');
  const item = RW.cat(kind === 'towel' ? 'towels' : kind === 'prop' ? 'props' : 'visitors', id);
  if (via === 'earn') {
    if (kind === 'towel' && L.total_min < item.min) throw new Error('还差 ' + (item.min - L.total_min) + ' 分钟');
    if (kind === 'prop') {
      if (L.avail_min < item.cost_min) throw new Error('可用分钟不够，还差 ' + (item.cost_min - L.avail_min) + ' 分钟');
      L.spent_min += item.cost_min; L.avail_min -= item.cost_min;
    }
    if (kind === 'visitor' && L.visit_days < item.days) throw new Error('再来 ' + (item.days - L.visit_days) + ' 天它就会来');
  } else s.purchases.push({ sku: kind + '.' + id, at: Date.now() });
  list.push(id);
  if (kind === 'towel' && !s.hung) s.hung = id;
  return v;
}
function demoPlace(v, slot, id) {
  const s = v.state;
  if (!id) { delete s.placed[slot]; return v; }
  for (const k in s.placed) if (s.placed[k] === id) delete s.placed[k];
  s.placed[slot] = id; return v;
}
})();
