// capyroom 移动端渲染层（骨架版，全部占位色块，不含任何美术资产）
//
// 🔴 这一层**只吃 view 对象，不认识 Tauri**。桥在 index.html 里接。
//    这么切有两个好处：①能在浏览器里用假 view 直接驱动、playwright 截图验收，
//    迭代成本几乎为零 ②不会再造出一对"同语义双胞胎"（项目里已有
//    bridge.js↔core.rs、pet.html↔companion.js 两对，两对都咬过人）。
//
// 分层严格按《场景与美术方案说明书》§8.3：
//   bgc  静态层：天空/林子/岸台/池盆/灯笼身/木牌 —— **只在尺寸或状态光变化时重画**
//   fxc  动态层：落日/灯笼光晕/水面反光/橘子/木牌数字 —— 每帧，且限帧
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

// ── 状态光表（§7.4）。状态之间只改"光"，不改底色 ──────────────
// 🔴 硬纪律：相邻状态过渡 ≥1.5 秒。余光里任何突变都会被读成"有事发生"，
//    抬头一看没事 —— 这是最伤人的干扰。
const LIGHT = {
  idle:     { sky:RGB('#e8956b'), lamp:RGB('#ff9f3c'), lampI:0.00, bright:0.85 },
  work:     { sky:RGB('#c9744e'), lamp:RGB('#ff9f3c'), lampI:0.50, bright:0.75 },
  break:    { sky:RGB('#ffb45c'), lamp:RGB('#ffd25e'), lampI:1.00, bright:1.00 },
  paused:   { sky:RGB('#8a8175'), lamp:RGB('#8a8175'), lampI:0.35, bright:0.60 },
  awaiting: { sky:RGB('#d98a5c'), lamp:RGB('#ffb45c'), lampI:0.70, bright:0.88 },
  done:     { sky:RGB('#2a2740'), lamp:RGB('#ffd25e'), lampI:1.10, bright:1.05 },
};
const FADE_MS = 1600;          // ≥1.5s
const PRE_ALERT_SEC = 30;      // 段末预告：最后 30 秒极缓地亮一点点，绝不闪

// ── 底色（§7.3，打样页跑过两轮 25 分钟的那组，手机上耐看）────────
const C = {
  skyTop:RGB('#191411'), skyLow:RGB('#241b13'),
  forest:RGB('#15110e'),
  bank:RGB('#2c2016'), bankHi:RGB('#3b2c1d'),
  water:RGB('#3a2f22'),
  stone:RGB('#4b4640'), lampStone:RGB('#5a544c'),
  board:RGB('#8a6b45'), boardEdge:RGB('#5a4530'),
  sun:RGB('#b93b22'), lampCore:RGB('#ffdca0'), orange:RGB('#e8801c'),
};

const Scene = {
  root:null, bgc:null, fxc:null, bx:null, fx:null,
  W:0, H:0, DPR:1, U:1,
  view:null,
  light:Object.assign({}, LIGHT.idle), lightFrom:null, lightTo:null, fadeT:1,
  status:'idle',   // 内核原状态
  phase:'idle',    // 表演相（LIGHT 的键）
  oranges:[],            // 已完成的工作段 → 漂在水面的橘子
  lastDoneWork:0,
  t:0, lastTs:0, raf:0, running:false, lastFps:0,
  drift:{x:0, y:0, t:0},  // 烧屏平移
  bgDirty:true,
  fps:12,                 // 🔴 限帧：打样实测动画只要 12fps 而页面在按 55fps 画，
  frameGap:1000/12 - 8,   //    五帧里四帧是白画的。这是最大的省电旋钮。
                          //    减 8ms 是为了对齐 rAF 的 60Hz 量化：不减的话
                          //    83.3ms 会被凑到 100ms，实测只有 10.7fps。
  nextFrameAt:0,

  mount(root) {
    this.root = root;
    root.innerHTML =
      '<canvas class="layer" id="bgc"></canvas>' +
      '<canvas class="layer" id="fxc"></canvas>' +
      '<div id="rulebar">长按取消 · 开始 30 秒内取消无损</div>';
    this.bgc = root.querySelector('#bgc');
    this.fxc = root.querySelector('#fxc');
    this.bx = this.bgc.getContext('2d');
    this.fx = this.fxc.getContext('2d');
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
    this.bgDirty = true;
    this.drawOnce();
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
    if (!view) return;
    const ph = this.phaseOf(view);
    if (ph !== this.phase) {
      this.lightFrom = Object.assign({}, this.light);
      this.lightTo = LIGHT[ph] || LIGHT.idle;
      this.fadeT = 0;
      this.phase = ph;
      this.bgDirty = true;
    }
    this.status = view.status;
    // 完成一个工作段 → 漂来一个橘子（§3：慢，不弹跳，2~3 秒滑到位）
    const doneWork = this.countDoneWork(view);
    if (doneWork > this.lastDoneWork) {
      for (let i = this.lastDoneWork; i < doneWork; i++) this.addOrange();
    } else if (doneWork < this.lastDoneWork) {
      this.oranges.length = 0;          // 新会话，清空
    }
    this.lastDoneWork = doneWork;
    this.view = view;
  },

  countDoneWork(v) {
    if (!v.stages || v.status === 'idle') return 0;
    let n = 0;
    for (let i = 0; i < v.idx && i < v.stages.length; i++) {
      if (v.stages[i].kind === 'work') n++;
    }
    return n;
  },

  addOrange() {
    // 从池子左缘慢慢漂到目标位；目标位错开排布，别叠在一起
    const k = this.oranges.length;
    this.oranges.push({
      tx: 0.24 + (k % 4) * 0.17 + (k >= 4 ? 0.06 : 0),
      ty: 0.80 + Math.floor(k / 4) * 0.045,
      x: 0.06, y: 0.84, born: this.t
    });
  },

  // ── 整场进度 → 天色（§4：水豚是晨昏动物，光就是它的生物钟）──
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

  // ── 静态层：只在尺寸变化或状态光变化时重画 ──────────────
  drawBg() {
    this.bgDirty = false;   // 先落旗：万一下面抛异常，也不会每帧重抛把循环卡死
    const { bx, W, H, U } = this;
    const L = this.light;
    const SKY = Math.round(H * 0.30), MID = Math.round(H * 0.60), POOL = Math.round(H * 0.95);

    bx.clearRect(0, 0, W, H);
    // 天空：底色 + 状态天光（只改光不改底色 §7.2）
    const g = bx.createLinearGradient(0, 0, 0, MID);
    g.addColorStop(0, css(mix(C.skyTop, L.sky, 0.10 * L.bright)));
    g.addColorStop(1, css(mix(C.skyLow, L.sky, 0.26 * L.bright)));
    bx.fillStyle = g; bx.fillRect(0, 0, W, MID);

    // 林子剪影（占位：一排三角）
    bx.fillStyle = css(C.forest);
    bx.beginPath();
    bx.moveTo(0, SKY + 40*U);
    for (let x = 0, i = 0; x < W + 60*U; x += 46*U, i++) {
      const h = (48 + ((i * 37) % 40)) * U;
      bx.lineTo(x, SKY + 40*U - h); bx.lineTo(x + 23*U, SKY + 40*U);
    }
    bx.lineTo(W, MID); bx.lineTo(0, MID); bx.closePath(); bx.fill();

    // 岸台
    bx.fillStyle = css(mix(C.bank, L.sky, 0.08 * L.bright));
    bx.fillRect(0, MID, W, POOL - MID);
    bx.fillStyle = css(mix(C.bankHi, L.sky, 0.10 * L.bright));
    bx.fillRect(0, MID, W, 10 * U);

    // 汤池（占位椭圆盆）§7.4：水是深色的，明度接近周围石头
    const cx = W * 0.5, cy = H * 0.815, rx = W * 0.42, ry = H * 0.115;
    bx.fillStyle = css(C.stone);
    bx.beginPath(); bx.ellipse(cx, cy, rx + 16*U, ry + 12*U, 0, 0, Math.PI*2); bx.fill();
    bx.fillStyle = css(mix(C.water, L.sky, 0.06 * L.bright));
    bx.beginPath(); bx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI*2); bx.fill();

    // 石灯笼（占位：柱 + 灯室），只画身体，光晕在动态层
    const lx = W * 0.80, ly = MID - 4*U;
    bx.fillStyle = css(C.lampStone);
    bx.fillRect(lx - 13*U, ly - 90*U, 26*U, 90*U);
    bx.fillRect(lx - 30*U, ly - 148*U, 60*U, 58*U);
    bx.fillRect(lx - 40*U, ly - 162*U, 80*U, 16*U);

    // 木牌（占位：牌面 + 两腿），数字在动态层
    const bw = W * 0.46, bh = bw * 0.44, bxx = W * 0.10, byy = MID - bh - 26*U;
    bx.fillStyle = css(C.boardEdge);
    bx.fillRect(bxx + bw*0.18, byy + bh, 9*U, 30*U);
    bx.fillRect(bxx + bw*0.72, byy + bh, 9*U, 30*U);
    bx.fillStyle = css(mix(C.board, L.sky, 0.12 * L.bright));
    bx.fillRect(bxx, byy, bw, bh);
    bx.fillStyle = css(C.boardEdge);
    bx.fillRect(bxx, byy, bw, 5*U);
    this.board = { x:bxx, y:byy, w:bw, h:bh };
    this.lamp = { x:lx, y:ly - 119*U };
    this.pool = { cx, cy, rx, ry };
  },

  // ── 动态层：每帧，但限到 12fps ──────────────────────
  drawFx(dt) {
    const { fx, W, H, U } = this;
    const L = this.light, v = this.view;
    fx.clearRect(0, 0, W, H);
    fx.save();
    fx.translate(this.drift.x, this.drift.y);   // 烧屏平移（§8.4）

    // 落日：整场剩余 ∝ 太阳高度
    const p = this.sessionProgress(v);
    const sunX = W * (0.22 + p * 0.10);
    const sunY = H * (0.06 + p * 0.26);
    const sunR = 34 * U;
    if (this.phase !== 'done') {
      const sg = fx.createRadialGradient(sunX, sunY, sunR*0.2, sunX, sunY, sunR*3.2);
      sg.addColorStop(0, 'rgba(200,70,40,' + (0.45*L.bright) + ')');
      sg.addColorStop(1, 'rgba(200,70,40,0)');
      fx.fillStyle = sg;
      fx.beginPath(); fx.arc(sunX, sunY, sunR*3.2, 0, Math.PI*2); fx.fill();
      fx.fillStyle = css(mix(C.sun, L.sky, 0.35));
      fx.beginPath(); fx.arc(sunX, sunY, sunR, 0, Math.PI*2); fx.fill();
    } else {
      // 完成＝天黑星星出来
      for (let i = 0; i < 40; i++) {
        const sx = ((i*137) % 100) / 100 * W, sy = ((i*61) % 55) / 100 * H * 0.5;
        const tw = 0.35 + 0.35 * Math.sin(this.t*1.6 + i);
        fx.fillStyle = 'rgba(255,240,210,' + tw.toFixed(2) + ')';
        fx.fillRect(sx, sy, 2.2*U, 2.2*U);
      }
    }

    // 灯笼光晕 + 落地暖光
    if (this.lamp && L.lampI > 0.01) {
      const flick = 1 + Math.sin(this.t * 3.1) * 0.05;
      const R = 200 * U * L.lampI * flick;
      const gg = fx.createRadialGradient(this.lamp.x, this.lamp.y, 6*U, this.lamp.x, this.lamp.y, R);
      gg.addColorStop(0, 'rgba(255,170,70,' + (0.42*L.lampI) + ')');
      gg.addColorStop(1, 'rgba(255,150,50,0)');
      fx.fillStyle = gg;
      fx.beginPath(); fx.arc(this.lamp.x, this.lamp.y, R, 0, Math.PI*2); fx.fill();
      fx.fillStyle = css(mix(C.lampCore, L.lamp, 0.4));
      fx.fillRect(this.lamp.x - 9*U, this.lamp.y - 12*U, 18*U, 24*U);
    }

    // 水面：只有靠灯笼那一侧有一小片暖橙反光（§7.4 的绝对参照）
    if (this.pool && L.lampI > 0.01) {
      const P = this.pool;
      fx.save();
      fx.beginPath(); fx.ellipse(P.cx, P.cy, P.rx, P.ry, 0, 0, Math.PI*2); fx.clip();
      const rg = fx.createLinearGradient(P.cx + P.rx*0.15, 0, P.cx + P.rx, 0);
      rg.addColorStop(0, 'rgba(255,150,60,0)');
      rg.addColorStop(0.55, 'rgba(255,150,60,' + (0.22*L.lampI) + ')');
      rg.addColorStop(1, 'rgba(255,150,60,0)');
      fx.fillStyle = rg;
      const wob = Math.sin(this.t*1.3) * 3 * U;
      fx.fillRect(P.cx, P.cy - P.ry + wob, P.rx, P.ry*2);
      fx.restore();
    }

    // 橘子＝进度条＝货币（§3）。程序画的静态小图，漂在水面这个固定平面上，
    // 不用追踪头顶锚点 → 零动画成本。
    if (this.pool) {
      for (const o of this.oranges) {
        const age = this.t - o.born;
        const k = Math.min(1, age / 2.6);            // 2.6 秒慢慢滑到位，不弹跳
        const e = 1 - Math.pow(1 - k, 3);
        const ox = lerp(o.x, o.tx, e) * W;
        const oy = lerp(o.y, o.ty, e) * H + Math.sin(this.t*0.9 + o.tx*9) * 2 * U;
        const r = 15 * U;
        fx.fillStyle = 'rgba(0,0,0,.22)';
        fx.beginPath(); fx.ellipse(ox, oy + r*0.5, r*1.05, r*0.42, 0, 0, Math.PI*2); fx.fill();
        fx.fillStyle = css(mix(C.orange, L.lamp, 0.25 * L.lampI));
        fx.beginPath(); fx.arc(ox, oy, r, 0, Math.PI*2); fx.fill();
        fx.fillStyle = 'rgba(255,214,150,.5)';
        fx.beginPath(); fx.arc(ox - r*0.28, oy - r*0.3, r*0.3, 0, Math.PI*2); fx.fill();
      }
    }

    // 木牌数字（本段剩余 MM:SS）。§4：一米外可读，占屏宽 ≥40%；
    // 余光态要弱、一瞥态要亮 —— 这里先做"弱"，抬手提亮等做交互时再接。
    if (this.board && v) {
      const B = this.board;
      const secs = Math.max(0, Math.round((v.remaining_ms || 0) / 1000));
      // 🔴 木牌表的是"本段剩余"，只有 running/paused 才有这个东西。
      //    idle / awaiting / done 显示 00:00 都是在说假话 —— 第一版只修了 idle，
      //    awaiting 和 done 照样在撒谎，是截图逐格看才发现的。
      const hasTime = (this.phase === 'work' || this.phase === 'break' || this.phase === 'paused');
      const txt = hasTime
        ? String(Math.floor(secs/60)).padStart(2,'0') + ':' + String(secs%60).padStart(2,'0')
        : '· ·';
      // 段末预告：最后 30 秒极缓地亮一点点，绝不闪
      const pre = (this.phase === 'work' || this.phase === 'break') && secs <= PRE_ALERT_SEC
        ? (1 - secs / PRE_ALERT_SEC) * 0.35 : 0;
      const alpha = (hasTime ? 0.55 + pre : 0.30);
      fx.font = '600 ' + Math.round(B.h * 0.52) + 'px ui-monospace,Menlo,monospace';
      fx.textAlign = 'center'; fx.textBaseline = 'middle';
      fx.fillStyle = 'rgba(58,42,26,' + Math.min(1, alpha + 0.18).toFixed(2) + ')';
      fx.fillText(txt, B.x + B.w/2 + 1.5*U, B.y + B.h/2 + 1.5*U);
      fx.fillStyle = 'rgba(250,228,190,' + Math.min(1, alpha).toFixed(2) + ')';
      fx.fillText(txt, B.x + B.w/2, B.y + B.h/2);
    }
    fx.restore();

    // 🔴 整体亮度（§7.4 的 bright）必须是**全局明度乘子**，不能只当混色比例——
    //    只混色的话工作态反而比空闲态亮，直接违反"工作段是全片最暗最静一档"
    //    的第一原理（0.75 vs 0.85）。fx 层盖在 bg 之上，所以在这里整屏叠一次
    //    就能压住全部内容（天空、灯光、橘子一起压）。一个 fillRect，很便宜。
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
  },

  start() { if (this.running) return; this.running = true; this.lastTs = 0; this.nextFrameAt = 0; this.raf = requestAnimationFrame((t) => this.frame(t)); },
  stop()  { this.running = false; cancelAnimationFrame(this.raf); },
};

window.Scene = Scene;
})();
