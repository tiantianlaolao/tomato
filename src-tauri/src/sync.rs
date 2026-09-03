// 跨设备同步的本地半边（2026-09-03，用户拍板：参考戳了么，记录级 LWW，全量同步含定时计划）。
//
// 分工：服务端是哑仓库（capyroom-server /api/sync，kind/id/data/mtime/seq）；推拉、队列、游标在前端
// account.js；**本地数据归 Rust 管**，所以"导出快照"和"导入合并"这两步在这里——前端只搬运字节。
//
// 命名空间（kind / id）：
//   session  / <started_ms>   流水一行一条，只增不删，mtime = ended_ms（它天然不变，两台设备永远一致）
//   plan     / <id>           自定义序列（内置的不同步），mtime = updated_ms；data=null 墓碑
//   schedule / <id>           定时计划（9-3 用户定：一起同步），同上
//   rewards  / rewards        奖励状态整个文件：**并集优先**——攒来的/买来的只增不减，挂着/摆着按 LWW（rewards.rs merge_remote）
//   settings / settings       只同步"偏好"子集（SYNC_KEYS），设备相关的（自启/桌宠/授权占位）不动
//
// 🔴 mtime 纪律（防回声环）：导入时把本地 updated_ms 设成**远端的 mtime**，不是 now——设成 now 会让本机
//    下次快照比服务端新、再推一遍、对端再合一遍、再设 now……两台设备互相推到天荒地老。
//    唯一例外是 rewards 并集真的合出了对端没有的东西，那份必须以 now 推上去（rewards.rs 里判）。
use crate::core::{Plan, Settings};
use crate::Schedule;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::Path;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Item { pub id: String, pub data: String, pub mtime: u64 }

#[derive(Serialize, Clone, Debug)]
pub struct Snapshot {
    pub sessions: Vec<Item>,
    pub plans: Vec<Item>,
    pub schedules: Vec<Item>,
    pub rewards: Item,
    pub settings: Item,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Change { pub kind: String, pub id: String, #[serde(default)] pub data: Option<String>, pub mtime: u64 }

#[derive(Serialize, Default, Clone, Debug)]
pub struct Report {
    pub applied: usize,
    pub sessions_added: usize,
    pub plans_changed: bool,
    pub schedules_changed: bool,
    pub rewards_changed: bool,
    pub settings_changed: bool,
}

/// 参与同步的设置项。license / autostart / launch_mode / pet_hidden 是"这台机器"的事，不跨设备。
pub const SYNC_KEYS: &[&str] = &[
    "auto_work_to_break", "auto_break_to_work", "rest_policy", "final_break_unlock", "sound_on", "volume",
    "pre_alert_sec", "theme", "selected_plan_id", "sound_id", "sit_remind_min", "strong_remind", "lang",
];

pub fn settings_body(s: &Settings) -> serde_json::Value {
    let full = serde_json::to_value(s).unwrap_or(serde_json::Value::Null);
    let mut out = serde_json::Map::new();
    for k in SYNC_KEYS { if let Some(v) = full.get(*k) { out.insert((*k).to_string(), v.clone()); } }
    serde_json::Value::Object(out)
}

/// 把远端的偏好子集盖到本地设置上（只碰 SYNC_KEYS 里的键，别的原样）
pub fn apply_settings(s: &mut Settings, v: &serde_json::Value) {
    let mut full = serde_json::to_value(&*s).unwrap_or(serde_json::Value::Null);
    if let (Some(dst), Some(src)) = (full.as_object_mut(), v.as_object()) {
        for k in SYNC_KEYS { if let Some(x) = src.get(*k) { dst.insert((*k).to_string(), x.clone()); } }
    }
    if let Ok(n) = serde_json::from_value::<Settings>(full) { let keep = s.updated_ms; *s = n; s.updated_ms = keep; }
}

/// 序列的"内容"（不含 updated_ms），用来判有没有真的改
pub fn plan_body(p: &Plan) -> String {
    serde_json::to_string(&(&p.name, &p.stages)).unwrap_or_default()
}
/// 定时计划的"内容"：last_fired / pre_alerted 是运行痕迹（滴答线程天天改），不算修改
pub fn schedule_body(s: &Schedule) -> String {
    serde_json::to_string(&(&s.plan_id, &s.mode, s.trigger_at, &s.time, &s.weekdays, s.enabled, &s.name, &s.stages)).unwrap_or_default()
}

fn history_lines(dir: &Path) -> Vec<(u64, String)> {
    let txt = fs::read_to_string(dir.join("history.jsonl")).unwrap_or_default();
    txt.lines().filter_map(|l| {
        let v: serde_json::Value = serde_json::from_str(l).ok()?;
        let started = v.get("started_ms")?.as_u64()?;
        Some((started, serde_json::to_string(&v).ok()?))
    }).collect()
}

pub fn snapshot(dir: &Path, settings: &Settings, plans: &[Plan], schedules: &[Schedule]) -> Snapshot {
    let sessions = history_lines(dir).into_iter().map(|(started, line)| {
        let ended = serde_json::from_str::<serde_json::Value>(&line).ok()
            .and_then(|v| v.get("ended_ms").and_then(|x| x.as_u64())).unwrap_or(started);
        Item { id: started.to_string(), data: line, mtime: ended.max(1) }
    }).collect();
    let plans = plans.iter().filter(|p| !p.builtin).map(|p| Item {
        id: p.id.clone(), data: serde_json::to_string(p).unwrap_or_default(), mtime: p.updated_ms.max(1),
    }).collect();
    let schedules = schedules.iter().map(|s| Item {
        id: s.id.clone(), data: serde_json::to_string(s).unwrap_or_default(), mtime: s.updated_ms.max(1),
    }).collect();
    let (rj, rm) = crate::rewards::snapshot_json(dir);
    Snapshot {
        sessions, plans, schedules,
        rewards: Item { id: "rewards".into(), data: rj, mtime: rm.max(1) },
        settings: Item { id: "settings".into(), data: settings_body(settings).to_string(), mtime: settings.updated_ms.max(1) },
    }
}

pub fn import(dir: &Path, settings: &mut Settings, plans: &mut Vec<Plan>, schedules: &mut Vec<Schedule>, changes: &[Change], now_ms: u64) -> Report {
    let mut rep = Report::default();
    let mut have: HashSet<u64> = history_lines(dir).into_iter().map(|(s, _)| s).collect();
    for c in changes {
        match c.kind.as_str() {
            "session" => {
                // 只增不删：墓碑忽略；同一 started_ms 已有就跳过
                let Some(data) = &c.data else { continue };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                let Some(started) = v.get("started_ms").and_then(|x| x.as_u64()) else { continue };
                if have.contains(&started) { continue; }
                if let Ok(line) = serde_json::to_string(&v) {
                    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(dir.join("history.jsonl")) {
                        let _ = writeln!(f, "{line}");
                        have.insert(started); rep.sessions_added += 1; rep.applied += 1;
                    }
                }
            }
            "plan" => {
                let pos = plans.iter().position(|p| p.id == c.id && !p.builtin);
                if let Some(i) = pos { if plans[i].updated_ms >= c.mtime { continue; } }
                match &c.data {
                    None => { if let Some(i) = pos { plans.remove(i); rep.plans_changed = true; rep.applied += 1; } }
                    Some(d) => {
                        let Ok(mut p) = serde_json::from_str::<Plan>(d) else { continue };
                        if p.builtin { continue; }
                        p.id = c.id.clone(); p.updated_ms = c.mtime;
                        if let Some(i) = pos { plans[i] = p; } else { plans.push(p); }
                        rep.plans_changed = true; rep.applied += 1;
                    }
                }
            }
            "schedule" => {
                let pos = schedules.iter().position(|s| s.id == c.id);
                if let Some(i) = pos { if schedules[i].updated_ms >= c.mtime { continue; } }
                match &c.data {
                    None => { if let Some(i) = pos { schedules.remove(i); rep.schedules_changed = true; rep.applied += 1; } }
                    Some(d) => {
                        let Ok(mut s) = serde_json::from_str::<Schedule>(d) else { continue };
                        s.id = c.id.clone(); s.updated_ms = c.mtime;
                        if let Some(i) = pos { schedules[i] = s; } else { schedules.push(s); }
                        rep.schedules_changed = true; rep.applied += 1;
                    }
                }
            }
            "rewards" => {
                let Some(d) = &c.data else { continue };
                if crate::rewards::merge_remote(dir, d, c.mtime, now_ms) { rep.rewards_changed = true; rep.applied += 1; }
            }
            "settings" => {
                let Some(d) = &c.data else { continue };
                if settings.updated_ms >= c.mtime { continue; }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(d) else { continue };
                apply_settings(settings, &v);
                settings.updated_ms = c.mtime;
                rep.settings_changed = true; rep.applied += 1;
            }
            _ => {}   // 未来版本的新 kind：安静跳过
        }
    }
    rep
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::Stage;
    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("capy-sync-{name}"));
        let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d
    }
    fn plan(id: &str, name: &str, up: u64) -> Plan {
        Plan { id: id.into(), name: name.into(), stages: vec![Stage { kind: "work".into(), secs: 60, activity: String::new() }], builtin: false, updated_ms: up }
    }
    fn rec(started: u64, ended: u64) -> String {
        format!(r#"{{"plan_name":"x","completed":true,"started_ms":{started},"ended_ms":{ended},"work_secs":1500,"rest_secs":0,"activity":"","stages":[{{"kind":"work","secs":1500,"activity":""}}]}}"#)
    }

    #[test]
    fn sessions_append_dedupe_and_snapshot_mtime() {
        let d = tmp("sess");
        fs::write(d.join("history.jsonl"), rec(100, 200) + "\n").unwrap();
        let mut s = Settings::default(); let mut p = vec![]; let mut sc = vec![];
        let ch = vec![
            Change { kind: "session".into(), id: "100".into(), data: Some(rec(100, 200)), mtime: 200 },   // 已有，跳过
            Change { kind: "session".into(), id: "300".into(), data: Some(rec(300, 400)), mtime: 400 },   // 新的，追加
            Change { kind: "session".into(), id: "300".into(), data: Some(rec(300, 400)), mtime: 400 },   // 同批重复，只加一次
            Change { kind: "session".into(), id: "999".into(), data: None, mtime: 5 },                   // 墓碑忽略
        ];
        let r = import(&d, &mut s, &mut p, &mut sc, &ch, 1000);
        assert_eq!(r.sessions_added, 1);
        let snap = snapshot(&d, &s, &p, &sc);
        assert_eq!(snap.sessions.len(), 2);
        assert_eq!(snap.sessions[1].id, "300"); assert_eq!(snap.sessions[1].mtime, 400);
    }

    #[test]
    fn plans_lww_and_tombstone_no_echo() {
        let d = tmp("plans");
        let mut s = Settings::default(); let mut sc = vec![];
        let mut p = vec![plan("a", "本地新", 500), plan("b", "要被删", 100)];
        let ch = vec![
            Change { kind: "plan".into(), id: "a".into(), data: Some(serde_json::to_string(&plan("a", "远端旧", 300)).unwrap()), mtime: 300 },  // 旧，丢
            Change { kind: "plan".into(), id: "b".into(), data: None, mtime: 200 },                                                        // 墓碑，删
            Change { kind: "plan".into(), id: "c".into(), data: Some(serde_json::to_string(&plan("c", "远端新", 0)).unwrap()), mtime: 700 }, // 新增
        ];
        let r = import(&d, &mut s, &mut p, &mut sc, &ch, 1000);
        assert!(r.plans_changed);
        assert_eq!(p.iter().find(|x| x.id == "a").unwrap().name, "本地新");
        assert!(p.iter().all(|x| x.id != "b"));
        let c = p.iter().find(|x| x.id == "c").unwrap();
        assert_eq!(c.updated_ms, 700, "导入后 updated_ms = 远端 mtime，不是 now（防回声）");
        // 内置序列不进快照
        p.push(Plan { builtin: true, ..plan("classic", "经典", 0) });
        assert!(snapshot(&d, &s, &p, &sc).plans.iter().all(|i| i.id != "classic"));
    }

    #[test]
    fn settings_subset_only() {
        let d = tmp("set");
        let mut s = Settings::default(); s.autostart = true; s.pet_hidden = true;
        let mut p = vec![]; let mut sc = vec![];
        let remote = serde_json::json!({"lang":"en","sound_id":"wood","autostart":false,"pet_hidden":false,"license":"HACK"});
        let ch = vec![Change { kind: "settings".into(), id: "settings".into(), data: Some(remote.to_string()), mtime: 900 }];
        let r = import(&d, &mut s, &mut p, &mut sc, &ch, 1000);
        assert!(r.settings_changed);
        assert_eq!(s.lang, "en"); assert_eq!(s.sound_id, "wood");
        assert!(s.autostart && s.pet_hidden, "设备相关项不受远端影响");
        assert_eq!(s.license, "", "license 不同步");
        assert_eq!(s.updated_ms, 900);
        let body = settings_body(&s);
        assert!(body.get("autostart").is_none() && body.get("lang").is_some());
        // 更旧的远端不覆盖
        let ch2 = vec![Change { kind: "settings".into(), id: "settings".into(), data: Some(serde_json::json!({"lang":"zh"}).to_string()), mtime: 800 }];
        import(&d, &mut s, &mut p, &mut sc, &ch2, 1000);
        assert_eq!(s.lang, "en");
    }
}
