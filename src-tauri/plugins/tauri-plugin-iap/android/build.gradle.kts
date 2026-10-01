// capyroom 内购桥 · 安卓半边（Google Play Billing Library 7）。
// 与 ios/ 同一套四条命令：products / purchase / restore / entitlements（见 IapPlugin.kt）。
// 🔴 这个模块由 tauri CLI 在 `tauri android init` 时通过 build.rs 的 android_path("android") 挂进 gen/android 工程，
//    :tauri-android 是 CLI 拷进 .tauri/tauri-api 的 Tauri 安卓 API（同 tauri-plugin-notification 的做法）。
// ⚠️ 本机（Windows）编不到，只有 CI（build-android / build-android-play）能验。
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tybbtech.capyroom.iap"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.9.0")
    implementation("androidx.appcompat:appcompat:1.6.0")
    // Play 结算库 8.x（10-01：Play 自 2026-08-31 起新包/更新最低 8，7 传不上去；下一道坎 = 2027-08-31 要 ≥9）。
    // 用不带 -ktx 的那份：我们只用回调接口，不用协程扩展，少一层 Kotlin 元数据版本的麻烦
    implementation("com.android.billingclient:billing:8.0.0")
    implementation(project(":tauri-android"))
}
