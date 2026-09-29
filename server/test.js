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

// ---- 支付测试的假支付宝（9-29，从戳了么 test.js 搬来）--------------------------------
// 🔴 支付宝正式环境没法离线测，但签名 / 验签 / 反查响应验签 / 幂等这些逻辑**必须被测**：
//    APP_KP = 我们的应用私钥（写成文件给 pay.js 读）；ALI_KP = "支付宝"的钥匙，
//    测试拿它的私钥给 notify 和 trade.query 响应签名，pay.js 拿它的公钥验 —— 走的是线上一模一样的代码。
const APP_KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ALI_KP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
// 私钥故意按密钥工具的样子存成"一行 base64"（PKCS8），验 readKeyFile 的折行套头逻辑
const pk8 = APP_KP.privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/-----[^-]+-----|\s/g, '');
fs.writeFileSync(path.join(TMP, 'app_priv.txt'), pk8);
fs.writeFileSync(path.join(TMP, 'ali_pub.txt'), ALI_KP.publicKey.export({ type: 'spki', format: 'pem' }));
process.env.LS_ALIPAY_PRIVATE_KEY_FILE = path.join(TMP, 'app_priv.txt');
process.env.LS_ALIPAY_PUBLIC_KEY_FILE = path.join(TMP, 'ali_pub.txt');
process.env.LS_ALIPAY_APP_ID = '2021000000000001';   // 测试用假 APPID；生产在 pm2 里配真的
process.env.LS_ALIPAY_GATEWAY = 'http://127.0.0.1:8795/gateway.do';
process.env.LS_PAY_TEST_PRODUCT = '1';
delete process.env.LS_ALIPAY_SELLER_ID;
delete process.env.LS_CATALOG;                          // 用仓里真的 rewards_catalog.json（theme.onsen ¥18）
// 假网关：只会 alipay.trade.query；每单的状态由测试用 GW_STATE 摆布。响应签名照支付宝规则签 response 节点原文。
const GW_STATE = {};
const GW_SEEN = [];
let GW_SIGNER = () => ALI_KP.privateKey;
const gwSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const p = Object.fromEntries(new URLSearchParams(body));
    GW_SEEN.push(p);
    const biz = JSON.parse(p.biz_content || '{}');
    const st = GW_STATE[biz.out_trade_no] || 'WAIT_BUYER_PAY';
    const node = JSON.stringify({ code: '10000', msg: 'Success', out_trade_no: biz.out_trade_no,
      trade_no: 'T' + biz.out_trade_no, trade_status: st, total_amount: GW_STATE[biz.out_trade_no + ':amt'] || '18.00' });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(node, 'utf8'), GW_SIGNER()).toString('base64');
    res.writeHead(200, { 'content-type': 'application/json' });
    // 手拼原文：sign 签的就是 node 这段字节，服务端要从原文里抠出来验
    res.end(`{"alipay_trade_query_response":${node},"sign":"${sig}"}`);
  });
});
gwSrv.listen(8795, '127.0.0.1');
gwSrv.unref();

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

  console.log('\n== 支付：支付宝 手机网站支付（9-29）==');
  {
    const PAY = require('./pay.js');
    const { signContent } = PAY._internal;
    ok(PAY.READY, 'pay.js 读到了私钥 + 支付宝公钥（一行 base64 折行套 PEM 头那条路）');
    const PR = await ja('GET', '/api/products');
    ok(PR.status === 200 && PR.body.products['theme.onsen'] && PR.body.products['theme.onsen'].fen === 1800, '价目表公开：theme.onsen ¥18 从 rewards_catalog.json 读来');
    ok(!PR.body.products['theme.ink'], '免费主题（ink）不在价目表里');
    const U = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken({ sub: 'pay-user-1' }) });
    ok(U.status === 200 && U.body.token, '付费测试用户登录');
    const TOK = U.body.token;
    const U2 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken({ sub: 'pay-user-2' }) });
    const TOK2 = U2.body.token;

    ok((await ja('POST', '/api/pay/create', { product: 'theme.onsen' })).status === 401, '不登录不能建单（权益要有归属）');
    ok((await ja('POST', '/api/pay/create', { product: 'theme.ink' }, TOK)).status === 400, '免费主题建不了单');
    ok((await ja('POST', '/api/pay/create', { product: 'nope' }, TOK)).status === 400, '不认识的商品 400');
    const C = await ja('POST', '/api/pay/create', { product: 'theme.onsen' }, TOK);
    ok(C.status === 200 && C.body.orderNo && C.body.payUrl && C.body.amountFen === 1800, '建单：拿到订单号 + payUrl，金额 1800 分由服务端定');
    const u = new URL(C.body.payUrl);
    const qp = Object.fromEntries(u.searchParams);
    ok(u.origin + u.pathname === 'http://127.0.0.1:8795/gateway.do', 'payUrl 指向网关');
    ok(qp.app_id === '2021000000000001' && qp.method === 'alipay.trade.wap.pay' && qp.sign_type === 'RSA2' && qp.charset === 'utf-8', '公共参数齐全');
    const biz = JSON.parse(qp.biz_content);
    ok(biz.out_trade_no === C.body.orderNo && biz.total_amount === '18.00' && biz.product_code === 'QUICK_WAP_WAY' && biz.subject.includes('野天风吕'), 'biz_content：订单号 / 18.00 / QUICK_WAP_WAY / 商品名');
    ok(qp.notify_url.endsWith('/capyroom/api/pay/alipay/notify') && qp.return_url.endsWith('/capyroom/pay/'), 'notify_url / return_url 指向 capyroom 自己的路径');
    ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(qp.timestamp), 'timestamp 是 yyyy-MM-dd HH:mm:ss');
    ok(crypto.verify('RSA-SHA256', Buffer.from(signContent(qp, ['sign']), 'utf8'), APP_KP.publicKey, Buffer.from(qp.sign, 'base64')), '请求签名能用应用公钥验过');
    const A = await ja('POST', '/api/pay/create', { product: 'theme.onsen', channel: 'alipay_app' }, TOK);
    ok(A.status === 200 && A.body.orderStr && !A.body.payUrl && A.body.orderStr.includes('alipay.trade.app.pay'), 'APP 支付通道返回 orderStr（不返回 payUrl）');
    const TT = await ja('POST', '/api/pay/create', { product: 'test001' }, TOK);
    ok(TT.status === 200 && TT.body.amountFen === 1, 'LS_PAY_TEST_PRODUCT=1 时 test001 ￥0.01 可建');

    const seen0 = GW_SEEN.length;
    const O1 = await ja('GET', '/api/pay/order?no=' + C.body.orderNo, null, TOK);
    ok(O1.status === 200 && O1.body.status === 'CREATED', '未付款：查单返回 CREATED');
    ok(GW_SEEN.length === seen0 + 1 && GW_SEEN[seen0].method === 'alipay.trade.query', '查单时服务端真的去支付宝反查了一次');
    ok((await ja('GET', '/api/pay/order?no=' + C.body.orderNo, null, TOK)).status === 200 && GW_SEEN.length === seen0 + 1, '3 秒内再查不重复打支付宝（限频）');
    ok((await ja('GET', '/api/pay/order?no=' + C.body.orderNo, null, TOK2)).status === 404, '别人的订单查不到（按 uid 隔离）');
    const E0 = await ja('GET', '/api/entitlements', null, TOK);
    ok(E0.status === 200 && E0.body.products.length === 0, '付款前没有权益');

    const notifyPost = async (over = {}, signer = ALI_KP.privateKey) => {
      const p = { app_id: '2021000000000001', out_trade_no: C.body.orderNo, trade_no: 'TRADE0001', trade_status: 'TRADE_SUCCESS',
        total_amount: '18.00', seller_id: '2088000000000000', buyer_id: '2088111111111111', notify_id: 'n1', notify_time: '2026-09-29 20:00:00',
        gmt_payment: '2026-09-29 20:00:00', sign_type: 'RSA2', ...over };
      p.sign = crypto.sign('RSA-SHA256', Buffer.from(signContent(p, ['sign', 'sign_type']), 'utf8'), signer).toString('base64');
      const r = await fetch(BASE + '/api/pay/alipay/notify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p).toString() });
      return r.text();
    };
    ok(await notifyPost({}, APP_KP.privateKey) === 'fail', 'notify 用错钥匙签的（非支付宝公钥可验）→ fail');
    ok(await notifyPost({ total_amount: '0.18' }) === 'fail', 'notify 金额对不上 → fail，不发权益');
    ok(await notifyPost({ app_id: '2021000000000000' }) === 'fail', 'notify app_id 不是我们的 → fail');
    ok(await notifyPost({ out_trade_no: 'CPNOSUCH' }) === 'fail', 'notify 查无此单 → fail');
    ok((await ja('GET', '/api/entitlements', null, TOK)).body.products.length === 0, '上面四条坏 notify 一个权益都没发出去');
    ok(await notifyPost() === 'success', '合法 notify → success');
    const O2 = await ja('GET', '/api/pay/order?no=' + C.body.orderNo, null, TOK);
    ok(O2.body.status === 'PAID' && O2.body.tradeNo === 'TRADE0001', '订单 → PAID，带支付宝交易号（客户端落账记它）');
    const E1 = await ja('GET', '/api/entitlements', null, TOK);
    ok(E1.body.products.includes('theme.onsen') && E1.body.items[0].orderNo === C.body.orderNo, '权益发了：theme.onsen，带订单号');
    ok(await notifyPost() === 'success', '同一条 notify 重放 → 仍回 success（支付宝才会停止重试）');
    ok(Number(srv.db.prepare('SELECT COUNT(*) AS c FROM entitlements WHERE uid = ?').get(U.body.uid).c) === 1, '重放后权益仍只有 1 条（幂等）');
    const C2 = await ja('POST', '/api/pay/create', { product: 'theme.onsen' }, TOK2);
    await notifyPost({ out_trade_no: C2.body.orderNo });
    ok((await ja('GET', '/api/pay/order?no=' + C2.body.orderNo, null, TOK2)).body.status !== 'PAID', '同一个 trade_no 再挂到别的单 → 不发权益（trade_no UNIQUE）');

    const C3 = await ja('POST', '/api/pay/create', { product: 'theme.onsen' }, TOK2);
    GW_STATE[C3.body.orderNo] = 'TRADE_SUCCESS';
    ok((await ja('GET', '/api/pay/order?no=' + C3.body.orderNo, null, TOK2)).body.status === 'PAID', '没等到 notify 也能靠反查到账（反查响应验签通过）');
    ok((await ja('GET', '/api/entitlements', null, TOK2)).body.products.includes('theme.onsen'), '反查到账同样发权益');
    const C4 = await ja('POST', '/api/pay/create', { product: 'theme.onsen' }, TOK);
    GW_STATE[C4.body.orderNo] = 'TRADE_SUCCESS'; GW_STATE[C4.body.orderNo + ':amt'] = '1.80';
    ok((await ja('GET', '/api/pay/order?no=' + C4.body.orderNo, null, TOK)).body.status === 'CREATED', '反查说付了但金额不对 → 不认');
    const C5 = await ja('POST', '/api/pay/create', { product: 'theme.onsen' }, TOK);
    GW_STATE[C5.body.orderNo] = 'TRADE_SUCCESS';
    const badKP = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    GW_SIGNER = () => badKP.privateKey;
    const O5 = await ja('GET', '/api/pay/order?no=' + C5.body.orderNo, null, TOK);
    GW_SIGNER = () => ALI_KP.privateKey;
    ok(O5.body.status === 'CREATED', '反查响应签名验不过 → 不认（中间人塞 TRADE_SUCCESS 无效）');
    ok(await notifyPost({ out_trade_no: C4.body.orderNo, trade_status: 'TRADE_CLOSED', trade_no: 'TRADE_CLOSED1' }) === 'success', 'TRADE_CLOSED 的 notify 回 success');
    ok((await ja('GET', '/api/pay/order?no=' + C4.body.orderNo, null, TOK)).body.status === 'CLOSED', '关单 notify → CLOSED');
    // 删账号连订单/权益一起删（下面「删除账号」段会删 L1，这里用 pay-user-2 单测）
    ok((await ja('POST', '/api/auth/delete', {}, TOK2)).status === 200, '付费用户删号 200');
    ok(Number(srv.db.prepare('SELECT COUNT(*) AS c FROM entitlements WHERE uid = ?').get(U2.body.uid).c) === 0
      && Number(srv.db.prepare('SELECT COUNT(*) AS c FROM orders WHERE uid = ?').get(U2.body.uid).c) === 0, '删号连订单和权益一起删');
  }

  console.log('\n== 登出 / 删除账号 ==');
  ok((await ja('POST', '/api/auth/logout', {}, L2.body.token)).status === 200, '登出 200');
  ok((await ja('GET', '/api/auth/me', null, L2.body.token)).status === 401, '登出后会话失效');
  ok((await ja('POST', '/api/auth/delete', {}, L1.body.token)).status === 200, '删除账号 200');
  ok(srv.db.prepare('SELECT COUNT(*) c FROM sync_items').get().c === 0, '删账号连同步数据一起删');
  ok((await ja('GET', '/api/auth/me', null, L1.body.token)).status === 401, '删后会话失效');
  const L3 = await ja('POST', '/api/auth/login', { provider: 'apple', token: appleToken() });
  ok(L3.status === 200 && L3.body.uid !== L1.body.uid, '删后同一 Apple 号再登录 = 新 uid');

  console.log(`\n${pass} 过 / ${fail} 挂`);
  srv.server.close(); srv.db.close(); keysSrv.close(); gwSrv.close();
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); srv.server.close(); srv.db.close(); process.exitCode = 1; });
