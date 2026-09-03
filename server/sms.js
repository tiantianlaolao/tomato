// ============================================================
// Capyroom · 腾讯云短信（从戳了么 server/sms.js 原样搬来，凭据/签名/模板同一套）（手机号登录的验证码，2026-08-31）
//
// 🔴 零依赖红线不破：TC3-HMAC-SHA256 签名用 node:crypto 手写，
//    ⛔ 不装 tencentcloud-sdk-nodejs —— 部署机在国内，多一个包就多一个
//    能在服务器上失败的环节（跟 better-sqlite3 同一条教训）。
//
// 配置全走 env（凭据在 D:\ios密钥备份\lifestamps-腾讯云短信密钥.txt，不落代码）：
//   LS_SMS_SECRET_ID / LS_SMS_SECRET_KEY / LS_SMS_SDKAPPID
//   LS_SMS_SIGN（签名：北京天怡数智科技） / LS_SMS_TEMPLATE（模板 2721103）
//   LS_SMS_REGION（默认 ap-guangzhou）
// 🔴 没配就 configured()=false，account.js 对手机号登录直接 501 ——
//    美服(43.173)故意不配：手机号只属于国内线。
//
// 模板内容：您的验证码为{1}，{2}分钟内有效。如非本人操作，请忽略。
// ============================================================
'use strict';

const crypto = require('node:crypto');

const SECRET_ID = process.env.LS_SMS_SECRET_ID || '';
const SECRET_KEY = process.env.LS_SMS_SECRET_KEY || '';
const SDKAPPID = process.env.LS_SMS_SDKAPPID || '';
const SIGN = process.env.LS_SMS_SIGN || '';
const TEMPLATE = process.env.LS_SMS_TEMPLATE || '';
const REGION = process.env.LS_SMS_REGION || 'ap-guangzhou';
const HOST = 'sms.tencentcloudapi.com';

function configured() {
  return !!(SECRET_ID && SECRET_KEY && SDKAPPID && SIGN && TEMPLATE);
}

const sha256hex = s => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

// 发一条验证码短信。成功返回 true，任何失败返回 false 并打日志 ——
// 跟 net.js 同一条哲学：短信发不出去不该把接口炸成 500，上层拿 false 挑话。
async function sendCode(phone, code, minutes) {
  if (!configured()) return false;
  const payload = JSON.stringify({
    PhoneNumberSet: ['+86' + phone],
    SmsSdkAppId: SDKAPPID,
    SignName: SIGN,
    TemplateId: TEMPLATE,
    TemplateParamSet: [String(code), String(minutes)],
  });

  // ---- TC3-HMAC-SHA256（照官方文档一步步来，别"优化"顺序）----
  const ts = Math.floor(Date.now() / 1000);
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const canonical = [
    'POST', '/', '',
    'content-type:application/json; charset=utf-8',
    'host:' + HOST,
    'x-tc-action:sendsms',
    '',
    'content-type;host;x-tc-action',
    sha256hex(payload),
  ].join('\n');
  const toSign = [
    'TC3-HMAC-SHA256', ts, date + '/sms/tc3_request', sha256hex(canonical),
  ].join('\n');
  const kDate = hmac('TC3' + SECRET_KEY, date);
  const kService = hmac(kDate, 'sms');
  const kSigning = hmac(kService, 'tc3_request');
  const sig = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');

  try {
    const r = await fetch('https://' + HOST, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        host: HOST,
        authorization: `TC3-HMAC-SHA256 Credential=${SECRET_ID}/${date}/sms/tc3_request, `
          + `SignedHeaders=content-type;host;x-tc-action, Signature=${sig}`,
        'x-tc-action': 'SendSms',
        'x-tc-timestamp': String(ts),
        'x-tc-version': '2021-01-11',
        'x-tc-region': REGION,
      },
      body: payload,
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    const st = j && j.Response && j.Response.SendStatusSet && j.Response.SendStatusSet[0];
    if (st && st.Code === 'Ok') return true;
    // 失败原因要留在日志里（签名审核没过/欠费/频控），但**绝不把它透给客户端**
    console.error('[sms] 发送失败：', JSON.stringify((j && j.Response) || j).slice(0, 300));
    return false;
  } catch (e) {
    console.error('[sms] 请求失败：', String(e && e.message));
    return false;
  }
}

module.exports = { configured, sendCode };
