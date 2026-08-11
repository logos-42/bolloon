# Bolloon Rokid Android 手机端

这是 Bolloon 的 Android 手机伴侣工程：Capacitor Android 承载 Bolloon Web UI（独立 APP），
通过 `RokidBridge` 暴露手机—眼镜消息桥，并已接入官方 **CXR-M SDK** (`com.rokid.cxr:client-m`)。

## 构建 (assembleDebug 出 APK)

前置：
- Android SDK：`C:\tools\android-sdk`（`ANDROID_HOME` 已设；platforms 含 android-35/36，build-tools 35.0.0）
- JDK：**21**（capacitor-android 8.4.1 编译要求 Java 21；本机用 Android Studio JBR）
  `C:\Program Files\Android\Android Studio\jbr`
- gradle wrapper 已生成（`gradlew` / `gradlew.bat`，Gradle 8.14.3 与 AGP 8.13.0 配对）

```bash
export JAVA_HOME='C:\Program Files\Android\Android Studio\jbr'
export PATH="$JAVA_HOME/bin:$PATH"
cd android
./gradlew :app:assembleDebug
# 产物: app/build/outputs/apk/debug/app-debug.apk (~16MB)
```

## 依赖加载

- **CXR-M SDK**：`implementation 'com.rokid.cxr:client-m:1.2.2'`（`maven.rokid.com/repository/maven-public/`，
  已在 settings.gradle 声明仓库；1.2.2 是 maven-metadata 的 latest）。AAR 本地副本：
  `android/vendor/client-m-1.2.2.aar`（gitignored，manifest 已登记）。
- **官方 AAR 缺陷补丁**：libcxr-bridge-jni.so 的 JNI_OnLoad 引用 `com.rokid.cxr.ReplyImpl`，
  但官方 classes.jar 所有版本都缺该类（R8 发布事故）→ 不补则 ART 直接 SIGABRT。
  已在本工程 `app/src/main/java/com/rokid/cxr/ReplyImpl.java` 补齐（实现 `CXRServiceBridge.Reply` +
  `nativeEnd(JLcom/rokid/cxr/Caps;)V` + `nativeReleaseData(J)V`，签名由崩溃消息迭代确定）。
  官方修复 AAR 后删除该文件即可。
- **capacitor-android**：官方无 maven 坐标（mavenCentral / google maven 均 404），必须走 npm 模块：
  `project(':capacitor-android')` → `../node_modules/@capacitor/android/capacitor`
  （相对 `android/` 一级 `..` 即到仓库根 node_modules）。
- **Web assets**：`app/src/main/assets/public/` = `dist/web/` 的拷贝（独立 APP 渲染的就是它）。
  更新 Web UI 后重新拷贝 + 重建：
  ```bash
  cp -r dist/web/. android/app/src/main/assets/public/
  ```
- **compileSdk 36**：capacitor 8.4.1 的 androidx 1.17 AAR metadata 强制 compileSdk >= 36；
  `targetSdk` 保持 **35**（platform-35 适配，设备行为 = Android 15）。

## 模拟器渲染

```bash
# 镜像 (android-36.1 google_apis_playstore x86_64, 与 AVD Medium_Phone_API_36.1 匹配):
sdkmanager --sdk_root=C:\tools\android-sdk "system-images;android-36.1;google_apis_playstore;x86_64"
# 启动 AVD (WHPX 加速):
/c/tools/android-sdk/emulator/emulator.exe -avd Medium_Phone_API_36.1 -no-snapshot &
adb wait-for-device
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.bolloon.agent.rokid/.MainActivity
adb exec-out screencap -p > screen.png
```

`ROKID_SDK_MODE` BuildConfig：默认 `mock`（`RokidBridgePlugin` 走 MockRokidAdapter，
不 load CXR JNI，x86_64 模拟器可跑）；`-ProkidSdkMode=vendor` 时编译期启用 vendor 分支
（真机接入 CXR 需要 arm64 设备 + 蓝牙授权）。

## 真实设备接入 (TODO)

拿到 Rokid 授权材料 / 真机联调后：实现 `RokidBridgePlugin` 的 Vendor Adapter
（`CXRServiceBridge.connect` + `CXRSocketProtocol`），Web 端桥接接口不变。
