// capyroom 资产通道：视频不进 App 包，首启从服务器缓存到 IndexedDB。
//
// 为什么：场景视频 ~30MB/主题焊进二进制，内测出包要跨境传（OTA 慢的根源）。
// 摘出去后包 2.4MB；视频只在美术变更时从本机传一次服务器（国内→国内）。
//
// 9-1 起主题感知：每个场景包声明自己的资产清单（S.assets），
//   AS.configure() 切主题——服务器目录、本地 dev 目录、IDB 键都按主题分。
//
// 播放策略（🔴 没有"等下载完"的门）：
//   url(name) 有缓存给 blob URL，没缓存直接给服务器网址流播——
//   <video> 网络流播不受 CORS 限制，首启零等待就能播；后台默默把各段
//   fetch 进 IndexedDB（这一步才要 CORS，nginx 已加头），下次启动全走本地。
//   离线 + 没缓存过 = 播不出（内测可接受；正式商店包资产回二进制，见档案）。
//
// 开发/截图验收（http:// 起源）：走本地目录相对路径——那批文件
// git rm --cached 了但**留在本地盘上**（frontendDist 整目录编进二进制，
// CI 靠 git 没有它们=包瘦；本地有它们=dev 照旧）。
(function () {
'use strict';

const HOST = 'https://www.tybbtech.com/capyroom/assets/';
// 🔴 9-5 安卓真机"水波没有/过场切不了"的根：以前按 protocol 判开发环境（http/https = 浏览器截图/dev），
//    iOS 壳是 tauri://localhost 没事，**安卓壳是 http://tauri.localhost** → 被当成 dev → 视频指向包内 assets/video-cn/
//    （按规矩不进包）→ 全 404 → 视频永远不来。改成"有 Tauri 桥就是正式包"，协议不再参与判断。
const DEV = !(window.__TAURI__ && window.__TAURI__.core);

let cur = null;          // {base, dir, names}
const map = {};          // '<base>/<name>' -> blob objectURL（永不 revoke，整场复用）

window.AS = {
  // 场景包声明：{base:'v1'|'cn-v1', dir:'assets/video'|'assets/video-cn', names:[...]}
  configure(a) {
    if (!a || (cur && cur.base === a.base)) return;
    cur = a;
    if (!DEV) ensure(a);
  },
  url(name) {
    if (!cur) return null;
    if (DEV) return cur.dir + '/' + name + '.mp4';
    return map[cur.base + '/' + name] || HOST + cur.base + '/' + name + '.mp4';
  },
  // 角色通道（9-3）：<base>/matte/<seg>.json + <seg>_<k>.webp，与视频同版本同目录（_design/video/_cmp/_matte.py 产）。
  // 有缓存给 blob，没缓存直接走服务器；ensure() 在视频之后顺手缓进 IDB。
  matteUrl(file) {
    if (!cur) return null;
    if (DEV) return cur.dir + '/matte/' + file;
    return map[cur.base + '/matte/' + file] || HOST + cur.base + '/matte/' + file;
  },
  // 诊断一行（调汤「画面」行用）：dev 还是正式、资产源、当前主题几段已缓进 IDB（其余走网播）
  diag() {
    if (!cur) return 'AS: 没配场景';
    const names = cur.names || [];
    const cached = names.filter((n) => (map[cur.base + '/' + n] || '').startsWith('blob:')).length;
    const matte = Object.keys(map).filter((k) => k.startsWith(cur.base + '/matte/')).length;
    return 'AS ' + (DEV ? 'DEV(本地目录 ' + cur.dir + ')' : 'PROD ' + HOST) + ' base=' + cur.base + ' 视频缓存 ' + cached + '/' + names.length + ' 通道文件 ' + matte + ' origin=' + location.origin;
  },
};

if (DEV) return;

function idb() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('capy-assets', 1);
    q.onupgradeneeded = () => q.result.createObjectStore('vids');
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
function get(db, k) {
  return new Promise((res) => {
    const q = db.transaction('vids').objectStore('vids').get(k);
    q.onsuccess = () => res(q.result); q.onerror = () => res(null);
  });
}
function put(db, k, v) {
  return new Promise((res) => {
    const q = db.transaction('vids', 'readwrite').objectStore('vids').put(v, k);
    q.onsuccess = () => res(true); q.onerror = () => res(false);
  });
}

// 首启小提示（角标，不挡画面，缓存齐了自己消失）
let tip = null;
function note(txt) {
  if (!txt) { if (tip) tip.remove(); tip = null; return; }
  if (!tip) {
    tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 86px);' +
      'transform:translateX(-50%);z-index:60;padding:6px 14px;border-radius:14px;' +
      'background:rgba(20,14,8,.72);color:#e8cfa8;font-size:12px;pointer-events:none';
    document.body.appendChild(tip);
  }
  tip.textContent = txt;
}

async function ensure(a) {
  let db;
  try { db = await idb(); } catch (e) { return; }   // IDB 不可用＝一直流播，也能用
  let miss = [];
  for (const n of a.names) {
    const k = a.base + '/' + n;
    if (map[k]) continue;
    const rec = await get(db, k);
    if (rec && rec.blob) map[k] = URL.createObjectURL(rec.blob);
    else miss.push(n);
  }
  if (!miss.length) return;
  // 逐段拉（并发 1：省内存；国内链路一个主题 ~35MB 二十几秒）
  let done = a.names.length - miss.length;
  for (const n of miss) {
    if (cur !== a) return;                         // 中途切了主题就让位
    note('正在缓存场景 ' + (done + 1) + '/' + a.names.length);
    try {
      const r = await fetch(HOST + a.base + '/' + n + '.mp4');
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      await put(db, a.base + '/' + n, { blob });
      map[a.base + '/' + n] = URL.createObjectURL(blob);
      done++;
    } catch (e) { /* 这段留网播，下次再补 */ }
  }
  note(null);
  // 角色通道：json + 精灵图逐个缓（小文件，静默；缓不上就一直走网）
  for (const n of a.names) {
    if (cur !== a) return;
    try {
      const jk = a.base + '/matte/' + n + '.json';
      let meta = await get(db, jk);
      if (!meta) {
        const r = await fetch(HOST + jk); if (!r.ok) continue;
        meta = await r.json(); await put(db, jk, meta);
      }
      for (const sh of (meta.sheets || [])) {
        const k = a.base + '/matte/' + sh;
        if (map[k]) continue;
        const rec = await get(db, k);
        if (rec && rec.blob) { map[k] = URL.createObjectURL(rec.blob); continue; }
        const r = await fetch(HOST + k); if (!r.ok) continue;
        const blob = await r.blob(); await put(db, k, { blob }); map[k] = URL.createObjectURL(blob);
      }
    } catch (e) { /* 下次再补 */ }
  }
}
})();
