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

if (qs.get('boxes')) window.__SHOWBOXES = true;   // 验收用：画出入口命中区
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
    // 切段：三款铃声照搬桌面端 app.js。
    // 🔴 8-29 反馈"三种声音听不出区别"＝这里第一版根本没读 sound_id，三档都在放同一个音
    const id = (settings && settings.sound_id) || 'chime';
    if (id === 'bell')      { [1568, 1245, 1047].forEach((f, i) => tone(t0 + i * 0.18, f, 0.9, v * 0.8)); }
    else if (id === 'wood') { tone(t0, 220, 0.09, v * 1.4, 'square'); tone(t0 + 0.16, 196, 0.09, v * 1.4, 'square'); }
    else                    { tone(t0, 660, 0.3, v); tone(t0 + 0.14, 880, 0.35, v); }
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
  // 强制休息（FE-40）：内核本来就会拒绝 skip/prev/reset（护栏在 core.rs，跨平台），
  // 界面上就别再摆一个按了没用的按钮 —— "说了做不到的事"比少个按钮伤得多
  show('opSkip',   !(view && view.rest_locked));
  if (st !== 'idle') closeSheet();   // 一开跑就收起面板，运行态是零 UI

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
    // ⚠️ 原来这儿写"攒了 N 个橘子"——8-29 用户把"橘子＝进度/货币"整个否了，
    //    而"攒什么"要等他想好。没定的事就别在成果卡片上先许愿。
    $('doneSub').textContent = '专注 ' + done + ' 段 · 休息 ' + human(view.acc_rest_ms || 0);
  }
  if (st === 'paused') $('opPause').textContent = '继续';
  else $('opPause').textContent = '暂停';

  // 规则条文案：宽限期内说"无代价"，过了就说清代价（§3.3：
  // 不提前说，代价就没有威慑力，只会变成"我怎么白干了"的差评）
  if (view && (st === 'running' || st === 'paused')) {
    const inGrace = Date.now() - (view.started_ms || 0) < GRACE_SEC * 1000;
    $('holdtip').textContent = view.rest_locked
      ? '强制休息中 · 按住 5 秒才能结束'
      : (inGrace
          ? '长按结束 · 开始 ' + GRACE_SEC + ' 秒内结束不计代价'
          : '长按结束 · 本段不计入');
  }
}

// ═══════════════ 预设 ═══════════════
function renderPlans() {
  const box = $('planlist');
  if (!box) return;          // 预设列表现在只活在"今天泡多久"那个面板里
  box.innerHTML = '';
  for (const p of plans) {
    const work = p.stages.filter(s => s.kind === 'work').reduce((a,s) => a + s.secs, 0);
    const el = document.createElement('button');
    el.className = 'plan';
    const mins = work >= 60 ? Math.round(work/60) + ' 分钟' : work + ' 秒';
    el.innerHTML = '<b>' + p.name + '</b><span>' + p.stages.length + ' 段 · 专注 ' + mins + '</span>';
    el.onclick = () => start(p);
    // 长按：自定义预设 → 删除确认；内置的 → 载进编排器改（改完可另存，内置本身不动）
    let lt = 0;
    const cancel = () => { clearTimeout(lt); lt = 0; };
    el.addEventListener('pointerdown', () => {
      lt = setTimeout(() => {
        lt = 0;
        if (p.builtin) {
          // 内置的改不了，但可以拿来当底子改完另存 —— 桌面端也是这个规矩
          draft = { name:'', stages: p.stages.map(s => Object.assign({}, s)) };
          openSheet('edit', '编排');
        } else {
          askConfirm('删除预设「' + p.name + '」？', () => {
            pushPlans(plans.filter(x => !x.builtin && x.id !== p.id));
          });
        }
      }, 600);
    });
    ['pointerup','pointercancel','pointerleave'].forEach(ev => el.addEventListener(ev, cancel));
    box.appendChild(el);
  }
}

// 自绘确认条。🔴 不用 window.confirm/prompt：WKWebView 里 prompt 是 no-op
// （桌面端 8-26 为这个把存预设的取名框改成自绘），confirm 也依赖宿主实现，别赌。
function askConfirm(text, onYes) {
  const wrap = document.createElement('div');
  wrap.id = 'ask';
  const p = document.createElement('div'); p.className = 'asktxt'; p.textContent = text;
  const no = document.createElement('button'); no.className = 'btn'; no.textContent = '算了';
  const yes = document.createElement('button'); yes.className = 'btn pri'; yes.textContent = '删掉';
  const row = document.createElement('div'); row.className = 'btns';
  row.appendChild(no); row.appendChild(yes);
  wrap.appendChild(p); wrap.appendChild(row);
  document.getElementById('ui').appendChild(wrap);
  const close = () => wrap.remove();
  no.onclick = close;
  yes.onclick = () => { close(); onYes(); };
}

// ═══════════════ 面板：编排 / 记录 / 设置 ═══════════════
// 用户 2026-08-29 定的边界：**桌面端的核心功能一定要保留，只是换手机的实现法**。
// 所以序列编排、预设增删、强制休息、记录、设置全都要有 —— 变的是交互形态：
//   桌面拖拽排序 → 手机上下箭头（滚动列表里拖拽必然误触）
//   桌面 window.prompt 取名 → 自绘输入框（WKWebView 的 prompt 是 no-op，桌面端 8-26 栽过）
//   桌面右栏常驻 → 手机底部抽屉，一开跑就收起（运行态零 UI 是第一原理）
let sheetKind = '', draft = null;

function closeSheet() {
  if (!sheetKind) return;
  sheetKind = '';
  $('sheet').classList.add('hide');
  document.body.classList.remove('sheeton');
}
function openSheet(kind, title) {
  sheetKind = kind;
  $('sheetTitle').textContent = title;
  $('sheet').classList.remove('hide');
  document.body.classList.add('sheeton');
  renderSheet();
}
$('sheetClose').onclick = closeSheet;

function renderSheet() {
  if (sheetKind === 'start') return renderStart();
  if (sheetKind === 'edit') return renderEditor();
  if (sheetKind === 'set')  return renderSettings();
  if (sheetKind === 'hist') return renderHistory();
}

// ── 木牌：今天泡多久（预设列表 + 去编排）──────────────
function renderStart() {
  const box = $('sheetBody');
  box.innerHTML = '';
  const list = document.createElement('div');
  list.id = 'planlist';
  box.appendChild(list);
  renderPlans();
  const go = document.createElement('button');
  go.className = 'btn wide'; go.style.marginTop = '14px';
  go.textContent = '自己编排一支';
  go.onclick = () => openSheet('edit', '编排');
  box.appendChild(go);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.textContent = '长按一支自定义的可以删掉；长按内置的会载进编排器当底子改。';
  box.appendChild(tip);
}

// ── 编排：序列编辑器 + 快捷生成 + 存为预设 ──────────────
function planTotals(stages) {
  const w = stages.filter(s => s.kind === 'work').reduce((a,s) => a + s.secs, 0);
  const r = stages.filter(s => s.kind === 'break').reduce((a,s) => a + s.secs, 0);
  return { w, r };
}
let totalsEl = null;
function paintTotals() {
  if (!totalsEl || !draft) return;
  const t = planTotals(draft.stages);
  const pct = t.w > 0 ? Math.round(t.r * 100 / t.w) : 0;
  totalsEl.className = 'tip';
  totalsEl.textContent = '共 ' + draft.stages.length + ' 段 · 专注 ' + Math.round(t.w/60)
    + ' 分 · 休息 ' + Math.round(t.r/60) + ' 分（休息约为专注的 ' + pct + '%）';
  if (t.w > 0 && pct < 10) {
    totalsEl.className = 'tip warn';
    totalsEl.textContent += ' —— 休息偏少，容易撑不到最后';
  }
}
function ensureDraft() {
  if (draft) return;
  const base = plans.find(p => p.id === (settings && settings.selected_plan_id)) || plans[0];
  draft = { name: '', stages: base ? base.stages.map(s => Object.assign({}, s)) : [] };
}
function renderEditor() {
  ensureDraft();
  const box = $('sheetBody');
  box.innerHTML = '';
  totalsEl = null;   // 上一轮那个节点已经被 innerHTML 清掉了，别再往它身上写
  // 🔴 先把 firstElementChild 抓出来再 append：append 会把它从 d 里**搬走**，
  //    搬走之后 d.firstElementChild 就是 null 了（第一版直接 return，全线 null）
  const add = (html) => {
    const d = document.createElement('div'); d.innerHTML = html;
    const el = d.firstElementChild; box.appendChild(el); return el;
  };

  add('<div class="sec">序列（点左边那格切工作／休息）</div>');
  draft.stages.forEach((s, i) => {
    const row = add('<div class="stage"></div>');
    const kind = document.createElement('button');
    kind.className = 'kind' + (s.kind === 'work' ? ' work' : '');
    kind.textContent = s.kind === 'work' ? '工作' : '休息';
    kind.onclick = () => { s.kind = s.kind === 'work' ? 'break' : 'work'; renderEditor(); };
    const dec = document.createElement('button'); dec.className = 'mini'; dec.textContent = '−';
    const mm  = document.createElement('div');    mm.className = 'mm';
    const paint = () => { mm.textContent = (s.secs >= 60 ? Math.round(s.secs/60) + ' 分' : s.secs + ' 秒'); paintTotals(); };
    paint();
    const inc = document.createElement('button'); inc.className = 'mini'; inc.textContent = '+';
    // 长按连加：手机上点 25 下调不动一小时（桌面端也有步进加速）。
    // 🔴 只重画这一行的数字和总览，绝不整表重绘 —— 重绘会把正在被按的按钮销毁
    const step = (d) => { s.secs = Math.max(60, s.secs + d * 60); paint(); };
    bindRepeat(dec, () => step(-1)); bindRepeat(inc, () => step(1));
    const up = document.createElement('button'); up.className = 'mini'; up.textContent = '↑';
    up.onclick = () => { if (i > 0) { const t = draft.stages[i-1]; draft.stages[i-1] = s; draft.stages[i] = t; renderEditor(); } };
    const dn = document.createElement('button'); dn.className = 'mini'; dn.textContent = '↓';
    dn.onclick = () => { if (i < draft.stages.length-1) { const t = draft.stages[i+1]; draft.stages[i+1] = s; draft.stages[i] = t; renderEditor(); } };
    const del = document.createElement('button'); del.className = 'mini del'; del.textContent = '×';
    del.onclick = () => { draft.stages.splice(i, 1); renderEditor(); };
    [kind, dec, mm, inc, up, dn, del].forEach(el => row.appendChild(el));
  });

  const addRow = add('<div class="btns"></div>');
  const bw = document.createElement('button'); bw.className = 'btn'; bw.textContent = '+ 工作 25 分';
  bw.onclick = () => { draft.stages.push({ kind:'work', secs:1500, activity:'' }); renderEditor(); };
  const bb = document.createElement('button'); bb.className = 'btn'; bb.textContent = '+ 休息 5 分';
  bb.onclick = () => { draft.stages.push({ kind:'break', secs:300, activity:'' }); renderEditor(); };
  addRow.appendChild(bw); addRow.appendChild(bb);

  // 总览 + 休息占比软提示（桌面端 P1 就有这条：休息 <10% 提醒一句，但不拦着）
  const ov = add('<div class="tip"></div>');
  totalsEl = ov;
  paintTotals();

  add('<div class="sec">快捷生成</div>');
  const gen = add('<div class="row"></div>');
  const mk = (v, w) => { const el = document.createElement('input'); el.className='num'; el.type='number';
    el.inputMode='numeric'; el.value=v; el.style.width=w||'56px'; return el; };
  const gw = mk(25), gn = mk(4), gb = mk(5), gl = mk(15);
  [['工作', gw], ['段数', gn], ['休息', gb], ['末段', gl]].forEach(([t, el]) => {
    const cell = document.createElement('div'); cell.className = 'gcell';
    const lab = document.createElement('div'); lab.className = 'sub'; lab.textContent = t;
    cell.appendChild(lab); cell.appendChild(el); gen.appendChild(cell);
  });
  const genBtn = add('<button class="btn wide">按上面四个数生成序列</button>');
  genBtn.onclick = () => {
    const w = Math.max(1, +gw.value||25), n = Math.max(1, +gn.value||4);
    const b = Math.max(1, +gb.value||5), l = Math.max(1, +gl.value||15);
    draft.stages = [];
    for (let i = 0; i < n; i++) {
      draft.stages.push({ kind:'work', secs:w*60, activity:'' });
      draft.stages.push({ kind:'break', secs:(i === n-1 ? l : b)*60, activity:'' });
    }
    renderEditor();
  };
  add('<div class="tip">四个数依次是：工作分钟、几段、休息分钟、最后一段休息分钟</div>');

  add('<div class="sec">存为预设</div>');
  const nameEl = document.createElement('input');
  nameEl.className = 'txt'; nameEl.type = 'text'; nameEl.placeholder = '给它起个名字';
  nameEl.value = draft.name || '';
  nameEl.oninput = () => { draft.name = nameEl.value; };
  box.appendChild(nameEl);

  const acts = add('<div class="btns"></div>');
  const save = document.createElement('button'); save.className = 'btn'; save.textContent = '存为预设';
  save.onclick = savePreset;
  const go = document.createElement('button'); go.className = 'btn pri'; go.textContent = '直接开始';
  go.onclick = () => {
    if (!draft.stages.length) return;
    start({ id:'custom', name: draft.name || '临时编排', stages: draft.stages, builtin:false });
  };
  acts.appendChild(save); acts.appendChild(go);
  add('<div class="tip">列表里长按一支自定义预设可以删掉它（内置的删不了）</div>');
}

// 按住不放连续调整（桌面端的步进长按加速，手机上更需要）
// 🔴🔴 8-29 真机反馈"点一下减号就一路掉到 1、加号一直闪"＝这里两个错叠在一起：
//    ① 停止监听挂在按钮自己身上，而每步都整表重绘 → 按钮当场被销毁 →
//       pointerup 永远等不到 → setInterval 永远停不下来（"停不住"的真凶）
//    ② 整表重绘＝每 90ms 重建一次 DOM（"数字一直在闪"）
//    改法：停止监听挂到 **document**（元素没了照样收得到抬手），
//    并且连调期间只改那一行的文字、不重绘（见 renderEditor 里的 paint）
function bindRepeat(el, fn) {
  let t = 0, iv = 0;
  const stop = () => {
    clearTimeout(t); clearInterval(iv); t = iv = 0;
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stop();          // 防止上一次没停干净
    fn();
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    t = setTimeout(() => { iv = setInterval(fn, 110); }, 450);
  });
}

async function savePreset() {
  if (!draft || !draft.stages.length) return;
  const name = (draft.name || '').trim() || ('我的编排 ' + (plans.filter(p => !p.builtin).length + 1));
  const customs = plans.filter(p => !p.builtin);
  customs.push({ id: 'p' + Date.now().toString(36), name, stages: draft.stages, builtin: false });
  await pushPlans(customs);
  draft.name = '';
  renderEditor();
}
async function pushPlans(customs) {
  if (!HAS_BRIDGE) { plans = plans.filter(p => p.builtin).concat(customs); renderPlans(); return; }
  try {
    plans = await T.core.invoke('save_plans', { plans: customs });   // Rust 会把内置的并回来
    renderPlans();
  } catch (e) { console.error('save_plans', e); }
}

// ── 设置：桌面端那份的手机版（托盘/自启/桌宠三类手机上不存在，不列）──
function renderSettings() {
  const box = $('sheetBody');
  box.innerHTML = '';
  if (!settings) { box.textContent = '读不到设置'; return; }
  const rowEl = (label, sub) => {
    const r = document.createElement('div'); r.className = 'row';
    const l = document.createElement('div'); l.className = 'lb';
    l.textContent = label;
    if (sub) { const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub; l.appendChild(s); }
    r.appendChild(l); box.appendChild(r); return r;
  };
  const sec = (t) => { const d = document.createElement('div'); d.className = 'sec'; d.textContent = t; box.appendChild(d); };
  const sw = (r, key) => {
    const b = document.createElement('button');
    b.className = 'sw' + (settings[key] ? ' on' : '');
    b.onclick = () => { settings[key] = !settings[key]; b.classList.toggle('on', settings[key]); pushSettings(); };
    r.appendChild(b);
  };
  const num = (r, key, min, max, unit) => {
    const i = document.createElement('input');
    i.className = 'num'; i.type = 'number'; i.inputMode = 'numeric'; i.value = settings[key];
    i.onchange = () => {
      let v = Math.round(+i.value || 0);
      v = Math.max(min, Math.min(max, v));
      i.value = v; settings[key] = v; pushSettings();
    };
    r.appendChild(i);
    if (unit) { const u = document.createElement('span'); u.className = 'sub'; u.textContent = unit; r.appendChild(u); }
  };

  sec('衔接');
  sw(rowEl('工作结束自动进休息'), 'auto_work_to_break');
  sw(rowEl('休息结束自动开工', '默认关着：防止一段接一段停不下来'), 'auto_break_to_work');

  sec('休息模式');
  const rp = rowEl('强制休息', '休息期间跳过/回退/重来全部按不动，只剩按住 5 秒的紧急出口');
  const seg = document.createElement('div'); seg.className = 'seg';
  [['flexible','弹性'],['forced','强制']].forEach(([v, t]) => {
    const b = document.createElement('button');
    b.textContent = t; b.className = settings.rest_policy === v ? 'on' : '';
    b.onclick = () => { settings.rest_policy = v; pushSettings(); renderSettings(); };
    seg.appendChild(b);
  });
  rp.appendChild(seg);
  if (settings.rest_policy === 'forced') {
    sw(rowEl('最后一段休息可解锁一次', '用掉即失效，下次会话重新给'), 'final_break_unlock');
  }

  sec('声音');
  sw(rowEl('提示音'), 'sound_on');
  const vr = rowEl('音量');
  const rg = document.createElement('input');
  rg.type = 'range'; rg.min = 0; rg.max = 1; rg.step = 0.05; rg.value = settings.volume;
  rg.onchange = () => { settings.volume = +rg.value; pushSettings(); beep('switch'); };
  vr.appendChild(rg);
  const sr = rowEl('铃声', '只管 App 开着时的提示音；锁屏后那一声是系统通知发的，音色归系统');
  const sseg = document.createElement('div'); sseg.className = 'seg';
  [['chime','清脆'],['bell','钟'],['wood','木鱼']].forEach(([v, t]) => {
    const b = document.createElement('button');
    b.textContent = t; b.className = settings.sound_id === v ? 'on' : '';
    b.onclick = () => { settings.sound_id = v; pushSettings(); renderSettings(); beep('switch'); };
    sseg.appendChild(b);
  });
  sr.appendChild(sseg);
  num(rowEl('段末预告', '结束前多少秒先滴一声，0＝不预告'), 'pre_alert_sec', 0, 60, '秒');

  sec('提醒');
  num(rowEl('久坐提醒', '连续工作多久提醒一次，0＝关'), 'sit_remind_min', 0, 240, '分');
  sw(rowEl('休息结束没反应就一直催'), 'strong_remind');

  const tip = document.createElement('div'); tip.className = 'tip';
  tip.textContent = '托盘、开机自启、桌宠小窗是桌面端专有的，手机上没有这些概念，所以这里不列。';
  box.appendChild(tip);
}
async function pushSettings() {
  if (!HAS_BRIDGE) return;
  try { settings = await T.core.invoke('save_settings', { settings }); }
  catch (e) { console.error('save_settings', e); }
}

// ── 记录：会话流水（按实际经过时间记，不是计划时长）──
async function renderHistory() {
  const box = $('sheetBody');
  box.innerHTML = '<div class="tip">读取中…</div>';
  let rows = [];
  if (HAS_BRIDGE) {
    try { rows = await T.core.invoke('get_history', { limit: 50 }); }
    catch (e) { box.innerHTML = '<div class="tip">读不到记录：' + e + '</div>'; return; }
  }
  const note = '<div class="tip">跑完的每一场都会记。中途结束的：满 1 分钟才记（免得误触也留痕），'
             + '所以拿「调试 · 20 秒 ×2」测的时候，只要没跑完就一条都不会留。</div>';
  if (!rows.length) { box.innerHTML = '<div class="tip">还没有记录。</div>' + note; return; }
  box.innerHTML = '';
  rows.slice().reverse().forEach(r => {
    const d = new Date(r.started_ms || r.ended_ms || Date.now());
    const el = document.createElement('div');
    el.className = 'hist' + (r.completed === false ? ' aband' : '');
    const dt = (d.getMonth()+1) + '月' + d.getDate() + '日 '
             + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    // 🔴 字段名照抄 Rust 的 HistoryRecord：work_secs / rest_secs（**不是 _ms**），
    //    自己编字段名就会全显示 0 分钟，而且看起来"没报错"
    el.innerHTML = '<b>' + (r.plan_name || '临时编排') + '</b> <span>· 专注 '
      + Math.round((r.work_secs || 0)/60) + ' 分 · 休息 ' + Math.round((r.rest_secs || 0)/60) + ' 分</span>'
      + '<div class="sub">' + dt + (r.completed === false ? ' · 中途结束' : ' · 完成') + '</div>';
    box.appendChild(el);
  });
  const n = document.createElement('div'); n.innerHTML = note;
  box.appendChild(n.firstElementChild);
}

// 🔴 入口在**场景物件**上（§9：画面里没有悬浮按钮）。点哪件东西开哪个面板，
//    映射由场景包给（换个场景就是换一组物件），引擎只负责命中判定。
const ENTRY_SHEET = { start:['start','今天泡多久'], settings:['set','设置'], stats:['hist','记录'] };
function tapScene(e) {
  // 运行态零 UI：跑起来之后点画面只唤出那条操作条，不开面板
  if (view && view.status !== 'idle' && view.status !== 'done') return popOps();
  const r = $('stage').getBoundingClientRect();
  const hit = Scene.hitEntry(e.clientX - r.left, e.clientY - r.top);
  if (!hit || !ENTRY_SHEET[hit]) return;
  openSheet(ENTRY_SHEET[hit][0], ENTRY_SHEET[hit][1]);
}

// ═══════════════ 命令 ═══════════════
async function start(plan) {
  closeSheet();
  if (!HAS_BRIDGE) return feed(fixture('running'));
  try { feed(await T.core.invoke('session_start', { plan })); }
  catch (e) { console.error('session_start', e); }
  // 记住这次用的是哪支：下次开 App 的编排器就从它起手（桌面端同规矩）
  if (settings && plan.id && plan.id !== 'custom' && settings.selected_plan_id !== plan.id) {
    settings.selected_plan_id = plan.id;
    pushSettings();
  }
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
$('stage').addEventListener('click', tapScene);
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
// 🔴 强制休息期间加长到 5 秒：桌面端的招牌戏是全屏遮罩 + 内核拒绝 skip/prev/reset，
//    手机上整屏就是它、遮罩没有意义，所以"强制"落在**出口更难**上
//    （跟桌面端遮罩里那个"按住 5 秒紧急结束"是同一个设计）。
function holdMs() { return view && view.rest_locked ? 5000 : HOLD_MS; }
(function bindHold() {
  const bar = $('holdbar'), ring = $('holdring');
  let t0 = 0, raf = 0;
  const tick = () => {
    const k = Math.min(1, (performance.now() - t0) / holdMs());
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
    // 强制休息：内核算出的 rest_locked=true —— 跳过按钮要消失、长按变 5 秒
    case 'forced':   return Object.assign({}, base, { status:'running', idx:3, remaining_ms:96000, rest_locked:true });
    default:         return Object.assign({}, base, { status:'running' });
  }
}

// ═══════════════ 启动 ═══════════════
if (!HAS_BRIDGE) {
  document.body.classList.add('nobridge');
  // 🔴 夹具的字段名照抄 core.rs 的 Settings，别自己编（编了本地全绿、真机全歪）
  settings = { auto_work_to_break:true, auto_break_to_work:false, rest_policy:'flexible',
               final_break_unlock:false, sound_on:true, volume:0.7, pre_alert_sec:5,
               sound_id:'chime', sit_remind_min:60, strong_remind:true, selected_plan_id:'classic' };
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
  // 设置被 Rust 侧改过（比如强制休息的一次性解锁被用掉）要同步回来，
  // 否则界面上还亮着、再存一次又把 true 写回去＝解锁悄悄重新武装（桌面端 8-26 的坑）
  T.event.listen('settings', (e) => {
    settings = e.payload || settings;
    if (sheetKind === 'set') renderSettings();
  });
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

// 截图验收用：?sheet=edit|set|hist 直接把面板打开（浏览器里跑，不进真机路径）
if (qs.get('sheet')) {
  const k = qs.get('sheet');
  setTimeout(() => openSheet(k, k === 'edit' ? '编排' : (k === 'set' ? '设置' : '记录')), 60);
}

// 页面不可见就停画（省电）
document.addEventListener('visibilitychange', () => {
  document.visibilityState === 'visible' ? Scene.start() : Scene.stop();
});
})();
