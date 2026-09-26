---
title: 模型切换 · P8 终验收口报告 (16 条逐条真跑 · 103 断言 · 5/5 变异判红)
source: session (leo 2026-09-26 P8 终验; 计划 docs/wiki/model-selection-protocol.md §9 验收矩阵; 前序门 verify-model-{selection,selector,registry,url-chain,discovery,policy,wiring,entrypoints}.ts)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [model, model-selection, provider, base-url, session-scope, run-snapshot, supervisor, config-store, migration, model-discovery, tool-calling, acceptance, verification, mutation-test, honest-report, p8]
---

# 模型切换 · P8 终验收口报告

**一句话**: 用户点名的 16 条模型切换验收, 在**当前集成树**上**逐条真跑** ——
**16/16 条目过 · 103/103 断言过 · 16/16 反事实对照符合预期**, 变异验证 **5/5 判红**
(每条都红在它该红的条目上); 全部模型调用打到**本地假上游** (**0 次真 LLM, 成本 0**),
没做到的逐条写在 [§5](#5-没做到--有保留逐条如实说)。

- **可重跑**: `npx tsx scripts/verify-model-acceptance.ts` (16 条全跑, 本机 **~44s**) ·
  单条: `… scripts/verify-model-acceptance.ts 7 12` · 变异: `python3 scripts/verify-model-acceptance-mutations.py`
- **凭据**: 假上游的 key 全是 `stub-*` 假值; 隔离 HOME 里**没有**机主真实配置/凭据; 报告与产物里**无真凭据** `[REDACTED]`。

---

## 1. 结果总表 (16 条逐条)

| # | 验收 (用户点名的) | 结果 | 断言 | 关键证据 (一句) | 反事实对照 (拿掉修复 → 该红) |
| --- | --- | --- | --- | --- | --- |
| 1 | CLI `/model` 从 A 切到 B, 下一次请求命中 B (不是同一家) | ✅ | 10/10 | 同进程切完真打请求 → `reply=pong:B:stubB-1` (A 这一轮 +0 笔); 真 CLI argv 进程两个方向各切一次都命中 | 旧行为 (只写配置不重建运行时) → 请求仍打 B (旧端点): `reply=pong:B:stubB-1` 而盘上已是 openai/stubA-1 |
| 2 | 同 provider 只切 model, 请求体里的 model 真变 | ✅ | 3/3 | 假上游逐笔记请求体: 换前 `model=stubB-1` → 换后 `model=stubB-2` (同一台 B、同一路径) | 换之前那一笔必须是旧 model (若两笔都新 = 字段不跟配置走, 空断言) |
| 3 | 自定义 base URL 指向本地 HTTP server, 请求真命中该地址 | ✅ | 6/6 | 非常规路径 + 尾斜杠 `/weird/path/v9/` → 命中 `/weird/path/v9/chat/completions`; A/B 两笔都没收到 | 同模型指到该地址上**没有的路径** → 探测判红 `invalid_url`, 盘上地址不变 |
| 4 | 错 key / 错 URL / 错 model / 畸形 URL **都不能**切换成功, 且盘上配置**字节不变** | ✅ | 7/7 | 四类各自真打假上游: `auth_failed`(401) · `provider_unreachable` · `model_not_found` · `invalid_url`; 四次失败前后 `sha256[:16]` 逐字相同 | 一次**正确**的切换必须让同一个 sha256 **变** (`d1fa2c48… → 7ea1bd5b…`) ⇒ 不是空断言 |
| 5 | CLI 与 Web 切换后读到**同一份**配置 | ✅ | 6/6 | 真 CLI 进程切 kimi@C → Web `GET /api/llm-config` 读出 kimi/stubC-1; Web `POST /api/llm-provider` 切 deepseek → 真 CLI `model status --json` 读出 deepseek/stubB-1 (三个进程 `configHash` 同值) | 放一份诱饵 `llm-config.json` (gemini/decoy-model) → 两个入口都**无视**它 |
| 6 | 重启 CLI 后仍生效 | ✅ | 5/5 | 两个**全新进程**各自读到 `kimi/stubC-1` + 同 `configHash`, 且真打请求命中 C | 会话级切到 openai 后新进程仍读全局 kimi (证明验的是"落盘"不是"上次选过什么") |
| 7 | Session 切换不改变 Global (别的会话不受影响) | ✅ | 8/8 | 会话级切换后全局配置 `sha256` 一个字节没变; 绑定写进 `model-sessions.json`; 别的会话仍读全局; 该会话真打请求命中 A | 同一个选择改用 `scope=global` → 全局 sha **必须变** (`499540dd… → 895f076e…`) |
| 8 | Global 切换影响新 Session | ✅ | 3/3 | 全新会话键读到新全局 `openai/stubA-2` + 请求体 `model=stubA-2` | 第 7 条留下的老会话仍读自己的绑定 (`stubA-1`, source=session) ⇒ 只影响**新**会话 |
| 9 | 长任务中途切默认模型 → 旧 Run **保留原配置快照** | ✅ | 7/7 | 执行中切全局后, 盘上 Run 记录 `modelConfig` 逐字段没变; `detectRunConfigDrift` 反过来证明"确实已漂"并点名 4 个字段 | 同一时刻重解析有效配置 = 新模型 (`cae096fd…`) ≠ Run 快照 (`f2cc1ef2…`) |
| 10 | 下一个 Run 用新模型 | ✅ | 4/4 | `resolveNextRunModel` 给 `source=global` → 按它真 `startRun`, 新 Run 快照 = `openai/stubA-1` | 新旧两条 Run 快照并排: `stubB-1` vs `stubA-1` (旧的一条字节没被改写) |
| 11 | Supervisor 恢复时继续用正确的 Run/Goal 模型策略 | ✅ | 7/7 | 真 `ExecutionSupervisor.tickOnce` (执行器注入) 交给执行器的 `req.modelConfig` = **pinned 固定那一份** `deepseek/stubB-1@B`, 且 `kind=resume`; 按快照装配后真打请求命中 B | 同一时刻按**当前全局**装配 → 命中 A (`openai/stubA-1`) ⇒ "用 Run 自己那份"不是自动成立的 |
| 12 | 两个进程同时切配置 → 不互相覆盖 | ✅ | 11/11 | (a) 屏障发令后两个**真进程**同时各切一家 → 两家改动都在; (b) 持锁进程占锁 900ms 期间并发切换 → 两边改动都在; (c) 并发切换实测**等锁释放等了 928ms** | 变异 M4 (锁空转 + 签名恒等) → (a) 丢一家 + (c) 只等 12ms ⇒ 两条真跑判决都判红 |
| 13 | 旧 `llm-config.json` 可迁移 | ✅ | 4/4 | 隔离 home 只放旧文件名 → 新进程读出 `deepseek/legacy-model-1@B`, 且迁移是**逐字节复制** (旧/新 sha 相同) | 同一份内容改名叫 `.bak` (不触发迁移) → 读到的是内置默认 `ollama/llama4` |
| 14 | provider `/models` 不可用时, **缓存与手动模型仍可用** | ✅ | 8/8 | 真把目录端点翻成 404: 失败被如实记 (`qwen:invalid_url`)、provider **没被静默删**(`unavailable` + 原因)、清单里仍有缓存模型 `live-m1` 与手输模型 `manual-m9` | 清掉发现缓存 + 上游仍 404 → `live-m1` **消失** (`origin=curated`) ⇒ 确实是缓存在兜 |
| 15 | 不支持 tool calling 的模型**被拒**于 Agent 执行 | ✅ | 7/7 | 切到"拒绝工具声明"的模型 → `failureClass=tool_call_unsupported` 且盘上字节未变; 注册表 `notoolgw` 不允许当长期任务执行器、不进 Supervisor 备用候选 | 同一台地址改成接受工具声明再切一次 → **成功** (若同样失败, 说明这条验收指错了对象) |
| 16 | 切换失败后旧模型仍可继续用 | ✅ | 7/7 | 错 model 被拒后: 同进程真打请求仍命中 B、**另起进程**也仍命中 B、盘上未变 | 手工模拟"失败但没回滚" (运行时指到死端口 + 不存在的模型) → 请求**失败**; 装回有效配置 → 又能命中 B |

**合计**: 条目 16/16 · 断言 103/103 · 反事实 16/16 · 真模型调用 **7 次**(全部 `POST …/chat/completions` → 本地假上游,
**非真 LLM**) · **真 LLM 调用 0 次 / 成本 0** · 单遍墙钟 **~44s**。

**这道门 vs 已有八道门**: 前一阶段每道门各管一段 (P0 选择入口 · P2 选择器 · P3 注册表 · P4 URL 链 · P5 发现与缓存 ·
P6 入口收敛 · P7 长任务策略 · 飞轮冻结门)。本门的主张不同: **把用户点名的 16 条端到端验收在当前集成树上逐条真跑**,
拿到"真进程 / 真 CLI argv / 真 HTTP / 真文件字节 / 真 Supervisor tick"级别的证据。
**"那道门绿过"不算数** —— 16 条每一条都在本次运行里重新跑过一遍并留了产物。

---

## 2. 逐条: 怎么做 · 真实输出摘录 · 产物 · 反事实

> 下面每一段都是本次运行 (`baseline` 一遍) 的原样摘录, 未做美化。完整输出见脚注里的重跑命令。

### 第 1 条 · CLI `/model` 从 A 切到 B, 下一次请求命中 B

- **怎么做**: ① 子进程里**先按旧配置装配好运行时**, 再走会话内 `/model` 切到 B, **同一个进程**里真打一次请求;
  ② 用**真 CLI argv 进程** (`bolloon model …` = `src/cli-entry.ts`) A→B→A 两个方向各切一次, 每次切换后另起进程真打一次。
  假上游把每笔请求 (路径 + 请求体 `model`) 都记下来。
- **输出摘录**:
  - `✅ 会话内 /model deepseek stubB-1 --base-url … 切换成功 — ✅ 已切换到 deepseek (model=stubB-1) — 全局默认 (新会话生效)`
  - `✅ **下一次请求命中 B** — reply=pong:B:stubB-1 · B chat +3 笔 · A chat +0 笔` · `✅ B 记下的请求体里 model=stubB-1 — path=/alt/v1/chat/completions`
  - `✅ 真 CLI 进程 bolloon model deepseek stubB-1 --base-url … 切换成功 (跨 provider)` → `✅ 切到 B 后下一秒请求命中 B — reply=pong:B:stubB-1`
- **产物**: `<隔离HOME>/.bolloon/bolloon-config.json (activeProvider=openai)` · B 的请求台账 `[{path:/alt/v1/chat/completions, model:stubB-1, authOk:true}]`
- **反事实**: 旧行为臂 (先按 B 装配 → 只写配置 + 换 activeProvider → **不重建运行时**) → `盘上有效配置=openai/stubA-1` 但
  `请求 reply=pong:B:stubB-1` ⇒ 复现了 P0 修掉的"切了不生效", 与修复后行为**相反**。

### 第 2 条 · 同 provider 只切 model, 请求体里的 model 真变

- **怎么做**: provider(baseUrl) 固定, 只把 model 从 `stubB-1` → `stubB-2`, 切换后真打一次; 用假上游**逐笔**的请求体对照。
- **输出摘录**: `✅ 切换后请求体里的 model 真的是 stubB-2 — reply=pong:B:stubB-2 · 上一笔 model=stubB-2` ·
  `✅ 盘上只有这一格变: providers.deepseek.model stubB-1→stubB-2, baseUrl 未变 — config sha=69d0288b…→5d0d0d33…`
- **产物**: `bolloon-config.json` 的 `providers.deepseek = {model: stubB-2, baseUrl: …/alt/v1}`
- **反事实**: 换之前那一笔请求体 = `stubB-1` (时间轴对照) ⇒ 该字段真跟配置走, 断言不空。

### 第 3 条 · 自定义 base URL 指向本地 HTTP server, 请求真命中该地址

- **怎么做**: 给内置供应商 kimi 配非常规路径 `/weird/path/v9/` (带尾斜杠) → 切 → 真打请求 → 读假上游 C 记下的**路径**;
  同时断言 A/B 一笔都没收到; 再用 P4 只读探测原语独立核一次 URL 解析。
- **输出摘录**: `✅ 带尾斜杠的自定义 URL 切换成功 (且被规范化) — effective.baseUrl=http://127.0.0.1:…/weird/path/v9` ·
  `✅ 命中的**路径就是自定义那条** /weird/path/v9/chat/completions` · `✅ A / B 两台一笔都没收到 (A +=0 B +=0)` ·
  `✅ 只读探测 … baseUrlSource=explicit toolCalling=yes (6 步: url✓ protocol✓ credential✓ connect✓ model✓ tool_call✓)`
- **产物**: C 的请求台账 `[{path:/weird/path/v9/chat/completions, model:stubC-1}]`
- **反事实**: 同一个模型指到该服务上**没有的路径** (`/no/such/path`) → 探测判红 `invalid_url`, 盘上地址一字未改
  ⇒ 不是"随便配个地址都能过"。

### 第 4 条 · 四类错误全拒 + 盘上配置字节不变

- **怎么做**: 先把默认落定 `deepseek/stubB-1@B` 并记下配置 `sha256`; 再连试四类错误 (每类**真打**假上游, 不是构造字符串)。
- **输出摘录**:
  - `✅ ① 错 key 被拒 (auth_failed) — 凭证被拒 (HTTP 401) — invalid api key [探测类目=auth_failed]`
  - `✅ ② 错 URL 被拒 (provider_unreachable) — 连接失败: fetch failed` · `✅ ③ 错 model 被拒 (model_not_found) — 目录里 3 个, 例: stubA-1…`
  - `✅ ④ 畸形 URL 被拒 (invalid_url) — 不是合法 URL: not-a-url`
  - `✅ 四次失败后: 配置字节未变 + 有效配置仍是 deepseek/stubB-1 — config sha=d1fa2c488f9e246e → d1fa2c488f9e246e`
  - `✅ 四类错误之后旧模型仍能真跑 — reply=pong:B:stubB-1`
- **产物**: `bolloon-config.json` `sha256[:16]=d1fa2c488f9e246e` (四次失败前后逐字相同); 正确切换后 `7ea1bd5b6134c510`
- **反事实**: 正确切换 → sha **必须变** (实测变了) ⇒ "失败后字节不变"不是空断言。

### 第 5 条 · CLI 与 Web 读到同一份配置

- **怎么做**: 真起 `express` + `registerLlmConfigRoutes` 的**真 HTTP 监听**; ① 真 CLI 进程切 kimi@C → 读 Web `GET /api/llm-config`;
  ② Web `POST /api/llm-provider` 切回 deepseek → 读真 CLI 进程的 `model status --json`; ③ 第三个进程 (子进程) 再读一次对照 `configHash`。
- **输出摘录**: `✅ Web 读到的 activeProvider = CLI 刚切的那一家 — web.activeProvider=kimi` ·
  `✅ 真 CLI 进程 model status --json 读到 Web 那次切换 — cli.effective=deepseek/stubB-1 web.effective=deepseek/stubB-1` ·
  `✅ 第三个进程读到的与 Web 返回的逐字段一致 — child hash=f2cc1ef2394d631c web hash=f2cc1ef2394d631c` ·
  `✅ 这条"同一份"配置是能真跑的 — reply=pong:B:stubB-1`
- **产物**: Web 真 HTTP `http://127.0.0.1:<port>` · 两个入口读的同一个文件 `<HOME>/.bolloon/bolloon-config.json`
- **反事实**: 放一份诱饵 `llm-config.json` (gemini/decoy-model) → 两个入口都**无视**诱饵 (仍报 deepseek/stubB-1)
  ⇒ "同一份"不是"随便哪一份"。

### 第 6 条 · 重启 CLI 后仍生效

- **怎么做**: 全局落到 kimi@C → 起**全新进程**读有效配置 (与父进程逐字段比, 含 `configHash`) → 再起第二个新进程复读; 再让新进程真打一次请求。
- **输出摘录**: `✅ 新进程 1 读到的与父进程逐字段相同 — child1=kimi/stubC-1 hash=6bbf221cf2c8edbd parent=同值` ·
  `✅ 再新起一个进程读 (第二次重启) 仍相同` · `✅ 新进程真打一次请求: 命中 C — reply=pong:C:stubC-1`
- **产物**: `<HOME>/.bolloon/bolloon-config.json (activeProvider=kimi, configHash=6bbf221c…)`
- **反事实**: 先做一次**会话级**切换 (只写会话绑定) 再起新进程 → 新进程仍读全局 kimi (source=global)
  ⇒ 这条验的是"重启后仍生效"的那一层 (全局), 没把会话绑定混进来。

### 第 7 条 · Session 切换不改变 Global

- **怎么做**: 全局定在 `deepseek/stubB-1@B` 并记字节; 用**另一个进程**做会话级切换 (scope=session → `openai/stubA-1`); 断言: 字节不变 · 绑定落
  `model-sessions.json` · **另一个会话**读到的仍是全局 · 该会话真打请求命中 A; 另试"会话级带凭证"必须被拒。
- **输出摘录**: `✅ **Global 配置文件字节一个都没变** — config sha=499540ddae8dc584 → 499540ddae8dc584` ·
  `✅ 会话绑定落在 model-sessions.json — sessions.sess-7={provider:openai, model:stubA-1, scope:session}` ·
  `✅ 绑定文件里没有 key 明文 — 含 stub-k-=false` · `✅ 别的会话不受影响 — sess-7-other=deepseek/stubB-1 source=global` ·
  `✅ 这个会话真打请求命中 A — reply=pong:A:stubA-1` · `✅ 会话级带凭证被拒 — credential_scope_conflict`
- **产物**: `<HOME>/.bolloon/model-sessions.json` (`sessions.sess-7={…}`)
- **反事实**: 同一个选择改用 `scope=global` → 全局 sha **变了** (`→ 895f076e6987e830`) ⇒ 有判别力。

### 第 8 条 · Global 切换影响新 Session

- **怎么做**: 全局切到 `openai/stubA-2` → 起**全新会话键**读有效配置 → 真打请求看请求体 `model`。
- **输出摘录**: `✅ 全新会话读到新的全局默认 (source=global) — fresh=openai/stubA-2` ·
  `✅ 新会话真打请求: 命中 A 且请求体里的 model 是新模型 stubA-2 — reply=pong:A:stubA-2`
- **产物**: `<HOME>/.bolloon/bolloon-config.json activeProvider=openai providers.openai.model=stubA-2`
- **反事实**: 第 7 条留下的老会话 (`sess-7` 绑 `stubA-1`) 再读 → 仍读自己的绑定 ⇒ Global 只影响**新**会话。

### 第 9 条 · 旧 Run 保留原配置快照

- **怎么做**: 取一份 Run 快照 → 真 `startRun` 建 Run (盘上记录) → 执行中把全局切到 A → 从**盘上**重读 Run 逐字段对照;
  再用 `detectRunConfigDrift` 反向核一次 (它必须**看得出**已经漂了)。
- **输出摘录**: `✅ 盘上这条 Run 的快照**逐字段没变** — 盘上快照={provider:deepseek, model:stubB-1, …, configHash:f2cc1ef2394d631c}` ·
  `✅ 反向校验看得出"现在已漂" — 变化的字段: provider, model, baseUrl, configHash` ·
  `✅ 当前有效配置是新的 (openai/stubA-1) —— 与 Run 快照并存, 两者各自可用` · `✅ 切完之后真请求命中新端点 A`
- **产物**: `<HOME>/.bolloon/runs/<runId>.json → modelConfig={…stubB-1…}` + `<HOME>/.bolloon/goals/<goalId>.json`
- **反事实**: 同一时刻重解析有效配置 = `openai/stubA-1 (cae096fd…)` ≠ Run 快照 `deepseek/stubB-1 (f2cc1ef2…)`
  ⇒ 若实现改成"读 Run 时现解析", 它就会等于新模型 (即漂移)。

### 第 10 条 · 下一个 Run 用新模型

- **怎么做**: 拿第 9 条那条 Run 当"上一条", 走 P7 唯一决定函数 `resolveNextRunModel` (Goal 没写策略 → 默认 `auto`) →
  按它的 `startRunModelConfig` 真 `startRun` → 从盘上读新 Run 的快照。
- **输出摘录**: `✅ 决定函数给出"用最新 Global" — next_run · mode=auto · source=global · 已换 · openai/stubA-1 (hash=cae096fd…)` ·
  `✅ 新 Run 的盘上快照就是新模型 — runId=… 新 Run 快照={openai, stubA-1, cae096fd…}` ·
  `✅ 两条 Run 的快照不同 (旧 Run 一个字节没被改写) — run1=stubB-1 vs run2=stubA-1`
- **产物**: `<HOME>/.bolloon/runs/<新runId>.json → modelConfig={openai/stubA-1}`
- **反事实**: 新旧两条快照并排不同 ⇒ "下一 Run 用新模型"真发生, 且没有顺手改写旧 Run。

### 第 11 条 · Supervisor 恢复时继续用正确的 Run/Goal 模型策略

- **怎么做**: ① 真 `ExecutionSupervisor.tickOnce` (执行器注入 —— 不出网, 但调度/决策/Run 装配全真路径), Goal 上写 `pinned` 策略固定 B;
  ② Goal `session` 策略且无绑定 → 决策必须冻在上一条 Run 的快照; ③ **恢复时真装配**: 另起进程按 Run 快照 `applyRunModelConfigToRuntime` 再真打请求。
- **输出摘录**: `✅ 建好一条可恢复的 Run (running → stalled) — goal.currentRunId=<runId>` ·
  `✅ Supervisor tickOnce 真跑了 且轮到了这条 Goal — tick=1 executed=[…] captured=1` · `✅ kind=resume` ·
  `✅ **交给执行器的模型 = pinned 固定的那一份** — req.modelConfig={deepseek/stubB-1@…, selectionScope:run} · 此刻全局=openai/stubA-1` ·
  `✅ session 策略且无会话绑定 → source=run_snapshot · 冻结` · `✅ 恢复后真打请求**命中快照那台 B** — reply=pong:B:stubB-1`
- **产物**: `<HOME>/.bolloon/goals/<goalId>.json (modelPolicy=pinned)` + `<HOME>/.bolloon/runs/<runId>.json`
- **反事实**: 同一时刻按**当前全局**装配 → `reply=pong:A:stubA-1` (命中 A) ≠ 按快照恢复命中的 B ⇒ 这条不是自动成立的。

### 第 12 条 · 两个进程同时切配置 → 不互相覆盖

- **怎么做**: (a) **屏障发令**后两个真进程在**同一瞬间**各切一家 (deepseek/openai), 各写各的 model, 然后读盘;
  (b) 一个进程持跨进程锁做 read-modify-write (中间故意停 900ms), 同时父进程再切第三家;
  (c) **互斥的直接判决**: 持锁进程在临界区里落"我正持锁"标记, 父进程在窗口里发起切换 —— 它必须**等锁释放**才可能写完。
- **输出摘录**: `✅ (a) 两个真进程都在屏障上就位 (真并发, 不是先后跑) — p1.ready=true p2.ready=true` ·
  `✅ (a) 进程 1 的改动活着 (race-b)` + `✅ 进程 2 的改动活着 (race-a)` · `✅ (b) 持锁进程写的 kimi 改动活着` +
  `✅ 并发的 qwen 改动没有被对方的陈旧快照覆盖` ·
  `✅ (c) 并发切换**必须等到锁释放之后**才写完 (实测等待 928ms) — 父进程写完 < 对方临界区结束`
- **产物**: `<HOME>/.bolloon/bolloon-config.json → deepseek=race-b openai=race-a activeProvider=deepseek`
- **反事实**: 变异 M4 (**`withConfigLock` 空转 + 配置签名恒等**) 下同一道门真跑 → 红项含第 12 条:
  `❌ (a) 进程 2 的改动活着 — providers.openai.model=stubA-1` + `❌ (c) … 实测等待 12ms`
  ⇒ 两条真跑判决都对互斥机制敏感 (不是靠"反事实位"空红)。

### 第 13 条 · 旧 `llm-config.json` 可迁移

- **怎么做**: 另开一个隔离 home, **只**写一份旧文件名 `llm-config.json` (deepseek/legacy-model-1@B), 起**全新进程**读有效配置。
- **输出摘录**: `✅ 迁移真发生 — exists=true [config-store] 已迁移 llm-config.json → bolloon-config.json` ·
  `✅ 迁移是**逐字节复制** — sha 旧=887058f66ec7b3a3 sha 新=887058f66ec7b3a3` ·
  `✅ 新进程读到的有效配置 = 旧文件里那一份 (deepseek/legacy-model-1@B)` · `✅ 迁移读回的有效配置里没有 key 明文`
- **产物**: `<隔离HOME>/.bolloon/bolloon-config.json` (由 `llm-config.json` 迁移而来, sha `887058f6…`)
- **反事实**: 同一份内容改名叫 `llm-config.json.bak` (不触发迁移) → 读到内置默认 `ollama/llama4` ⇒ legacy 值确实来自迁移这条链。

### 第 14 条 · `/models` 不可用时的缓存与手动模型

- **怎么做**: 先把 qwen 指到假上游 E (目录端点正常) → 真取一次目录 + 手输一个目录里没有的模型 → **把 E 的目录端点翻成 404**
  (真 404) → 再真取一次 + 列目录: 看缓存模型、手输模型、以及这家 provider 还在不在列表里。
- **输出摘录**: `✅ 目录端点正常时真取到上游清单 — origin=live models=live-m1` · `✅ 手输模型记进发现缓存 — manual-m9` ·
  `✅ 目录端点 404 时: 失败被如实记下 — ["qwen:invalid_url"]` ·
  `✅ **provider 没有被静默删掉** — discoveryState=unavailable keptDespiteFailure=true reason=端点不存在 (HTTP 404)` ·
  `✅ **缓存里的模型仍可用** — origin=cached models=live-m1,manual-m9` · `✅ **手输的模型仍可用** — manualModels=["manual-m9"]` ·
  `✅ 缓存被清干净 + 上游 404 时, 手输模型仍能再记进去 — models=[manual-m9, qwen3-max, …]`
- **产物**: `<HOME>/.bolloon/model-discovery-cache.json` (qwen 桶 `models=[live-m1, manual-m9]`)
- **反事实**: 清掉发现缓存 + 上游**仍是** 404 → `live-m1` **消失** (`origin=curated`) ⇒ 上面"仍可用"确实是缓存在兜。

### 第 15 条 · 不支持 tool calling 的模型被拒

- **怎么做**: 假上游 D 对"带工具声明的请求"回 400 (明确说不支持 tools); 走统一入口切到 `glm/no-tool-model@D`;
  再查注册表: 未声明工具调用能力的自定义供应商不得当长期任务执行器, 且不进 Supervisor 备用候选。
- **输出摘录**: `✅ 切到"拒绝工具声明"的模型被拒 — failureClass=tool_call_unsupported · 工具调用能力确认失败 — 不接受工具调用声明 (HTTP 400)` ·
  `✅ 被拒后盘上配置字节未变 — config sha=2017f4966f2426bf → 同值` ·
  `✅ 注册表: notoolgw (toolCalling=no) → allowsLongRunningExecutor=false 且会给理由` ·
  `✅ 注册表: toolgw (toolCalling=yes) → true (不是"一律拒绝")` · `✅ canServeLongRunningTasks: notoolgw=false, toolgw=true` ·
  `✅ Supervisor 备用候选里不会出现那家 — 候选=[openai/race-a, deepseek/race-b, kimi/…, glm/no-tool-model, toolgw/stubA-1]`
- **产物**: 探测逐步事实 `[url]✓ [protocol]✓ [credential]✓ [connect]✓ [model]✓ [tool_call]✗`
- **反事实**: 同一台地址改成**接受**工具声明再切一模一样的一次 → `ok=true` ⇒ 拒绝的原因确实是工具调用能力。

### 第 16 条 · 切换失败后旧模型仍可继续用

- **怎么做**: 基线 `deepseek/stubB-1@B` → 做一次会失败的切换 (错 model) → 断言: ① 同进程真打请求仍命中 B; ② **另起进程**也仍命中 B;
  ③ 盘上配置未变。
- **输出摘录**: `✅ 一次会失败的切换: 错 model 被拒 (model_not_found)` ·
  `✅ 失败信息明确说"旧配置仍生效" — 切换未生效 (探测失败, 配置与运行时保持原样)` ·
  `✅ ① 失败后**同进程**真打请求仍命中 B — reply=pong:B:stubB-1` + `✅ ② 另起进程也仍命中 B` ·
  `✅ ③ 盘上配置未变 + 有效配置仍是旧的那一份 — sha 同值`
- **产物**: `bolloon-config.json` (失败前后同 sha) + 假上游 B 的新一笔真请求
- **反事实**: 手工把运行时指到那个被拒的候选 (死端口 + 不存在的模型) 模拟"失败但没回滚" → 请求**失败**
  (`connect ECONNREFUSED 127.0.0.1:9`); 按有效配置装回去 → 又命中 B ⇒ "旧模型仍可用"是回滚换来的, 不是自动的。

---

## 3. 变异验证 (门是否承重): **5/5 判红**

`python3 scripts/verify-model-acceptance-mutations.py` —— 每条变异都先证明**盘上 hash 真变了**, 再真跑整道门;
门判绿就算失败 (门不承重)。跑完从内存原文写回 (`git diff` 空)。

| 变异 | 改坏了什么 | 判红 | 红项条目 | 摘录 |
| --- | --- | --- | --- | --- |
| M1 | CLI `/model` 切完**不重建运行时** (P0 那个缺陷原样复现) | ✅ | **[1]**, 2, 3, 4, 5, 9, 16 | `❌ **下一次请求命中 B** — reply=undefined · B chat +2 笔 · A chat +0 笔` |
| M2 | 探测失败**不再拦** (错 key/URL/model 一律当成功写盘) | ✅ | **[4]**, 3, 15, 16 | `❌ 四次失败后: 配置字节未变 — sha=703400e0… → 9b688bf8… · 生效=openai/no-such-model-xyz` |
| M3 | 会话级切换**把全局也一起写了** (作用域被吞) | ✅ | **[7]** | `❌ **Global 配置文件字节一个都没变** — sha=e38888a2… → 397913c3…` |
| M4 | 跨进程互斥两条机制一起拿掉 (锁空转 + 签名恒等) | ✅ | **[12]**, 5 | `❌ (a) 进程 2 的改动活着 — providers.openai.model=stubA-1` · `❌ (c) 实测等待 12ms` |
| M5 | "不接受工具调用声明"不再归类为 `tool_call_unsupported` | ✅ | **[15]** | `❌ 切到"拒绝工具声明"的模型被拒 — failureClass=protocol_mismatch` |

- 每条变异都**红在它该红的条目上** (加粗), 且判红来自**真跑出来的红项**而不是"反事实位没填"
  (变异脚本给被测门设 `BOLLOON_ACCEPTANCE_M4_RED=1`, 让第 12 条的反事实位**通过**, 红必须从真跑检查里出)。
- M4 第一次跑时第 12 条的并发臂 (a) 受调度抖动影响**没红**(只红了第 5 条) → 因此补了 **(c) 互斥时序判决**
  (持锁 900ms 的窗口 + 实测等待), 现在 M4 下 (a) 与 (c) 都判红。**这是本轮的一处如实修正**。

---

## 4. 成本 / 凭据

- **真 LLM 调用 0 次, 预估成本 0**。16 条里的"真请求"全部打到 `scripts/verify-model-acceptance.ts` 里现起的
  **本地假上游** (5 台: A `/v1` · B `/alt/v1` · C `/weird/path/v9` · D 拒工具声明 · E 目录端点可翻 404), 真 HTTP、
  真 `/v1/models`、真 `/v1/chat/completions`、真 401/400/404。
- 门自己统计并打印: `模型调用 (真 HTTP 打到本地假上游, **非真 LLM**): 7 次 · 成本 0`。
- 假上游的 key 全是 `stub-k-*` 假值; 隔离 HOME 里没有机主真实配置/凭据 (**没有**用 `makeSetupReady` 复制真配置进来);
  报告与产物里**无真凭据** `[REDACTED]`; 假上游只记录 `authOk:true/false` 与路径/model, **不记 key 值**。
- 单遍墙钟 **~44s** (16 条 + 真 CLI 子进程 3 次 + 子进程 ~20 次); 变异套件 5 条 ≈ **4 分钟**。

---

## 5. 没做到 / 有保留 (逐条如实说)

1. **没有真 LLM 参与**: 16 条全部用本地假上游 ("非真 LLM")。没有用真供应商凭据跑过一句真模型的对话 ——
   本门要验的是"配置/运行时/快照/作用域/恢复策略"的链路事实, 假上游能把"命中了哪台、请求体里 model 是什么"逐笔记死;
   真 LLM 能多验的是"生成的 token 确实来自新模型", 本轮**没验**。
2. **第 5 条的 Web 侧**是同进程真 `express` + 真 `registerLlmConfigRoutes` + **真 HTTP 监听**, **不是**完整
   `src/index.ts --web` 引导 (身份/kubo/IPNS 那层没跑) —— 与 P6 门的口径一致; 完整 `createWebServer` 的入口一致性由
   `verify-model-entrypoints.ts` (59/0, 冷启动 ~114s) 覆盖。
3. **第 11 条的 Supervisor 用注入执行器** (不出网, 只回 `blocked`): 调度/决策/Run 装配/策略挑选全真, 但"真 LLM 被唤醒后
   真按 pinned 模型跑一轮"这最后一步没跑。
4. **第 11 条为让 Goal 有"继续的资格", 给那条 Run 补了一条可核验证据**: 飞轮接线 (冻结门
   `goal-flywheel-wiring-freeze.test.ts`) 的规则是"本轮有新证据才有继续的资格", 没证据的运行会被判 `needs_decision`、
   不自动唤醒。这一步与模型策略无关 (策略断言在别处), 但**它是为了让门能跑到恢复路径而加的前提**, 如实记下。
5. **Goal 创建用了 `BOLLOON_SETUP_IN_PROGRESS=1`**: 隔离 home 没有 `bolloon setup` 的引导状态, `createGoal` 的初始化
   硬门禁会拦。用的是代码里**已经有**的那个旁路开关 (与 setup 向导同一条), **不是**把机主真实 LLM 配置/凭据复制进来
   (那会引入真凭据, 也会换掉本验收自己的基线配置)。
6. **第 12 条的反事实臂是外部的**: (a)/(b)/(c) 三条判决都在门内真跑, 但"把互斥机制拿掉会怎样"这件事由
   变异脚本 M4 提供 (门内只留一个显式指向它的反事实位, 由环境变量填)。第一次跑 M4 时第 12 条的并发臂没红
   (调度抖动), 补 (c) 之后才稳定判红 —— 这条抖动如实记在这里, 不假装 (a) 一直是敏感的。
7. **第 6 条用"新进程"验重启**, 没有真重启 REPL/TUI (ink 界面); 差别只在"重启"是不是要人按键那一步。
8. **第 12 条 (a) 的并发**用屏障发令把两个真进程对齐到同一瞬间, **不是**靠 sleep 猜时机; 但进程内锁竞争的极端交错
   (同一毫秒内多次写 + 陈旧锁回收) 未穷举。
9. **未验**: 真 Web UI 点击切模型 (DOM 层) · 真 REPL 按键 `⌨` · Anthropic/Gemini **原生协议形状** (假上游只覆盖
   OpenAI 兼容 `/v1/models` + `/v1/chat/completions`) · 真断网/真限流下的发现回退 (第 14 条用的是"目录端点 404") ·
   模型切换与更新系统 (双源) 的交互 · 多机 (跨机器) 配置一致性 (本门的"两进程"都在同一台机器同一份 HOME 下)。

---

## 6. 怎么重跑

```bash
# 1) 16 条逐条真跑 (本机 ~44s)
npx tsx scripts/verify-model-acceptance.ts

# 2) 只跑指定条目 (调试用)
npx tsx scripts/verify-model-acceptance.ts 1 4 7 12 15

# 3) 变异验证: 门是否承重 (5 条各真跑一遍门, ~4 分钟)
python3 scripts/verify-model-acceptance-mutations.py
#    只跑某一条
python3 scripts/verify-model-acceptance-mutations.py --only M4

# 产物
#   <系统临时目录>/bolloon-model-acceptance-<rand>/model-acceptance-report.json   (逐条 JSON: 断言 · 反事实 · 产物路径)
#   隔离 HOME: <上面那个目录>/home/  (runs/ goals/ model-sessions.json model-discovery-cache.json …)
```

- 门**自清**: 每次跑都新建隔离 HOME + 随机端口假上游, 结束关掉全部 server, 不动机主真实 `~/.bolloon`。
- 退出码: 0 = 16 条全过 (`条目 16/16 · 断言 N/N · 反事实 M/M`); 非 0 = 有红项 (末行列出红项与证据)。
- `BOLLOON_ACCEPTANCE_M4_RED=1` 只影响第 12 条那个"外部反事实位"的显示, 不影响任何真跑判决。

---

## 7. 关联

- [model-selection-protocol.md](./model-selection-protocol.md) — 模型选择协议 (统一入口 + 有效模型配置 + 每 Run 快照 + 验收矩阵)
- [goal-model-policy.md](./goal-model-policy.md) — P7 长期任务 / Supervisor 模型策略
- [model-discovery.md](./model-discovery.md) — P5 发现与缓存 (回退链 · 不静默删 provider)
- [provider-registry.md](./provider-registry.md) — P3 注册表 (含"是否允许当长期任务执行器")
- [model-url-chain.md](./model-url-chain.md) — P4 探测原语与失败七类
- [verify-model-acceptance.ts](../../scripts/verify-model-acceptance.ts) · [verify-model-acceptance-mutations.py](../../scripts/verify-model-acceptance-mutations.py) · [model-acceptance-child.ts](../../scripts/lib/model-acceptance-child.ts)
