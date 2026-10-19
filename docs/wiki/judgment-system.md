---
title: 判断力系统全景: 注入三条路 + 演化四层 + 三个缺口补齐 (D-hook 接 CLI / evolve 留痕 / 节流 key)
source: session (leo 2026-10-19 「判断力有没有注入 prompt / 有没有自动升级机制」「继续深挖并且补缺口」+ 本机实况取证)
created: 2026-10-19
last_confirmed: 2026-10-19
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [judgment, injection-gate, negative-guard, evolve, detect-hook, adaptive-scan, causal-judge, monitor-gate, dhook, acceptance]
---

# 判断力系统全景: 注入 / 演化 / 缺口

**口径 (leo 2026-10-19)**: 「判断力部分有没有注入 prompt？有没有自动升级和更新机制」→ 深挖后
「继续深挖并且补缺口」。本页记全景图谱、本机实况、三个缺口的补法。

## 1. 注入 prompt — 有, 三条路都在主路径上 (本机在跑)

| 注入路径 | 挂点 | 形态 |
|---|---|---|
| **判断力注入门** `injectJudgmentGate` | `pi-sdk.ts` 三入口全调 (`prompt`:1359 · `promptStream`:1554 · `promptWithPivotLoop`:1992 → `computeJudgmentGate`:626) | Top 3 相关原则拼 systemPrompt 尾部 (:2063); `maxChars` 背压动态 (high 800 / medium 1500 / low 1800, `exhaust-scrubber.ts`) |
| **负向避免清单** `injectNegativeGuard` | `pi-sdk.ts:648`; 同时是 `deny-pipeline.ts` 工具拒绝链第 4 层 | reject + stakes high/critical + confidence ≥0.7, maxChars=300 |
| **channel 绑定判断力** `buildJudgmentHint` | `server.ts:5079/6792/913` (Web/远端访客) | channel 的 `judgment_ids` 注入 |

**运行证据**: `usage.jsonl` 774KB, 最后写入取证当日 10:39 (`usedIds` 实值, 含正/负极性记账) —— 注入门在真跑。

## 2. 自动升级/更新 — 机制四层, 自动度分层说

| 机制 | 位置 | 自动度 | 本机实况 (2026-10-19 取证) |
|---|---|---|---|
| **D-hook 自动捕获** `detectIfWorthStoring → distillFromConversation → storeHumanJudgment → evolveNewJudgment` | `detect-hook.ts`; 触发点: `server.ts:5524` (web 消息, 5min/channel 节流) + `routes-judgments.ts:198` (手动端点) | 自动入库 (confidence ≥0.75 + 24h 滑窗去重) | `judgments.json` 最后写入 **10-02**; **CLI 主路径没有挂点** (缺口 ①, 已补) |
| **入库即演化** `evolveNewJudgment` (jaccard >0.85 直接 merge / 0.3-0.85 送 LLM 判 merge·contradict·unrelated) | `evolve-judgment.ts` | 自动 (60s/channel debounce) | 9 条 superseded **全是 07-06 一批** (decision 即 `batch a/b`, 疑似当年夹具), 之后 3.5 个月无演化动作留痕 (缺口 ②, 已补) |
| **自适应扫描** `runAdaptiveScan` (usage 驱动找 stale/unused/rising → 建议) | `adaptive-scan.ts` + `bootstrap.ts` (启动 + 24h 定时) | **只出建议不自动改库 —— 有意设计** (类 B 边界防越权; accept 走 Web `adaptive-apply`, 自动路径另有 `BOLLOON_AUTO_EVOLVE_DATA` 策略门, 默认关) | 每次启动扫 64 条原则 / 3159 条使用 → 96 条建议; `evolution.jsonl` 1735 条全是扫描记录 |
| **回复后合规审计** `monitorAfterReply` | `monitor-gate.ts`, `pi-sdk.ts:1739` fire-and-forget | 自动 (只记违规) | 在跑 |
| **反事实审计** `causal-judge` | `causal-judge.ts` + HTTP 4 端点 | 自动 | `counterfactual-audit.jsonl` 214KB 当天还在写 |
| **复盘经验回流** | `pi-sdk.ts:1462` `storeHumanJudgment(source:trajectory)` | 自动 (2026-10-19 修通复盘后才真正供血) | 库里 2 条 trajectory 来自 `decision-store` reflect, 非复盘 |

**库实况**: 64 条 (53 active / 9 superseded / 2 rejected); source: explicit 57 · implicit 5 · trajectory 2。

## 3. 三个缺口/bug 与补法 (2026-10-19)

### ① D-hook 未接 CLI 主路径 (捕获腿静默的主因) — 已补

`detectAndDistillFromChannel` 原先只有 web 消息路径和手动端点; 用户主力在 CLI ⇒ 捕获腿 17 天零写入。
补法: `pi-sdk.ts` 回合收尾 (复盘挂点旁) fire-and-forget 跑同一条 D 路径 —— `throttleDHook(channelId)`
5min 节流 (**与 web 路径共用同一张节流表**, 双路径不重复触发), confidence≥0.75 + 24h 去重都在
`detectAndDistillFromChannel` 内部; 结果如实落 `~/.bolloon/logs/judgment-dhook.log`, 不进回复流, 不阻塞本回合。

### ② evolve 动作无留痕 — 已补

`evolution.jsonl` 是设计中的 audit/回滚源, 但旧实现只有 adaptive-scan 启动扫描记录 (1735 条全是
`bootstrap-startup`), `evolveNewJudgment` 的 merge/supersede/contradict 只 return 给调用方。
补法: `evolveNewJudgment` 收尾写 `logEvolution` —— 合成 suggestion 沿用 bootstrap/adaptive-apply 惯例
(`key: 'evolve:<newId>'` 可检索, kind 占位, reason 带 `merged=N contradicted=N unrelated=N llmCompared=N supersededIds=…`);
无 merge 且无 LLM 比对时**不写** (防噪音)。留痕失败静默, 绝不影响演化本身。

### ③ evolve 节流 key bug — 已修

`evolveNewJudgment` 从 `context.channelId` 读节流 key, 而 detect-hook 存的是 `context.domain='channel:<id>'`
(没有 channelId 字段) ⇒ **debounce 永不生效**, 每次 D 存储都全量 jaccard 扫库 + 可能调 LLM。
补法: 新增 `channelKeyOf()` 归一化 (channelId 优先, `domain` 的 `channel:` 前缀次之), 两种形状都认。

### 边界 (如实, 不补的部分)

- adaptive-scan 建议**不自动落地是设计**, 不是缺口: 类 B 边界 (不自动改库防越权) + 自动路径有策略门。
  补的是**可见性**: bootstrap 启动扫描行带上 kind:action 分布与处理入口 (走 `[bootstrap]` 内部通道落
  startup.log, `--verbose` 可见), Web 面板 📊自适应 与 `POST /api/judgments/adaptive-apply` 不变。
- 演化留痕走 `action:'accept'` (系统自动语义), 与用户在 UI 的 accept/reject 不区分 action 字段,
  靠 `key` 前缀 `evolve:` 区分 —— 若将来要在 UI 里分开渲染, 再加专用 kind。

## 4. 验证 (2026-10-19)

| 项 | 结果 |
|---|---|
| 聚焦测试 `judgment-evolve.test.ts` (新) | 留痕可检索 + 无动作不写 + 节流不碰库不写留痕 + `channelKeyOf` 纯函数 + 源级反回归 (pi-sdk 必须挂 D-hook) |
| 存量判断力测试 (distill / injection-gate) | 回归绿 |
| `tsc --noEmit` | 0 错 |
| LLM 纪律 | 夹具要么 jaccard>0.85 (纯 merge) 要么 <0.3 (unrelated), 单测零真 LLM |

**变异对应**: 删掉 evolve 收尾的 logEvolution 块 ⇒ ① 红; 还原 `channelKeyOf` 为只读 channelId ⇒ ② 红;
删掉 pi-sdk 的 D-hook 块 ⇒ ③ 红。
