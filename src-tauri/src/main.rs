// 桌面入口。移动端走 lib.rs 的 mobile_entry_point（M3 打包 iOS/Android 时零改动）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tomato_lib::run()
}
