// 🔴 tauri-plugin-social-auth 在 iOS/Android 上没有 Rust 命令（JS 直接 invoke 到原生插件），
//    Tauri 的 ACL 不认识它的命令 → 真机报 "command plugin:social-auth|apple_sign_in not allowed by ACL"（9-3 撞过）。
//    按插件 README：在 App 的 build.rs 里把它当 inlined plugin 声明命令，capabilities/mobile.json 的
//    "social-auth:default" 才有东西可放行。桌面端也走这段（无害：桌面不挂这个插件，也没有窗口引用它）。
fn main() {
    // 🔴 9-26 内测包标记：lib.rs 用 option_env!("CAPY_INTERNAL")。安卓 CI 直接 export 能生效；
    //    iOS 的 Rust 由 Xcode「Build Rust Code」阶段（tauri ios xcode-script）转手编译，
    //    workflow 的 env 传不到 → build 42~81 的 iOS 测试包其实都没带内测开关。
    //    改成：环境变量 **或** 标记文件 src-tauri/.capy_internal（iOS adhoc workflow 编译前 touch，
    //    .gitignore 挡住永不进仓，商店包不会有）→ 由这里统一注入给 rustc。
    println!("cargo:rerun-if-env-changed=CAPY_INTERNAL");
    println!("cargo:rerun-if-changed=.capy_internal");
    let flag = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".into())).join(".capy_internal");
    if std::env::var_os("CAPY_INTERNAL").is_some() || flag.exists() {
        println!("cargo:rustc-env=CAPY_INTERNAL=1");
    }
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
