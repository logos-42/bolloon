# Bolloon Tauri App (桌面外壳)

Electron 外壳的 Tauri 替代 (Rust 原生, 产物体积 ~10MB vs Electron ~800MB)。

## 结构

- `src-tauri/src/main.rs` — Tauri 入口: 托管 `bolloon-web` axum 服务 (127.0.0.1 随机端口) + 主窗口加载它
- `src-tauri/tauri.conf.json` — 窗口/打包配置 (复用 bolloon 品牌色)
- 前端 = `bolloon-web` 的单页 (hushforge 布局), 无需单独构建

## 构建

```bash
# 首次 (需要 Rust 1.99 + 系统 WebView: macOS 自带 WKWebView)
cd rust/app-tauri/src-tauri
cargo tauri build        # 产物: dmg / app
cargo tauri dev          # 开发模式
```

## 纪律 (对齐 desktop-app-plan.md)

- 数据目录仍走 `~/.bolloon/rust/` (与 CLI/Web 共享, BOLLOON_HOME 后门保留)
- 内嵌服务是唯一业务入口, **桌面壳不写业务分支** (托盘/窗口/单实例是壳的全部职责)
- 单实例锁 / 关窗行为 / 深链: P2 阶段接 `tauri-plugin-single-instance` 等
