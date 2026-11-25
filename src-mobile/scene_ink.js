// Water Ink Courtyard: entries and timer follow the same composition as the footage.
(function () {
'use strict';

// 坐标：归一化于母版画幅 1152×2048（手机 cover 裁两侧各 ~9%，横向安全区 0.10~0.90）
const P = {
  wall: {x:.125,y:.277,x2:.445,y2:.350},   // 题壁计时区（墙面留白）
  // 菜单一列三词（9-3 用户定：右侧宫灯与廊柱之间；量母版：宫灯右缘 0.74、门洞白框 0.80、风铃垂到 0.30、地面 0.575 →
  // 可用墙面只有 5.5% 宽，横排放不下，竖排六字一列；只在空闲态画）
  menuCol: {x:.866,y:.232,x2:.997,y2:.408},
};
const rowOf = (i) => { const h = (P.menuCol.y2 - P.menuCol.y) / 3;
                       return { x:P.menuCol.x, y:P.menuCol.y + h * i, x2:P.menuCol.x2, y2:P.menuCol.y + h * (i + 1) }; };

window.SCENES = window.SCENES || {};
window.SCENES.ink = {
  id: 'ink',
  name: '水墨庭院',
  fit: 'contain', frame: [720, 1280],
  poster: 'assets/ink-courtyard/soak.webp',
  hint: '木牌三格都能点：汤沐＝开始 · 调汤＝设置 · 沐录＝记录',
  assets: { bundled: true, base: 'ink-courtyard-v5', dir: 'assets/ink-courtyard',   // 9-2：睡觉/吃桃重出 + 四段过渡换 Seedance 2.0；v3=去程首帧改钉工作帧（与 loop_work 同源）
            names: ['loop_soak','loop_work','loop_nap','loop_eat',
                    'loop_urge','loop_empty','t_a_swim','t_b_swim'] },

  loops: {
    idle:  'loop_soak',         // 闭眼泡（B 微动作版：抽鼻子/耳朵轻动）
    work:  'loop_work',
    shortBreak: 'loop_nap',     // 蒲团打盹
    longBreak:  'loop_eat',     // 蒲团吃桃
    awaiting:   'loop_urge',
    done:  'loop_empty',
  },
  poolStates: ['idle', 'work', 'awaiting'],
  swimOut: 't_a_swim',          // 池心→对岸池沿（上岸瞬间藏在雾里，同日系）
  swimIn:  't_b_swim',          // 池沿→池心（break→work 回程）

  menu: [ { key:'start',    label:'汤沐' },     // 9-2 用户改：入池→汤沐、池录→沐录；调汤不动
          { key:'settings', label:'调汤' },
          { key:'stats',    label:'沐录' } ],
  entries: { start:rowOf(0), settings:rowOf(1), stats:rowOf(2) },

  ink: '#3e3226', seal: '汤', sealBg: '#b2382a',
  dim: { idle:0, work:0.08, break:0, awaiting:0, done:0, paused:0.34 },

  // ── 叠加层：题壁横排倒计时+朱印+当班小字（运行），菜单一行（空闲）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;

    YardArt(E,cx,ph,window.RW?.view?.state);
    {
      // 菜单：右侧墙面竖排一列三词（题壁式毛笔字，不垫底衬——墙面留白本身就是底；每词下一道淡墨短线提示可点）
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      for (let i = 0; i < S.menu.length; i++) {
        const R = E.rect(rowOf(i)), cxm = R.x + R.w / 2, cym = R.y + R.h / 2;
        const lab = window.I18N ? I18N.t(S.menu[i].label) : S.menu[i].label;   // 英文：Soak / Tune / Log
        // 🔴 字号受列宽约束（列只有 5.5% 幅宽）：中文两字上下叠；英文横写、按字数缩
        const fs = Math.round(Math.min(R.w * 0.43, R.h * 0.40));
        cx.fillStyle = ph==='idle'?'#ebc787':'#bc9863';
        if (/[一-鿿]/.test(lab)) {
          cx.font = fs + 'px ' + BRUSH;
          for (let c = 0; c < lab.length; c++) cx.fillText(lab[c], cxm, cym + (c - (lab.length - 1) / 2) * fs * 1.1);
        } else {
          const fe = Math.round(Math.min(fs * 0.8, R.w * 1.9 / Math.max(3, lab.length)));
          cx.font = fe + 'px ' + BRUSH;
          cx.fillText(lab, cxm, cym);
        }
      }
    }
    if (ph !== 'work' && ph !== 'break' && ph !== 'paused') return;

    // 题壁计时：横排 MM:SS 大字 + 右侧朱印；下方一行当班小字。
    // 题壁诗直接落在粉壁上是园林母语——没有框，字就是画的一部分。
    const T = E.rect(P.wall);
    const secs = Math.max(0, Math.round(((v && v.remaining_ms) || 0) / 1000));
    const pre = (ph !== 'paused' && secs <= E.preAlertSec) ? (1 - secs / E.preAlertSec) : 0;
    const txt = String(Math.floor(secs / 60)).padStart(2, '0') + ':' +
                String(secs % 60).padStart(2, '0');
    const fpx = Math.round(Math.min(T.h * 0.60, T.w * 0.30));
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.font = fpx + 'px ' + BRUSH;
    cx.fillStyle = 'rgba(62,50,38,' + (0.82 + pre * 0.18).toFixed(2) + ')';
    const tx = T.x + T.w * 0.44, ty = T.y + T.h * 0.42;
    cx.fillText(txt, tx, ty);
    // 朱印：字右下角落款
    const sw = fpx * 0.42;
    const sx = tx + cx.measureText(txt).width / 2 + sw * 0.35, sy = ty + fpx * 0.18;
    cx.fillStyle = S.sealBg;
    cx.fillRect(sx, sy, sw, sw);
    cx.font = Math.round(sw * 0.72) + 'px ' + BRUSH;
    cx.fillStyle = 'rgba(245,235,215,0.95)';
    cx.fillText(S.seal, sx + sw / 2, sy + sw * 0.54);
    // 当班小字：第X泡 / 小憩 / 休止
    let label;
    const EN = window.I18N && I18N.lang === 'en';   // 9-2 双语：画布上的字不在 DOM 里，场景包自己选词
    if (ph === 'paused') label = EN ? 'Paused' : '休止';
    else if (ph === 'break') label = EN ? 'Rest' : '小憩';
    else {
      const CN = ['一','二','三','四','五','六','七','八','九','十'];
      const st = (v && v.stages) || [], idx = (v && v.idx) || 0;
      const n = st.slice(0, idx + 1).filter((s) => s.kind !== 'break').length;
      label = EN ? ('Soak ' + n) : ('第' + (n <= 10 ? CN[n - 1] : (n < 20 ? '十' + CN[n - 11] : String(n))) + '泡');
    }
    cx.font = Math.round(fpx * 0.34) + 'px ' + BRUSH;
    cx.fillStyle = 'rgba(62,50,38,0.68)';
    cx.fillText(label, tx, T.y + T.h * 0.82);
  },
};
})();
