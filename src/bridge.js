// 桥：在 Tauri 里走 Rust 内核；在普通浏览器里退回一个同语义的 JS 模拟内核。
// 模拟内核只为本地开发/截图验收用，语义必须和 src-tauri/src/core.rs 保持一致 ——
// 改那边的规则，这边要跟着改（两处都有"惰性投影/强制休息护栏"注释锚点）。
(function () {
  const onTauri = !!(window.__TAURI__ && window.__TAURI__.core);

  if (onTauri) {
    const inv = window.__TAURI__.core.invoke;
    window.Bridge = {
      onTauri: true,
      boot: () => inv('boot'),
      getState: () => inv('get_state'),
      sessionStart: (plan) => inv('session_start', { plan }),
      sessionCmd: (cmd) => inv('session_cmd', { cmd }),
      saveSettings: (settings) => inv('save_settings', { settings }),
      savePlans: (plans) => inv('save_plans', { plans }),
      saveSchedules: (schedules) => inv('save_schedules', { schedules }),
      getHistory: (limit) => inv('get_history', { limit }),
    };
    return;
  }

  // ———— 浏览器模拟内核（语义对齐 core.rs） ————
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const DEFAULT_SETTINGS = {
    auto_work_to_break: true, auto_break_to_work: false,
    rest_policy: 'flexible', final_break_unlock: false,
    sound_on: true, volume: 0.7, pre_alert_sec: 3,
    theme: 'auto', selected_plan_id: 'classic', license: '',
  };
  function builtinPlans() {
    const classic = [];
    for (let i = 0; i < 4; i++) {
      classic.push({ kind: 'work', secs: 25 * 60 });
      classic.push({ kind: 'break', secs: i === 3 ? 15 * 60 : 5 * 60 });
    }
    return [
      { id: 'classic', name: '经典番茄', stages: classic, builtin: true },
      { id: 'p5217', name: '52 / 17', stages: [{ kind: 'work', secs: 52 * 60 }, { kind: 'break', secs: 17 * 60 }], builtin: true },
      { id: 'p9020', name: '90 / 20 深工作', stages: [{ kind: 'work', secs: 90 * 60 }, { kind: 'break', secs: 20 * 60 }], builtin: true },
      { id: 'sprint5', name: '5 秒冲刺（测试）', stages: [{ kind: 'work', secs: 5 }, { kind: 'break', secs: 5 }, { kind: 'work', secs: 5 }], builtin: true },
    ];
  }
  let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('tm_settings', {}));
  let plans = builtinPlans().concat((LS.get('tm_plans', [])).filter((p) => !p.builtin));
  let session = LS.get('tm_session', null) || { status: 'idle', stages: [], idx: 0, end_ms: 0, remain_ms: 0, plan_id: '', plan_name: '', started_ms: 0 };

  function project(s, cfg, now) {
    while (s.status === 'running' && now >= s.end_ms) {
      if (s.idx + 1 >= s.stages.length) { s.status = 'done'; return; }
      const cur = s.stages[s.idx].kind, next = s.stages[s.idx + 1].kind;
      const auto = cur === 'work' && next === 'break' ? (cfg.auto_work_to_break || cfg.rest_policy === 'forced')
        : cur === 'break' && next === 'work' ? cfg.auto_break_to_work : true;
      if (auto) { s.idx += 1; s.end_ms += s.stages[s.idx].secs * 1000; }
      else { s.status = 'awaiting'; return; }
    }
  }
  function restLocked(s, cfg) {
    if (cfg.rest_policy !== 'forced') return false;
    if (s.status !== 'running' && s.status !== 'paused') return false;
    const st = s.stages[s.idx];
    if (!st || st.kind !== 'break') return false;
    const isFinal = s.idx + 1 === s.stages.length;
    return !(isFinal && cfg.final_break_unlock);
  }
  function view(s, cfg, now) {
    return Object.assign({}, s, {
      remaining_ms: s.status === 'running' ? Math.max(0, s.end_ms - now) : s.status === 'paused' ? s.remain_ms : 0,
      rest_locked: restLocked(s, cfg),
      now,
    });
  }
  function persist() { LS.set('tm_session', session); LS.set('tm_settings', settings); LS.set('tm_plans', plans.filter((p) => !p.builtin)); }

  window.Bridge = {
    onTauri: false,
    boot: async () => {
      const now = Date.now();
      project(session, settings, now);
      return { settings, plans, view: view(session, settings, now), schedules: LS.get('tm_schedules', []), missed: [] };
    },
    saveSchedules: async (schedules) => { LS.set('tm_schedules', schedules); return schedules; },
    getHistory: async () => LS.get('tm_history', []),
    getState: async () => {
      const now = Date.now();
      project(session, settings, now);
      persist();
      return view(session, settings, now);
    },
    sessionStart: async (plan) => {
      if (!plan.stages.length) throw '序列是空的，先加一段';
      for (const st of plan.stages) if (st.secs < 5 || st.secs > 4 * 3600) throw '阶段时长要在 5 秒到 4 小时之间';
      const now = Date.now();
      session = { status: 'running', plan_id: plan.id, plan_name: plan.name, stages: plan.stages.map((s) => ({ ...s })), idx: 0, end_ms: now + plan.stages[0].secs * 1000, remain_ms: 0, started_ms: now };
      persist();
      return view(session, settings, now);
    },
    sessionCmd: async (cmd) => {
      const now = Date.now();
      const s = session, cfg = settings;
      project(s, cfg, now);
      const lockedZone = cfg.rest_policy === 'forced' && (s.status === 'running' || s.status === 'paused')
        && s.stages[s.idx] && s.stages[s.idx].kind === 'break';
      if (cmd === 'pause') {
        if (s.status !== 'running') throw '现在没有在计时';
        s.remain_ms = Math.max(0, s.end_ms - now); s.status = 'paused';
      } else if (cmd === 'resume') {
        if (s.status !== 'paused') throw '现在不是暂停状态';
        s.end_ms = now + s.remain_ms; s.status = 'running';
      } else if (cmd === 'skip' || cmd === 'prev' || cmd === 'reset_stage') {
        if (!['running', 'paused', 'awaiting'].includes(s.status)) throw '现在没有会话';
        if (restLocked(s, cfg)) throw '强制休息中，好好歇一会儿';
        if (lockedZone) { settings.final_break_unlock = false; } // 一次性解锁用掉即复位
        if (cmd === 'skip') {
          if (s.status === 'awaiting' || s.idx + 1 < s.stages.length) {
            s.idx += 1; s.end_ms = now + s.stages[s.idx].secs * 1000; s.status = 'running';
          } else s.status = 'done';
        } else if (cmd === 'prev') {
          if (s.status !== 'awaiting' && s.idx > 0) s.idx -= 1;
          s.end_ms = now + s.stages[s.idx].secs * 1000; s.status = 'running';
        } else {
          const dur = s.stages[s.idx].secs * 1000;
          if (s.status === 'running') s.end_ms = now + dur;
          else if (s.status === 'paused') s.remain_ms = dur;
          else { s.end_ms = now + dur; s.status = 'running'; }
        }
      } else if (cmd === 'start_next') {
        if (s.status !== 'awaiting') throw '现在不在段间等待';
        s.idx += 1; s.end_ms = now + s.stages[s.idx].secs * 1000; s.status = 'running';
      } else if (cmd === 'stop') {
        session = { status: 'idle', stages: [], idx: 0, end_ms: 0, remain_ms: 0, plan_id: '', plan_name: '', started_ms: 0 };
      } else throw '未知指令 ' + cmd;
      persist();
      return view(session, settings, now);
    },
    saveSettings: async (st) => { settings = st; persist(); return settings; },
    savePlans: async (ps) => { plans = builtinPlans().concat(ps.filter((p) => !p.builtin)); persist(); return plans; },
  };
})();
