# Bolloon 桌面端自动更新 (Tauri v2 + tauri-plugin-updater)

## 架构

- **壳只做机制**：`rust/app-tauri/` 用官方 `tauri-plugin-updater` 完成「版本检查 / 下载 / **签名验证** / 安装 / 重启」。
  前端通过 IPC 调用两个薄命令：`check_update`、`update_install`，外加 `relaunch`。壳**不写任何业务判断**。
- **UI 与执行分离**：状态机与界面在网页前端（`rust/crates/bolloon-web/assets/index.html`，以及 `src/web/client.ts`），
  真正的下载/验签/安装/重启在 Rust 侧。进度与状态通过 Tauri 事件 `update-progress` / `update-state` 实时推给前端。

状态机：`idle → checking → up-to-date | update-available → downloading → verifying → installing → restart-required | failed`
（失败可重试；启动静默检查只查不装，绝不未经授权自动安装）。

## 配置文件

- `rust/app-tauri/src-tauri/tauri.conf.json`
  - `app.withGlobalTauri: true` —— 让前端用 `window.__TAURI__.core.invoke` 检测 Tauri 环境并走原生更新。
  - `plugins.updater.endpoints` —— 版本清单地址（当前为 `https://releases.bolloon.app/update/latest.json`）。
  - `plugins.updater.pubkey` —— **ed25519/minisign 公钥**（见下方密钥）。
  - `bundle.createUpdaterArtifacts: true` —— `cargo tauri build` 时自动产出 `.app.tar.gz` / `.nsis` / `.AppImage` 及对应 `.sig`。
- `rust/app-tauri/src-tauri/capabilities/default.json` —— 授予 `core:default`（事件监听，用于收进度）+ `updater:default`。

## 密钥与签名

> **私钥绝对不能入库。** 仓库 `.gitignore` 已忽略 `.tauri/`。公钥在 `tauri.conf.json`（可公开）。

当前 `tauri.conf.json` 里的 `pubkey` 是本地脚手架密钥，仅供联调。**发布前请重新生成自己的密钥对**：

```bash
cd rust/app-tauri/src-tauri
cargo tauri signer generate          # 交互设置密码; 输出 Private(私钥) 与 Public(公钥)
```

- 私钥写入 `.tauri/updater.key`（已 gitignore）。
- 公钥：取 `Public:` 输出解码后的**第二行裸 key**（形如 `RWQxxxx...`），填进 `tauri.conf.json` 的 `pubkey`。

### 发布时环境变量

```bash
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<生成时设的密码>"
# 可选: 直接给私钥内容 / 路径 (默认读 .tauri/updater.key)
# export TAURI_SIGNING_PRIVATE_KEY="<base64 私钥>"
# export TAURI_SIGNING_PRIVATE_KEY_PATH="rust/app-tauri/src-tauri/.tauri/updater.key"
```

## 构建 + 签名 + 发布

```bash
# 1) 构建并自动签名更新包 (产出 .sig)
cd rust/app-tauri/src-tauri
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=xxx cargo tauri build

# 2) 生成版本清单 latest.json (扫描 bundle 目录里的 .sig 与产物)
cd ../../..
npx tsx scripts/gen-update-manifest.ts \
  --version 0.6.15 --notes "本次更新说明" \
  --base-url https://releases.bolloon.app/update

# 3) 把 latest.json 与各平台产物本体 (app.tar.gz / nsis / AppImage) 一起托管到
#    https://releases.bolloon.app/update/  (与 tauri.conf.json 的 endpoints 对齐)
```

清单格式（Tauri v2 updater 要求）：

```json
{
  "version": "0.6.15",
  "notes": "本次更新说明",
  "pub_date": "2026-10-29T12:00:00Z",
  "platforms": {
    "darwin-aarch64": { "signature": "<.sig 内容>", "url": "https://releases.bolloon.app/update/.../Bolloon_aarch64.app.tar.gz" },
    "windows-x86_64": { "signature": "...", "url": "..." },
    "linux-x86_64":   { "signature": "...", "url": "..." }
  }
}
```

## 平台差异

- **macOS**：更新替换 `.app` 包内可执行文件；安装后需**重启**应用（前端 `restart-required` → `relaunch` 调 `app.restart()`）。
- **Windows**：NSIS 更新包；安装函数会启动安装器并**退出当前进程**，由安装器负责拉起新版本。
- **Linux**：AppImage；同 macOS，安装后重启生效。
- 数据目录在 `~/.bolloon`，与 app 包分离，更新/重启**不丢数据**。

## 安全约束（已落实，勿破坏）

- 签名验证由 `tauri-plugin-updater` 在下载后自动执行，**验不过绝不安装**（错误会带 `signature_failed` 标记）。
- 严禁设置 `dangerousInsecureTransportProtocol` / `dangerous_accept_invalid_certs` —— endpoints 必须是 HTTPS。
- 30s 网络超时（`make_updater` 里配置），失败可重试。
- 安装流互斥（`UPDATING` 原子标志），重复点击/并发 invoke 被拒绝。

## 已验证 vs 待真实环境验证

**本地已验证（可在本机跑）**
- `cargo check` 通过（Rust 后端 + 插件编译）。
- 配置结构、capabilities、公钥格式、前端状态机逻辑、并发/无更新/检查失败等纯逻辑分支。

**需真实签名证书 / 发布环境 / 安装包才能验证（本机无法跑）**
- 真实 `cargo tauri build` 产出带 `.sig` 的更新包并成功签名。
- 在 macOS / Windows / Linux 上实际下载 → 验签 → 安装 → 重启并跑起新版本。
- 故意篡改包 / 错配公钥 → 验签失败被拒（已在代码中走到 `failed(signature_failed)`）。
- Windows NSIS 退出与重启行为、macOS `.app` 替换后重启。

## 边界情况覆盖

- 无更新：`check` 返回 `None` → 前端显示「已是最新」。
- 检查/下载网络失败：错误显式回传 `failed` + reason，提供重试入口。
- 签名不匹配 / 损坏包：插件验签失败 → `failed(signature_failed:true)`，拒绝安装。
- 不兼容版本 / target 缺失：manifest 无当前平台条目 → `check` 报错 → `failed`。
- 版本比较：插件默认只安装「远程版本 > 当前版本」，不会降级。
- 重复点击 / 并发：Rust `UPDATING` 互斥 + 前端状态机防重入。
