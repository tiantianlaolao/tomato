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
const PRE_ALERT_SEC = 30;

const Scene = {
  root:null, vids:[], vi:0, fog:null, cv:null, cx:null,
  W:0, H:0, DPR:1,
  scene:null, view:null,
  phase:'idle', seg:null, frozen:false,
  raf:0, running:false, lastFps:12, lastTs:0, nextFrameAt:0,
  frameGap:1000/8 - 8,      // 数字层 8fps 足够（视频自己 24fps 硬解）
  swapToken:0,

  use(id) {
    const s = (window.SCENES || {})[id];
    if (!s) { console.error('没有这个场景：' + id); return; }
    this.scene = s;
  },

  mount(root, sceneId) {
    this.root = root;
    root.innerHTML =
      '<video class="layer" id="sv0" muted playsinline></video>' +
      '<video class="layer" id="sv1" muted playsinline></video>' +
      '<div id="fog"></div>' +
      '<canvas class="layer" id="ovc"></canvas>';
    this.vids = [root.querySelector('#sv0'), root.querySelector('#sv1')];
    for (const v of this.vids) { v.setAttribute('playsinline', ''); v.poster = 'assets/poster.webp'; }
    this.fog = root.querySelector('#fog');
    this.cv = root.querySelector('#ovc');
    this.cx = this.cv.getContext('2d');
    this.use(sceneId || 'onsen');
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

  playOn(el, seg, loop) {
    const old = this.cur();
    el.loop = !!loop;
    el.src = this.src(seg);
    el.currentTime = 0;
    el.play().catch(() => {});
    el.classList.add('on');
    // 🔴 首次喂数据时新旧是同一个元素——摘 .on/卸 src 只对"真的旧元素"做，
    //    否则刚点亮就被自己摘掉＝黑屏（idle/paused 首屏黑就是这个）
    if (old !== el) {
      old.classList.remove('on');
      setTimeout(() => { if (this.cur() !== old) { old.pause(); old.removeAttribute('src'); old.load(); } }, 700);
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
            this.playOn(sp, S.swimOut, false);
            sp.onended = () => {
              if (token !== this.swapToken) return;
              this.fogSwap(seg, true);
            };
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

    // 调光（视频自带黄昏光，这里只轻叠）
    const dim = (S.dim && S.dim[this.phase]) || 0;
    if (dim > 0.005) {
      cx.fillStyle = 'rgba(8,6,4,' + dim.toFixed(3) + ')';
      cx.fillRect(0, 0, this.W, this.H);
    }

    // ── 8-31 定案「功能上牌 + 倒计时上天」（此设计=日系主题专属，中国风主题另起炉灶）──
    const BRUSH = '"onsen-brush","STXingkai","KaiTi",serif';   // 5KB OFL 子集，dev/真机同字

    // 木牌功能菜单：只在空闲画（运行=零 UI；等待/完成走 HTML 层的按钮和卡片）
    if (this.phase === 'idle' && S.board) {
      const B = this.rect(S.board);
      cx.save();
      cx.translate(B.x + B.w / 2, B.y + B.h / 2);
      cx.rotate((S.board.tiltDeg || 0) * Math.PI / 180);   // 牌画在视频里，左低右高 ~3.2°
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      const rows = S.board.menu, rh = B.h / rows.length;
      cx.font = Math.round(rh * 0.60) + 'px ' + BRUSH;
      cx.fillStyle = S.board.ink;
      for (let i = 0; i < rows.length; i++) {
        cx.fillText(rows[i].label, 0, (i - (rows.length - 1) / 2) * rh);
      }
      cx.restore();
    }

    // 倒计时题字框：右上天空，纸色+朱红双边+竖排 MM/SS+「汤」印。
    // 浮世绘的天空本来就是题字盖印的地方——文字压在画面上是这种画的母语。
    const secs = Math.max(0, Math.round(((v && v.remaining_ms) || 0) / 1000));
    const hasTime = (this.phase === 'work' || this.phase === 'break' || this.phase === 'paused');
    if (hasTime && S.cart) {
      const C = this.rect(S.cart);
      const pre = (this.phase !== 'paused' && secs <= PRE_ALERT_SEC)
        ? (1 - secs / PRE_ALERT_SEC) : 0;                  // 末 30 秒纸色渐醒目
      cx.save();
      // 和纸底（半透让天色透一点，压住"贴片感"）+ 朱红双边
      cx.fillStyle = 'rgba(' + S.cart.paper + ',' + (0.80 + pre * 0.12).toFixed(2) + ')';
      cx.fillRect(C.x, C.y, C.w, C.h);
      cx.strokeStyle = 'rgba(' + S.cart.border + ',0.95)';
      cx.lineWidth = Math.max(2, C.w * 0.018);
      cx.strokeRect(C.x, C.y, C.w, C.h);
      cx.lineWidth = Math.max(1, C.w * 0.006);
      cx.strokeStyle = 'rgba(' + S.cart.border + ',0.55)';
      const p = C.w * 0.055;
      cx.strokeRect(C.x + p, C.y + p, C.w - 2 * p, C.h - 2 * p);
      // 竖排两段：分 / 秒
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.font = Math.round(C.w * 0.52) + 'px ' + BRUSH;
      cx.fillStyle = S.cart.ink;
      const mm = String(Math.floor(secs / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      cx.fillText(mm, C.x + C.w / 2, C.y + C.h * 0.225);
      cx.fillText(ss, C.x + C.w / 2, C.y + C.h * 0.545);
      // 中间一道笔断意连的分隔（略斜，呼应手写）
      cx.strokeStyle = 'rgba(90,58,30,0.7)';
      cx.lineWidth = Math.max(2, C.w * 0.014);
      cx.beginPath();
      cx.moveTo(C.x + C.w * 0.28, C.y + C.h * 0.392);
      cx.lineTo(C.x + C.w * 0.72, C.y + C.h * 0.378);
      cx.stroke();
      // 落款印
      const sw = C.w * 0.30, sx = C.x + (C.w - sw) / 2, sy = C.y + C.h * 0.72;
      cx.fillStyle = S.cart.sealBg;
      cx.fillRect(sx, sy, sw, sw);
      cx.font = Math.round(sw * 0.72) + 'px ' + BRUSH;
      cx.fillStyle = 'rgba(245,235,215,0.95)';
      cx.fillText(S.cart.seal, sx + sw / 2, sy + sw * 0.54);
      cx.restore();
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
