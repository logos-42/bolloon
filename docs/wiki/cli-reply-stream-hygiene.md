---
title: CLI 会话内回复流卫生: 内部运行日志不进回复流 (发送点声明 internal + 搬去日志文件)
source: session (leo 2026-09-27 两次反馈 + 真跑捕获 + 变异验证)
created: 2026-09-27
last_confirmed: 2026-09-27
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [cli, reply-stream, hygiene, internal-log, pi-sdk, stream-event, verbose, ink, acceptance, mutation]
---

# CLI 会话内回复流卫生: 内部运行日志不进回复流

**口径 (leo 2026-09-27, 两次反馈)**: 会话里的**回复流**混进了**给开发者看的运行日志** ——
`🔄 开始 React 循环`(他写的是这个拼法, 源码里的字面是 `🔄 开始 ReAct 循环...`) · `🧷 运行已登记 (…)` ·
`🔄 目标对齐 review 1/2: 深挖续跑` · `✅ 处理完成，共 N 次循环`(他说的"目标循环次数") · `🎯 目标仍在进行 …`。
"**回复过程的掺杂日志还没去掉**" —— 判据: 这些行在**回复流里 0 命中**, 但**诊断能力不许丢**
(搬去日志文件, `--verbose` / `BOLLOON_VERBOSE=1` 仍能查到)。
同一条口径的另一半: 回复本身要去冗余(**不复述用户请求 · 不复述工具输出 · 不预告再宣告 · 不把内心独白当内容**),
只留 **结论 + 必要证据(路径/命令/数字) + 下一步或需要人决定的点**。

姊妹页: [cli-startup-output.md](./cli-startup-output.md) (管**启动期**加载日志; 本页管**每次对话**的回复流)。

## 1. 先真跑捕获「回复流里到底有哪几行」, 再归因到发送点

真跑 = 隔离 HOME (复制本机 provider 配置) + 真模型 + 真 pty (`scripts/lib/pty-drive.py`, 等渲染出现再喂输入) +
`npx tsx src/index.ts` (`bolloon --cli` 走同一条主路径)。任务: 「看一下当前目录有哪些文件, 一行回我即可」。

**修复前实际出现在回复流里的行 (逐字, 去 ANSI 后)** — 共 **8 行**, 归因到具体发送点:

| 回复流里真出现的行 (原文) | 发送点 (文件:行) | 来源 tag |
|---|---|---|
| `🔄 开始 ReAct 循环...` | `src/agents/pi-sdk.ts:1621` | system |
| `🧷 运行已登记 (run=…, goal=…, 预算 60 步 / 30 分钟)` | `src/agents/pi-sdk.ts:1700` | harness |
| `✅ list_files 执行成功` | `src/agents/pi-sdk.ts:2295` | 工具名 |
| `🔄 工具结果汇报超限, 强制收尾` | `src/agents/pi-sdk.ts:2407` | system |
| `🔄 目标对齐 review 1/2: 深挖续跑` (×2 行) | `src/agents/pi-sdk.ts:2438` | system |
| `✅ 处理完成，共 6 次循环` | `src/agents/pi-sdk.ts:2493` | system |
| `🎯 目标仍在进行 (未判完成): 本轮有可核验进展: … → 直接开下一轮 (收尾 9 步 · memory 3 · skill 候选 0 · goal=…)` | `src/agents/pi-sdk.ts:2586` | harness |

**归属结论 (拿代码路径 + 真跑为据)**: 不是 ink 渲染层把日志当消息渲染, 也不是工具结果透传 ——
**是 agent 循环自己把这些 `type: 'status'` 事件 emit 到 `onStream`**, 而 CLI 交互面**没有独立状态区**,
它的 `onStream` **就是对话回复流** (`src/index.ts` 里落进 `appendLine` → Ink 消息列表)。
根因是**判据按内容子串猜**: 那里原有一张子串黑名单 (`content.includes('🔄 循环')` …), 于是
`🔄 开始 ReAct 循环...` 这种"说得更早、措辞不同"的一句整条漏掉, 猜不完。

## 2. 修法: 在**发送点**声明, 在**回复流组装口**唯一落判

| 层 | 做什么 | 文件 |
|---|---|---|
| 类型 | `StreamEvent.internal?: boolean` —— "这一条是内部运行日志", 缺省 = 用户可见 | `src/agents/pi-sdk-types.ts` |
| 发送点 (emit) | **20 处** `type: 'status'` 事件加 `internal: true` (循环推进 / 运行登记 / 压缩 / 收尾计数 …) | `src/agents/pi-sdk.ts` (1186, 1621, 1655, 1700, 1823, 1846, 2096, 2221, 2295, 2315, 2395, 2407, 2438, 2465, 2473, 2493, 2586, 2780, 2930, 2962) |
| 判据 (唯一) | `isInternalRunLog(e)` = `status && internal === true`; `internalRunLogLine()` 生成落盘行 | `src/cli/reply-hygiene.ts` (新) |
| 回复流组装口 | 认这条声明: 内部日志 **只落盘**, 只有显式 verbose 才照旧上屏; 旧的子串黑名单**继续保留兜底** | `src/index.ts` (`processInputInner` 的 onStream status 分支) |

**为什么不在渲染层做字符串过滤**: 发送点自己最清楚"这句话是给谁看的"; 渲染层拿子串猜会一直漏,
且会把"要不要给用户看"这个产品判断埋进画界面的代码里。**没有新增第二条回复流组装路径**: 判据一个函数、
落盘一个函数、组装口一处 if。

**其它面一字不变**: Web 面 (`src/web/server.ts` 的 `streamCallback` → 状态栏 / `workflow_step`) 照旧收这些事件;
轨迹 / Run 记录等观测面照旧。**只有"CLI 交互面的回复流"这一个面把内部日志搬走。**

## 3. 搬走不是删掉: 日志文件 + verbose

| 项 | 值 |
|---|---|
| 落盘位置 | `${BOLLOON_HOME:-~/.bolloon}/logs/startup.log` (目的地走**已有**的 `startupLogPath()`, 不新开第二条路径) |
| 落盘行的形状 | `[<ISO 时间戳>] [运行] <来源 tag> · <原文一字不改>` (前缀可 grep: `grep '\[运行\] '`) |
| 上屏 | 默认**不上屏**; `--verbose` / `BOLLOON_VERBOSE=1` 时**原文**回到原来的位置 (走同一个 `appendLine`) |
| 落盘失败 | 静默吞掉 (绝不因为写日志失败影响对话) |
| 改前的行为 | 这些行既不进日志文件也不给开关 —— 是**真丢**, 不是静默 |

## 4. 验收 (真跑 · 逐串给数字)

`npx tsx scripts/verify-reply-hygiene.ts` —— 真 CLI 源码 + 真 pty + 真模型, 一次跑 **5 个会话** (默认 / verbose / 3 个变异)。

**逐串实测 (回复流命中 / 日志文件命中)**, 取自本轮默认模式真跑:

| 串 | 修复前 (真抓包 fixture) | 修复后 回复流 | 修复后 日志文件 |
|---|---|---|---|
| `开始 ReAct 循环` | 1 行 | **0** | 1 |
| `开始 React 循环` (leo 的拼法) | 0 (源码里没有这个字面) | **0** | 0 |
| `目标对齐` | 2 行 | **0** | 2 |
| `运行已登记` | 1 行 | **0** | 1 |
| `处理完成，共` | 1 行 | **0** | 1 |
| `目标仍在进行` | 1 行 | **0** | 1 |
| `工具结果汇报超限` | 1 行 | **0** | 1 |
| `执行完成，继续循环` | 0 (当轮未触发) | **0** | 1 |
| `参数: {` (工具入参 dump) | 0 (当轮未触发) | **0** | 1 |
| `评估是否需要压缩上下文` / `上下文压缩:` / `提取最终回答` / `reactive compaction 预检` / `恢复保护` / `自动重试 loop` / `loop 自动压缩` | 0 (当轮未触发) | **0** | 0 (当轮未触发) |

- **阳性对照 (不许空文档假绿)**: 修复前真抓包里同判据数出 **8 行内部运行日志 / 黑名单命中 6 类**
  (`scripts/fixtures/reply-hygiene/before-reply-stream.txt`); 且每次真跑都断言**会话真跑了**
  (用户消息回显 + 答案框 + 日志里的 `[运行]` 行) —— 否则"0 命中"判不了。
- **行数对比 (同任务 · 同判据)**: 回复流唯一行 **78 → 47**; 其中**内部运行日志 8 → 0**。
- **诊断召回对照**: 同一批串在 `BOLLOON_VERBOSE=1` 真跑里 **17 处回到屏上** (逐串: 开始ReAct=4 · 目标对齐=2 ·
  运行已登记=3 · 处理完成=1 · 目标仍在进行=1 · 工具结果汇报超限=2 · 执行完成继续循环=2 · 参数=2), 且该轮**照样落盘 9 串**。
- **发送点声明完备 (源码级)**: 20/20 内部行带 `internal: true`; **阴性对照 6/6** 用户可见状态
  (`⛔ loop 自动重试…仍失败` · `⚠️ AI 调用失败 N/M` · `💡 Reflection:` · `⚠️ 收尾被拒` · `⏹️ 运行状态保持为` · `⚠️ LLM 调用失败`)
  **没有**被误标 —— 防的就是"一把全吞换 0 命中"。
- **凭证不进现场**: 断言抓包里 key 原文 0 命中; 隔离 HOME 跑完即删。

## 5. 变异判红 (3 条, 每条都真跑一轮)

| 变异 | 结果 |
|---|---|
| M1 `isInternalRunLog` 恒 `false` (内部日志又透回回复流) | 门**必红** —— 回复流命中 **11 行** |
| M2 落盘行生成拿掉 (`internalRunLogLine` → `''`, 只静默不落盘) | 门**必红** —— 日志 `[运行]` 通道命中 **0** (搬走变成了删掉) |
| M3 把发送点 `🔄 开始 ReAct 循环...` 的 `internal: true` 拿掉 (回到"按内容猜") | 门**必红** —— 回复流命中 **4 行** |

变异是**改盘上文件 → 真跑 → 断言红 → 逐字节还原 (sha256 比对)**, 恢复失败也会判红。

## 6. 回复去冗余 (乔布斯式减法) 做到哪一步

| 减法 | 做法 | 状态 |
|---|---|---|
| 不预告再宣告 (先"我接下来要…"再"已完成…") | 内部推进过程 (循环/登记/收尾计数/目标对齐) 全部搬出回复流 —— 用户只在**有结论**时看到一条回复框 | ✓ 本轮 |
| 不复述工具输出 | `🔧 <工具> <耗时>` 工具行已在流里, 就不再单发一条 `✅ <工具> 执行成功`; 工具入参 dump (`📋 参数: {…}`) 也不再上屏 | ✓ 本轮 |
| 不复述用户请求 | 用户消息框 (`✓ 已发送`) 是唯一一次回显, 回复里不再重复请求原文 | ✓ (回复框里只有结论) |
| 不把思考过程当内容 | `💡 反思` 框**保留** —— 它是 leo 2026-08-07 点名要的"思考框", 属**有意保留**而非漏改 (见 §7) | 保留 (明确) |
| 能一句说清不用三句 | 内部门牌行 (登记/预算/剩余判据/收尾步数) 一律不进回复流; 需要时 `--verbose` 或翻日志 | ✓ 本轮 |

## 7. 刻意保留 / 未做 (逐条)

- **保留**: `💡 反思 (Reflection)` 思考框 —— leo 2026-08-07 明确要求的"思考过程可见", 与"内部运行日志"是两回事。
  想一起去掉是**另一个决定**, 改 `src/index.ts` 里 Reflection 分支即可。
- **保留**: 真失败/降级/需人介入的行 (`⛔ …仍失败` · `⚠️ AI 调用失败 N/M` · `⚠️ 收尾被拒` · `⏹️ 运行状态保持为…`) ——
  "错的东西不许一并吞掉"。
- **未动 (同类但不在本轮名册)**: 启动期的 `📚 自动整理完成 …` 整理结果框 (`src/index.ts` 的 organize-heartbeat 回调, `appendLine` 附近)
  —— 它属**启动面**, 且**紧邻另一条线正在改的启动面板区域**, 本轮按并行卫生不动它; 要搬走是同一套修法 (一行)。
- **未单独立门**: "回复文字的行数"没法稳定断言 (模型措辞每次不同) —— 用同任务前后真抓包的
  **内部运行日志行数 (8 → 0)** 与 **回复流唯一行数 (78 → 47)** 代替, 数字都给在 §4。
- **本轮真跑走 `npx tsx src/index.ts`**: `dist/` 未在本次重建 (另一条线同时在改 `src/cli/**`, 重建会把它的半成品带进产物);
  发布 `npm 0.5.1` 前**必须** `npm run build:main` 后复核。
- **未 push** (按纪律)。

## 8. 变更文件

| 文件 | 说明 |
|---|---|
| `src/cli/reply-hygiene.ts` (新) | 唯一判据 `isInternalRunLog` + 落盘行/落盘函数 `internalRunLogLine`/`appendInternalRunLog` (目的地走已有 `startupLogPath()`) |
| `src/agents/pi-sdk-types.ts` (改) | `StreamEvent.internal?: boolean` (语义 + 各面去处写在类型注释里) |
| `src/agents/pi-sdk.ts` (改) | 20 处内部运行日志 status 事件标 `internal: true` (只加字段, 不改文案/不改流程) |
| `src/index.ts` (改) | 回复流组装口的 status 分支: 认 `internal` → 落盘 + 仅 verbose 上屏 (2 处小改: import + 分支) |
| `src/test/reply-hygiene.test.ts` (新 15 条) | 判据语义 + 落盘行形状 + **发送点声明不许丢** (7 内部标记必须带 / 4 用户可见标记不许带) |
| `scripts/verify-reply-hygiene.ts` (新) | 真跑门: 源码级声明完备 + 默认 0 命中 + 日志对照 + verbose 召回 + 行数对比 + 3 条变异判红 |
| `scripts/fixtures/reply-hygiene/before-reply-stream.txt` (新) | 修复前真抓包里那 8 行内部运行日志 (阳性对照 + 行数对比的 before 一边) |

## 9. 复现

```bash
npx tsx scripts/verify-reply-hygiene.ts --only-source   # 秒级: 只看发送点声明 + fixture 阳性对照
npx tsx scripts/verify-reply-hygiene.ts                 # 全跑: 5 个真会话 (~3 分钟)
npx vitest run src/test/reply-hygiene.test.ts           # 15 条, 秒级
grep '\[运行\] ' "${BOLLOON_HOME:-$HOME/.bolloon}/logs/startup.log" | tail    # 看被搬走的行
```
