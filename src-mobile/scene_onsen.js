// 场景包 · 山中野天风吕 —— 整场视频状态机版（8-30 架构定案后重写）
// Full, locked-camera shots share a low stone landing and a clear foreground pool.
(function () {
'use strict';

// Layout uses the original pool coordinates. The taller cut gives the board
// a 294-pixel writing face above the unchanged towel rail and waterline.
const board={x:.092,y:(530-256)/1280,x2:.374,y2:(824-256)/1280};
const row=i=>({...board,y:board.y+(board.y2-board.y)*i/3,y2:board.y+(board.y2-board.y)*(i+1)/3});
const P={board,row1:row(0),row2:row(1),row3:row(2),cart:{x:.759,y:-.075,x2:.887,y2:.081}};
const tray=[.745,.84,.173];
window.SCENES = window.SCENES || {};
window.SCENES.onsen = {
  id: 'onsen',
  readVideoPixels: true,
  name: '山中野天风吕',
  fit:'cover', frame:[720,1280], frameTop:256, alignY:.72,
  poster: 'assets/onsen-spring/soak.webp',
  hint: '轻点木牌上的「开始」「设置」或「记录」',
  assets: {bundled:true,mattes:true,base:'onsen-spring-v2',dir:'assets/onsen-spring',
            names: ['loop_soak','loop_work','loop_tea','loop_eat',
                    'loop_urge','loop_empty','t_a_swim','t_b_swim'] },

  // Each loop and its adjoining action share the same camera and anchor poses.
  loops: {
    idle:  'loop_soak',         // 闭眼泡着打盹（拜访概念：你没来它也在过日子）
    work:  'loop_work',         // 睁眼安静陪你泡
    shortBreak: 'loop_tea',     // 岸上捧茶小口抿
    longBreak:  'loop_eat',
    awaiting:   'loop_urge',    // 在水里朝你招手
    done:  'loop_empty',        // 人去汤空
    // paused：不换段——当前视频停格 + 调光（引擎处理）
  },
  // 池内状态（从这些状态去休息时，先播"游到池边"再雾转场）
  poolStates: ['idle', 'work', 'awaiting'],
  swimOut: 't_a_swim',
  // The return starts at the tea landing and ends at the work loop's waterline.
  swimIn: 't_b_swim',

  // 木牌功能菜单（空闲时画；毛笔字=马善政楷 OFL 子集，倾角跟牌走，量自 kf_k1）
  board: { ...P.board, tiltDeg:0, ink:'#3a2112',
           menu: [ { key:'start',    label:'开始' },
                   { key:'settings', label:'设置' },
                   { key:'stats',    label:'记录' } ] },
  // 倒计时题字框：右上天空竖排，纸色+朱边+「汤」印（浮世绘题字的母语，不是 UI 贴片）
  cart: { ...P.cart, paper:'229,216,189', border:'129,97,68', ink:'#302724',
          seal:'汤', sealBg:'#984735' },
  entries: { start:P.row1, settings:P.row2, stats:P.row3 },

  // 状态调光（视频自带黄昏光，这里只做轻叠加）：paused 最暗，work 微暗
  dim: { idle:0, work:0.10, break:0, awaiting:0, done:0, paused:0.34 },

  // 各摆件共用主景坐标，水面花瓣和酒盘的倒影随波变化。
  // 🔴 整层先画离屏，再按角色通道挖掉水豚（E.matteCut）——樱花漂满池面，不挖就压在水豚身上。
  // 🔴 花瓣漂移只能来回摆（样片是 5 秒的线性漂移，App 常开会漂出池子）。
  waterObstacle() {
    if (window.RW?.theme !== 'onsen' || window.RW?.view?.state?.placed?.water_near !== 'float') return null;
    const [x,y,w]=tray;
    const h=w*(this._imgs?.float?.naturalHeight/this._imgs?.float?.naturalWidth || .84)*9/16;
    return {x,y:y+h*.27,rx:w*.52+.008,ry:h*.25+.006};
  },
  drawGarden(E, cx, toy = null) {
    const S = this, RW = window.RW, rv = RW && RW.view;
    if (!rv || !rv.state || !rv.catalog) return;
    // A cold start may display the poster before the matching actor mask is decoded.
    if (E.seg !== S.loops.done && (!E.cur()?.videoWidth || !E.matteFrame())) return;
    const DIR = 'assets/p3/onsen/';
    const img = (n) => {
      const c = S._imgs || (S._imgs = {});
      if (!(n in c)) { const im = new Image(); c[n] = im; im.ok = false;
        im.onload = () => { im.ok = true; E.draw && E.draw(); }; im.onerror = () => { im.failed = true; }; im.src = DIR + n + '.png'; }
      return c[n];
    };
    if (!S._sak && !S._sakLoading) {
      S._sakLoading = true;
      fetch(DIR + 'sakura.json').then((r) => r.json()).then((j) => { S._sak = j; E.draw && E.draw(); }).catch(() => {});
    }
    const placed = rv.state.placed || {};
    const hung = rv.state.hung && RW.cat('towels', rv.state.hung);
    // 🔴 手机 cover 左右各裁 ~9%（横向安全区 0.10~0.90）：巾子原放 0.115 只露一半、木屐 0.93 整个被裁 → 挪进安全区
    const SPOT={rock:[.085,.812],lamp_base:[.832,.562],wall_top:[.499,.558]};
    const W_OF={oke:.102,milk:.042,geta:.08,kokedama:.082,usagi:.056};
    const statics=[];
    ['rock', 'lamp_base', 'wall_top'].forEach((sl) => { if (placed[sl]) statics.push({ id: placed[sl], at: SPOT[sl], fw: W_OF[placed[sl]] || 0.06 }); });
    const hasFloat = placed.water_near === 'float', hasSak = placed.sakura === 'sakura' && S._sak;
    const need = statics.map((s) => img(s.id));
    if (hasFloat) need.push(img('float'));
    const PN = (S._sak && S._sak.petals) || 0;
    if (hasSak) for (let i = 0; i < PN; i++) need.push(img('petal_water_' + i), img('petal_land_' + i));
    if ((!hung && !need.length) || need.some((im) => !im.ok && !im.failed)) return;     // 冷启不许一件件蹦
    const FW = E.map(1, 0)[0] - E.map(0, 0)[0], kk = FW / 1088;                // 素材像素量自 1088 宽画幅
    const now = toy ? toy.now : performance.now() / 1000;
    const dt = Math.max(0, Math.min(.1, now - (S._gardenTick ?? now)));
    S._gardenTime = (S._gardenTime || 0) + (E.running && !E.frozen ? dt : 0);
    S._gardenTick = now;
    const t = S._gardenTime;
    const front = toy && toy.pass === 'front';
    if (front && !hasFloat) return;
    const pc = E.hasMatte() ? (S._pc || (S._pc = document.createElement('canvas'))) : null;
    if (pc && (pc.width !== E.W || pc.height !== E.H)) { pc.width = E.W; pc.height = E.H; }
    const c = pc ? pc.getContext('2d') : cx;
    if (pc) c.clearRect(0, 0, E.W, E.H);
    const persp = (y) => Math.max(0.45, Math.min(1.15, 0.45 + (y - 0.55) / 0.38 * 0.7));   // 远小近大
    const LAMPX = 0.82;
    if(!front && hung) {
      const [x,y]=E.map(.112,.474);
      YardArt.drawOnsenCloth(c,hung.id,t,x,y,FW/810);
    }
    // ① 岸上花瓣（静）：躺平＝按地面透视压扁
    if (!front && hasSak) for (const [x, y, r0, sd] of S._sak.land) {
      const im = img('petal_land_' + (sd % PN)); if (!im.ok) continue;
      const [px, py] = E.map(x, y), k = persp(y) * 1.05 * kk;
      c.save(); c.translate(px, py); c.scale(k, k * 0.5); c.rotate(r0 * Math.PI / 180);
      c.drawImage(im, -im.width / 2, -im.height / 2); c.restore();
    }
    // ② 静物：落影背离灯笼 + 贴地接触线，按底边 y 排序（近的盖远的）
    statics.sort((a, b) => a.at[1] - b.at[1]);
    for (const s of front ? [] : statics) {
      const im = img(s.id); if (!im.ok) continue;
      const [px, py] = E.map(s.at[0], s.at[1]), w = s.fw * FW, h = w * im.height / im.width;
      const lx = s.at[0] < LAMPX ? -w * 0.2 : w * 0.2;
      const shadow = (cxm, cym, rx, ry, a) => {
        const g = c.createRadialGradient(cxm, cym, 0, cxm, cym, rx);
        g.addColorStop(0, 'rgba(22,16,20,' + a + ')'); g.addColorStop(0.6, 'rgba(22,16,20,' + (a * 0.45) + ')'); g.addColorStop(1, 'rgba(22,16,20,0)');
        c.save(); c.translate(cxm, cym); c.scale(1, ry / rx); c.translate(-cxm, -cym);
        c.fillStyle = g; c.beginPath(); c.arc(cxm, cym, rx, 0, Math.PI * 2); c.fill(); c.restore();
      };
      shadow(px + lx * 0.5, py - h * 0.015, w * 0.62, Math.max(3, h * 0.09), 0.5);
      shadow(px, py - h * 0.008, w * 0.44, Math.max(2, h * 0.03), 0.6);
      c.save(); c.translate(px, py - h / 2); if (s.tilt) c.rotate(s.tilt * Math.PI / 180);
      c.drawImage(im, -w / 2, -h / 2, w, h); c.restore();
    }
    // ③ 水面花瓣（漂）：各自慢漂慢转、不同步；湿的效果已预做进 petal_water_*
    if (!front && hasSak) for (const [x, y, r0, sd] of S._sak.water) {
      const im = img('petal_water_' + (sd % PN)); if (!im.ok) continue;
      const per = 7 + sd % 6, k = persp(y) * 1.3 * kk;
      const [bx, by] = E.map(x, y);
      const px = bx + kk * (5 * Math.sin(2 * Math.PI * t / (8 + sd % 5) + sd) + 12 * Math.sin(2 * Math.PI * t / (40 + sd % 20) + sd * 0.7));
      const py = by + kk * 1.5 * Math.sin(2 * Math.PI * t / (5 + sd % 4) + sd);
      const swell = Math.sin(t * 1.65 + x * 10 + y * 18);
      c.save(); c.translate(px, py); c.scale(k * (sd % 2 ? -1 : 1), k * (.44 + .08*swell));
      c.globalAlpha = .82 + .13*swell;
      c.rotate((r0 + 20 * Math.sin(2 * Math.PI * t / per + sd)) * Math.PI / 180);
      c.drawImage(im, -im.width / 2, -im.height / 2); c.restore();
    }
    // ④ 浮盘：慢起伏 + 微晃 + 慢漂；倒影、断续涟漪、水汽（参数同 9-25 认可的样片）
    if (hasFloat) {
      const im = img('float');
      const [fx, fy, fwid] = tray;
      const [cxp, cyp] = E.map(fx, fy), w = fwid * FW, h = w * im.height / im.width;
      const dx = 3 * kk * Math.sin(2 * Math.PI * t / 9), dy = 1.6 * kk * Math.sin(2 * Math.PI * t / 3.7), rot = 1.1 * Math.sin(2 * Math.PI * t / 5.3);
      const bot = cyp + dy + h * 0.43;
      // Compare water-contact depth, not the centre of the tray artwork.
      const trayDepth = (bot - E.map(0, 0)[1]) / (E.map(0, 1)[1] - E.map(0, 0)[1]);
      const trayInFront = toy && toy.depth < trayDepth;
      if (!front) {
      c.save(); c.strokeStyle = 'rgba(210,228,224,0.31)'; c.lineCap = 'round';
      const w2 = w * 1.12 / 2, h2 = w * 1.12 * 0.19;
      [[200, 250, 2], [275, 330, 3], [25, 70, 2], [115, 160, 3]].forEach(([a0, a1, lw]) => {
        c.lineWidth = lw * kk; c.beginPath();
        c.ellipse(cxp + dx, bot + h2 * 0.05, w2, h2 * 0.9, 0, a0 * Math.PI / 180, a1 * Math.PI / 180); c.stroke();
      });
      c.restore();
      // Broken bands reflect the actual tray against the moving spring.
      c.save();c.translate(cxp+dx,bot);c.rotate(rot*Math.PI/180);
      for(let row=0;row<18;row++){
        c.globalAlpha=.18*(1-row/18);
        const sy=im.height*(.91-row*.047);
        c.drawImage(im,0,sy,im.width,im.height*.044,-w/2+kk*1.8*Math.sin(t*2.2+row*.8),row*h*.014,w,h*.009);
      }
      c.restore();
      }
      if (!toy || !!front === !!trayInFront) {
      c.save(); c.translate(cxp + dx, cyp + dy); c.rotate(rot * Math.PI / 180);
      c.beginPath(); c.moveTo(-w/2,-h/2); c.lineTo(w/2,-h/2);
      for(let i=24;i>=0;i--){
        const u=i/24;
        c.lineTo((u-.5)*w,h*(.476+.008*Math.sin(t*1.8+u*12)));
      }
      c.closePath();c.clip();c.drawImage(im, -w / 2, -h / 2, w, h); c.restore();
      }
    }
    if (pc) { E.matteCut(c); cx.drawImage(pc, 0, 0); }
  },

  // ── 叠加层绘制（9-1 从引擎搬回家：日系=功能上牌+当班牌+天空题字框竖排）──
  drawUI(E, cx, v) {
    const S = this, ph = E.phase, BRUSH = E.brush;
    if (!window.WaterToys?.composesGarden?.('onsen')) S.drawGarden(E, cx);
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
        cx.font = '600 ' + Math.round(rh * .53) + 'px ' + BRUSH;
        cx.lineWidth = Math.max(E.DPR, B.w * .009);
        for (let i = 0; i < rows.length; i++) {
          const y = (i - 1) * rh;
          cx.fillStyle = S.board.ink;
          cx.fillText(window.I18N ? I18N.t(rows[i].label) : rows[i].label, -B.w*.035, y, B.w*.77);
          cx.strokeStyle = '#663b24';
          cx.beginPath(); cx.moveTo(B.w*.38,y-rh*.075); cx.lineTo(B.w*.42,y); cx.lineTo(B.w*.38,y+rh*.075); cx.stroke();
          if (i < rows.length-1) {
            cx.strokeStyle = 'rgba(83,44,20,.36)';
            cx.beginPath(); cx.moveTo(-B.w*.44,y+rh/2); cx.lineTo(B.w*.44,y+rh/2); cx.stroke();
          }
        }
      } else if (ph === 'work' || ph === 'break' || ph === 'paused') {
        const st = (v && v.stages) || [], idx = (v && v.idx) || 0;
        let label;
        const EN = window.I18N && I18N.lang === 'en';   // 9-2 双语：画布上的字场景包自己选词
        if (ph === 'paused') label = EN ? 'Paused' : '休 止';
        else if (ph === 'break') label = EN ? 'Rest' : '小 憩';
        else {
          const CN = ['一','二','三','四','五','六','七','八','九','十'];
          const n = st.slice(0, idx + 1).filter((s) => s.kind !== 'break').length;
          const cn = n <= 10 ? CN[n - 1] : (n < 20 ? '十' + CN[n - 11] : String(n));
          label = EN ? ('Soak ' + n) : ('第' + cn + '泡');
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
      C.y = Math.max(C.y, Math.min(E.H*.08,60*E.DPR));
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
