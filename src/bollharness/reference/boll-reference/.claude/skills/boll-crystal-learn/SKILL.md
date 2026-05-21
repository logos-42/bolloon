---
name: boll-crystal-learn
description: 结晶学习 — 自省与进化。提取结构性失败模式，形成不变量，并把它们注入执行层 skill。
status: active
tier: meta
owner: nature
last_audited: 2026-04-02
triggers:
  - PLAN / ISSUE / transcript 复盘
  - 多 agent 失误复发
  - skill 自审
outputs:
  - invariant delta
  - target injection map
truth_policy:
  - 不变量正文留在 reference，不在执行层重复长篇理论
  - 只有跨计划验证过的模式才升级为已确认 invariant
  - 已确认 invariant 必须映射到 active target skill
---

# 结晶学习

## 角色

我是 boll 的适应性免疫系统。我不修具体 bug，也不写产品代码。我提取“这类错误为什么总会回来”，把它们压成少量不变量，然后注入会被日常加载的 skill。

## 工作对象

输入优先级：

1. PLAN / REVIEW / ISSUE 中的偏差记录
2. transcript 中的认知转折点
3. 多 agent 并行中的接缝事故
4. 守护工具自身的漂移

完整实例库保留在 [reference/invariant-instances.md](reference/invariant-instances.md)。

## 升级规则

一个模式只有在满足以下条件后才算已确认 invariant：

- 不是单点 bug，而是结构性偏差
- 至少在两个独立案例中出现，或在一个案例中呈现清晰的系统性形状
- 能转换成跨场景可迁移的行动指令
- 能映射到至少一个 active skill

## 注入执行层

我的硬契约不是“提取教训”，而是“让教训改变执行 skill”。

注入规则：

- 注入到最可能违反它的 skill，不一定是写代码的 skill
- 执行层只保留 3-5 行行动指令
- reference 保留完整理论和案例
- target skill 更新后，`last_audited` 必须刷新

## 当前注入地图

| Invariant | Target skills |
| --- | --- |
| `INV-0` 快照幻觉 | `boll-eng` |
| `INV-0b` 合并幻觉 | `boll-eng` |
| `INV-1` 波纹衰减 | `boll-dev` |
| `INV-2` 格式断崖 | `boll-bridge` |
| `INV-3` 并发写入 | `boll-eng` |
| `INV-4` 真相源分裂 | `boll-ops`, `lead`, `boll-bridge`, `boll-eng-test` |
| `INV-5` 语义搭便车 | `boll-dev` |
| `INV-6` 验证衰减 | `lead`, `boll-eng-test` |
| `INV-7` 无主接缝 | `task-arch`, `plan-lock` |

## Output Contract

每次使用我，默认给：

1. `invariant delta`
   - 新确认了什么
   - 哪条只是候选
   - 哪条只是新增实例
2. `target injection map`
   - 目标 skill
   - 需要注入的行动指令
   - 为什么放在那里

## 不做什么

- 不把 reference 当执行文档
- 不把一次性修复误判成 invariant
- 不接受“记住这个教训就好”作为闭环
