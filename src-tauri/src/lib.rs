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
//
// ⚠️ 平台切分（cfg(desktop) / cfg(mobile)）：
//   desktop = Windows + macOS + Linux；mobile = iOS + Android。注意 macOS 属于 desktop 这一边，
//   跟 iOS 分在两处 —— 别把 cfg(desktop) 看成"只有 Windows"。
//   凡是桌面独有的能力（托盘、全局快捷键、开机自启、任务栏进度条、pet/rest 两个附属窗口）
//   一律用 #[cfg(desktop)] 圈起来；移动端只留内核 + 命令 + 通知 + 一个主 webview。
//   给移动端补空实现的函数（sync_rest_overlay / apply_pet_visibility）是有意为之：
//   调用点因此不用加 cfg，桌面端的调用路径一个字都没动。
//
// ⚠️ 配置也分了两份：iOS 走 tauri.ios.conf.json 覆盖（Tauri 会合并到主 conf 之上，
//   对象递归合并、数组整体替换），桌面端读到的仍是原来那份 tauri.conf.json。
//   🔴 千万别图省事直接改主 conf 的 identifier —— app_data_dir() 是按 identifier 算的，
//   一改桌面端的数据目录就换了地方，用户现有的 settings/plans/session/history 全部读不到。
//   移动端 identifier = com.tybbtech.capyroom（与桌面端是两个独立产品，App Store 条目也是独立的）；
//   productName 在 iOS 侧特意用 ASCII：tauri ios init 拿它生成 Xcode 工程名和 scheme，中文是已知的雷。
//   iOS 那份只留 main 一个窗口 —— rest 遮罩窗和 pet 桌宠窗在移动端不存在。
mod core;
mod rewards;

use core::{Plan, Session, Settings};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
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

// 移动端不画托盘、没有遮罩窗 → last_tray / last_tray_sec / rest_shown 三个字段没人读，
// 但保留它们能让 App 的构造和存取路径两边完全一致（少一个平台分叉就少一处走形）。
#[cfg_attr(mobile, allow(dead_code))]
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
    /// iOS 本地通知的排期指纹（status/idx/end_ms）。滴答每秒都会推 state，
    /// 但排期只在这三样真的变了时才需要重排 —— 每秒 cancel_all + 重排一遍
    /// 是往 Swift 桥上狂敲，白烧电。
    #[cfg(mobile)]
    last_arm: String,
    /// 诊断条用：上一次真排上了几条、报的什么错。真机上"排没排上"必须看得见 ——
    /// 第一版就是因为看不见，"没听到声音"到底是没排上、没授权还是静音，三种可能分不开。
    #[cfg(mobile)]
    arm_count: usize,
    #[cfg(mobile)]
    arm_err: String,
    /// 屏幕常亮当前是开是关（只在翻转时才去动 UIApplication）
    #[cfg(mobile)]
    keep_awake: bool,
    /// 长期统计（两端都记：桌面端也会有"来过几次"的用处）
    stats: Stats,
}

#[derive(Serialize, Deserialize)]
struct SavedSession {
    saved_at: u64,
    session: Session,
}

/// 长期统计（`stats.json`）。
///
/// 🔴 2026-08-29 用户拍板：「攒什么能吸引用户」以后再定，**但打开次数这类数据现在
///    就要开始记，以后用得到**。所以这里只管**攒数**，不做任何解释和展示 ——
///    等养成/拜访那条线定了，再决定拿哪几个数字说事。
/// ⚠️ 只增不改：以后要加字段直接加（`#[serde(default)]` 保证老文件照读），
///    但已有字段的**含义不许改**，否则历史数字会变成一笔糊涂账。
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Stats {
    launches: u64,           // 冷启动次数（"来过几次"最朴素的那个数）
    first_launch_ms: u64,    // 第一次打开的时刻 —— 以后算"认识多久了"要用
    last_launch_ms: u64,
    sessions_started: u64,
    sessions_done: u64,      // 完整跑完的场次
    sessions_abandoned: u64, // 中途结束且够门槛入账的场次
    work_ms: u64,            // 累计专注（按**实际经过时间**，跟流水同口径）
    rest_ms: u64,
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
        // 打开次数在这儿 +1（App::load 每个进程只跑一次＝一次冷启动）
        let mut stats: Stats = read("stats.json").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        stats.launches += 1;
        let boot_now = now_ms();
        if stats.first_launch_ms == 0 { stats.first_launch_ms = boot_now; }
        stats.last_launch_ms = boot_now;
        if let Ok(s) = serde_json::to_string_pretty(&stats) { fs::write(dir.join("stats.json"), s).ok(); }
        // prev_* 直接对齐恢复出来的会话：否则滴答线程会把"恢复"误判成"刚发生的切换"，
        // 启动即重发完成/等待通知，restored done 还会在静默自启时强行弹主窗（曾依赖前端 boot 在 1s 内抢先对齐，竞态）
        let (prev_status, prev_idx) = (session.status.clone(), session.idx);
        App {
            dir, settings, plans, session, schedules,
            prev_status, prev_idx, prealert_idx: -1,
            last_strong_ms: 0, continuous_work_ms: 0, last_sit_ms: 0,
            last_tray: String::new(), last_tray_sec: String::new(),
            rest_shown: false, last_save_ms: 0, remind_armed: false,
            #[cfg(mobile)] last_arm: String::new(),
            #[cfg(mobile)] arm_count: 0,
            #[cfg(mobile)] arm_err: String::new(),
            #[cfg(mobile)] keep_awake: false,
            stats,
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
    fn save_stats(&self) {
        if let Ok(s) = serde_json::to_string_pretty(&self.stats) { fs::write(self.dir.join("stats.json"), s).ok(); }
    }
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
        // 统计跟流水同一个口径、同一个时刻入账：流水记明细，stats 记总数
        if completed { self.stats.sessions_done += 1; } else { self.stats.sessions_abandoned += 1; }
        self.stats.work_ms += self.session.acc_work_ms;
        self.stats.rest_ms += self.session.acc_rest_ms;
        self.save_stats();
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
#[cfg(desktop)]
const FONT: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111], [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111], [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001], [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111], [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111], [0b111, 0b101, 0b111, 0b001, 0b111],
];

#[cfg(desktop)]
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

#[cfg(desktop)]
struct TrayUi {
    status: MenuItem<tauri::Wry>,
    toggle: MenuItem<tauri::Wry>,
    skip: MenuItem<tauri::Wry>,
    pet: MenuItem<tauri::Wry>,
}

// ———————————————————————— 通知 + 音效（音效发给前端 WebAudio 播） ————————————————————————
fn notify(app: &AppHandle, title: &str, body: &str) {
    // iOS 上不显式给 sound 就是静默横幅（见下面 SOUND 那条注释）。走这条路的是强提醒和
    // 久坐提醒 —— 它们本来就是"要把人叫回来"的，没声音等于没有。
    // 🔴 但必须听「提示音」这个开关：用户 8-29 反馈"关了提示音到点还是响"，
    //    因为声音其实是系统通知发的，而那条路当时根本没看设置 —— 开关说了不算＝在说假话。
    // ⚠️ 取完 sound_on 立刻放锁再去碰插件：持锁调插件就是 8-25 那个死锁的翻版。
    #[cfg(mobile)]
    let want_sound = {
        let state: State<Mutex<App>> = app.state();
        let on = state.lock().unwrap().settings.sound_on;
        on
    };
    let b = app.notification().builder().title(title).body(body);
    #[cfg(mobile)]
    let b = if want_sound { b.sound(SOUND) } else { b };
    let _ = b.show();
}
fn sfx(app: &AppHandle, kind: &str) {
    let _ = app.emit("sfx", kind);
}

// ———————————————————————— iOS：把段末提醒提前委托给系统 ————————————————————————
// iOS 上 App 进后台**完全冻结**：没有线程、没有定时器、没有 JS。桌面端那个每秒
// 一次的滴答线程一锁屏就死了，段结束时不会有任何提示 —— 而这个产品的定位就是
// "手机立在桌上当摆件，人去干别的事"，不能叫人就等于不成立。
//
// 计时本身不会错（内核是"目标时间戳 + 惰性投影"，回前台一投影就准）。做不到的
// 只是"在后台叫你"，所以只能提前把所有切换时刻**批量注册成系统本地通知**。
//
// 🔴 移动端一律只走排期、滴答不再发切段通知：iOS 的 willPresent 前台也会弹
//    （插件里返回 [.badge, .sound, ...]），两条路一起走就会双响。
// 🔴 每次状态变化都要重排：用户暂停/跳过之后，旧的排期绝不能照响。
// 🔴🔴 时区修正（2026-08-29 加，第一版真机"到点没有任何动静"的头号嫌疑）：
//    插件 iOS 侧解析我们发过去的日期串用的是
//      dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
//    —— 那个 'Z' 只是个**字面量字符**，而 formatter 没有设 timeZone，默认取设备本地时区。
//    我们发的是 UTC 时刻，它按东八区读 → 提前 8 小时 → 落在过去 →
//    插件直接 throw pastScheduledTime，一条都排不上（源码：ios/Sources/Notification.swift:179-188）。
//    对策：把要发的时刻**先加上本地偏移**，让序列化出来的 UTC 墙上时间恰好等于本地墙上时间，
//    被它误读一次正好还原。用 chrono 取偏移（time 的 current_local_offset 在多线程程序里会拒绝返回）。
//    ⚠️ 这是绕插件的坑，不是正道；插件哪天修好了这里要跟着去掉 —— 所以单独拎成一个函数，
//    真机上到底哪一版能响由 test_notify 的 A/B 三连当场判定，不靠猜。
#[cfg(mobile)]
fn sched_date(at_ms: u64, shift: bool) -> Option<time::OffsetDateTime> {
    let off = if shift {
        chrono::Local::now().offset().local_minus_utc() as i64
    } else {
        0
    };
    time::OffsetDateTime::from_unix_timestamp((at_ms / 1000) as i64 + off).ok()
}

// 通知声音：插件只有在我们显式传了 sound 才会去设 content.sound，不传就是 nil＝静默横幅
//（源码：ios/Sources/Notification.swift:65-66）。第一版没传，所以就算排上了也不会响。
#[cfg(mobile)]
const SOUND: &str = "default";

#[cfg(mobile)]
fn arm_notifications(app: &AppHandle) {
    use tauri_plugin_notification::{NotificationExt, PermissionState, Schedule};

    // 锁内只取快照，放锁后再碰插件 —— 插件调用会派发到主线程，
    // 持锁去碰就是 8-25 那个死锁的翻版。
    let (awake_change, switches, sound_on, lang) = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let sound_on = a.settings.sound_on;
        let lang = a.settings.lang.clone();   // 通知文案按语言选（9-2 双语）；进指纹，切语言要重排
        // 常亮只在"在跑没跑"真的翻转时才去动。滴答每秒都会走到这儿，
        // 每秒往主线程派一条 ObjC 消息是白烧电 —— 而省电正是我们要量的东西。
        let want = a.session.status == "running";
        let awake_change = if a.keep_awake != want { a.keep_awake = want; Some(want) } else { None };
        // 🔴 指纹里必须带上 sound_on：排期是**提前**发出去的，改设置时那批通知已经躺在
        //    系统里了。不带的话"关掉提示音"要等下一次切段才生效，本次会话照响。
        let fp = format!("{}|{}|{}|{}|{}", a.session.status, a.session.idx, a.session.end_ms, sound_on, lang);
        if fp == a.last_arm {
            (awake_change, None, sound_on, lang) // 排期没变，不用往 Swift 桥上白敲一遍
        } else {
            a.last_arm = fp;
            let cfg = a.settings.clone();
            (awake_change, Some(core::future_switches(&a.session, &cfg)), sound_on, lang)
        }
    };

    // 屏幕常亮跟着"在跑没跑"走：跑着就别让它息屏（摆件形态的前提），
    // 一暂停/等待/完成立刻还给系统 —— 常亮和省电是对着干的，不能一直占着。
    if let Some(on) = awake_change {
        set_keep_awake(app, on);
    }

    let switches = match switches {
        Some(s) => s,
        None => return,
    };

    let n = app.notification();
    let _ = n.cancel_all(); // 先撤销未触发的旧排期

    // 没授权就别排：排了也不会响，还会让诊断条上的数字骗人
    let granted = matches!(n.permission_state(), Ok(PermissionState::Granted));

    let now = now_ms();
    let mut count = 0usize;
    let mut err = String::new();
    if granted {
        for (i, sw) in switches.iter().enumerate() {
            if sw.at_ms <= now + 1000 {
                continue; // 已经过去的时刻，iOS 也不会触发
            }
            let date = match sched_date(sw.at_ms, true) {
                Some(d) => d,
                None => continue,
            };
            let en = lang == "en";
            let (title, body) = match sw.to.as_str() {
                "break"    => if en { ("Time to get out", "This focus block is done. Go soak a while.") } else { ("上岸歇会儿", "这一段专注走完了，去泡一泡。") },
                "work"     => if en { ("Back in the water", "Break's over. Next block starts now.") } else { ("回水里吧", "休息结束，下一段开始了。") },
                "awaiting" => if en { ("Block finished", "Come back and tap to start the next one.") } else { ("这一段走完了", "回来点一下，接着下一段。") },
                _          => if en { ("Session complete", "The whole session is done. Come take a look.") } else { ("这一场结束了", "整场都跑完了，回来看看吧。") },
            };
            // 🔴「提示音」开关要管到这儿：段末那一声其实是系统排期通知发的，
            //    不看设置的话，用户把开关关了照样响 ＝ 开关在说假话
            let mut b = n.builder().id(9000 + i as i32).title(title).body(body);
            if sound_on { b = b.sound(SOUND); }
            match b
                .schedule(Schedule::At { date, repeating: false, allow_while_idle: true })
                .show()
            {
                Ok(_) => count += 1,
                Err(e) => if err.is_empty() { err = e.to_string(); },
            }
        }
    } else if !switches.is_empty() {
        err = "未授权".into();
    }

    // 落进诊断条：真机上"到底排上几条、报的什么错"必须看得见，不能只能靠猜
    let state: State<Mutex<App>> = app.state();
    let mut a = state.lock().unwrap();
    a.arm_count = count;
    a.arm_err = err;
}

// ———————————————————————— 屏幕常亮（iOS） ————————————————————————
// Tauri 没有这个 API，自己给 UIApplication 发一条 setIdleTimerDisabled:。
// 🔴 必须回主线程：UIKit 的属性不能在滴答线程上写。
#[cfg(target_os = "ios")]
fn set_keep_awake(app: &AppHandle, on: bool) {
    let _ = app.run_on_main_thread(move || unsafe {
        use objc2::runtime::{AnyObject, Bool};
        use objc2::{class, msg_send};
        let shared: *mut AnyObject = msg_send![class!(UIApplication), sharedApplication];
        if !shared.is_null() {
            let _: () = msg_send![shared, setIdleTimerDisabled: Bool::new(on)];
        }
    });
}

// 桌面端与 Android：没有 idleTimer 这个概念（桌面息屏归系统电源策略管）
#[cfg(not(target_os = "ios"))]
#[allow(dead_code)]
#[inline]
fn set_keep_awake(_app: &AppHandle, _on: bool) {}

// 桌面端不需要排期：滴答线程一直活着，到点直接发即时通知。
#[cfg(desktop)]
#[inline]
fn arm_notifications(_app: &AppHandle) {}

// ———————————————————————— UI 动作清单：锁内攒、放锁后做 ————————————————————————
// 前三项两个平台都有（通知/音效/状态推送）；其余全是桌面窗口与托盘的活儿。
#[derive(Default)]
struct UiWork {
    notices: Vec<(String, String)>,   // 系统通知（标题, 正文）
    sfx: Vec<&'static str>,
    state_push: Option<core::View>,   // 状态快照推给所有窗口
    #[cfg(desktop)] attention: bool,              // 主窗口闪烁请求
    #[cfg(desktop)] tray: Option<TrayDraw>,       // 图标/菜单/进度条（分钟级变化才动）
    #[cfg(desktop)] tray_sec: Option<TraySec>,    // 标题(mac)/气泡/状态行（秒级）
    #[cfg(desktop)] rest_show: Option<bool>,      // Some(true)=弹强制休息遮罩，Some(false)=收
    #[cfg(desktop)] rest_regrab: bool,            // 遮罩活跃期间每秒抢回焦点
    #[cfg(desktop)] show_main: bool,              // 会话完成 → 主窗口回来展示汇总
}
#[cfg(desktop)]
struct TrayDraw {
    txt: String,
    rgb: [u8; 3],
    toggle: String,
    toggle_en: bool,
    skip_en: bool,
    prog_status: u8, // 0=无 1=正常 2=暂停
    prog: u64,
}
#[cfg(desktop)]
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
                    // 🔴 移动端这三类切段通知由 arm_notifications 的**排期**负责：
                    //    iOS 前台也会弹排期通知，两条路一起走就会双响。
                    #[cfg(desktop)]
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
                #[cfg(desktop)]
                w.notices.push(("这一段走完了".into(), body.into()));
                #[cfg(mobile)]
                let _ = body;
                w.sfx.push("switch");
                a.last_strong_ms = now;
                a.remind_armed = true;
            }
            "done" => {
                #[cfg(desktop)]
                w.notices.push(("🍅 这一轮收获满满".into(), "整个序列都跑完了，去看看汇总吧。".into()));
                w.sfx.push("done");
                #[cfg(desktop)]
                { w.show_main = true; } // 跑完把主窗口叫回来看汇总（桌宠期间主窗是藏着的）
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
        #[cfg(desktop)]
        { w.attention = true; }
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
    // 移动端没有托盘也没有任务栏 —— 整段不参与编译（手机上的"还剩多久"归通知和界面自己管）
    #[cfg(desktop)]
    {
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
    }

    // ⑧ 跑动中每 30s 兜底存一次盘
    if a.session.status == "running" && now.saturating_sub(a.last_save_ms) >= 30_000 {
        a.save_session();
    }

    // ⑨ 强制休息全屏遮罩：休息被锁定期间亮着 + 每秒抢回焦点（FE-40 真·强制）
    // 移动端没有"另开一个窗口盖住屏幕"这回事（也不需要 —— 手机上人本来就没在看屏幕），
    // 强制休息在移动端要怎么表达是产品设计问题，不在这一层解决。
    #[cfg(desktop)]
    {
        let want_rest = core::rest_locked(&a.session, &a.settings);
        if want_rest != a.rest_shown {
            a.rest_shown = want_rest;
            w.rest_show = Some(want_rest);
        }
        w.rest_regrab = want_rest;
    }

    w
}

/// 放锁后阶段：真正执行 UI 动作。此时不持任何锁，阻塞派发到主线程也无妨。
fn apply_ui(app: &AppHandle, w: UiWork) {
    for (t, b) in &w.notices { notify(app, t, b); }
    for k in &w.sfx { sfx(app, k); }
    if let Some(v) = w.state_push { let _ = app.emit("state", v); }
    arm_notifications(app);
    // 以下全是桌面窗口与托盘的活儿：闪窗、托盘图标/菜单栏/气泡、任务栏进度条、
    // 主窗召回、强制休息遮罩。移动端一样都没有 —— 整块不参与编译。
    #[cfg(desktop)]
    {
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
}

/// 强制休息遮罩窗（FE-40 真·强制）：铺满主窗口所在显示器、置顶、抢焦点。
/// 不需要系统权限；Cmd+Tab/Alt+Tab 切走会被立刻抢回来，其他窗口实际用不了。
#[cfg(desktop)]
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

/// 移动端没有遮罩窗，给个空实现 —— 这样 do_session_start / do_session_cmd / save_settings
/// 三处调用点保持原样，桌面端的路径一个字都没动。
#[cfg(mobile)]
fn sync_rest_overlay(_app: &AppHandle) {}

/// 命令路径（跳过/暂停等）也可能进出锁定休息段，跟滴答线程共用同一套开合判断。
#[cfg(desktop)]
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
    // 通知权限在**第一次开始会话时**要，不在冷启动时要 —— 用户刚点了"开始"，
    // 这时候弹"允许通知"才讲得通；一打开 App 就弹框只会吓跑人。
    // 没授权的话段末提醒根本响不了，而这个产品 90% 时间用户不看屏幕，只能靠听。
    // 🔴 要等授权真的落定再往下走：request_permission 会一直等到用户点了那个系统弹框
    //    才返回。第一版把返回值丢了、紧接着就去排期 —— 授权还没点，排期就已经发出去了。
    #[cfg(mobile)]
    {
        use tauri_plugin_notification::{NotificationExt, PermissionState};
        let n = app.notification();
        if !matches!(n.permission_state(), Ok(PermissionState::Granted)) {
            let _ = n.request_permission();
        }
    }
    let view = {
        let state: State<Mutex<App>> = app.state();
        let mut a = state.lock().unwrap();
        let now = now_ms();
        a.session = core::start_session(plan, now)?;
        a.stats.sessions_started += 1;
        a.save_stats();
        a.prev_status = "running".into();
        a.prev_idx = 0;
        a.continuous_work_ms = 0;
        a.remind_armed = false;
        a.save_session();
        core::view(&a.session, &a.settings, now)
    };
    sync_rest_overlay(app);
    let _ = app.emit("state", view.clone()); // 广播给所有窗口（主窗口/遮罩窗谁发起的都同步）
    arm_notifications(app);
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
    arm_notifications(app);
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
        // 开机自启是桌面概念（移动端由系统统一管，App 无权自启）
        #[cfg(desktop)]
        if autostart_changed {
            use tauri_plugin_autostart::ManagerExt;
            let al = app.autolaunch();
            if a.settings.autostart { let _ = al.enable(); } else { let _ = al.disable(); }
        }
        #[cfg(mobile)]
        let _ = autostart_changed;
        (a.settings.clone(), pet_changed)
    };
    // 锁已放，才能安全碰窗口/菜单（线程纪律）
    if pet_changed { apply_pet_visibility(&app, saved.pet_hidden); }
    // 休息策略被改（强制→非强制）时，遮罩要立刻跟着收
    sync_rest_overlay(&app);
    // 🔴 改完设置要重排通知：段末那批是**提前**发进系统的，
    //    关掉提示音/改了自动衔接，不重排就还是按老设置响
    arm_notifications(&app);
    saved
}

/// 移动端没有桌宠窗（整块屏幕就是舞台），同样给空实现保住调用点
#[cfg(mobile)]
fn apply_pet_visibility(_app: &AppHandle, _hidden: bool) {}

/// 桌宠窗显隐 + 托盘菜单文字同步（调用方保证不持 App 锁）
#[cfg(desktop)]
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

/// 长期统计。现在没有任何界面用它 —— 存在的理由是**数据不补记**：
/// 等以后"攒什么"定了，回头就有账可查；今天不记，那段历史永远没有了。
#[tauri::command]
async fn get_stats(app: AppHandle) -> Stats {
    let state: State<Mutex<App>> = app.state();
    let a = state.lock().unwrap();
    a.stats.clone()
}

// ── P3 奖励载体（rewards.rs）：账本从 history.jsonl 重算，状态落 rewards.json ──
// 🔴 只取 dir 后立刻放锁：规则计算不需要 App 状态，别让读文件顶着内核锁。
fn data_dir(app: &AppHandle) -> PathBuf {
    let state: State<Mutex<App>> = app.state();
    let a = state.lock().unwrap();
    a.dir.clone()
}
#[tauri::command]
async fn get_rewards(app: AppHandle, theme: String) -> rewards::RewardsView {
    rewards::view(&data_dir(&app), &theme, now_ms())
}
#[tauri::command]
async fn reward_unlock(app: AppHandle, theme: String, kind: String, id: String, via: String) -> Result<rewards::RewardsView, String> {
    rewards::unlock(&data_dir(&app), &theme, &kind, &id, &via, now_ms())
}
#[tauri::command]
async fn reward_place(app: AppHandle, theme: String, slot: String, id: String) -> Result<rewards::RewardsView, String> {
    rewards::place(&data_dir(&app), &theme, &slot, &id, now_ms())
}
#[tauri::command]
async fn reward_hang(app: AppHandle, theme: String, id: String) -> Result<rewards::RewardsView, String> {
    rewards::hang(&data_dir(&app), &theme, &id, now_ms())
}

/// 回主窗口（编排/跳过/结束都在那边）。桌宠右键菜单的「打开主窗口」走这条。
#[tauri::command]
async fn open_main(app: AppHandle) {
    #[cfg(desktop)]
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    #[cfg(mobile)]
    let _ = app; // 移动端只有一个 webview，"回主窗口"无意义
}

/// 桌宠右键菜单（系统原生弹出菜单）。
/// 为什么不是 HTML 菜单：桌宠窗只有 260×250，HTML 画的菜单会被窗口边界裁掉，
/// 而系统菜单不受窗口尺寸限制，Mac 上观感也是对的。
/// 菜单项 id 与托盘菜单同名 —— muda 的菜单事件是全局广播（tray 的 on_menu_event
/// 挂在 global_event_listeners 上），托盘那份处理器会照单收下，这里不用再挂一份。
/// 每次右键现搭一份：标签/可用性按当下状态算，永远不会显示成过期的「暂停」。
#[cfg(mobile)]
#[tauri::command]
async fn pet_menu(_app: AppHandle) {}

#[cfg(desktop)]
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
    arm_notifications(&app);
}

#[cfg(mobile)]
#[tauri::command]
async fn rest_focus(_app: AppHandle) -> bool { false }

/// 遮罩窗失焦时自己喊一声，Rust 立刻把焦点抢回来（比等下一秒滴答更快）
#[cfg(desktop)]
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
// 这两个只有托盘菜单和全局快捷键会调 —— 都是桌面独有的入口
#[cfg(desktop)]
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
#[cfg(desktop)]
fn skip_session(app: &AppHandle) {
    let _ = do_session_cmd(app, "skip");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init());

    // 开机自启 + 全局快捷键：桌面独有的两个插件（移动端连这两个 crate 都不会拉，见 Cargo.toml）
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());

    let builder = builder
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("拿不到应用数据目录");
            let loaded = App::load(dir);
            #[cfg(desktop)]
            let silent = std::env::args().any(|x| x == "--hidden") && loaded.settings.launch_mode == "silent";
            #[cfg(desktop)]
            let pet_hidden0 = loaded.settings.pet_hidden;
            app.manage(Mutex::new(loaded));

            // 以下整块是桌面形态的装配：静默自启、桌宠窗、托盘菜单、全局快捷键。
            // 移动端一样都没有 —— 它只有一个铺满屏幕的 webview。
            #[cfg(desktop)]
            {
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
            }

            // 滴答线程：窗口在不在都每秒推一次
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(std::time::Duration::from_secs(1));
                tick(&handle);
            });
            Ok(())
        });

    // 关窗只隐藏，计时不断（FE-26）；真正退出走托盘菜单。
    // 移动端没有"关窗口"这回事（生命周期归系统管），整个处理器不挂。
    #[cfg(desktop)]
    let builder = builder.on_window_event(|window, event| {
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
    });

    builder
        .invoke_handler(tauri::generate_handler![
            boot, get_state, session_start, session_cmd,
            save_settings, save_plans, save_schedules, get_history, rest_focus, set_activity,
            open_main, pet_menu, get_stats,
            get_rewards, reward_unlock, reward_place, reward_hang
        ])
        .run(tauri::generate_context!())
        .expect("番茄时钟启动失败")
}
