// ============================================================
// Capyroom · 账号 + 跨设备同步服务（2026-09-03）
//
// 从戳了么 server/ 搬来的骨架，只留账号那半边：/api/auth/*、/api/sync、/api/health。
// 🔴 **零依赖**：只用 node:http + node:sqlite，没有 npm 包（部署 = 传文件 + pm2 start）。
//    ⚠️ node:sqlite 标着 experimental，启动一行警告，正常。
// 🔴 独立实例（用户 9-3 拍板）：自己的库、自己的端口、自己的 pm2 进程，
//    和戳了么的用户池互不相通。nginx 把 /capyroom/api/ 反代到 127.0.0.1:8782/api/。
// 🔴 只听 127.0.0.1，外面一律走 nginx。
// ============================================================
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('node:http');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.LS_PORT || 8782);
const DB_PATH = process.env.LS_DB || path.join(__dirname, 'data', 'capyroom.db');
const BODY_LIMIT = 64 * 1024;

// ---- 库 --------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ⚠️ readBody / send 在下面才定义 —— 箭头包一层延迟取值
const account = require('./account.js').mount({
  db,
  send: (...a) => send(...a),
  readBody: (...a) => readBody(...a),
});

// ---- 跨域 ------------------------------------------------------------------
// Tauri 壳的 origin：iOS 是 tauri://localhost，Android 是 http://tauri.localhost（v2 默认）。
// 本地截图验收走 http://127.0.0.1:89xx（端口不固定，按前缀放）。
// ⛔ 不用 `*`、不发 Allow-Credentials（Bearer 在头里，不靠 cookie）。
const ALLOW_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function originOk(o) {
  return ALLOW_ORIGINS.has(o) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o);
}
function applyCors(req, res) {
  res.setHeader('Vary', 'Origin');           // 🔴 响应随 Origin 变，缓存层必须知道
  const o = req.headers.origin;
  if (o && originOk(o)) res.setHeader('Access-Control-Allow-Origin', o);
}

// ---- 小工具 ----------------------------------------------------------------
function send(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

// ---- 路由 ------------------------------------------------------------------
async function route(req, res, pathname) {
  const m = req.method;
  if (m === 'OPTIONS' && pathname.startsWith('/api/')) {
    res.writeHead(204, {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-max-age': '86400',
      'content-length': '0',
    });
    res.end();
    return true;
  }
  {
    const hit = await account.route(req, res, pathname);
    if (hit !== null) return hit;
  }
  if (m === 'GET' && pathname === '/api/health') {
    const users = Number(db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
    return send(res, 200, { ok: true, app: 'capyroom', users });
  }
  return null;
}

// ---- 起 --------------------------------------------------------------------
const server = http.createServer((req, res) => {
  applyCors(req, res);                        // 🔴 每一条响应都带，包括 4xx/5xx 和预检
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; }
  catch (_) { return send(res, 400, { error: 'bad url' }); }
  route(req, res, pathname)
    .then(hit => { if (hit === null) send(res, 404, { error: 'not found' }); })
    .catch(err => {
      const msg = String(err && err.message);
      if (msg === 'too large') { send(res, 413, { error: 'too large' }); req.destroy(); return; }
      if (msg === 'bad json') return send(res, 400, { error: 'bad json' });
      console.error('[500]', req.method, pathname, msg);
      send(res, 500, { error: 'server error' });
    });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`capyroom-server :${PORT}  db=${DB_PATH}`);
});

// 导出给 test.js：测完 close 掉 server 和 db 再退出（Windows 上直接 process.exit 会撞 libuv 断言）
module.exports = { server, db };
