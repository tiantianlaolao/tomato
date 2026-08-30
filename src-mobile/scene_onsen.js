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
  lamp:  { x:0.805, y:0.443 },                       // 石灯笼的光窗
  pool:  { cx:0.50, cy:0.820, rx:0.500, ry:0.190 },  // 汤池水面（bg_final＝v2 底：池占下半）
  // 🔴 木牌＝背景里画好的那块（_make_bg_final.py 合成时坐标定死）。
  //    牌子左缘故意出血到 0.056（手机 cover 裁 9% 很自然）；
  //    数字槽只取裁切安全区内的牌面 x0.115~0.42、y=牌面竖向范围（y2 是下缘）。
  board: { x:0.115, y:0.358, w:0.300, y2:0.505 },
  // 🔴 命中区要落在**画上真有那件东西**的地方。记录入口＝灯笼左边地上那几块石头。
  stone: { x:0.500, y:0.505, w:0.190, h:0.055 },
  lampBox:{ x:0.715, y:0.350, w:0.195, h:0.330 },    // 石灯笼整体（设置入口）
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
  bgImage: 'assets/onsen_bg.webp',   // 8-30 重设计版：空池 + 木牌画进背景（程序牌退役）
  imageSize: [1152, 2048],

  // ── 角色层配置（capy.js 读）：anchor=水豚 bbox 底边中心（脚底/水patch底），
  //    w=水豚 bbox 上屏宽（图宽单位）——按量出的 bbox 缩放，各段大小从此一致 ──
  // 🔴 8-30 重设计：木桶退役，泡汤类段=直接泡在池水里（水面涟漪在素材里，色键保水）；
  //    上岸类段锚在木牌右侧、灯笼左边的碎石地（中景，按透视比池心略小）。
  capy: {
    x:0.50, y:0.97, w:0.60,
    states: {
      idle:'v3_idle',         // 空闲：闭眼泡着打盹（拜访概念——你没来它也在过日子）
      work:'v3_soak',         // 工作：睁眼安静泡着陪你
      shortBreak:'v3_sunbathe', longBreak:'v2_eat',
      awaiting:'v3_urge',     // 段间：在水里探身朝你招手（它不上岸等你）
      done:'',                // 拜访结束＝人去汤空（道别仪式以后做成卡片前的过场）
    },
    perSeg: {
      // 上岸段：整只落在碎石地上（y=脚底线；🔴脚绝不许沾池沿/水）
      v3_sunbathe:{ x:0.57, y:0.578, w:0.30 },
      v2_eat:     { x:0.58, y:0.578, w:0.21 },
    },
  },
  // ── 薄雾层（capy.js 画，lighter 叠加）：多实例不同相位/镜像/速率铺满整池，
  //    消掉单实例循环感；x/y=雾层底边中心，w=实例宽（图宽单位）──
  mist: {
    sheet: 'v_fx_mist',
    instances: [
      { x:0.32, y:0.84, w:0.85, t0:0.0 },
      { x:0.70, y:0.92, w:0.95, t0:2.7, flip:true },
      { x:0.50, y:1.00, w:1.10, t0:5.3 },
    ],
    alphaByPhase: { idle:0.38, work:0.5, break:0.26, paused:0.3, awaiting:0.42, done:0.5 },
  },

  // ── 静态层：木牌已画进背景（8-30 重设计，程序牌退役）——这里只回填槽位 ──
  drawBg(g) {
    const { bx, W, H, U, light: L, slots, map, mapW } = g;
    bx.clearRect(0, 0, W, H);

    // 时间槽＝背景里那块画好的木牌牌面（坐标在 _make_bg_final.py 合成时定死；
    // 取**裁切安全区内**的牌面：牌子左缘故意出血到 0.056，数字只用 0.115 起）
    const t0 = map(P.board.x, P.board.y), t1 = map(P.board.x + P.board.w, P.board.y2);
    slots.time = { x:t0[0], y:t0[1], w:t1[0]-t0[0], h:t1[1]-t0[1], ink:'#f7d3a4', paper:'#4a2b16' };

    // 🔴 只挂**功能真的存在**的入口。环境音和商店还没有这个功能，
    //    图里也没有竹筒和竹筐 —— 摆一个点了没反应的东西，比少一个入口伤得多。
    const box = (r) => { const p = map(r.x, r.y); return { x:p[0], y:p[1], w:mapW(r.w), h:mapW(r.h) }; };
    slots.entries = {
      start:    slots.time,                       // 木牌（画在背景里）＝ 选今天泡多久 / 编排
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
