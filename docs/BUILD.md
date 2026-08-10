# Bolloon Agent — Build & Distribution

打包桌面 (mac/win/linux) 和 iOS 的方式, 已知坑位, CI 流程.

---

## Desktop (Electron)

### 本地开发

```bash
npm install
npm run build:all          # server + web + electron + cli
npm run electron:dev       # dev:web (tsx server) + electron:start (BrowserWindow)
```

dev 模式连真 server, `src/web/` 改了直接刷新, `src/electron/` 改了要重启.

### 本地打包 (手搓, 绕过 electron-builder walker OOM)

```bash
npm install                 # 装 electron, postinstall 会下载 Electron binary 到 node_modules/electron/dist/
node node_modules/electron/install.js   # 如果上面没自动跑
npm run build:all
npm run app:bundle          # 产物: release/mac-arm64/Bolloon Agent.app (~2.6G)
open "release/mac-arm64/Bolloon Agent.app"
```

**为什么不用 `electron-builder`?** `app-builder-lib@26.x` 在 1.1G `@rayhanadev/iroh` + 大 node_modules 下 OOM (12GB heap 也炸). 见 memory/electron-pack-oom-2026-06-24.md.

**为什么 .app 启动后 macOS 弹 Gatekeeper?** 未签名的 app 第一次打开会被 Gatekeeper 拦. 两种处理:
- `codesign --force --deep --sign - "Bolloon Agent.app"` (ad-hoc 签名, 本地可跑)
- 正式签名 + notarize: 需要 Apple Developer ID ($99/yr), 走 CI `desktop-mac` job 自动签名 (没配 secrets 时跳过)

### 打包到 Windows / Linux

本机 macOS 13.7.8 没装交叉编译工具链. 这两个平台的产物只能走 CI:
- `desktop-win` job (windows-latest runner) → `release/*.exe` (NSIS installer)
- `desktop-linux` job (ubuntu-latest runner) → `release/*.AppImage`

CI 上 electron-builder walker 可能在干净 runner 上不 OOM, 所以 CI 用 `npx electron-builder --win --x64` / `--linux --x64`, 不用手搓脚本.

---

## iOS (Capacitor)

### 本地开发 (需要 macOS 14+ with Xcode 15+)

```bash
npm install
npm run build:web          # Capacitor 需要 dist/web/ 存在
npx cap sync ios           # 把 dist/web/ 拷到 ios/App/App/public/
npx cap open ios           # 用 Xcode 打开 ios/App/App.xcodeproj
```

Xcode 里:
1. 选 device 或 simulator
2. Cmd+R 跑起来
3. 看 WKWebView 加载 `ios/App/App/public/index.html`

### iOS 后端限制 (跟 Electron 不同)

| 限制 | 影响 |
|---|---|
| iOS 后台 30s 后 suspended | P2P 连接会断, 跨机 @-mention 在锁屏后会断 |
| localStorage 5MB 上限 | 单频道数据大时会爆, 后面迁到 Capacitor Preferences API |
| 不支持任意端口 listen | WebRTC / WebSocket 受限 |
| iOS 17+ 默认禁 HTTP 明文 | Info.plist 已加 `NSAppTransportSecurity.NSAllowsLocalNetworking` + `localhost` 例外 |

### 真机 / TestFlight / App Store

需要 Apple Developer Program ($99/yr). 步骤:
1. 在 https://developer.apple.com 注册, 创建 App ID `com.bolloon.agent`
2. 创建 iOS Development / Distribution 证书
3. 创建 Provisioning Profile (Development + App Store)
4. Xcode → Signing & Capabilities → 选 Team
5. Archive → Distribute App → App Store Connect / Ad Hoc / Development

CI 跑 `ios-build` job 需要在 repo settings 加 secrets:
- `APPLE_CERT_P12_BASE64` (base64 编码的 .p12 证书)
- `APPLE_CERT_PASSWORD`
- `APPLE_PROVISIONING_PROFILE_BASE64`

不配 secrets → CI 出 unsigned .xcarchive, dev 本地自己 archive.

## Rokid Android 手机端

Rokid 手机伴侣工程位于 `rokid/android/`，默认使用 Mock 适配器，不需要 Rokid 私有 SDK：

```bash
cd rokid/android
gradle :app:assembleDebug
```

如果本机没有 Android SDK 或 Gradle，请用 Android Studio 打开 `rokid/android/`。拿到官方 SDK 后，保持私有材料在 `/Users/apple/Downloads/rokid/vendor/`，通过 `ROKID_SDK_DIR` 和 `-ProkidSdkMode=vendor` 注入，禁止将 AAR/JAR、授权文件或密钥提交到仓库。

## Rokid Glass 眼镜端

眼镜端是独立的 Android 工程，位于 `rokid/glass/`：

```bash
cd rokid/glass
gradle :app:assembleDebug
```

默认页面使用 `MockRokidGlassesAdapter`，用于验证大字号消息、连接状态和语音结果；官方 SDK 到位后只替换 Vendor Adapter。

---

## CI / Release

`.github/workflows/release.yml`:

```
git tag v0.2.1
git push origin v0.2.1
```

触发 4 个并行 job + 1 个 release job:
| Job | Runner | 产物 |
|---|---|---|
| `desktop-mac` | macos-latest | `Bolloon Agent-*.dmg` 或 `*-mac.tar.gz` |
| `desktop-win` | windows-latest | `Bolloon Agent Setup-*.exe` |
| `desktop-linux` | ubuntu-latest | `Bolloon Agent-*.AppImage` |
| `ios-build` | macos-latest | `BolloonAgent.xcarchive` + `*.ipa` (有 secrets 时) |
| `release` | ubuntu-latest | 创建 GitHub Release + 附件所有 artifact |

`workflow_dispatch` 也能手动触发 (不带 tag 时只 build 不 release).

---

## 关键文件

- `scripts/build-app-bundle.cjs` — 手搓 macOS .app, 避开 electron-builder walker
- `capacitor.config.ts` — Capacitor 配置 (appId, appName, webDir)
- `ios/App/App/Info.plist` — iOS 配置 (ATS, UIBackgroundModes, permissions)
- `ios/App/App.xcodeproj/` — Capacitor 生成的 Xcode 项目
- `.github/workflows/release.yml` — 4 平台 + release 发布
- `src/electron/` — Electron 主进程 (main, window, server, menu, tray, dialogs, ipc, logger, paths, config)
- `src/electron-preload.ts` — contextBridge 暴露给渲染进程的 API
- `electron-builder` 配置在 `package.json` 的 `build` 字段 (备选, 当前 mac 用手搓)

---

## 已知未实现

- [ ] **electron-updater** — 当前 CLI 用 `src/utils/auto-update.ts` (npm global) 更新; desktop/iOS 走 App Store / Mac App Store 自动更新, 暂无独立 OTA
- [x] **Android / Rokid Mock** — `rokid/android/` 手机端 + `rokid/glass/` 眼镜端工程已建立；真实 Rokid SDK 等待官方材料
- [ ] **macOS 公证 (Notarization)** — 没配 Apple ID 账号, CI 出来的 .dmg 没 notarize, 用户首次开要手动允许
- [ ] **Code signing certificate** — 没放, 配 secrets 后走 CI 自动签名
- [ ] **Auto-publish to GitHub Releases** — release job 已经做了, 但 publish config (`package.json` build.publish) 还是 placeholder `REPLACE_WITH_OWNER/REPO`
