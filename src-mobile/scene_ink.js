// 场景包 · 水墨庭院（中国风，9-1 上线；默认免费主题——商业化定调见档案）
//
// 🔴 美术定案（8-31 十二版母版换来的）：白墙即画布（题壁）、水面铺满下缘、
//    上岸位=灯旁蒲团、世界观=院子按水豚尺寸造。母版 _design/anchor_cn/master_v12。
// 🔴 显示层规矩（用户拍板）：**倒计时横排**（日系竖排/中国风横排=主题区分）+朱印，
//    **功能菜单放下方**（水面上一行三项）。
// 🔴 视频产线：8 段全带轮廓锁；空庭段守卫句"水面上没有任何动物"（水獭事件）。
(function () {
'use strict';

// 坐标：归一化于母版画幅 1152×2048（手机 cover 裁两侧各 ~9%，横向安全区 0.10~0.90）
const P = {
  wall: { x:0.10, y:0.125, x2:0.66, y2:0.315 },   // 题壁计时区（墙面留白）
  menuRow: { x:0.14, y:0.795, x2:0.86, y2:0.875 },// 菜单一行三项（近处水面上）
};
const third = (i) => ({ x:P.menuRow.x + (P.menuRow.x2-P.menuRow.x)/3*i, y:P.menuRow.y,
                        x2:P.menuRow.x + (P.menuRow.x2-P.menuRow.x)/3*(i+1), y2:P.menuRow.y2 });

window.SCENES = window.SCENES || {};
window.SCENES.ink = {
  id: 'ink',
  name: '水墨庭院',
  frame: [1152, 2048],
  poster: 'assets/poster_cn.webp',
  hint: '水上三个词都能点：入池＝开始 · 调汤＝设置 · 池录＝记录',
  assets: { base: 'cn-v2', dir: 'assets/video-cn',   // 9-2：睡觉/吃桃重出 + 四段过渡换 Seedance 2.0（上岸/下水拍回来了）
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

  menu: [ { key:'start',    label:'入池' },
          { key:'settings', label:'调汤' },
          { key:'stats',    label:'池录' } ],
  entries: { start:third(0), settings:third(1), stats:third(2) },

  ink: '#3e3226', seal: '汤', sealBg: '#b2382a',
  dim: { idle:0, work:0.08, break:0, awaiting:0, done:0, paused:0.34 },

  // ── 叠加层：题壁横排倒计时+朱印+当班小字（运行），菜单一行（空闲）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;

    if (ph === 'idle') {
      // 菜单：近处水面一行三项（毛笔字+各自一枚小水痕底衬，提示可点）
      const R = E.rect(P.menuRow), n = S.menu.length, cw = R.w / n;
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.font = Math.round(R.h * 0.56) + 'px ' + BRUSH;
      for (let i = 0; i < n; i++) {
        const cxm = R.x + cw * i + cw / 2, cym = R.y + R.h / 2;
        cx.fillStyle = 'rgba(244,238,224,0.55)';           // 水面上垫一层淡宣纸色保可读
        const bw = cw * 0.72, bh = R.h * 0.94;
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(cxm - bw/2, cym - bh/2, bw, bh, bh * 0.5);
        else cx.rect(cxm - bw/2, cym - bh/2, bw, bh);
        cx.fill();
        cx.fillStyle = S.ink;
        cx.fillText(S.menu[i].label, cxm, cym + R.h * 0.02);
      }
      return;
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
    if (ph === 'paused') label = '休止';
    else if (ph === 'break') label = '小憩';
    else {
      const CN = ['一','二','三','四','五','六','七','八','九','十'];
      const st = (v && v.stages) || [], idx = (v && v.idx) || 0;
      const n = st.slice(0, idx + 1).filter((s) => s.kind !== 'break').length;
      label = '第' + (n <= 10 ? CN[n - 1] : (n < 20 ? '十' + CN[n - 11] : String(n))) + '泡';
    }
    cx.font = Math.round(fpx * 0.34) + 'px ' + BRUSH;
    cx.fillStyle = 'rgba(62,50,38,0.68)';
    cx.fillText(label, tx, T.y + T.h * 0.82);
  },
};
})();
