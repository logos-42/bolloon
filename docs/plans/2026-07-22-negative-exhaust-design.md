---
title: 负向回收 + 上下文废气涡轮增压 设计
source: session
created: 2026-07-22
last_confirmed: 2026-07-22
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [judgment, negative-recycle, turbocharger, backpressure, exhaust-scrubber]
---

# 负向回收 + 上下文废气涡轮增压 设计

## 背景

Bolloon 当前是"正向沉淀"架构: summary 回注、judgment 注入、crystallized-claims 全是赢家通吃。两类"废料"没被再利用:

- **上下文废料**: session-window dropped / memory-compressor skipped / compaction stage drops / context truncation → 只 `console.warn` 排走
- **判断力废料**: `rejected` / `reject` 类 judgment → 只标记降权, 不再利用

用户要求: 负向设计 + Web 判断力页面简化为正向/负向两类 + 上下文废气隐式设计, 锚点 = 涡轮增压。

**拍板 (2026-07-22)**:

| 通道 | 进 prompt? | 形态 | 可见性 |
|---|---|---|---|
| 判断力负向回收 (设计 B) | ✅ 进 (约束语义) | "避免清单" | 显式 (Web 负向 tab + 徽标) |
| 上下文废气回收 (设计 C) | ❌ 不进 | 压力信号调参 + 落 log/memory | 隐式 (背压表可选) |

## 思想锚点: 涡轮增压落地映射

| 物理部件 | Bolloon 对应 | 现状 |
|---|---|---|
| 排气 (废气) | session-window dropped / memory-compressor skipped / compaction stage drops / context truncation | 已产生, 只 `console.warn` 排走 |
| 涡轮 (回收装置) | 新增 `exhaust-scrubber.ts`: 采样丢弃事件聚合"背压" | 不存在, 新建 |
| 中冷器 + 进气增压 | 背压反向调进气侧参数: 压缩阈值 / 检索 top-k / judgment 注入 maxChars | 不存在, 接入 |
| 燃烧室 (prompt) | agent systemPrompt | 废气**不进**这里 (保持精准), 只让压力调参 |

核心原则: **智能体要精准, 废气不进 prompt; 但废气产生的压力有用 — 用来调进气侧的"增压量"。**

## 设计 A: Web 判断力页面简化为「正向 / 负向」两类

现状 (`index.html` `judgments-modal`): 2 scope tab (本channel/全局) + 6 status filter (全部/活跃/已过时/违规/自适应/因果分析) + 复杂表单 → 杂乱。

**改动**:

1. `judgments-status-filter` 的 6 个按钮 → **2 个主分类 tab**: 正向 / 负向
   - **正向** = `decision_type ∈ {approve, modify, escalate}` 且 `status=active`
   - **负向** = `decision_type=reject` 或 `status ∈ {rejected, superseded}`
2. 表单加**正/负向 toggle** (默认正向); `domain/stakes` 下拉折叠进"高级"区
3. 删除"违规记录/自适应/因果分析"独立 tab — 数据/API 不删, 仅 UI 不单独占 tab; 负向 tab 内用小标签区分"被拒/已推翻/违规"
4. 保留: 导入文件、批量删除、本channel/全局 (降为次级筛选)
5. `renderJudgments` (client.ts:2527) 过滤逻辑: 按 `status` 改为按 `decision_type` 正负分桶

`HumanJudgment.decision_type: 'approve'|'reject'|'modify'|'escalate'` 天然支持正负分桶, 0 数据迁移。

## 设计 B: 判断力负向回收 (显式, 进 prompt)

判断力负向是"判断力"不是"废气", 可进 prompt 作为**约束** (精准 = 正向指引 + 负向避免)。

**改动**:

1. `injection-gate.ts` 新增 `injectNegativeGuard(userInput, opts)`: 从 reject 类 + 高 `stakes`(high/critical) + 高 `confidence` judgment 选 Top N, 以"避免清单"语义产出 systemAddition
   - `maxChars: 300` (远小于正向 1500, 防噪音)
   - 同样静默失败, 返回 `InjectionGateResult`
2. `pi-sdk.ts` `computeJudgmentGate` (L199): 调 `injectNegativeGuard`, 拼到 `judgmentGateAddition` 末尾的"## 避免清单"段; `recordJudgmentUsage` 记录负向 usedIds
3. Web 负向 tab 每条标注"已作为约束注入"徽标 (跟正向"已使用"对称)
4. `recordJudgmentUsage` 扩展: entry 加 `polarity: 'positive'|'negative'` 字段 (回溯可区分)

## 设计 C: 上下文废气涡轮增压 (隐式, 不进 prompt)

**新增 `src/bootstrap/exhaust-scrubber.ts` (涡轮)**:

采样端 (订阅已有丢弃事件, 零新数据源):

- `session-window.ts` saveWindow 返回的 `totalBehind` / `dropped`
- `memory-compressor.ts` 的 `skipped` 原因 + 频率
- `context-compaction/pipeline.ts` 各 `StageResult` 丢弃量
- `context-collector.ts` / `context-hierarchy.ts` 的 `truncated`

聚合背压指标 (环形缓冲, 内存 + 落盘):

```
~/.bolloon/engine/backpressure.jsonl   (append, 跟 chat-archiver 同模式)
{
  ts, droppedTokens, dropRate, compactionCount,
  truncationCount, pressureLevel: 'idle'|'low'|'medium'|'high',
  sample: { source, reason }   // 不存原文, 只存来源+原因标签
}
```

**进气增压 (反向调参, 核心利用点)**:

`exhaust-scrubber` 暴露 `getPressureLevel()`, 进气侧读它:

| 背压等级 | 进气侧动作 (只调参, 不灌内容) |
|---|---|
| idle/low | judgment 注入 maxChars 放宽到 1800; 检索 top-k 放宽; 推迟 auto-compact |
| medium | 默认值 (现状) |
| high | judgment 注入收紧到 800; 检索 top-k 收紧; auto-compact 阈值下调 (更早压缩); state 注入精简 |

接人: `pi-sdk.ts` `computeJudgmentGate` 的 `maxChars` 从固定 1500 改为读 `getPressureLevel()` 动态值。

**可观测 (隐式但可见)**: 暴露 `GET /api/engine/backpressure`; Web 顶栏可选加"引擎背压"色点 (涡轮增压表)。废气内容任何地方都不展示, 只展示压力等级。

**进 memory (拍板要求)**: 背压高峰 (pressureLevel=high 持续) 触发一次轻量 LLM 摘要写 `~/.bolloon/memory/<agentId>/engine/exhaust-<YYYY-MM>.summary.md` (月度滚动, 跟 chat-archiver 同模式), 让"为什么这段时间上下文一直紧张"沉淀进 memory 供 agent 回看。

## 实施清单

| # | 设计 | 文件 | 类型 |
|---|---|---|---|
| A1 | UI 简化 | `src/web/index.html` (judgments-modal 段) | 改 |
| A2 | 渲染分桶 | `src/web/client.ts` (renderJudgments + tab handler + openJudgmentsModal) | 改 |
| A3 | 样式 | `src/web/style.css` (正负向 tab + 徽标) | 改 |
| B1 | 负向 gate | `src/pi-ecosystem-judgment/injection-gate.ts` (新增 injectNegativeGuard) | 改 |
| B2 | 注入接入 | `src/agents/pi-sdk.ts` (computeJudgmentGate) | 改 |
| B3 | usage 极性 | `src/pi-ecosystem-judgment/injection-gate.ts` (recordJudgmentUsage +polarity) | 改 |
| C1 | 涡轮 | `src/bootstrap/exhaust-scrubber.ts` (新) | 新 |
| C2 | 采样接入 | `src/bootstrap/session-window.ts` + `memory-compressor.ts` + `context-compaction/pipeline.ts` (调 scrubber.record) | 改 |
| C3 | 进气调参 | `src/agents/pi-sdk.ts` (maxChars 读 pressure) | 改 |
| C4 | 路由 | `src/web/server.ts` (GET /api/engine/backpressure) | 改 |
| C5 | memory 落地 | `src/bootstrap/exhaust-scrubber.ts` (月度摘要) | 新 (含 C1) |
| T1 | 测试 | `src/test/exhaust-scrubber.test.ts` (新) + `negative-judgment-guard.test.ts` (新) + UI 渲染测试 | 新 |

## 验证

- `npx tsc --noEmit` 0 错
- `npx vitest run --bail=1` 全过 (新增 scrubber/guard 单测)
- 消融实验可选: 压力 high 时 maxChars 收紧到 800 的端到端断言
- wiki writeback: `current-status.md` 已支持表加两行 (判断力负向回收 / 上下文废气涡轮增压); `log.md` 加本 session 记录

## 不做 (YAGNI)

- 不做 embedding 检索负向 judgment (先用 keyword + stakes/confidence 过滤)
- 不做废气原文存储 (只存来源+原因标签, 防隐私/膨胀)
- 不删现有"违规/自适应/因果"API (UI 隐藏, 数据保留)
- 涡轮增压表不强制展示 (默认隐藏, 用户可开启)
