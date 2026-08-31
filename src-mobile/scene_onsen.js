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
  poster: 'assets/poster.webp',
  hint: '牌上三行都能点：入浴＝开始 · 汤加减＝设置 · 汤帐＝记录',
  assets: { base: 'v1', dir: 'assets/video',
            names: ['loop_soak','loop_work','loop_sunbathe','loop_eat',
                    'loop_urge','loop_empty','t_a_swim','t_b_swim'] },

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
  // 回程（8-31）：休息→工作时，雾散见水豚已在池边→游回池心→交叉淡化接工作循环。
  // 🔴 只接 work（尾帧钉的 K1b 睁眼泡）；休息→等待/空闲仍走纯雾转场（姿态对不上）。
  swimIn: 't_b_swim',

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

  // ── 叠加层绘制（9-1 从引擎搬回家：日系=功能上牌+当班牌+天空题字框竖排）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;
    // 木牌：空闲=功能菜单；运行=当班牌（第几泡/小憩/休止 + 完成刻痕计数）。
    // 🔴 当班牌是纯展示不是按钮——零 UI 原则没破，只是别让牌在过程中空着（8-31 反馈）。
    if (S.board) {
      const B = E.rect(S.board);
      cx.save();
      cx.translate(B.x + B.w / 2, B.y + B.h / 2);
      cx.rotate((S.board.tiltDeg || 0) * Math.PI / 180);   // 牌画在视频里，左低右高 ~3.2°
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      if (ph === 'idle') {
        const rows = S.board.menu, rh = B.h / rows.length;
        cx.font = Math.round(rh * 0.60) + 'px ' + BRUSH;
        cx.fillStyle = S.board.ink;
        for (let i = 0; i < rows.length; i++) {
          cx.fillText(rows[i].label, 0, (i - (rows.length - 1) / 2) * rh);
        }
      } else if (ph === 'work' || ph === 'break' || ph === 'paused') {
        const st = (v && v.stages) || [], idx = (v && v.idx) || 0;
        let label;
        if (ph === 'paused') label = '休 止';
        else if (ph === 'break') label = '小 憩';
        else {
          const CN = ['一','二','三','四','五','六','七','八','九','十'];
          const n = st.slice(0, idx + 1).filter((s) => s.kind !== 'break').length;
          const cn = n <= 10 ? CN[n - 1] : (n < 20 ? '十' + CN[n - 11] : String(n));
          label = '第' + cn + '泡';
        }
        cx.font = Math.round(B.h * 0.34) + 'px ' + BRUSH;
        cx.fillStyle = S.board.ink;
        cx.fillText(label, 0, -B.h * 0.12);
        // 完成刻痕：每过一段添一道笔触（确定性微抖，像刻上去的计数）
        const jj = (s) => { const x = Math.sin(s) * 43758.5453; return x - Math.floor(x); };
        const dn = Math.min(idx, 24), tw = B.h * 0.052, gap = B.w * 0.052;
        const x0 = -((dn - 1) * gap) / 2;
        cx.strokeStyle = 'rgba(58,33,18,0.78)';
        cx.lineCap = 'round';
        for (let i = 0; i < dn; i++) {
          cx.lineWidth = tw * (0.30 + jj(i * 7.3) * 0.14);
          cx.beginPath();
          cx.moveTo(x0 + i * gap + (jj(i * 3.1) - 0.5) * gap * 0.2, B.h * 0.20 - tw * (1 + jj(i * 5.7) * 0.3));
          cx.lineTo(x0 + i * gap + (jj(i * 9.7) - 0.5) * gap * 0.2, B.h * 0.20 + tw * (1 + jj(i * 2.9) * 0.3));
          cx.stroke();
        }
      }
      cx.restore();
    }

    // 倒计时题字框：右上天空，纸色+朱红双边+竖排 MM/SS+「汤」印。
    // 浮世绘的天空本来就是题字盖印的地方——文字压在画面上是这种画的母语。
    const secs = Math.max(0, Math.round(((v && v.remaining_ms) || 0) / 1000));
    const hasTime = (ph === 'work' || ph === 'break' || ph === 'paused');
    if (hasTime && S.cart) {
      const C = E.rect(S.cart);
      const pre = (ph !== 'paused' && secs <= E.preAlertSec)
        ? (1 - secs / E.preAlertSec) : 0;                  // 末 30 秒纸色渐醒目
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
  },
};
})();
