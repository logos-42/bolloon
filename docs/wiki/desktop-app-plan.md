---
title: 桌面版 App 规划 (Win/mac/Linux)
source: session
created: 2026-10-24
last_confirmed: 2026-10-24
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
type: plan
since: 2026-10-24
owner: leo
tags: [desktop, electron, packaging, release]
---

# 桌面版 App 规划 (Windows / macOS / Linux)

> 目标: 一份代码, 三平台各出一个**能双击安装、能自动更新、数据与 CLI 共享**的安装包; 不给用户「先装 Node 再跑 npm」的台阶。

## 1. 现状盘点 (2026-10-24 实测)

已具备 (不要重造):

| 能力 | 落点 | 状态 |
| --- | --- | --- |
| Electron 主进程 (窗口/托盘/菜单/日志/IPC/首次引导) | `src/electron/{main,window,tray,menu,ipc,dialogs,logger,first-run,config}.ts` | 有 |
| 内嵌服务托管 (spawn 子进程 + `ELECTRON_RUN_AS_NODE=1`) | `src/electron/server.ts` | 有 |
| 单实例锁 | `main.ts` `requestSingleInstanceLock` | 有 |
| 打包配置 (nsis x64 / dmg / AppImage) | `package.json` → `build` | 有 |
| 三平台图标 | `build/icon.{icns,ico,png}` · `tray.png` | 有 |
| asar 例外 (native/加密库) | `asarUnpack`: @diap / libp2p / @x402 … | 有 |
| 本地出 mac 包脚本 | `npm run app:bundle` → `release/mac-arm64/…app` | 有 |

缺口 (本规划的实活):

1. **没有签名**: mac 未公证 (Gatekeeper 拦), Windows 未签 (SmartScreen 红字), 用户装不上。
2. **没有自动更新**: 无 `electron-updater`, 升级要手动重装。
3. **只有 x64 Windows / 单构 mac**: 缺 arm64 Windows、缺 mac 双构 (Intel + Apple Silicon) 或 universal。
4. **只有 AppImage**: Linux 无 deb/rpm (企业装机走 apt/yum)。
5. **没有 CI 产物**: 打包靠本机, 三平台必须在各自 OS 上打 (Windows 签名需 Win 环境), 现状无法复现。
6. **窗口/托盘行为未做三平台验收**: 关窗语义 (mac 留托盘 / Win 退出)、开机自启、深链、菜单快捷键。
7. **数据目录**: 现设计**故意**统一 `~/.bolloon` (与 CLI 共享, 卸载不删数据) —— 保留; `BOLLOON_HOME` 作为便携/企业重定向后门 (env 层已收口, 见 `bolloonHome()`)。

## 2. 阶段

### P0 · 先让三平台都能出包 (1–2 天)

- 加 `electron-updater` 依赖 + `build.publish` (generic 或 GitHub Releases)。
- `build` 补: mac `target: [dmg, zip]` + `arch: [x64, arm64]`; win `arch: [x64, arm64]`; linux `[AppImage, deb]`。
- `build.mac.notarize: false` 暂时 + 文档写清「未签名构建 = 内部分发」。
- 验收: 三平台 `electron-builder` 各出一份产物, 能起、能连内嵌服务、能聊天 (冒烟脚本见 P2)。

### P1 · 签名与公证 (阻塞项, 需账号)

- **macOS**: Apple Developer ID Application 证书 + `notarytool` (app-specific password 或 API key)。`build.mac.hardenedRuntime: true`、`entitlements` (需要 JIT/网络/文件访问的声明)、`afterSign` 公证钩子。
- **Windows**: 代码签名证书 (EV 或 OV); `win.signingHashAlgorithms: ['sha256']`、`certificateSubjectName` 或 PFX + 密码走 CI secret。EV 证书可免 SmartScreen 冷启动警告。
- **Linux**: 不签名; 提供 `deb` 的 `maintainer` 与 `desktop` entry, AppImage 给 `chmod +x` 说明。
- 验收: mac 首启无「无法验证开发者」; Windows 无 SmartScreen 拦截; 三平台版本号一致 (`0.6.x` 由 `package.json` 单一真源驱动, 与 `build:ios-web` 同策略)。

### P2 · 体验一致性与自更新 (2–3 天)

- 自动更新: 启动检查 + 托盘「有新版本」+ 下载完提示重启; 失败降级为「手动下载」链接 (不静默)。
- 平台差异: 关窗 (mac 隐藏到托盘 / Win-Linux 退出可配)、开机自启、单实例聚焦已有窗口、深链 `bolloon://` (可选)。
- 崩溃与日志: 主进程日志已有 (`logsDir()`); 补渲染进程崩溃上报到本地文件, 面板可见。
- 验收门 `scripts/verify-desktop.ts` (新增, 三平台各跑一次):
  1. 冷启动 → 窗口出现 ≤ N 秒, 内嵌服务 `/api/friend-requests` 200;
  2. 发一条消息 → 收到回复 → 退出重开, 会话还在 (数据在 `~/.bolloon`);
  3. 托盘菜单 4 项可用, 关窗语义符合平台;
  4. 版本号 = `package.json`;
  5. 更新检查能在「无更新 / 有更新 / 检查失败」三态给不同反馈 (用本地 stub 源)。

### P3 · 分发与 CI (2 天)

- GitHub Actions matrix: `macos-14` (arm64+x64 交叉或两台)、`windows-2022`、`ubuntu-22.04`; 产物上传 Releases; 签名密钥走 secrets。
- 发布节奏: 与 npm 发版同一条版本号; tag `vX.Y.Z` 触发桌面产物 + npm publish。
- 回滚: 保留上两个版本产物; 自动更新源支持「按平台 + 按架构」分派, 避免 arm64 用户拿到 x64 包。

## 3. 关键取舍 (已定, 写死避免反复)

1. **数据目录仍是 `~/.bolloon`** (`src/electron/paths.ts` 顶部注释即决策): 桌面与 CLI 双开同数据, 卸载不删。`BOLLOON_HOME` 只作便携/企业重定向。
2. **内嵌服务由 Electron 托管**, 不另装守护进程; 端口用现有 54188 + 递增兜底, 并通过 `BOLLOON_PORT` 契约回传渲染端。
3. **不引入第二套 UI 技术栈**: 复用现有 web 前端 (`src/web/client.ts` → `dist/web`), 桌面只是宿主。
4. **P2P 能力不因桌面而特化**: 桌面与 CLI 走同一条协议栈; 若需「只允许桌面跑常驻」, 用现有 `managedServices` 端口判断, 不在 Electron 里写业务分支 (遵守架构分层 §8)。

## 4. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 签名成本/周期 | Apple/Windows 证书审批, 首次公证常失败 (entitlements) | P1 提前启动, 先用 unsigned 内测 |
| 原生依赖打包 | `@diap/sdk`/libp2p 已 asarUnpack, 新依赖可能漏 | CI 上跑 `electron-builder` 后启动冒烟, 不只 build 成功 |
| 体积 | 1775 文件 + 原生库, 安装包可能 >150MB | asar + 只打必要 `dist`, 评估 `files` 白名单收紧 |
| 双开端口冲突 | 桌面 + CLI 同机 | 已有 `BOLLOON_PORT` 契约 + 递增; P2 加「端口占用提示」 |
| 自动更新失败静默 | 用户以为已升级 | 三态反馈 + 落盘日志 (P2 验收门第 5 条) |

## 5. 与现有工作的衔接

- `bolloonHome()` / `BOLLOON_HOME` 收口 (2026-10-24 已落地 20 个 store) 是 P0 的前置: 桌面若需按 OS 规范目录, 只改注入点不动业务代码。
- 发版链路已通 (npm 0.6.8 + tag `v0.6.8`); 桌面产物挂到同一 tag。
- iOS/Android 已有 Capacitor 链路 (`build:ios-web` / `cap sync`), 与本规划互不干扰; 三端版本号同源 `package.json`。
