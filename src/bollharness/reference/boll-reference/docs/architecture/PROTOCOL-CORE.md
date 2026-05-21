# 协议核心：流程、Center 设计、状态、事件

> 来源: ARCHITECTURE_DESIGN.md §1-4
> 依赖: [PRINCIPLES.md](PRINCIPLES.md)
> 关联讨论: D-01, D-03, D-07

---

## 1. 最小完整单元 ⚠️ 待对齐

> **V1 设计**: 8 步完整流程，每步有明确的决策点和 Skill
> **V2 现实**: 压缩为 需求→Formulation(单次API)→match()→结晶（催化做一切）
> **讨论点**: 哪些被压缩掉的决策点需要恢复？

### 1.1 V1 核心流程

```
用户表达意图（原始的、可能模糊的）
    ↓
【需求clarification-session】用户Agent基于Profile理解真实需求，丰富化
    用户确认 → 编码为HDC签名 → 广播
    ↓
【供给方共振】端侧Agent本地共振检测：这个信号跟我有关吗？
    ↓
通过共振的Agent用大模型读取需求，给出Offer
    ↓
Offer收集完毕（等待屏障）
    ↓
中心Agent综合所有Offer，设计方案
    （用户偏好/约束作为Center的context输入，Center有权建议放宽）
    ↓
判断是否有Gap → 如果有，递归处理子需求
    ↓
方案输出（协商的自然终止态）
    ├─ plan → 文本方案（信息类/建议类需求）
    └─ contract → 可执行合约 → WOWOK Machine → 执行阶段
```

### 1.2 需求 Formulation 与共振筛选 ⚠️ 待对齐

> **V2 缺失**: Formulation 没有做需求密度判断，没有编织偏好进签名（双向编码只实现了接收方）

**V1 设计要点**:

- **需求 ≠ 要求**（原则 0.6）。需求是抽象张力，要求是假设性解法
- 需求方偏好通过**两个位置**表达:

| 位置 | 时机 | 机制 |
|------|------|------|
| 需求 clarification-session（前置） | 广播前 | 用户Agent丰富化需求，偏好编织进HDC签名 |
| Center context（后置） | 综合时 | 用户偏好/约束作为Center输入 |

- Formulation 是**可插拔**的：从"基本原样+补充Profile信息"到"Agent大幅重构需求"
- **不做独立的需求方筛选**: HDC 共振已做语义过滤，Center 综合已包含选人智能

### 1.3 "自-我"工程映射 → 见 [AGENT-PROFILE.md](AGENT-PROFILE.md)

### 1.4 场景（Scene）→ 见 [AGENT-PROFILE.md](AGENT-PROFILE.md)

---

## 2. 协作组内交流机制 ⚠️ 待对齐

> **V2 现实**: 结晶协议重新实现了轮次管理。V1 的"端侧独立回复→Center聚合"变成了"催化统一编排"
> **讨论点**: V1 的端侧独立性是否需要恢复？

### 2.1 交流粒度

**轮次级别（回合制）**——每次交流是完整轮次，中心Agent收集所有Agent本轮输入后聚合。

### 2.2 交流拓扑

**中心化架构**——主要: 端侧Agent ↔ 中心Agent（一对一）。例外: 端侧 ↔ 端侧（P2P，由中心触发）。

### 2.3 轮次管理

- 等所有Agent都回复才进入下一轮
- Agent选择退出则立即退出（AI不需要"软性退出"）

### 2.4 一个轮次的流程

```
中心Agent向所有端侧Agent发送本轮信息
    ↓
端侧Agent各自处理，生成回复
    ↓
中心Agent收集所有回复
    ↓
中心Agent聚合/分析/决策
    ↓
进入下一轮或结束
```

---

## 3. Center Agent 设计 ⚠️ 待对齐

> **V1 设计**: Center = 拿着工具集的 Agent（tool use 模型）
> **V2 现实**: Catalyst = 自由文本输出的协调者。工具调用模型丢失了。
> **关键问题**: V1 的结构化约束 vs V2 的灵活性，怎么取舍？

### 3.1 角色定位

Center 是**多方资源综合规划者**。不是"传话筒"，也不是"绝对理性裁判"。
设计原则：**用代码消除已知偏见，用 prompt 引导元认知**。

### 3.2 输入

- 需求文本（经 clarification-session 丰富化）
- 所有 Offer（程序层等待屏障保障完整性）
- 用户偏好/约束
- 历史（观察遮蔽格式：保留推理，遮蔽原始 Offer）

### 3.3 决策规则

| 优先级 | 规则 |
|--------|------|
| 1 | 满足需求 |
| 2 | 通过率（涉及各方会不会同意） |
| 3 | 效率 |

### 3.4 Center 工具集 ⚠️ 待对齐

> **V1**: 5 个结构化工具，代码约束行为空间
> **V2**: 催化自由文本输出，没有工具约束
> **讨论点**: 是否恢复工具调用模型？

| 工具 | 作用 | 程序层后续 |
|------|------|----------|
| `output_plan(content)` | 输出文本方案 | 协商终止 |
| `create_machine(json)` | 创建 WOWOK Machine 草案 | 上链（V2 不涉及） |
| `ask_agent(agent_id, question)` | 向指定 Agent 追问 | 转发问题，收回复后重新调用 Center |
| `start_matching(a, b, reason)` | 触发发现性对话 | SubNegotiationSkill |
| `create_sub_demand(gap)` | 生成子需求 | 启动新协商（递归） |

**关键设计**: 工具不互斥（可组合）。工具集即边界（LLM 不能做工具集以外的事）。可扩展（新能力=新工具）。

### 3.5 工作模式

**程序层代码保障**（不依赖 prompt）:

| 保障 | 机制 |
|------|------|
| 消除第一提案偏见 | 等待屏障：所有 Offer 到齐才调用 Center |
| 防止无限循环 | 轮次计数器 |
| 控制 context 质量 | 观察遮蔽 |
| 限制行为空间 | 工具集本身就是边界 |

研究支撑:
- **多轮迭代**: Google DeepMind（2025）平均效果 -3.5%，错误放大 4.4x
- **观察遮蔽**: JetBrains Research（2025）遮蔽比摘要更好，成本低 50%

### 3.6 协议层事件语义

> **对齐状态** (2026-04-03 PLAN-080 WP-03): Bridge 进度事件通过 `event_translator.py` 翻译为协议级事件。
> 翻译层是事件字符串的单一真相源 (INV-4)。

**协商阶段事件**:

| 事件 | 语义 | Bridge 映射 |
|------|------|-------------|
| `demand.formulate` | 用户 Agent 将原始意图丰富化为需求表达 | `clarification-session.completed` |
| `demand.broadcast` | 存在体向网络发出信号，表达状态张力 | — |
| `offer.submit` | 存在体对需求信号产生响应 | `endpoint.completed` |
| `catalyst.observe` | 催化者观察本轮响应，生成综合 | `catalyst.observation` |
| `plan.generate` | 多个响应被聚合整合为综合方案 | `plan.generated` |
| `delivery.complete` | 个性化交付生成完毕 | `delivery.completed` |
| `gap.identify` | 方案中发现无法被现有响应满足的部分 | — |
| `sub_demand.create` | 缺口转化为子需求，触发递归 | — |

**方案确认**（V1 决策）: "确认"不是独立步骤，而是协商的三种穷举终止态——有异议（继续）、退出、无异议（即确认）。

---

## 4. 状态管理 ⚠️ 待对齐

> **V2 现实**: PostgreSQL runs 表 + status 字段（queued/running/done/failed）+ Bridge heartbeat
> **V1 设计**: 更细粒度的协作组状态 + Agent 状态

### 4.1 设计原则

能少一个环节就少一个环节。

### 4.2 协作组状态

V1 只需两个状态: `negotiating` | `completed`（不需要 forming/confirming/failed/cancelled——协商总会有结果）

### 4.3 Agent 状态 ⚠️ 待对齐

> **V2 缺失**: 没有 Agent 级别的状态跟踪

| 状态 | 描述 |
|------|------|
| `active` | 活跃，参与协商 |
| `replied` | 本轮已回复 |
| `exited` | 已退出 |

### 4.4 状态检测

**核心假设**: Agent 是 AI，不是人。AI 不会"忘记回复"或"拖延"。每个 Agent 要么回复，要么退出。
**协议层不需要超时**——超时是基础设施层的容错。

### 4.5 等待屏障（Barrier）⚠️ 待对齐

> **V2 缺失**: 没有等待屏障。催化直接编排所有参与者。

程序层维护"待响应列表"。每收到一个 Offer 或退出通知，从列表移除。列表为空 → 进入 Center 综合。

**这是对抗第一提案偏见的结构性保障**（原则 0.5 代码保障 > Prompt 保障）。
