---
title: 手机端 (Tauri v2) 独立 UI 架构与构建
source: session 2026-11-16
created: 2026-11-16
last_confirmed: 2026-11-16
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [mobile, tauri, android, ios, embedded-axum, mobile-ui, app=mobile]
---

# 手机端 (Tauri v2) 独立 UI 架构与构建

## 结论先行

手机端与桌面**共用 Rust 后端，但 UI 完全分开**：

```
Tauri 壳
  └─ 启动内嵌 axum (bolloon-web::serve_on, 127.0.0.1:随机端口)
       └─ WebView 导航到 http://127.0.0.1:<port>/?app=mobile
            └─ server.rs index() 按 query 返回 assets/mobile.html（独立移动 UI）
```

- 分流点：`rust/crates/bolloon-web/src/server.rs` 的 `index(Query<IndexQuery>)`。
  `?app=mobile` → `MOBILE_HTML`；否则 → 桌面 `INDEX_HTML`。
- 移动页面：`rust/crates/bolloon-web/assets/mobile.html`（自包含 CSS/JS，无外部依赖）。
- 桌面页面：`assets/index.html`，**不再承载移动布局**（旧 `body.mobile` 代码保留但不会被 `?app=mobile` 命中）。

## 移动 UI 设计（与桌面不同）

移动端按「单手、碎片时间、低频深度操作」重排：

| 区域 | 设计 |
|---|---|
| 底部导航 | 对话 / 联系人 / 世界 / 我（4 个，固定 + 安全区） |
| 对话 | 顶部智能体横向切换 → 最近会话 → 快捷功能四宫格；进入后是沉浸式聊天页 + 固定输入条 |
| 联系人 | 搜索 + 列表 + 待处理请求，主操作是「加人/发消息」 |
| 世界 | 机会流卡片，只展示真实流入，空态明确 |
| 我 | 资料卡 + 统计 + 功能列表（钱包/插件/模型/额度/授权）+ 外观切换 |
| 子页 | 钱包/插件/模型/额度/授权以全屏右滑子页呈现，表单为大触控控件 |

与桌面的差异：无侧栏、无多栏、无密集表格；弹窗改为页面；操作路径不超过 2 层。

## 功能与后端接口（真实路由）

- 对话：`GET /api/bootstrap`、`POST /api/chat {message,session_id,agent_id}`、`POST /api/sessions`、`POST /api/active`
- 联系人：`GET /api/contacts`（`items/requests_in`）、`POST /api/contacts/set`
- 世界：`GET /api/world/feed`
- 钱包/代币：`/api/wallet/{status,setup,unlock,lock,backup,restore}`、`/api/tokens`、`/api/tokens/import`、`/api/tokens/prepare|confirm`
- 插件：`/api/plugins`、`/api/plugins/{create,import,share,remove}`（`run_plugin` 是 Agent 工具，无 HTTP 直跑）
- 模型：`/api/models`、`/api/models/select`、`/api/models/test`
- 额度：`/api/pay/summary`、`/api/pay/info`、`/api/pay/claim`
- 授权：`/api/grants`、`/api/grants/revoke`
- 资料：`POST /api/profile`

无鉴权；仅回环 + `full_access_guard` 总闸（`/api/grants*` 受总闸管）。

## 旧 Capacitor 工程

仓库根 `android/`、`ios/` 是历史 Capacitor 工程；`src/web/mobile.html` + `mobile.js` 是旧前端，**当前 Tauri 手机端不使用**。是否删除待 Tauri 移动端出包验证后决定。

## 构建

```bash
bash scripts/build-mobile.sh --check      # 环境自检
bash scripts/build-mobile.sh android      # APK/AAB
bash scripts/build-mobile.sh ios          # iOS（需完整 Xcode）
```

首次会自动 `cargo tauri android init` / `ios init`，生成 `gen/`（**未入库**）。

| 平台 | 需要 |
|---|---|
| Android | `ANDROID_HOME` + SDK + NDK 26+；`rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android` |
| iOS | macOS + **完整 Xcode** + CocoaPods |

## 本机验证（2026-11-16）

- `cargo check -p bolloon-web`：通过（45s）。
- 本地起 `bolloon web --port 54914`：
  - `GET /?app=mobile` → 42,968 B，含 4 个 nav tab；
  - `GET /` → 353,267 B，桌面 UI 不含移动 tab；
  - `GET /api/bootstrap` → 200。
- Playwright（系统 Chrome，390×844）：
  - 4 个 nav、1 个智能体；
  - 点「我」→「钱包与代币」子页打开，标题正确，状态渲染（`未创建` / `base-sepolia`）；
  - **0 个 pageerror**。

## 未验证 / 风险

1. Android/iOS 均未真实构建（本机无 SDK/NDK/Xcode）。
2. `tauri-plugin-updater` 仍是无条件依赖与注册；移动端编译是否通过未验证。
3. 移动 UI 的真机安全区、键盘顶起、手势返回需真机回归。
4. 世界卡片/联系人请求字段按后端现有结构做了兼容读取，极端数据形态未覆盖。
