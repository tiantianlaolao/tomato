// 🔴 tauri-plugin-social-auth 在 iOS/Android 上没有 Rust 命令（JS 直接 invoke 到原生插件），
//    Tauri 的 ACL 不认识它的命令 → 真机报 "command plugin:social-auth|apple_sign_in not allowed by ACL"（9-3 撞过）。
//    按插件 README：在 App 的 build.rs 里把它当 inlined plugin 声明命令，capabilities/mobile.json 的
//    "social-auth:default" 才有东西可放行。桌面端也走这段（无害：桌面不挂这个插件，也没有窗口引用它）。
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().plugin(
            "social-auth",
            tauri_build::InlinedPlugin::new()
                .commands(&["apple_sign_in", "google_sign_in", "vk_sign_in", "yandex_sign_in"])
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
