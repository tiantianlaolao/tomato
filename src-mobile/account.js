// ============================================================
// Capyroom · 账号 + 跨设备同步（2026-09-03，参考戳了么 app/js/net.js + sync.js，用户拍板）
//
// 服务端：capyroom-server（1.13:8782，nginx /capyroom/api/），和戳了么同一套 account.js。
// 登录方式按区分流（用户 9-3 定）：中国区 = 手机号 + Apple；非中国区 = Apple + Google，无手机号。
//   · 区 = 构建时注入的 WEB_BASE（指 www.tybbtech.com 就是中国区；海外包由 CI 换成海外域名）
//   · 手机号入口再多一道能力探测：所连服务端没配短信 → sms_send 回 501 → 不显示
// 原生登录：tauri-plugin-social-auth（Apple / Google 拉系统面板拿 idToken，服务端验签）。
//   浏览器里（DEMO/截图）没有原生桥 → 登录键点了回 'native'，界面安静收场。
//
// 同步模型（与服务端同一条 LWW 规则）：本地数据归 Rust，这里只搬字节——
//   sync_snapshot → 和 meta（上次已知 mtime）比 → 差的推上去 → 拉增量 → sync_import 合并 → meta 更新。
//   🔴 本地永远先写（内核照常落盘），同步是后台慢慢推；任何网络失败静默吞掉，绝不挡界面。
//   🔴 mtime 纪律在 Rust 侧（导入用远端 mtime，不用 now），这里不要"聪明地"改 mtime。
// ============================================================
(function () {
'use strict';

// 🔴 生产主机唯一注入点。海外构建由 CI 把这一行整体替换成海外域名（那一刻 IS_OVERSEAS 跟着切）。
const WEB_BASE = 'https://www.tybbtech.com/capyroom/';
const IS_OVERSEAS = !WEB_BASE.startsWith('https://www.tybbtech.com/');
const API = WEB_BASE + 'api/';
const TIMEOUT = 8000;
const T = window.__TAURI__;
const HAS_BRIDGE = !!(T && T.core);

async function call(path, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(API + path, { ...opts, signal: ctl.signal });
    const data = await r.json().catch(() => null);
    return { status: r.status, data };
  } catch (_) {
    return { status: 0, data: null };              // 网不通 / 超时 / 被墙，一律当"这次没成"
  } finally { clearTimeout(timer); }
}
const jsonPost = (path, body, token) => call(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body),
});

// ---- 服务端接口 ----
const net = {
  async login(provider, idToken) {
    const { status, data } = await jsonPost('auth/login', { provider, token: idToken });
    if (status === 0) return null;
    return data || {};
  },
  async loginPhone(phone, code) {
    const { status, data } = await jsonPost('auth/login', { provider: 'phone', phone, code });
    if (status === 0) return null;
    return data || {};
  },
  async smsSend(phone) {
    const { status, data } = await jsonPost('auth/sms_send', { phone });
    if (status === 0) return null;
    return { status, ...(data || {}) };
  },
  // 能力探测：空请求→服务端没配短信回 501（判断排在参数校验前），配了回 400。结果缓存一会话。
  _sms: null,
  async smsSupported() {
    if (this._sms !== null) return this._sms;
    const { status } = await jsonPost('auth/sms_send', {});
    if (status === 0) return false;
    this._sms = status !== 501;
    return this._sms;
  },
  logout(token) { return call('auth/logout', { method: 'POST', headers: { authorization: 'Bearer ' + token } }); },
  async deleteAccount(token) { return (await call('auth/delete', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).status; },
  // 推一批 + 按游标拉。🔴 401 原样交上去：引擎拿它判"会话没了该静默掉线"
  async syncPush(token, cursor, changes) {
    const { status, data } = await jsonPost('sync', { cursor, changes }, token);
    if (status === 0) return null;
    if (status === 401) return { status: 401, changes: [], cursor, more: false };
    if (!data || !Number.isFinite(data.cursor)) return null;
    return { status, cursor: data.cursor, more: !!data.more, changes: data.changes || [] };
  },
  // 原生登录：拉系统面板，回 idToken；没桥/取消/失败一律 null（界面不区分原因，安静收场）
  async nativeLogin(provider) {
    if (!HAS_BRIDGE) return null;
    try {
      const r = await T.core.invoke('plugin:social-auth|' + (provider === 'apple' ? 'apple_sign_in' : 'google_sign_in'));
      return (r && (r.idToken || r.identityToken)) || null;
    } catch (_) { return null; }
  },
};

const K = 'capy_sync_';
function load(k, d) { try { const v = JSON.parse(localStorage.getItem(K + k)); return v ?? d; } catch (_) { return d; } }
function save(k, v) { try { localStorage.setItem(K + k, JSON.stringify(v)); } catch (_) {} }
const BATCH = 400;               // 服务端上限 500
const DEBOUNCE_MS = 3000;
const KINDS = ['session', 'plan', 'schedule', 'rewards', 'settings'];

window.Account = {
  net, IS_OVERSEAS, HAS_BRIDGE,
  account: load('account', null),      // {token, uid, provider, email} | null
  cursor: load('cursor', {}),          // uid -> seq
  meta: load('meta', {}),              // `${kind}|${id}` -> 已知 mtime（本地=服务端一致时的值）
  lastSyncAt: load('lastSyncAt', 0),
  onChange: null,                      // 账号态/同步结果变了叫一声（main.js 重渲染设置页/账本）
  _timer: null, _busy: false,

  isLoggedIn() { return !!(this.account && this.account.token); },
  persist() { save('account', this.account); save('cursor', this.cursor); save('meta', this.meta); save('lastSyncAt', this.lastSyncAt); },

  // 本地有改动（存设置/序列/计划、会话完成、奖励变动）→ 3 秒后推一轮。没登录就什么都不做。
  touch() { if (this.isLoggedIn()) this.schedule(); },
  schedule() { clearTimeout(this._timer); this._timer = setTimeout(() => this.flush(), DEBOUNCE_MS); },

  // ---- 登录 / 登出 / 删号 ----
  async login(provider) {
    const idToken = await net.nativeLogin(provider);
    if (!idToken) return { error: 'native' };
    return this._adopt(await net.login(provider, idToken));
  },
  async loginPhone(phone, code) { return this._adopt(await net.loginPhone(phone, code)); },
  _adopt(r) {
    if (!r) return { error: 'net' };
    if (!r.token) return { error: 'auth', why: r.error || '' };
    this.account = { token: r.token, uid: r.uid, provider: r.provider, email: r.email || '' };
    // 🔴 登录一律游标清零、meta 清空：从头拉一遍 + 本地全量推一遍。重装/换设备都靠这一下恢复；
    //    LWW 保证幂等（服务端旧的盖不掉新的，本地导入也是），代价只是一次全量。
    this.cursor[r.uid] = 0;
    this.meta = {};
    this.persist();
    this.flush();
    if (this.onChange) this.onChange();
    return { ok: true };
  },
  async logout() {
    const t = this.account && this.account.token;
    this.account = null; this.meta = {};
    this.persist();
    if (t) net.logout(t);                            // 失败也无所谓，会话 400 天自己烂掉
    if (this.onChange) this.onChange();
  },
  // 🔴 删号必须等服务端回话（网不通报 net 让用户再试），本机数据不动——删的是账号不是记录
  async deleteAccount() {
    const t = this.account && this.account.token;
    if (!t) return { ok: true };
    const status = await net.deleteAccount(t);
    if (status === 0) return { error: 'net' };
    if (status !== 200 && status !== 401) return { error: 'fail' };
    this.account = null; this.meta = {};
    this.persist();
    if (this.onChange) this.onChange();
    return { ok: true };
  },

  // ---- 推拉一轮 ----
  // 单飞行；网不通原地退出下次再来；401 静默掉线。
  async flush() {
    if (!this.isLoggedIn() || !HAS_BRIDGE || this._busy) return;
    this._busy = true;
    let applied = 0;
    try {
      const uid = this.account.uid;
      let guard = 0;
      for (;;) {
        if (++guard > 40) break;
        // ① 快照 vs meta → 本地要推的
        const snap = await T.core.invoke('sync_snapshot');
        const local = {};
        for (const it of snap.sessions) local['session|' + it.id] = it;
        for (const it of snap.plans) local['plan|' + it.id] = it;
        for (const it of snap.schedules) local['schedule|' + it.id] = it;
        local['rewards|rewards'] = snap.rewards;
        local['settings|settings'] = snap.settings;
        const changes = [];
        for (const key in local) {
          const it = local[key];
          if ((this.meta[key] || 0) === it.mtime) continue;
          if ((this.meta[key] || 0) > it.mtime) continue;        // 本地比已知还旧？不该发生，别推
          const [kind, id] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
          changes.push({ kind, id, data: it.data, mtime: it.mtime });
        }
        // 本地已经没有的（删掉的序列/计划）→ 墓碑；只对 plan/schedule
        const now = Date.now();
        for (const key in this.meta) {
          if (local[key]) continue;
          const kind = key.slice(0, key.indexOf('|'));
          if (kind !== 'plan' && kind !== 'schedule') continue;
          if (this.meta[key] === -1) continue;                    // 墓碑已经推过
          changes.push({ kind, id: key.slice(key.indexOf('|') + 1), data: null, mtime: now });
        }
        const batch = changes.slice(0, BATCH);
        // ② 推 + 拉
        const r = await net.syncPush(this.account.token, this.cursor[uid] || 0, batch);
        if (!r) return;
        if (r.status === 401) { this.account = null; this.meta = {}; this.persist(); if (this.onChange) this.onChange(); return; }
        for (const c of batch) this.meta[c.kind + '|' + c.id] = c.data === null ? -1 : c.mtime;
        // ③ 远端变更交给内核合并（LWW/并集在 Rust 侧），meta 记远端 mtime
        const remote = (r.changes || []).filter(c => KINDS.includes(c.kind));
        if (remote.length) {
          const res = await T.core.invoke('sync_import', { changes: remote });
          applied += (res.report && res.report.applied) || 0;
          for (const c of remote) {
            const key = c.kind + '|' + c.id;
            if (c.data === null) { if (c.kind === 'plan' || c.kind === 'schedule') this.meta[key] = -1; }
            else if (c.kind === 'session' || c.kind === 'plan' || c.kind === 'schedule' || c.kind === 'settings') this.meta[key] = Math.max(this.meta[key] || 0, c.mtime);
            // rewards：合并后本地 updated_ms 可能变成 now（有远端没有的东西）→ 让下一轮快照自己判，这里不记
          }
          if (res.report && (res.report.plans_changed || res.report.schedules_changed || res.report.settings_changed || res.report.rewards_changed || res.report.sessions_added)) {
            if (this.onImported) this.onImported(res);
          }
        }
        this.cursor[uid] = r.cursor;
        this.lastSyncAt = Date.now();
        this.persist();
        // 收工条件：没有更多可拉、本轮也推完了。rewards 合并后本地可能变成"以 now 推上去"，多跑一轮把并集送上去
        const rewardsBounce = remote.some(c => c.kind === 'rewards') && guard < 3;
        if (!r.more && changes.length <= BATCH && !rewardsBounce) break;
      }
    } catch (e) {
      console.error('sync', e);
    } finally {
      this._busy = false;
      if (this.onChange) this.onChange();
    }
    return applied;
  },

  init() {
    if (this.isLoggedIn()) this.flush();             // 开机对一轮账
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
    setInterval(() => { if (this.isLoggedIn()) this.flush(); }, 10 * 60 * 1000);   // 常开也每 10 分钟对一次
  },
};
})();
