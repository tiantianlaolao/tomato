// capyroom 移动端渲染引擎（骨架版，全部占位色块，不含任何美术资产）
//
// 🔴 这一层**只吃 view 对象，不认识 Tauri**。桥在 index.html 里接。
//    这么切有两个好处：①能在浏览器里用假 view 直接驱动、playwright 截图验收，
//    迭代成本几乎为零 ②不会再造出一对"同语义双胞胎"（项目里已有
//    bridge.js↔core.rs、pet.html↔companion.js 两对，两对都咬过人）。
//
// 🔴🔴 引擎不认识任何一个具体场景（2026-08-29 用户定：温泉只是**初始场景之一**，
//    以后一定会有别的场景）。场景相关的东西全在场景包里（scene_onsen.js）：
//    状态光表、底色、怎么画、时间显示挂在哪个物件上、五个入口分别是哪件东西。
//    引擎只管这些**跟场景无关**的事：
//      分层与脏标记 · 限帧 · 状态光渐变 · 烧屏平移 · 全局明度 · 把 MM:SS 写进
//      场景给的那个框 · 内核状态→表演相的映射
//    加第二个场景 = 再写一份场景包 + Scene.use('xxx')，引擎一行不动。
//
// 分层严格按《场景与美术方案说明书》§8.3：
//   bgc  静态层：**只在尺寸或状态光变化时重画**
//   fxc  动态层：每帧，且限帧
// 8-28 打样实测：整屏每帧重铺（A 模式）比背景不重绘（B 模式）慢一倍，所以静态的
// 东西一帧都不该重画。
(function () {
'use strict';

// ── 颜色一律用 [r,g,b] 数组在内部流转，只在真正要画的时候才拼成字符串 ──
// 🔴 这条不是洁癖：第一版 LIGHT 表存 '#RRGGBB'、mix() 却返回 'rgb(...)'，
//    过渡一次之后 light.sky 就变了格式，下一帧再当 hex 解析直接出 NaN。
//    而 addColorStop 遇到非法颜色**会抛异常** —— 异常抛在 bgDirty=false 之前，
//    于是 bgDirty 永远为真、drawFx 一帧都没跑到，实测帧率 0.0。
//    一个类型不一致就能让整个渲染层静默死掉，所以类型必须是一种。
function RGB(h) {
  return [parseInt(h.slice(1,3),16), parseInt(h.slice(3,5),16), parseInt(h.slice(5,7),16)];
}
function mix(a, b, t) { return [0,1,2].map(i => Math.round(a[i] + (b[i]-a[i])*t)); }
function css(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }
function rgba(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
function lerp(a, b, t) { return a + (b-a)*t; }
// 场景包要用同一套工具，别各写一份
window.SceneUtil = { RGB, mix, css, rgba, lerp };

const FADE_MS = 1600;          // ≥1.5s：余光里任何突变都会被读成"有事发生"
const PRE_ALERT_SEC = 30;      // 段末预告：最后 30 秒极缓地亮一点点，绝不闪

const Scene = {
  root:null, bgc:null, fxc:null, bx:null, fx:null,
  W:0, H:0, DPR:1, U:1,
  view:null,
  scene:null,                          // 当前场景包
  slots:{ time:null, entries:null },   // 场景回填：时间显示的框、入口命中区
  light:null, lightFrom:null, lightTo:null, fadeT:1,
  map:null, mapW:null,                 // 底图 cover 变换（remap 里算）
  status:'idle',   // 内核原状态
  phase:'idle',    // 表演相（场景光表的键）
  t:0, lastTs:0, raf:0, running:false, lastFps:0,
  drift:{x:0, y:0, t:0},  // 烧屏平移
  bgDirty:true,
  fps:12,                 // 🔴 限帧：打样实测动画只要 12fps 而页面在按 55fps 画，
  frameGap:1000/12 - 8,   //    五帧里四帧是白画的。这是最大的省电旋钮。
                          //    减 8ms 是为了对齐 rAF 的 60Hz 量化：不减的话
                          //    83.3ms 会被凑到 100ms，实测只有 10.7fps。
  nextFrameAt:0,

  // 换场景：以后加了第二个场景，这里就是唯一的开关
  use(id) {
    const s = (window.SCENES || {})[id];
    if (!s) { console.error('没有这个场景：' + id); return; }
    this.scene = s;
    if (this.bgi) {
      this.bgi.style.display = s.bgImage ? '' : 'none';
      if (s.bgImage && this.bgi.getAttribute('src') !== s.bgImage) this.bgi.src = s.bgImage;
    }
    this.light = Object.assign({}, s.light[this.phase] || s.light.idle);
    this.lightFrom = this.lightTo = null; this.fadeT = 1;
    this.bgDirty = true;
    // 🔴 mount 里 use() 跑在 resize() 之前，那时候 W/H 还是 0、变换还没算出来。
    //    第一版直接 drawOnce，场景包拿到的 map 是 undefined → 每帧抛异常 →
    //    实测帧率 0.0（跟 8-28 那次 addColorStop 抛异常一模一样的死法）。
    if (this.root && this.W) { this.remap(); this.drawOnce(); }
  },

  mount(root, sceneId) {
    this.root = root;
    // 🔴 第 0 层是 <img> 不是 canvas：8-28 打样实测整屏位图每帧重铺比背景不重绘
    //    慢一倍（§8.3）。底图交给浏览器合成器，我们一帧都不用画它。
    root.innerHTML =
      '<img class="layer" id="bgi" alt="">' +
      '<canvas class="layer" id="bgc"></canvas>' +
      '<canvas class="layer" id="fxc"></canvas>';
    this.bgi = root.querySelector('#bgi');
    this.bgc = root.querySelector('#bgc');
    this.fxc = root.querySelector('#fxc');
    this.bx = this.bgc.getContext('2d');
    this.fx = this.fxc.getContext('2d');
    // 角色层+蒸汽层（capy.js）：插在 bgi 之后、bgc 之前。
    // 层序 bgi→水豚→蒸汽→bgc→fxc —— fxc 的全局明度乘子要压住下面所有层
    if (window.Capy) window.Capy.mountInto(root, this.bgi);
    this.use(sceneId || 'onsen');
    // 🔴 只听 window.resize 不够：同页面内的布局变化不发这个事件
    //    （8-26 桌面端"序列开合把水豚拉伸"就是这个坑）。
    new ResizeObserver(() => this.resize()).observe(root);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  },

  resize() {
    const r = this.root.getBoundingClientRect();
    this.DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    const w = Math.round(r.width * this.DPR), h = Math.round(r.height * this.DPR);
    if (w === this.W && h === this.H) return;
    this.W = w; this.H = h; this.U = h / 1000;
    for (const c of [this.bgc, this.fxc]) { c.width = w; c.height = h; }
    this.remap();
    this.bgDirty = true;
    this.drawOnce();
    if (window.Capy) window.Capy.onResize();
  },

  // 底图按 cover 铺满（CSS 那边 object-fit:cover），这里算出**同一套**变换，
  // 好让场景包用归一化坐标标出来的槽位/命中区跟画面严丝合缝。
  // 🔴 手机比图更窄更长，cover 会裁掉两侧 —— 不算这个变换，木牌和入口就会漂。
  remap() {
    const sz = (this.scene && this.scene.imageSize) || [this.W, this.H];
    const iw = sz[0], ih = sz[1];
    const s = Math.max(this.W / iw, this.H / ih);
    const dw = iw * s, dh = ih * s;
    const ox = (this.W - dw) / 2, oy = (this.H - dh) / 2;
    this.map  = (nx, ny) => [ox + nx * dw, oy + ny * dh];
    this.mapW = (n) => n * dw;
  },

  // 🔴 内核的 status 只有 idle/running/paused/awaiting/done 五个，**没有 work/break**
  //    ——是工作段还是休息段，要看 stages[idx].kind。
  //    状态光是**表演层**概念，内核状态是**数据层**概念，中间必须有这个显式映射。
  //    （第一版我按 work/break 建表、夹具也自己编成 status:'work'，本地六态全绿，
  //      一接真内核会全部落到 idle 那一档 —— 自己编的夹具跟内核真相不一致，
  //      测试就成了自说自话。）
  phaseOf(v) {
    if (!v || v.status === 'idle') return 'idle';
    if (v.status === 'done') return 'done';
    if (v.status === 'awaiting') return 'awaiting';
    if (v.status === 'paused') return 'paused';
    const cur = v.stages && v.stages[v.idx];
    return (cur && cur.kind === 'break') ? 'break' : 'work';
  },

  // ── 喂数据。渲染层不区分数据是来自 Tauri 事件还是测试夹具 ──
  update(view) {
    if (!view || !this.scene) return;
    const ph = this.phaseOf(view);
    if (ph !== this.phase) {
      this.lightFrom = Object.assign({}, this.light);
      this.lightTo = this.scene.light[ph] || this.scene.light.idle;
      this.fadeT = 0;
      this.phase = ph;
      this.bgDirty = true;
    }
    this.status = view.status;
    this.view = view;
    if (window.Capy) window.Capy.onPhase(ph, view);
  },

  // 整场跑了多少（0~1）。给场景当气氛用（比如天色）——
  // ⚠️ 这**不是进度条**：8-29 用户否掉了"橘子＝进度"那个设计，
  //    "还剩多久"由木牌上的本段倒计时负责，不另外做进度显示。
  sessionProgress(v) {
    if (!v || !v.stages || !v.stages.length || v.status === 'idle') return 0;
    let total = 0, left = 0;
    for (let i = 0; i < v.stages.length; i++) {
      total += v.stages[i].secs * 1000;
      if (i > v.idx) left += v.stages[i].secs * 1000;
    }
    left += v.remaining_ms || 0;
    if (v.status === 'done') return 1;
    return total ? Math.min(1, Math.max(0, 1 - left / total)) : 0;
  },

  drawBg() {
    this.bgDirty = false;   // 先落旗：万一下面抛异常，也不会每帧重抛把循环卡死
    if (!this.scene || !this.map) return;
    this.slots = { time:null, entries:null };
    this.scene.drawBg({
      bx:this.bx, W:this.W, H:this.H, U:this.U, light:this.light, slots:this.slots,
      map:this.map, mapW:this.mapW,
    });
  },

  drawFx(dt) {
    const { fx, W, H, U } = this;
    const L = this.light, v = this.view;
    if (!this.scene || !L || !this.map) return;
    fx.clearRect(0, 0, W, H);
    fx.save();
    fx.translate(this.drift.x, this.drift.y);   // 烧屏平移（§8.4）

    this.scene.drawFx({
      fx, W, H, U, light:L, t:this.t, dt:dt || 0,
      phase:this.phase, view:v, progress:this.sessionProgress(v),
      map:this.map, mapW:this.mapW,
    });

    this.drawTime();
    // 验收用：?boxes=1 把入口命中区画出来。入口挂在画上的东西上，
    // 光看截图分不清"点不到"是位置错了还是命中区错了 —— 画出来一眼就知道。
    if (window.__SHOWBOXES && this.slots.entries) {
      fx.lineWidth = 2 * this.DPR; fx.strokeStyle = 'rgba(120,255,180,.85)';
      fx.font = (14 * this.DPR) + 'px sans-serif'; fx.fillStyle = 'rgba(120,255,180,.95)';
      fx.textAlign = 'left'; fx.textBaseline = 'top';
      for (const k in this.slots.entries) {
        const r = this.slots.entries[k];
        fx.strokeRect(r.x, r.y, r.w, r.h);
        fx.fillText(k, r.x + 4 * this.DPR, r.y + 4 * this.DPR);
      }
    }
    fx.restore();

    // 🔴 整体亮度（§7.4 的 bright）必须是**全局明度乘子**，不能只当混色比例——
    //    只混色的话工作态反而比空闲态亮，直接违反"工作段是全片最暗最静一档"
    //    的第一原理（0.75 vs 0.85）。fx 层盖在 bg 之上，所以在这里整屏叠一次
    //    就能压住全部内容。一个 fillRect，很便宜。
    if (L.bright < 1) {
      fx.fillStyle = 'rgba(8,6,4,' + (1 - L.bright).toFixed(3) + ')';
      fx.fillRect(0, 0, W, H);
    } else if (L.bright > 1) {
      fx.globalCompositeOperation = 'lighter';
      fx.fillStyle = 'rgba(255,232,190,' + ((L.bright - 1) * 0.5).toFixed(3) + ')';
      fx.fillRect(0, 0, W, H);
      fx.globalCompositeOperation = 'source-over';
    }
  },

  // ── 时间显示：本段剩余 MM:SS，画进场景指定的那个框 ──────────
  // 🔴 位置由场景说了算（这一版是岸边木牌，换个场景可能是台历、收银屏、墙上的钟）。
  // 🔴 木牌表的是"本段剩余"，只有 running/paused 才有这个东西。
  //    idle / awaiting / done 显示 00:00 都是在说假话 —— 第一版只修了 idle，
  //    awaiting 和 done 照样在撒谎，是截图逐格看才发现的。
  drawTime() {
    const B = this.slots.time, v = this.view, fx = this.fx, U = this.U;
    if (!B || !v) return;
    const secs = Math.max(0, Math.round((v.remaining_ms || 0) / 1000));
    const hasTime = (this.phase === 'work' || this.phase === 'break' || this.phase === 'paused');
    const txt = hasTime
      ? String(Math.floor(secs/60)).padStart(2,'0') + ':' + String(secs%60).padStart(2,'0')
      : '· ·';
    // 段末预告：最后 30 秒极缓地亮一点点，绝不闪
    const pre = (this.phase === 'work' || this.phase === 'break') && secs <= PRE_ALERT_SEC
      ? (1 - secs / PRE_ALERT_SEC) * 0.35 : 0;
    // 🔴 8-29 用户："倒计时太小了……一眼能瞄见"。原来 0.55 的半透明是"余光态要弱"
    //    那条纪律用力过猛：弱到瞄不见就不成立了。改成 0.88，靠**尺寸和对比**读，
    //    靠整体明度乘子压住存在感（工作段整屏本来就最暗）。
    const alpha = (hasTime ? 0.88 + pre * 0.3 : 0.34);
    const ink = B.ink || '#3a2a1a', paper = B.paper || '#fae4be';
    // 🔴 字号受槽位**宽高双约束**：只按高算，"03:01" 五个字符会横向撑出牌面
    //    （8-30 画进背景的木牌比程序牌窄，第一版数字直接溢出到画外）
    fx.font = '700 ' + Math.round(Math.min(B.h * 0.56, B.w * 0.30)) + 'px ui-monospace,Menlo,monospace';
    fx.textAlign = 'center'; fx.textBaseline = 'middle';
    fx.fillStyle = rgba(RGB(ink), Math.min(1, alpha + 0.18).toFixed(2));
    fx.fillText(txt, B.x + B.w/2 + 1.5*U, B.y + B.h/2 + 1.5*U);
    fx.fillStyle = rgba(RGB(paper), Math.min(1, alpha).toFixed(2));
    fx.fillText(txt, B.x + B.w/2, B.y + B.h/2);
  },

  // 点到场景里的哪个入口物件了（'start'/'settings'/…；没点到返回 null）。
  // 坐标是 CSS 像素，内部按 DPR 换算。
  hitEntry(cssX, cssY) {
    const E = this.slots.entries;
    if (!E) return null;
    const x = cssX * this.DPR, y = cssY * this.DPR;
    for (const k in E) {
      const r = E[k];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return k;
    }
    return null;
  },

  drawOnce() {
    if (this.bgDirty) this.drawBg();
    this.drawFx(0);
  },

  frame(ts) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // 🔴 限帧：动画只要 12fps，别让 rAF 的 60/120Hz 白画帧
    if (ts < this.nextFrameAt) return;
    this.nextFrameAt = ts + this.frameGap;

    const dt = Math.min(0.25, (ts - this.lastTs) / 1000 || 1/this.fps);
    this.lastTs = ts; this.t += dt;

    // 实测帧率（诊断条用）：滑动平均，不是"某一刻的值"——
    // 8-28 那次"帧率 0.0"就是靠这个数看出来的，留着
    this.lastFps = this.lastFps ? this.lastFps * 0.8 + (1/dt) * 0.2 : 1/dt;

    // 状态光过渡（≥1.5 秒，绝不突变）
    if (this.fadeT < 1 && this.lightTo) {
      this.fadeT = Math.min(1, this.fadeT + dt * 1000 / FADE_MS);
      const a = this.lightFrom, b = this.lightTo, k = this.fadeT;
      this.light = {
        sky: mix(a.sky, b.sky, k),
        lamp: mix(a.lamp, b.lamp, k),
        lampI: lerp(a.lampI, b.lampI, k),
        bright: lerp(a.bright, b.bright, k),
        tint: lerp(a.tint || 0, b.tint || 0, k),
      };
      this.bgDirty = true;
    }

    // 烧屏平移（§8.4）：每 4 分钟 ±3px，缓动 2 秒，察觉不到
    this.drift.t += dt;
    if (this.drift.t > 240) {
      this.drift.t = 0;
      this.drift.x = (Math.random()*2 - 1) * 3 * this.DPR;
      this.drift.y = (Math.random()*2 - 1) * 3 * this.DPR;
    }

    if (this.bgDirty) this.drawBg();
    this.drawFx(dt);
    if (window.Capy) window.Capy.tick(dt);   // 角色层随引擎限帧走，不另起循环
  },

  start() { if (this.running) return; this.running = true; this.lastTs = 0; this.nextFrameAt = 0; this.raf = requestAnimationFrame((t) => this.frame(t)); },
  stop()  { this.running = false; cancelAnimationFrame(this.raf); },
};

window.Scene = Scene;
})();
