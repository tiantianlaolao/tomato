// 场景包 · 山中野天风吕（第一个场景，不是唯一一个）
//
// 🔴 用户 2026-08-29 定的：温泉只是**初始场景之一**，以后一定会有别的场景。
//    所以场景相关的一切都收在这一份文件里，引擎（scene.js）不认识任何一个具体场景。
//    加第二个场景 = 照着这份再写一份 + 换一行 Scene.use('xxx')，不用动引擎。
//
// 8-29 起底图换成**风格锚点图 v4 真图**（用户："先不着急重新出图，就用现有资源"）。
// 🔴 底图走 <img> 图层，不进 canvas：8-28 打样实测整屏位图每帧重铺比背景不重绘慢一倍
//    （《场景与美术方案说明书》§8.3 第 0 层）。canvas 上只画图里没有的东西 + 光。
//
// 🔴 所有坐标都写成**底图归一化坐标**（0~1，相对 1152×2048 那张图），
//    由引擎按 cover 变换换算到屏幕。手机比图更窄更长，两侧会被裁掉一点 ——
//    写归一化坐标，槽位和命中区才不会跟着裁切漂走。
(function () {
'use strict';
const { RGB, mix, css } = window.SceneUtil;

// ── 状态光表（§7.4）：状态之间只改"光"，不改底色 ──────────────
// 🔴 硬纪律：相邻状态过渡 ≥1.5 秒（引擎负责渐变）。余光里任何突变都会被读成
//    "有事发生"，抬头一看没事 —— 这是最伤人的干扰。
// 🔴 bright 是**全局明度乘子**：工作段是全片最暗最静一档，这是第一原理。
// ⚠️ 底图现在是真图了，天色不能再整片换色 —— 改成"很淡地染一层 + 压/提亮度"，
//    宁可克制。tint 就是染那一层的浓度。
const LIGHT = {
  idle:     { sky:RGB('#e8956b'), lamp:RGB('#ff9f3c'), lampI:0.35, bright:0.92, tint:0.05 },
  work:     { sky:RGB('#4a5a86'), lamp:RGB('#ff9f3c'), lampI:0.55, bright:0.74, tint:0.14 },
  break:    { sky:RGB('#ffb45c'), lamp:RGB('#ffd25e'), lampI:1.00, bright:1.04, tint:0.10 },
  paused:   { sky:RGB('#8a8175'), lamp:RGB('#8a8175'), lampI:0.30, bright:0.62, tint:0.16 },
  awaiting: { sky:RGB('#d98a5c'), lamp:RGB('#ffb45c'), lampI:0.75, bright:0.90, tint:0.08 },
  done:     { sky:RGB('#2a2740'), lamp:RGB('#ffd25e'), lampI:1.10, bright:0.98, tint:0.18 },
};

// 底图里几件东西的位置（归一化，量自 1152×2048 那张 v4）
const P = {
  lamp:  { x:0.805, y:0.445 },                       // 石灯笼的光窗
  pool:  { cx:0.50, cy:0.845, rx:0.455, ry:0.125 },  // 汤池水面
  // 🔴 木牌必须落在**裁切安全区**里：手机比图窄，cover 会把两侧各裁掉约 9%
  //    （430×932 实测）。第一版摆在 x=0.045，左半块直接被裁到屏幕外。
  //    安全区按 x∈[0.12, 0.88] 取，比实测再留一点余量给更窄的机型。
  board: { x:0.135, y:0.487, w:0.300, h:0.076 },     // 木牌要摆的空地（图里没有木牌，我们画）
  stone: { x:0.545, y:0.500, w:0.165, h:0.062 },     // 岸上那几块石头（记录入口）
  lampBox:{ x:0.700, y:0.335, w:0.215, h:0.235 },    // 石灯笼整体（设置入口）
};

// 木牌的木色照着底图里那只木桶取，别用一块突兀的亮色板（它已经够格格不入了）
const C = { board:RGB('#6b4f33'), boardEdge:RGB('#3d2c1c'), lampCore:RGB('#ffdca0') };

window.SCENES = window.SCENES || {};
window.SCENES.onsen = {
  id: 'onsen',
  name: '山中野天风吕',
  light: LIGHT,
  bgImage: 'assets/onsen_v4.webp',
  imageSize: [1152, 2048],

  // ── 静态层：底图里没有的东西才画。现在只有一块木牌 ──────────
  // ⚠️ 木牌是程序画的色块，跟手绘底图风格必然不一致 —— 这是**临时的**：
  //    正式出图时木牌应该画进背景、或作为独立小物出一张。
  drawBg(g) {
    const { bx, W, H, U, light: L, slots, map, mapW } = g;
    bx.clearRect(0, 0, W, H);

    const b = map(P.board.x, P.board.y);
    const bw = mapW(P.board.w), bh = mapW(P.board.h);
    // 两条腿
    bx.fillStyle = css(C.boardEdge);
    bx.fillRect(b[0] + bw*0.18, b[1] + bh, 7*U, 26*U);
    bx.fillRect(b[0] + bw*0.72, b[1] + bh, 7*U, 26*U);
    // 落地影子：没有影子的东西看着是浮在画上的
    bx.fillStyle = 'rgba(0,0,0,.28)';
    bx.beginPath();
    bx.ellipse(b[0] + bw*0.5, b[1] + bh + 26*U, bw*0.42, 7*U, 0, 0, Math.PI*2);
    bx.fill();
    // 牌面（跟着状态光走一点点，别让它在暗场里发白）
    bx.fillStyle = css(mix(C.board, L.sky, 0.18 * L.tint * 6));
    bx.fillRect(b[0], b[1], bw, bh);
    // 上下沿加深，模拟木板的厚度
    bx.fillStyle = css(C.boardEdge);
    bx.fillRect(b[0], b[1], bw, 5*U);
    bx.fillRect(b[0], b[1] + bh - 4*U, bw, 4*U);

    // 回填槽位：时间显示挂在木牌上（🔴 位置由场景说了算，换场景就换物件）
    slots.time = { x:b[0], y:b[1], w:bw, h:bh, ink:'#3a2a1a', paper:'#fae4be' };

    // 🔴 只挂**功能真的存在**的入口。环境音和商店还没有这个功能，
    //    图里也没有竹筒和竹筐 —— 摆一个点了没反应的东西，比少一个入口伤得多。
    const box = (r) => { const p = map(r.x, r.y); return { x:p[0], y:p[1], w:mapW(r.w), h:mapW(r.h) }; };
    slots.entries = {
      start:    { x:b[0], y:b[1], w:bw, h:bh },   // 木牌 ＝ 选今天泡多久 / 编排
      settings: box(P.lampBox),                   // 石灯笼 ＝ 设置
      stats:    box(P.stone),                     // 岸上石头 ＝ 记录（来过几次）
    };
  },

  // ── 动态层：状态染色 + 灯笼呼吸光 + 水面微光。底图已经很完整，这里要克制 ──
  drawFx(g) {
    const { fx, W, H, light: L, t, map, mapW } = g;

    // 状态染色：很淡地染一层，别把真图染成塑料
    if (L.tint > 0.005) {
      fx.fillStyle = 'rgba(' + L.sky[0] + ',' + L.sky[1] + ',' + L.sky[2] + ',' + L.tint.toFixed(3) + ')';
      fx.fillRect(0, 0, W, H);
    }

    // 灯笼：底图里那盏本来就亮着，这里只加一层会呼吸的暖光晕
    if (L.lampI > 0.01) {
      const p = map(P.lamp.x, P.lamp.y);
      const flick = 1 + Math.sin(t * 2.6) * 0.045;
      const R = mapW(0.30) * L.lampI * flick;
      const gg = fx.createRadialGradient(p[0], p[1], mapW(0.01), p[0], p[1], R);
      gg.addColorStop(0, 'rgba(255,178,84,' + (0.30 * L.lampI).toFixed(3) + ')');
      gg.addColorStop(1, 'rgba(255,150,50,0)');
      fx.fillStyle = gg;
      fx.beginPath(); fx.arc(p[0], p[1], R, 0, Math.PI*2); fx.fill();
      fx.fillStyle = css(mix(C.lampCore, L.lamp, 0.35));
      fx.globalAlpha = 0.5 * L.lampI;
      fx.beginPath(); fx.arc(p[0], p[1], mapW(0.018), 0, Math.PI*2); fx.fill();
      fx.globalAlpha = 1;
    }

    // 水面：灯笼那一侧的倒影随水轻轻晃（底图里那道倒影是死的，加一点活气）
    if (L.lampI > 0.01) {
      const c = map(P.pool.cx, P.pool.cy);
      const rx = mapW(P.pool.rx), ry = mapW(P.pool.ry);
      fx.save();
      fx.beginPath(); fx.ellipse(c[0], c[1], rx, ry, 0, 0, Math.PI*2); fx.clip();
      const rg = fx.createLinearGradient(c[0] + rx*0.18, 0, c[0] + rx, 0);
      rg.addColorStop(0, 'rgba(255,150,60,0)');
      rg.addColorStop(0.5, 'rgba(255,150,60,' + (0.13 * L.lampI).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(255,150,60,0)');
      fx.fillStyle = rg;
      const wob = Math.sin(t*1.15) * mapW(0.006);
      fx.fillRect(c[0], c[1] - ry + wob, rx, ry*2);
      fx.restore();
    }
  },
};
})();
