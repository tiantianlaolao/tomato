// capyroom 移动端外壳：接桥 + 会话流程。画面全在 scene.js 里。
//
// 🔴 内核真相（查过 core.rs，不是猜的）：
//    status 只有 idle / running / paused / awaiting / done 五个，**没有 work/break**；
//    是工作段还是休息段看 stages[idx].kind。
//    session_cmd 认的命令：pause / resume / skip / prev / reset_stage / start_next / stop。
//    boot 返回 { settings, plans, view, schedules, missed } —— 预设从这儿来。
//
// 交互纪律（《场景与美术方案说明书》§2.1 / 产品定义 §2.3 §3.3）：
//   空闲 → 家具/预设可点，全开放
//   运行 → **零 UI**。只有底部规则条常驻 + 长按取消；轻触画面才临时唤出操作条，
//          3 秒自动收起（既守住"余光态不抢注意力"，又不至于没有出口）
//   等待 → 一个"开始下一段"
//   完成 → 成果卡片
(function () {
'use strict';
const T = window.__TAURI__;
const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);
const HAS_BRIDGE = !!(T && T.core);

const GRACE_SEC = 30;      // §3.3 开始 30 秒内取消无代价
const HOLD_MS = 1500;      // §3.3 长按 1.5 秒才算取消（防误触）

let view = null, plans = [], opsTimer = 0, settings = null;

Scene.mount($('stage'));
Scene.start();

// ═══════════════ 声音 ═══════════════
// 🔴 Rust 每次切段都 emit('sfx')，桌面端 app.js 接了去 beep，移动端第一版**根本没接** ——
//    所以哪怕人正看着屏幕，段末也是悄无声息的（2026-08-29 真机反馈"没听到声音"的其中一因）。
//    后台/锁屏那条路归系统排期通知管，这里管的是"App 在前台开着"的那条。
let actx = null;
function tone(t0, freq, dur, vol, type) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type || 'sine'; o.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
function beep(kind) {
  if (settings && settings.sound_on === false) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    // 🔴 没有用户手势创建的 AudioContext 是 suspended（自启/定时开跑那条路径上没人点过屏幕），
    //    先唤醒再排音 —— 桌面端 8-26 栽过一次全静音。
    if (actx.state === 'suspended') actx.resume();
    const v = ((settings && settings.volume) || 0.7) * 0.3;
    const t0 = actx.currentTime;
    if (kind === 'pre')    { tone(t0, 1320, 0.08, v * 0.5); return; }
    if (kind === 'remind') { tone(t0, 660, 0.25, v); tone(t0 + 0.35, 660, 0.25, v); return; }
    if (kind === 'done')   { [523, 659, 784, 1046].forEach((f, i) => tone(t0 + i * 0.15, f, 0.4, v)); return; }
    tone(t0, 660, 0.3, v); tone(t0 + 0.14, 880, 0.35, v);   // 切段
  } catch (e) {}
}

// ═══════════════ 数据入口 ═══════════════
function feed(v) {
  if (!v) return;
  view = v;
  Scene.update(v);
  syncUI();
}

function phase() { return Scene.phaseOf(view); }
function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(s/60)).padStart(2,'0') + ':' + String(s%60).padStart(2,'0');
}
function human(ms) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? (Math.floor(m/60) + ' 小时 ' + (m%60) + ' 分') : (m + ' 分钟');
}

// ═══════════════ 界面同步 ═══════════════
function show(id, on) { $(id).classList.toggle('hide', !on); }

function syncUI() {
  const st = view ? view.status : 'idle';
  show('picker',   st === 'idle');
  show('nextbar',  st === 'awaiting');
  show('donecard', st === 'done');
  show('holdbar',  st === 'running' || st === 'paused');
  show('ops',      (st === 'running' || st === 'paused') && opsTimer > 0);

  if (st === 'awaiting') {
    const nxt = view.stages && view.stages[view.idx + 1];
    // 🔴 文案按下一段的方向分流。桌面端 8-26 栽过：关掉自动进休息后，
    //    三处文案都在说"休息结束该开工"，而实际下一段是休息。
    $('nextbtn').textContent = nxt && nxt.kind === 'break'
      ? '去泡一会儿（' + Math.round(nxt.secs/60) + ' 分钟）'
      : '开始下一段（' + (nxt ? Math.round(nxt.secs/60) : 0) + ' 分钟）';
  }
  if (st === 'done' && view) {
    const done = (view.stages || []).filter(s => s.kind === 'work').length;
    $('doneMain').textContent = human(view.acc_work_ms || 0);
    $('doneSub').textContent = '专注 ' + done + ' 段 · 休息 ' + human(view.acc_rest_ms || 0)
      + ' · 攒了 ' + done + ' 个橘子';
  }
  if (st === 'paused') $('opPause').textContent = '继续';
  else $('opPause').textContent = '暂停';

  // 规则条文案：宽限期内说"无代价"，过了就说清代价（§3.3：
  // 不提前说，代价就没有威慑力，只会变成"我怎么白干了"的差评）
  if (view && (st === 'running' || st === 'paused')) {
    const inGrace = Date.now() - (view.started_ms || 0) < GRACE_SEC * 1000;
    $('holdtip').textContent = inGrace
      ? '长按结束 · 开始 ' + GRACE_SEC + ' 秒内结束不计代价'
      : '长按结束 · 本段不计入';
  }
}

// ═══════════════ 预设 ═══════════════
function renderPlans() {
  const box = $('planlist');
  box.innerHTML = '';
  for (const p of plans) {
    const work = p.stages.filter(s => s.kind === 'work').reduce((a,s) => a + s.secs, 0);
    const el = document.createElement('button');
    el.className = 'plan';
    el.innerHTML = '<b>' + p.name + '</b><span>' + p.stages.length + ' 段 · 专注 '
                 + Math.round(work/60) + ' 分钟</span>';
    el.onclick = () => start(p);
    box.appendChild(el);
  }
}

// ═══════════════ 命令 ═══════════════
async function start(plan) {
  if (!HAS_BRIDGE) return feed(fixture('running'));
  try { feed(await T.core.invoke('session_start', { plan })); }
  catch (e) { console.error('session_start', e); }
}
async function cmd(c) {
  if (!HAS_BRIDGE) return feed(fixture(c === 'stop' ? 'done' : 'running'));
  try { feed(await T.core.invoke('session_cmd', { cmd: c })); }
  catch (e) { console.error('session_cmd ' + c, e); }
}

// ═══════════════ 轻触唤出操作条（3 秒自动收起）═══════════════
function popOps() {
  if (!view || (view.status !== 'running' && view.status !== 'paused')) return;
  opsTimer = 3;
  syncUI();
}
$('stage').addEventListener('click', popOps);
setInterval(() => {
  if (opsTimer > 0) { opsTimer--; if (opsTimer === 0) syncUI(); }
}, 1000);

$('opPause').onclick = (e) => { e.stopPropagation(); cmd(view && view.status === 'paused' ? 'resume' : 'pause'); opsTimer = 3; };
$('opSkip').onclick  = (e) => { e.stopPropagation(); cmd('skip'); opsTimer = 3; };
$('nextbtn').onclick = () => cmd('start_next');
$('doneOk').onclick  = () => cmd('stop');

// ═══════════════ 诊断条（内测专用，上架前连同 Rust 的 diag/test_notify 一起删）═══════════════
// 🔴 存在的理由：真机上"没听到声音"至少有四种可能 —— 没授权 / 没排上 / 排上了但静音 /
//    手机侧边静音开关。看不见就只能一轮一轮猜，而每猜一轮都要用户 25 分钟。
async function refreshDiag() {
  if (!HAS_BRIDGE) { $('diagTxt').textContent = '浏览器模式'; return; }
  try {
    const d = await T.core.invoke('diag');
    $('diagTxt').textContent = '通知' + d.perm + ' · 已排 ' + d.armed + ' 条'
      + (d.err ? ' · 错:' + d.err : '') + ' · 时区+' + d.tz_min + '分 · ' + Scene.lastFps.toFixed(1) + 'fps';
  } catch (e) { $('diagTxt').textContent = 'diag 调不到：' + e; }
}
$('diagRing').onclick = async () => {
  beep('switch');                       // 先证明前台声音这条通了
  $('diagTxt').textContent = '排期中…';
  if (!HAS_BRIDGE) return;
  try {
    const r = await T.core.invoke('test_notify');
    $('diagTxt').textContent = r.join(' | ');
  } catch (e) { $('diagTxt').textContent = 'test_notify 失败：' + e; }
};
$('diagTxt').onclick = refreshDiag;
setInterval(refreshDiag, 5000);

// ═══════════════ Hold to cancel（§3.3）═══════════════
// 🔴 长按 1.5 秒才算数，防误触；而且**规则常驻印在屏幕上**，
//    不提前说代价就没有威慑力。
(function bindHold() {
  const bar = $('holdbar'), ring = $('holdring');
  let t0 = 0, raf = 0;
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / HOLD_MS);
    ring.style.width = (k * 100).toFixed(1) + '%';
    if (k >= 1) { end(true); return; }
    raf = requestAnimationFrame(tick);
  };
  const begin = (e) => {
    if (!view || (view.status !== 'running' && view.status !== 'paused')) return;
    e.preventDefault();
    t0 = performance.now(); bar.classList.add('holding');
    raf = requestAnimationFrame(tick);
  };
  const end = (fire) => {
    cancelAnimationFrame(raf); raf = 0;
    bar.classList.remove('holding'); ring.style.width = '0%';
    if (fire) cmd('stop');
  };
  bar.addEventListener('pointerdown', begin);
  bar.addEventListener('pointerup', () => end(false));
  bar.addEventListener('pointercancel', () => end(false));
  bar.addEventListener('pointerleave', () => end(false));
})();

// ═══════════════ 测试夹具（浏览器无 Tauri 时）═══════════════
// 🔴 状态值必须**照抄内核真相**。第一版我自己编了 status:'work'，
//    本地六态全绿而真机会全部落到 idle —— 夹具跟内核不一致，测试就是自说自话。
function fixture(kind) {
  const stages = [
    { kind:'work',  secs:1500, activity:'idle' },
    { kind:'break', secs:300,  activity:'' },
    { kind:'work',  secs:1500, activity:'idle' },
    { kind:'break', secs:900,  activity:'' },
  ];
  const now = Date.now();
  const base = { stages, plan_id:'classic', plan_name:'经典番茄', idx:2,
                 remaining_ms:184000, now, end_ms:now+184000, rest_locked:false,
                 started_ms:now-3600000, awaiting_since:0, logged:false,
                 acc_work_ms:1620000, acc_rest_ms:300000, activity:'idle' };
  switch (kind) {
    case 'idle':     return Object.assign({}, base, { status:'idle', stages:[], idx:0, remaining_ms:0, plan_name:'' });
    case 'break':    return Object.assign({}, base, { status:'running', idx:3, remaining_ms:96000 });
    case 'paused':   return Object.assign({}, base, { status:'paused' });
    case 'awaiting': return Object.assign({}, base, { status:'awaiting', idx:2, remaining_ms:0 });
    case 'done':     return Object.assign({}, base, { status:'done', idx:3, remaining_ms:0 });
    case 'pre':      return Object.assign({}, base, { status:'running', remaining_ms:9000 });
    case 'grace':    return Object.assign({}, base, { status:'running', started_ms:now-8000 });
    default:         return Object.assign({}, base, { status:'running' });
  }
}

// ═══════════════ 启动 ═══════════════
if (!HAS_BRIDGE) {
  document.body.classList.add('nobridge');
  plans = [
    { id:'classic', name:'经典番茄', builtin:true, stages:fixture('run').stages },
    { id:'deep',    name:'深度专注', builtin:true, stages:[{kind:'work',secs:3000,activity:'idle'},{kind:'break',secs:600,activity:''}] },
    { id:'short',   name:'小憩一下', builtin:true, stages:[{kind:'work',secs:900,activity:'idle'},{kind:'break',secs:300,activity:''}] },
  ];
  renderPlans();
  feed(fixture(qs.get('demo') || 'running'));
  setInterval(() => {
    if (!view || view.status !== 'running') return;
    view.remaining_ms = Math.max(0, view.remaining_ms - 1000);
    Scene.update(view); syncUI();
  }, 1000);
} else {
  T.event.listen('state', (e) => feed(e.payload));
  // 前台切段音：Rust 滴答线程发 sfx（switch / pre / remind / done）
  T.event.listen('sfx', (e) => beep(e.payload));
  (async () => {
    try {
      const b = await T.core.invoke('boot');
      plans = b.plans || [];
      settings = b.settings || null;
      renderPlans();
      feed(b.view);
    } catch (e) {
      console.error('boot', e);
      try { feed(await T.core.invoke('get_state')); } catch (e2) {}
    }
    // Rust 每秒推 state；本地按时间戳补插，免得秒针一顿一顿
    setInterval(() => {
      if (!view || view.status !== 'running') return;
      view.remaining_ms = Math.max(0, view.end_ms - Date.now());
      Scene.update(view); syncUI();
    }, 250);
  })();
}

// 页面不可见就停画（省电）
document.addEventListener('visibilitychange', () => {
  document.visibilityState === 'visible' ? Scene.start() : Scene.stop();
});
})();
