// Capyroom 后端自测。跑法：node test.js（临时库，不碰 data/）
// 从戳了么 server/test.js 的账号/同步段搬来：假 Apple JWKS 走的是 account.js 一模一样的验签代码。
// ⚠️ 环境变量必须在 require('./server.js') 之前设好（account.js 在 require 时读）。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('node:crypto');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'capy-test-'));
process.env.LS_DB = path.join(TMP, 'test.db');
process.env.LS_PORT = '8797';
process.env.LS_APPLE_KEYS = 'http://127.0.0.1:8796/keys';
delete process.env.LS_GOOGLE_AUD;                      // 故意不配：测 501
process.env.LS_SMS_TEST_CODE = '246810';               // 🔴 测试钩子，生产永远不配
delete process.env.LS_SMS_SECRET_ID;

const KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...KP.publicKey.export({ format: 'jwk' }), kid: 't1', alg: 'RS256', use: 'sig' };
const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function signJwt(payload, { kid = 't1', alg = 'RS256', breakSig = false } = {}) {
  const h = b64u({ alg, kid }), p = b64u(payload);
  let sig = crypto.sign('RSA-SHA256', Buffer.from(h + '.' + p), KP.privateKey).toString('base64url');
  if (breakSig) sig = sig.slice(0, -4) + 'AAAA';
  return `${h}.${p}.${sig}`;
}
const AUD = 'com.tybbtech.capyroom';
function appleToken(over = {}) {
  return signJwt({ iss: 'https://appleid.apple.com', aud: AUD, sub: 'apple-user-001', email: 'a@example.com',
    exp: Math.floor(Date.now() / 1000) + 600, ...over });
}
const keysSrv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [JWK] }));
});
keysSrv.listen(8796, '127.0.0.1'); keysSrv.unref();

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS  ' + msg); } else { fail++; console.log('  FAIL  ' + msg); } }

const srv = require('./server.js');
const BASE = 'http://127.0.0.1:8797';
const ja = async (m, u, b, tok, origin) => {
  const headers = {};
  if (b) headers['content-type'] = 'application/json';
  if (tok) headers.authorization = 'Bearer ' + tok;
  if (origin) headers.origin = origin;
  const r = await fetch(BASE + u, { method: m, headers, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, body: await r.json().catch(() => null), h: r.headers };
};

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('== health / CORS ==');
  const h = await ja('GET', '/api/health', null, null, 'tauri://localhost');
  ok(h.status === 200 && h.body.ok && h.body.app === 'capyroom', 'health');
  ok(h.h.get('access-control-allow-origin') === 'tauri://localhost', 'Tauri iOS 壳的 origin 在白名单');
  const h2 = await ja('GET', '/api/health', null, null, 'https://evil.example');
  ok(!h2.h.get('access-control-allow-origin'), '别的 origin 不给 CORS 头');
  const h3 = await ja('GET', '/api/health', null, null, 'http://127.0.0.1:8942');
  ok(h3.h.get('access-control-allow-origin') === 'http://127.0.0.1:8942', '本地截图端口按前缀放行');
  const pre = await fetch(BASE + '/api/sync', { method: 'OPTIONS', headers: { origin: 'tauri://localhost' } });
  ok(pre.status === 204 && /authorization/.test(pre.headers.get('access-control-allow-headers') || ''), '预检 204 且允许 authorization 头');

  console.log('\n== 账号：Apple 登录 ==');
  const L1 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken(), install: 'test-install-0001' });
  ok(L1.status === 200 && L1.body.token && L1.body.uid, '合法 Apple token 能登录，拿到会话');
  ok(L1.body.email === 'a@example.com', '首次登录把 email 存下来了');
  const bad1 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken({ aud: 'com.tybbtech.lifestamps' }) });
  ok(bad1.status === 401, '别家 app（戳了么）的 token aud 不对被拒：' + bad1.status);
  const bad2 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken({ exp: Math.floor(Date.now() / 1000) - 3600 }) });
  ok(bad2.status === 401, '过期 token 被拒');
  const bad3 = await ja('POST', '/api/auth/login', { provider: 'apple', token: signJwt({ iss: 'https://appleid.apple.com', aud: AUD, sub: 'x', exp: Math.floor(Date.now() / 1000) + 600 }, { breakSig: true }) });
  ok(bad3.status === 401, '签名被篡改的 token 被拒');
  const bad4 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken().split('.').map((s, i) => i === 0 ? Buffer.from(JSON.stringify({ alg: 'none', kid: 't1' })).toString('base64url') : s).join('.') });
  ok(bad4.status === 401, 'alg=none 被拒');
  const g501 = await ja('POST', '/api/auth/login', { provider: 'google', token: 'whatever' });
  ok(g501.status === 501, 'Google 没配 client id 时 501');
  const me1 = await ja('GET', '/api/auth/me', null, L1.body.token);
  ok(me1.status === 200 && me1.body.uid === L1.body.uid, '/me 认出自己');
  ok((await ja('GET', '/api/auth/me')).status === 401, '/me 不带会话 401');
  const L2 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken() });
  ok(L2.status === 200 && L2.body.uid === L1.body.uid && L2.body.token !== L1.body.token, '同一 Apple 号再登录 = 同 uid 新会话');

  console.log('\n== 账号：手机号登录（中国区）==');
  const PH = '13800001111';
  ok((await ja('POST', '/api/auth/sms_send', { phone: '12345' })).status === 400, '不像手机号 400');
  const s1 = await ja('POST', '/api/auth/sms_send', { phone: PH });
  ok(s1.status === 200 && s1.body.ok, '发码成功（测试钩子不真发）');
  const cool = await ja('POST', '/api/auth/sms_send', { phone: PH });
  ok(cool.status === 429 && cool.body.error === 'cooldown', '60 秒冷却');
  const wrong = await ja('POST', '/api/auth/login', { provider: 'phone', phone: PH, code: '000000' });
  ok(wrong.status === 401 && wrong.body.error === 'code', '错码 401 code');
  const P1 = await ja('POST', '/api/auth/login', { provider: 'phone', phone: PH, code: '246810' });
  ok(P1.status === 200 && P1.body.token && P1.body.provider === 'phone' && P1.body.email === '138****1111', '对码登录，展示名打码');
  const reuse = await ja('POST', '/api/auth/login', { provider: 'phone', phone: PH, code: '246810' });
  ok(reuse.status === 401 && reuse.body.error === 'expired', '一码一用');
  const smsRow = srv.db.prepare('SELECT * FROM sms_codes WHERE phone = ?').get(PH);
  ok(!smsRow || !/246810/.test(JSON.stringify(smsRow)), '库里不存验证码明文');

  console.log('\n== 同步（记录级 LWW）==');
  ok((await ja('POST', '/api/sync', { cursor: 0, changes: [] })).status === 401, '没登录不能同步');
  const p1 = await ja('POST', '/api/sync', { cursor: 0, changes: [
    { kind: 'session', id: '1756900000000', data: '{"plan_name":"经典","work_secs":1500}', mtime: 1000 },
    { kind: 'rewards', id: 'rewards', data: '{"towels":["t01"]}', mtime: 1500 },
  ] }, L1.body.token);
  ok(p1.status === 200 && p1.body.cursor >= 2 && p1.body.changes.length === 2, '设备1 推 2 条，游标 ' + (p1.body && p1.body.cursor));
  const p2 = await ja('POST', '/api/sync', { cursor: 0, changes: [] }, L2.body.token);
  ok(p2.status === 200 && p2.body.changes.length === 2, '设备2 从头拉到 2 条');
  await ja('POST', '/api/sync', { cursor: p2.body.cursor, changes: [{ kind: 'rewards', id: 'rewards', data: '{"towels":[]}', mtime: 500 }] }, L2.body.token);
  ok(srv.db.prepare("SELECT data FROM sync_items WHERE kind='rewards'").get().data.includes('t01'), 'LWW：旧 mtime 盖不掉新数据');
  const p3 = await ja('POST', '/api/sync', { cursor: p2.body.cursor, changes: [{ kind: 'rewards', id: 'rewards', data: '{"towels":["t01","t02"]}', mtime: 2000 }] }, L2.body.token);
  ok(p3.status === 200 && srv.db.prepare("SELECT data FROM sync_items WHERE kind='rewards'").get().data.includes('t02'), 'LWW：新 mtime 能赢');
  const p4 = await ja('POST', '/api/sync', { cursor: p1.body.cursor, changes: [] }, L1.body.token);
  ok(p4.status === 200 && p4.body.changes.length === 1 && p4.body.changes[0].data.includes('t02'), '设备1 增量只拉到设备2 那条新的');
  const tomb = await ja('POST', '/api/sync', { cursor: p3.body.cursor, changes: [{ kind: 'plan', id: 'p9', data: null, mtime: 3000 }] }, L2.body.token);
  ok(tomb.status === 200 && tomb.body.changes.some(c => c.kind === 'plan' && c.data === null), '墓碑（data=null）能推能拉');
  const badc = await ja('POST', '/api/sync', { cursor: 0, changes: [{ kind: 'Bad Kind', id: 'x', data: '1', mtime: 1 }] }, L1.body.token);
  ok(badc.status === 400, '坏 kind 整批 400');

  console.log('\n== 登出 / 删除账号 ==');
  ok((await ja('POST', '/api/auth/logout', {}, L2.body.token)).status === 200, '登出 200');
  ok((await ja('GET', '/api/auth/me', null, L2.body.token)).status === 401, '登出后会话失效');
  ok((await ja('POST', '/api/auth/delete', {}, L1.body.token)).status === 200, '删除账号 200');
  ok(srv.db.prepare('SELECT COUNT(*) c FROM sync_items').get().c === 0, '删账号连同步数据一起删');
  ok((await ja('GET', '/api/auth/me', null, L1.body.token)).status === 401, '删后会话失效');
  const L3 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken() });
  ok(L3.status === 200 && L3.body.uid !== L1.body.uid, '删后同一 Apple 号再登录 = 新 uid');

  console.log(`\n${pass} 过 / ${fail} 挂`);
  srv.server.close(); srv.db.close(); keysSrv.close();
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); srv.server.close(); srv.db.close(); process.exitCode = 1; });
