# Skill 设计中的说服原则

## 概览

LLM 和人一样会对同样的说服原则做出反应。理解这些心理学原理能帮你设计出更有效的 skill——不是为了操纵，而是为了确保关键实践在压力下也能被执行。

**研究基础：** Meincke 等（2025）用 N=28,000 的 AI 对话测试了 7 条说服原则。说服技巧让合规率翻了一倍多（33% → 72%，p < .001）。

## 七大原则

### 1. 权威（Authority）
**是什么：** 对专业能力、资历、官方来源的顺从。

**如何在 skill 中运用：**
- 命令式语言："YOU MUST"、"Never"、"Always"
- 不可议价的框架："No exceptions"
- 消除决策疲劳和找借口的空间

**何时使用：**
- 强制纪律的 skill（TDD、验证要求）
- 安全攸关的实践
- 既定的最佳实践

**示例：**
```markdown
✅ Write code before test? Delete it. Start over. No exceptions.
❌ Consider writing tests first when feasible.
```

### 2. 承诺（Commitment）
**是什么：** 与既有行为、声明或公开表态保持一致。

**如何在 skill 中运用：**
- 要求主动声明："Announce skill usage"
- 强制显式选择："Choose A, B, or C"
- 用 TodoWrite 之类的工具做清单跟踪

**何时使用：**
- 确保 skill 被真正执行
- 多步流程
- 责任追溯机制

**示例：**
```markdown
✅ When you find a skill, you MUST announce: "I'm using [Skill Name]"
❌ Consider letting your partner know which skill you're using.
```

### 3. 稀缺（Scarcity）
**是什么：** 时间限制或资源有限带来的紧迫感。

**如何在 skill 中运用：**
- 时间窗口要求："Before proceeding"
- 顺序依赖："Immediately after X"
- 防止拖延

**何时使用：**
- 立刻验证的要求
- 时效性敏感的工作流
- 防止"回头再说"

**示例：**
```markdown
✅ After completing a task, IMMEDIATELY request code review before proceeding.
❌ You can review code when convenient.
```

### 4. 社会认同（Social Proof）
**是什么：** 顺从多数人怎么做、什么是常态。

**如何在 skill 中运用：**
- 普遍性表述："Every time"、"Always"
- 失败模式："X without Y = failure"
- 建立规范

**何时使用：**
- 记录通用实践
- 警示常见错误
- 强化标准

**示例：**
```markdown
✅ Checklists without TodoWrite tracking = steps get skipped. Every time.
❌ Some people find TodoWrite helpful for checklists.
```

### 5. 一致性 / 共同体（Unity）
**是什么：** 共同身份、"我们感"、圈内归属。

**如何在 skill 中运用：**
- 协作式语言："our codebase"、"we're colleagues"
- 共同目标："we both want quality"

**何时使用：**
- 协作型工作流
- 建立团队文化
- 非等级化实践

**示例：**
```markdown
✅ We're colleagues working together. I need your honest technical judgment.
❌ You should probably tell me if I'm wrong.
```

### 6. 互惠（Reciprocity）
**是什么：** 有义务回报得到的好处。

**如何使用：**
- 慎用 —— 可能显得操纵
- skill 里很少需要

**何时避免：**
- 几乎都要避免（其他原则更有效）

### 7. 好感（Liking）
**是什么：** 更愿意和自己喜欢的人合作。

**如何使用：**
- **不要用来强制合规**
- 与诚实的反馈文化相冲突
- 会培养迎合

**何时避免：**
- 用于强制纪律时，永远避免

## 按 Skill 类型搭配原则

| Skill 类型 | 推荐用 | 避免用 |
|------------|-----|-------|
| 强制纪律型 | Authority + Commitment + Social Proof | Liking, Reciprocity |
| 指引/技巧型 | 适度 Authority + Unity | 重 Authority |
| 协作型 | Unity + Commitment | Authority, Liking |
| 参考型 | 只需清晰 | 任何说服手段 |

## 为什么有效：背后的心理学

**硬性规则能减少找借口：**
- "YOU MUST" 消除决策疲劳
- 绝对化措辞消灭"这算例外吗？"的疑问
- 显式的反借口针对具体漏洞

**执行意图能制造自动行为：**
- 清晰的触发 + 规定的动作 = 自动执行
- "When X, do Y" 比 "generally do Y" 有效得多
- 降低合规的认知负担

**LLM 是类人的：**
- 训练数据里包含了大量体现这些模式的人类文本
- 训练数据中权威语言往往先于合规出现
- 承诺序列（声明 → 行动）经常被模仿
- 社会认同模式（大家都做 X）能建立规范

## 合乎伦理的使用

**正当用法：**
- 确保关键实践被执行
- 写出有效的文档
- 防止可预见的失败

**不正当用法：**
- 为私利操纵
- 制造虚假紧迫感
- 用愧疚驱动合规

**判断标准：** 如果用户完全了解这种技巧，它是否仍然在服务用户的真实利益？

## 研究引用

**Cialdini, R. B. (2021).** *Influence: The Psychology of Persuasion (New and Expanded).* Harper Business.
- 七大说服原则
- 影响研究的实证基础

**Meincke, L., Shapiro, D., Duckworth, A. L., Mollick, E., Mollick, L., & Cialdini, R. (2025).** Call Me A Jerk: Persuading AI to Comply with Objectionable Requests. University of Pennsylvania.
- 用 N=28,000 的 LLM 对话测试 7 大原则
- 用上说服技巧后，合规率从 33% 提升到 72%
- Authority、Commitment、Scarcity 最有效
- 验证了 LLM 行为的"类人"模型

## 快速参考

设计 skill 时，问自己：

1. **它是什么类型？**（强制纪律型 vs. 指引型 vs. 参考型）
2. **我想要改变哪种行为？**
3. **哪条（些）原则适用？**（强制纪律型通常是 Authority + Commitment）
4. **我是不是用得太多了？**（不要 7 条全上）
5. **这合乎伦理吗？**（服务于用户的真实利益吗？）
