# Bolloon Rokid Android 手机端

这是 Bolloon 的 Android 手机伴侣工程，使用 Capacitor Android 承载 Bolloon Web UI，并通过 `RokidBridge` 暴露手机—眼镜消息桥。

## 默认 Mock 构建

```bash
gradle :app:assembleDebug
```

默认 `rokidSdkMode=mock`，不需要 Rokid 私有 SDK。当前环境若没有 Android SDK/Gradle，请在 Android Studio 打开本目录后构建。

## 接入官方 SDK

官方材料放在外部目录，不要提交 Git：

```bash
export ROKID_SDK_DIR=/Users/apple/Downloads/rokid/vendor
./gradlew :app:assembleDebug -ProkidSdkMode=vendor
```

拿到真实 SDK 后，只实现 `RokidBridgePlugin` 内的 Vendor Adapter，不改变 Web 端桥接接口。
