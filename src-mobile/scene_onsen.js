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
const { RGB, mix, css, rgba } = window.SceneUtil;

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

// 底图里几件东西的位置（归一化，8-30 起量自"空池版" bg_onsen_empty：
// 水豚/木桶不再烘在图里，由 capy.js 精灵层叠加——所以才有下面的 capy/steam 配置）
const P = {
  lamp:  { x:0.805, y:0.443 },                       // 石灯笼的光窗（新图基本没挪）
  pool:  { cx:0.50, cy:0.800, rx:0.480, ry:0.165 },  // 汤池水面（新图池更大更圆）
  // 🔴 木牌必须落在**裁切安全区**里：手机比图窄，cover 会把两侧各裁掉约 9%
  //    （430×932 实测）。第一版摆在 x=0.045，左半块直接被裁到屏幕外。
  //    安全区按 x∈[0.12, 0.88] 取，比实测再留一点余量给更窄的机型。
  // 🔴 8-29 用户："倒计时太小了……希望能明显一些一眼能瞄见" →
  //    牌子放大到屏宽约 2/3，数字横向占屏宽 ~48%（《场景与美术方案说明书》§4：
  //    一米外可读、占屏宽 ≥40%）。w/h 都是**图宽**单位（mapW 按宽缩放）。
  board: { x:0.115, y:0.447, w:0.550, h:0.225 },
  // 🔴 命中区要落在**画上真有那件东西**的地方（点一片空气＝看得见摸不着）。
  //    新图里最明确的石头＝灯笼左边地上那几块。
  stone: { x:0.480, y:0.508, w:0.200, h:0.060 },     // 灯笼左侧地上的石头（记录入口）
  lampBox:{ x:0.715, y:0.356, w:0.195, h:0.410 },    // 石灯笼整体（设置入口，新图灯笼更高）
};

// 🔴 木色**直接从 v4 图里取样**（木桶那一片的主色/暗箍/高光），不靠感觉调 ——
//    8-29 用户说新木牌不如旧的搭，病根就是我自己配了一个暗棕色块。
const C = {
  board:RGB('#de9d60'), boardDark:RGB('#985839'), boardEdge:RGB('#724737'),
  boardHi:RGB('#f0bd88'), lampCore:RGB('#ffdca0'),
};

window.SCENES = window.SCENES || {};
window.SCENES.onsen = {
  id: 'onsen',
  name: '山中野天风吕',
  light: LIGHT,
  bgImage: 'assets/onsen_bg.webp',   // 8-30 空池版（水豚/木桶由精灵层叠加）
  imageSize: [1152, 2048],

  // ── 角色层配置（capy.js 读）：anchor=768 源帧底边中心落点，w=源帧宽（图宽单位）──
  // 泡汤类段（精灵自带木桶）锚在池心；上岸类段锚在灯笼左边的石岸上（画里真有地面）。
  capy: {
    x:0.50, y:0.92, w:0.62,
    states: {
      idle:'v2_onsen',        // 空闲：它自己泡着（拜访概念——你没来它也在过日子）
      work:'v2_soak',         // 工作：眼半睁醒着陪你
      shortBreak:'v2_sunbathe', longBreak:'v2_eat',
      awaiting:'v2_urge',
      done:'',                // 拜访结束＝人去汤空（道别仪式以后做成卡片前的过场）
    },
    // 🔴 上岸类段不能锚在灯笼旁的石岸（y≈0.57）——那片正好在大木牌背后，
    //    角色层画在 bgc 之下，整只水豚被牌子盖没（截图才看出来）。
    //    改锚**前景池沿**（y≈1.0 贴住前沿石才不像漂在水上）：更近景更大。
    perSeg: {
      v2_onsen:   { x:0.52, y:0.90, w:0.56 },   // 视频里桶几乎占满帧，bbox 复位后偏左偏大
      // y>1＝脚被画框底边裁掉一点：明确的"近景坐在最前沿"，消掉漂在水上的歧义
      v2_sunbathe:{ x:0.55, y:1.030, w:0.46 },
      v2_eat:     { x:0.60, y:1.035, w:0.40 },
      v2_urge:    { x:0.60, y:1.035, w:0.40 },
    },
  },
  // ── 蒸汽层配置：x/y=蒸汽底边中心（池面），w=宽（图宽单位）──
  // y 压到 0.88：蒸汽要从水面长出来，0.78 时柱脚断在半池空中
  steam: { x:0.50, y:0.88, w:0.60 },

  // ── 静态层：底图里没有的东西才画。现在只有一块木牌 ──────────
  // ⚠️ 木牌是程序画的色块，跟手绘底图风格必然不一致 —— 这是**临时的**：
  //    正式出图时木牌应该画进背景、或作为独立小物出一张。
  drawBg(g) {
    const { bx, W, H, U, light: L, slots, map, mapW } = g;
    bx.clearRect(0, 0, W, H);

    const b = map(P.board.x, P.board.y);
    const bw = mapW(P.board.w), bh = mapW(P.board.h);
    const legY = b[1] + bh, legH = mapW(0.048), legW = mapW(0.022);

    // 落地影子：没有影子的东西看着是浮在画上的
    bx.fillStyle = 'rgba(0,0,0,.30)';
    bx.beginPath();
    bx.ellipse(b[0] + bw*0.5, legY + legH, bw*0.46, mapW(0.016), 0, 0, Math.PI*2);
    bx.fill();
    // 两根立柱
    bx.fillStyle = css(C.boardEdge);
    bx.fillRect(b[0] + bw*0.17, legY, legW, legH);
    bx.fillRect(b[0] + bw*0.83 - legW, legY, legW, legH);
    // 牌面（跟着状态光走一点点，别让它在暗场里发白）
    const face = mix(C.board, L.sky, 0.18 * L.tint * 6);
    bx.fillStyle = css(face);
    bx.fillRect(b[0], b[1], bw, bh);
    // 三条横向木纹：一块纯色板一眼就是"程序画的"，加了纹理才像木头
    bx.fillStyle = rgba(C.boardEdge, 0.14);
    for (let i = 1; i <= 3; i++) bx.fillRect(b[0], b[1] + bh * i/4, bw, Math.max(1, mapW(0.0035)));
    // 上沿高光 + 下沿暗边 ＝ 板子的厚度
    bx.fillStyle = rgba(C.boardHi, 0.55);
    bx.fillRect(b[0], b[1], bw, mapW(0.010));
    bx.fillStyle = css(C.boardDark);
    bx.fillRect(b[0], b[1] + bh - mapW(0.014), bw, mapW(0.014));
    // 左右包边（横木两端的绑扎），跟木桶上的箍呼应
    bx.fillRect(b[0], b[1], mapW(0.016), bh);
    bx.fillRect(b[0] + bw - mapW(0.016), b[1], mapW(0.016), bh);

    // 回填槽位：时间显示挂在木牌上（🔴 位置由场景说了算，换场景就换物件）
    // 🔴 数字是**刻在浅木牌上的深色字**（暖木底 + 深棕字 + 下方一道浅色凹凸边），
    //    不是原来那种"深色板 + 米色字"。ink 是那道凹凸边，paper 是字本身。
    slots.time = { x:b[0], y:b[1], w:bw, h:bh, ink:'#f7d3a4', paper:'#4a2b16' };

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
