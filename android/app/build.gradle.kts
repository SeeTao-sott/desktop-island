plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.stanley.deskremote"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.stanley.deskremote"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    // 网页直接用电脑那边同一份（src-tauri/phone/index.html），改一处两边都更新
    sourceSets["main"].assets.srcDirs("../../src-tauri/phone")

    buildTypes {
        release {
            isMinifyEnabled = false
            // 自己用：直接用调试签名，装得上就行
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}
