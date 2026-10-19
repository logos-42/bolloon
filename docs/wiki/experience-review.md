---
title: 回合后复盘 → 经验沉淀库: 从「368 次触发 0 条落库」到两条根因修通 (reply 字段 + 空回复重问)
source: session (leo 2026-10-19 「经验 ❌ 从未成功」+ experience-review.log 实况取证)
created: 2026-10-19
last_confirmed: 2026-10-19
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [experience, review, post-turn, pi-sdk, chat-result, reply-field, empty-reply, retry, minimax, glm, acceptance, mutation]
---

# 回合后复盘 → 经验沉淀库

**口径 (leo 2026-10-19)**: 「经验 ❌ 从未成功」—— 复盘机制跑了 160+ 次, `~/.bolloon/experience/`
目录根本不存在, 一条经验都没落过库。本页记实况取证、两条独立根因、修法与验证边界。

## 1. 实况取证 (先看日志, 不看叙述)

`~/.bolloon/logs/experience-review.log` (2026-10-01 起, 37,246 字节; 已登记 manifest
`experience-review-log-20261001`, 副本 `.bolloon/logs/experience-review.log`) 的逐行统计:

| 日志行 (原文) | 次数 | 含义 |
|---|---|---|
| `开始(换了任务 ⇒ 立刻复盘)` | 368 | 复盘被触发 |
| `审了但没写: 没找到 JSON(模型原文头部: )` | 117 | **原文头部全是空的** |
| `没审: 回合太短, 不值得审` | 40 | 正常不审 (摘要 < 40 字符) |
| `审查超时(25000ms) …` + `没审: chat-timeout` | 7 | 超时放行 (2026-10-01 既有设计) |
| `审了但没写: 没找到 JSON` (无原文头部) | 3 | 早期版本旧行 |

**已沉淀经验 0 条**。用户最初的归因 (「glm-5.3-flash 对这个提示词持续返回空 content」) 只对了一半 ——
见下面两条根因, 空回复有两条独立来路, 第一条与模型无关。

## 2. 根因: 两条独立病因 (不是一条)

### 病因 A (主因): chat 包装取错字段 —— 对 ChatResult 永远解出空串

复盘挂点 (`src/agents/pi-sdk.ts` 的 `runExperienceReview({ chat: … })`) 原来是:

```ts
const r: any = await getMinimax().chat(prompt);
return typeof r === 'string' ? r : String(r?.content ?? r?.text ?? '');
```

`getMinimax().chat()` 返回的是 **ChatResult**, 真字段是 `reply` (`src/llm/pi-ai.ts:359`);
`content` / `text` 在 ChatResult 上**根本不存在** ⇒ 无论模型回了什么, 这里都解出 `''`
⇒ 日志里 117 次「模型原文头部」**全是空的** —— 这是取值 bug 的**必然结果**,
**不能**据此反推「模型 117/117 空回复」。(正确写法的参照: `src/cli/session-summary.ts:125`
就是 `reply ?? content ?? text`。)

### 病因 B: 复盘直连 chat, 不在 pivot loop 的空回复打回面上

复盘是纯旁路 (fire-and-forget), 走 `getMinimax().chat(prompt)` **直连** —— 不经过
`workflow-pivot-loop`, 于是 2026-10-13/10-19 刚修的**空回复打回机制**覆盖不到这条路:
`evaluateQuality` 空/纯空白一律 0.3 分打回重跑 (2026-10-13) · 异常出口共用
`finalResponseOrFallback` 绝不返回空 (2026-10-19)。就算模型真的给空 content, 复盘也没有补救,
只能 `parseReviewDecision('')` → `action:'none'` → **冒充「无需记录」**。

## 3. 修法 (两处, 各治一条病因)

### 3.1 取值修对 (治病因 A) — `src/agents/pi-sdk.ts`

复盘 chat 包装改为 **`reply` 优先**, `content`/`text` 兜底 (兼容字符串返回):

```ts
if (typeof r === 'string') return r;
return String(r?.reply ?? r?.content ?? r?.text ?? '');
```

### 3.2 空回复重问 + 如实记录 (治病因 B) — `src/agents/experience-review.ts`

- 新增纯函数 **`buildReviewRetryPrompt(turnSummary)`**: 更短更聚焦的**轻量重问提示词** ——
  仍只回一个 JSON, 但任务收窄成「一句话: 这回合有没有值得记的」, 并把「必须给出 JSON, 不要空着」说在前面。
- `runExperienceReview` 编排改为: 首轮回复空/纯空白 ⇒ 换重问提示词**再问一次**
  (两次调用各自带 25s 硬超时, 绝不让复盘拖住主回合) ⇒ 仍空 ⇒ **如实**返回
  `reason: '模型返回空内容'` 并落一行日志 —— 不冒充 `action:'none'` 的「无需记录」。
- 纪律不变: fire-and-forget · 只写 `~/.bolloon/experience/` (不碰主对话/prompt 缓存) ·
  任何一步失败只记日志, 不影响本回合结果。

## 4. 验证 (2026-10-19)

| 项 | 结果 |
|---|---|
| 聚焦测试 `src/test/experience-review.test.ts` | **22/22 绿** (含新增 4 条) |
| 新增 ① 首轮空 → 自动换提示词重问 → 落库 | ✓ (断言: 重问恰好 1 次 · 提示词确实变了 · 更短 · 仍要 JSON) |
| 新增 ② 重问后仍空 → 如实记录且零写入 | ✓ (`reason='模型返回空内容'` · 日志含该行 · 库目录都不建) |
| 新增 ③ 重问提示词纯函数性质 | ✓ (比首轮短 · 含 JSON · 带摘要 · 空摘要不抛) |
| 新增 ④ 源级反回归 | ✓ (pi-sdk 里必须 `r?.reply ?? r?.content` —— 删掉即红) |
| `npx tsc --noEmit` | 0 错 |
| `python3 scripts/raw_manifest_check.py` | OK (v2 18 列, 日志副本登记) |

**变异对应**: 把 `r?.reply ??` 删掉 ⇒ ④ 红; 去掉重问分支 ⇒ ①/② 红。

## 5. 仍存在的边界 (如实)

- 「模型对复盘提示词持续空 content」这条病因**只在取值修通之后才可测** —— 117/117 全空此前是
  取值 bug 的必然结果; 重问机制是**防御**, 不是已证实的需求。修通后若仍高频空, 才该回到模型侧
  (换模型/降 temperature/加 purpose 标签)。
- 复盘仍只做「回合摘要 + 库目录」的纯文本判断 (v1 无工具), 未改。
- 未接: 经验条目写进 `~/.bolloon/experience/<类>.md` 后的**再消费** (注入提示/召回) 仍是
  `onLesson` 那条只记候选的线, 不自动改技能。
