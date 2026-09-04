// capyroom 移动端渲染引擎 —— 整场视频状态机版（8-30 架构定案：canvas 精灵机退役）
//
// 🔴 这一层只吃 view 对象，不认识 Tauri（桥在 index.html/main.js 接）。
// 🔴 引擎不认识任何具体场景：段清单/状态映射/过场规则/槽位全在场景包（scene_onsen.js）。
//
// 画面＝一段整场循环视频（关键帧首尾帧钉扣子→ <video loop> 原生无缝）：
//   状态切换＝雾吞吐转场（0.95s 变浓 → 幕后换段 → 散开）；
//   池内→休息 先播"游到池边"过场段再入雾（上岸瞬间藏在雾里，爬岸实拍已判死）；
//   暂停＝当前视频停格 + 调光（不换段）；
//   数字/调光/命中区调试框＝一块 canvas 叠在视频上（数字永远程序画，永远清晰）。
(function () {
'use strict';

const FOG_MS = 950;
const PRE_ALERT_SEC = 30;   // 场景包经 Scene.preAlertSec 取用（末 30 秒计时渐醒目）

const Scene = {
  root:null, vids:[], vi:0, fog:null, cv:null, cx:null,
  W:0, H:0, DPR:1,
  scene:null, view:null,
  phase:'idle', seg:null, frozen:false,
  ready:false,              // 🔴 9-3：底图（海报或视频首帧）没出来之前叠加层一笔不画——冷启曾是"贴图和菜单先蹦出来，画面后到"
  poster:null,
  raf:0, running:false, lastFps:12, lastTs:0, nextFrameAt:0,
  frameGap:1000/8 - 8,      // 数字层 8fps 足够（视频自己 24fps 硬解）
  swapToken:0,
  preAlertSec: PRE_ALERT_SEC,
  brush: '"onsen-brush","STXingkai","KaiTi",serif',   // 毛笔字栈，场景包共用

  use(id) {
    const s = (window.SCENES || {})[id];
    if (!s) { console.error('没有这个场景：' + id); return; }
    this.scene = s;
    // 主题资产与首屏海报都归场景包管（9-1 双主题起）
    if (window.AS && s.assets) AS.configure(s.assets);
    if (s.assets) this.matteLoad(s.assets.names); else this.matte = {};
    const poster = s.poster || 'assets/poster.webp';
    if (this.vids) for (const el of this.vids) el.poster = poster;
    // 海报层：视频还没喂/还没出帧时舞台就是它（不然是 #stage 的深色底）；换了海报就重新等它 load
    if (this.poster && this.poster.getAttribute('src') !== poster) { this.ready = false; this.poster.src = poster; }
  },

  // 切主题（设置面板调）：落 localStorage，清段重喂
  setScene(id) {
    try { localStorage.setItem('capy_scene', id); } catch (e) {}
    this.swapToken++;
    this.use(id);
    this.seg = null; this.frozen = false; this.phase = 'idle';
    for (const el of this.vids) { el.pause(); el.classList.remove('on'); el.removeAttribute('src'); el.load(); }
    if (this.view) this.update(this.view);
    this.draw();
  },

  mount(root, sceneId) {
    this.root = root;
    root.innerHTML =
      '<img class="layer" id="sposter" alt="">' +
      '<video class="layer" id="sv0" muted playsinline></video>' +
      '<video class="layer" id="sv1" muted playsinline></video>' +
      '<div id="fog"></div>' +
      '<canvas class="layer" id="ovc"></canvas>';
    this.vids = [root.querySelector('#sv0'), root.querySelector('#sv1')];
    for (const v of this.vids) { v.setAttribute('playsinline', ''); v.poster = 'assets/poster.webp'; }
    this.fog = root.querySelector('#fog');
    this.cv = root.querySelector('#ovc');
    this.cx = this.cv.getContext('2d');
    this.poster = root.querySelector('#sposter');
    this.poster.onload = () => { this.ready = true; this.draw(); };
    this.poster.onerror = () => { this.ready = true; this.draw(); };   // 海报缺了也别把叠加层永远锁死
    let saved = null;
    try { saved = localStorage.getItem('capy_scene'); } catch (e) {}
    const qsScene = new URLSearchParams(location.search).get('scene');   // 截图验收用
    this.use(sceneId || qsScene || saved || 'onsen');
    // 🔴 canvas fillText 不会触发 @font-face 加载，必须显式预载；
    //    加载完立刻重画一次（8fps 循环也会自愈，这里只是别让首屏闪一帧衬线字）
    if (document.fonts && document.fonts.load) {
      document.fonts.load('12px onsen-brush').then(() => this.draw()).catch(() => {});
    }
    new ResizeObserver(() => this.resize()).observe(root);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize() {
    const r = this.root.getBoundingClientRect();
    this.DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    this.W = Math.round(r.width * this.DPR);
    this.H = Math.round(r.height * this.DPR);
    this.cv.width = this.W; this.cv.height = this.H;
    this.draw();
  },

  // 关键帧画幅归一化坐标 → 画布像素（cover，与视频 object-fit:cover 同一套变换）
  map(nx, ny) {
    const [iw, ih] = this.scene.frame;
    const s = Math.max(this.W / iw, this.H / ih);
    return [(this.W - iw*s)/2 + nx*iw*s, (this.H - ih*s)/2 + ny*ih*s];
  },
  rect(r) {
    const a = this.map(r.x, r.y), b = this.map(r.x2, r.y2);
    return { x:a[0], y:a[1], w:b[0]-a[0], h:b[1]-a[1] };
  },

  // 视频地址统一问资产通道（assets.js：缓存给 blob、没缓存流播服务器、dev 走本地文件）
  src(name) { return (window.AS ? AS.url(name) : 'assets/video/' + name + '.mp4'); },

  // ── 角色通道（9-3）：每段视频配逐帧水豚 alpha（_design/video/_cmp/_matte.py 产，与视频同版本同目录），
  //    小物层先画到离屏、按当前视频帧把水豚那块挖掉再贴上——小物永远在角色后面，像素零牺牲。
  //    🔴 这是"小物压在水豚上"的根治：不认槽位不认场景，新加一段视频跑一遍脚本即生效。
  //    帧同步用 requestVideoFrameCallback 的 mediaTime（iOS 15.4+），没有就退回 currentTime。
  matte: {}, vt: -1,
  matteLoad(names) {
    this.matte = {};
    if (!window.AS) return;
    for (const n of names) {
      const url = AS.matteUrl(n + '.json'); if (!url) continue;
      fetch(url).then((r) => (r.ok ? r.json() : null)).then((meta) => {
        if (!meta || !meta.frames) { this.matte[n] = null; return; }
        const sheets = (meta.sheets || []).map((f) => { const im = new Image(); im.src = AS.matteUrl(f); return im; });
        this.matte[n] = { meta, sheets };
      }).catch(() => { this.matte[n] = null; });
    }
  },
  hasMatte() { return !!(this.seg && this.matte[this.seg]); },
  // 同帧合成（9-3 用户："视觉不能有一点含糊"）：过渡段把当前视频帧画进叠加画布，洞和画面取自同一帧——
  // 之前视频由系统解码器上屏、洞由画布画，两条管线差一帧（42ms），水豚走路一帧挪十来像素就露一条茶盘边。
  // 循环段水豚只是呼吸，差一帧不到 1px，仍走"只挖洞"的省电路。
  sameFrame() {
    const S = this.scene;
    return this.hasMatte() && (this.seg === S.swimOut || this.seg === S.swimIn);
  },
  coverRect(el) {
    const vw = el.videoWidth || 1088, vh = el.videoHeight || 1920, s = Math.max(this.W / vw, this.H / vh);
    return [(this.W - vw * s) / 2, (this.H - vh * s) / 2, vw * s, vh * s];
  },
  drawVideo(cx) {
    const el = this.cur(); if (!el || el.readyState < 2) return false;
    // 换段后 500ms 内复刻 CSS 的交叉淡化（旧段打底、新段按进度叠），不然画布一盖淡化就没了
    const old = this.vids[1 - this.vi], t = (performance.now() - (this.swapAt || 0)) / 500;
    if (!this.hardCut && old && old !== el && old.getAttribute('src') && old.readyState >= 2 && t < 1) {
      cx.drawImage(old, ...this.coverRect(old)); cx.globalAlpha = Math.max(0, Math.min(1, t));
    }
    cx.drawImage(el, ...this.coverRect(el)); cx.globalAlpha = 1;
    return true;
  },
  // 当前段当前帧的遮罩块：精灵图坐标 + 画布像素坐标；这一帧没角色（空庭）返回 null
  matteFrame() {
    const m = this.seg && this.matte[this.seg]; if (!m) return null;
    const el = this.cur(); if (!el) return null;
    const t = this.vt >= 0 ? this.vt : el.currentTime;
    const fr = m.meta.frames, idx = Math.max(0, Math.min(fr.length - 1, Math.round(t * m.meta.fps)));
    const f = fr[idx]; if (!f) return null;
    const img = m.sheets[f[0]]; if (!img || !img.complete || !img.naturalWidth) return null;
    const [cw, ch] = m.meta.cell, cols = m.meta.cols, sc = m.meta.scale;
    // 🔴 遮罩坐标是**视频**像素系（1088×1920），不是母版画幅（1152×2048）——按视频自己的 cover 变换映射，
    //    否则整块往左上偏 3%（9-3 红色叠层一眼看出来）
    const vw = m.meta.w || 1088, vh = m.meta.h || 1920, s = Math.max(this.W / vw, this.H / vh);
    const ox = (this.W - vw * s) / 2, oy = (this.H - vh * s) / 2;
    return { img, sx: (f[1] % cols) * cw, sy: Math.floor(f[1] / cols) * ch, sw: f[4], sh: f[5],
             x: ox + f[2] * sc * s, y: oy + f[3] * sc * s, w: f[4] * sc * s, h: f[5] * sc * s };
  },
  // 在离屏小物层上挖掉水豚（destination-out）。没得挖返回 false
  matteCut(pcx) {
    const f = this.matteFrame(); if (!f) return false;
    pcx.save(); pcx.globalCompositeOperation = 'destination-out';
    pcx.drawImage(f.img, f.sx, f.sy, f.sw, f.sh, f.x, f.y, f.w, f.h); pcx.restore();
    return true;
  },

  // 🔴 内核 status 只有 idle/running/paused/awaiting/done，没有 work/break——
  //    工作还是休息看 stages[idx].kind（老引擎的显式映射，原样保留）
  phaseOf(v) {
    if (!v || v.status === 'idle') return 'idle';
    if (v.status === 'done') return 'done';
    if (v.status === 'awaiting') return 'awaiting';
    if (v.status === 'paused') return 'paused';
    const cur = v.stages && v.stages[v.idx];
    return (cur && cur.kind === 'break') ? 'break' : 'work';
  },

  // 状态 → 段名（break 按本段时长分池：≥600s 长休吃瓜，否则晒太阳）
  segFor(ph, v) {
    const L = this.scene.loops;
    if (ph === 'paused') return this.seg;          // 暂停不换段（停格）
    if (ph === 'break') {
      const cur = v && v.stages && v.stages[v.idx];
      return (cur && cur.secs >= 600) ? L.longBreak : L.shortBreak;
    }
    return L[ph] !== undefined ? L[ph] : L.idle;
  },

  cur()   { return this.vids[this.vi]; },
  spare() { return this.vids[1 - this.vi]; },

  // 雾吞吐：变浓 → 幕后换段 → 散开
  fogSwap(seg, loop) {
    const token = ++this.swapToken;
    this.fog.classList.add('on');
    setTimeout(() => {
      if (token !== this.swapToken) return;
      this.playOn(this.spare(), seg, loop);
      this.fog.classList.remove('on');
    }, FOG_MS);
  },

  // hard（9-4）：接口处**硬切**——游出/游回两段与工作循环的接口帧只差几像素，0.5s 交叉淡化反而让两个水豚
  //   同时可见半秒（用户："大小两个水豚晃一下"）。硬切＝等新段**第一帧解码到位**（rVFC 首拍 / loadeddata）
  //   再一次性换类，换类时两个元素都临时去掉 transition；canvas 侧 drawVideo 也不再叠旧帧。
  playOn(el, seg, loop, hard) {
    const old = this.cur();
    this.hardCut = !!hard;
    el.loop = !!loop;
    el.src = this.src(seg);
    el.currentTime = 0;
    el.play().catch(() => {});
    let revealed = false;
    const reveal = () => {
      if (revealed || this.cur() !== el) return;
      revealed = true;
      el.classList.add('cut'); old.classList.add('cut');
      el.classList.add('on'); if (old !== el) old.classList.remove('on');
      requestAnimationFrame(() => { el.classList.remove('cut'); old.classList.remove('cut'); });
      this.draw();
    };
    el.onloadeddata = () => {
      if (!this.ready) { this.ready = true; this.draw(); }
      if (hard) reveal();
    };
    if (hard) setTimeout(reveal, 1500);   // 首帧迟迟不来（网络卡）也别让画面停在旧段
    // 角色通道跟帧：视频每呈现一帧就拿 mediaTime 重画叠加层（过渡段每帧、循环段隔帧——循环里水豚只是呼吸）
    this.vt = -1;
    if (el.requestVideoFrameCallback) {
      const tok = (el._vfc = (el._vfc || 0) + 1);
      const tick = (now, md) => {
        if (el._vfc !== tok || this.cur() !== el) return;
        this.vt = md.mediaTime;
        if (hard) reveal();                    // 硬切：第一帧真的呈现了才换类
        if (this.hasMatte()) this.draw();      // 有角色通道的段每帧重画（过渡段连视频帧一起画，同帧）
        el.requestVideoFrameCallback(tick);
      };
      el.requestVideoFrameCallback(tick);
    }
    if (!hard) el.classList.add('on');
    // 🔴 首次喂数据时新旧是同一个元素——摘 .on/卸 src 只对"真的旧元素"做，
    //    否则刚点亮就被自己摘掉＝黑屏（idle/paused 首屏黑就是这个）
    if (old !== el) {
      this.swapAt = hard ? 0 : performance.now();
      if (!hard) old.classList.remove('on');
      // 硬切时旧段要撑到新段首帧露出（最晚 1.5s 兜底）之后再卸
      setTimeout(() => { if (this.cur() !== old) { old.pause(); old.removeAttribute('src'); old.load(); } }, hard ? 2200 : 700);
    }
    this.vi = this.vids.indexOf(el);
    this.seg = seg;
  },

  update(view) {
    if (!view || !this.scene) return;
    const ph = this.phaseOf(view);
    const wasPh = this.phase;
    this.view = view;
    // 首次喂数据：直接上段不走雾（放最前，避免和切换逻辑双路都去 playOn）
    if (!this.seg) {
      let seg = this.segFor(ph, view);
      if (!seg) {
        const ph2 = this.phaseOf(Object.assign({}, view, { status: 'running' }));
        seg = this.segFor(ph2, view);
      }
      this.playOn(this.cur(), seg, true);
      if (ph === 'paused') { this.frozen = true; this.cur().pause(); }
      this.phase = ph;
      return;
    }
    if (ph === wasPh) {
      // break 中场（长短休不会中途互换）——不动
    } else {
      // 暂停/恢复＝停格与解冻，不换段不进雾
      if (ph === 'paused') { this.frozen = true; this.cur().pause(); }
      else if (wasPh === 'paused' && this.segFor(ph, view) === this.seg) {
        this.frozen = false; this.cur().play().catch(() => {});
      } else {
        this.frozen = false;
        const seg = this.segFor(ph, view);
        if (seg && seg !== this.seg) {
          const S = this.scene;
          const fromPool = S.poolStates.includes(wasPh);
          const toBreak = (ph === 'break');
          if (fromPool && toBreak && S.swimOut) {
            // 铃响：先游到池边（一次性段），演完入雾换休息循环
            const token = ++this.swapToken;
            const sp = this.spare();
            this.playOn(sp, S.swimOut, false, true);   // 硬切：游出首帧钉的就是工作循环帧
            sp.onended = () => {
              if (token !== this.swapToken) return;
              this.fogSwap(seg, true);
            };
          } else if (wasPh === 'break' && ph === 'work' && S.swimIn) {
            // 回程：雾散时水豚已在池边 → 游回池心 → 交叉淡化接工作循环
            //（swimIn 尾帧钉的 K1b；只有 break→work 走这条，其余仍纯雾转场）
            const token = ++this.swapToken;
            this.fog.classList.add('on');
            setTimeout(() => {
              if (token !== this.swapToken) return;
              const sp = this.spare();
              this.playOn(sp, S.swimIn, false);
              this.fog.classList.remove('on');
              sp.onended = () => {
                if (token !== this.swapToken) return;
                this.playOn(this.spare(), seg, true, true);   // 硬切：游回尾帧钉的就是工作循环首帧
              };
            }, FOG_MS);
          } else {
            this.fogSwap(seg, true);
          }
        }
      }
      this.phase = ph;
    }
  },

  // ── 叠加层：数字 + 状态调光 + 调试框（8fps 足够）──────────────
  draw() {
    const cx = this.cx, v = this.view, S = this.scene;
    if (!cx || !S) return;
    cx.clearRect(0, 0, this.W, this.H);
    if (!this.ready) return;   // 底图没到，什么都不画（见 ready 注释）
    if (this.sameFrame()) this.drawVideo(cx);   // 过渡段：视频帧先画进来，下面的洞和它同一帧

    // 调光（视频自带黄昏光，这里只轻叠）
    const dim = (S.dim && S.dim[this.phase]) || 0;
    if (dim > 0.005) {
      cx.fillStyle = 'rgba(8,6,4,' + dim.toFixed(3) + ')';
      cx.fillRect(0, 0, this.W, this.H);
    }

    // 叠加层其余内容（菜单/当班牌/计时……）全归场景包画——引擎不认识具体场景（9-1 归位）
    if (S.drawUI) S.drawUI(this, cx, v);

    // 验收用：?matte=1 把角色通道当前帧红色半透明叠上来，看它跟视频里的水豚贴不贴
    if (window.__SHOWMATTE) {
      const f = this.matteFrame();
      if (f) {
        const k = this._mdbg || (this._mdbg = document.createElement('canvas')); k.width = f.sw; k.height = f.sh;
        const g = k.getContext('2d'); g.clearRect(0, 0, f.sw, f.sh); g.drawImage(f.img, f.sx, f.sy, f.sw, f.sh, 0, 0, f.sw, f.sh);
        g.globalCompositeOperation = 'source-in'; g.fillStyle = 'rgba(255,0,0,0.45)'; g.fillRect(0, 0, f.sw, f.sh);
        cx.drawImage(k, f.x, f.y, f.w, f.h);
      }
    }
    // 验收用：?boxes=1 画命中区
    if (window.__SHOWBOXES) {
      cx.lineWidth = 2 * this.DPR; cx.strokeStyle = 'rgba(120,255,180,.85)';
      cx.font = (14 * this.DPR) + 'px sans-serif'; cx.fillStyle = 'rgba(120,255,180,.95)';
      cx.textAlign = 'left'; cx.textBaseline = 'top';
      for (const k in S.entries) {
        const r = this.rect(S.entries[k]);
        cx.strokeRect(r.x, r.y, r.w, r.h);
        cx.fillText(k, r.x + 4*this.DPR, r.y + 4*this.DPR);
      }
    }
  },

  hitEntry(cssX, cssY) {
    const S = this.scene;
    if (!S) return null;
    const x = cssX * this.DPR, y = cssY * this.DPR;
    for (const k in S.entries) {
      const r = this.rect(S.entries[k]);
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return k;
    }
    return null;
  },

  frame(ts) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    if (ts < this.nextFrameAt) return;
    this.nextFrameAt = ts + this.frameGap;
    const dt = (ts - this.lastTs) / 1000 || 1/8;
    this.lastTs = ts;
    this.lastFps = this.lastFps * 0.8 + (1/dt) * 0.2;
    this.draw();
  },

  start() {
    if (this.running) return;
    this.running = true; this.lastTs = 0; this.nextFrameAt = 0;
    if (this.seg && !this.frozen) this.cur().play().catch(() => {});
    this.raf = requestAnimationFrame((t) => this.frame(t));
  },
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.cur().pause();          // 后台停视频省电（回前台 start 会续播）
  },
};

window.Scene = Scene;
})();
