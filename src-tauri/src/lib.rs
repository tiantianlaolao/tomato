// Tauri 壳（M2）：core 状态机 + 滴答线程 + 托盘常驻 + 系统通知 + 全局快捷键 + 自启 + 定时计划。
//
// M2 的关键升级：后台滴答线程。M1 靠前端轮询推进惰性投影，窗口一藏就没人问时间了；
// 现在 Rust 侧每秒 tick 一次 —— 窗口关着照样：阶段切换发通知、托盘分钟数在变、
// 定时计划到点开跑、会话完成写流水。前端只是"恰好也在看"的一个观众。
//
// ⚠️ 线程纪律（Mac 卡死事故的教训）：托盘/菜单的 set_* 是「同步派发到主线程并阻塞等
// 结果」（tauri 的 run_item_main_thread）。滴答线程若持着 App 锁去调它们，而主线程恰好
// 在一个也要拿 App 锁的同步 command 里 —— 两边互等，整个进程冻死（工作段结束必触发
// 托盘重画，所以表现为"时间一到就卡死"）。因此：
//   ① tick 锁内只做计算和落盘，把 UI 动作攒进 UiWork，放锁之后再执行；
//   ② 所有 #[tauri::command] 一律 async —— 跑在异步线程池上，主线程永远不等 App 锁。
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
    pub trigger_at: u64,   // delay/once：绝对时刻 ms（once 由前端精确到秒）
    pub time: String,      // recurring："HH:MM"
    pub weekdays: Vec<u8>, // recurring：0=周日 … 6=周六
    pub enabled: bool,
    pub last_fired: String, // recurring：上次触发的 YYYY-MM-DD，防同日重复
    pub pre_alerted: bool,  // 触发前 30s 预告只发一次
    pub name: String,           // 序列快照名（delay 存的是"当时编辑器里那个序列"）
    pub stages: Vec<core::Stage>, // 序列快照；非空时不查 plan_id，直接跑它 —— 没存成预设的临时编排也能如约开跑
}
impl Default for Schedule {
    fn default() -> Self {
        Schedule { id: String::new(), plan_id: String::new(), mode: "once".into(), trigger_at: 0, time: String::new(), weekdays: vec![], enabled: true, last_fired: String::new(), pre_alerted: false, name: String::new(), stages: vec![] }
    }
}

// ———————————————————————— 会话流水（情感路线的地基：完成一次记一笔） ————————————————————————
#[derive(Serialize)]
struct HistoryRecord<'a> {
    plan_name: &'a str,
    completed: bool, // false=中途放弃（部分时长也如实入账）
    started_ms: u64,
    ended_ms: u64,
    work_secs: u64,
    rest_secs: u64,
    activity: &'a str, // 陪伴活动（将来"陪你读了X小时书"的统计地基）
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
    last_tray: String,       // 托盘图标/菜单上次画的内容（分钟级），变了才重画
    last_tray_sec: String,   // 托盘标题/气泡上次的内容（秒级）
    rest_shown: bool,        // 强制休息全屏遮罩当前是否亮着
    last_save_ms: u64,
    remind_armed: bool,      // 强提醒只对"本次运行期间进入等待"的会话催；隔夜恢复的旧会话不该开机就被唠叨
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
        // prev_* 直接对齐恢复出来的会话：否则滴答线程会把"恢复"误判成"刚发生的切换"，
        // 启动即重发完成/等待通知，restored done 还会在静默自启时强行弹主窗（曾依赖前端 boot 在 1s 内抢先对齐，竞态）
        let (prev_status, prev_idx) = (session.status.clone(), session.idx);
        App {
            dir, settings, plans, session, schedules,
            prev_status, prev_idx, prealert_idx: -1,
            last_strong_ms: 0, continuous_work_ms: 0, last_sit_ms: 0,
            last_tray: String::new(), last_tray_sec: String::new(),
            rest_shown: false, last_save_ms: 0, remind_armed: false,
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
    /// 追加一行 JSONL 流水（history.jsonl）。将来的番茄园/统计都从这里长。
    /// 时长按 acc_* 实际经过时间入账（跳过不虚记、暂停不算、放弃记部分）。
    fn write_history(&mut self, completed: bool) {
        let rec = HistoryRecord {
            plan_name: &self.session.plan_name,
            completed,
            started_ms: self.session.started_ms,
            ended_ms: now_ms(),
            work_secs: self.session.acc_work_ms / 1000,
            rest_secs: self.session.acc_rest_ms / 1000,
            activity: &self.session.activity,
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
    /// 会话完成 → 入账（防重复）
    fn maybe_log_done(&mut self) {
        if self.session.status != "done" || self.session.logged { return; }
        self.write_history(true);
    }
    /// 中途结束 → 部分入账（不足 1 分钟的就不记了，免得误触也留痕）
    fn log_abandoned(&mut self) {
        if !matches!(self.session.status.as_str(), "running" | "paused" | "awaiting") || self.session.logged { return; }
        if self.session.acc_work_ms + self.session.acc_rest_ms < 60_000 { return; }
        self.write_history(false);
    }
}

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
    pet: MenuItem<tauri::Wry>,
}

// ———————————————————————— 通知 + 音效（音效发给前端 WebAudio 播） ————————————————————————
fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}
fn sfx(app: &AppHandle, kind: &str) {
    let _ = app.emit("sfx", kind);
}

// ———————————————————————— UI 动作清单：锁内攒、放锁后做 ————————————————————————
#[derive(Default)]
struct UiWork {
    notices: Vec<(String, String)>,   // 系统通知（标题, 正文）
    sfx: Vec<&'static str>,
    state_push: Option<core::View>,   // 状态快照推给所有窗口
    attention: bool,                  // 主窗口闪烁请求
    tray: Option<TrayDraw>,           // 图标/菜单/进度条（分钟级变化才动）
    tray_sec: Option<TraySec>,        // 标题(mac)/气泡/状态行（秒级）
    rest_show: Option<bool>,          // Some(true)=弹强制休息遮罩，Some(false)=收
    rest_regrab: bool,                // 遮罩活跃期间每秒抢回焦点
    show_main: bool,                  // 会话完成 → 主窗口回来展示汇总
}
struct TrayDraw {
    txt: String,
    rgb: [u8; 3],
    toggle: String,
    toggle_en: bool,
    skip_en: bool,
    prog_status: u8, // 0=无 1=正常 2=暂停
    prog: u64,
}
struct TraySec {
    title: Option<String>, // macOS 菜单栏文字（MM:SS 每秒刷新）
    tip: String,
}

// ———————————————————————— 每秒滴答：投影推进 / 提醒 / 托盘 / 定时 / 流水 ————————————————————————
fn tick(app: &AppHandle) {
    let work = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        collect_tick(&mut a)
    };
    apply_ui(app, work);
}

/// 锁内阶段：只做状态推演、落盘和"要做什么 UI 动作"的决策，绝不碰托盘/窗口。
fn collect_tick(a: &mut App) -> UiWork {
    let mut w = UiWork::default();
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
                        w.notices.push((format!("第 {}/{} 段 · {}", idx + 1, total, kind),
                            format!("{} {} 分钟，开始。", kind, (cur.secs + 30) / 60)));
                        w.sfx.push("switch");
                    }
                }
            }
            "awaiting" => {
                // 段间等待有两种方向：休息完等开工（默认），或关了"自动进休息"后工作完等休息 —— 文案要分开
                let next_is_work = a.session.stages.get(idx + 1).map(|s| s.kind == "work").unwrap_or(true);
                let body = if next_is_work { "休息结束，准备好了就开始下一段工作。" } else { "这段工作完成了，歇一会儿再继续。" };
                w.notices.push(("这一段走完了".into(), body.into()));
                w.sfx.push("switch");
                a.last_strong_ms = now;
                a.remind_armed = true;
            }
            "done" => {
                w.notices.push(("🍅 这一轮收获满满".into(), "整个序列都跑完了，去看看汇总吧。".into()));
                w.sfx.push("done");
                w.show_main = true; // 跑完把主窗口叫回来看汇总（桌宠期间主窗是藏着的）
            }
            _ => {}
        }
        a.prev_status = st.clone();
        a.prev_idx = idx;
        a.prealert_idx = -1;
        w.state_push = Some(core::view(&a.session, &a.settings, now));
        a.save_session();
    }

    // ② 阶段结束前 N 秒预备音（FE-22）
    if st == "running" && cfg.pre_alert_sec > 0 {
        let remain = a.session.end_ms.saturating_sub(now);
        if remain > 0 && remain <= cfg.pre_alert_sec as u64 * 1000 && a.prealert_idx != idx as i64 {
            a.prealert_idx = idx as i64;
            w.sfx.push("pre");
        }
    }

    // ③ 强提醒（FE-23）：段间等待每 60s 催一次 + 窗口闪烁。
    // remind_armed：只催"本次运行期间"进入等待的会话 —— 隔夜恢复的旧会话开机就唠叨太烦，交给"还没跑完"的 toast。
    if st == "awaiting" && cfg.strong_remind && a.remind_armed && now.saturating_sub(a.last_strong_ms) >= 60_000 {
        a.last_strong_ms = now;
        let next_is_work = a.session.stages.get(idx + 1).map(|s| s.kind == "work").unwrap_or(true);
        let body = if next_is_work { "休息早结束了，回来把下一段工作开起来。" } else { "工作早就结束了，去歇一会儿吧。" };
        w.notices.push(("还等着你呢".into(), body.into()));
        w.sfx.push("remind");
        w.attention = true;
    }

    // ④ 久坐提醒（FE-41）：非强制模式下连续工作每 N 分钟响一声
    if cfg.rest_policy == "flexible" && cfg.sit_remind_min > 0 {
        if st == "running" {
            if a.session.stages.get(idx).map(|s| s.kind == "work").unwrap_or(false) {
                a.continuous_work_ms += 1000;
                let gap = cfg.sit_remind_min as u64 * 60_000;
                if a.continuous_work_ms >= gap && now.saturating_sub(a.last_sit_ms) >= gap {
                    a.last_sit_ms = now;
                    w.notices.push(("该歇歇眼睛了".into(), format!("已经连续专注 {} 分钟，起来活动一下吧。", a.continuous_work_ms / 60_000)));
                    w.sfx.push("remind");
                }
            } else {
                a.continuous_work_ms = 0; // 真正休息了才清零
            }
        } else if st == "idle" || st == "done" {
            a.continuous_work_ms = 0;
        }
    }

    // ⑤ 定时计划（FE-29~33）
    let mut fire: Vec<Schedule> = vec![];
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let hhmm = chrono::Local::now().format("%H:%M").to_string();
    let weekday = chrono::Datelike::weekday(&chrono::Local::now()).num_days_from_sunday() as u8;
    let mut dirty = false;
    let plan_names: Vec<(String, String)> = a.plans.iter().map(|p| (p.id.clone(), p.name.clone())).collect();
    let sched_name = |sc: &Schedule| -> String {
        if !sc.name.is_empty() { return sc.name.clone(); }
        plan_names.iter().find(|(id, _)| *id == sc.plan_id).map(|(_, n)| n.clone()).unwrap_or_else(|| "定时计划".into())
    };
    for sc in a.schedules.iter_mut() {
        if !sc.enabled { continue; }
        match sc.mode.as_str() {
            "delay" | "once" => {
                if sc.trigger_at == 0 { continue; }
                let until = sc.trigger_at.saturating_sub(now);
                if until > 0 && until <= 30_000 && !sc.pre_alerted {
                    sc.pre_alerted = true; dirty = true;
                    w.notices.push(("⏳ 30 秒后自动开始".into(), "定好的专注马上开始，准备一下。".into()));
                }
                if now >= sc.trigger_at && now - sc.trigger_at < 90_000 {
                    fire.push(sc.clone());
                    sc.enabled = false; dirty = true;
                } else if now >= sc.trigger_at {
                    // 触发点被睡过去了（app 在跑但机器挂起超过 90s）：别留僵尸，明说错过了
                    let name = sched_name(sc);
                    sc.enabled = false; dirty = true;
                    w.notices.push(("错过了定时计划".into(), format!("「{name}」到点时机器不在线，这次没有自动开始。")));
                }
            }
            "recurring" => {
                if sc.weekdays.contains(&weekday) && sc.last_fired != today {
                    if sc.time == hhmm {
                        sc.last_fired = today.clone(); dirty = true;
                        fire.push(sc.clone());
                    } else if sc.time.as_str() < hhmm.as_str() {
                        // 今天的触发分钟已经过去（睡眠/当时没开机）：记为已处理并提示，别整天沉默
                        sc.last_fired = today.clone(); dirty = true;
                        w.notices.push(("错过了今天的计划".into(),
                            format!("{} 的定时专注这次没赶上，想跑的话去主窗口手动开。", sc.time)));
                    }
                }
            }
            _ => {}
        }
    }
    // 名字要在可变借用结束后取
    let fire: Vec<(Option<Plan>, String)> = fire.into_iter().map(|sc| {
        let name = sched_name(&sc);
        let plan = if !sc.stages.is_empty() {
            Some(Plan { id: if sc.plan_id.is_empty() { "adhoc".into() } else { sc.plan_id.clone() }, name: name.clone(), stages: sc.stages.clone(), builtin: false })
        } else {
            a.plans.iter().find(|p| p.id == sc.plan_id).cloned()
        };
        (plan, name)
    }).collect();
    if dirty { a.save_schedules(); }
    for (plan, _name) in fire {
        if a.session.status == "idle" || a.session.status == "done" {
            if let Some(p) = plan {
                if let Ok(s) = core::start_session(&p, now) {
                    a.session = s;
                    a.prev_status = "running".into(); a.prev_idx = 0;
                    a.continuous_work_ms = 0;
                    a.remind_armed = false;
                    a.save_session();
                    w.notices.push((format!("🍅 已自动开始「{}」", p.name), "到点了，这一轮已经替你开起来了。".into()));
                    w.sfx.push("switch");
                    w.state_push = Some(core::view(&a.session, &a.settings, now));
                }
            }
        } else {
            w.notices.push(("定时计划到点了".into(), "但你正在会话中，没有打断你。想切换就去主窗口。".into()));
        }
    }

    // ⑥ 会话完成 → 流水入账
    a.maybe_log_done();

    // ⑦ 托盘。秒级：菜单栏标题(mac)/气泡/状态行；分钟级：图标/菜单项/进度条
    let (title, tip, txt, rgb) = match a.session.status.as_str() {
        "running" | "paused" => {
            let cur = &a.session.stages[a.session.idx];
            let remain = if a.session.status == "running" { a.session.end_ms.saturating_sub(now) } else { a.session.remain_ms };
            let paused = a.session.status == "paused";
            let rgb = if paused { [128, 128, 128] } else if cur.kind == "work" { [232, 89, 12] } else { [12, 166, 120] };
            let sym = if paused { "‖" } else if cur.kind == "work" { "◉" } else { "◇" };
            let (mm, ss) = (remain / 60_000, remain % 60_000 / 1000);
            (Some(format!("{sym} {mm:02}:{ss:02}")),
             format!("{} {} {:02}:{:02}{} · {}", sym, if cur.kind == "work" { "工作" } else { "休息" },
                mm, ss, if paused { "（已暂停）" } else { "" }, a.session.plan_name),
             format!("{}", mm.min(99)), rgb)
        }
        "awaiting" => (Some("⏳".into()), "⏳ 等你开始下一段".to_string(), String::new(), [180, 140, 60]),
        "done" => (None, "🍅 跑完了，去看汇总".to_string(), String::new(), [233, 168, 13]),
        _ => (None, "番茄时钟 · 空闲".to_string(), String::new(), [200, 120, 90]),
    };
    let sec_key = format!("{title:?}|{tip}");
    if sec_key != a.last_tray_sec {
        a.last_tray_sec = sec_key;
        w.tray_sec = Some(TraySec { title, tip });
    }
    let toggle = if a.session.status == "paused" { "继续" } else if a.session.status == "awaiting" { "开始下一段" } else { "暂停" }.to_string();
    let toggle_en = a.session.status != "idle" && a.session.status != "done";
    let skip_en = matches!(a.session.status.as_str(), "running" | "paused" | "awaiting");
    let (prog_status, prog) = match a.session.status.as_str() {
        "running" => {
            let cur = &a.session.stages[a.session.idx];
            let done = 100u64.saturating_sub(a.session.end_ms.saturating_sub(now) * 100 / (cur.secs * 1000).max(1));
            (1u8, done.min(100))
        }
        "paused" => (2u8, 0),
        _ => (0u8, 0),
    };
    let min_key = format!("{txt}|{rgb:?}|{toggle}|{toggle_en}|{skip_en}|{prog_status}|{prog}");
    if min_key != a.last_tray {
        a.last_tray = min_key;
        w.tray = Some(TrayDraw { txt, rgb, toggle, toggle_en, skip_en, prog_status, prog });
    }

    // ⑧ 跑动中每 30s 兜底存一次盘
    if a.session.status == "running" && now.saturating_sub(a.last_save_ms) >= 30_000 {
        a.save_session();
    }

    // ⑨ 强制休息全屏遮罩：休息被锁定期间亮着 + 每秒抢回焦点（FE-40 真·强制）
    let want_rest = core::rest_locked(&a.session, &a.settings);
    if want_rest != a.rest_shown {
        a.rest_shown = want_rest;
        w.rest_show = Some(want_rest);
    }
    w.rest_regrab = want_rest;

    w
}

/// 放锁后阶段：真正执行 UI 动作。此时不持任何锁，阻塞派发到主线程也无妨。
fn apply_ui(app: &AppHandle, w: UiWork) {
    for (t, b) in &w.notices { notify(app, t, b); }
    for k in &w.sfx { sfx(app, k); }
    if let Some(v) = w.state_push { let _ = app.emit("state", v); }
    if w.attention {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    }
    if let Some(s) = w.tray_sec {
        if let Some(tray) = app.tray_by_id("tray") {
            let _ = tray.set_tooltip(Some(&s.tip));
            #[cfg(target_os = "macos")]
            let _ = tray.set_title(s.title.as_deref());
            #[cfg(not(target_os = "macos"))]
            let _ = s.title; // 其他平台托盘没有文字位，气泡里有到秒的时间
        }
        let ui: State<TrayUi> = app.state();
        let _ = ui.status.set_text(&s.tip);
    }
    if let Some(d) = w.tray {
        if let Some(tray) = app.tray_by_id("tray") {
            let _ = tray.set_icon(Some(tray_image(&d.txt, d.rgb)));
        }
        let ui: State<TrayUi> = app.state();
        let _ = ui.toggle.set_text(&d.toggle);
        let _ = ui.toggle.set_enabled(d.toggle_en);
        let _ = ui.skip.set_enabled(d.skip_en);
        // 任务栏/Dock 进度条（FE-27 的跨平台落法）
        if let Some(win) = app.get_webview_window("main") {
            use tauri::window::{ProgressBarState, ProgressBarStatus};
            let pb = match d.prog_status {
                1 => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(d.prog) },
                2 => ProgressBarState { status: Some(ProgressBarStatus::Paused), progress: None },
                _ => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
            };
            let _ = win.set_progress_bar(pb);
        }
    }
    if w.show_main {
        if let Some(win) = app.get_webview_window("main") { let _ = win.show(); let _ = win.set_focus(); }
    }
    if let Some(show) = w.rest_show { set_rest_overlay(app, show); }
    if w.rest_regrab {
        if let Some(win) = app.get_webview_window("rest") {
            if !win.is_focused().unwrap_or(true) { let _ = win.set_focus(); }
        }
    }
}

/// 强制休息遮罩窗（FE-40 真·强制）：铺满主窗口所在显示器、置顶、抢焦点。
/// 不需要系统权限；Cmd+Tab/Alt+Tab 切走会被立刻抢回来，其他窗口实际用不了。
fn set_rest_overlay(app: &AppHandle, show: bool) {
    let Some(w) = app.get_webview_window("rest") else { return };
    if show {
        // 非 mac：铺满所有显示器的包围盒 —— 只盖一块屏的话，双屏用户在另一块上照常干活，"强制"就不成立了
        #[cfg(not(target_os = "macos"))]
        {
            let mons = w.available_monitors().unwrap_or_default();
            if mons.len() > 1 {
                let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
                for m in &mons {
                    let (p, s) = (m.position(), m.size());
                    x0 = x0.min(p.x); y0 = y0.min(p.y);
                    x1 = x1.max(p.x + s.width as i32); y1 = y1.max(p.y + s.height as i32);
                }
                let _ = w.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(x0, y0)));
                let _ = w.set_size(tauri::Size::Physical(tauri::PhysicalSize::new((x1 - x0) as u32, (y1 - y0) as u32)));
            } else if let Some(mon) = mons.into_iter().next() {
                let _ = w.set_position(tauri::Position::Physical(*mon.position()));
                let _ = w.set_size(tauri::Size::Physical(*mon.size()));
            }
        }
        #[cfg(target_os = "macos")]
        {
            let mon = app.get_webview_window("main")
                .and_then(|m| m.current_monitor().ok().flatten())
                .or_else(|| w.primary_monitor().ok().flatten());
            if let Some(mon) = mon {
                let _ = w.set_position(tauri::Position::Physical(*mon.position()));
                let _ = w.set_size(tauri::Size::Physical(*mon.size()));
            }
        }
        let _ = w.set_visible_on_all_workspaces(true);
        let _ = w.set_always_on_top(true);
        let _ = w.show();
        #[cfg(target_os = "macos")]
        let _ = w.set_simple_fullscreen(true); // 非原生全屏：不建新 Space、没有切换动画
        let _ = w.set_focus();
    } else {
        #[cfg(target_os = "macos")]
        let _ = w.set_simple_fullscreen(false);
        let _ = w.hide();
        if let Some(m) = app.get_webview_window("main") {
            if m.is_visible().unwrap_or(false) { let _ = m.set_focus(); }
        }
    }
}

/// 命令路径（跳过/暂停等）也可能进出锁定休息段，跟滴答线程共用同一套开合判断。
fn sync_rest_overlay(app: &AppHandle) {
    let change = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let want = core::rest_locked(&a.session, &a.settings);
        if want == a.rest_shown { None } else { a.rest_shown = want; Some(want) }
    };
    if let Some(show) = change { set_rest_overlay(app, show); }
}

// ———————————————————————— 命令 ————————————————————————
// 全部 async：跑在异步线程池上，主线程绝不因等 App 锁被卡住（死锁修复的另一半）。
#[derive(Serialize)]
struct MissedPlan {
    name: String,
    plan_id: String,
    stages: Vec<core::Stage>, // 解析好的真实序列 —— 补跑要跑"错过的那个"，不是编辑器里正好装着的
}

#[derive(Serialize)]
struct Boot {
    settings: Settings,
    plans: Vec<Plan>,
    view: core::View,
    schedules: Vec<Schedule>,
    missed: Vec<MissedPlan>, // 错过的计划（FE-33：启动时询问补跑）
}

#[tauri::command]
async fn boot(app: AppHandle) -> Boot {
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();
    core::project(&mut a.session, &cfg, now);
    a.prev_status = a.session.status.clone();
    a.prev_idx = a.session.idx;
    // 错过的一次性计划：到点了但当时没开机。带上解析好的序列，前端"补跑"直接照着开
    let plan_lookup: Vec<Plan> = a.plans.clone();
    let mut missed = vec![];
    for sc in a.schedules.iter_mut() {
        if sc.enabled && matches!(sc.mode.as_str(), "once" | "delay") && sc.trigger_at > 0 && now > sc.trigger_at + 90_000 {
            sc.enabled = false;
            let found = plan_lookup.iter().find(|p| p.id == sc.plan_id);
            let name = if !sc.name.is_empty() { sc.name.clone() } else { found.map(|p| p.name.clone()).unwrap_or_default() };
            let stages = if !sc.stages.is_empty() { sc.stages.clone() } else { found.map(|p| p.stages.clone()).unwrap_or_default() };
            if !stages.is_empty() {
                missed.push(MissedPlan { name, plan_id: sc.plan_id.clone(), stages });
            }
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
async fn get_state(app: AppHandle) -> core::View {
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    let now = now_ms();
    let cfg = a.settings.clone();
    core::project(&mut a.session, &cfg, now);
    a.maybe_log_done();
    core::view(&a.session, &a.settings, now)
}

fn do_session_start(app: &AppHandle, plan: &Plan) -> Result<core::View, String> {
    let view = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let now = now_ms();
        a.session = core::start_session(plan, now)?;
        a.prev_status = "running".into();
        a.prev_idx = 0;
        a.continuous_work_ms = 0;
        a.remind_armed = false;
        a.save_session();
        core::view(&a.session, &a.settings, now)
    };
    sync_rest_overlay(app);
    let _ = app.emit("state", view.clone()); // 广播给所有窗口（主窗口/遮罩窗谁发起的都同步）
    Ok(view)
}

#[tauri::command]
async fn session_start(app: AppHandle, plan: Plan) -> Result<core::View, String> {
    do_session_start(&app, &plan)
}

fn do_session_cmd(app: &AppHandle, cmd: &str) -> Result<core::View, String> {
    let (view, settings_push) = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let now = now_ms();
        let cfg = a.settings.clone();
        if cmd == "stop" {
            // 结束前把账推到 now 并入流水（放弃也如实记部分时长）
            core::project(&mut a.session, &cfg, now);
            a.log_abandoned();
        }
        let out = core::apply(&mut a.session, &cfg, cmd, now)?;
        let mut settings_push = None;
        if out.unlock_consumed {
            a.settings.final_break_unlock = false;
            a.save_settings();
            settings_push = Some(a.settings.clone()); // 推给前端，别让设置面板里的开关继续亮着骗人
        }
        if a.session.status == "awaiting" && a.prev_status != "awaiting" {
            // 命令路径也可能落进段间等待（内核投影发生在 apply 里）：强提醒计时从现在起算
            a.last_strong_ms = now;
            a.remind_armed = true;
        }
        a.prev_status = a.session.status.clone();
        a.prev_idx = a.session.idx;
        a.maybe_log_done();
        a.save_session();
        (core::view(&a.session, &a.settings, now), settings_push)
    };
    sync_rest_overlay(app);
    if let Some(s) = settings_push { let _ = app.emit("settings", s); }
    let _ = app.emit("state", view.clone()); // 广播给所有窗口
    Ok(view)
}

#[tauri::command]
async fn session_cmd(app: AppHandle, cmd: String) -> Result<core::View, String> {
    do_session_cmd(&app, &cmd)
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Settings) -> Settings {
    let (saved, pet_changed) = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let autostart_changed = a.settings.autostart != settings.autostart;
        let pet_changed = a.settings.pet_hidden != settings.pet_hidden;
        a.settings = settings;
        a.save_settings();
        if autostart_changed {
            use tauri_plugin_autostart::ManagerExt;
            let al = app.autolaunch();
            if a.settings.autostart { let _ = al.enable(); } else { let _ = al.disable(); }
        }
        (a.settings.clone(), pet_changed)
    };
    // 锁已放，才能安全碰窗口/菜单（线程纪律）
    if pet_changed { apply_pet_visibility(&app, saved.pet_hidden); }
    // 休息策略被改（强制→非强制）时，遮罩要立刻跟着收
    sync_rest_overlay(&app);
    saved
}

/// 桌宠窗显隐 + 托盘菜单文字同步（调用方保证不持 App 锁）
fn apply_pet_visibility(app: &AppHandle, hidden: bool) {
    if let Some(w) = app.get_webview_window("pet") {
        if hidden { let _ = w.hide(); } else { let _ = w.show(); }
    }
    let ui: State<TrayUi> = app.state();
    let _ = ui.pet.set_text(if hidden { "显示桌宠" } else { "隐藏桌宠" });
}

#[tauri::command]
async fn save_plans(app: AppHandle, plans: Vec<Plan>) -> Vec<Plan> {
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    let mut merged = core::builtin_plans();
    merged.extend(plans.into_iter().filter(|p| !p.builtin));
    a.plans = merged;
    a.save_plans();
    a.plans.clone()
}

#[tauri::command]
async fn save_schedules(app: AppHandle, schedules: Vec<Schedule>) -> Vec<Schedule> {
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    a.schedules = schedules;
    a.save_schedules();
    a.schedules.clone()
}

#[tauri::command]
async fn get_history(app: AppHandle, limit: usize) -> Vec<serde_json::Value> {
    let state: State<Mutex<App>> = app.state();
    let a = state.lock().unwrap();
    let txt = fs::read_to_string(a.dir.join("history.jsonl")).unwrap_or_default();
    let mut v: Vec<serde_json::Value> = txt.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    let n = v.len();
    if n > limit { v.drain(0..n - limit); }
    v
}

/// 回主窗口（编排/跳过/结束都在那边）。桌宠右键菜单的「打开主窗口」走这条。
#[tauri::command]
async fn open_main(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 桌宠右键菜单（系统原生弹出菜单）。
/// 为什么不是 HTML 菜单：桌宠窗只有 260×250，HTML 画的菜单会被窗口边界裁掉，
/// 而系统菜单不受窗口尺寸限制，Mac 上观感也是对的。
/// 菜单项 id 与托盘菜单同名 —— muda 的菜单事件是全局广播（tray 的 on_menu_event
/// 挂在 global_event_listeners 上），托盘那份处理器会照单收下，这里不用再挂一份。
/// 每次右键现搭一份：标签/可用性按当下状态算，永远不会显示成过期的「暂停」。
#[tauri::command]
async fn pet_menu(app: AppHandle) {
    // 锁内只取快照。建菜单的 MenuItem::with_id 是「同步派发到主线程并阻塞等结果」，
    // 持着 App 锁去等主线程 = 文件头那条死锁纪律，必须放锁之后再建。
    let (toggle_txt, toggle_en, skip_en) = {
        let state: State<Mutex<App>> = app.state();
        let a = state.lock().unwrap();
        let txt = match a.session.status.as_str() {
            "paused" => "继续", "awaiting" => "开始下一段", _ => "暂停",
        };
        (txt.to_string(),
         a.session.status != "idle" && a.session.status != "done",
         matches!(a.session.status.as_str(), "running" | "paused" | "awaiting"))
    };
    let Some(pet) = app.get_webview_window("pet") else { return };
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let toggle = MenuItem::with_id(&app, "toggle", &toggle_txt, toggle_en, None::<&str>)?;
        let skip = MenuItem::with_id(&app, "skip", "跳过这一段", skip_en, None::<&str>)?;
        let show = MenuItem::with_id(&app, "show", "打开主窗口", true, None::<&str>)?;
        let settings = MenuItem::with_id(&app, "settings", "设置…", true, None::<&str>)?;
        let hide = MenuItem::with_id(&app, "pet", "隐藏桌宠", true, None::<&str>)?;
        Menu::with_items(&app, &[
            &toggle, &skip, &PredefinedMenuItem::separator(&app)?,
            &show, &settings, &hide,
        ])
    };
    if let Ok(menu) = build() { let _ = pet.popup_menu(&menu); }
}

/// 陪伴活动（守烛/键盘/读书/写字）：随时可换，落进会话并入流水。
/// 改完必须广播 state —— 计时中主窗是藏着的，用户看的是桌宠窗，它只认 state 推送
/// （不广播的话要等下一次状态跳变才刷新，表现为"切了活动没反应，暂停再开始才变"）。
#[tauri::command]
async fn set_activity(app: AppHandle, activity: String) {
    let view = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        if a.session.activity == activity { return; }
        a.session.activity = activity;
        if a.session.status != "idle" { a.save_session(); }
        core::view(&a.session, &a.settings, now_ms())
    };
    let _ = app.emit("state", view);
}

/// 遮罩窗失焦时自己喊一声，Rust 立刻把焦点抢回来（比等下一秒滴答更快）
#[tauri::command]
async fn rest_focus(app: AppHandle) -> bool {
    let want = {
        let state: State<Mutex<App>> = app.state();
        let a = state.lock().unwrap();
        a.rest_shown && core::rest_locked(&a.session, &a.settings)
    };
    if want {
        if let Some(w) = app.get_webview_window("rest") { let _ = w.set_focus(); }
    }
    want
}

// ———————————————————————— 组装 ————————————————————————
fn toggle_session(app: &AppHandle) {
    let cmd = {
        let state: State<Mutex<App>> = app.state();
        let a = state.lock().unwrap();
        match a.session.status.as_str() {
            "running" => "pause", "paused" => "resume", "awaiting" => "start_next",
            _ => return,
        }.to_string()
    };
    let _ = do_session_cmd(app, &cmd); // 广播在 do_session_cmd 里统一发
}
fn skip_session(app: &AppHandle) {
    let _ = do_session_cmd(app, "skip");
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
            let pet_hidden0 = loaded.settings.pet_hidden;
            app.manage(Mutex::new(loaded));

            // 自启且静默：只留托盘，不亮主窗口（FE-25 启动形态）
            if silent {
                if let Some(w) = app.get_webview_window("main") { let _ = w.hide(); }
            }
            // 桌宠窗常驻，但用户收起过就保持收起（托盘/设置里可再叫出来）
            if pet_hidden0 {
                if let Some(w) = app.get_webview_window("pet") { let _ = w.hide(); }
            }

            // 桌宠窗默认落在主屏右下角（拖动后位置由前端 localStorage 记忆并恢复）
            if let Some(pet) = app.get_webview_window("pet") {
                if let Ok(Some(mon)) = pet.primary_monitor() {
                    let sf = mon.scale_factor();
                    let (mw, mh) = (mon.size().width as f64, mon.size().height as f64);
                    let (pw, ph) = (260.0 * sf, 250.0 * sf);
                    let _ = pet.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
                        (mw - pw - 24.0 * sf) as i32,
                        (mh - ph - 90.0 * sf) as i32,
                    )));
                }
            }

            // 托盘 + 迷你菜单（FE-24）
            let status = MenuItem::with_id(app, "status", "番茄时钟 · 空闲", false, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "暂停", false, None::<&str>)?;
            let skip = MenuItem::with_id(app, "skip", "跳过这一段", false, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
            let pet_item = MenuItem::with_id(app, "pet", if pet_hidden0 { "显示桌宠" } else { "隐藏桌宠" }, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[
                &status, &PredefinedMenuItem::separator(app)?,
                &toggle, &skip, &PredefinedMenuItem::separator(app)?,
                &show, &pet_item, &quit,
            ])?;
            app.manage(TrayUi { status: status.clone(), toggle: toggle.clone(), skip: skip.clone(), pet: pet_item.clone() });
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
                    // 桌宠右键菜单里的「设置…」：主窗弹出来还不够，得直接把设置面板展开
                    "settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show(); let _ = w.set_focus();
                            let _ = w.emit("open_settings", ());
                        }
                    }
                    "pet" => {
                        // 先在锁内翻状态落盘，放锁后才碰窗口/菜单（线程纪律）
                        let hidden = {
                            let state: State<Mutex<App>> = app.state();
                            let mut a = state.lock().unwrap();
                            a.settings.pet_hidden = !a.settings.pet_hidden;
                            a.save_settings();
                            a.settings.pet_hidden
                        };
                        apply_pet_visibility(app, hidden);
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
                // 桌宠被 Alt+F4 收起：记进设置并同步托盘菜单文字，托盘里随时能再叫出来
                if window.label() == "pet" {
                    let app = window.app_handle();
                    {
                        let state: State<Mutex<App>> = app.state();
                        let mut a = state.lock().unwrap();
                        a.settings.pet_hidden = true;
                        a.save_settings();
                    }
                    let ui: State<TrayUi> = app.state();
                    let _ = ui.pet.set_text("显示桌宠");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            boot, get_state, session_start, session_cmd,
            save_settings, save_plans, save_schedules, get_history, rest_focus, set_activity,
            open_main, pet_menu
        ])
        .run(tauri::generate_context!())
        .expect("番茄时钟启动失败")
}
