// 水豚陪伴舞台（替代旧 viz.js 燃烧番茄）：主窗口可视化 = 它 + 烛钟 + 木牌。
// 资产：即梦图生视频 → 逐帧抠图精灵图（12fps 往返循环）；4 个仪式帧暂为静态图（额度补齐后换）。
// 职责：只画。计时真相在内核；app.js 每次拿到快照就 Companion.set(view)，
// 这里自己检测状态跳变来触发仪式动画（点烛/道别/吹烛/离场）。
window.Companion = (function () {
  // —— 精灵图元数据（420 格 / 8 列 / 12fps）——
  const VM = {
    v_idle_breath:{frames:61,x0:74,y0:99,x1:350,y1:365}, v_typing:{frames:61,x0:24,y0:104,x1:379,y1:365},
    v_reading:{frames:61,x0:72,y0:98,x1:349,y1:365}, v_doze:{frames:61,x0:74,y0:98,x1:349,y1:365},
    v_writing:{frames:61,x0:65,y0:93,x1:362,y1:364}, v_tea:{frames:61,x0:92,y0:93,x1:349,y1:365},
    v_stretch:{frames:61,x0:71,y0:67,x1:328,y1:379}, v_onsen:{frames:61,x0:58,y0:60,x1:365,y1:368},
    v_eat:{frames:61,x0:70,y0:96,x1:349,y1:365}, v_pause:{frames:61,x0:86,y0:100,x1:349,y1:365},
    v_urge:{frames:61,x0:51,y0:92,x1:357,y1:369},
  };
  const SM = {   // 静态兜底（仪式帧，1024 源图 bbox）
    pose_light2:{x0:109,y0:223,x1:865,y1:880}, pose_blow2:{x0:192,y0:246,x1:851,y1:885},
    pose_wave:{x0:203,y0:218,x1:839,y1:879}, pose_leave:{x0:306,y0:236,x1:754,y1:886},
  };
  const CELL = 420, COLS = 8, FPS = 12;
  const SHEETS = {}, SIMGS = {};
  for (const n in VM) { const im = new Image(); im.src = 'assets/capy/' + n + '.webp'; SHEETS[n] = im; }
  for (const n in SM) { const im = new Image(); im.src = 'assets/capy/' + n + '.png'; SIMGS[n] = im; }

  let cv, ctx, W = 0, H = 0, dpr = 1;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // —— 输入快照（app.js 喂）——
  let V = { status: 'idle', stages: [], idx: 0, end_ms: 0, remaining_ms: 0, activity: '' };
  let idleSecs = 25 * 60;      // 空闲时木牌显示的首段时长

  // —— 内部演出状态机 ——
  // phase: idle summon work restS restL pause awaiting wave blow leave
  let phase = 'idle', phaseT = 0, prevStatus = 'idle', restClip = 'v_onsen';
  let cur = '', prev = '', fadeT = 1, clipT = 0, charX = 0, slideX = 0;
  let dozeT = 0, dozing = false;
  const parts = [];
  let t = 0, last = 0;

  function stageKind(v) { return (v.stages[v.idx] || {}).kind || ''; }
  function enter(p) {
    phase = p; phaseT = 0;
    if (p === 'restS') restClip = Math.random() < 0.5 ? 'v_tea' : 'v_stretch';
    if (p === 'restL') restClip = Math.random() < 0.5 ? 'v_onsen' : 'v_eat';
  }
  function restPhaseFor(v) { return (v.stages[v.idx] && v.stages[v.idx].secs <= 420) ? 'restS' : 'restL'; }

  // 状态跳变 → 演出切换（仪式动画只在跳变瞬间触发）
  function onView(v) {
    const st = v.status;
    const active = ['running', 'paused', 'awaiting'].includes(st);
    if (st !== prevStatus || (st === 'running' && phase !== 'summon')) {
      if ((prevStatus === 'idle' || prevStatus === 'done') && st === 'running') enter('summon');
      else if (st === 'done' && ['work','restS','restL','pause','awaiting','summon'].includes(phase)) enter('wave');
      else if (st === 'idle' && ['work','restS','restL','pause','awaiting'].includes(phase)) enter('blow');
      else if (st === 'running' && !['summon','wave','blow','leave'].includes(phase)) {
        const want = stageKind(v) === 'break' ? restPhaseFor(v) : 'work';
        if (phase !== want && !(phase === 'restS' && want === 'restS') && !(phase === 'restL' && want === 'restL')) enter(want);
      }
      else if (st === 'paused' && !['wave','blow','leave'].includes(phase)) { if (phase !== 'pause') enter('pause'); }
      else if (st === 'awaiting' && phase !== 'awaiting' && !['wave','blow','leave'].includes(phase)) enter('awaiting');
      else if (st === 'idle' && !['blow','leave'].includes(phase)) { phase = 'idle'; cur = prev = ''; }
    } else if (st === 'running' && !['summon','wave','blow','leave'].includes(phase)) {
      // 同为 running 但段可能换了（工作↔休息）
      const want = stageKind(v) === 'break' ? restPhaseFor(v) : 'work';
      if ((want === 'work') !== (phase === 'work')) enter(want);
    }
    prevStatus = st;
    V = v;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  function spawn(p) { if (parts.length < 100) parts.push(p); }
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60); };

  // 烛钟：蜡烛长度 = 本轮会话剩余工作量 / 工作总量
  function candleFraction(v) {
    if (!v.stages || !v.stages.length) return 1;
    let total = 0, remain = 0;
    v.stages.forEach((s, i) => {
      if (s.kind !== 'work') return;
      total += s.secs;
      if (i > v.idx) remain += s.secs;
      else if (i === v.idx) {
        const ms = v.status === 'running' ? Math.max(0, v.end_ms - Date.now()) : v.remaining_ms;
        remain += (['running','paused'].includes(v.status)) ? ms / 1000 : (v.status === 'awaiting' ? 0 : s.secs);
      }
    });
    return total > 0 ? remain / total : 1;
  }
  function plateText() {
    if (phase === 'idle' || phase === 'leave') return fmt(idleSecs * 1000);
    if (V.status === 'running') return fmt(Math.max(0, V.end_ms - Date.now()));
    if (V.status === 'paused') return fmt(V.remaining_ms);
    if (V.status === 'awaiting') { const nx = V.stages[V.idx + 1]; return nx ? fmt(nx.secs * 1000) : '00:00'; }
    return '';
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = ts; return; }  // 隐藏停画，计时在内核不受影响
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016); last = ts;
    t += dt; phaseT += dt; clipT += dt;
    if (fadeT < 1) fadeT = Math.min(1, fadeT + dt / 0.3);

    const k = Math.max(0.6, Math.min(1.5, Math.min(W / 440, H / 620)));  // 布局缩放
    const VS = 0.731 * k, SS = 0.30 * k;
    const tableY = H - Math.max(80, 118 * k);
    const candleX = W * 0.30, ANCHOR = W * 0.62, ANCHOR_SUMMON = candleX + 136 * k;

    // 演出推进
    if (phase === 'summon' && phaseT > 2.3) enter(stageKind(V) === 'break' ? restPhaseFor(V) : 'work');
    if (phase === 'wave' && phaseT > 1.2) enter('blow');
    if (phase === 'blow' && phaseT > 1.0) enter('leave');
    if (phase === 'leave' && phaseT > 1.4) { phase = V.status === 'done' ? 'done' : 'idle'; cur = prev = ''; }
    if (phase === 'work') {
      dozeT += dt;
      if (!dozing && dozeT > 25) { dozing = true; dozeT = 0; }
      else if (dozing && dozeT > 7) { dozing = false; dozeT = 0; }
    }
    const targetX = phase === 'summon' ? ANCHOR_SUMMON : ANCHOR;
    if (!charX) charX = targetX;
    charX += (targetX - charX) * Math.min(1, dt * 5);

    // 当前姿态
    const act = V.activity || 'idle';
    const setPose = (n) => { if (n !== cur) { prev = cur; cur = n; fadeT = 0; clipT = 0; } };
    if (phase === 'idle' || phase === 'done') { cur = prev = ''; }
    else if (phase === 'summon') setPose('pose_light2');
    else if (phase === 'work') setPose(act === 'idle' ? (dozing ? 'v_doze' : 'v_idle_breath') : ('v_' + act));
    else if (phase === 'restS' || phase === 'restL') setPose(restClip);
    else if (phase === 'pause') setPose('v_pause');
    else if (phase === 'awaiting') setPose('v_urge');
    else if (phase === 'wave') setPose('pose_wave');
    else if (phase === 'blow') setPose('pose_blow2');
    else if (phase === 'leave') setPose('pose_leave');

    slideX = phase === 'summon' ? Math.pow(1 - Math.min(1, phaseT / 0.8), 2) * 240 * k
           : phase === 'leave' ? Math.pow(phaseT / 1.4, 1.5) * 300 * k : 0;

    // —— 背景 / 桌面 ——
    ctx.clearRect(0, 0, W, H);
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c1613'); bg.addColorStop(0.7, '#241b13'); bg.addColorStop(1, '#2a1f15');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4b3826'; ctx.fillRect(0, tableY, W, H - tableY);
    ctx.fillStyle = '#5a4530'; ctx.fillRect(0, tableY, W, 12 * k);

    // —— 烛钟（长度=剩余工作量；只在工作段燃烧；带刻度环）——
    const frac = candleFraction(V);
    const CANDLE_MIN = 42 * k, CANDLE_FULL = 150 * k;
    const candleH = CANDLE_MIN + (CANDLE_FULL - CANDLE_MIN) * frac;
    const w = 32 * k, top = tableY - candleH;
    const litPhases = ['summon', 'work', 'pause', 'wave', 'blow'];
    const flameLit = litPhases.includes(phase) &&
      !(phase === 'summon' && phaseT < 1.32) &&
      !(phase === 'blow' && phaseT > 0.45);
    ctx.fillStyle = '#5f4b34';
    ctx.beginPath(); ctx.ellipse(candleX, tableY + 4 * k, 48 * k, 9 * k, 0, 0, Math.PI * 2); ctx.fill();
    const wg = ctx.createLinearGradient(candleX - w / 2, 0, candleX + w / 2, 0);
    wg.addColorStop(0, '#e8ddc8'); wg.addColorStop(.5, '#fdf6e3'); wg.addColorStop(1, '#cfc0a4');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(candleX - w / 2, tableY); ctx.lineTo(candleX - w / 2, top + 5 * k);
    ctx.quadraticCurveTo(candleX - w / 2, top, candleX - w / 2 + 7 * k, top);
    ctx.lineTo(candleX + w / 2 - 5 * k, top + 2 * k);
    ctx.quadraticCurveTo(candleX + w / 2, top + 3 * k, candleX + w / 2, top + 8 * k);
    ctx.lineTo(candleX + w / 2, tableY); ctx.closePath(); ctx.fill();
    // 刻度环（烛钟的钟面）
    ctx.strokeStyle = 'rgba(140,115,80,.4)'; ctx.lineWidth = 1.2;
    const fullSpan = CANDLE_FULL - CANDLE_MIN;
    for (let i = 1; i <= 4; i++) {
      const ry = tableY - CANDLE_MIN - fullSpan * (i / 5);
      if (ry > top + 8 * k) {
        ctx.beginPath(); ctx.moveTo(candleX - w / 2 + 2, ry);
        ctx.quadraticCurveTo(candleX, ry + 2.5 * k, candleX + w / 2 - 2, ry); ctx.stroke();
      }
    }
    ctx.strokeStyle = '#2a2018'; ctx.lineWidth = 2.4 * k; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(candleX, top); ctx.lineTo(candleX + 1, top - 7 * k); ctx.stroke();
    const fy = top - 7 * k;
    if (flameLit) {
      const paused = phase === 'pause';
      const sway = (paused || reduced) ? 0 : Math.sin(t * 2.4) * 2.4 + Math.sin(t * 7.1) * 1.1;
      const br = (paused || reduced) ? 1 : 1 + Math.sin(t * 3.1) * 0.06;
      const fh = (paused ? 32 : 42) * br * k, fw = 21 * (2 - br) * k;
      const glow = ctx.createRadialGradient(candleX, fy - fh * 0.4, 4, candleX, fy - fh * 0.4, 180 * k);
      glow.addColorStop(0, 'rgba(255,170,60,' + (paused ? 0.16 : 0.28 + Math.sin(t * 3) * 0.04) + ')');
      glow.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(candleX, fy - fh * 0.4, 180 * k, 0, Math.PI * 2); ctx.fill();
      for (const [s, c1, c2] of [[1, '#ff7a1f', '#ff9f3c'], [0.72, '#ffb43a', '#ffd25e'], [0.44, '#ffe9a8', '#fff7dd']]) {
        const hh = fh * s, ww = fw * s, tipX = sway * s * s;
        const g = ctx.createLinearGradient(0, fy, 0, fy - hh);
        g.addColorStop(0, c1); g.addColorStop(1, c2);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(candleX - ww / 2, fy);
        ctx.bezierCurveTo(candleX - ww / 2 - 3, fy - hh * 0.42, candleX + tipX - ww * 0.16, fy - hh * 0.75, candleX + tipX, fy - hh);
        ctx.bezierCurveTo(candleX + tipX + ww * 0.16, fy - hh * 0.75, candleX + ww / 2 + 3, fy - hh * 0.42, candleX + ww / 2, fy);
        ctx.quadraticCurveTo(candleX, fy + 4 * s, candleX - ww / 2, fy);
        ctx.fill();
      }
      if (!paused && !reduced && Math.random() < 0.2) spawn({ k: 'ember', x: candleX + (Math.random() - 0.5) * 8, y: fy - fh * 0.8,
        vx: (Math.random() - 0.5) * 8, vy: -(18 + Math.random() * 22), life: 1, r: (0.8 + Math.random() * 1.3) * k });
    } else if (phase === 'blow' || (phase === 'leave' && phaseT < 0.6)) {
      if (Math.random() < 0.6) spawn({ k: 'smoke', x: candleX + (Math.random() - 0.5) * 6, y: fy,
        vx: (Math.random() - 0.5) * 10 + 8, vy: -(16 + Math.random() * 14), life: 1, r: (2 + Math.random() * 2.5) * k });
    } else if (phase === 'idle' && Math.random() < 0.012) {
      spawn({ k: 'smoke', x: candleX, y: fy, vx: (Math.random() - 0.5) * 4, vy: -10, life: 0.6, r: 1.4 * k });
    }

    // —— 角色 ——
    const drawChar = (name, alpha) => {
      ctx.save(); ctx.globalAlpha = alpha;
      if (VM[name]) {
        const m = VM[name], sheet = SHEETS[name];
        if (sheet.complete && sheet.naturalWidth) {
          const total = m.frames;
          const fi0 = Math.floor(clipT * FPS) % (total * 2 - 2);
          const fi = reduced ? 0 : (fi0 < total ? fi0 : total * 2 - 2 - fi0);  // 往返循环
          const sx = (fi % COLS) * CELL, sy = Math.floor(fi / COLS) * CELL;
          const dx = charX + slideX - ((m.x0 + m.x1) / 2) * VS;
          const dy = tableY + 6 * k - m.y1 * VS;
          ctx.drawImage(sheet, sx, sy, CELL, CELL, dx, dy, CELL * VS, CELL * VS);
        }
      } else if (SM[name]) {
        const m = SM[name], im = SIMGS[name];
        if (im.complete && im.naturalWidth) {
          const bw = (m.x1 - m.x0) * SS, bh = (m.y1 - m.y0) * SS;
          const breathe = reduced ? 1 : 1 + Math.sin(t * 1.2) * 0.011;
          ctx.translate(charX + slideX, tableY + 6 * k);
          ctx.scale(1, breathe);
          ctx.drawImage(im, m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0, -bw / 2, -bh, bw, bh);
        }
      }
      ctx.restore();
    };
    if (cur) {
      if (fadeT < 1 && prev) drawChar(prev, 1 - fadeT);
      drawChar(cur, fadeT < 1 ? fadeT : 1);
      // 点烛仪式：火种从火柴尖跳到烛芯
      if (phase === 'summon' && phaseT >= 1.05 && phaseT < 1.32) {
        const tipX = charX + slideX - 110 * SS / 0.30, tipY = tableY + 6 * k - 157 * SS / 0.30;
        const p = (phaseT - 1.05) / 0.27;
        const sx2 = tipX + (candleX - tipX) * p;
        const sy2 = tipY + (fy - tipY) * p - Math.sin(p * Math.PI) * 12 * k;
        ctx.fillStyle = 'rgba(255,210,110,.95)';
        ctx.beginPath(); ctx.arc(sx2, sy2, (4 + Math.sin(t * 22) * 1.2) * k, 0, Math.PI * 2); ctx.fill();
        if (Math.random() < 0.6) spawn({ k: 'ember', x: sx2, y: sy2, vx: (Math.random() - 0.5) * 14,
          vy: (Math.random() - 0.5) * 10, life: 0.5, r: 1 * k });
      }
      if (flameLit) {  // 烛光暖色打在它身上
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        const warm = ctx.createRadialGradient(candleX, fy, 10, candleX, fy, 320 * k);
        warm.addColorStop(0, 'rgba(255,150,50,' + (0.09 + Math.sin(t * 3) * 0.02) + ')');
        warm.addColorStop(1, 'rgba(255,150,50,0)');
        ctx.fillStyle = warm; ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }
    }
    if (phase === 'idle') {
      ctx.fillStyle = 'rgba(200,180,150,.4)';
      ctx.font = Math.round(13 * k) + 'px "PingFang SC","Microsoft YaHei",sans-serif';
      const msg = '它不在。点燃一支番茄，它就来。';
      ctx.fillText(msg, (W - ctx.measureText(msg).width) / 2, tableY - 14 * k);
    }

    // —— 木牌：精确读数（桌面前沿，当前段剩余 MM:SS）——
    const txt = plateText();
    if (txt) {
      const pw = 86 * k, ph = 34 * k;
      const px = candleX, py = tableY + (H - tableY) * 0.52;
      ctx.save();
      ctx.fillStyle = '#3d2f20';
      ctx.beginPath(); ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, 7 * k); ctx.fill();
      ctx.strokeStyle = 'rgba(190,150,100,.35)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.roundRect(px - pw / 2 + 2.5, py - ph / 2 + 2.5, pw - 5, ph - 5, 5 * k); ctx.stroke();
      const alertNow = V.status === 'running' && (V.end_ms - Date.now()) <= 10_000;
      ctx.fillStyle = alertNow ? '#ffb35c' : (phase === 'pause' ? 'rgba(232,214,180,.5)' : '#e8d6b4');
      ctx.font = '600 ' + Math.round(17 * k) + 'px Georgia,"PingFang SC",serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, px, py + 1);
      ctx.restore(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }

    // —— 粒子 ——
    if (!reduced && Math.random() < 0.04) spawn({ k: 'dust', x: Math.random() * W, y: tableY - Math.random() * H * 0.5,
      vx: (Math.random() - 0.5) * 4, vy: -(3 + Math.random() * 4), life: 1, r: (1 + Math.random() * 1.2) * k });
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.life -= dt * (p.k === 'smoke' ? 0.5 : p.k === 'dust' ? 0.22 : 0.9);
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      if (p.k === 'ember') {
        ctx.fillStyle = 'rgba(255,' + Math.floor(120 + p.life * 100) + ',60,' + p.life * 0.9 + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2); ctx.fill();
      } else if (p.k === 'dust') {
        ctx.fillStyle = 'rgba(255,205,140,' + p.life * 0.15 + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = 'rgba(160,150,140,' + p.life * 0.3 + ')';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (2 - p.life), 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  return {
    init(canvas) {
      cv = canvas; ctx = cv.getContext('2d');
      resize();
      // ⚠️ 只听 window.resize 不够：收起/展开右侧「序列」栏（#layout.collapsed）改的是
      // #vizPane 的宽，窗口没变，resize 事件不发 —— 画布的 CSS 尺寸跟着变了、位图尺寸还是旧的，
      // 浏览器就把旧位图硬拉进新盒子，水豚被横向拉伸。ResizeObserver 盯的是元素自己的盒子。
      if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
      window.addEventListener('resize', resize);  // 拖到另一块屏 dpr 变了、盒子没变，这条才管用
      requestAnimationFrame(frame);
    },
    set(view) { onView(view); },
    setIdleSecs(secs) { idleSecs = secs || 25 * 60; },
  };
})();
