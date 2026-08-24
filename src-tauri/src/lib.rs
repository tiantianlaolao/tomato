// Tauri 壳（M2）：core 状态机 + 滴答线程 + 托盘常驻 + 系统通知 + 全局快捷键 + 自启 + 定时计划。
//
// M2 的关键升级：后台滴答线程。M1 靠前端轮询推进惰性投影，窗口一藏就没人问时间了；
// 现在 Rust 侧每秒 tick 一次 —— 窗口关着照样：阶段切换发通知、托盘分钟数在变、
// 定时计划到点开跑、会话完成写流水。前端只是"恰好也在看"的一个观众。
mod core;

use core::{Plan, Session, Settings};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

// ———————————————————————— 定时计划（FE-29~33） ————————————————————————
#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Schedule {
    pub id: String,
    pub plan_id: String,
    pub mode: String,      // "delay" | "once" | "recurring"
    pub trigger_at: u64,   // delay/once：绝对时刻 ms
    pub time: String,      // recurring："HH:MM"
    pub weekdays: Vec<u8>, // recurring：0=周日 … 6=周六
    pub enabled: bool,
    pub last_fired: String, // recurring：上次触发的 YYYY-MM-DD，防同日重复
    pub pre_alerted: bool,  // 触发前 30s 预告只发一次
}
impl Default for Schedule {
    fn default() -> Self {
        Schedule { id: String::new(), plan_id: String::new(), mode: "once".into(), trigger_at: 0, time: String::new(), weekdays: vec![], enabled: true, last_fired: String::new(), pre_alerted: false }
    }
}

// ———————————————————————— 会话流水（情感路线的地基：完成一次记一笔） ————————————————————————
#[derive(Serialize)]
struct HistoryRecord<'a> {
    plan_name: &'a str,
    started_ms: u64,
    ended_ms: u64,
    work_secs: u64,
    rest_secs: u64,
    stages: &'a [core::Stage],
}

struct App {
    dir: PathBuf,
    settings: Settings,
    plans: Vec<Plan>,
    session: Session,
    schedules: Vec<Schedule>,
    // 滴答线程用的运行时记忆（不落盘）
    prev_status: String,
    prev_idx: usize,
    prealert_idx: i64,       // 已发过"最后 N 秒"预备音的阶段
    last_strong_ms: u64,     // 上次强提醒时刻
    continuous_work_ms: u64, // 连续工作累计（久坐提醒 FE-41）
    last_sit_ms: u64,        // 上次久坐提醒时刻
    last_tray: String,       // 托盘上次画的内容，变了才重画
    last_save_ms: u64,
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    saved_at: u64,
    session: Session,
}

impl App {
    fn load(dir: PathBuf) -> Self {
        fs::create_dir_all(&dir).ok();
        let read = |name: &str| fs::read_to_string(dir.join(name)).ok();
        let settings: Settings = read("settings.json").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let mut plans: Vec<Plan> = read("plans.json").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        plans.retain(|p| !p.builtin);
        let customs = plans;
        plans = core::builtin_plans();
        plans.extend(customs);
        let session = read("session.json")
            .and_then(|s| serde_json::from_str::<SavedSession>(&s).ok())
            .map(|w| core::restore(w.session, &settings, w.saved_at))
            .unwrap_or_else(Session::idle);
        let schedules: Vec<Schedule> = read("schedules.json").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        App {
            dir, settings, plans, session, schedules,
            prev_status: "idle".into(), prev_idx: 0, prealert_idx: -1,
            last_strong_ms: 0, continuous_work_ms: 0, last_sit_ms: 0,
            last_tray: String::new(), last_save_ms: 0,
        }
    }
    fn save_settings(&self) { if let Ok(s) = serde_json::to_string_pretty(&self.settings) { fs::write(self.dir.join("settings.json"), s).ok(); } }
    fn save_plans(&self) { if let Ok(s) = serde_json::to_string_pretty(&self.plans) { fs::write(self.dir.join("plans.json"), s).ok(); } }
    fn save_schedules(&self) { if let Ok(s) = serde_json::to_string_pretty(&self.schedules) { fs::write(self.dir.join("schedules.json"), s).ok(); } }
    fn save_session(&mut self) {
        self.last_save_ms = now_ms();
        let w = SavedSession { saved_at: self.last_save_ms, session: self.session.clone() };
        if let Ok(s) = serde_json::to_string(&w) { fs::write(self.dir.join("session.json"), s).ok(); }
    }
    /// 会话完成 → 追加一行 JSONL 流水（history.jsonl）。将来的番茄园/统计都从这里长
    fn maybe_log_done(&mut self) {
        if self.session.status != "done" || self.session.logged { return; }
        let work: u64 = self.session.stages.iter().filter(|s| s.kind == "work").map(|s| s.secs).sum();
        let rest: u64 = self.session.stages.iter().filter(|s| s.kind == "break").map(|s| s.secs).sum();
        let rec = HistoryRecord {
            plan_name: &self.session.plan_name,
            started_ms: self.session.started_ms,
            ended_ms: now_ms(),
            work_secs: work, rest_secs: rest,
            stages: &self.session.stages,
        };
        if let Ok(line) = serde_json::to_string(&rec) {
            if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(self.dir.join("history.jsonl")) {
                let _ = writeln!(f, "{line}");
            }
        }
        self.session.logged = true;
        self.save_session();
    }
}

type S<'a> = State<'a, Mutex<App>>;

// ———————————————————————— 托盘图标：把剩余分钟画进 32×32（Windows 托盘没有文字位） ————————————————————————
// 3×5 点阵数字，放大 3 倍 = 9×15，两位数并排居中。够清楚，也不用拖字体库。
const FONT: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111], [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001], [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111], [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111], [0b111, 0b101, 0b111, 0b001, 0b111],
];

fn tray_image(text: &str, rgb: [u8; 3]) -> tauri::image::Image<'static> {
    const W: usize = 32;
    let mut px = vec![0u8; W * W * 4];
    // 圆角方底
    for y in 0..W {
        for x in 0..W {
            let (dx, dy) = (x as i32 - 15, y as i32 - 15);
            let corner = dx.abs().max(dy.abs()) > 15 || (dx.abs() > 11 && dy.abs() > 11 && dx * dx + dy * dy > 420);
            if !corner {
                let i = (y * W + x) * 4;
                px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
            }
        }
    }
    // 数字（最多两位）白色居中；scale=3
    let digits: Vec<usize> = text.chars().filter_map(|c| c.to_digit(10)).map(|d| d as usize).collect();
    if !digits.is_empty() {
        let n = digits.len().min(2);
        let total_w = n * 9 + (n - 1) * 3;
        let x0 = (W - total_w) / 2;
        let y0 = (W - 15) / 2;
        for (di, d) in digits.iter().take(2).enumerate() {
            for (row, bits) in FONT[*d].iter().enumerate() {
                for col in 0..3 {
                    if bits & (0b100 >> col) != 0 {
                        for sy in 0..3 {
                            for sx in 0..3 {
                                let x = x0 + di * 12 + col * 3 + sx;
                                let y = y0 + row * 3 + sy;
                                let i = (y * W + x) * 4;
                                px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; px[i + 3] = 255;
                            }
                        }
                    }
                }
            }
        }
    }
    tauri::image::Image::new_owned(px, W as u32, W as u32)
}

struct TrayUi {
    status: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    skip: MenuItem<tauri::Wry>,
}

// ———————————————————————— 通知 + 音效（音效发给前端 WebAudio 播） ————————————————————————
fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
fn sfx(app: &AppHandle, kind: &str) {
    let _ = app.emit("sfx", kind);
}
fn push_state(app: &AppHandle, a: &App) {
    let _ = app.emit("state", core::view(&a.session, &a.settings, now_ms()));
}

// ———————————————————————— 每秒滴答：投影推进 / 提醒 / 托盘 / 定时 / 流水 ————————————————————————
fn tick(app: &AppHandle) {
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();

    core::project(&mut a.session, &cfg, now);

    // ① 阶段切换/完成：通知 + 音 + 推给前端
    let (st, idx) = (a.session.status.clone(), a.session.idx);
    if st != a.prev_status || idx != a.prev_idx {
        let total = a.session.stages.len();
        match st.as_str() {
            "running" => {
                if let Some(cur) = a.session.stages.get(idx) {
                    let kind = if cur.kind == "work" { "工作" } else { "休息" };
                    if a.prev_status != "idle" && !(a.prev_status == "paused" && a.prev_idx == idx) {
                        notify(app, &format!("第 {}/{} 段 · {}", idx + 1, total, kind),
                            &format!("{} {} 分钟，开始。", kind, (cur.secs + 30) / 60));
                        sfx(app, "switch");
                    }
                }
            }
            "awaiting" => {
                notify(app, "这一段走完了", "休息结束，准备好了就开始下一段工作。");
                sfx(app, "switch");
                a.last_strong_ms = now;
            }
            "done" => {
                notify(app, "🍅 这一轮收获满满", "整个序列都跑完了，去看看汇总吧。");
                sfx(app, "done");
            }
            _ => {}
        }
        a.prev_status = st.clone();
        a.prev_idx = idx;
        a.prealert_idx = -1;
        push_state(app, &a);
        a.save_session();
    }

    // ② 阶段结束前 N 秒预备音（FE-22）
    if st == "running" && cfg.pre_alert_sec > 0 {
        let remain = a.session.end_ms.saturating_sub(now);
        if remain > 0 && remain <= cfg.pre_alert_sec as u64 * 1000 && a.prealert_idx != idx as i64 {
            a.prealert_idx = idx as i64;
            sfx(app, "pre");
        }
    }

    // ③ 强提醒（FE-23）：休息结束停在等待，每 60s 催一次 + 窗口闪烁
    if st == "awaiting" && cfg.strong_remind && now.saturating_sub(a.last_strong_ms) >= 60_000 {
        a.last_strong_ms = now;
        notify(app, "还等着你呢", "休息早结束了，回来把下一段工作开起来。");
        sfx(app, "remind");
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }

    // ④ 久坐提醒（FE-41）：非强制模式下连续工作每 N 分钟响一声
    if cfg.rest_policy == "flexible" && cfg.sit_remind_min > 0 {
        if st == "running" {
            if a.session.stages.get(idx).map(|s| s.kind == "work").unwrap_or(false) {
                a.continuous_work_ms += 1000;
                let gap = cfg.sit_remind_min as u64 * 60_000;
                if a.continuous_work_ms >= gap && now.saturating_sub(a.last_sit_ms) >= gap {
                    a.last_sit_ms = now;
                    notify(app, "该歇歇眼睛了", &format!("已经连续专注 {} 分钟，起来活动一下吧。", a.continuous_work_ms / 60_000));
                    sfx(app, "remind");
                }
            } else {
                a.continuous_work_ms = 0; // 真正休息了才清零
            }
        } else if st == "idle" || st == "done" {
            a.continuous_work_ms = 0;
        }
    }

    // ⑤ 定时计划（FE-29~33）
    let mut fire: Vec<(String, String)> = vec![]; // (plan_id, 描述)
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let hhmm = chrono::Local::now().format("%H:%M").to_string();
    let weekday = chrono::Datelike::weekday(&chrono::Local::now()).num_days_from_sunday() as u8;
    let mut dirty = false;
    for sc in a.schedules.iter_mut() {
        if !sc.enabled { continue; }
        match sc.mode.as_str() {
            "delay" | "once" => {
                if sc.trigger_at == 0 { continue; }
                let until = sc.trigger_at.saturating_sub(now);
                if until > 0 && until <= 30_000 && !sc.pre_alerted {
                    sc.pre_alerted = true; dirty = true;
                    notify(app, "⏳ 30 秒后自动开始", "定好的专注马上开始，准备一下。");
                }
                if now >= sc.trigger_at && now - sc.trigger_at < 90_000 {
                    fire.push((sc.plan_id.clone(), sc.mode.clone()));
                    sc.enabled = false; dirty = true;
                }
            }
            "recurring" => {
                if sc.weekdays.contains(&weekday) && sc.time == hhmm && sc.last_fired != today {
                    sc.last_fired = today.clone(); dirty = true;
                    fire.push((sc.plan_id.clone(), "recurring".into()));
                }
            }
            _ => {}
        }
    }
    if dirty { a.save_schedules(); }
    for (plan_id, _) in fire {
        if a.session.status == "idle" || a.session.status == "done" {
            if let Some(p) = a.plans.iter().find(|p| p.id == plan_id).cloned() {
                if let Ok(s) = core::start_session(&p, now) {
                    a.session = s;
                    a.prev_status = "running".into(); a.prev_idx = 0;
                    a.save_session();
                    notify(app, &format!("🍅 已自动开始「{}」", p.name), "到点了，这一轮已经替你开起来了。");
                    sfx(app, "switch");
                    push_state(app, &a);
                }
            }
        } else {
            notify(app, "定时计划到点了", "但你正在会话中，没有打断你。想切换就去主窗口。");
        }
    }

    // ⑥ 会话完成 → 流水入账
    a.maybe_log_done();

    // ⑦ 托盘 + 任务栏进度（内容变了才重画）
    let (txt, rgb, tip) = match a.session.status.as_str() {
        "running" | "paused" => {
            let cur = &a.session.stages[a.session.idx];
            let remain = if a.session.status == "running" { a.session.end_ms.saturating_sub(now) } else { a.session.remain_ms };
            let mins = (remain / 60_000).min(99);
            let paused = a.session.status == "paused";
            let rgb = if paused { [128, 128, 128] } else if cur.kind == "work" { [232, 89, 12] } else { [12, 166, 120] };
            let sym = if cur.kind == "work" { "◉" } else { "◇" };
            (format!("{mins}"), rgb,
             format!("{} {} {:02}:{:02}{} · {}", sym, if cur.kind == "work" { "工作" } else { "休息" },
                remain / 60_000, remain % 60_000 / 1000, if paused { "（已暂停）" } else { "" }, a.session.plan_name))
        }
        "awaiting" => ("0".into(), [180, 140, 60], "⏳ 等你开始下一段".to_string()),
        "done" => (String::new(), [233, 168, 13], "🍅 跑完了，去看汇总".to_string()),
        _ => (String::new(), [200, 120, 90], "番茄时钟 · 空闲".to_string()),
    };
    let key = format!("{txt}|{rgb:?}|{tip}");
    if key != a.last_tray {
        a.last_tray = key;
        if let Some(tray) = app.tray_by_id("tray") {
            let _ = tray.set_icon(Some(tray_image(&txt, rgb)));
            let _ = tray.set_tooltip(Some(&tip));
        }
        let ui: State<TrayUi> = app.state();
        let _ = ui.status.set_text(&tip);
        let _ = ui.toggle.set_text(if a.session.status == "paused" { "继续" } else if a.session.status == "awaiting" { "开始下一段" } else { "暂停" });
        let _ = ui.toggle.set_enabled(a.session.status != "idle" && a.session.status != "done");
        let _ = ui.skip.set_enabled(matches!(a.session.status.as_str(), "running" | "paused" | "awaiting"));
        // 任务栏/Dock 进度条（FE-27 的跨平台落法）
        if let Some(w) = app.get_webview_window("main") {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let pb = match a.session.status.as_str() {
                "running" => {
                    let cur = &a.session.stages[a.session.idx];
                    let done = 100 - (a.session.end_ms.saturating_sub(now) * 100 / (cur.secs * 1000).max(1)) as u64;
                    ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(done.min(100)) }
                }
                "paused" => ProgressBarState { status: Some(ProgressBarStatus::Paused), progress: None },
                _ => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
            };
            let _ = w.set_progress_bar(pb);
        }
    }

    // ⑧ 跑动中每 30s 兜底存一次盘
    if a.session.status == "running" && now.saturating_sub(a.last_save_ms) >= 30_000 {
        a.save_session();
    }
}

// ———————————————————————— 命令 ————————————————————————
#[derive(Serialize)]
struct Boot {
    settings: Settings,
    plans: Vec<Plan>,
    view: core::View,
    schedules: Vec<Schedule>,
    missed: Vec<String>, // 错过的计划描述（FE-33：启动时询问补跑）
}

#[tauri::command]
fn boot(app: S) -> Boot {
    let mut a = app.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();
    core::project(&mut a.session, &cfg, now);
    a.prev_status = a.session.status.clone();
    a.prev_idx = a.session.idx;
    // 错过的一次性计划：到点了但当时没开机
    let plan_names: Vec<(String, String)> = a.plans.iter().map(|p| (p.id.clone(), p.name.clone())).collect();
    let mut missed = vec![];
    for sc in a.schedules.iter_mut() {
        if sc.enabled && matches!(sc.mode.as_str(), "once" | "delay") && sc.trigger_at > 0 && now > sc.trigger_at + 90_000 {
            sc.enabled = false;
            let name = plan_names.iter().find(|(id, _)| *id == sc.plan_id).map(|(_, n)| n.clone()).unwrap_or_default();
            missed.push(name);
        }
    }
    if !missed.is_empty() { a.save_schedules(); }
    Boot {
        settings: a.settings.clone(), plans: a.plans.clone(),
        view: core::view(&a.session, &a.settings, now),
        schedules: a.schedules.clone(), missed,
    }
}

#[tauri::command]
fn get_state(app: S) -> core::View {
    let mut a = app.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();
    core::project(&mut a.session, &cfg, now);
    a.maybe_log_done();
    core::view(&a.session, &a.settings, now)
}

#[tauri::command]
fn session_start(app: S, plan: Plan) -> Result<core::View, String> {
    let mut a = app.lock().unwrap();
    let now = now_ms();
    a.session = core::start_session(&plan, now)?;
    a.prev_status = "running".into();
    a.prev_idx = 0;
    a.continuous_work_ms = 0;
    a.save_session();
    Ok(core::view(&a.session, &a.settings, now))
}

#[tauri::command]
fn session_cmd(app: S, cmd: String) -> Result<core::View, String> {
    let mut a = app.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();
    let out = core::apply(&mut a.session, &cfg, &cmd, now)?;
    if out.unlock_consumed {
        a.settings.final_break_unlock = false;
        a.save_settings();
    }
    a.prev_status = a.session.status.clone();
    a.prev_idx = a.session.idx;
    a.maybe_log_done();
    a.save_session();
    Ok(core::view(&a.session, &a.settings, now))
}

#[tauri::command]
fn save_settings(app: S, handle: AppHandle, settings: Settings) -> Settings {
    let mut a = app.lock().unwrap();
    let autostart_changed = a.settings.autostart != settings.autostart;
    a.settings = settings;
    a.save_settings();
    if autostart_changed {
        use tauri_plugin_autostart::ManagerExt;
        let al = handle.autolaunch();
        if a.settings.autostart { let _ = al.enable(); } else { let _ = al.disable(); }
    }
    a.settings.clone()
}

#[tauri::command]
fn save_plans(app: S, plans: Vec<Plan>) -> Vec<Plan> {
    let mut a = app.lock().unwrap();
    let mut merged = core::builtin_plans();
    merged.extend(plans.into_iter().filter(|p| !p.builtin));
    a.plans = merged;
    a.save_plans();
    a.plans.clone()
}

#[tauri::command]
fn save_schedules(app: S, schedules: Vec<Schedule>) -> Vec<Schedule> {
    let mut a = app.lock().unwrap();
    a.schedules = schedules;
    a.save_schedules();
    a.schedules.clone()
}

#[tauri::command]
fn get_history(app: S, limit: usize) -> Vec<serde_json::Value> {
    let a = app.lock().unwrap();
    let txt = fs::read_to_string(a.dir.join("history.jsonl")).unwrap_or_default();
    let mut v: Vec<serde_json::Value> = txt.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let n = v.len();
    if n > limit { v.drain(0..n - limit); }
    v
}

// ———————————————————————— 组装 ————————————————————————
fn toggle_session(app: &AppHandle) {
    let state: State<Mutex<App>> = app.state();
    let cmd = {
        let a = state.lock().unwrap();
        match a.session.status.as_str() {
            "running" => "pause", "paused" => "resume", "awaiting" => "start_next",
            _ => return,
        }.to_string()
    };
    let _ = session_cmd(app.state(), cmd);
    let a = state.lock().unwrap();
    push_state(app, &a);
}
fn skip_session(app: &AppHandle) {
    let _ = session_cmd(app.state(), "skip".into());
    let state: State<Mutex<App>> = app.state();
    let a = state.lock().unwrap();
    push_state(app, &a);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("拿不到应用数据目录");
            let loaded = App::load(dir);
            let silent = std::env::args().any(|x| x == "--hidden") && loaded.settings.launch_mode == "silent";
            app.manage(Mutex::new(loaded));

            // 自启且静默：只留托盘，不亮主窗口（FE-25 启动形态）
            if silent {
                if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
            }

            // 托盘 + 迷你菜单（FE-24）
            let status = MenuItem::with_id(app, "status", "番茄时钟 · 空闲", false, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "暂停", false, None::<&str>)?;
            let skip = MenuItem::with_id(app, "skip", "跳过这一段", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status, &PredefinedMenuItem::separator(app)?,
                &toggle, &skip, &PredefinedMenuItem::separator(app)?,
                &show, &quit,
            ])?;
            app.manage(TrayUi { status: status.clone(), toggle: toggle.clone(), skip: skip.clone() });
            TrayIconBuilder::with_id("tray")
                .icon(tray_image("", [200, 120, 90]))
                .tooltip("番茄时钟")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "toggle" => toggle_session(app),
                    "skip" => skip_session(app),
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") { let _ = w.show(); let _ = w.set_focus(); }
                    }
                    "quit" => {
                        let state: State<Mutex<App>> = app.state();
                        state.lock().unwrap().save_session();
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 全局快捷键（FE-28）：暂停/继续 + 跳过
            {
                use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
                #[cfg(target_os = "macos")]
                let (k_toggle, k_skip) = ("Alt+Cmd+P", "Alt+Cmd+S");
                #[cfg(not(target_os = "macos"))]
                let (k_toggle, k_skip) = ("Ctrl+Alt+P", "Ctrl+Alt+S");
                let _ = app.global_shortcut().on_shortcut(k_toggle, |app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed { toggle_session(app); }
                });
                let _ = app.global_shortcut().on_shortcut(k_skip, |app, _sc, ev| {
                    if ev.state() == ShortcutState::Pressed { skip_session(app); }
                });
            }

            // 滴答线程：窗口在不在都每秒推一次
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                tick(&handle);
            });
            Ok(())
        })
        // 关窗只隐藏，计时不断（FE-26）；真正退出走托盘菜单
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            boot, get_state, session_start, session_cmd,
            save_settings, save_plans, save_schedules, get_history
        ])
        .run(tauri::generate_context!())
        .expect("番茄时钟启动失败");
}
