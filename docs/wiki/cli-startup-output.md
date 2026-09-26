---
title: CLI 启动期加载日志: 默认静默 + 诊断回流 + 文件留底
source: session (leo 2026-09-26 队列① + 真跑捕获 + 变异验证)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [cli, startup, logging, log-gate, quiet, verbose, ink, acceptance, mutation]
---

# CLI 启动期加载日志: 默认静默 + 诊断回流 + 文件留底

**口径 (leo 2026-09-26)**: 正常/交互启动**不刷加载日志**; 诊断能力**不许真删** —— 日志仍写文件, 并留在
`--verbose` / `BOLLOON_VERBOSE=1` 后面; **错误 / 降级 / 需人介入的信息不算加载日志, 不许一并吞掉**。
覆盖三个启动面: CLI 交互启动 · `bolloon` 子命令 · 后台进程 (dashboard / `--web`)。

## 1. 先查清「谁在打哪些行」(真跑捕获 stdout/stderr)

**结论: 启动刷屏全部来自我们自己这一侧的两种写法, 与 tsx 运行时无关。**

| 行 (原文摘录, 取自真跑) | 谁打的 | 出处 |
|---|---|---|
| `[web] webRoot = /Users/…/src/web` | 本仓 | `src/web/server.ts` |
| `[createWebServer] bootstrap 完成 (3506ms)` | 本仓 | `src/web/server.ts` |
| `[agent-registry] OrbitDB 服务注册表 已启用` | 本仓 | `src/web/server.ts` |
| `[did-catalog] OrbitDB 复制启动失败 (非致命…)` / `[自愈] 恢复 channel: …` / `[runs] 对账: …` | 本仓 | `src/web/server.ts` |
| `开始生成 P2P 身份...` · `复用 P2P 身份: did:key:z6Mk…` · `P2P 身份已生成: …` · `DID: did:key:z6Mk…` | 本仓 (无 tag 的裸 `console.log`) | `src/web/server.ts` |
| `[supervisor-host] 启动 owner=… worker=… tick=30000ms` · `[supervisor] 长期执行层已启动 (…)` | 本仓 | `src/agents/supervisor-host.ts` |
| `[supervisor] 初始化未就绪 (setup, 阶段 identity_pending) → 只诊断, 不执行 Goal` | 本仓 (**信号行**, 保留) | `src/index.ts` |
| `[HumanValueStore] Initialized at /Users/…` | 本仓 | `src/pi-ecosystem-judgment/human-value-store.ts` |
| `[IrohTransport] Started, node=…` | 本仓 | `src/network/iroh-transport.ts` |
| `[bootstrap] context 收集完成: …` | 本仓 | `src/bootstrap/bootstrap.ts` |
| `[PiAIModel] Initializing with provider: …` | 本仓 | `src/llm/pi-ai.ts` |
| `[McpAdapter] Discovered …` | 本仓 | `src/pi-ecosystem-mcp/index.ts` |
| `2026-…Z [info]: ✅ 智能体验证管理器已创建` · `🔧 Hyperswarm P2P 通信器已创建` | **依赖库** | `node_modules/@diap/sdk/dist/index.js` |
| `2026-…Z [info]: ✅ Kubo 本地节点完全就绪` · `[warn]: ⚠️ 守护进程启动超时…ipfs daemon` | **依赖库** | `node_modules/@diap/sdk/dist/ipfs-setup.js` |
| `2026-…Z [warn]: ⚠️ 本地 IPNS 发布失败: TimeoutError…` | **依赖库** | `node_modules/@diap/sdk/dist/ipfs-multi*.js` |
| (无) | **tsx 运行时** | 实测 `npx tsx -e "console.log('probe')"` → stdout 1 行(自己的), **stderr 0 行** |
| `启动 Web 服务...` / `启动命令行界面...` | 本仓父进程 (`cli-entry.ts` 拼 ANSI 色码) | 一行启动自述, 不属加载日志, 保留 |

实测规模 (26s 观察窗口, `--web`, 同一台机器):

```
[基线 BOLLOON_LOG_GATE=0] 控制台总行数=139 · 加载日志类=102
[默认模式]                控制台总行数= 26 · 加载日志类=  0
[诊断模式 BOLLOON_VERBOSE=1] 控制台总行数=149 · 加载日志类=111
```

## 2. 做法: 集中式日志闸门 (不是逐文件删 console.log)

新增 `src/cli/log-gate.ts`(`installStartupLogGate`), 在 `src/index.ts` 的 `main()` 里**任何 bootstrap 之前**装上。
理由: 加载日志散在 1325 处 `console.*` + 依赖库自己的 logger 里, 逐点改动必漏、且不可回退。

| 启动面 | 判定 | 静默范围 | 信号行去处 |
|---|---|---|---|
| CLI 交互 (`--cli`) | `cli-interactive` | `console.log/info/debug/warn` + stdout 加载行 | **改道 stderr** (stdout 是 Ink 画布, 既不丢又不糊屏) |
| 后台 / dashboard (`--web`) | `web` | stdout/stderr 里的加载行 | 原样留在 stderr |
| 其它一次性启动 | `plain` | 同上 | 原样 |

**不装闸门的三类**(它们的输出就是交付物/机器数据): `--json` · 一次性工具调用 (`--prompt`/`--tool`/`--read` …) ·
命令式诊断 (`--setup-*` / `--supervise*`)。

**行分派规则**(按行判定, 不按调用点): `signal`(错误/降级/需人介入 → 任何模式都可见) > `loading`(默认丢, 写文件) > `plain`(放行)。
- loading 的形状: module tag (`[web]` / `[自愈]`) · ISO 时间戳行 · inspect dump · 少数无 tag 的启动自述行 (逐条锚定, 不做宽泛匹配)。
- `0 个错误` / `0 个转人工` 这类**零计数**不算信号 (「没有要人管的事」); 但同一行里还写了别的失败/超时 → 照样算信号, `N 个转人工` (N>0) 也照样保留。
- 整 chunk 被静默时仍按 Node 语义回调一次 (`nextTick`), 否则 Ink 的渲染链会卡死。

## 3. 双向真跑存证 (`scripts/verify-cli-quiet.ts`, 12 条, 全绿 exit 0)

判据在门里**独立重写**(不 import `isStartupLogLine` —— 那会用自己证明自己), 全部真跑真进程。

```
A1  前置: 基线真的有加载日志 (否则「静默」恒真 = 空门)          → 102 行
A1b 前置: 跨轮稳定样本够多                                      → 100 行 (单轮特有 2 行属事件类)
A2  默认静默: 加载日志不上控制台                                 → 139 → 26 行; 加载日志 102 → 0
A3  诊断回流: 稳定加载日志一字不少地回来                         → 100 行全回来, 缺 0
A3b 诊断回流(逐字): 不含数字的稳定样本                           → 13 条, 逐字缺 0
A3d 一行不落: 该轮写进文件的行, 控制台同样看得见 (同一进程双向)   → 111 → 缺 0
A3c CLI 开关: `--web --verbose` 与 env 开关等价                  → 49 行加载日志全量输出
A4  诊断不丢: 控制台看不到的行在日志文件里查得到 (逐字)           → 默认轮区段 132 行, 稳定样本 13/13; 诊断轮 111/111
A5  错误不吞(环境真降级): 基线信号行在默认模式照样显示             → 2/2 (含「初始化未就绪」「OrbitDB 复制启动失败」)
A6  错误不吞(定向注入, 夹具自造): 坏配置的真错误必须可见           → 命中; 该轮加载日志仍 0
A7  CLI 交互启动(真 pty): 加载日志 0 行, 面板/输入提示/门禁提示都在 → 0 行; 面板 ✓ 提示 ✓ 门禁 ✓
A8  子命令 + 机器可读输出不受影响                                → 3 子命令 exit 0 无加载日志; `--version json` 仍可 JSON.parse
```

几个**必须写清的采样细节**(否则数字对不上时无从判断):
- 跨进程比对对**行身份**做了归一 (行首 ISO 时间戳 · CID/DID/hex · 随机 worker/对端 id · 耗时计数), 而 `A3b` 对不含数字的稳定样本做**逐字**比对; `A3d`/`A4` 是**同一进程内**的逐字比对。
- 诊断轮窗口比基线**长 8s**: 基线有些行 (IPNS 发布序列) 在 24–26s 才出现, 窗口一样长会变成「比赛谁先被杀」。
- 基线跑**两轮**取交集当跨进程基准: `[自愈] 恢复 channel: …` 这类**事件**不是每轮都有, 拿单轮当基准会把「事件没再发生」误判成「诊断没回流」。
- A6 的注入是**夹具自造**(隔离 HOME 写坏 `bolloon-config.json`), 不依赖外部环境: 真跑原文
  `[PiAIModel] Error reading apiKey from config: SyntaxError: Expected property name or '}' in JSON at position 45`。
- A7 用 macOS 自带 `script -q /dev/null` 开**真 pty** —— Ink 的 TUI 没有 TTY 就不渲染(直接抛 `Raw mode is not supported`), 拿管道测等于没测。

## 4. 变异 (阴性对照): 至少 1 条判红

`npx tsx scripts/verify-cli-quiet.ts --mutation` —— 把闸门过滤开关改成 `if (false && filtering)` + 重建 dist:

```
[变异] 盘上 hash 已变 (22f182f800ac) → 重建 dist → 跑门 (期望 A2 红)
  ✗ FAIL A2 默认静默 — 控制台总行数 135 → 135; 加载日志类 98 → 103   ← 红
  变异态 exit=1
[变异] 已恢复原文件 → 重建 dist → 复跑门 (期望绿)
  ✓ PASS A2 默认静默 — 控制台总行数 135 → 26; 加载日志类 98 → 0      ← 绿
  恢复态 exit=0
=== 变异验证: 变异态 exit=1 · 恢复态 exit=0 → ✓ 判据成立 ===
```

## 5. 开关 / 文件 / 逃生口

| 项 | 值 |
|---|---|
| 诊断模式 | `--verbose` (任意启动面, 经 `cli-entry` 透传) 或 `BOLLOON_VERBOSE=1` |
| 关掉闸门 (拿未静默的原始输出) | `BOLLOON_LOG_GATE=0` |
| 日志文件 | `${BOLLOON_HOME:-~/.bolloon}/logs/startup.log` (append; 每 chunk 一次 `appendFileSync`, 进程被强杀也不丢) |
| 文件里有什么 | 每个 chunk 的行 + `# <ISO> startup log (mode=… verbose=… pid=… argv=…)` 头 |
| 闸门自身写文件失败 | `stats.fileError` 立即打到 stderr —— 「日志写不进去」不许变成新的静默缺陷 |

## 6. 门禁 (本轮)

- `scripts/verify-cli-quiet.ts` **12 passed / 0 failed / 0 skipped** (exit 0) · 变异 `--mutation` **判红→恢复绿**
- `src/test/log-gate.test.ts` **20/20** (行分类 · 信号行 · 零计数 · verbose/逃生口 · 日志路径 · 流包装回调)
- 全量 vitest **245 文件 / 3980 测全绿** (前台一次, 71s) · `tsc --noEmit` **0 错**
- 飞轮冻结门 `goal-flywheel-wiring-freeze.test.ts` **34/34**
- `scripts/verify-model-*.ts` (P0–P7 那七门): selection **55/0** · selector **51/0** · policy **36/0** · discovery **81/0** · wiring **89/0** · entrypoints **59/0** (全 exit 0)
- wiki 四门 (`wiki_check` · `wiki_lint --strict=v2` · `raw_manifest_check` · `supersede_check`) OK

## 7. 刻意保留 / 未做 (逐条)

- **保留**: 5 步启动清单 (`⟳ [3/5] 启动 P2P 网络` …) 与品牌框 —— 它们是**进度 UI**, 是「必要的 spinner」那一条; 去掉就没有任何启动反馈了。
  想连它也静默, 改 `src/cli/log-gate.ts` 的加载行判据即可 (现在它们不含 module tag, 不在判据内)。
- **保留**: `● Bootstrap 完成 (3506ms, 0 个非致命错误)` 之外的那些 `s.log(...)` 状态行同样按「plain 放行」处理。
- **未做**: 没有把 `--cli` 下 Ink 的状态栏/工具栏改成可隐藏 —— 与本次诉求无关。
- **顺手发现, 未动**: `src/web/server.ts.bak` 是一份历史备份文件(不在我的名册内, 也不是本轮引入)。
- **未做**: 依赖库 (`@diap/sdk`) 自己 `console.log` 的**源头**没改 (闸门在进程边界按行拦, 不动 `node_modules`)。
- 第八门 `scripts/verify-model-acceptance.ts` 属 P8 那条线 (`1326a9e`), 裸跑 exit=1 的原因写在它自己的红项里
  (第 12 条反事实要靠它的变异脚本 M4 的输出), **与本轮改动无关**; 且该脚本不依赖启动日志文本 (源码里 `webRoot`/`log-gate`/`BOLLOON_VERBOSE` 命中 0)。

## 8. 变更文件

| 文件 | 说明 |
|---|---|
| `src/cli/log-gate.ts` (新) | 启动期日志闸门: 行分类 · 信号行不吞 · 文件留底 · verbose/逃生口 · `startupLogPath` |
| `src/index.ts` (改) | `main()` 里装闸门 (三个启动面); 删掉旧的「清空 console + 只丢行首 `[`」的两处临时静默 (它会把 `[supervisor] 初始化未就绪` 这类**需人介入**的行一起吞掉) |
| `src/test/log-gate.test.ts` (新 20 条) | 行分类/信号/零计数/开关/路径/流包装 |
| `scripts/verify-cli-quiet.ts` (新) | 双向真跑验收门 + `--mutation` 阴性对照 |

复现: `npx tsx scripts/verify-cli-quiet.ts` (全跑 ~3.5 分钟) · `npx tsx scripts/verify-cli-quiet.ts --mutation` (阴性对照)。
