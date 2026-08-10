plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val rokidSdkMode = providers.gradleProperty("rokidSdkMode").getOrElse("mock")

android {
    namespace = "com.bolloon.rokid.glass"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.bolloon.rokid.glass"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    buildFeatures { buildConfig = true }
    buildTypes.configureEach {
        buildConfigField("String", "ROKID_SDK_MODE", "\"$rokidSdkMode\"")
    }
}

dependencies {
    // 真实 Glass SDK 到位后在 vendor 模式下注入，不在仓库伪造依赖坐标。
    if (rokidSdkMode == "vendor") {
        // implementation(files("$rootDir/../../../rokid/vendor/rokid-glass-sdk.aar"))
    }
}
