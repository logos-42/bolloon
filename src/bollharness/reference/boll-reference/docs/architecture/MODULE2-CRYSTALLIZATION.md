# 模块二：协商/结晶引擎 + Skill 系统

> 来源: ARCHITECTURE_DESIGN.md §2, §3, §10 + V2 结晶实验成果
> 依赖: [PRINCIPLES.md](PRINCIPLES.md), [MODULE1-INTENT-FIELD.md](MODULE1-INTENT-FIELD.md)
> **这是当前最大的 gap 所在——V1 设计有大量好东西被 V2 压缩掉了**
> 关联讨论: D-01, D-02, D-03, D-04, D-05, D-07

---

## V2 实现现状

### 已验证的基础（不要忽略）

- ✅ 结晶协议 13 条特性经 6 次实验验证
- ✅ Bridge 全自动管道: dispatcher → Claude Code → 结晶 → complete → 前端
- ✅ v2 基线固化: clarification-session_v1.1 + endpoint_v2 + catalyst_v2.1 + plan_v0
- ✅ 159 tests passing
- ✅ 产品化全栈: 注册、需求提交、匹配、结晶、进度推送、结果展示

### 首次真实 Run 暴露的问题（2026-02-26）

**现象**: "找几个人聊 AI"跑了 4 轮，输出 5000 字重型协作方案，指标失真（1500分钟节省、¥36,000）。

**根因诊断**（不只是 prompt 问题，是流程层的决策点缺失）:

| 缺失 | V1 设计位置 | 影响 |
|------|------------|------|
| Formulation 需求密度分级 | §1.2, §10.4 | 所有需求走同等重型流程 |
| 端侧意愿判断 | §6.1.3 第三层, §10.6 | 匹配到就无条件投影 |
| 中途退出权 | ADR-005 | 进来就跑完全程 |
| 轻量输出路径 | §3.4 output_plan | 恒定输出完整 Plan |
| 发送方偏好编码 | §1.2 | 双向编码只实现了接收方 |
| 收敛准则 | §3.5 | 从"三准则"退化为"信息差耗尽" |

### V2 vs V1 流程对比

**V1 完整流程**（§10.2）:
```
① 用户意图
② Formulation（密度判断 + 偏好编码 + 用户确认）
③ HDC 共振（三层过滤）
④ 并行 Offer（端侧独立生成，OfferGenerationSkill）
⑤ 等待屏障（所有 Offer 到齐）
⑥ Center 综合（工具调用模型）
⑦ 工具执行（追问/发现/子需求/输出）
⑧ 轮次控制（代码硬上限）
```

**V2 实际流程**:
```
用户提需求 → Formulation（单次 API，无密度判断）→ match()（只有第二层）→ 结晶（催化做 ②④⑤⑥⑦⑧ 的所有事）
```

---

## Skill 系统 ⚠️ 待对齐

> **V1 设计**: 接口稳定 + 实现可进化，6 个 Skill 各有明确职责
> **V2 现实**: 催化 prompt 吸收了多个 Skill 的职责，端侧 prompt 只做投影
> **核心问题**: 催化承担太多，缺乏结构化约束

### 设计理念 ✅

Skill = 启用一个子 Agent。两层分离:
- **接口层**（稳定）: 角色、职责、输入/输出、原则、约束
- **实现层**（可进化）: 具体提示词、few-shot、CoT 引导

两种类型:
- **统一 Skill**: 所有实例同一逻辑（Center、SubNegotiation、GapRecursion）
- **可定制 Skill**: 每个 Agent 有自己的版本（Formulation、Offer）

### Skill 清单与生命周期

| Skill | 类型 | 位置 | V2 状态 |
|-------|------|------|---------|
| **DemandFormulationSkill** | 可定制 | ② | ⚠️ 简化为单次 API，缺密度判断 |
| **ReflectionSelectorSkill** | 可定制 | 注册/变更时 | ✅ 实现为 EncodingPipeline |
| **OfferGenerationSkill** | 可定制 | ④ | ⚠️ 被催化吸收，端侧无独立 Offer |
| **CenterCoordinatorSkill** | 统一 | ⑥ | ⚠️ 变为催化自由文本，工具模型丢失 |
| **SubNegotiationSkill** | 统一 | ⑦ | 🔮 未实现 |
| **GapRecursionSkill** | 统一 | ⑦ | 🔮 未实现 |

### 10.4 DemandFormulationSkill ⚠️ 待对齐

| 项目 | V1 设计 |
|------|---------|
| 角色 | 用户真实需求的理解者和表达者 |
| 职责 | 基于 Profile 和上下文，将原始意图丰富化 |
| 输入 | 用户原始意图 + Agent 的 Profile Data |
| 输出 | 丰富化后的需求文本（供 HDC 编码和广播） |
| 原则 | ① 理解"要求"背后的"需求" ② 保留意图，补充上下文 ③ 丰富化程度由用户控制 |
| 约束 | 输出需经用户确认后才广播 |

**V2 缺失**: 没有需求密度判断。V1 设计中这里应该决定低/中/高密度 → 影响后续轮次和输出格式。

### 10.6 OfferGenerationSkill ⚠️ 待对齐

| 项目 | V1 设计 |
|------|---------|
| 角色 | Agent 在协商中的发言人 |
| 职责 | 基于真实 Profile，对需求给出诚实回应 |
| 输入 | 需求文本 + Agent 自己的 Profile Data |
| 输出 | Offer（我能贡献什么、什么相关经历） |
| 原则 | ① 只描述 Profile 中记录的（不捏造）② 说清楚相关/不相关 ③ 元认知：意想不到的价值 |
| 约束 | Prompt 中只有自己的 Profile，没有其他 Agent 信息 |

**V2 现实**: 端侧 prompt（endpoint_v2）做的是"投影"——催化给上下文，端侧输出回复。没有独立的"我要不要参与"判断，也没有独立的 Offer 生成。

**关键区别**: V1 端侧是**独立思考者**（读需求→判断要不要→生成 Offer）。V2 端侧是**催化的执行者**（催化问什么就答什么）。

### 10.7 CenterCoordinatorSkill ⚠️ 待对齐

| 项目 | V1 设计 |
|------|---------|
| 角色 | 多方资源综合规划者 |
| 职责 | 综合所有 Offer，用工具推进协商 |
| 输入 | 需求 + 所有 Offer + 用户偏好 + 历史（观察遮蔽） |
| 工具集 | output_plan / create_machine / ask_agent / start_matching / create_sub_demand |
| 核心规则 | 评估 Offer 能否满足需求，用工具推进 |
| 约束 | 只在 Offer 到齐后调用；超过 2 轮限制工具集 |

**V2 现实**: 催化做了 Center 的工作但没有工具约束。催化自由决定输出什么，没有程序层的结构化限制。

### 10.10 Skill 优化机制（SkillPolisher）🔮

接口稳定，实现可持续优化。SkillPolisher 不能改接口，只能优化 prompt。
V2 用手动 prompt 迭代替代（实验驱动）。

---

## V2 结晶协议已验证的特性

> 来源: EXP-009 实验（SIM-001/002 + RUN-001~006）

### 8 条已验证协议特性

1. 投影函数张力依赖性
2. 信息函数不变量多轮稳定性
3. 投影张力锁定跨轮稳定性
4. 收敛因=边界精度饱和
5. 催化元认知
6. 5轮=数据耗尽非带宽限制
7. 逐对检查R1全覆盖
8. Plan来源可追溯性

### 关键实验结论

- **v2 基线**在{模糊需求,精确需求}×{同质,差异化}的 2×2 条件空间验证通过
- 催化元认知（"你看到了什么，你还没看到什么"）是有效的
- 收敛 = 边界精度饱和，不是信息耗尽
- 问题不在协议引擎层，在**流程决策层**（缺少门控和分级）

### 当前 Prompt 版本链

| Prompt | 版本 | 位置 | 备注 |
|--------|------|------|------|
| Formulation | v2 | `clarification-session.py:_SYSTEM_PROMPT` | PLAN-080 WP-04: 世界观注入 |
| Formulation (实验) | v1.1 | `tests/convergence_poc/prompts/` | 四参数编码器 |
| Endpoint | v2 | `tests/convergence_poc/prompts/` | |
| Endpoint (收敛) | v3 | `endpoint_default.md` | PLAN-080 WP-01: [NEW_INFO]/[NO_NEW_INFO] 标记 |
| Catalyst | v2.1 | `tests/convergence_poc/prompts/` | |
| Plan | v0 | 同上 | |
| Delivery | (催化内嵌) | — | |

---

## 指标体系 ⚠️ 待对齐

> **V2 公式**（ADR-015）:
> - B1 节省时间 = total_output_chars / 100 × (1 + 2.0) 分钟
> - B3 效率倍数 = 节省时间 / AI实际耗时
> - B4 协作价值 = 参与人数 × 300元/小时 × 节省小时数
>
> **问题**: 这些公式对高密度需求合理，对"找人聊天"产生 ¥36,000 的荒谬值。
> **待讨论** (D-05): 指标基线跟需求密度走

---

## 需要恢复的完整流程（讨论草案）

> 这是 gap analysis 的初步方案，需要逐个讨论确认

```
模块 1（向量数学）→ 通过的 agent 列表
    ↓
模块 2 入口:
    ├── 需求密度判断（分流: 低/中/高）     ← D-01
    ├── 端侧 Agent 意愿判断                ← D-02
    │     ├── 不感兴趣 → 退出
    │     └── 感兴趣 → 进入结晶
    ↓
结晶循环（端侧投影 → 催化观察 → 下一轮）
    ↓ 每轮端侧保留退出权                   ← D-04
    ↓
收敛 / 达到最大轮次
    ↓
输出格式跟密度走:                           ← D-03
    低密度 → 推荐卡片
    高密度 → 完整协作方案
```
