// 计时内核：整个应用唯一的真相源。
//
// 设计原则（对应规格书 FE-14 / FE-26 / FE-39）：
//   · 不养定时器线程 —— 会话状态是「目标时间戳 + 惰性投影」：任何人在任何时刻问
//     "现在什么状态"，都拿当前时刻对着 end_ms 推演（可能一口气推过好几个自动衔接的
//     阶段）。挂起、休眠、窗口关掉再开，推演结果都严格准确。
//   · 强制休息（FE-40）是内核里的护栏，不是 UI 的摆设：跳过/回退/重置在休息阶段
//     一律被内核拒绝，UI 只是把这个事实画出来。
//   · 所有变更立刻落盘（三个 JSON），进程怎么死都丢不了。

use serde::{Deserialize, Serialize};

pub const MIN_STAGE_SEC: u64 = 5;
pub const MAX_STAGE_SEC: u64 = 4 * 3600;

#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct Stage {
    pub kind: String, // "work" | "break"
    pub secs: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Plan {
    pub id: String,
    pub name: String,
    pub stages: Vec<Stage>,
    pub builtin: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub auto_work_to_break: bool,  // 工作→休息 自动衔接（FE-13）
    pub auto_break_to_work: bool,  // 休息→工作 默认手动，防过劳（FE-13）
    pub rest_policy: String,       // "flexible" | "forced"（FE-40/41）
    pub final_break_unlock: bool,  // 强制模式下，仅会话最后一段休息可解锁一次（FE-40⑤），用掉即复位
    pub sound_on: bool,
    pub volume: f32,
    pub pre_alert_sec: u32,        // 阶段结束前 N 秒预备提示（FE-22）
    pub theme: String,             // "auto" | "light" | "dark"
    pub selected_plan_id: String,
    pub license: String,           // 收费校验占位：现在恒空，M3 接支付后填真值
    pub sound_id: String,          // 铃声库（FE-21）："chime" | "bell" | "wood"
    pub autostart: bool,           // 开机自启（FE-25）
    pub launch_mode: String,       // 自启形态："silent" | "window"
    pub sit_remind_min: u32,       // 久坐提醒间隔分钟，0=关（FE-41，仅非强制模式）
    pub strong_remind: bool,       // 休息结束未响应的强提醒（FE-23）
    pub pet_hidden: bool,          // 桌宠小窗是否收起（托盘/设置可切）
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            auto_work_to_break: true,
            auto_break_to_work: false,
            rest_policy: "flexible".into(),
            final_break_unlock: false,
            sound_on: true,
            volume: 0.7,
            pre_alert_sec: 3,
            theme: "auto".into(),
            selected_plan_id: "classic".into(),
            license: String::new(),
            sound_id: "chime".into(),
            autostart: false,
            launch_mode: "silent".into(),
            // 默认 60：必须大于常见工作段长（25/52 分钟），否则会在正常番茄中途催人起身
            sit_remind_min: 60,
            strong_remind: true,
            pet_hidden: false,
        }
    }
}

/// 会话运行态。status 的含义：
///   idle     没有会话
///   running  当前段在走，end_ms 是这一段的目标时刻
///   paused   暂停，remain_ms 是这一段还剩多少
///   awaiting 上一段走完了、下一段等手动开始（idx 还停在走完的那段上）
///   done     整个序列走完
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Session {
    pub status: String,
    pub plan_id: String,
    pub plan_name: String,
    pub stages: Vec<Stage>,
    pub idx: usize,
    pub end_ms: u64,
    pub remain_ms: u64,
    pub started_ms: u64,     // 会话开始时刻（完成页汇总用）
    pub awaiting_since: u64, // 进入段间等待的时刻（强提醒 FE-23 的计时起点）
    pub logged: bool,        // 这次会话完成后是否已写进流水（防重复入账）
    pub activity: String,    // 陪伴活动（守烛idle/typing/reading/writing），流水记账用
    pub acc_work_ms: u64,    // 实际专注毫秒（跳过/暂停/放弃都按真实经过时间算，流水入账用）
    pub acc_rest_ms: u64,    // 实际休息毫秒
    pub mark_ms: u64,        // 上次记账时刻；所有推进时间的路径都要过 credit()
}

/// 实际时长记账：把 [mark_ms, upto) 计入当前段的种类。
/// 幂等（同一 now 重复调加零）；暂停/等待期间不会被调到，所以那些时间不入账。
fn credit(s: &mut Session, upto: u64) {
    if upto <= s.mark_ms {
        return;
    }
    let add = upto - s.mark_ms;
    if let Some(st) = s.stages.get(s.idx) {
        if st.kind == "work" {
            s.acc_work_ms += add;
        } else {
            s.acc_rest_ms += add;
        }
    }
    s.mark_ms = upto;
}

impl Session {
    pub fn idle() -> Self {
        Session { status: "idle".into(), ..Default::default() }
    }
    fn is_active(&self) -> bool {
        matches!(self.status.as_str(), "running" | "paused" | "awaiting")
    }
    fn cur(&self) -> Option<&Stage> {
        self.stages.get(self.idx)
    }
}

/// 惰性投影：把会话推演到 now 时刻。可能连续吃掉多个自动衔接的阶段。
pub fn project(s: &mut Session, cfg: &Settings, now: u64) {
    while s.status == "running" && now >= s.end_ms {
        let end = s.end_ms;
        credit(s, end);
        if s.idx + 1 >= s.stages.len() {
            s.status = "done".into();
            return;
        }
        let cur_kind = s.stages[s.idx].kind.clone();
        let next_kind = s.stages[s.idx + 1].kind.clone();
        let auto = if cur_kind == "work" && next_kind == "break" {
            // 强制休息：工作→休息必然自动进入（FE-40①，覆盖开关）
            cfg.auto_work_to_break || cfg.rest_policy == "forced"
        } else if cur_kind == "break" && next_kind == "work" {
            cfg.auto_break_to_work
        } else {
            true // 同类相接（工作→工作）没有伦理问题，直接续
        };
        if auto {
            s.idx += 1;
            s.end_ms += s.stages[s.idx].secs * 1000;
        } else {
            s.status = "awaiting".into();
            s.awaiting_since = s.end_ms; // 等待从"那一段真正结束的时刻"算起（惰性投影也准确）
            return;
        }
    }
    if s.status == "running" {
        credit(s, now);
    }
}

/// 强制休息护栏：当前是否处于"锁定的休息阶段"。
/// awaiting 状态不锁 —— 那时休息已经走完，开始下一段工作天经地义。
pub fn rest_locked(s: &Session, cfg: &Settings) -> bool {
    if cfg.rest_policy != "forced" {
        return false;
    }
    if !matches!(s.status.as_str(), "running" | "paused") {
        return false;
    }
    match s.cur() {
        Some(st) if st.kind == "break" => {
            let is_final = s.idx + 1 == s.stages.len();
            !(is_final && cfg.final_break_unlock)
        }
        _ => false,
    }
}

fn remaining(s: &Session, now: u64) -> u64 {
    match s.status.as_str() {
        "running" => s.end_ms.saturating_sub(now),
        "paused" => s.remain_ms,
        _ => 0,
    }
}

/// 会话指令。返回 Err(文案) 表示被内核拒绝（UI 原样 Toast）。
/// unlock_consumed 由调用方检查：为 true 时把 settings.final_break_unlock 复位并落盘。
#[derive(Debug)]
pub struct CmdOutcome {
    pub unlock_consumed: bool,
}

pub fn apply(
    s: &mut Session,
    cfg: &Settings,
    cmd: &str,
    now: u64,
) -> Result<CmdOutcome, String> {
    project(s, cfg, now);
    let mut out = CmdOutcome { unlock_consumed: false };
    // 强制休息里被放行的动作要消耗掉那一次解锁
    let locked_zone = cfg.rest_policy == "forced"
        && matches!(s.status.as_str(), "running" | "paused")
        && s.cur().map(|st| st.kind == "break").unwrap_or(false);

    match cmd {
        "pause" => {
            if s.status != "running" {
                return Err("现在没有在计时".into());
            }
            s.remain_ms = s.end_ms.saturating_sub(now);
            s.status = "paused".into();
        }
        "resume" => {
            if s.status != "paused" {
                return Err("现在不是暂停状态".into());
            }
            s.end_ms = now + s.remain_ms;
            s.status = "running".into();
            s.mark_ms = now; // 暂停期间不入账
        }
        "skip" | "prev" | "reset_stage" => {
            if !s.is_active() {
                return Err("现在没有会话".into());
            }
            if rest_locked(s, cfg) {
                return Err("强制休息中，好好歇一会儿".into());
            }
            if locked_zone {
                out.unlock_consumed = true; // 最后一段休息 + 已解锁 → 放行并用掉
            }
            match cmd {
                "skip" => {
                    if s.status == "awaiting" || s.idx + 1 < s.stages.len() {
                        s.idx += 1;
                        s.end_ms = now + s.stages[s.idx].secs * 1000;
                        s.status = "running".into();
                        s.mark_ms = now;
                    } else {
                        s.status = "done".into();
                    }
                }
                "prev" => {
                    if s.status == "awaiting" {
                        // 停在段间：回到刚走完那一段的开头
                        s.end_ms = now + s.stages[s.idx].secs * 1000;
                    } else if s.idx > 0 {
                        s.idx -= 1;
                        s.end_ms = now + s.stages[s.idx].secs * 1000;
                    } else {
                        s.end_ms = now + s.stages[0].secs * 1000;
                    }
                    s.status = "running".into();
                    s.mark_ms = now;
                }
                "reset_stage" => {
                    let dur = s.stages[s.idx].secs * 1000;
                    match s.status.as_str() {
                        "running" => s.end_ms = now + dur,
                        "paused" => s.remain_ms = dur,
                        _ => {
                            s.end_ms = now + dur;
                            s.status = "running".into();
                            s.mark_ms = now;
                        }
                    }
                }
                _ => unreachable!(),
            }
        }
        "start_next" => {
            if s.status != "awaiting" {
                return Err("现在不在段间等待".into());
            }
            s.idx += 1;
            s.end_ms = now + s.stages[s.idx].secs * 1000;
            s.status = "running".into();
            s.mark_ms = now;
        }
        "stop" => {
            *s = Session::idle();
        }
        other => return Err(format!("未知指令 {other}")),
    }
    Ok(out)
}

pub fn start_session(plan: &Plan, now: u64) -> Result<Session, String> {
    if plan.stages.is_empty() {
        return Err("序列是空的，先加一段".into());
    }
    for st in &plan.stages {
        if st.secs < MIN_STAGE_SEC || st.secs > MAX_STAGE_SEC {
            return Err("阶段时长要在 5 秒到 4 小时之间".into());
        }
    }
    Ok(Session {
        status: "running".into(),
        plan_id: plan.id.clone(),
        plan_name: plan.name.clone(),
        stages: plan.stages.clone(),
        idx: 0,
        end_ms: now + plan.stages[0].secs * 1000,
        remain_ms: 0,
        started_ms: now,
        awaiting_since: 0,
        logged: false,
        activity: String::new(),
        acc_work_ms: 0,
        acc_rest_ms: 0,
        mark_ms: now,
    })
}

/// 重启恢复（FE-39）：上次退出时若在跑，按"退出即暂停"折算 —— 退出后流逝的时间不算专注。
pub fn restore(mut s: Session, cfg: &Settings, saved_at: u64) -> Session {
    if s.status == "running" {
        project(&mut s, cfg, saved_at);
        if s.status == "running" {
            s.remain_ms = s.end_ms.saturating_sub(saved_at);
            s.status = "paused".into();
        }
    }
    s
}

/// 内置预设（FE-17）。plans.json 里没有时补种；builtin 只读由前端约束。
pub fn builtin_plans() -> Vec<Plan> {
    fn seq(pairs: &[(&str, u64)]) -> Vec<Stage> {
        pairs.iter().map(|(k, s)| Stage { kind: (*k).into(), secs: *s }).collect()
    }
    let classic = {
        let mut v = Vec::new();
        for i in 0..4 {
            v.push(Stage { kind: "work".into(), secs: 25 * 60 });
            v.push(Stage { kind: "break".into(), secs: if i == 3 { 15 * 60 } else { 5 * 60 } });
        }
        v
    };
    #[allow(unused_mut)]
    let mut v = vec![
        Plan { id: "classic".into(), name: "经典番茄".into(), stages: classic, builtin: true },
        Plan { id: "p5217".into(), name: "52 / 17".into(), stages: seq(&[("work", 52 * 60), ("break", 17 * 60)]), builtin: true },
        Plan { id: "p9020".into(), name: "90 / 20 深工作".into(), stages: seq(&[("work", 90 * 60), ("break", 20 * 60)]), builtin: true },
    ];
    // 冲刺预设只进 debug 构建：正式包用户不该看到测试用序列
    #[cfg(debug_assertions)]
    v.push(Plan { id: "sprint5".into(), name: "5 秒冲刺（测试）".into(), stages: seq(&[("work", 5), ("break", 5), ("work", 5)]), builtin: true });
    v
}

/// 给前端的快照：附上派生量，前端不用自己算
#[derive(Serialize, Clone)]
pub struct View {
    #[serde(flatten)]
    pub session: Session,
    pub remaining_ms: u64,
    pub rest_locked: bool,
    pub now: u64,
}

pub fn view(s: &Session, cfg: &Settings, now: u64) -> View {
    View {
        remaining_ms: remaining(s, now),
        rest_locked: rest_locked(s, cfg),
        session: s.clone(),
        now,
    }
}

// ——————————————————————————————————————————————————————————
#[cfg(test)]
mod tests {
    use super::*;

    fn plan(pairs: &[(&str, u64)]) -> Plan {
        Plan {
            id: "t".into(),
            name: "测试".into(),
            stages: pairs.iter().map(|(k, s)| Stage { kind: (*k).into(), secs: *s }).collect(),
            builtin: false,
        }
    }

    #[test]
    fn auto_chain_eats_multiple_stages() {
        // 工作→休息自动、休息→工作也开自动：睡一觉回来应该一口气推到正确位置
        let mut cfg = Settings::default();
        cfg.auto_break_to_work = true;
        let p = plan(&[("work", 60), ("break", 30), ("work", 60), ("break", 30)]);
        let mut s = start_session(&p, 0).unwrap();
        project(&mut s, &cfg, 100_000); // 100s：60+30 过完，第三段走到 10s
        assert_eq!(s.idx, 2);
        assert_eq!(s.status, "running");
        assert_eq!(s.end_ms, 150_000);
        project(&mut s, &cfg, 999_000); // 远超总长 → done
        assert_eq!(s.status, "done");
    }

    #[test]
    fn manual_boundary_waits() {
        // 休息→工作默认手动：休息走完停在 awaiting，等多久都不偷跑
        let cfg = Settings::default();
        let p = plan(&[("work", 60), ("break", 30), ("work", 60)]);
        let mut s = start_session(&p, 0).unwrap();
        project(&mut s, &cfg, 95_000); // 工作完(auto)→休息完(90s)→该等手动
        assert_eq!(s.status, "awaiting");
        assert_eq!(s.idx, 1); // idx 停在走完的休息段
        project(&mut s, &cfg, 500_000);
        assert_eq!(s.status, "awaiting"); // 不偷跑
        apply(&mut s, &cfg, "start_next", 500_000).unwrap();
        assert_eq!(s.idx, 2);
        assert_eq!(s.end_ms, 560_000);
    }

    #[test]
    fn pause_resume_is_exact() {
        let cfg = Settings::default();
        let p = plan(&[("work", 60), ("break", 30)]);
        let mut s = start_session(&p, 0).unwrap();
        apply(&mut s, &cfg, "pause", 20_000).unwrap();
        assert_eq!(s.remain_ms, 40_000);
        apply(&mut s, &cfg, "resume", 1_000_000).unwrap(); // 暂停了很久
        assert_eq!(s.end_ms, 1_040_000); // 剩余原封不动接上
    }

    #[test]
    fn forced_rest_blocks_and_final_unlock_consumes() {
        let mut cfg = Settings::default();
        cfg.rest_policy = "forced".into();
        cfg.auto_break_to_work = false;
        let p = plan(&[("work", 60), ("break", 30), ("work", 60), ("break", 30)]);
        let mut s = start_session(&p, 0).unwrap();
        // 强制模式：工作→休息自动进入（即使把开关关掉）
        cfg.auto_work_to_break = false;
        project(&mut s, &cfg, 70_000);
        assert_eq!(s.idx, 1);
        assert_eq!(s.status, "running");
        // 休息中跳过/回退/重置全被拒
        assert!(apply(&mut s, &cfg, "skip", 75_000).is_err());
        assert!(apply(&mut s, &cfg, "prev", 75_000).is_err());
        assert!(apply(&mut s, &cfg, "reset_stage", 75_000).is_err());
        // 暂停/继续放行（暂停 15s 后 end 顺延到 91s）
        apply(&mut s, &cfg, "pause", 75_000).unwrap();
        apply(&mut s, &cfg, "resume", 76_000).unwrap();
        assert_eq!(s.end_ms, 91_000);
        assert!(apply(&mut s, &cfg, "skip", 80_000).is_err()); // 还在休息，仍被拒
        project(&mut s, &cfg, 91_000);
        assert_eq!(s.status, "awaiting"); // 休息完等手动开工作（awaiting 不锁）
        apply(&mut s, &cfg, "start_next", 91_000).unwrap(); // 工作到 151s
        project(&mut s, &cfg, 160_000); // 工作完(151s)→强制自动进最后一段休息(到 181s)
        assert_eq!(s.idx, 3);
        assert_eq!(s.status, "running");
        assert!(apply(&mut s, &cfg, "skip", 160_000).is_err()); // 未解锁仍拒
        cfg.final_break_unlock = true; // 设置里解锁一次
        let out = apply(&mut s, &cfg, "skip", 160_000).unwrap();
        assert!(out.unlock_consumed); // 用掉了，调用方负责复位
        assert_eq!(s.status, "done");
    }

    #[test]
    fn restore_treats_exit_as_pause() {
        let cfg = Settings::default();
        let p = plan(&[("work", 60), ("break", 30)]);
        let s = start_session(&p, 0).unwrap();
        let r = restore(s, &cfg, 20_000); // 退出那一刻走了 20s
        assert_eq!(r.status, "paused");
        assert_eq!(r.remain_ms, 40_000);
        // 退出时其实已经跑完工作+休息、停在"休息→工作"的手动边界 → 恢复成 awaiting
        let p3 = plan(&[("work", 60), ("break", 30), ("work", 60)]);
        let s2 = start_session(&p3, 0).unwrap();
        let r2 = restore(s2, &cfg, 95_000);
        assert_eq!(r2.status, "awaiting");
    }

    #[test]
    fn actual_time_accounting() {
        // 实际时长记账：暂停不算、跳过只算真跑过的、放弃前的部分也在账上
        let cfg = Settings::default();
        let p = plan(&[("work", 60), ("break", 30), ("work", 60)]);
        let mut s = start_session(&p, 0).unwrap();
        apply(&mut s, &cfg, "pause", 20_000).unwrap(); // 工作 20s
        assert_eq!(s.acc_work_ms, 20_000);
        apply(&mut s, &cfg, "resume", 100_000).unwrap(); // 暂停 80s 不入账
        project(&mut s, &cfg, 110_000); // 再工作 10s
        assert_eq!(s.acc_work_ms, 30_000);
        apply(&mut s, &cfg, "skip", 110_000).unwrap(); // 工作还剩 30s 直接跳进休息
        assert_eq!(s.acc_work_ms, 30_000);
        project(&mut s, &cfg, 125_000); // 休息 15s
        assert_eq!(s.acc_rest_ms, 15_000);
        apply(&mut s, &cfg, "skip", 125_000).unwrap(); // 跳进最后一段工作
        project(&mut s, &cfg, 130_000); // 工作 5s 后放弃
        assert_eq!(s.acc_work_ms, 35_000);
        assert_eq!(s.acc_rest_ms, 15_000);
        // 整段自然跑完的账也对：睡一觉回来一口气投影
        let mut s2 = start_session(&plan(&[("work", 60), ("break", 30)]), 0).unwrap();
        let mut cfg2 = Settings::default();
        cfg2.auto_break_to_work = true;
        project(&mut s2, &cfg2, 999_000);
        assert_eq!(s2.status, "done");
        assert_eq!(s2.acc_work_ms, 60_000);
        assert_eq!(s2.acc_rest_ms, 30_000);
    }

    #[test]
    fn stage_bounds_checked() {
        assert!(start_session(&plan(&[("work", 4)]), 0).is_err());
        assert!(start_session(&plan(&[("work", 4 * 3600 + 1)]), 0).is_err());
        assert!(start_session(&plan(&[]), 0).is_err());
    }
}
