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
    if (this.vids) for (const el of this.vids) el.poster = s.poster || 'assets/poster.webp';
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
      '<video class="layer" id="sv0" muted playsinline></video>' +
      '<video class="layer" id="sv1" muted playsinline></video>' +
      '<div id="fog"></div>' +
      '<canvas class="layer" id="ovc"></canvas>';
    this.vids = [root.querySelector('#sv0'), root.querySelector('#sv1')];
    for (const v of this.vids) { v.setAttribute('playsinline', ''); v.poster = 'assets/poster.webp'; }
    this.fog = root.querySelector('#fog');
    this.cv = root.querySelector('#ovc');
    this.cx = this.cv.getContext('2d');
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
                this.playOn(this.spare(), seg, true);
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

    // 调光（视频自带黄昏光，这里只轻叠）
    const dim = (S.dim && S.dim[this.phase]) || 0;
    if (dim > 0.005) {
      cx.fillStyle = 'rgba(8,6,4,' + dim.toFixed(3) + ')';
      cx.fillRect(0, 0, this.W, this.H);
    }

    // 叠加层其余内容（菜单/当班牌/计时……）全归场景包画——引擎不认识具体场景（9-1 归位）
    if (S.drawUI) S.drawUI(this, cx, v);

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
