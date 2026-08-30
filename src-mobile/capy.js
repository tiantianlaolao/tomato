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

  // Scene.mount 里调：建角色画布，插在 bgi 之后、bgc 之前。
  // 薄雾也画在这块画布上（角色之后、lighter 叠加）——8-30 重设计：
  // <video> 单实例硬循环被否（循环感/三炷香），换精灵图多实例。
  mountInto(root, bgi) {
    this.cv = document.createElement('canvas');
    this.cv.className = 'layer'; this.cv.id = 'cpc';
    bgi.after(this.cv);
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
    this.phase = phase;
    const seg = this.segFor(phase, view);
    this.frozen = (phase === 'paused');
    if (seg !== this.cur) { this.cur = seg; this.t = 0; if (seg) this.load(seg); }
    const mc = window.Scene && Scene.scene && Scene.scene.mist;
    if (mc && mc.sheet) this.load(mc.sheet, true);   // 薄雾常驻，不参与 2 段上限
  },

  load(seg, pinned) {
    if (this.sheets[seg]) return;
    const img = new Image();
    img.src = 'assets/capy/' + seg + '.webp';
    const rec = { img, ready:false, pinned:!!pinned };
    img.onload = () => { rec.ready = true; };
    this.sheets[seg] = rec;
    // 🔴 常驻上限＝2 段角色 + 常驻雾（pinned）：踢掉最早的非当前非常驻段
    const keys = Object.keys(this.sheets).filter(k => !this.sheets[k].pinned);
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
  },

  // 往返循环帧号（0..n-1..0 无接缝）
  ppFrame(t, m, t0) {
    const n = m.frames, cycle = Math.max(1, 2 * n - 2);
    let fi = Math.floor((t + (t0 || 0)) * m.fps) % cycle;
    return fi >= n ? cycle - fi : fi;
  },

  // 薄雾：多实例不同相位/镜像铺满整池，lighter 叠加（黑=不加光=透明）。
  // 素材是视频出的，这里只做摆位——不违「动效尽量视频出」。
  drawMist() {
    const S = window.Scene, mc = S.scene && S.scene.mist;
    if (!mc || !this.meta || !this.meta[mc.sheet]) return;
    const rec = this.sheets[mc.sheet];
    if (!rec || !rec.ready) return;
    const m = this.meta[mc.sheet];
    const alpha = (mc.alphaByPhase && mc.alphaByPhase[this.phase]) != null
      ? mc.alphaByPhase[this.phase] : 0.4;
    if (alpha <= 0.01) return;
    const cx = this.cx;
    cx.save();
    cx.globalCompositeOperation = 'lighter';
    for (const it of mc.instances || []) {
      const fi = this.ppFrame(this.t, m, it.t0);
      const sx = (fi % m.cols) * m.cellW, sy = Math.floor(fi / m.cols) * m.cellH;
      const a = S.map(it.x, it.y);
      const w = S.mapW(it.w), h = w * m.cellH / m.cellW;
      cx.globalAlpha = alpha;
      if (it.flip) {
        cx.save(); cx.translate(a[0], 0); cx.scale(-1, 1);
        cx.drawImage(rec.img, sx, sy, m.cellW, m.cellH, -w / 2, a[1] - h, w, h);
        cx.restore();
      } else {
        cx.drawImage(rec.img, sx, sy, m.cellW, m.cellH, a[0] - w / 2, a[1] - h, w, h);
      }
    }
    cx.restore();
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
    this.drawChar(c, S);
    this.drawMist();          // 雾画在角色之后＝飘在水面和身前
  },

  drawChar(c, S) {
    const seg = this.cur;   // ''/null＝这个状态画面里没有水豚（done=人去汤空）
    if (!seg || !this.meta || !this.meta[seg]) return;
    const rec = this.sheets[seg];
    if (!rec || !rec.ready) { this.load(seg); return; }
    const m = this.meta[seg];
    const fi = this.ppFrame(this.t, m, 0);         // 往返循环
    const sx = (fi % m.cols) * m.cellW, sy = Math.floor(fi / m.cols) * m.cellH;
    // 🔴 放置按**量出来的水豚 bbox**缩放，不按生成帧（8-30 用户打回：各段裁切比例
    //    不同（85%/60%），按帧宽缩放＝各场景水豚大小不一）。cell 就是管线裁出的
    //    bbox+pad：配置的 w＝"水豚在屏上多宽"，素材裁多松都不影响上屏大小。
    //    锚点＝bbox 底边中心＝脚底/水线，落点即接地点（上岸必须整只在岸上）。
    const per = (c.perSeg && c.perSeg[seg]) || {};
    const a = S.map(per.x != null ? per.x : c.x, per.y != null ? per.y : c.y);
    const cw = S.mapW(per.w != null ? per.w : c.w) * (per.k || 1);
    const k = cw / m.cellW;
    this.cx.drawImage(rec.img, sx, sy, m.cellW, m.cellH,
      a[0] - cw / 2, a[1] - m.cellH * k, cw, m.cellH * k);
    // 验收用：?boxes=1 把角色 bbox 和接地锚点画出来（脚出石台一眼就看到）
    if (window.__SHOWBOXES) {
      this.cx.strokeStyle = 'rgba(255,180,120,.9)'; this.cx.lineWidth = 2;
      this.cx.strokeRect(a[0] - cw / 2, a[1] - m.cellH * k, cw, m.cellH * k);
      this.cx.fillStyle = 'rgba(255,80,80,.9)';
      this.cx.fillRect(a[0] - 4, a[1] - 4, 8, 8);
    }
  },
};

window.Capy = Capy;
})();
