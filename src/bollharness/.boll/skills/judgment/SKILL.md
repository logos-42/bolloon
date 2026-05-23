---
name: judgment
description: 判断力系统 - 从人类输入中提取、蒸馏和应用判断原则。触发条件：明确纠正、隐式偏好、行为轨迹分析。支持决策授权（自主/内部咨询/外部咨询/需要人类）。
status: active
tier: core
owner: pi-ecosystem
window_owner: shared
window_owner_since: 2026-05-23T13:38+08:00
window_owner_adr: src/pi-ecosystem-judgment/
last_audited: 2026-05-23
---

# /judgment — 判断力系统

## 什么是判断力系统

人类决策原则 → LLM 蒸馏 → YAML 存储 → 注入到 Agent 上下文

Pi 判断力系统捕获人类输入中的判断原则，通过 LLM 实时提炼为结构化 Judgment，存储在 `~/.bolloon/judgments/` 和 context-fragment frontmatter 中，供运行时决策使用。

## 判断类型

| Type | 说明 | 置信度默认 |
|------|------|-----------|
| `rule` | 明确规则（不要/必须/应该） | 0.9 |
| `preference` | 偏好（喜欢/宁愿） | 0.7 |
| `trajectory` | 行为轨迹（重复模式） | 0.75 |
| `reward` | 奖励信号 | 0.6 |

## 触发类型

- **explicit**: 明确纠正（"不，应该这样做"、"错了，要xxx"）
- **implicit**: 隐式偏好（短陈述，可能表示偏好）
- **trajectory**: 行为轨迹（多次相似行为approved/rejected）

## 决策层级

当 agent 置信度低于阈值时：

| 层级 | 条件 | 咨询对象 |
|------|------|---------|
| `autonomous` | confidence >= threshold | 无 |
| `consult_internal` | confidence >= threshold * 0.7 | colony_ant, subagent |
| `consult_external` | confidence >= threshold * 0.4 | colony_ant, subagent, p2p_agent |
| `require_human` | confidence < threshold * 0.4 | human |

## 存储位置

- `~/.bolloon/judgments/rules.yaml` - 明确规则
- `~/.bolloon/judgments/preferences.yaml` - 偏好
- `~/.bolloon/judgments/trajectories.yaml` - 行为轨迹
- `~/.bolloon/judgments/rewards.yaml` - 奖励信号

## 注入时机

- **Session Start**: 注入核心判断（置信度 ≥ 0.9）
- **Context Router 匹配**: 注入路径相关判断（置信度 ≥ 0.7）
- **决策点**: 动态注入，基于置信度

## API

### 创建判断
```
await createJudgment({
  type: 'rule',
  content: '不要使用 var，优先用 const',
  source: 'human',
  confidence: 0.95,
  context: 'typescript-style'
})
```

### 获取判断
```
await getCombinedJudgments()  // 文件 + fragment
await getJudgmentsForContext('code-style')
await getValueFunction(context)
```

### 蒸馏输入
```
await distillInput({
  rawInput: '不，应该用 const 而不是 var',
  trigger: 'explicit',
  context: 'javascript'
})
```

### 决策请求
```
const request = await evaluateDecision(
  'description',
  'context',
  'agent-id',
  0.7  // threshold
)
```

## 判断力注入到上下文

通过 ContextRouter 扩展：

```typescript
const router = new ContextRouter()
const coreJudgments = await router.getCoreJudgments(0.9)
const pathJudgments = await router.getJudgmentsForPath('src/agents/', 0.7)
const injection = await router.generateJudgmentInjection('src/agents/', 0)
```

## 相关模块

- `src/pi-ecosystem-judgment/index.ts` - 核心类型和存储
- `src/pi-ecosystem-judgment/distillation.ts` - LLM 蒸馏
- `src/pi-ecosystem-judgment/decision.ts` - 决策授权流
- `src/bollharness-integration/context-router-judgment.ts` - 上下文注入
