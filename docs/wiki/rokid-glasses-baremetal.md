---
title: Rokid Glasses 裸机开发接入（RG-glasses2 / YodaOS-Sprite）与眼镜端 Bolloon 客户端
source: session
created: 2026-10-28
last_confirmed: 2026-10-28
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [rokid, glasses, yodaos-sprite, android, adb, baremetal, camera2, ocr, whisper, asr, bolloon, qr-login, qr-code]
---

# Rokid Glasses 裸机开发接入 — 设备事实、可用/不可用边界、眼镜端 Bolloon 客户端

> 起点：leo「开发 rokid 眼镜，把 Rust 的 bolloon 开发接入，USB 已连上，需要授权码接入」。
> 本文只写**实测过的**东西；没验的一律标「未验」。

## 1. 设备事实（adb 实测）

| 项 | 值 |
| --- | --- |
| 型号 | `RG-glasses2` / `ro.product.rokid.oem.model=RV301` |
| 系统 | Android 14（`ro.build.version.sdk=34`），内核 6.1.162-android14，平台 YodaOS-Sprite |
| 固件 | `1.05.001-20260916-180202`（`UKQ1.251204.001`） |
| SoC/ABI | Qualcomm(`neo61`)，仅 `arm64-v8a`，4 核 |
| 序列号 | `2401092640182167` |
| USB | VID `0x18d1` PID `0x4e11`，含 **ADB Interface**（class 255/66/1），经 Apple USB-C 数字 AV 转接器枚举 |
| 屏幕 | `wm size` 480×380，密度 240dpi ⇒ 可用 **320×253 dp**（极窄，字号必须按 dp 重算） |
| 存储 | `/data` 19G，空闲 19G |
| 默认息屏 | `screen_off_timeout=5000`（调试时改成 600000，否则截图全是黑的） |

**ADB 注意**：首次 `adb devices` 可能空表（daemon 赶在枚举完成前启动）。`adb kill-server` 后重试即出 `device`。本次未出现 `unauthorized`（无需眼镜端确认指纹）。

## 2. 三条「授权/接入」不要混为一谈

| 名字 | 是什么 | 对本项目的作用 |
| --- | --- | --- |
| **授权码**（8 位，说明书上） | 消费版**功能激活**，在安卓「乐奇灵眸」App 里手输（与账号绑定，5 次错锁 10 分钟） | **与开发无关**。不激活只锁官方 App 的拍照/录像/AI 问答/行业专家；`adb install` 与自研 App 照跑 |
| ADB 调试授权 | 电脑与眼镜的 RSA 指纹 | 本机已通过 |
| SDK 接入配置 | Maven 仓库 + AAR 依赖 | 见 §3（本设备**用不了**企业版 SDK） |

## 3. Glass3 企业版 SDK 在本设备不可用（关键结论）

- 官方 Maven 可达：`https://maven.rokid.com/repository/maven-public/`（`glass3.open.sdk` 有 `2.2.2-E`…`2.5.1-P`）。
- AAR 里 `GlassSdk.bindSecurityService()` 绑的是 **`com.rokid.security.system.server`** 的 `SecurityCoreService`。
- 本机 `pm list packages` **无 `com.rokid.security.*`**，`cmd package query-services -a com.rokid.security.system.server.SecurityCoreService` → **No services found**。
- ⇒ 企业版 SDK（`glass3.open.sdk`）**绑不上**，`rokidSdkMode=vendor` 不要打开。

## 4. 正确路线 = 「眼镜端裸机开发」（官方公开）

`developerdoc.rokid.com/sdk` 选型表（YodaOS-Sprite / Rokid Glasses 一栏）：

| 方案 | 跑在哪 | 获取 | 用途 |
| --- | --- | --- | --- |
| CXR-L SDK | 手机 | 公开 | 经 Rokid AI App 用眼镜的取景/音频/显示 |
| CXR-M SDK | 手机 | **商务对接**（Glasses.BD@rokid.com） | 与眼镜协同的手机 App |
| **眼镜端裸机开发** | **眼镜本机** | **公开** | **标准 Android(AOSP) 工程，可管按键/IMU/Camera** |

本项目走第三列：`rokid/glass` 就是一个普通 Android 工程（`com.bolloon.rokid.glass`，minSdk 26 / targetSdk 35），`adb install` 直接跑。

## 5. 触摸面板是按键，不是触摸屏

`dumpsys input`：`ROKID,PSOC-TP-R`（`/dev/input/event3`），**Classes: KEYBOARD**，`getevent -p` 支持的 keycode：

```
0x1c KEY_ENTER   0x67 KEY_UP    0x69 KEY_LEFT   0x6a KEY_RIGHT  0x6c KEY_DOWN
0x9e KEY_BACK    0x94..0xcc (PROG1/2/3/4, PLAYPAUSE, F13/F14)
```

⇒ UI **不能只靠 Button 点击**（这也是「两个按钮切换不了」的根因）。必须在 Activity 里 `dispatchKeyEvent` 处理 DPAD/ENTER/BACK。

本仓约定（`MainActivity.kt`，leo 2026-10-28 定稿）：

**两种滑动 = 前进 / 后退**（不是「上下切板块」）：

| 键 | 列表页 | 对话页 | 说明 |
| --- | --- | --- | --- |
| 往后滑 `KEY_DOWN`/`RIGHT` | 往下走：条目下一条，到底进下一栏 | 往下翻记录 | 世界 → 外部 → 智能体 → 群组 → 世界 |
| 往前滑 `KEY_UP`/`LEFT` | 往回走：条目上一条；到顶选中**顶部外壳**；首栏再退 = 上一栏 | 往上翻记录 | |
| 单击 `KEY_ENTER` | 世界=**扫一眼**；外部/智能体=进对话；群组=进群 | 开始/停止说话并发送 | |
| 双击 `KEY_BACK` | 顶部外壳取消 → 否则退出应用 | 返回列表 | |

**最小化挂在顶部外壳**：往前滑到顶 → `◉ bolloon` 那一行白底高亮 → **单击它**才最小化成左下角挂件（logo + 一个机会卡片位，新消息流入显示 `+N`，5s 轮询）。透视屏「黑=不画」，所以只隐藏主列 + 挂件 `layout_gravity=BOTTOM|START`，不改窗口尺寸。

## 6. 眼镜侧没有可用的系统语音/识别服务

- `android.speech` 的 `RecognitionService`：**No services found**；无 `RecognizerIntent` activity；无 TTS 引擎（`settings get secure tts_default_synth` = null）。
- Rokid 自己的 `com.rokid.os.sprite.aiui.AIUIService`（乐奇语音）**存在但 `exported` 同时要求 `com.rokid.os.sprite.permission.BIND_AIUI_SERVICE`，`prot=signature`** ⇒ 第三方绑不了。

⇒ **语音与视觉都放在节点侧做**（见 §7），眼镜只负责录音/拍照与显示。

## 7. 节点侧新增三端点（Rust `bolloon-web`）

| 端点 | 入参 | 实现 | 实测 |
| --- | --- | --- | --- |
| `GET /api/wallet` | — | 读 `~/.hermes/wallets/{sepolia-test,mainnet}.json` 的 `address`，`eth_getBalance` + USDC `balanceOf`（`0x70a08231`）真打 RPC；私钥永不出模块 | ✅ `ok:true, eth:0.0, usdc:0.0, network:sepolia, source:chain` |
| `POST /api/asr` | 原始 WAV（16k/mono/16bit） | 落临时文件 → `whisper-cli -m <model> -l zh -nt -np` → 拼 stdout；**失败如实报错**（不假装识别成功） | 见 §9 |
| `POST /api/vision` | `{image_base64}` | macOS **Vision 框架离线 OCR**（`~/.bolloon/bin/vision-ocr`，Swift 编译）→ 与意图词表词面匹配（整词命中优先） | ✅ 真截图 OCR 出整屏中文并命中意图「项目」 |

配置（都可省，默认指向 `~/.bolloon/`）：`BOLLOON_ASR_BIN` / `BOLLOON_ASR_MODEL` / `BOLLOON_ASR_LANG` / `BOLLOON_OCR_BIN` / `BOLLOON_WALLET_FILE` / `BOLLOON_RPC_URL`。

安装脚本：`scripts/setup-ocr.sh`（swiftc 编译 OCR）、`scripts/setup-asr.sh`（cmake + whisper.cpp + ggml 模型）。

**为什么视觉不是视觉大模型**：当前 provider `deepseek-chat` 不吃图。先让链路真通（OCR 读字 + 词面匹配意图），换视觉模型时只改 `vision.rs::ocr_text` 一处。

## 8. 眼镜端客户端（`rokid/glass`）实况

- 顶栏 `◉ bolloon`（内联文字 logo）+ 节点状态（`世界 N · 外部 N · 我的 N · 群 N`）；**侧栏四栏：世界 / 外部 / 智能体 / 群组**；底部按键提示条；启动 900ms splash。
- **世界**：默认动作条 `📷 扫一眼 · 识别画面匹配意图` → 卡片流（`1/4 · ● ○ ○ ○`、匹配 %）。
- **外部**（外部智能体）：钱包（地址短写 + USDC/ETH 余额）· 待确认支付/授权条数 · 最近交流（最新 5 条）· 执行工作（任务数 + 前几条）。
- **智能体**（我的智能体）：本机 `state.agents`，进对话。
- **群组**：`/api/groups` 列表（含 ACL）+ 最近 5 条群消息；进群后说话走 `/api/groups/{id}/say`。
- **对话页**：`🎤 单击说话` → `AudioRecord` 录音 → `/api/asr` → `/api/chat`（或群 say）→ 回复上屏 + TTS 尝试。
- **静音门**：录音 RMS < 600 直接当「没说话」，避免 whisper 在静音上幻觉出一句话（实测踩过：静音被识别成「字幕:郭文贵」）。
- **刷新节奏**：切栏 / 进对话 / 20s 定时；**链上钱包单独刷**（RPC 慢，塞进主刷新会把整屏拖在「连接节点中…」）。
- 明文 HTTP **只对 `127.0.0.1`/`localhost`** 放开（`res/xml/network_security_config.xml`），targetSdk 35 默认禁 cleartext —— 之前「拉不到机会」就是这条。
- 摄像头走 **Camera2**（`CameraCapture.kt`），JPEG → `downscale` → base64 → `/api/vision`。

节点位置两种模式：眼镜上跑（`127.0.0.1:54188`）或 Mac 上跑 + `adb reverse tcp:54188 tcp:54188`（当前调试用后者）。

## 8.5 两种显示模式（leo 2026-10-28 定稿）

| 模式 | 形态 | 切换 |
| --- | --- | --- |
| **球体（默认）** | 中心 `bolloon` 球 + 世界/外部/智能体/群组四个卫星球**同时显示**；球间大间距、**无连线**；选中球放大回弹 420ms，切换节流 300ms | 单击 `bolloon` 球 → 卡片模式 |
| **卡片** | 四栏两级侧栏：顶层四栏，进栏后**侧栏内容被替换**成该栏条目名单；主区显示详情 | 单击顶部外壳（= bolloon 球）→ 球体模式；**长按**外壳才是最小化到左下角挂件 |

两种模式共享同一份状态（section / 选中项 / 列表数据），切模式**不丢当前页面**。

## 8.6 登录（扫码 / 出码两条路，2026-10-28）

眼镜上没有键盘，所以登录**不做密码**，只做「把本机节点身份授给这台眼镜」：两条路共用一个**一次性码**（6 位，去掉 `0/O/1/I` 的 32 字母表，180s 有效，用完即废）。

| 路 | 谁出码 | 谁确认 | 链路 |
| --- | --- | --- | --- |
| ① 扫码 | 电脑/手机（`/login` 页出二维码） | 眼镜拍一下 | `/api/auth/qr/issue` → 页面内联 SVG → 眼镜拍照 → `POST /api/auth/qr/scan`（节点 macOS Vision 解）→ `POST /api/auth/qr/claim` |
| ② 出码 | 眼镜（镜片显示 6 位码） | 手机/电脑在 `/login` 输入并点「授权这台眼镜」 | `GET /api/auth/device-code` → `POST /api/auth/qr/approve` → 眼镜轮询 `/api/auth/qr/status` 见到 `approved` → `claim` |

- **令牌** = `{code}.{ts}.{ed25519 签名 hex}`，签名体 `glass|{code}|{ts}`；`GET /api/auth/session?token=` 用本机 identity 公钥**离线验签** + 30 天有效期，节点**不存令牌**（换身份/换机自然失效）。
- **授权门**：`via=device` 的码（显示在镜片上，谁看见都能念）必须有人在手机/电脑点过授权才给令牌，否则 `claim` 返回 `need_approve`；`via=screen` 的码本身就是授权凭据。
- **眼镜端 UI**：未登录时球体**中心球=「确认登录」**（其余球点了也进登录页）；登录页三态 `CONFIRM / SCAN / CODE`——单击推进或重试、往后滑换路线（扫码 ⇄ 出码）、双击返回；出码页 26sp 大字 + 剩余秒数。令牌存 `SharedPreferences`（`auth_token`），启动时验一次，进程被杀重开仍是登录态。
- **设置页第 5 行**：显示 已登录 / 未登录 / 开发者跳过，**单击 = 登录或退出登录**（退出清令牌 + 清开发者跳过，中心球回到「确认登录」）。
- **终端出码（不用开浏览器）**：`bolloon glass login` 调本机节点的 `/api/auth/qr/issue`，把二维码画成方块字符打到终端（同一 `qrcode` 矩阵，`Dense1x2` 渲染），等眼镜扫到后打印 `✓ 眼镜已登录`；`--once` 只出码不等。
- **开发者模式跳过**：**debug 包 + 插着 USB 数据线**（`ACTION_BATTERY_CHANGED` 的 `EXTRA_PLUGGED != 0`）才出现，拔线就隐藏 —— 正常戴出门不会看到开发者选项；确认页**长按**（≥700ms）= 跳过登录，**只对本次进程有效、不落盘**（否则跳过一次就再也测不到真流程）。
- **手机打开 `/login` 需要局域网监听**：默认只绑 `127.0.0.1`；`BOLLOON_BIND=0.0.0.0 bolloon web` 后用 `http://<电脑 IP>:54188/login`。

踩过的四个坑（都在眼镜端）：① 登录页正文整块不显示 —— 收侧栏时藏了 `sidebarBox.parent`，它的 parent 是含正文的 `body`，要收的是 `sidebarCol` 本身；② 出码页「一闪就没」—— 扫码 `loginBusy` 把滑动挡死 + 触摸面板长滑连发 `DPAD_DOWN`（未过滤 `repeatCount`）会不停换码 ⇒ 600ms 节流 + 只认首次 + 码不被重取清空；③ 摄像头不出图会永久挂在「识别中…」⇒ 9s 看门狗解除 busy 并提示改道；④ `session` 端点原来只判「令牌非空」= 假门，本轮改成真验签。

## 9. 验证记录（真跑）

| 项 | 结果 |
| --- | --- |
| gradle 构建 | `BUILD SUCCESSFUL`，`app-debug.apk` 844K |
| 安装启动 | `Success` / `am start` ok，`pidof` 有进程，`uiautomator dump` 抓到本 App 的视图树 |
| 截图 | 三页截图均真抓（顶栏/侧栏/卡片/钱包/最近交流） |
| `/api/chat` | ✅ 真回复（「我是小黑，一个本地优先的 AI agent…」） |
| `/api/wallet` | ✅ sepolia 真链查询 |
| `/api/vision` | ✅ 真截图 OCR 全中文 + 命中意图 |
| 扫一眼（眼镜上） | ✅ 相机真出图、链路走通（当次镜头对着空白场景，结果「已识别画面（未匹配意图）」） |
| 语音闭环（眼镜上） | ✅ `AudioRecord` → `/api/asr` → 文本上屏 → `/api/chat`。**唯一保留**：没人对着麦克风说话，识别到的是环境声（已加 RMS 静音门） |
| 登录·扫码路 | ✅ 真浏览器 `/login` 出真二维码 → `vision-ocr --qr` 解出 `bolloon://login?code=S6UZ7U` → 节点 `/api/auth/qr/scan` 同码 → `claim` → `/api/auth/session` 验签通过 → 二次 `claim` 拒 |
| 登录·出码路 | ✅ 真机出码 `JHNQS2`/`PWMWV9`（大字 + 倒计时）→ 手机侧 `approve` → 眼镜自动 `claim` 回球体；`run-as cat shared_prefs` 里是真令牌，杀进程重启仍登录态 |
| 登录·测试门 | ✅ `cargo test -p bolloon-web --lib qr_login` 4/4（真 HTTP 全链路 + `/login` 页可达 + 假签名拒 + 一次性拒 + 授权门） |
| `/api/asr` | ✅ whisper-base 真转写（`你好,我是小星,现在测试眼镜余音时别` — 3.8s/5s 音频；base 模型有字错，可升 small） |

## 10. 诚实边界（未做/未验）

- **ASR 已通，但是 base 模型 + CPU**：`ggml-base.bin` 从 HuggingFace 反复断流（`curl 18`），最终走 `hf-mirror.com` 一次拿全 141MB；whisper.cpp 用 **`GGML_METAL=OFF`** 构建（Intel + 1.5G 显存走 Metal 会 `GGML_ASSERT(buf_src)` 崩）。base 中文有字错，要更准换 `small`。
- **钱包支付未打通 UI**：只显示余额与 `待确认支付 N`（来自 `/api/auth/requests`）；眼镜上没有一键签支付（x402 `/api/x402/info/{id}/payment` 通路存在但未接）。
- **「最近交流」不是按联系人分库**：读的是 `/api/bootstrap` 运行期消息流最新 5 条。
- **「执行工作」读 `/api/tasks` 任务板**，当前空。
- **Rust 交叉编译到 arm64-Android 未跑过**：`scripts/build-android-rust.sh` 已写好（需 NDK r27c，本机正在下），眼镜现在是客户端、节点在 Mac 上。
- **登录不是接口门禁**：节点其它 API 仍未鉴权，令牌只用于眼镜端「是否已登录」的判定与身份证明。
- **眼镜对着屏幕扫码那一步未在本会话目验**：解码环节是用页面截图在节点侧验的；leo 现场确认「扫描成立」覆盖了那一跳。
- **未验**：眼镜独立联网（`wlan0` 当时 `DOWN`）、Wi-Fi 配网、后台常驻/开机自启、x402 真链支付、连续语音多轮上下文。

相关：[glass-reality-interface.md](./glass-reality-interface.md)（产品定义：常驻感知 vs 遥控器）、[rust-rewrite.md](./rust-rewrite.md)、[log.md](./log.md)。
