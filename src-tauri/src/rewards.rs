//! P3 奖励载体（2026-09-02 定案，见 `P3奖励载体玩法定义.md`）。
//!
//! 账本单位＝专注分钟，不设新货币。真相源是 history.jsonl：每次调用**重算**，不单独存累计分钟，
//! 免得两份账对不上。状态落 rewards.json；目录 rewards_catalog.json 与前端是同一份文件
//! （include_str! 编进二进制，前端按相对路径 fetch 同一份），改数不改代码。
//!
//! 四线口径：
//! - 汤札牌：每天首次完成会话＝一个印，只攒不卖（这里只算"来访天数"，画牌是前端的事）
//! - 手拭巾：累计分钟到里程碑即可领（earn），或直接买（buy）
//! - 庭院小物：花可用分钟换（earn，扣 spent_min），或直接买
//! - 访客：累计来访天数到即可领，或直接买
//! 红线：分钟永不衰减、放弃会话不计、单会话按工作段数×60 分钟封顶（堵"一段三小时"）。
use chrono::{Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

pub const CATALOG: &str = include_str!("../../src-mobile/assets/rewards_catalog.json");
/// 单个工作段计入上限（分钟）
pub const SEG_CAP_MIN: u64 = 60;

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct ThemeState {
    #[serde(default)] pub towels: Vec<String>,
    #[serde(default)] pub hung: String,
    #[serde(default)] pub props: Vec<String>,
    #[serde(default)] pub placed: BTreeMap<String, String>, // slot -> prop id
    #[serde(default)] pub visitors: Vec<String>,
    #[serde(default)] pub purchases: Vec<Purchase>,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Purchase { pub sku: String, pub at: u64 }

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct RewardsFile {
    #[serde(default)] pub spent_min: u64,
    #[serde(default)] pub themes: BTreeMap<String, ThemeState>,
}

#[derive(Serialize, Clone, Default, Debug)]
pub struct Ledger {
    pub total_min: u64,
    pub spent_min: u64,
    pub avail_min: u64,
    pub sessions_done: u32,
    pub visit_days: u32,       // 有过完成会话的天数（累计，访客触发用）
    pub month: String,         // "2026-09"
    pub month_days: Vec<u32>,  // 本月盖了印的日子（1..31）
}

#[derive(Serialize, Clone, Debug)]
pub struct RewardsView {
    pub ledger: Ledger,
    pub state: ThemeState,
    pub catalog: serde_json::Value,
}

#[derive(Deserialize)]
struct Rec {
    completed: bool,
    #[serde(default)] started_ms: u64,
    #[serde(default)] ended_ms: u64,
    #[serde(default)] work_secs: u64,
    #[serde(default)] stages: Vec<StageLite>,
}
#[derive(Deserialize)]
struct StageLite { kind: String }

/// 一场会话计多少分钟：只算完成的；按实际专注时间；按工作段数 × 60 封顶。
pub fn session_minutes(rec_json: &str) -> Option<u64> {
    let r: Rec = serde_json::from_str(rec_json).ok()?;
    if !r.completed { return None; }
    let works = r.stages.iter().filter(|s| s.kind == "work").count().max(1) as u64;
    Some((r.work_secs / 60).min(SEG_CAP_MIN * works))
}

pub fn ledger_from(history: &str, spent_min: u64, now_ms: u64) -> Ledger {
    let now = Local.timestamp_millis_opt(now_ms as i64).single().unwrap_or_else(Local::now);
    let (cy, cm) = (now.year(), now.month());
    let mut total = 0u64; let mut done = 0u32;
    let mut days: BTreeSet<(i32, u32, u32)> = BTreeSet::new();
    for line in history.lines() {
        let Some(mins) = session_minutes(line) else { continue };
        total += mins; done += 1;
        let r: Rec = match serde_json::from_str(line) { Ok(r) => r, Err(_) => continue };
        let t = if r.ended_ms > 0 { r.ended_ms } else { r.started_ms };
        if let Some(d) = Local.timestamp_millis_opt(t as i64).single() {
            days.insert((d.year(), d.month(), d.day()));
        }
    }
    let month_days: Vec<u32> = days.iter().filter(|(y, m, _)| *y == cy && *m == cm).map(|(_, _, d)| *d).collect();
    Ledger {
        total_min: total, spent_min, avail_min: total.saturating_sub(spent_min),
        sessions_done: done, visit_days: days.len() as u32,
        month: format!("{cy:04}-{cm:02}"), month_days,
    }
}

fn load(dir: &Path) -> RewardsFile {
    fs::read_to_string(dir.join("rewards.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}
fn save(dir: &Path, f: &RewardsFile) {
    if let Ok(s) = serde_json::to_string_pretty(f) { fs::write(dir.join("rewards.json"), s).ok(); }
}
fn catalog_theme(theme: &str) -> serde_json::Value {
    let all: serde_json::Value = serde_json::from_str(CATALOG).unwrap_or(serde_json::Value::Null);
    all.get(theme).cloned().unwrap_or(serde_json::json!({"slots":[],"towels":[],"props":[],"visitors":[]}))
}
fn find<'a>(cat: &'a serde_json::Value, list: &str, id: &str) -> Option<&'a serde_json::Value> {
    cat.get(list)?.as_array()?.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id))
}
fn history_text(dir: &Path) -> String { fs::read_to_string(dir.join("history.jsonl")).unwrap_or_default() }

pub fn view(dir: &Path, theme: &str, now_ms: u64) -> RewardsView {
    let f = load(dir);
    RewardsView {
        ledger: ledger_from(&history_text(dir), f.spent_min, now_ms),
        state: f.themes.get(theme).cloned().unwrap_or_default(),
        catalog: catalog_theme(theme),
    }
}

/// kind: towel | prop | visitor；via: earn | buy。返回更新后的视图；不满足条件返回中文原因（UI 直接显示）。
pub fn unlock(dir: &Path, theme: &str, kind: &str, id: &str, via: &str, now_ms: u64) -> Result<RewardsView, String> {
    let mut f = load(dir);
    let cat = catalog_theme(theme);
    let ledger = ledger_from(&history_text(dir), f.spent_min, now_ms);
    let list = match kind { "towel" => "towels", "prop" => "props", "visitor" => "visitors", _ => return Err("不认识的种类".into()) };
    let item = find(&cat, list, id).ok_or_else(|| "目录里没有这件".to_string())?.clone();
    let st = f.themes.entry(theme.to_string()).or_default();
    let owned = match kind { "towel" => &mut st.towels, "prop" => &mut st.props, _ => &mut st.visitors };
    if owned.iter().any(|x| x == id) { return Err("已经有了".into()); }
    let mut spend = 0u64;
    match via {
        "earn" => match kind {
            "towel" => {
                let need = item.get("min").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
                if ledger.total_min < need { return Err(format!("还差 {} 分钟", need - ledger.total_min)); }
            }
            "prop" => {
                let cost = item.get("cost_min").and_then(|v| v.as_u64()).unwrap_or(u64::MAX);
                if ledger.avail_min < cost { return Err(format!("可用分钟不够，还差 {} 分钟", cost - ledger.avail_min)); }
                spend = cost;
            }
            _ => {
                let need = item.get("days").and_then(|v| v.as_u64()).unwrap_or(u64::MAX) as u32;
                if ledger.visit_days < need { return Err(format!("再来 {} 天它就会来", need - ledger.visit_days)); }
            }
        },
        "buy" => st.purchases.push(Purchase { sku: format!("{theme}.{kind}.{id}"), at: now_ms }),
        _ => return Err("不认识的方式".into()),
    }
    owned.push(id.to_string());
    if kind == "towel" && st.hung.is_empty() { st.hung = id.to_string(); }
    f.spent_min += spend;
    save(dir, &f);
    Ok(view(dir, theme, now_ms))
}

/// 把已有小物摆进槽位（id 空＝撤下）。槽位必须与目录里该小物的 slot 一致。
pub fn place(dir: &Path, theme: &str, slot: &str, id: &str, now_ms: u64) -> Result<RewardsView, String> {
    let mut f = load(dir);
    let cat = catalog_theme(theme);
    if find(&cat, "slots", slot).is_none() { return Err("没有这个位置".into()); }
    let st = f.themes.entry(theme.to_string()).or_default();
    if id.is_empty() { st.placed.remove(slot); }
    else {
        if !st.props.iter().any(|x| x == id) { return Err("还没有这件".into()); }
        let want = find(&cat, "props", id).and_then(|p| p.get("slot")).and_then(|v| v.as_str()).unwrap_or("");
        if want != slot { return Err("这件放不到这个位置".into()); }
        // 同一件不能同时摆两处
        st.placed.retain(|_, v| v != id);
        st.placed.insert(slot.to_string(), id.to_string());
    }
    save(dir, &f);
    Ok(view(dir, theme, now_ms))
}

/// 挂哪条手拭巾（id 空＝不挂）。
pub fn hang(dir: &Path, theme: &str, id: &str, now_ms: u64) -> Result<RewardsView, String> {
    let mut f = load(dir);
    let st = f.themes.entry(theme.to_string()).or_default();
    if !id.is_empty() && !st.towels.iter().any(|x| x == id) { return Err("还没有这条".into()); }
    st.hung = id.to_string();
    save(dir, &f);
    Ok(view(dir, theme, now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rec(completed: bool, work_secs: u64, works: usize, ended_ms: u64) -> String {
        let stages: Vec<String> = (0..works).map(|_| r#"{"kind":"work","secs":1500}"#.to_string()).collect();
        format!(r#"{{"plan_name":"x","completed":{completed},"started_ms":{},"ended_ms":{ended_ms},"work_secs":{work_secs},"rest_secs":0,"activity":"","stages":[{}]}}"#,
            ended_ms.saturating_sub(1000), stages.join(","))
    }
    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tomato_rewards_{}", std::process::id()));
        let _ = fs::remove_dir_all(&d); fs::create_dir_all(&d).unwrap(); d
    }
    const DAY: u64 = 86_400_000;

    #[test]
    fn minutes_only_completed_and_capped() {
        assert_eq!(session_minutes(&rec(false, 3000, 1, 1_800_000_000_000)), None);
        assert_eq!(session_minutes(&rec(true, 1500, 1, 1_800_000_000_000)), Some(25));
        // 一段工作 3 小时 → 封顶 60
        assert_eq!(session_minutes(&rec(true, 10800, 1, 1_800_000_000_000)), Some(60));
        // 两段工作各 90 分钟 → 封顶 120
        assert_eq!(session_minutes(&rec(true, 10800, 2, 1_800_000_000_000)), Some(120));
    }

    #[test]
    fn ledger_days_and_month() {
        let now = 1_800_000_000_000u64;
        let h = [rec(true, 1500, 1, now - 2 * DAY), rec(true, 1500, 1, now - 2 * DAY + 60_000),
                 rec(true, 600, 1, now - DAY), rec(false, 5000, 1, now)].join("\n");
        let l = ledger_from(&h, 5, now);
        assert_eq!(l.total_min, 25 + 25 + 10);
        assert_eq!(l.spent_min, 5);
        assert_eq!(l.avail_min, 55);
        assert_eq!(l.sessions_done, 3);
        assert_eq!(l.visit_days, 2, "同一天两场只算一个印，放弃的不算");
        assert!(l.month_days.len() <= 2);
    }

    #[test]
    fn unlock_earn_buy_place_hang() {
        let d = tmp(); let now = 1_800_000_000_000u64;
        // 5 场完成，每场 25 分钟共 125 分钟，跨 5 天（手算：目录里 t01=60 / t02=180 / windbell=120 / orchid=150 / v01=7 天）
        let h: Vec<String> = (0..5).map(|i| rec(true, 1500, 1, now - i * DAY)).collect();
        fs::write(d.join("history.jsonl"), h.join("\n")).unwrap();
        // 手拭巾 t01 要 60 分钟：够
        let v = unlock(&d, "ink", "towel", "t01", "earn", now).unwrap();
        assert_eq!(v.state.towels, vec!["t01"]); assert_eq!(v.state.hung, "t01");
        // t02 要 180：125 不够，报差额 55
        let e = unlock(&d, "ink", "towel", "t02", "earn", now).unwrap_err();
        assert!(e.contains("还差 55"), "{e}");
        // 小物 orchid 150 分钟：可用 125 不够
        assert!(unlock(&d, "ink", "prop", "orchid", "earn", now).is_err());
        // windbell 120：够，扣掉后可用 5
        let v = unlock(&d, "ink", "prop", "windbell", "earn", now).unwrap();
        assert_eq!(v.ledger.spent_min, 120); assert_eq!(v.ledger.avail_min, 5);
        assert_eq!(v.ledger.total_min, 125, "累计分钟不因花费而减");
        // 买：不看分钟，记流水
        let v = unlock(&d, "ink", "prop", "koi", "buy", now).unwrap();
        assert_eq!(v.state.purchases.len(), 1);
        // 重复解锁拒绝
        assert!(unlock(&d, "ink", "prop", "koi", "buy", now).is_err());
        // 摆放：位置要对
        assert!(place(&d, "ink", "wall", "windbell", now).is_err());
        let v = place(&d, "ink", "willow", "windbell", now).unwrap();
        assert_eq!(v.state.placed.get("willow").unwrap(), "windbell");
        let v = place(&d, "ink", "willow", "", now).unwrap();
        assert!(v.state.placed.is_empty());
        // 访客：需要 7 天，只有 5 天
        let e = unlock(&d, "ink", "visitor", "v01", "earn", now).unwrap_err();
        assert!(e.contains("再来 2 天"), "{e}");
        // 挂巾
        assert!(hang(&d, "ink", "t08", now).is_err());
        assert_eq!(hang(&d, "ink", "", now).unwrap().state.hung, "");
        let _ = fs::remove_dir_all(&d);
    }
}
