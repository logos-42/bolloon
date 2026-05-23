---
name: context-chains
description: 上下文 session 摘要链化系统。根据工作类型（code_change/review/design/question）将每次会话压缩为结构化摘要，存储在 `.boll/state/context-chains/` 中，新会话自动关联历史上下文。触发时机：每次会话结束 / Gate 0 进入时 / 显式请求"关联上下文"时使用。
status: active
tier: core
owner: boll-system
window_owner: shared
last_audited: 2026-05-23
triggers:
  - 会话结束
  - Gate 0 进入
  - 显式请求"关联上下文"或"总结上次"
  - 需要引用历史决策或上下文
inject_gates:
  - 0
  - 3
work_types:
  - code_change
  - review
  - design
  - question
  - planning
  - debugging
---

# Context Chains — 上下文会话摘要链化

## 核心思想

每次会话结束后，将本次对话的**核心上下文**压缩为一个 `context-summary.yaml` 文件，存入 `.boll/state/context-chains/`。新会话开始时，自动找到并注入相关的历史上下文链。

**有限上下文长度 = 强制压缩点**。我们不做"保留一切"的徒劳努力，而是主动决定"什么必须保留、什么可以丢失"。

## 工作类型与萃取策略

| work_type | 保留内容 | 压缩比例 | 优先级 |
|-----------|---------|---------|--------|
| `code_change` | 改了什么文件 / 决策理由 / 引入接缝 | 10:1 | 决策理由 > 接缝 > 文件 |
| `review` | 审查意见模式 / 反复出现的问题 / verdict | 20:1 | verdict > 模式 > 问题 |
| `design` | 设计选择 / 约束条件 / 消费方 | 5:1 | 约束 > 选择 > 消费方 |
| `question` | 问的是什么 / 答案摘要 / 来源 | 3:1 | 答案 > 问题类型 |
| `planning` | 目标 / 依赖 / 风险点 / 决策缺口 | 5:1 | 风险 > 依赖 > 目标 |
| `debugging` | 根因 / 症状 / 修复方案 / 验证方法 | 3:1 | 根因 > 修复 > 症状 |

## 存储结构

```
.boll/state/context-chains/
└── {YYYY-MM}/{session-id}-{work_type}-{seq}.yaml
```

每次会话生成一个摘要文件，命名规范：
- `{session-id}`: 会话唯一标识（UUID 或时间戳）
- `{work_type}`: 工作类型
- `{seq}`: 当日序号（从 1 开始）

## 摘要 YAML Schema

```yaml
session_id: "uuid-or-timestamp"
work_type: code_change | review | design | question | planning | debugging
created_at: "2026-05-23T15:00:00+08:00"
gate_at_session: 0-8
关联上下文:
  - session_id: "..."
    reason: "同模块改动了 X"
    relevance: 0.8
  - session_id: "..."
    reason: "接缝变更影响 Y"
    relevance: 0.6
核心摘要:
  work_type 内容字段（见下方各类型定义）
决策缺口:
  - 描述
  - 影响
  - 需要什么才能关闭
风险点:
  - 描述
  - 概率
  - 缓解措施
遗迹（可丢失内容）:
  - 过程讨论
  - 试错过程
  - 临时调试输出
```

## 各 work_type 核心摘要字段

### code_change

```yaml
核心摘要:
  files_changed:
    - path: "src/agents/manager.ts"
      change_type: modify | add | delete
      reason: "解决 Z 问题"
      seam_affected: true | false
  decisions:
    - choice: "选择方案 A 而非 B"
      reason: "因为..."
    - choice: "引入新接缝"
      owner: "谁负责"
  adr_linked: ["ADR-NNN"]
```

### review

```yaml
核心摘要:
  verdict: PASS | BLOCK | CONDITIONAL
  reviewed_artifact: "路径或描述"
  blocking_issues:
    - severity: blocker | warning | nit
      description: "..."
      pattern: "这是第 N 次出现此类问题"
  non_blocking_observations:
    - "..."
  reviewer_preference_patterns:
    - "审查者反复强调 X"
      frequency: 3
```

### design

```yaml
核心摘要:
  design_choices:
    - what: "决定 X"
      why: "因为约束 A/B/C"
      alternatives_considered:
        - "方案 B: 缺点是..."
  constraints:
    - type: technical | business | temporal
      description: "..."
  consumers:
    - type: data | behavior | visibility
      description: "..."
```

### question

```yaml
核心摘要:
  question_type: concept | implementation | debugging | tool_usage
  answer_summary: "一句话答案"
  source: "来自文档/代码/讨论"
  related_context:
    - session_id: "..."
      relevance: 0.7
```

### planning

```yaml
核心摘要:
  goals:
    - description: "..."
      acceptance_criteria: ["...", "..."]
  dependencies:
    - on_artifact: "..."
      type: blocks | informs
  risks:
    - description: "..."
      probability: high | medium | low
      mitigation: "..."
  decision_gaps:
    - question: "..."
      stakes: "..."
      owner: "谁决定"
```

### debugging

```yaml
核心摘要:
  root_cause: "根本原因一句话"
  symptoms_observed:
    - "..."
  fix_applied:
    - description: "..."
      verification: "..."
  files_touched:
    - "..."
  introduced_regression_risk: low | medium | high
```

## 上下文链查找算法

当新会话开始时，按以下顺序查找关联上下文：

1. **同 work_type 最近 3 条**（权重 0.8）
2. **同模块/同目录最近 2 条**（权重 0.7）
3. **共享 ADR 关联**（权重 0.6）
4. **审查 verdicts 关联**（权重 0.5）

注入上限：取相关性加权求和 Top 5，总 token 预算 ≤ 2000。

## 与 Judgment 系统集成

context-chains 的摘要可以被 judgment 系统二次处理：

- 高频出现的 `blocking_issues` → 新增 `rule` 类型判断
- 审查者偏好模式 → 新增 `preference` 类型判断
- 决策缺口积累 → 触发 `consult_external` 层级

## 使用场景

### 场景 1：会话结束自动摘要

```
会话结束时自动调用，生成摘要写入 .boll/state/context-chains/
```

### 场景 2：Gate 0 进入时注入

```
进入 Gate 0 时：
1. 查找相关历史上下文链
2. 注入核心摘要（≤ 2000 tokens）
3. 输出关联 session_id 列表供深入查看
```

### 场景 3：显式请求

```
用户说"关联上次"或"总结上次做了什么"
→ 找到最近一条同 work_type 摘要
→ 展开核心摘要
→ 必要时追溯完整链
```

### 场景 4：ADR 撰写时

```
写 ADR 前先注入相关 design/planning 摘要
→ 约束条件已明确
→ 避免重复造轮子
```

## 不做什么

- 不存储完整会话记录（那是日志系统的事）
- 不压缩过程性内容（试错、讨论细节）
- 不做语义搜索（只做结构化字段匹配）
- 不在摘要中存储秘密/密钥

## 辅助文件

- `context-chain-index.md` — 每日摘要索引
- `work-type-extractors/` — 各 work_type 的萃取脚本
