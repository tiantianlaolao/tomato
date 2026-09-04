// swift-tools-version:5.5
// capyroom 内购桥（StoreKit 2）。
// 🔴 平台下限写 iOS 13 不是 15：swift-rs 用 IPHONEOS_DEPLOYMENT_TARGET（默认 13.0）编这个包，
//    包声明得比它高就编不过；StoreKit 2 的 15+ 要求靠源码里的 @available 守。
// 🔴 name / library / target 三个名字必须都等于 crate 名（swift-rs 按这个名字找 .a）。
import PackageDescription

let package = Package(
  name: "tauri-plugin-iap",
  platforms: [
    .macOS(.v10_13),
    .iOS(.v13),
  ],
  products: [
    .library(
      name: "tauri-plugin-iap",
      type: .static,
      targets: ["tauri-plugin-iap"])
  ],
  dependencies: [
    // 构建时由 tauri-plugin 的 build 脚本把 tauri 的 iOS API 拷到 ../.tauri/tauri-api（.gitignore 掉）
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(
      name: "tauri-plugin-iap",
      dependencies: [
        .byName(name: "Tauri")
      ],
      path: "Sources")
  ]
)
