# Tauri 安卓插件靠反射找 @TauriPlugin 类和 @Command 方法，R8 不许改名
-keep class com.tybbtech.capyroom.iap.** { *; }
-keep class com.android.vending.billing.**
