# 权限说明与隐私合规（应用市场上架用）

> 用途：填华为/小米/OPPO/vivo 等应用市场的「权限说明文档」「隐私政策链接」「APP 备案」表单时直接抄本页。
> 事实来源：`android/app/src/main/AndroidManifest.xml`、`src/web/mobile-privacy.ts`、`package.json` 依赖清单（2026-09-16 逐项核对）。
> 政策落地页（商店表单要填的公开链接）：https://bolloon.cn/privacy.html
> 应用内双入口：首启同意门（`#privacy-gate`）+ 设置 → 隐私政策与个人信息（`#settings-privacy`）

## 一、应用基本信息

| 项 | 值 |
|---|---|
| 应用名称 | Bolloon |
| Android 包名 | `com.hibs.bolloon` |
| iOS Bundle ID | `com.hibs.bolloon` |
| 版本（当前源码） | versionName `0.4.24` / versionCode `26` |
| 平台 | Android（Capacitor 8 WebView）/ iOS / Web (PWA) |
| 开源协议 | MIT（https://github.com/logos-42/bolloon） |
| 隐私政策链接 | https://bolloon.cn/privacy.html |
| 客服邮箱 | yuanjieliu65@gmail.com |

## 二、权限逐条说明（商店表单照抄）

| 权限 | 用途说明（可直接粘贴给审核） | 是否按需申请 |
|---|---|---|
| `BLUETOOTH_SCAN` | 发现附近的 Bolloon 设备与好友，用于 P2P 直连。已声明 `usesPermissionFlags="neverForLocation"`，**不用于推断位置**。 | 是（进入「附近设备」时） |
| `BLUETOOTH_CONNECT` | 与已发现的附近设备建立蓝牙连接，交换连接信息。 | 是 |
| `ACCESS_FINE_LOCATION` / `ACCESS_COARSE_LOCATION` | **仅 Android 11 及以下**：系统要求蓝牙扫描必须持有位置权限。已声明 `android:maxSdkVersion="30"`，Android 12 及以上不再申请、安装时也不会展示该权限。应用不读取、不存储、不上传任何位置数据。 | 否（仅系统要求，受限 ≤ API 30） |
| `INTERNET` | P2P 连接、从 bolloon.cn / GitHub 下载安装包、检查版本号。 | — |
| `ACCESS_NETWORK_STATE` | 判断网络可用性，决定走局域网直连还是中继。 | — |
| 相机 | **未申请** `CAMERA` 权限。扫码与拍摄头像通过系统相机应用完成（`ACTION_IMAGE_CAPTURE`），本应用只接收返回的图片。 | — |
| 完全访问权限（系统无障碍服务 `AccessibilityService`） | 提供「智能体操作手机」：由你在系统设置中确认一次后，智能体才可代你操作本机界面。**官网直装版默认引导开启（首次启动直接带你去开关页），可随时在系统设置里关闭**。**应用商店版（flavor=store）不含此项**（`android/app/src/store/AndroidManifest.xml` 用 `tools:node="remove"` 摘除）。 | 是（须用户在系统设置里确认一次） |
| Shizuku（第三方提权通道） | 可选的高级能力：在用户自行安装 Shizuku 并授权后，调用系统级 API。**应用商店版不含此项**。 | 是 |
| 存储/相册 | 不申请读写存储权限。头像图片在 WebView 内处理，写入应用私有目录。 | — |

## 三、我们不收集什么（可直接粘贴给审核）

- 无账号体系：不要求手机号、邮箱、身份证。
- **通讯录 / 短信 / 邮件（2026-11-13 新增，需用户显式开启）**：仅在用户主动开启对应开关后读取本机数据，用于本地检索与智能体处理；数据只保存在本机 `~/.bolloon/rust/mail`，可随时关闭，并在「清除本机数据」中一并删除。**不读取系统通话记录**（不申请 `READ_CALL_LOG`）。iOS 不提供短信读取能力（平台无公开 API），该项在 iOS 上如实不可用。
- **通话 / AI 外呼（2026-11-13 新增，需用户显式开启）**：外呼经语音服务商 / SIP 中继进行，App 只做发起与控制；本机只记录「号码、时间、时长、原因、状态」，**不存通话内容、不录音**。当前版本仅 Mock 服务商，未连接任何真实运营商。通话接通时**必须声明是 AI 助手**。
- 不采集设备唯一标识（IMEI / MAC / Android ID / 广告标识）。
- 不采集精确定位。
- **不含任何广告、行为统计、崩溃上报 SDK**（依赖清单 64 项中无 Sentry / Firebase / 各家统计 SDK；已用源码与依赖清单双向核对）。
- 不向第三方出售或共享个人信息。

## 四、数据流向与第三方清单

| 第三方 | 用途 | 数据 | 是否出境 |
|---|---|---|---|
| 用户自选的大模型服务商（DeepSeek / OpenAI 等） | 生成回复 | 用户填写的 API Key 与对话内容（**设备直连该服务商**，我们不经手、不中转） | 取决于用户选择 |
| Cloudflare | 网站与安装包托管、防护 | 访问日志（IP / User-Agent） | 是 |
| GitHub | 安装包与版本信息 | 下载请求日志 | 是 |
| npm registry | 读取最新版本号 | 请求 IP | 是 |
| Google Fonts | 网页字体（仅网站） | 请求 IP | 是 |
| IPFS / Kubo | 用户主动发布技能包 | 用户发布的内容 | 分布式 |
| x402 结算 / EVM 链 | 用户启用微支付时 | 公开链上交易记录（不可删除） | 是 |

## 五、账号注销 / 数据删除路径（商店必填项）

- 入口：应用内「我 → 设置 → 清除本机数据（注销）」。
- 行为：删除本机身份标识（DID）与密钥、智能体、会话与消息、支付记录、钱包账本，以及 localStorage 中的本机键。
- 实现：`src/web/mobile-privacy.ts` 的 `wipeLocalData()`（4 个 IndexedDB：`bolloon-mobile-data` / `bolloon-mobile` / `bolloon-mobile-payments` / `bolloon`），单测 `src/test/mobile-privacy.test.ts` 锁住"清单与实际库名一致"。
- 时限：**即时生效**；异常情况最长 7 个工作日（邮箱同上）。
- 例外（已向用户明示）：已写入公开区块链的交易记录任何服务方都无法删除。

## 六、首次启动合规（商店审核高频驳回项）

- 首次启动即弹出隐私政策同意门，**同意前不初始化任何功能**：不读本机数据、不连网、不申请权限（`mobile.js` 的 `init()` 只做分支判断，真正初始化在 `initApp()`）。
- 用户点「不同意」不会崩溃、不会被强制退出，停留在说明页且不收集任何信息。
- 隐私政策有**双入口**：首启同意门 + 设置页「隐私政策与个人信息」。
- 验收脚本：`node scripts/verify-privacy.mjs`（站点侧，真 Chrome）与 `npx tsx scripts/verify-mobile-privacy.ts`（App 侧，真 Chrome 点真 DOM）。

## 七、备案信息（待填）

- ICP 备案号：**办理中**（站点页脚已留占位，见各页 `备案完成后在页脚公示` 注释块）
- APP 备案号：**办理中**（填入 `src/web/mobile-privacy.ts` 的 `APP_FILING_NO` 后，设置页与政策页自动展示）
