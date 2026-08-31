// 场景包 · 山中野天风吕 —— 整场视频状态机版（8-30 架构定案后重写）
//
// 🔴 画面不再分层拼装：每个状态＝一段"整场画好的循环视频"（关键帧首尾帧钉扣子，
//    原生 <video loop> 无缝）。引擎（scene.js）只管播视频、雾转场、写数字、调光、
//    命中区——不认识任何具体场景；本包给出：段清单、状态→段映射、过场规则、槽位。
// 🔴 关键帧体系（_design\anchor\kf_*.jpg）：K0 空场景母版（=done）/K1 闭眼泡（idle）/
//    K1b 睁眼泡（work）/K1.5 爬沿（过场①的尾锚）/K2 岸上吃瓜（长休）/
//    K3 晒太阳（短休）/K4 水中招手（awaiting）。产线规矩=K0+添加，永不挪主体。
// 🔴 过场规则：铃响下水段（池内状态→休息）先播 t_a_swim（游到池边，后半身在水
//    ＝无尾可画），随后**雾吞吐遮蔽上岸瞬间**；其余一切切换（含回程/打断）一律雾转场。
//    "爬上岸"实拍两引擎判死（3.0 长尾×5、Pro 变浣熊），别再试。
(function () {
'use strict';

// 坐标：归一化于关键帧画幅 1152×2048（视频 1088×1920，纵横比差 0.7% 忽略）
const P = {
  board:  { x:0.100, y:0.350, x2:0.410, y2:0.505 },   // 木牌牌面（功能菜单，裁切安全区内）
  // 8-31 用户定案「功能上牌 + 倒计时上天」：木牌=三行功能字（空闲时），
  // 倒计时=右上天空的浮世绘题字框（太阳在左上，别撞）。石灯笼/石头入口退役。
  row1: { x:0.100, y:0.352, x2:0.410, y2:0.403 },
  row2: { x:0.100, y:0.403, x2:0.410, y2:0.454 },
  row3: { x:0.100, y:0.454, x2:0.410, y2:0.505 },
  cart: { x:0.665, y:0.052, x2:0.865, y2:0.292 },     // 题字框（竖排 MM/SS + 落款印）
};

window.SCENES = window.SCENES || {};
window.SCENES.onsen = {
  id: 'onsen',
  name: '山中野天风吕',
  frame: [1152, 2048],          // 槽位坐标的参照画幅

  // 状态 → 循环段（都在 assets/video/，首=尾原生无缝循环）
  loops: {
    idle:  'loop_soak',         // 闭眼泡着打盹（拜访概念：你没来它也在过日子）
    work:  'loop_work',         // 睁眼安静陪你泡
    shortBreak: 'loop_sunbathe',
    longBreak:  'loop_eat',
    awaiting:   'loop_urge',    // 在水里朝你招手
    done:  'loop_empty',        // 人去汤空
    // paused：不换段——当前视频停格 + 调光（引擎处理）
  },
  // 池内状态（从这些状态去休息时，先播"游到池边"再雾转场）
  poolStates: ['idle', 'work', 'awaiting'],
  swimOut: 't_a_swim',

  // 木牌功能菜单（空闲时画；毛笔字=马善政楷 OFL 子集，倾角跟牌走，量自 kf_k1）
  board: { ...P.board, tiltDeg:-3.2, ink:'#3a2112',
           menu: [ { key:'start',    label:'入 浴' },
                   { key:'settings', label:'汤加减' },
                   { key:'stats',    label:'汤 帐' } ] },
  // 倒计时题字框：右上天空竖排，纸色+朱边+「汤」印（浮世绘题字的母语，不是 UI 贴片）
  cart: { ...P.cart, paper:'242,226,192', border:'178,60,38', ink:'#2b1a0e',
          seal:'汤', sealBg:'#b7382a' },
  entries: { start:P.row1, settings:P.row2, stats:P.row3 },

  // 状态调光（视频自带黄昏光，这里只做轻叠加）：paused 最暗，work 微暗
  dim: { idle:0, work:0.10, break:0, awaiting:0, done:0, paused:0.34 },
};
})();
