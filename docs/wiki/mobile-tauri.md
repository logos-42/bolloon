---
title: 手机端 (Tauri v2) 架构与构建
source: session 2026-11-16
created: 2026-11-16
last_confirmed: 2026-11-16
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [mobile, tauri, android, ios, embedded-axum, app=mobile]
---

# 手机端 (Tauri v2) 架构与构建

## 结论先行

手机端与桌面**共用同一份 Rust 后端与 UI**，不是 Capacitor 的独立前端：

```
Tauri 壳
  └─ 启动内嵌 axum (bolloon-web::serve_on, 127.0.0.1:随机端口)
       └─ WebView 导航到 http://127.0.0.1:<port>/?app=mobile
            └─ assets/index.html + body.mobile 响应式（底部四 tab）
```

- 入口：`rust/app-tauri/src-tauri/src/lib.rs` 的 `#[cfg(mobile)]` 分支。
- UI：`rust/crates/bolloon-web/assets/index.html` 的 `initMobile()`（`?app=mobile` 才启用）。
- 后端：`/api/*` 与桌面同源，无鉴权（仅回环 + `full_access_guard` 总闸）。

## 与 Capacitor 的关系

仓库根的 `android/`、`ios/` 是 **历史 Capacitor 工程**（`webDir: dist/web` / `dist/ios`），与 Tauri 手机端不是同一条链：

- `src/web/mobile.html` + `mobile.js` 是 Capacitor 旧前端，**不再被 Tauri 使用**。
- `scripts/build-web.ts` 仍会产出 `dist/web/mobile.*`，仅为兼容旧工程；Tauri 不需要 `cap sync`。
- 是否删除 Capacitor 目录，等 Tauri 移动端出包验证后再决定（当前保留，避免误删历史产物）。

## 移动端功能入口

桌面靠顶栏/侧栏进入钱包/插件/模型；手机端没有这些栏，已在「设置」弹窗内补「功能」组：

- 钱包与代币 → `openWallet()`
- 插件 → `openPlugins()`
- 模型 → `openModelPool()`
- 支付/额度 → `openPayDialog()`

所有 `<dialog>` 在 `body.mobile` 下改为全屏 + 安全区 padding（`index.html` 内联 CSS）。

## 构建

```bash
bash scripts/build-mobile.sh --check      # 环境自检
bash scripts/build-mobile.sh android      # APK/AAB
bash scripts/build-mobile.sh ios          # iOS（需完整 Xcode）
```

首次会自动 `cargo tauri android init` / `ios init`，生成 `gen/`（**未入库**）。

### 前提

| 平台 | 需要 |
|---|---|
| Android | `ANDROID_HOME` + SDK + NDK 26+；`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| iOS | macOS + **完整 Xcode**（不是 Command Line Tools）+ CocoaPods |

### 本机现状（2026-11-16）

- 无 `ANDROID_HOME`、无 android rust target → **Android 未构建**。
- `xcodebuild` 指向 Command Line Tools，无 Xcode → **iOS 未构建**。
- 因此本轮只交付代码与配置，构建验证留给具备 SDK/Xcode 的机器或 CI。

## 权限

- `capabilities/default.json`：仅桌面平台（含 updater）。
- `capabilities/mobile.json`：`platforms: ["android","iOS"]`，只给 `core:default` + `bolloon-default`，不含 updater。
- `remote.urls` 必须包含 `http://127.0.0.1:*`，否则 WebView 的 IPC 会被 ACL 拒绝。

## 体积

Tauri 复用 Rust 静态库，无 Capacitor WebView 壳的额外 ~5MB；Android `.so` 与桌面共用 `profile.release`（strip + LTO，见 `Cargo.toml`）。实际 APK 体积需在具备 NDK 的机器上实测，**本文不编造数字**。

## 未验证 / 风险

1. Android/iOS 均未真实构建。
2. `tauri-plugin-updater` 目前是无条件依赖与注册；移动端是否编译通过未验证（首次构建若失败，需按平台 cfg 门控）。
3. `gen/` 未生成，`tauri.conf.json` 的 `app.windows` 为空，移动端主窗口由 Tauri 创建，需首次 `init` 后确认。
