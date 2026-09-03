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
pub struct Purchase { pub sku: String, pub at: u64, #[serde(default)] pub tx: String }   // tx=商店交易号（StoreKit），模拟后端为空

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
pub struct RewardsFile {
    #[serde(default)] pub spent_min: u64,
    #[serde(default)] pub themes: BTreeMap<String, ThemeState>,
    #[serde(default)] pub owned_themes: Vec<String>,   // 买断的主题包（P4；免费主题不在这里）
    #[serde(default)] pub purchases: Vec<Purchase>,    // 主题包购买流水（单件流水在各主题 state 里）
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
    /// 近 400 天每天的专注分钟（"YYYY-MM-DD" → 分钟，只有有完成会话的日子才有键）。
    /// 9-3 汤札改周牌 + 月/年全貌墙要按天深浅，month_days 不够用；400 天够画一整年。
    pub days: BTreeMap<String, u32>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RewardsView {
    pub ledger: Ledger,
    pub state: ThemeState,
    pub catalog: serde_json::Value,
    pub owned_themes: Vec<String>,     // P4：买断的主题包
    pub themes: serde_json::Value,     // 目录里的主题清单（含 paid / 价格 / sku）
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
    let mut per_day: BTreeMap<String, u32> = BTreeMap::new();
    let keep_from = now_ms.saturating_sub(400 * 86_400_000);
    for line in history.lines() {
        let Some(mins) = session_minutes(line) else { continue };
        total += mins; done += 1;
        let r: Rec = match serde_json::from_str(line) { Ok(r) => r, Err(_) => continue };
        let t = if r.ended_ms > 0 { r.ended_ms } else { r.started_ms };
        if let Some(d) = Local.timestamp_millis_opt(t as i64).single() {
            days.insert((d.year(), d.month(), d.day()));
            if t >= keep_from {
                *per_day.entry(format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())).or_insert(0) += mins as u32;
            }
        }
    }
    let month_days: Vec<u32> = days.iter().filter(|(y, m, _)| *y == cy && *m == cm).map(|(_, _, d)| *d).collect();
    Ledger {
        total_min: total, spent_min, avail_min: total.saturating_sub(spent_min),
        sessions_done: done, visit_days: days.len() as u32,
        month: format!("{cy:04}-{cm:02}"), month_days, days: per_day,
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
    let all: serde_json::Value = serde_json::from_str(CATALOG).unwrap_or(serde_json::Value::Null);
    RewardsView {
        ledger: ledger_from(&history_text(dir), f.spent_min, now_ms),
        state: f.themes.get(theme).cloned().unwrap_or_default(),
        catalog: catalog_theme(theme),
        owned_themes: f.owned_themes.clone(),
        themes: all.get("themes").cloned().unwrap_or(serde_json::json!([])),
    }
}

/// 真钱购买（P4）：kind = theme | towel | prop | visitor；tx = 商店交易号（模拟后端传空）。
/// 主题包记在顶层 owned_themes；单件走各主题 state（与 unlock(via=buy) 同一落点，只是多记 tx）。
/// 幂等：已拥有直接返回视图（恢复购买会把同一批商品再送一遍）。
pub fn purchase(dir: &Path, theme: &str, kind: &str, id: &str, tx: &str, now_ms: u64) -> Result<RewardsView, String> {
    if kind == "theme" {
        let mut f = load(dir);
        let all: serde_json::Value = serde_json::from_str(CATALOG).unwrap_or(serde_json::Value::Null);
        let known = all.get("themes").and_then(|v| v.as_array()).map(|a| a.iter().any(|t| t.get("id").and_then(|v| v.as_str()) == Some(id))).unwrap_or(false);
        if !known { return Err("目录里没有这个主题".into()); }
        if !f.owned_themes.iter().any(|x| x == id) {
            f.owned_themes.push(id.to_string());
            f.purchases.push(Purchase { sku: format!("theme.{id}"), at: now_ms, tx: tx.to_string() });
            save(dir, &f);
        }
        return Ok(view(dir, theme, now_ms));
    }
    match unlock(dir, theme, kind, id, "buy", now_ms) {
        Ok(v) => {
            if tx.is_empty() { return Ok(v); }
            let mut f = load(dir);
            if let Some(st) = f.themes.get_mut(theme) { if let Some(p) = st.purchases.last_mut() { p.tx = tx.to_string(); } }
            save(dir, &f);
            Ok(view(dir, theme, now_ms))   // 重读：视图里要带上刚写的 tx
        }
        Err(e) if e == "已经有了" => Ok(view(dir, theme, now_ms)),
        Err(e) => Err(e),
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
        "buy" => st.purchases.push(Purchase { sku: format!("{theme}.{kind}.{id}"), at: now_ms, tx: String::new() }),
        _ => return Err("不认识的方式".into()),
    }
    owned.push(id.to_string());
    if kind == "towel" && st.hung.is_empty() { st.hung = id.to_string(); }
    f.spent_min += spend;
    save(dir, &f);
    Ok(view(dir, theme, now_ms))
}

/// 内测：一键拥有该主题全部单件 + 所有付费主题（交易号记 "internal"，能精确撤回，不碰真买的）。
pub const INTERNAL_TX: &str = "internal";
pub fn grant_all(dir: &Path, theme: &str, now_ms: u64) -> Result<RewardsView, String> {
    let all: serde_json::Value = serde_json::from_str(CATALOG).unwrap_or(serde_json::Value::Null);
    if let Some(ts) = all.get("themes").and_then(|v| v.as_array()) {
        for t in ts {
            let paid = t.get("paid").and_then(|v| v.as_bool()).unwrap_or(false);
            if let (true, Some(id)) = (paid, t.get("id").and_then(|v| v.as_str())) { purchase(dir, theme, "theme", id, INTERNAL_TX, now_ms)?; }
        }
    }
    let cat = catalog_theme(theme);
    for (kind, list) in [("towel", "towels"), ("prop", "props"), ("visitor", "visitors")] {
        if let Some(items) = cat.get(list).and_then(|v| v.as_array()) {
            for it in items { if let Some(id) = it.get("id").and_then(|v| v.as_str()) { purchase(dir, theme, kind, id, INTERNAL_TX, now_ms)?; } }
        }
    }
    Ok(view(dir, theme, now_ms))
}

/// 内测撤回：只删交易号为 "internal" 的购买及其对应物件（摆着/挂着的一并撤下），攒来的和真买的原样保留。
pub fn revoke_internal(dir: &Path, theme: &str, now_ms: u64) -> Result<RewardsView, String> {
    let mut f = load(dir);
    let dropped: Vec<String> = f.purchases.iter().filter(|p| p.tx == INTERNAL_TX).map(|p| p.sku.trim_start_matches("theme.").to_string()).collect();
    f.owned_themes.retain(|t| !dropped.contains(t));
    f.purchases.retain(|p| p.tx != INTERNAL_TX);
    for (_, st) in f.themes.iter_mut() {
        let skus: Vec<String> = st.purchases.iter().filter(|p| p.tx == INTERNAL_TX).map(|p| p.sku.clone()).collect();
        for sku in &skus {
            // sku = "<theme>.<kind>.<id>"
            let mut parts = sku.splitn(3, '.'); let (_t, kind, id) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            match kind {
                "towel" => { st.towels.retain(|x| x != id); if st.hung == id { st.hung.clear(); } }
                "prop" => { st.props.retain(|x| x != id); st.placed.retain(|_, v| v != id); }
                "visitor" => st.visitors.retain(|x| x != id),
                _ => {}
            }
        }
        st.purchases.retain(|p| p.tx != INTERNAL_TX);
    }
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
    // 🔴 每个测试各一个目录：cargo test 在同一进程里并行跑，按进程号命名会互相覆盖 rewards.json（9-2 踩过）
    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("tomato_rewards_{}_{}", std::process::id(), name));
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
        // 按天分钟表：两天有键，前天两场 25+25=50，昨天 10；放弃的那天没有键
        assert_eq!(l.days.len(), 2);
        let mut v: Vec<u32> = l.days.values().copied().collect(); v.sort();
        assert_eq!(v, vec![10, 50]);
    }

    #[test]
    fn unlock_earn_buy_place_hang() {
        let d = tmp("unlock"); let now = 1_800_000_000_000u64;
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

    #[test]
    fn purchase_theme_and_items_idempotent() {
        let d = tmp("purchase"); let now = 1_800_000_000_000u64;
        fs::write(d.join("history.jsonl"), "").unwrap();
        // 主题包：买断进 owned_themes，带交易号；重复购买（恢复）不重复记
        let v = purchase(&d, "ink", "theme", "onsen", "tx-1", now).unwrap();
        assert_eq!(v.owned_themes, vec!["onsen"]);
        let v = purchase(&d, "ink", "theme", "onsen", "tx-1", now).unwrap();
        assert_eq!(v.owned_themes.len(), 1);
        assert_eq!(load(&d).purchases.len(), 1);
        assert_eq!(load(&d).purchases[0].tx, "tx-1");
        assert!(purchase(&d, "ink", "theme", "nope", "", now).is_err());
        // 单件：不看分钟，记 tx；再买一次幂等返回视图
        let v = purchase(&d, "ink", "prop", "koi", "tx-2", now).unwrap();
        assert!(v.state.props.contains(&"koi".to_string()));
        assert_eq!(v.state.purchases[0].tx, "tx-2");
        assert!(purchase(&d, "ink", "prop", "koi", "tx-2", now).is_ok());
        assert_eq!(load(&d).themes["ink"].purchases.len(), 1);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn internal_grant_then_revoke_keeps_real_ones() {
        let d = tmp("internal"); let now = 1_800_000_000_000u64;
        // 先有一场完成 → 攒到 t01（60 分钟够），再真买 koi
        fs::write(d.join("history.jsonl"), [rec(true, 3600, 1, now), rec(true, 3600, 1, now - DAY)].join("\n")).unwrap();
        unlock(&d, "ink", "towel", "t01", "earn", now).unwrap();
        purchase(&d, "ink", "prop", "koi", "tx-real", now).unwrap();
        let v = grant_all(&d, "ink", now).unwrap();
        assert!(v.owned_themes.contains(&"onsen".to_string()));
        assert_eq!(v.state.towels.len(), 8); assert_eq!(v.state.props.len(), 8); assert_eq!(v.state.visitors.len(), 1);
        place(&d, "ink", "willow", "windbell", now).unwrap();
        let v = revoke_internal(&d, "ink", now).unwrap();
        assert!(v.owned_themes.is_empty());
        assert_eq!(v.state.towels, vec!["t01"], "攒来的留着");
        assert_eq!(v.state.props, vec!["koi"], "真买的留着");
        assert!(v.state.placed.is_empty(), "内测摆的撤下");
        assert_eq!(v.state.purchases.len(), 1); assert_eq!(v.state.purchases[0].tx, "tx-real");
        let _ = fs::remove_dir_all(&d);
    }
}
