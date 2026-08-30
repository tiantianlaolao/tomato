// 水豚角色层 + 蒸汽层（8-30 首版：16 段资产账里的 6 段先上，看整体效果）
//
// 🔴 跟 scene.js 同一条纪律：只吃 view/phase，不认识 Tauri。
// 🔴 场景无关：放哪儿、哪个状态演哪段，全由场景包的 scene.capy / scene.steam
//    配置说了算（水豚是平光素材，换场景不用重出——§7.1 第 4 条）。
//    场景包没配 capy 就整层不存在。
//
// 精灵图母版（_pipeline_v2.py 产）：每段 61 帧 12fps，按 alpha bbox 裁格，
// meta 记 cellW/cellH/offX/offY/srcScale(768)。播放＝往返循环（无接缝，8-25 验证）。
// 🔴 内存纪律（§5.3）：同时最多常驻 2 段——当前段 + 预判的下一段，其余释放。
//
// 蒸汽＝黑底视频 + plus-lighter 叠加（8-30 验证）：黑=全透明不走抠图；
// 即梦的"黑底"实为炭黑纸纹+底边奶白亮带 → 强 contrast 压黑位 + 裁掉底部 7% + 椭圆 mask。
(function () {
'use strict';

const Capy = {
  cv:null, cx:null, steamBox:null, steamV:null,
  meta:null,            // capy/meta.json（全段账本）
  sheets:{},            // seg -> {img, ready}
  cur:null,             // 正在演的段名
  frozen:false,         // paused＝冻结当前帧（§设计：暂停不换段，画面停住光变暗）
  t:0,

  // Scene.mount 里调：建两层，插在 bgi 之后、bgc 之前
  mountInto(root, bgi) {
    this.cv = document.createElement('canvas');
    this.cv.className = 'layer'; this.cv.id = 'cpc';
    this.steamBox = document.createElement('div');
    this.steamBox.id = 'steamBox';
    this.steamV = document.createElement('video');
    this.steamV.muted = true; this.steamV.loop = true; this.steamV.autoplay = true;
    this.steamV.playsInline = true; this.steamV.setAttribute('playsinline', '');
    this.steamBox.appendChild(this.steamV);
    bgi.after(this.cv, this.steamBox);
    this.cx = this.cv.getContext('2d');
    fetch('assets/capy/meta.json').then(r => r.json()).then(m => { this.meta = m; });
  },

  cfg() { return window.Scene && Scene.scene && Scene.scene.capy; },

  // phase + view → 段名。break 按本段时长分池（§4：短休晒太阳 / 长休吃瓜）。
  // 🔴 '' ＝这个状态没有水豚（done＝拜访结束人去汤空；道别仪式以后做成
  //    卡片弹出前的过场，定格画面就该是空的）。
  segFor(phase, view) {
    const c = this.cfg(); if (!c) return null;
    const st = c.states;
    if (phase === 'paused') return this.cur || st.idle;   // 冻结在当前段
    if (phase === 'break') {
      const cur = view && view.stages && view.stages[view.idx];
      return (cur && cur.secs >= 600) ? st.longBreak : st.shortBreak;
    }
    return st[phase] !== undefined ? st[phase] : st.idle;
  },

  onPhase(phase, view) {
    const seg = this.segFor(phase, view);
    this.frozen = (phase === 'paused');
    if (seg !== this.cur) { this.cur = seg; this.t = 0; if (seg) this.load(seg); }
  },

  load(seg) {
    if (this.sheets[seg]) return;
    const img = new Image();
    img.src = 'assets/capy/' + seg + '.webp';
    const rec = { img, ready:false };
    img.onload = () => { rec.ready = true; };
    this.sheets[seg] = rec;
    // 🔴 常驻上限 2 段：踢掉最早的非当前段（src 置空让浏览器能回收位图）
    const keys = Object.keys(this.sheets);
    while (keys.length > 2) {
      const k = keys.find(x => x !== seg && x !== this.cur) || keys[0];
      if (k === seg) break;
      this.sheets[k].img.src = '';
      delete this.sheets[k];
      keys.splice(keys.indexOf(k), 1);
    }
  },

  onResize() {
    if (!this.cv || !window.Scene || !Scene.W) return;
    this.cv.width = Scene.W; this.cv.height = Scene.H;
    this.draw();               // resize 后立即补一帧，别等下个 tick
    // 蒸汽层定位（CSS 像素）：场景包给归一化的 {x,y,w}，y=蒸汽底边（池面）
    const sc = Scene.scene && Scene.scene.steam;
    if (!sc) { this.steamBox.style.display = 'none'; return; }
    const p = Scene.map(sc.x, sc.y);
    const w = Scene.mapW(sc.w) / Scene.DPR;
    const bx = p[0] / Scene.DPR, by = p[1] / Scene.DPR;
    Object.assign(this.steamBox.style, {
      display:'', left:(bx - w/2) + 'px', top:(by - w) + 'px',
      width:w + 'px', height:w + 'px',
    });
    if (!this.steamV.getAttribute('src')) { this.steamV.src = 'assets/fx_steam.mp4'; this.steamV.play().catch(()=>{}); }
  },

  // Scene.frame 每帧调（已限 12fps）。往返循环：0..n-1..0，无接缝
  // 🔴 冻结只停"时间推进"，draw 照跑——第一版 frozen 直接 return，
  //    demo=paused 直接进入时精灵图还没加载完，唯一的 draw 调用被拦，水豚永远不出现
  tick(dt) {
    if (!this.frozen) this.t += dt;   // 暂停＝停格（状态光在 fx 层继续变暗）
    this.draw();
  },

  draw() {
    const c = this.cfg(), S = window.Scene;
    if (!this.cx || !c || !S || !S.map) return;
    this.cx.clearRect(0, 0, this.cv.width, this.cv.height);
    const seg = this.cur;   // ''/null＝这个状态画面里没有水豚，清掉即止
    if (!seg || !this.meta || !this.meta[seg]) return;
    const rec = this.sheets[seg];
    if (!rec || !rec.ready) { this.load(seg); return; }
    const m = this.meta[seg];
    const n = m.frames;
    const cycle = Math.max(1, 2 * n - 2);
    let fi = Math.floor(this.t * m.fps) % cycle;
    if (fi >= n) fi = cycle - fi;                  // 往返
    const sx = (fi % m.cols) * m.cellW, sy = Math.floor(fi / m.cols) * m.cellH;
    // 放置：把整个 768 源帧的底边中心锚到 anchor，等比缩放到 frameW；
    // 单元格按 offX/offY 摆回原位，跨段大小关系与生成时一致。
    const per = (c.perSeg && c.perSeg[seg]) || {};
    const a = S.map(per.x != null ? per.x : c.x, per.y != null ? per.y : c.y);
    const frameW = S.mapW(per.w != null ? per.w : c.w) * (per.k || 1);
    const k = frameW / m.srcScale;
    const ox = a[0] - frameW / 2, oy = a[1] - m.srcScale * k;
    this.cx.drawImage(rec.img, sx, sy, m.cellW, m.cellH,
      ox + m.offX * k, oy + m.offY * k, m.cellW * k, m.cellH * k);
  },
};

window.Capy = Capy;
})();
