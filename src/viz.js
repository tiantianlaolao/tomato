// 燃烧番茄可视化（规格 4.2）：工作=番茄自上而下燃尽，休息=小苗生长。
// 约束照规格执行：粒子 ≤200；窗口隐藏时停画（计时逻辑在内核，不受影响）；
// Reduce Motion 时退化成静态形状；MM:SS 大数字由 DOM 叠加（这里只画氛围）。
window.Viz = (function () {
  let cv, ctx, W = 0, H = 0, dpr = 1;
  let state = { mode: 'idle', progress: 0, paused: false, alert: false };
  const parts = []; // 火苗/烟/落叶 共用一池
  const MAX_PARTS = 200;
  let t = 0; // 动画相位：暂停时冻结（时间凝固感）
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function spawn(p) { if (parts.length < MAX_PARTS) parts.push(p); }

  // —— 番茄本体：以 (cx,cy) 为中心、r 为半径，只画 burnY 以下的部分 ——
  function tomato(cx, cy, r, burnY, frozen) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx - r * 1.4, burnY, r * 2.8, cy + r * 1.2 - burnY);
    ctx.clip();
    // 果体
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r * 1.05);
    g.addColorStop(0, frozen ? '#d98a66' : '#ff8a4d');
    g.addColorStop(0.55, frozen ? '#c25a2a' : '#e8590c');
    g.addColorStop(1, frozen ? '#8f3d16' : '#c74c08');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.92, 0, 0, Math.PI * 2);
    ctx.fill();
    // 高光
    ctx.fillStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.38, cy - r * 0.32, r * 0.22, r * 0.14, -0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // 蒂叶：只在还没烧到头顶时画
    if (burnY < cy - r * 0.75) {
      ctx.fillStyle = frozen ? '#4d8a72' : '#0ca678';
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * r * 0.3, cy - r * 0.86 + Math.sin(a) * r * 0.12,
          r * 0.2, r * 0.09, a, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // —— 燃边 + 火苗 + 烟（工作期） ——
  function burnEdge(cx, cy, r, burnY, frozen) {
    if (burnY <= cy - r * 0.95 || burnY >= cy + r * 0.95) return;
    const half = Math.sqrt(Math.max(0, 1 - Math.pow((burnY - cy) / (r * 0.92), 2))) * r;
    // 燃边微光
    const glow = ctx.createLinearGradient(0, burnY - 14, 0, burnY + 6);
    glow.addColorStop(0, 'rgba(255,190,60,0)');
    glow.addColorStop(1, frozen ? 'rgba(140,200,255,.45)' : 'rgba(255,160,40,.55)');
    ctx.fillStyle = glow;
    ctx.fillRect(cx - half, burnY - 14, half * 2, 18);
    // 沿边的小火苗（暂停=冰晶色、相位冻结）
    const n = Math.max(3, Math.floor(half / 22));
    for (let i = 0; i <= n; i++) {
      const x = cx - half + (half * 2 * i) / n;
      const fl = 10 + Math.sin(t * 6 + i * 2.1) * 4 + Math.sin(t * 13 + i) * 2.5;
      const grd = ctx.createLinearGradient(0, burnY, 0, burnY - fl - 8);
      if (frozen) { grd.addColorStop(0, 'rgba(150,210,255,.9)'); grd.addColorStop(1, 'rgba(150,210,255,0)'); }
      else { grd.addColorStop(0, 'rgba(255,200,70,.95)'); grd.addColorStop(0.6, 'rgba(255,120,30,.8)'); grd.addColorStop(1, 'rgba(255,80,20,0)'); }
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.moveTo(x - 5, burnY + 1);
      ctx.quadraticCurveTo(x - 2, burnY - fl * 0.6, x + Math.sin(t * 8 + i) * 2.5, burnY - fl - 6);
      ctx.quadraticCurveTo(x + 2, burnY - fl * 0.6, x + 5, burnY + 1);
      ctx.fill();
    }
    // 烟粒
    if (!frozen && !reduced && Math.random() < 0.35) {
      spawn({ k: 'smoke', x: cx - half + Math.random() * half * 2, y: burnY - 8, vy: -(12 + Math.random() * 18), vx: (Math.random() - 0.5) * 8, life: 1, r: 2 + Math.random() * 3 });
    }
  }

  // —— 小苗（休息期）：高度 = 已休息比例 ——
  function sprout(cx, baseY, growth, frozen) {
    const h = (0.25 + growth * 0.75) * Math.min(H * 0.42, 240);
    const sway = frozen ? 0 : Math.sin(t * 1.6) * 6 * growth;
    ctx.strokeStyle = frozen ? '#4d8a72' : '#0ca678';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, baseY);
    ctx.quadraticCurveTo(cx + sway * 0.4, baseY - h * 0.55, cx + sway, baseY - h);
    ctx.stroke();
    // 叶片：沿茎每 22% 高度一对，随生长渐次舒展
    for (let i = 1; i * 0.22 < growth + 0.18; i++) {
      const fy = baseY - h * (i * 0.22) - 2;
      const open = Math.min(1, (growth - (i * 0.22 - 0.18)) / 0.18);
      if (open <= 0) continue;
      const lw = 26 * open, lh = 11 * open;
      const droop = frozen ? 0.35 : 0; // 暂停时叶垂落
      ctx.fillStyle = frozen ? 'rgba(77,138,114,.9)' : 'rgba(12,166,120,.92)';
      for (const dir of [-1, 1]) {
        ctx.save();
        ctx.translate(cx + sway * (i * 0.22), fy);
        ctx.rotate(dir * (0.55 - droop) + (frozen ? 0 : Math.sin(t * 2 + i) * 0.06));
        ctx.beginPath();
        ctx.ellipse(dir * lw * 0.55, 0, lw * 0.55, lh * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    // 芽尖聚光（最后 3s 警示由 alert 驱动）
    if (state.alert) {
      ctx.fillStyle = 'rgba(255,220,90,' + (0.4 + 0.4 * Math.sin(t * 10)) + ')';
      ctx.beginPath();
      ctx.arc(cx + sway, baseY - h, 10, 0, Math.PI * 2);
      ctx.fill();
    }
    // 土壤
    ctx.fillStyle = 'rgba(120,90,60,.45)';
    ctx.beginPath();
    ctx.ellipse(cx, baseY + 4, 60, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawParts(dt, frozen) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (!frozen) {
        p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt * 0.5;
      }
      if (p.life <= 0) { parts.splice(i, 1); continue; }
      ctx.fillStyle = 'rgba(150,140,130,' + (p.life * 0.35) + ')';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * (2 - p.life), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  let last = 0;
  function frame(ts) {
    requestAnimationFrame(frame);
    if (document.hidden) { last = ts; return; } // 隐藏即停画（省电，计时不受影响）
    const dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    const frozen = state.paused;
    if (!frozen && !reduced) t += dt;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2 + 16;
    const r = Math.min(W, H) * 0.24;
    if (state.mode === 'work' || state.mode === 'idle') {
      // 工作：燃面 = 进度；编辑态（idle）满番茄 + 微呼吸
      const prog = state.mode === 'idle' ? 0 : state.progress;
      const top = cy - r * 0.95, bottom = cy + r * 0.95;
      const burnY = top + (bottom - top) * prog;
      if (state.mode === 'idle' && !reduced) {
        ctx.save();
        ctx.globalAlpha = 0.92 + Math.sin(t * 1.5) * 0.05;
        tomato(cx, cy, r, top - 20, false);
        ctx.restore();
      } else {
        tomato(cx, cy, r, burnY, frozen);
        burnEdge(cx, cy, r, burnY, frozen);
      }
    } else if (state.mode === 'break') {
      sprout(cx, cy + r * 0.9, state.progress, frozen);
    } else if (state.mode === 'awaiting') {
      // 段间等待：种子静置在土里 + 呼吸微光（放在数字/副标题下方，别挡字）
      const sy = cy + r * 0.95;
      ctx.fillStyle = 'rgba(120,90,60,.35)';
      ctx.beginPath();
      ctx.ellipse(cx, sy + 16, 52, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.globalAlpha = 0.85 + Math.sin(t * 2) * 0.12;
      ctx.fillStyle = '#b98a5e';
      ctx.beginPath();
      ctx.ellipse(cx, sy, 18, 24, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    drawParts(dt, frozen);
  }

  return {
    init(canvas) {
      cv = canvas; ctx = cv.getContext('2d');
      resize();
      window.addEventListener('resize', resize);
      requestAnimationFrame(frame);
    },
    set(s) { state = Object.assign(state, s); },
  };
})();
