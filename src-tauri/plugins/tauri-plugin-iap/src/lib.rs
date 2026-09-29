//! capyroom 内购桥（P4，2026-09-04）。
//!
//! 结构与 tauri-plugin-notification 同型：Rust 这边只负责把原生类注册进 Tauri 的插件管理器，
//! 四条命令（products / purchase / restore / entitlements）全在原生侧实现：
//!   iOS     `ios/Sources/IapPlugin.swift`（StoreKit 2）
//!   Android `android/src/main/java/com/tybbtech/capyroom/iap/IapPlugin.kt`（Google Play Billing 7，9-29）
//! JS 直接 `invoke('plugin:iap|products', {ids})`，两端同名同形。
//!
//! 🔴 凭证与落账不在这里：原生只回"商店说你买了什么"，写 rewards.json 的永远是内核 `reward_purchase`（幂等）。
//! 桌面端：init 是空插件（Windows/macOS 没有商店这条线，桌面版也不走账号/内购）。
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_iap);

/// 留住原生插件句柄（PluginHandle 本身没有 Drop，注册后就在原生侧的 PluginManager 里；
/// 这里 manage 一份只是为了将来 Rust 侧要主动调它时有地方拿）。
#[cfg(mobile)]
pub struct Iap<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("iap")
        .setup(|_app, _api| {
            #[cfg(target_os = "ios")]
            {
                use tauri::Manager;
                let handle = _api.register_ios_plugin(init_plugin_iap)?;
                _app.manage(Iap(handle));
            }
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                // 包名 + 类名与 IapPlugin.kt 一字不差；找不到类会在启动时 panic，CI 的旁装包一开就知道
                let handle = _api.register_android_plugin("com.tybbtech.capyroom.iap", "IapPlugin")?;
                _app.manage(Iap(handle));
            }
            Ok(())
        })
        .build()
}
