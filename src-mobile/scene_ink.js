// 场景包 · 水墨庭院（中国风，9-1 上线；默认免费主题——商业化定调见档案）
//
// 🔴 美术定案（8-31 十二版母版换来的）：白墙即画布（题壁）、水面铺满下缘、
//    上岸位=灯旁蒲团、世界观=院子按水豚尺寸造。母版 _design/anchor_cn/master_v12。
// 🔴 显示层规矩（用户拍板）：**倒计时横排**（日系竖排/中国风横排=主题区分）+朱印，
//    功能菜单 9-3 用户定：**挪到右侧宫灯与廊柱之间的墙面竖排一列**（汤沐/调汤/沐录），
//    地砖中央整块让给小物——之前一行三项横在白墙下方，把院子里唯一能摆东西的地面占死了。
// 🔴 P3 槽位（9-2）：风铃檐下、题壁字墙心、手拭巾两根竿在题字下（第二根给访客手信）、
//    石灯与兰花在太湖石脚下、荷花近水；岸上槽位一律避开水豚坐蒲团的 x 0.54~0.90。
// 🔴 视频产线：8 段全带轮廓锁；空庭段守卫句"水面上没有任何动物"（水獭事件）。
(function () {
'use strict';

// 坐标：归一化于母版画幅 1152×2048（手机 cover 裁两侧各 ~9%，横向安全区 0.10~0.90）
const P = {
  wall: { x:0.10, y:0.125, x2:0.66, y2:0.315 },   // 题壁计时区（墙面留白）
  // 菜单一列三词（9-3 用户定：右侧宫灯与廊柱之间；量母版：宫灯右缘 0.74、门洞白框 0.80、风铃垂到 0.30、地面 0.575 →
  // 可用墙面只有 5.5% 宽，横排放不下，竖排六字一列；只在空闲态画）
  menuCol: { x:0.735, y:0.335, x2:0.81, y2:0.555 },
};
const rowOf = (i) => { const h = (P.menuCol.y2 - P.menuCol.y) / 3;
                       return { x:P.menuCol.x, y:P.menuCol.y + h * i, x2:P.menuCol.x2, y2:P.menuCol.y + h * (i + 1) }; };
// P3 庭院槽位（id 与 rewards_catalog.json 的 ink.slots 一致）+ 手拭巾晾杆位。
// 🔴 现在全是占位（纸色小牌写名字），真图到了换成 drawImage，坐标不动。
const SLOTS = {
  // 🔴 岸上段水豚占 x 0.50~0.89，槽位必须避开，否则叠加层会画在它身上
  lamp_side:  { x:0.235, y:0.57, x2:0.30, y2:0.62, scale:1.6 },   // 太湖石旁（id 沿用 lamp_side 免得改内核；蒲团旁那块在空闲态压着菜单、休息态压着水豚，两头都不行）
  // 🔴 量母版（_design/anchor_cn/master_v12，见 9-3 pool_edge 网格图）：墙裙 y 0.56~0.585 → 地砖 0.585~0.615 → **池沿石台 0.615~0.64** → 水 0.64 起。
  //    第一版把香炉底边钉 0.652＝已经在水里了（用户抓到）；石台上站东西底边只能在 0.63~0.64。
  pool_edge:  { x:0.13, y:0.58, x2:0.21, y2:0.636 },   // 石台左侧＝池沿石台上（香炉）
  floor_mid:  { x:0.37, y:0.565, x2:0.55, y2:0.618 },  // 地砖中央（茶盘；9-3 用户："太小、再靠中间"→中心 0.46；休息态水豚左缘实测在 0.60，不碰）
  wall:       { x:0.31, y:0.375, x2:0.53, y2:0.44, scale:1.0 },   // 白墙留白（菜单上方）——9-2 用户：太大 → 缩到槽位原尺寸
  water_near: { x:0.12, y:0.84,  x2:0.40, y2:0.93 },   // 近处水面（9-3 用户："荷花和背景荷叶大小差太多"→背景近处荷叶约 0.30 幅宽，荷花组放到同尺度，槽位随之加宽右移）
  // 🔴 挂点坐标是量母版像素得来的（檐底 x0.73~0.76 → y≈0.195~0.21；石顶脊 x0.13 → y≈0.367），别目测
  willow:     { x:0.72, y:0.195, x2:0.77, y2:0.30, top:true, scale:1.0 },   // 檐下：绳头顶进飞檐底边（9-2 用户：挂柳条上挂不住）
};
// 手拭巾（9-2 定案）：题壁字下方、菜单上方的墙面，两根短竹竿（竿画在图里）。
// 第一根＝自己挂的那条，永远在；第二根＝访客来时挂它带来的手信，平时空着不画。
const TOWELS = [ { x:0.28, y:0.445, x2:0.41, y2:0.535, top:true, scale:1.0 },
                 { x:0.43, y:0.445, x2:0.56, y2:0.535, top:true, scale:1.0 } ];
// 9-3 尺度定案：每件占母版幅宽的比例（尺子＝母版里水豚坐的那只蒲团 ≈0.22 幅宽；cushion2 就是从它身上裁的）。
// 没列的（风铃/题壁字/手拭巾）仍按槽位框 contain。🔴 别再回到"槽位框×2.2"——茶盘曾比蒲团还大。
// 🔴 9-3 用户定：石灯、第二只蒲团撤掉（地砖带只有画面高 5.5%，高件没位置；同一只蒲团出现两次像复制粘贴）→ 换香炉、石凳（矮件）
const PROP_W = { orchid:0.085, teatray:0.17, censer:0.075, stool:0.09, koi:0.15, lotus:0.17 };   // 荷花只留花（小荷叶/莲蓬已删），0.17＝与背景近处荷叶同尺度
const WATER = { koi:1 };              // 水里的：不画接地影，压水色 + 半分辨率柔边（"像在空中"病根＝纯不透明锐边）
const FLAT  = { tibi:1, lotus:1 };    // 题在墙上的字 / 浮在水面的荷花：原样画，不画影不叠色（9-3 用户：荷花压了水色反而"变成水下了"）

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
  entries: { start:rowOf(0), settings:rowOf(1), stats:rowOf(2) },

  ink: '#3e3226', seal: '汤', sealBg: '#b2382a',
  dim: { idle:0, work:0.08, break:0, awaiting:0, done:0, paused:0.34 },

  // ── 叠加层：题壁横排倒计时+朱印+当班小字（运行），菜单一行（空闲）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;

    // P3：摆好的小物 + 挂着的手拭巾（静态景物，所有状态都在——它们不是进度，不违红线一）
    const RW = window.RW, rv = RW && RW.view;
    if (rv && rv.state) {
      // 真图：assets/p3/ink/<id>.png（RGBA，长边 512，抠图 _design/p3_cn/_cut2.py）。图加载失败才画纸牌占位。
      // 🔴 9-3 合成规矩（用户"一看就是贴图、很不和谐"后定）：
      //   ① 尺寸按 PROP_W 定占幅宽比例，不按槽位框放大；底边对齐地面/水面，挂着的顶边对齐
      //   ② 站地上的画椭圆接地影；挂着的画偏移软影（也把米白手巾从米白墙上"托"出来）；水里的压水色、半分辨率柔边、不画影
      //   ③ 站/挂的都轻叠一层黄昏暖色（和视频同一光）
      //   ④ 这一帧要画的一组图没全加载完就一张都不画（冷启不许一件件蹦）；按底边 y 排序，近的盖远的
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
      // 目录里所有图首帧就开始预载（进沐录/摆件时才不会白等）
      if (!S._pre && rv.catalog) {
        S._pre = true;
        (rv.catalog.props || []).forEach((p) => img(p.id));
        (rv.catalog.towels || []).forEach((t) => img(t.id));
      }
      const off = (w, h) => { const k = document.createElement('canvas'); k.width = Math.max(1, w | 0); k.height = Math.max(1, h | 0); return k; };
      // 精灵缓存（一张图各做一次，整场复用）：warm=暖色版 / water=水色半分辨率版 / shadow=深色剪影 1/8 分辨率（放大画＝廉价模糊；
      // 🔴 不用 ctx.filter='blur()'，WKWebView 支持不稳）
      const sprite = (im, kind) => {
        const c = im._spr || (im._spr = {});
        if (c[kind]) return c[kind];
        let k;
        if (kind === 'shadow') {
          k = off(im.width / 8, im.height / 8); const g = k.getContext('2d');
          g.drawImage(im, 0, 0, k.width, k.height);
          g.globalCompositeOperation = 'source-in'; g.fillStyle = '#2b1d10'; g.fillRect(0, 0, k.width, k.height);
        } else {
          const half = kind === 'water';
          k = off(im.width / (half ? 2 : 1), im.height / (half ? 2 : 1)); const g = k.getContext('2d');
          g.drawImage(im, 0, 0, k.width, k.height);
          g.globalCompositeOperation = 'source-atop';
          g.fillStyle = half ? 'rgba(122,168,160,0.40)' : 'rgba(214,168,110,0.10)';
          g.fillRect(0, 0, k.width, k.height);
        }
        return (c[kind] = k);
      };
      const FW = E.map(1, 0)[0] - E.map(0, 0)[0];   // 母版幅宽在画布上的像素数
      const jobs = [];
      const pic = (r, id, name) => {
        const im = img(id);
        jobs.push({ r, id, name, im, y: r.top ? r.y : r.y2 });
      };
      // 锦鲤微动画（9-4 用户："有没有可能做成微动画，感觉在游动"）：图里两条鱼头尾相反、但都躺在同一条 ↘ 斜轴上，
      // 所以：①把水色精灵按 -θ 转正存一张离屏（一次）②每帧沿鱼身轴切 14 条、按行波做正弦错位＝尾摆（两头摆得大、中段小）
      // ③整体加几像素慢漂 + ±2.5° 微转。不画涟漪（容易假）。draw() 在有角色通道的段跟视频帧走 24fps，所以顺滑不额外花电。
      const KOI_AXIS = 0.66;   // 鱼身轴相对图片 x 轴的夹角（量图：尾 (60,60)→头 (400,330) ≈ 38°）
      const paintKoi = (im, c, x, y, w, h) => {
        const sp = sprite(im, 'water');
        let rot = im._koiRot;
        if (!rot) {
          const D = Math.ceil(Math.hypot(sp.width, sp.height));
          rot = im._koiRot = off(D, D); const g = rot.getContext('2d');
          g.translate(D / 2, D / 2); g.rotate(-KOI_AXIS); g.drawImage(sp, -sp.width / 2, -sp.height / 2);
        }
        const t = performance.now() / 1000, D = rot.width, N = 14, sw = D / N;
        const k = w / sp.width;                       // 精灵 → 画布的缩放
        const dx = w * 0.05 * Math.sin(t * 2 * Math.PI / 13), dy = h * 0.03 * Math.sin(t * 2 * Math.PI / 9 + 1);
        c.save(); c.globalAlpha = 0.93;
        c.translate(x + w / 2 + dx, y + h / 2 + dy);
        c.rotate(KOI_AXIS + 0.045 * Math.sin(t * 2 * Math.PI / 17));   // 离屏是按 -θ 转正的，这里转回去＝原朝向
        c.scale(k, k);
        for (let i = 0; i < N; i++) {
          const u = (i + 0.5) / N;                                     // 0..1 沿鱼身轴
          const amp = D * 0.012 * (0.5 + Math.abs(u - 0.5) * 1.6);      // 两头（尾巴）摆得大，中段小
          const off_y = amp * Math.sin(t * 2 * Math.PI * 1.1 - u * 2 * Math.PI * 0.9);
          const cw = Math.min(sw + 1, D - i * sw);                     // 多切 1px 盖住条与条之间的缝
          c.drawImage(rot, i * sw, 0, cw, D, -D / 2 + i * sw, -D / 2 + off_y, cw, D);
        }
        c.restore();
      };
      const paint = (j, c) => {          // c＝画到哪块画布（有角色通道时是离屏）
        const im = j.im, r = j.r, R = E.rect(r);
        let w, h;
        if (PROP_W[j.id]) { w = PROP_W[j.id] * FW; h = w * im.height / im.width; }
        else { const s = Math.min((R.w * (r.scale || 1)) / im.width, (R.h * (r.scale || 1)) / im.height); w = im.width * s; h = im.height * s; }
        const x = R.x + (R.w - w) / 2, y = r.top ? R.y : R.y + R.h - h;
        if (j.id === 'koi') {
          paintKoi(im, c, x, y, w, h);
        } else if (WATER[j.id]) {
          c.globalAlpha = 0.93; c.drawImage(sprite(im, 'water'), x, y, w, h); c.globalAlpha = 1;
        } else if (FLAT[j.id]) {
          c.drawImage(im, x, y, w, h);
        } else if (r.top) {
          c.globalAlpha = 0.26; c.drawImage(sprite(im, 'shadow'), x + w * 0.05, y + h * 0.035, w, h); c.globalAlpha = 1;
          c.drawImage(sprite(im, 'warm'), x, y, w, h);
        } else {
          const cxm = x + w / 2, cym = y + h - h * 0.02, rx = w * 0.52, ry = Math.max(3, w * 0.11);
          const g = c.createRadialGradient(cxm, cym, 0, cxm, cym, rx);
          g.addColorStop(0, 'rgba(60,40,22,0.34)'); g.addColorStop(0.55, 'rgba(60,40,22,0.16)'); g.addColorStop(1, 'rgba(60,40,22,0)');
          c.save(); c.translate(cxm, cym); c.scale(1, ry / rx); c.translate(-cxm, -cym);
          c.fillStyle = g; c.beginPath(); c.arc(cxm, cym, rx, 0, Math.PI * 2); c.fill(); c.restore();
          c.drawImage(sprite(im, 'warm'), x, y, w, h);
        }
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
        if (p && SLOTS[slot]) pic(SLOTS[slot], p.id, p.name);
      }
      if (rv.state.hung) {
        const t = RW.cat('towels', rv.state.hung);
        if (t) pic(TOWELS[0], t.id, t.name);
      }
      if (rv.state.guest_towel) {          // 访客带来的手信（访客线接上后由内核写入）
        const t = RW.cat('towels', rv.state.guest_towel);
        if (t) pic(TOWELS[1], t.id, t.name);
      }
      if (!jobs.some((j) => !j.im.ok && !j.im.failed)) {   // 全到齐才画（失败的画纸牌）
        jobs.sort((a, b) => a.y - b.y);
        if (E.hasMatte()) {
          // 角色通道（9-3 根治）：小物先画离屏，按当前视频帧挖掉水豚，再贴上——小物永远在水豚后面
          const pc = S._pc || (S._pc = document.createElement('canvas'));
          if (pc.width !== E.W || pc.height !== E.H) { pc.width = E.W; pc.height = E.H; }
          const pcx = pc.getContext('2d'); pcx.clearRect(0, 0, E.W, E.H);
          for (const j of jobs) { if (j.im.failed) tag(j.r, j.name); else paint(j, pcx); }
          E.matteCut(pcx);
          cx.drawImage(pc, 0, 0);
        } else {
          for (const j of jobs) { if (j.im.failed) tag(j.r, j.name); else paint(j, cx); }
        }
      }
    }

    if (ph === 'idle') {
      // 菜单：右侧墙面竖排一列三词（题壁式毛笔字，不垫底衬——墙面留白本身就是底；每词下一道淡墨短线提示可点）
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      for (let i = 0; i < S.menu.length; i++) {
        const R = E.rect(rowOf(i)), cxm = R.x + R.w / 2, cym = R.y + R.h / 2;
        const lab = window.I18N ? I18N.t(S.menu[i].label) : S.menu[i].label;   // 英文：Soak / Tune / Log
        // 🔴 字号受列宽约束（列只有 5.5% 幅宽）：中文两字上下叠；英文横写、按字数缩
        const fs = Math.round(Math.min(R.w * 0.62, R.h * 0.42));
        cx.fillStyle = S.ink;
        if (/[一-鿿]/.test(lab)) {
          cx.font = fs + 'px ' + BRUSH;
          for (let c = 0; c < lab.length; c++) cx.fillText(lab[c], cxm, cym + (c - (lab.length - 1) / 2) * fs * 1.1);
        } else {
          const fe = Math.round(Math.min(fs * 0.8, R.w * 1.9 / Math.max(3, lab.length)));
          cx.font = fe + 'px ' + BRUSH;
          cx.fillText(lab, cxm, cym);
        }
        cx.fillStyle = 'rgba(62,50,38,0.28)';
        cx.fillRect(cxm - fs * 0.5, R.y + R.h - fs * 0.22, fs, Math.max(2, fs * 0.05));
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
