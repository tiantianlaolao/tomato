// ============================================================
// Capyroom · 账号 + 跨设备同步（2026-09-03 从戳了么 server/account.js 原样搬来，用户拍板：Apple + Google + 手机号(中国区)，全量同步）
// 🔴 跟戳了么保持同构：那边修了什么这边照抄；差异只有默认 aud 和口径注释。
//
// 🔴 零依赖，跟 server.js 同一条红线：验签不引 jose/jsonwebtoken，
//    JWKS 用全局 fetch 拉（Node 22 内置），RS256 用 node:crypto 验。
//
// 🔴 Google 的 JWKS 地址必须可配（LS_GOOGLE_CERTS）：googleapis.com 从境内服务器
//    **出不去**。部署在国内时把它指到美国反代；部署在海外节点时用默认值直连。
//    Apple 的 appleid.apple.com 境内可达，不用绕。
//
// 🔴 口径（完整版见 schema.sql 顶部 8-30 那段）：
//    这半边是**用户主动注册**的身份，跟分享/赠礼那半边的匿名体系是两码事。
//    ① installs 把匿名安装号绑到 uid —— 安装号同时是 shares.author，
//       所以注册用户的分享作者身份可关联到账号（同步本来就需要这个能力），如实承认。
//    ② 访客（B 侧）的 visitor / browser 与账号零关联：没有任何查询把它们 join 到 uid。
//
// 同步模型：记录级 LWW（last-write-wins）。
//   sync_items(uid, kind, id, data, mtime, seq)
//   · mtime = 客户端的修改毫秒时间戳，谁新谁赢 —— 客户端两边各自也按这个规则合并，幂等。
//   · data = NULL 是墓碑（删除也要同步，不然删掉的章会从另一台设备"复活"）。
//   · seq  = 服务端按 uid 单调递增的序号，客户端拿它当增量拉取的游标。
//   🔴 「盖章从不联网」的红线不归这里管也不受影响：客户端永远先写本地，
//      同步是后台慢慢推，这里只是仓库。
// ============================================================
'use strict';

const crypto = require('node:crypto');
const sms = require('./sms.js');

// ---- 手机号登录（2026-08-31，中国线专用）------------------------------------
// 美服不配短信凭据 → sms.configured()=false → 这条路 501（跟 Google 没配 aud 同款处理）。
// 🔴 LS_SMS_TEST_CODE 是 test.js 专用钩子：设了就不真发短信、验证码固定为它。
//    ⛔ 生产环境永远不配这个变量 —— 配了等于所有人都知道验证码。
const SMS_TEST_CODE = process.env.LS_SMS_TEST_CODE || '';
const SMS_TTL_MIN = 5;                               // 跟短信模板里的 {2} 一致
const SMS_TTL_MS = SMS_TTL_MIN * 60 * 1000;
const SMS_COOLDOWN_MS = 60 * 1000;                   // 同号 60 秒才能再发
const SMS_DAY_MAX = 8;                               // 同号每天最多 8 条（护钱包）
const SMS_MAX_TRIES = 5;                             // 同一条码错 5 次作废（防爆破）
const PHONE_RE = /^1[3-9]\d{9}$/;                    // 中国大陆手机号
const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- 配置 ------------------------------------------------------------------
const APPLE_KEYS = process.env.LS_APPLE_KEYS || 'https://appleid.apple.com/auth/keys';
const APPLE_ISS = ['https://appleid.apple.com'];
const APPLE_AUD = (process.env.LS_APPLE_AUD || 'com.tybbtech.capyroom').split(',');
const GOOGLE_CERTS = process.env.LS_GOOGLE_CERTS || 'https://www.googleapis.com/oauth2/v3/certs';
// 走反代拉 Google 证书时要带的口令（美服 nginx 的 x-proxy-token 校验；直连 googleapis 不用）。
// ⚠️ 只附给 Google 证书这一个地址 —— 给 Apple 的请求带上等于把口令白送出去。
const GOOGLE_CERTS_TOKEN = process.env.LS_GOOGLE_CERTS_TOKEN || '';
const GOOGLE_ISS = ['https://accounts.google.com', 'accounts.google.com'];
// 🔴 没配 client id 时 Google 登录直接 501 —— 宁可明说"没配置"，
//    也不要空着 aud 校验放行任何人拿别家 app 的 google token 来登录。
const GOOGLE_AUD = process.env.LS_GOOGLE_AUD ? process.env.LS_GOOGLE_AUD.split(',') : null;

const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;   // 滑动 400 天：App 常开就永不掉线
const SYNC_BODY_LIMIT = 512 * 1024;                  // 一次推送上限（一年的记录也就几百 KB）
const MAX_CHANGES = 500;                             // 单次推送条数上限，客户端分批
const MAX_ITEM_BYTES = 8 * 1024;                     // 单条 data 上限
const MAX_ROWS_PER_USER = 50000;                     // 灌数据的兜底（十几年的记录也到不了）
const PULL_LIMIT = 500;

// ---- JWKS 缓存 -------------------------------------------------------------
// url -> { keys: Map(kid -> KeyObject), at: 毫秒 }
// 12 小时一换；碰到不认识的 kid 且缓存超过 1 分钟 → 立刻重拉一次（密钥轮换的正常路径）。
const jwksCache = new Map();

async function fetchJwks(url) {
  const headers = {};
  if (GOOGLE_CERTS_TOKEN && url === GOOGLE_CERTS) headers['x-proxy-token'] = GOOGLE_CERTS_TOKEN;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('jwks ' + r.status);
  const j = await r.json();
  const keys = new Map();
  for (const k of j.keys || []) {
    try { keys.set(k.kid, crypto.createPublicKey({ key: k, format: 'jwk' })); }
    catch (_) { /* 跳过看不懂的 key，别让一把坏钥匙拖垮全部 */ }
  }
  if (!keys.size) throw new Error('jwks empty');
  jwksCache.set(url, { keys, at: Date.now() });
  return keys;
}

async function keyFor(url, kid) {
  let c = jwksCache.get(url);
  if (!c || Date.now() - c.at > 12 * 60 * 60 * 1000) c = { keys: await fetchJwks(url), at: Date.now() };
  if (!c.keys.has(kid) && Date.now() - c.at > 60 * 1000) c.keys = await fetchJwks(url);
  return c.keys.get(kid) || null;
}

const b64u = s => Buffer.from(s, 'base64url');

// 验一个 RS256 的 id_token。过了才返回 payload，任何一步不对都抛。
// ⚠️ 只支持 RS256 —— Apple/Google 的 id_token 都是它。alg 必须白名单，
//    接受 token 自己声明的算法（尤其 none/HS256）是 JWT 的经典坑。
async function verifyIdToken(token, { keysUrl, iss, aud }) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('jwt shape');
  const header = JSON.parse(b64u(parts[0]).toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('alg');
  const key = await keyFor(keysUrl, header.kid);
  if (!key) throw new Error('kid');
  const okSig = crypto.verify('RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]), key, b64u(parts[2]));
  if (!okSig) throw new Error('sig');
  const p = JSON.parse(b64u(parts[1]).toString('utf8'));
  if (!p.exp || p.exp * 1000 < Date.now() - 60 * 1000) throw new Error('exp');
  if (!iss.includes(p.iss)) throw new Error('iss');
  const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (!auds.some(a => aud.includes(a))) throw new Error('aud');
  if (!p.sub) throw new Error('sub');
  return p;
}

// ---- 挂载 ------------------------------------------------------------------
// server.js 传进来它的 db / send / readBody，路由风格保持一致：
// 匹配不上返回 undefined，让 server.js 继续往下走。
function mount({ db, send, readBody }) {
  const q = {
    userBySubject: db.prepare('SELECT * FROM users WHERE provider = ? AND subject = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (uid, provider, subject, email, created) VALUES (?, ?, ?, ?, ?)'),
    touchEmail: db.prepare('UPDATE users SET email = ? WHERE uid = ? AND email IS NOT ?'),
    getUser: db.prepare('SELECT * FROM users WHERE uid = ?'),
    insertSession: db.prepare(
      'INSERT INTO sessions (token, uid, created, seen) VALUES (?, ?, ?, ?)'),
    getSession: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    touchSession: db.prepare('UPDATE sessions SET seen = ? WHERE token = ?'),
    dropSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
    sweepSessions: db.prepare('DELETE FROM sessions WHERE seen < ?'),
    // 删除账号（9-03，Google Play / App Store 都要求"能建账号就必须能在 App 里删"）：
    // 账号半边四张表按 uid 清干净。匿名半边（shares/gifts/unlocks…）不碰——
    // 那边本来就没有身份，installs 解绑后老分享回到"匿名安装号"状态，跟从没登录过一样。
    dropUserSessions: db.prepare('DELETE FROM sessions WHERE uid = ?'),
    dropUserInstalls: db.prepare('DELETE FROM installs WHERE uid = ?'),
    dropUserItems: db.prepare('DELETE FROM sync_items WHERE uid = ?'),
    dropUser: db.prepare('DELETE FROM users WHERE uid = ?'),
    putInstall: db.prepare(
      'INSERT INTO installs (install, uid, created) VALUES (?, ?, ?)'
      + ' ON CONFLICT(install) DO UPDATE SET uid = excluded.uid'),
    getItem: db.prepare('SELECT mtime FROM sync_items WHERE uid = ? AND kind = ? AND id = ?'),
    putItem: db.prepare(
      'INSERT INTO sync_items (uid, kind, id, data, mtime, seq) VALUES (?, ?, ?, ?, ?, ?)'
      + ' ON CONFLICT(uid, kind, id) DO UPDATE SET'
      + ' data = excluded.data, mtime = excluded.mtime, seq = excluded.seq'),
    maxSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM sync_items WHERE uid = ?'),
    pull: db.prepare(
      'SELECT kind, id, data, mtime, seq FROM sync_items WHERE uid = ? AND seq > ?'
      + ' ORDER BY seq LIMIT ' + PULL_LIMIT),
    countRows: db.prepare('SELECT COUNT(*) AS c FROM sync_items WHERE uid = ?'),
    getSms: db.prepare('SELECT * FROM sms_codes WHERE phone = ?'),
    putSms: db.prepare(
      'INSERT INTO sms_codes (phone, hash, expires, tries, lastSent, dayKey, dayCount)'
      + ' VALUES (?, ?, ?, 0, ?, ?, ?)'
      + ' ON CONFLICT(phone) DO UPDATE SET hash = excluded.hash, expires = excluded.expires,'
      + ' tries = 0, lastSent = excluded.lastSent, dayKey = excluded.dayKey,'
      + ' dayCount = excluded.dayCount'),
    bumpSmsTries: db.prepare('UPDATE sms_codes SET tries = tries + 1 WHERE phone = ?'),
    dropSms: db.prepare('DELETE FROM sms_codes WHERE phone = ?'),
  };

  // 会话过期清扫：跟 server.js 的 sweep 一个节奏，但归自己管（unref，不挡退出）
  const t = setInterval(() => {
    const n = q.sweepSessions.run(Date.now() - SESSION_TTL_MS).changes;
    if (n) console.log(`[account] 清掉 ${n} 个超过 400 天没动的会话`);
  }, 60 * 60 * 1000);
  t.unref();

  // Bearer token -> session 行；顺手滑动续期（每小时最多写一次，别每个请求都写盘）
  function sessionOf(req) {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return null;
    const s = q.getSession.get(h.slice(7).trim());
    if (!s) return null;
    if (Number(s.seen) < Date.now() - SESSION_TTL_MS) { q.dropSession.run(s.token); return null; }
    if (Date.now() - Number(s.seen) > 60 * 60 * 1000) q.touchSession.run(Date.now(), s.token);
    return s;
  }

  // 发验证码。成功只回 {ok}，失败的话（冷却/当日上限/短信通道挂了）分开回，
  // 客户端拿 error 挑话。⚠️ dayKey 用 UTC 日期，中国的"一天"会错开 8 小时 ——
  // 它只管每日上限这一件事，错开无害，别为它引时区库。
  async function smsSend(req, res) {
    const b = await readBody(req);
    const phone = String(b.phone || '');
    // 🔴 501 判断必须在 400 之前：客户端拿"空请求回 501 还是 400"当能力探测
    //    （App 里手机号入口只在所连服务端配了短信时才显示）。反过来的话
    //    空请求两边都回 400，探测就瞎了。
    if (!SMS_TEST_CODE && !sms.configured()) return send(res, 501, { error: 'sms not configured' });
    if (!PHONE_RE.test(phone)) return send(res, 400, { error: 'phone' });
    const now = Date.now();
    const cur = q.getSms.get(phone);
    if (cur && now - Number(cur.lastSent) < SMS_COOLDOWN_MS) {
      return send(res, 429, {
        error: 'cooldown',
        wait: Math.ceil((SMS_COOLDOWN_MS - (now - Number(cur.lastSent))) / 1000),
      });
    }
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const dayCount = cur && cur.dayKey === dayKey ? Number(cur.dayCount) : 0;
    if (dayCount >= SMS_DAY_MAX) return send(res, 429, { error: 'daily' });
    // crypto.randomInt 而不是 Math.random：验证码是安全凭据
    const code = SMS_TEST_CODE || String(crypto.randomInt(100000, 1000000));
    if (!SMS_TEST_CODE) {
      const sent = await sms.sendCode(phone, code, SMS_TTL_MIN);
      if (!sent) return send(res, 502, { error: 'sms failed' });
    }
    // 发送成功才落库计数（发失败不占额度也不进冷却；腾讯云自己还有一层频控兜底）
    q.putSms.run(phone, sha256(code), now + SMS_TTL_MS, now, dayKey, dayCount + 1);
    return send(res, 200, { ok: true, ttl: SMS_TTL_MS / 1000 });
  }

  async function login(req, res) {
    const b = await readBody(req);
    let payload;

    // 手机号这条路不走 id_token 验签，先单独处理完再进 try（那里面的 catch 是给验签的）。
    if (b.provider === 'phone') {
      const phone = String(b.phone || '');
      if (!PHONE_RE.test(phone)) return send(res, 400, { error: 'phone' });
      const row = q.getSms.get(phone);
      const now0 = Date.now();
      // 没发过 / 过期 / 试错太多次 → 一律 'expired'（让用户重发一条，不区分是哪种没了）
      if (!row || Number(row.expires) < now0 || Number(row.tries) >= SMS_MAX_TRIES) {
        return send(res, 401, { error: 'expired' });
      }
      if (sha256(String(b.code || '')) !== row.hash) {
        q.bumpSmsTries.run(phone);
        return send(res, 401, { error: 'code' });
      }
      q.dropSms.run(phone);                     // 一码一用，登上就作废
      // 跟 id_token 路径同形：sub = 提供方的稳定用户号，手机号就是它自己。
      // email 字段语义是「展示你登录的是哪个号」→ 存打码手机号正合适（客户端零改动）。
      payload = { sub: phone, email: phone.slice(0, 3) + '****' + phone.slice(7) };
    }

    try {
      if (payload) {
        // phone 已经验完了，跳过验签
      } else if (b.provider === 'apple') {
        payload = await verifyIdToken(b.token, { keysUrl: APPLE_KEYS, iss: APPLE_ISS, aud: APPLE_AUD });
      } else if (b.provider === 'google') {
        if (!GOOGLE_AUD) return send(res, 501, { error: 'google not configured' });
        payload = await verifyIdToken(b.token, { keysUrl: GOOGLE_CERTS, iss: GOOGLE_ISS, aud: GOOGLE_AUD });
      } else {
        return send(res, 400, { error: 'provider' });
      }
    } catch (e) {
      // 🔴 拉不到 JWKS（网络/反代挂了）和 token 本身坏，是两种完全不同的故障，
      //    必须分开返回 —— 混成一个 401 的话，反代一挂所有人"密码错误"，会往错误方向查。
      const msg = String(e && e.message);
      if (/jwks|fetch|timeout|network|abort/i.test(msg)) {
        console.error('[account] JWKS 拉取失败：', msg);
        return send(res, 502, { error: 'keys unreachable' });
      }
      return send(res, 401, { error: 'bad token' });
    }

    const now = Date.now();
    let u = q.userBySubject.get(b.provider, payload.sub);
    if (!u) {
      const uid = 'u' + crypto.randomBytes(12).toString('hex');
      // ⚠️ email 只存来展示「你登录的是哪个号」；Apple 只在**第一次**授权时给，
      //    以后都是 undefined —— 所以只在有值时更新，别拿 undefined 把存过的盖掉。
      q.insertUser.run(uid, b.provider, payload.sub, payload.email || null, now);
      u = { uid, provider: b.provider, email: payload.email || null };
    } else if (payload.email) {
      q.touchEmail.run(payload.email, u.uid, payload.email);
    }

    // 匿名安装号 → 账号。安装号同时是 shares.author，绑上之后老分享/封蜡跟着账号走。
    // 同一台设备换号登录 = 改绑到新 uid（最后登录的说了算）。
    if (typeof b.install === 'string' && /^[0-9a-z-]{8,64}$/i.test(b.install)) {
      q.putInstall.run(b.install, u.uid, now);
    }

    const token = crypto.randomBytes(24).toString('hex');
    q.insertSession.run(token, u.uid, now, now);
    return send(res, 200, {
      token, uid: u.uid, provider: b.provider, email: u.email || payload.email || null,
    });
  }

  async function sync(req, res, sess) {
    const b = await readBody(req, SYNC_BODY_LIMIT);
    const cursor = Number.isInteger(b.cursor) && b.cursor >= 0 ? b.cursor : 0;
    const changes = Array.isArray(b.changes) ? b.changes : [];
    if (changes.length > MAX_CHANGES) return send(res, 400, { error: 'too many changes' });

    // 校验先做完再开事务：一条坏数据整批拒掉，客户端重试才是幂等的
    for (const c of changes) {
      if (!c || typeof c.kind !== 'string' || !/^[a-z][a-z0-9_]{0,23}$/.test(c.kind)
        || typeof c.id !== 'string' || !c.id.length || c.id.length > 64
        || !Number.isFinite(c.mtime)) return send(res, 400, { error: 'bad change' });
      if (c.data !== null && c.data !== undefined) {
        if (typeof c.data !== 'string' || Buffer.byteLength(c.data) > MAX_ITEM_BYTES) {
          return send(res, 400, { error: 'bad data' });
        }
      }
    }

    if (changes.length
      && Number(q.countRows.get(sess.uid).c) + changes.length > MAX_ROWS_PER_USER) {
      return send(res, 507, { error: 'quota' });
    }

    // 🔴 LWW 在服务端也要判，不能只信客户端顺序：两台设备同时推，后到的那台
    //    可能带着更旧的 mtime —— 旧的不许盖新的，两边各自应用同一条规则才收敛。
    db.exec('BEGIN');
    try {
      let seq = Number(q.maxSeq.get(sess.uid).s);
      for (const c of changes) {
        const cur = q.getItem.get(sess.uid, c.kind, c.id);
        if (cur && Number(cur.mtime) >= c.mtime) continue;    // 旧改动，丢弃
        seq += 1;
        q.putItem.run(sess.uid, c.kind, c.id,
          c.data === undefined ? null : c.data, c.mtime, seq);
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }

    // 拉增量。⚠️ 会包含这次自己刚推上来的条目 —— 客户端按同一条 LWW 规则应用，
    // 结果不变（幂等），换省这一点流量要多存"谁推的"，不值。
    const rows = q.pull.all(sess.uid, cursor);
    const last = rows.length ? Number(rows[rows.length - 1].seq) : cursor;
    return send(res, 200, {
      cursor: last,
      more: rows.length === PULL_LIMIT,
      changes: rows.map(r => ({
        kind: r.kind, id: r.id, data: r.data, mtime: Number(r.mtime),
      })),
    });
  }

  // 路由。跟 server.js 同一套约定：**null = 没匹配上**（server.js 继续走它自己的表），
  // 其余任何返回值 = 已经回复过了。⚠️ send() 返回 undefined，所以匹配到的分支
  // 必须显式 return true —— 拿 undefined 当"已处理"会跟 null 语义撞车（栽过：双重响应）。
  async function route(req, res, pathname) {
    const m = req.method;
    if (m === 'POST' && pathname === '/api/auth/sms_send') { await smsSend(req, res); return true; }
    if (m === 'POST' && pathname === '/api/auth/login') { await login(req, res); return true; }
    if (m === 'POST' && pathname === '/api/auth/logout') {
      const s = sessionOf(req);
      if (s) q.dropSession.run(s.token);
      send(res, 200, { ok: true });
      return true;
    }
    // 删除账号：会话有效才能删（Bearer 就是身份证明，不再要密码/验证码——
    // 这个账号本来就没有密码）。删完 200；会话已失效回 401，客户端把 401 也当"已经没了"。
    // 🔴 四张表一个事务：删了 users 没删 sync_items = 数据孤儿，且同一 Apple 号再登录
    //    会生成新 uid，老数据永远找不回也删不掉。
    if (m === 'POST' && pathname === '/api/auth/delete') {
      const s = sessionOf(req);
      if (!s) { send(res, 401, { error: 'auth' }); return true; }
      db.exec('BEGIN');
      try {
        q.dropUserItems.run(s.uid);
        q.dropUserInstalls.run(s.uid);
        q.dropUserSessions.run(s.uid);
        q.dropUser.run(s.uid);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      send(res, 200, { ok: true });
      return true;
    }
    if (m === 'GET' && pathname === '/api/auth/me') {
      const s = sessionOf(req);
      if (!s) { send(res, 401, { error: 'auth' }); return true; }
      const u = q.getUser.get(s.uid);
      send(res, 200, { uid: s.uid, provider: u && u.provider, email: u && u.email });
      return true;
    }
    if (m === 'POST' && pathname === '/api/sync') {
      const s = sessionOf(req);
      if (!s) { send(res, 401, { error: 'auth' }); return true; }
      await sync(req, res, s);
      return true;
    }
    return null;
  }

  return { route };
}

module.exports = { mount, verifyIdToken };
