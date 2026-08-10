# Bolloon Rokid Glass 眼镜端

这是独立的眼镜端 Android 工程，默认使用 `MockRokidGlassesAdapter`，提供适合眼镜屏幕的大字号、焦点导航、消息显示、语音结果和连接状态示例。

```bash
gradle :app:assembleDebug
```

真实 Rokid SDK 到位后，把 `MockRokidGlassesAdapter` 替换为实现 `RokidGlassesAdapter` 的 Vendor Adapter；不要改变 `GlassMessage`、`GlassDeviceState` 和上层 UI 契约。
