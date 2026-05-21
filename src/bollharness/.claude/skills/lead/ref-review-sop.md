# lead SKILL.md

## 审查闭环 SOP

### TeamCreate 使用规范

**什么时候用 TeamCreate**：
- Gate 2 架构审查
- Gate 4 PLAN 审查 + plan-lock
- Gate 6 task 审查
- Gate 8 最终审查

**什么时候用 Agent tool**：
- 禁止用 Agent tool 做审查
- Agent tool 是共享上下文，判断不独立

### 三视角矩阵

| 视角 | 关注点 |
|------|--------|
| 商业可行性 | 价值、风险、成本 |
| 技术本质 | 可行性、复杂性、依赖 |
| 用户体验 | 可用性、接受度 |

### 裁决格式

```
## Verdict: PASS / FAIL

## Scores
- Completeness: X/5
- Honesty: X/5
- Quality: X/5
- Consistency: X/5

## Findings
1. [具体发现]
2. [具体发现]

## Recommendation
[如果 FAIL，具体要修什么]
```

### 生产问题诊断硬规则

1. **先看日志/事件/DB**，不先看代码猜测
2. **先隔离问题范围**，不直接全局搜索
3. **先验证假设**，不基于假设行动
