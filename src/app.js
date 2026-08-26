// 界面主逻辑：编辑器（三态里的 Idle）、运行视图（Running/Awaiting）、完成态（Done）。
// 内核在 Rust（浏览器里退回 bridge.js 的模拟内核），这里只做两件事：
//   ① 把用户操作翻译成内核指令  ② 把内核快照画出来。
const $ = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const fmt = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
};
const fmtLong = (sec) => {
  const m = Math.round(sec / 60);
  if (m < 1) return `${sec} 秒`;
  return m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ' ' + (m % 60) + ' 分' : ''}` : `${m} 分钟`;
};

const S = {
  settings: null,
  plans: [],
  view: { status: 'idle' },          // 内核快照
  edit: { name: '未命名序列', planId: '', stages: [] }, // 编辑器里的序列（Idle 态的真相）
  undoStack: [],                     // 编辑操作撤销（快照式）
  deleted: null,                     // 待撤销的删除 {stage, at}
  schedules: [],                     // 定时计划（FE-29~33）
  listOpen: false,                   // 计时期间右侧序列栏是否展开（默认收起）
  wasActive: false,                  // 上一帧是否在会话中（检测 idle→active 边沿）
  activity: localStorage.getItem('tm_activity') || 'idle', // 陪伴活动：守烛/键盘/读书/写字
  donePlayed: false, doneDelay: false, // 完成态先让道别动画演完再弹汇总
};

// 把最新快照喂给舞台（activity 以前端选择为准）
function feedCompanion() {
  S.view.activity = S.activity;
  Companion.set(S.view);
}

// ———————————————————————— 内核交互 ————————————————————————
async function cmd(c) {
  try {
    S.view = await Bridge.sessionCmd(c);
    render();
  } catch (e) {
    toast(String(e));
  }
}
async function pollLoop() {
  // 每 800ms 向内核对一次表（惰性投影在内核侧推进；本地帧间用 end_ms 自算）
  setInterval(async () => {
    if (S.view.status === 'running') {
      const prev = { status: S.view.status, idx: S.view.idx };
      S.view = await Bridge.getState();
      if (S.view.status !== prev.status || S.view.idx !== prev.idx) {
        onTransition(prev);
      }
      render();
    }
  }, 800);
  // 大数字每 200ms 本地刷（不打内核）
  setInterval(() => { if (S.view.status === 'running') renderClock(); }, 200);
}

function onTransition(prev) {
  // Tauri 里切换音由 Rust 滴答线程 emit('sfx') 统一发（窗口关着也响得了）；
  // 只有浏览器模拟内核才在这本地放，免得双响
  if (!Bridge.onTauri) beep(S.view.status === 'done' ? 'done' : 'switch');
}

// ———————————————————————— 编辑器 ————————————————————————
function pushUndo() {
  S.undoStack.push(JSON.stringify(S.edit.stages));
  if (S.undoStack.length > 50) S.undoStack.shift();
}
function undo() {
  const last = S.undoStack.pop();
  if (!last) { toast('没有可撤销的编辑'); return; }
  S.edit.stages = JSON.parse(last);
  S.edit.planId = '';
  renderEditor();
}
function addStage(kind) {
  pushUndo();
  S.edit.stages.push({ kind, secs: kind === 'work' ? 25 * 60 : 5 * 60 });
  S.edit.planId = '';
  renderEditor(S.edit.stages.length - 1);
}
function delStage(i) {
  pushUndo();
  S.deleted = { stage: S.edit.stages[i], at: i };
  S.edit.stages.splice(i, 1);
  S.edit.planId = '';
  renderEditor();
  toast('已删除', '撤销', () => {
    if (!S.deleted) return;
    S.edit.stages.splice(S.deleted.at, 0, S.deleted.stage);
    S.deleted = null;
    renderEditor();
  });
}
function moveStage(i, d) {
  const j = i + d;
  if (j < 0 || j >= S.edit.stages.length) return;
  pushUndo();
  const [st] = S.edit.stages.splice(i, 1);
  S.edit.stages.splice(j, 0, st);
  S.edit.planId = '';
  renderEditor();
}
function dupStage(i) {
  pushUndo();
  S.edit.stages.splice(i + 1, 0, { ...S.edit.stages[i] });
  S.edit.planId = '';
  renderEditor();
}
function setSecs(i, secs, inputEl) {
  const bad = secs < 5 || secs > 4 * 3600;
  if (bad) {
    inputEl.classList.add('bad');
    setTimeout(() => { inputEl.classList.remove('bad'); renderEditor(); }, 500);
    return;
  }
  pushUndo();
  S.edit.stages[i].secs = secs;
  S.edit.planId = '';
  renderEditor();
}

function stageCard(st, i, running) {
  const card = document.createElement('div');
  card.className = 'scard' + (st.kind === 'break' ? ' break' : '');
  const bar = document.createElement('span'); bar.className = 'bar';
  const num = document.createElement('span'); num.className = 'num'; num.textContent = pad2(i + 1);
  const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = st.kind === 'work' ? '⏱' : '☕';
  const name = document.createElement('span'); name.className = 'sname'; name.textContent = st.kind === 'work' ? '工作' : '休息';
  card.append(bar, num, ico, name);

  if (running) {
    const v = S.view;
    if (i < v.idx || (i === v.idx && v.status === 'awaiting') || v.status === 'done') {
      card.classList.add('done-stage');
      const fin = document.createElement('span'); fin.className = 'fin'; fin.textContent = '✓';
      name.after(fin);
    }
    const len = document.createElement('span'); len.className = 'runlen';
    len.textContent = fmt(st.secs * 1000);
    card.appendChild(len);
    if (i === v.idx && (v.status === 'running' || v.status === 'paused')) {
      card.classList.add('cur');
      const prog = document.createElement('div'); prog.className = 'prog';
      const total = st.secs * 1000;
      prog.style.width = (100 * (1 - v.remaining_ms / total)).toFixed(1) + '%';
      card.appendChild(prog);
    }
    return card;
  }

  // —— 编辑态：MM:SS 输入 + 步进 + 排序/复制/删除 ——
  const dur = document.createElement('span'); dur.className = 'dur';
  const mi = document.createElement('input');
  mi.value = pad2(Math.floor(st.secs / 60)); mi.maxLength = 3; mi.inputMode = 'numeric';
  const colon = document.createElement('span'); colon.className = 'colon'; colon.textContent = ':';
  const si = document.createElement('input');
  si.value = pad2(st.secs % 60); si.maxLength = 2; si.inputMode = 'numeric';
  mi.addEventListener('input', () => { if (mi.value.length >= 2) si.select(); }); // 输完分自动跳秒
  const commit = () => {
    const m = parseInt(mi.value) || 0, sec = parseInt(si.value) || 0;
    setSecs(i, m * 60 + sec, si);
  };
  mi.addEventListener('blur', commit); si.addEventListener('blur', commit);
  mi.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  si.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
  dur.append(mi, colon, si);

  const steps = document.createElement('span'); steps.className = 'steps';
  const up = document.createElement('button'); up.textContent = '▲';
  const dn = document.createElement('button'); dn.textContent = '▼';
  let holdTimer = 0, holdRep = 0;
  const stepOnce = (d) => setSecs(i, Math.max(5, S.edit.stages[i].secs + d), si);
  const hold = (btn, d) => {
    btn.addEventListener('mousedown', () => {
      stepOnce(d);
      holdRep = 0;
      holdTimer = setInterval(() => { holdRep++; stepOnce(d * (holdRep > 6 ? 4 : 1)); }, 220); // 长按连续加速
    });
    ['mouseup', 'mouseleave'].forEach((ev) => btn.addEventListener(ev, () => clearInterval(holdTimer)));
  };
  hold(up, 60); hold(dn, -60);
  steps.append(up, dn);

  const ops = document.createElement('span'); ops.className = 'rowops';
  const mkOp = (txt, title, fn, cls) => {
    const b = document.createElement('button'); b.textContent = txt; b.title = title; b.onclick = fn;
    if (cls) b.className = cls;
    ops.appendChild(b);
  };
  mkOp('↑', '上移', () => moveStage(i, -1));
  mkOp('↓', '下移', () => moveStage(i, 1));
  mkOp('⧉', '复制（Ctrl+D）', () => dupStage(i));
  mkOp('✕', '删除', () => delStage(i), 'del');
  card.append(dur, steps, ops);

  // 拖拽排序
  card.draggable = true;
  card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); card.classList.add('dragging'); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dropline'); });
  card.addEventListener('dragleave', () => card.classList.remove('dropline'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); card.classList.remove('dropline');
    const from = parseInt(e.dataTransfer.getData('text/plain'));
    if (isNaN(from) || from === i) return;
    pushUndo();
    const [st2] = S.edit.stages.splice(from, 1);
    S.edit.stages.splice(i, 0, st2);
    S.edit.planId = '';
    renderEditor();
  });
  return card;
}

function renderEditor(focusIdx) {
  const list = $('stageList');
  list.textContent = '';
  S.edit.stages.forEach((st, i) => list.appendChild(stageCard(st, i, false)));
  $('emptyHint').classList.toggle('hide', S.edit.stages.length > 0);
  $('editorBar').classList.remove('hide');
  // 总览（FE-05）
  const total = S.edit.stages.reduce((s, x) => s + x.secs, 0);
  const work = S.edit.stages.filter((x) => x.kind === 'work').reduce((s, x) => s + x.secs, 0);
  const rest = total - work;
  const sum = $('summary');
  if (total > 0) {
    sum.innerHTML = '';
    const frag = document.createDocumentFragment();
    const line = document.createElement('span');
    line.append('共 ');
    const b1 = document.createElement('b'); b1.textContent = S.edit.stages.length + ' 段';
    const b2 = document.createElement('b'); b2.textContent = fmtLong(total);
    line.append(b1, ' · ', b2, ` · 工作 ${total ? Math.round((work / total) * 100) : 0}% / 休息 ${total ? Math.round((rest / total) * 100) : 0}%`);
    frag.appendChild(line);
    sum.appendChild(frag);
    sum.classList.remove('bump'); void sum.offsetWidth; sum.classList.add('bump');
    if (rest / total < 0.1 && rest > 0 || (work > 0 && rest === 0)) {
      const warn = document.createElement('div');
      warn.className = 'dim'; warn.textContent = '休息占比不到 10%，注意别把自己烧干了';
      sum.appendChild(warn);
    }
  } else sum.textContent = '';
  $('tbPlan').textContent = S.edit.planId
    ? (S.plans.find((p) => p.id === S.edit.planId) || {}).name || S.edit.name
    : S.edit.name;
  $('tbStage').textContent = '';
  if (focusIdx != null) {
    const cards = list.querySelectorAll('.scard .dur input');
    const inp = cards[focusIdx * 2];
    if (inp) { inp.focus(); inp.select(); }
  }
}

// ———————————————————————— 预设 ————————————————————————
function renderPresets() {
  const box = $('presetList');
  box.textContent = '';
  S.plans.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'preset-row' + (p.id === S.edit.planId ? ' on' : '');
    const name = document.createElement('span'); name.className = 'preset-name'; name.textContent = p.name;
    const meta = document.createElement('span'); meta.className = 'preset-meta';
    meta.textContent = p.stages.length + ' 段 · ' + fmtLong(p.stages.reduce((s, x) => s + x.secs, 0));
    row.append(name, meta);
    if (!p.builtin) {
      const del = document.createElement('button'); del.className = 'preset-del'; del.textContent = '删';
      del.onclick = async (e) => {
        e.stopPropagation();
        S.plans = S.plans.filter((x) => x.id !== p.id);
        S.plans = await Bridge.savePlans(S.plans);
        renderPresets();
      };
      row.appendChild(del);
    }
    row.onclick = async () => {
      S.edit = { name: p.name, planId: p.id, stages: p.stages.map((s) => ({ ...s })) };
      S.undoStack = [];
      hidePanels();
      renderEditor();
      // 记住这次选的预设：下次启动编辑器直接装回它（以前永远装回经典番茄）
      if (S.settings.selected_plan_id !== p.id) {
        S.settings.selected_plan_id = p.id;
        S.settings = await Bridge.saveSettings(S.settings);
      }
    };
    box.appendChild(row);
  });
}
// 自绘取名弹层：window.prompt 在 macOS 的 WKWebView 里是 no-op（Tauri 已知限制），不能用
function askName(defVal) {
  return new Promise((resolve) => {
    const modal = $('nameModal'), inp = $('nameInput');
    inp.value = defVal || '';
    modal.classList.remove('hide');
    inp.focus(); inp.select();
    const done = (val) => {
      modal.classList.add('hide');
      inp.onkeydown = $('nameOk').onclick = $('nameCancel').onclick = null;
      resolve(val);
    };
    $('nameOk').onclick = () => done(inp.value.trim() || null);
    $('nameCancel').onclick = () => done(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') done(inp.value.trim() || null);
      else if (e.key === 'Escape') done(null);
      e.stopPropagation();
    };
  });
}
async function saveAsPreset() {
  if (!S.edit.stages.length) { toast('序列是空的'); return; }
  const name = await askName(S.edit.name === '未命名序列' ? '' : S.edit.name);
  if (!name) return;
  const p = { id: 'c' + Date.now().toString(36), name: name.slice(0, 20), stages: S.edit.stages.map((s) => ({ ...s })), builtin: false };
  S.plans.push(p);
  S.plans = await Bridge.savePlans(S.plans);
  S.edit.planId = p.id; S.edit.name = p.name;
  renderPresets(); renderEditor();
  toast('已保存预设「' + p.name + '」');
}

// ———————————————————————— 快捷生成（FE-09/10） ————————————————————————
function quickGen() {
  const w = (parseInt($('qWork').value) || 25) * 60;
  const b = (parseInt($('qBreak').value) || 5) * 60;
  const loops = Math.min(12, Math.max(1, parseInt($('qLoops').value) || 4));
  const useLong = $('qLong').checked;
  const longN = Math.max(2, parseInt($('qLongN').value) || 4);
  const longM = (parseInt($('qLongM').value) || 15) * 60;
  pushUndo();
  const stages = [];
  for (let i = 1; i <= loops; i++) {
    stages.push({ kind: 'work', secs: w });
    stages.push({ kind: 'break', secs: useLong && i % longN === 0 ? longM : b });
  }
  S.edit = { name: `${w / 60}/${b / 60} × ${loops}`, planId: '', stages };
  $('quickModal').classList.add('hide');
  renderEditor();
}

// ———————————————————————— 运行视图 ————————————————————————
function renderClock() {
  // 大数字钟已隐藏（木牌接管画面读数），这里只维护窗口标题的值
  const v = S.view;
  const cl = $('clock');
  if (v.status === 'running') {
    cl.textContent = fmt(Math.max(0, v.end_ms - Date.now()));
  } else if (v.status === 'paused') {
    cl.textContent = fmt(v.remaining_ms);
  }
  feedCompanion();
  document.title = v.status === 'running' || v.status === 'paused'
    ? `${cl.textContent} · ${v.stages[v.idx].kind === 'work' ? '工作' : '休息'} — 番茄时钟`
    : '番茄时钟';
}

function render() {
  const v = S.view;
  const active = ['running', 'paused', 'awaiting'].includes(v.status);
  // 开始计时 → 右侧序列栏自动收起（☰ 按钮可随时展开）
  if (active && !S.wasActive) S.listOpen = false;
  S.wasActive = active;
  $('layout').classList.toggle('collapsed', active && !S.listOpen);
  const tl = $('btnToggleList');
  tl.classList.toggle('hide', !active);
  tl.textContent = S.listOpen ? '✕ 收起' : '☰ 序列';
  document.body.className = v.status === 'done' ? 'mode-done'
    : active && v.stages[v.idx] && v.stages[v.idx].kind === 'break' && v.status !== 'awaiting' ? 'mode-rest'
    : '';
  // 完成态：先让舞台演完道别（挥手→吹烛→离场 约3.4s）再弹汇总
  if (v.status === 'done' && !S.donePlayed) {
    S.donePlayed = true; S.doneDelay = true;
    setTimeout(() => { S.doneDelay = false; render(); }, 3400);
  }
  if (v.status !== 'done') S.donePlayed = false;
  $('doneView').classList.toggle('hide', v.status !== 'done' || S.doneDelay);
  // 活动选择行：空闲或工作段可见（休息/完成时藏起）
  $('actRow').classList.toggle('hide2',
    !(v.status === 'idle' || (active && v.stages[v.idx] && v.stages[v.idx].kind === 'work')));
  feedCompanion();

  const main = $('btnMain');
  if (v.status === 'idle') {
    main.textContent = '▶ 开始';
    $('btnPrev').disabled = $('btnReset').disabled = $('btnSkip').disabled = $('btnStop').disabled = true;
    $('clock').classList.remove('dimmed', 'alert');
    const total = S.edit.stages.reduce((s, x) => s + x.secs, 0);
    $('clock').textContent = fmt((S.edit.stages[0] ? S.edit.stages[0].secs : 25 * 60) * 1000);
    $('clockSub').textContent = total ? '就绪 · 共 ' + fmtLong(total) : '';
    Companion.setIdleSecs(S.edit.stages[0] ? S.edit.stages[0].secs : 25 * 60);
    renderEditor();
    document.title = '番茄时钟';
    return;
  }

  // 运行/暂停/等待：右侧列表切换成只读运行卡
  const list = $('stageList');
  list.textContent = '';
  v.stages.forEach((st, i) => list.appendChild(stageCard(st, i, true)));
  const curCard = list.children[v.idx];
  if (curCard) curCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('editorBar').classList.add('hide');
  $('emptyHint').classList.add('hide');
  $('summary').textContent = '';

  $('tbPlan').textContent = v.plan_name || '会话';
  const st = v.stages[v.idx];
  $('tbStage').textContent = v.status === 'done' ? '' : `第 ${v.idx + 1}/${v.stages.length} 段 · ${st.kind === 'work' ? '工作' : '休息'}`;

  $('btnStop').disabled = false;
  if (v.status === 'awaiting') {
    const next = v.stages[v.idx + 1];
    main.textContent = '▶ 开始' + (next.kind === 'work' ? '工作' : '休息');
    $('clock').textContent = fmt(next.secs * 1000);
    $('clock').classList.remove('dimmed', 'alert');
    $('clockSub').textContent = next.kind === 'work' ? '这一段休息结束了，准备好了就开始' : '这一段工作结束了，歇一会儿吧';
    $('btnPrev').disabled = false; $('btnReset').disabled = true; $('btnSkip').disabled = false;
  } else if (v.status === 'paused') {
    main.textContent = '▶ 继续';
    $('clock').classList.add('dimmed');
    $('clockSub').textContent = '已暂停';
    const locked = v.rest_locked;
    $('btnPrev').disabled = locked; $('btnReset').disabled = locked; $('btnSkip').disabled = locked;
    renderClock();
  } else if (v.status === 'running') {
    main.textContent = '‖ 暂停';
    $('clock').classList.remove('dimmed');
    $('clockSub').textContent = '';
    const locked = v.rest_locked;
    $('btnPrev').disabled = locked; $('btnReset').disabled = locked; $('btnSkip').disabled = locked;
    renderClock();
  } else if (v.status === 'done') {
    renderDone();
  }
}

function renderDone() {
  const v = S.view;
  const work = v.stages.filter((s) => s.kind === 'work').reduce((a, s) => a + s.secs, 0);
  const rest = v.stages.filter((s) => s.kind === 'break').reduce((a, s) => a + s.secs, 0);
  const sum = $('doneSummary');
  sum.innerHTML = '';
  const b1 = document.createElement('b'); b1.textContent = fmtLong(work);
  const b2 = document.createElement('b'); b2.textContent = fmtLong(rest);
  sum.append('本次专注 ', b1, ' · 休息 ', b2);
  const box = $('doneStages');
  box.textContent = '';
  v.stages.forEach((s, i) => {
    const d = document.createElement('div');
    d.textContent = `✓ ${pad2(i + 1)} ${s.kind === 'work' ? '工作' : '休息'} ${fmt(s.secs * 1000)}`;
    box.appendChild(d);
  });
}

// ———————————————————————— 控制 ————————————————————————
// 统一的会话启动：开始/再来一轮/补跑都走这里 —— 开跑后主窗退场，陪伴交给桌宠小窗（完成时自动回来展示汇总）
async function startPlan(plan) {
  try {
    S.view = await Bridge.sessionStart(plan);
    if (Bridge.setActivity) Bridge.setActivity(S.activity); // 会话开场就把活动记进内核
    render();
    if (Bridge.onTauri) {
      setTimeout(() => { try { window.__TAURI__.window.getCurrentWindow().hide(); } catch (e) {} }, 600);
    }
  } catch (e) { toast(String(e)); }
}
function editorPlan() {
  return {
    id: S.edit.planId || 'adhoc',
    name: S.edit.planId ? ((S.plans.find((p) => p.id === S.edit.planId) || {}).name || S.edit.name) : S.edit.name,
    stages: S.edit.stages,
    builtin: false,
  };
}
async function mainAction() {
  const v = S.view;
  if (v.status === 'idle') {
    if (!S.edit.stages.length) { toast('先加一段，或选个预设'); return; }
    await startPlan(editorPlan());
  } else if (v.status === 'running') cmd('pause');
  else if (v.status === 'paused') cmd('resume');
  else if (v.status === 'awaiting') cmd('start_next');
}

// ———————————————————————— 铃声库（FE-21：三款合成音 + 预备滴答 + 催促） ————————————————————————
let actx = null;
function tone(t0, freq, dur, vol, type) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.frequency.value = freq; o.type = type || 'sine';
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g).connect(actx.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
function beep(kind) {
  if (!S.settings || !S.settings.sound_on) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    // 无用户手势创建的 AudioContext 可能是 suspended（自启静默+定时开跑的路径上没人点过窗口）：先唤醒再排音
    if (actx.state === 'suspended') actx.resume();
    const v = (S.settings.volume || 0.7) * 0.3;
    const t0 = actx.currentTime;
    const id = S.settings.sound_id || 'chime';
    if (kind === 'pre') { tone(t0, 1320, 0.08, v * 0.5); return; }           // 预备滴答
    if (kind === 'remind') { tone(t0, 660, 0.25, v); tone(t0 + 0.35, 660, 0.25, v); return; }
    if (kind === 'done') { [523, 659, 784, 1046].forEach((f, i) => tone(t0 + i * 0.15, f, 0.4, v)); return; }
    // 阶段切换：三款可选
    if (id === 'bell') { [1568, 1245, 1047].forEach((f, i) => tone(t0 + i * 0.18, f, 0.9, v * 0.8)); }
    else if (id === 'wood') { tone(t0, 220, 0.09, v * 1.4, 'square'); tone(t0 + 0.16, 196, 0.09, v * 1.4, 'square'); }
    else { tone(t0, 660, 0.3, v); tone(t0 + 0.14, 880, 0.35, v); }
  } catch (e) {}
}

// ———————————————————————— 定时面板（FE-29~33） ————————————————————————
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];
const scState = { mode: 'delay', days: [1, 2, 3, 4, 5] };
function planOptions(sel) {
  sel.textContent = '';
  S.plans.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id; o.textContent = p.name;
    sel.appendChild(o);
  });
}
function scDesc(sc) {
  const plan = sc.name || (S.plans.find((p) => p.id === sc.plan_id) || {}).name || '?';
  if (sc.mode === 'recurring') return `每周${sc.weekdays.map((d) => WEEK_CN[d]).join('/')} ${sc.time} · ${plan}`;
  const d = new Date(sc.trigger_at);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} · ${plan}`;
}
async function pushSchedules() {
  S.schedules = await Bridge.saveSchedules(S.schedules);
  renderSchedules();
}
function renderSchedules() {
  const box = $('scList'); box.textContent = '';
  if (!S.schedules.length) {
    const p = document.createElement('div'); p.className = 'dim'; p.textContent = '还没有计划';
    box.appendChild(p); return;
  }
  S.schedules.forEach((sc) => {
    const row = document.createElement('div'); row.className = 'sc-row' + (sc.enabled ? '' : ' sc-off');
    const on = document.createElement('input'); on.type = 'checkbox'; on.checked = sc.enabled;
    on.onchange = () => { sc.enabled = on.checked; pushSchedules(); };
    const desc = document.createElement('span'); desc.className = 'sc-desc'; desc.textContent = scDesc(sc);
    const del = document.createElement('button'); del.className = 'preset-del'; del.textContent = '删';
    del.onclick = () => { S.schedules = S.schedules.filter((x) => x.id !== sc.id); pushSchedules(); };
    row.append(on, desc, del);
    box.appendChild(row);
  });
}
function bindSchedules() {
  // 类型三选一（定时/定点/周重复）：只展开选中的表单
  const seg = $('scModeSeg');
  const applyMode = () => {
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.mode === scState.mode));
    $('scFormDelay').classList.toggle('hide', scState.mode !== 'delay');
    $('scFormOnce').classList.toggle('hide', scState.mode !== 'once');
    $('scFormRec').classList.toggle('hide', scState.mode !== 'recurring');
  };
  seg.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { scState.mode = b.dataset.mode; applyMode(); };
  });
  applyMode();
  // 定点默认值：10 分钟后（秒归零），已填过就不动
  if (!$('scOnceDate').value) {
    const d = new Date(Date.now() + 10 * 60000);
    $('scOnceDate').value = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    $('scOnceH').value = d.getHours(); $('scOnceM').value = d.getMinutes(); $('scOnceS').value = 0;
  }
  planOptions($('scOncePlan')); planOptions($('scRecPlan'));
  const dayBox = $('scRecDays'); dayBox.textContent = '';
  for (let d = 0; d < 7; d++) {
    const b = document.createElement('button');
    b.className = 'chip' + (scState.days.includes(d) ? ' on' : '');
    b.textContent = '周' + WEEK_CN[d];
    b.onclick = () => {
      if (scState.days.includes(d)) scState.days = scState.days.filter((x) => x !== d);
      else scState.days.push(d);
      b.classList.toggle('on');
    };
    dayBox.appendChild(b);
  }
  const newId = () => 's' + Date.now().toString(36);
  $('scDelayGo').onclick = () => {
    const min = parseInt($('scDelayMin').value) || 30;
    if (!S.edit.stages.length) { toast('当前序列是空的'); return; }
    // 把"当前序列"整个快照进计划：没存成预设的临时编排也能如约开跑（以前会悄悄回落到别的预设）
    const p = editorPlan();
    S.schedules.push({ id: newId(), plan_id: S.edit.planId || '', name: p.name, stages: p.stages.map((s) => ({ ...s })), mode: 'delay', trigger_at: Date.now() + min * 60000, time: '', weekdays: [], enabled: true, last_fired: '', pre_alerted: false });
    pushSchedules();
    toast(`定好了：${min} 分钟后自动开始「${p.name}」`);
  };
  $('scOnceGo').onclick = () => {
    const date = $('scOnceDate').value;
    if (!date) { toast('先选个日期'); return; }
    const clamp = (id, max) => Math.min(max, Math.max(0, parseInt($(id).value) || 0));
    const h = clamp('scOnceH', 23), m = clamp('scOnceM', 59), sec = clamp('scOnceS', 59);
    const [Y, Mo, D] = date.split('-').map(Number);
    const ts = new Date(Y, Mo - 1, D, h, m, sec).getTime();
    if (!ts || ts <= Date.now()) { toast('这个时间已经过了'); return; }
    S.schedules.push({ id: newId(), plan_id: $('scOncePlan').value, name: '', stages: [], mode: 'once', trigger_at: ts, time: '', weekdays: [], enabled: true, last_fired: '', pre_alerted: false });
    pushSchedules();
    toast(`定好了：${Mo}/${D} ${pad2(h)}:${pad2(m)}:${pad2(sec)}`);
  };
  $('scRecGo').onclick = () => {
    if (!scState.days.length) { toast('选几个星期几'); return; }
    S.schedules.push({ id: newId(), plan_id: $('scRecPlan').value, name: '', stages: [], mode: 'recurring', trigger_at: 0, time: $('scRecTime').value || '09:30', weekdays: scState.days.slice().sort(), enabled: true, last_fired: '', pre_alerted: false });
    pushSchedules();
    toast('每周计划已加上');
  };
  renderSchedules();
}

// ———————————————————————— 杂项 UI ————————————————————————
let toastTimer = 0;
function toast(msg, actionText, action) {
  const t = $('toast');
  t.textContent = msg;
  if (actionText) {
    const b = document.createElement('button');
    b.textContent = actionText;
    b.onclick = () => { t.classList.add('hide'); action(); };
    t.appendChild(b);
  }
  t.classList.remove('hide');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hide'), 5000);
}
function hidePanels() {
  $('presetPanel').classList.add('hide');
  $('settingsPanel').classList.add('hide');
  $('schedulePanel').classList.add('hide');
  $('historyPanel').classList.add('hide');
}

// ———————————————————————— 记录（history.jsonl 的可视化，实际时长口径） ————————————————————————
async function renderHistory() {
  const box = $('histList');
  box.textContent = '';
  let rows = [];
  try { rows = await Bridge.getHistory(30); } catch (e) {}
  if (!rows.length) {
    const p = document.createElement('div'); p.className = 'dim'; p.textContent = '还没有记录，跑完一轮就有了';
    box.appendChild(p); return;
  }
  rows.slice().reverse().forEach((r) => {
    const d = new Date(r.ended_ms || 0);
    const row = document.createElement('div'); row.className = 'hist-row';
    const when = document.createElement('span'); when.className = 'hist-when';
    when.textContent = `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const name = document.createElement('span'); name.className = 'hist-name'; name.textContent = r.plan_name || '会话';
    const len = document.createElement('span'); len.className = 'hist-len';
    len.textContent = '专注 ' + fmtLong(r.work_secs || 0) + (r.completed === false ? ' · 中途结束' : '');
    row.append(when, name, len);
    box.appendChild(row);
  });
}
function togglePanel(id) {
  const was = $(id).classList.contains('hide');
  hidePanels();
  if (was) $(id).classList.remove('hide');
}

function bindSettings() {
  const s = S.settings;
  $('optAutoWB').checked = s.auto_work_to_break;
  $('optAutoBW').checked = s.auto_break_to_work;
  ($('opt' + (s.rest_policy === 'forced' ? 'Forced' : 'Flexible'))).checked = true;
  $('optUnlock').checked = s.final_break_unlock;
  $('optUnlockWrap').classList.toggle('hide', s.rest_policy !== 'forced');
  $('optSound').checked = s.sound_on;
  $('optSoundId').value = s.sound_id || 'chime';
  $('optVolume').value = Math.round((s.volume || 0.7) * 100);
  $('optSit').value = s.sit_remind_min != null ? s.sit_remind_min : 60;
  $('optStrong').checked = s.strong_remind !== false;
  $('optPre').value = s.pre_alert_sec != null ? s.pre_alert_sec : 3;
  $('optPet').checked = !s.pet_hidden;
  $('optAuto').checked = !!s.autostart;
  $('optLaunchMode').value = s.launch_mode || 'silent';
  const save = async () => {
    s.auto_work_to_break = $('optAutoWB').checked;
    s.auto_break_to_work = $('optAutoBW').checked;
    s.rest_policy = $('optForced').checked ? 'forced' : 'flexible';
    s.final_break_unlock = $('optUnlock').checked;
    s.sound_on = $('optSound').checked;
    s.sound_id = $('optSoundId').value;
    s.volume = (parseInt($('optVolume').value) || 70) / 100;
    s.sit_remind_min = Math.max(0, parseInt($('optSit').value) || 0);
    s.strong_remind = $('optStrong').checked;
    s.pre_alert_sec = Math.min(60, Math.max(0, parseInt($('optPre').value) || 0));
    s.pet_hidden = !$('optPet').checked;
    s.autostart = $('optAuto').checked;
    s.launch_mode = $('optLaunchMode').value;
    $('optUnlockWrap').classList.toggle('hide', s.rest_policy !== 'forced');
    S.settings = await Bridge.saveSettings(s);
    render();
  };
  ['optAutoWB', 'optAutoBW', 'optFlexible', 'optForced', 'optUnlock', 'optSound',
   'optSoundId', 'optVolume', 'optSit', 'optStrong', 'optPre', 'optPet', 'optAuto', 'optLaunchMode']
    .forEach((id) => { $(id).onchange = save; });
  $('optSoundTry').onclick = () => { S.settings.sound_id = $('optSoundId').value; beep('switch'); };
}

// ———————————————————————— 快捷键（FE-35，强制休息屏蔽照内核判定） ————————————————————————
function bindKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const v = S.view;
    if (e.code === 'Space') { e.preventDefault(); mainAction(); }
    else if (e.key === 'Enter' && v.status === 'idle') mainAction();
    else if ((e.key === 's' || e.key === 'ArrowRight') && v.status !== 'idle') cmd('skip');
    else if (e.key === 'ArrowLeft' && v.status !== 'idle') cmd('prev');
    else if (e.key === 'r' && v.status !== 'idle') cmd('reset_stage');
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && v.status === 'idle') { e.preventDefault(); undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'd' && v.status === 'idle') {
      e.preventDefault();
      if (S.edit.stages.length) dupStage(S.edit.stages.length - 1);
    }
  });
}

// ———————————————————————— 启动 ————————————————————————
async function boot() {
  const b = await Bridge.boot();
  S.settings = b.settings;
  S.plans = b.plans;
  S.view = b.view;
  S.schedules = b.schedules || [];
  Companion.init($('viz'));
  // 活动选择：你在做什么，它就做什么（记住上次；写进内核给流水记账）
  const syncActBtns = () => document.querySelectorAll('#actRow button')
    .forEach((x) => x.classList.toggle('on', x.dataset.a === S.activity));
  document.querySelectorAll('#actRow button').forEach((b2) => {
    b2.onclick = (e) => {
      e.stopPropagation(); // 别触发舞台的暂停热区
      S.activity = b2.dataset.a;
      localStorage.setItem('tm_activity', S.activity);
      syncActBtns();
      if (Bridge.setActivity) Bridge.setActivity(S.activity);
      feedCompanion();
    };
  });
  syncActBtns();
  bindSettings();
  bindSchedules();
  renderPresets();

  // 错过的定时计划（FE-33：关机时到点了没跑）——补跑要跑"错过的那一个"，不是编辑器里正好装着的
  if (b.missed && b.missed.length) {
    const m = b.missed[0];
    toast(`错过了定时计划：${b.missed.map((x) => x.name).join('、')}`, '现在补跑', () => {
      if (S.view.status !== 'idle') { toast('正在会话中，先结束再补跑'); return; }
      startPlan({ id: m.plan_id || 'missed', name: m.name || '补跑', stages: m.stages, builtin: false });
    });
  }

  // Rust 侧滴答线程的推送：阶段切换/托盘操作/全局快捷键改了状态，界面立刻跟上
  if (Bridge.onTauri) {
    const { listen } = window.__TAURI__.event;
    listen('state', (e) => { S.view = e.payload; render(); });
    listen('sfx', (e) => beep(e.payload));
    // 内核侧改了设置（比如"最后一段休息解锁"被用掉复位）→ 面板别继续显示旧状态骗人
    listen('settings', (e) => { S.settings = e.payload; bindSettings(); });
  }

  // 默认把选中预设装进编辑器
  const sel = S.plans.find((p) => p.id === S.settings.selected_plan_id) || S.plans[0];
  if (sel) S.edit = { name: sel.name, planId: sel.id, stages: sel.stages.map((s) => ({ ...s })) };

  // 上次没跑完的会话：问一声（FE-39）——「继续」要真的把计时开回来
  if (['paused', 'awaiting'].includes(S.view.status)) {
    toast('上次的会话还没跑完', '继续', () => {
      if (S.view.status === 'paused') cmd('resume');
      else if (S.view.status === 'awaiting') cmd('start_next');
    });
  } else if (S.view.status === 'idle') {
    S.view = { status: 'idle' };
  }
  render();
  pollLoop();

  $('btnMain').onclick = mainAction;
  $('btnSkip').onclick = () => cmd('skip');
  $('btnPrev').onclick = () => cmd('prev');
  $('btnReset').onclick = () => cmd('reset_stage');
  $('btnStop').onclick = () => {
    toast('结束这次会话？', '确定结束', () => cmd('stop'));
  };
  $('btnAddWork').onclick = () => addStage('work');
  $('btnAddBreak').onclick = () => addStage('break');
  $('btnQuick').onclick = () => $('quickModal').classList.remove('hide');
  $('qCancel').onclick = () => $('quickModal').classList.add('hide');
  $('qGo').onclick = quickGen;
  $('btnEmptyClassic').onclick = () => {
    const p = S.plans.find((x) => x.id === 'classic');
    S.edit = { name: p.name, planId: p.id, stages: p.stages.map((s) => ({ ...s })) };
    renderEditor();
  };
  $('btnPresets').onclick = (e) => { e.stopPropagation(); togglePanel('presetPanel'); renderPresets(); };
  $('btnHistory').onclick = (e) => { e.stopPropagation(); togglePanel('historyPanel'); renderHistory(); };
  $('btnSettings').onclick = (e) => { e.stopPropagation(); togglePanel('settingsPanel'); };
  $('btnSchedules').onclick = (e) => { e.stopPropagation(); togglePanel('schedulePanel'); bindSchedules(); };
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.drop') && !e.target.closest('.tb-right')) hidePanels();
  });
  $('btnSaveAs').onclick = saveAsPreset;
  $('btnAgain').onclick = () => {
    const v = S.view;
    startPlan({ id: v.plan_id, name: v.plan_name, stages: v.stages, builtin: false });
  };
  $('btnNewSession').onclick = () => cmd('stop');
  $('btnToggleList').onclick = (e) => {
    e.stopPropagation(); // 别触发 vizPane 的暂停/继续热区
    S.listOpen = !S.listOpen;
    render();
  };
  // 可视化大热区：点击=暂停/继续（规格 4.1）
  $('vizPane').onclick = () => {
    const v = S.view;
    if (v.status === 'running') cmd('pause');
    else if (v.status === 'paused') cmd('resume');
  };
  bindKeys();
}

boot();
