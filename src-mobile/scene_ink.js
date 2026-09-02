// 场景包 · 水墨庭院（中国风，9-1 上线；默认免费主题——商业化定调见档案）
//
// 🔴 美术定案（8-31 十二版母版换来的）：白墙即画布（题壁）、水面铺满下缘、
//    上岸位=灯旁蒲团、世界观=院子按水豚尺寸造。母版 _design/anchor_cn/master_v12。
// 🔴 显示层规矩（用户拍板）：**倒计时横排**（日系竖排/中国风横排=主题区分）+朱印，
//    **功能菜单放白墙下方一行三项**（9-2 用户定：汤沐/调汤/沐录，从水面挪到墙上）。
// 🔴 P3 槽位（9-2）：风铃檐下、题壁字墙心、手拭巾两根竿在题字下（第二根给访客手信）、
//    石灯与兰花在太湖石脚下、荷花近水；岸上槽位一律避开水豚坐蒲团的 x 0.54~0.90。
// 🔴 视频产线：8 段全带轮廓锁；空庭段守卫句"水面上没有任何动物"（水獭事件）。
(function () {
'use strict';

// 坐标：归一化于母版画幅 1152×2048（手机 cover 裁两侧各 ~9%，横向安全区 0.10~0.90）
const P = {
  wall: { x:0.10, y:0.125, x2:0.66, y2:0.315 },   // 题壁计时区（墙面留白）
  menuRow: { x:0.29, y:0.535, x2:0.63, y2:0.605 }, // 菜单一行三项（9-2 用户定：白墙下方，太湖石与宫灯之间的留白；下挪 5% 给手拭巾杆腾位；右缘 0.63 避开宫灯杆 0.64；只在空闲态画）
};
const third = (i) => ({ x:P.menuRow.x + (P.menuRow.x2-P.menuRow.x)/3*i, y:P.menuRow.y,
                        x2:P.menuRow.x + (P.menuRow.x2-P.menuRow.x)/3*(i+1), y2:P.menuRow.y2 });
// P3 庭院槽位（id 与 rewards_catalog.json 的 ink.slots 一致）+ 手拭巾晾杆位。
// 🔴 现在全是占位（纸色小牌写名字），真图到了换成 drawImage，坐标不动。
const SLOTS = {
  // 🔴 岸上段水豚占 x 0.50~0.89，槽位必须避开，否则叠加层会画在它身上
  lamp_side:  { x:0.235, y:0.57, x2:0.30, y2:0.62, scale:1.6 },   // 石灯旁（蒲团旁那块在空闲态压着菜单、休息态压着水豚，两头都不行）
  pool_edge:  { x:0.10, y:0.545, x2:0.22, y2:0.615 },  // 石台左侧、太湖石脚下（右侧超出手机安全区会被裁）
  wall:       { x:0.31, y:0.375, x2:0.53, y2:0.44, scale:1.0 },   // 白墙留白（菜单上方）——9-2 用户：太大 → 缩到槽位原尺寸
  water_near: { x:0.10, y:0.86,  x2:0.24, y2:0.92 },   // 近处水面
  // 🔴 挂点坐标是量母版像素得来的（檐底 x0.73~0.76 → y≈0.195~0.21；石顶脊 x0.13 → y≈0.367），别目测
  willow:     { x:0.72, y:0.195, x2:0.77, y2:0.30, top:true, scale:1.0 },   // 檐下：绳头顶进飞檐底边（9-2 用户：挂柳条上挂不住）
};
// 手拭巾（9-2 定案）：题壁字下方、菜单上方的墙面，两根短竹竿（竿画在图里）。
// 第一根＝自己挂的那条，永远在；第二根＝访客来时挂它带来的手信，平时空着不画。
const TOWELS = [ { x:0.28, y:0.445, x2:0.41, y2:0.535, top:true, scale:1.0 },
                 { x:0.43, y:0.445, x2:0.56, y2:0.535, top:true, scale:1.0 } ];

window.SCENES = window.SCENES || {};
window.SCENES.ink = {
  id: 'ink',
  name: '水墨庭院',
  frame: [1152, 2048],
  poster: 'assets/poster_cn.webp',
  hint: '墙上三个词都能点：汤沐＝开始 · 调汤＝设置 · 沐录＝记录',
  assets: { base: 'cn-v3', dir: 'assets/video-cn',   // 9-2：睡觉/吃桃重出 + 四段过渡换 Seedance 2.0；v3=去程首帧改钉工作帧（与 loop_work 同源）
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
  entries: { start:third(0), settings:third(1), stats:third(2) },

  ink: '#3e3226', seal: '汤', sealBg: '#b2382a',
  dim: { idle:0, work:0.08, break:0, awaiting:0, done:0, paused:0.34 },

  // ── 叠加层：题壁横排倒计时+朱印+当班小字（运行），菜单一行（空闲）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;

    // P3：摆好的小物 + 挂着的手拭巾（静态景物，所有状态都在——它们不是进度，不违红线一）
    const RW = window.RW, rv = RW && RW.view;
    if (rv && rv.state) {
      // 真图：assets/p3/ink/<id>.png（RGBA，长边 512）。没图或没加载完就画纸牌占位。
      // 图按槽位框"contain"放、底边对齐（东西都是立在地上/浮在水上的）。
      const img = (id) => {
        const c = S._imgs || (S._imgs = {});
        if (!(id in c)) {
          const im = new Image(); c[id] = im; im.ok = false;
          im.onload = () => { im.ok = true; E.draw && E.draw(); };
          im.onerror = () => { im.ok = false; im.failed = true; };
          im.src = 'assets/p3/ink/' + id + '.png';
        }
        return c[id];
      };
      const pic = (r, id, name, scale) => {
        const im = img(id);
        if (!im.ok) { if (im.failed) tag(r, name); return; }
        const sc = r.scale || scale;
        const R = E.rect(r), s = Math.min((R.w * sc) / im.width, (R.h * sc) / im.height);
        const w = im.width * s, h = im.height * s;
        // 立在地上/浮在水上的底边对齐；挂着的（风铃/手拭巾）顶边对齐
        cx.drawImage(im, R.x + (R.w - w) / 2, r.top ? R.y : R.y + R.h - h, w, h);
      };
      const tag = (r, name) => {
        const R = E.rect(r), fpx = Math.round(Math.min(R.h * 0.55, R.w * 0.42));
        cx.fillStyle = 'rgba(244,238,224,0.82)';
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(R.x, R.y, R.w, R.h, R.h * 0.25); else cx.rect(R.x, R.y, R.w, R.h);
        cx.fill();
        cx.strokeStyle = 'rgba(62,50,38,0.35)'; cx.lineWidth = Math.max(1, R.h * 0.03); cx.stroke();
        cx.fillStyle = S.ink; cx.textAlign = 'center'; cx.textBaseline = 'middle';
        cx.font = fpx + 'px ' + BRUSH;
        cx.fillText(name, R.x + R.w / 2, R.y + R.h / 2);
      };
      const placed = rv.state.placed || {};
      for (const slot in placed) {
        const p = RW.cat('props', placed[slot]);
        if (p && SLOTS[slot]) pic(SLOTS[slot], p.id, p.name, 2.2);
      }
      if (rv.state.hung) {
        const t = RW.cat('towels', rv.state.hung);
        if (t) pic(TOWELS[0], t.id, t.name, 1.0);
      }
      if (rv.state.guest_towel) {          // 访客带来的手信（访客线接上后由内核写入）
        const t = RW.cat('towels', rv.state.guest_towel);
        if (t) pic(TOWELS[1], t.id, t.name, 1.0);
      }
    }

    if (ph === 'idle') {
      // 菜单：白墙下方一行三项（题壁式毛笔字，不垫底衬——墙面留白本身就是底；字下一道淡墨短线提示可点）
      const R = E.rect(P.menuRow), n = S.menu.length, cw = R.w / n;
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      // 🔴 字号受格宽约束：两个字占格宽 80%，否则三组词挤成一串（9-2 截图撞过）
      const fpx = Math.round(Math.min(R.h * 0.62, cw * 0.40));
      cx.font = fpx + 'px ' + BRUSH;
      for (let i = 0; i < n; i++) {
        const cxm = R.x + cw * i + cw / 2, cym = R.y + R.h / 2;
        cx.fillStyle = S.ink;
        cx.fillText(window.I18N ? I18N.t(S.menu[i].label) : S.menu[i].label, cxm, cym);   // 英文：Soak / Tune / Log
        cx.fillStyle = 'rgba(62,50,38,0.28)';
        cx.fillRect(cxm - fpx * 0.9, cym + fpx * 0.62, fpx * 1.8, Math.max(2, fpx * 0.05));
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
