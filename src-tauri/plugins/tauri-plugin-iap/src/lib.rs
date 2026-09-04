//! capyroom 内购桥（P4，2026-09-04）。
//!
//! 结构与 tauri-plugin-notification 同型：Rust 这边只负责把 Swift 类注册进 Tauri 的插件管理器，
//! 四条命令（products / purchase / restore / entitlements）全在 `ios/Sources/IapPlugin.swift` 里实现，
//! JS 直接 `invoke('plugin:iap|products', {ids})`。
//!
//! 🔴 凭证与落账不在这里：Swift 只回"苹果说你买了什么"，写 rewards.json 的永远是内核 `reward_purchase`（幂等）。
//! 桌面端：init 是空插件（Windows/macOS 没有 StoreKit 这条线，桌面版也不走账号/内购）。
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_iap);

/// 留住原生插件句柄（PluginHandle 本身没有 Drop，注册后就在 Swift 侧的 PluginManager 里；
/// 这里 manage 一份只是为了将来 Rust 侧要主动调它时有地方拿）。
#[cfg(target_os = "ios")]
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
            Ok(())
        })
        .build()
}
