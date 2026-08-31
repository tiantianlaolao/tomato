// capyroom 资产通道：视频不进 App 包，首启从服务器缓存到 IndexedDB。
//
// 为什么：7 段场景视频 ~29MB 焊进二进制，每次内测出包都要跨境传 35MB（OTA 慢的根源）。
// 摘出去后包回 5MB 级；视频只在美术变更时从本机传一次服务器（国内→国内）。
//
// 播放策略（🔴 没有"等下载完"的门）：
//   url(name) 有缓存给 blob URL，没缓存直接给服务器网址流播——
//   <video> 网络流播不受 CORS 限制，首启零等待就能播；后台默默把 7 段
//   fetch 进 IndexedDB（这一步才要 CORS，nginx 已加头），下次启动全走本地。
//   离线 + 无缓存 = 播不出（内测可接受；正式商店包资产回二进制，见档案）。
//
// 开发/截图验收（http:// 起源）：走本地 assets/video/ 相对路径——那批文件
// git rm --cached 了但**留在本地盘上**（frontendDist 是整目录编进二进制，
// 所以 CI 靠 git 没有它们=包瘦；本地有它们=dev 照旧）。
(function () {
'use strict';

const VER = 1;                 // 美术批次号：换资产 → 服务器传 v{N+1}/ + 这里 +1
const CDN = 'https://www.tybbtech.com/capyroom/assets/v' + VER + '/';
const NAMES = ['loop_soak', 'loop_work', 'loop_sunbathe', 'loop_eat',
               'loop_urge', 'loop_empty', 't_a_swim'];
const DEV = location.protocol === 'http:' || location.protocol === 'https:';

const map = {};                // name -> blob objectURL（永不 revoke，整场复用）

window.AS = {
  url(name) {
    if (DEV) return 'assets/video/' + name + '.mp4';
    return map[name] || CDN + name + '.mp4';
  },
};

if (DEV) return;

// ── 后台缓存（不阻塞任何东西）─────────────────────────────
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

(async () => {
  let db;
  try { db = await idb(); } catch (e) { return; }   // IDB 不可用＝一直流播，也能用
  let miss = [];
  for (const n of NAMES) {
    const rec = await get(db, n);
    if (rec && rec.ver === VER && rec.blob) map[n] = URL.createObjectURL(rec.blob);
    else miss.push(n);
  }
  if (!miss.length) return;
  // 逐段拉（并发 1：省内存，反正是后台活；国内链路 29MB 十几秒）
  let done = NAMES.length - miss.length;
  for (const n of miss) {
    note('首次启动，正在缓存场景 ' + (done + 1) + '/' + NAMES.length);
    try {
      const r = await fetch(CDN + n + '.mp4');
      if (!r.ok) throw new Error(r.status);
      const blob = await r.blob();
      await put(db, n, { ver: VER, blob });
      map[n] = URL.createObjectURL(blob);
      done++;
    } catch (e) { /* 这段留网播，下次启动再补 */ }
  }
  note(null);
})();
})();
