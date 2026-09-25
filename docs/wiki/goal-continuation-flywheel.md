---
title: Goal 长期执行飞轮 (意图 + 执行机制: 意图 → Goal → continuation → Run → Memory/Skill → 下一次执行)
source: session (leo 2026-09-25 设计稿 + 现状盘点)
created: 2026-09-25
last_confirmed: 2026-09-25
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [intent, goal, continuation, flywheel, supervisor, memory, skill, work-contract, block-monitor, goal-change, interface-freeze, p0, p1, p2, p3, p4, p5]
---

# Goal 长期执行飞轮 (意图 + 执行机制)

> 一句话: 飞轮**不是给产品加的功能**, 而是把**人的长期意图**持续执行下去的**机制 (引擎)** ——
> 把**已经有但没收敛**的能力收敛成这台引擎, 而不是再造一个更大的 Agent 平台。
>
> **意图是一等输入**: 人的意愿先于代码 (仓库原则 `Idea / Intent` 优先于 `Code`)。
> **Goal 是意图的可执行投影** —— 意图由人写下、可更新、可撤销; Goal 是它落到可运行判据上的那一份。
> 所以本页写的是「**意图 + 执行机制**」, **不是**产品功能清单, **也不是**产品路线图。
> 本轮只做两件事: ① 把机制落进 wiki ② **冻结接口类型** (不接实现, 不改现有调用方)。

## 意图的落位 (意图 → Goal → continuation → Run → Memory/Skill → 下一次执行)

```
意图 (Intent) → Goal → continuation → Run → Memory / Skill → 下一次执行
 人写, 可改可撤   投影     调度        执行      复用资产        下一次不再从零
```

| 层 | 是什么 | 谁能改 |
| --- | --- | --- |
| **意图 (Intent)** | 人的意愿本身 (要什么 / 为什么 / 到什么程度算成) 以及意愿的**变更与撤销** | **只有人**。Agent 只读, **不得自行改意图** |
| **Goal** | 意图的**可执行投影**: 目标 + 完成判据 + 预算 + 权限 + 范围 | Agent 可提候选; 判据/预算/权限/范围的变更按 P4 规则走 (见 §9) |
| **continuation** | 回答「下一步是什么 / 何时继续 / 为何继续 / 谁来继续」 | Agent 可自动写 (**不改意图, 不改完成判据**) |
| **Run** | 一次有限执行片段 (有始有终; 不把长期意图做成一条超长 Run) | Agent 自主 |
| **Memory / Skill** | 复用资产: 事实 / 教训 / Skill 改进候选 | 事实与教训可自动写; **正式 Skill 变更需批准** (见 §6) |
| **下一次执行** | 下一次从 Memory/Skill 起步, 而不是从零 | —— |

三条纪律:

1. **意图可以更新, 也可以撤销**; 意图的变更**不等于** Goal 的变更。
2. **意图级变更高于 Goal 级变更**: 现有 P4 的 `GoalChangeRequest` (见 §9) 只管 **Goal 级** (优先级 / 判据 / 预算 / 权限 / 范围 / 中止);
   **意图级变更需要单独一层, 由人确认** —— Agent 不得自行改意图, 也不得把「执行起来方便」当成改意图的理由。
3. **意图被撤销后 Goal 不许继续跑**: 落到 `abandoned` / `needs_human`, 且**不许悬空** (与 §9 的 `GoalContinuationEnvelope` 同一条纪律); 已发生的历史 Run 不被改写 (P4 规则 4)。

一句话记住: **引擎执行意图, 不生产意图** —— 飞轮跑得再久, 也不许自己长出新的意图。

> 本轮**不新增意图层的类型**: 先把落位写清; 意图层的类型等有真实需要时**单独一次提交**冻结 ——
> 与 `types.ts` 改接口同样的纪律 (见 §13 补充规则)。

## 1. 飞轮 (一轮执行的生命周期)

下面是「意图的落位」那条链里 **Goal → continuation → Run → Memory/Skill → 下一次执行** 那一段怎么转起来
(意图本身不在这一层被改写):

```
目标 → 判断下一步 → 自主决定节奏 → 执行或派遣 → 监控阻塞 → 动态注入新要求
     → 汇总结果 → 写入 Memory → 形成 Skill 改进候选 → 下一次直接复用
```

飞轮的判据只有一条: **下一次是不是真的更容易/更省** (有没有 Memory 可复用、有没有 Skill 候选可晋升、
有没有说清下一步是谁做什么)。**「继续运行」本身不算进展**。

## 2. 现状: 已经有的引擎零件 (收敛对象, 不是从零开始)

| 能力 | 落在哪 |
| --- | --- |
| Goal / Run / Checkpoint / Recovery 状态机 | `src/agents/goal-store.ts` · `run-store.ts` · `docs/wiki/durable-run-protocol.md` |
| ExecutionSupervisor + 跨进程 lease | `src/agents/execution-supervisor.ts` · `supervisor-host.ts` |
| Goal continuation / 外部事件等待 | `goal-store.ts` 的 `GoalContinuation` · `external-events.ts` · `goal-event-bridge.ts` |
| Skill Manager / skill-writer | `skills-manager.ts` · `skill-writer.ts` · `skill-readiness.ts` · `skill-supervisor-link.ts` |
| Memory compressor / recall | `memory-recall.ts` · `src/agents/memory-*` |
| delegate 真执行 | `agent-delegate-server.ts` · `scripts/verify-agent-delegate-real.ts` |
| Watchdog / heartbeat | `supervisor-host.ts` 心跳 · `scripts/verify-*.ts` 的进程存活检查 |
| reviewFinal | `pi-harness.ts` 的 `sessionEnd` / `reviewFinal` |
| Task group / 任务公告 | `task-group.ts` · `task-board.ts` |

## 3. 四套**没收敛**的引擎能力 (缺口)

| # | 缺口 | 现在的样子 |
| --- | --- | --- |
| ① | Goal/Supervisor 的**节奏** | 由**固定次数 / retry 上限**控制 (第 N 次失败 → needs_human), 不是由进展控制 |
| ② | Run 收尾 | 有 review + skill-writer, 但**不是强制流水线** (成功时走, 失败/中断恢复时可以不走) |
| ③ | Memory | 能压能召回, 但**不是每次任务结束的必经步骤** |
| ④ | Subagent | 能派遣, 但缺**统一任务合同 / 心跳 / 阻塞上报 / 变更注入 / 最终汇报**; 子只回一段文本也能算数 |

---

## 4. P0 — 节奏由进展决定

**引入状态** (`ContinuationState`):
`progressing` / `blocked` / `waiting_external` / `waiting_agent` / `needs_decision` / `no_progress` / `completed` / `failed`

**每个 Run 结束产出结构化 `ContinuationDecision`** (至少这些字段, 缺字段 = 收尾没做完):
`decision` (`continue` / `wait` / `delegate` / `ask_human` / `complete` / `fail` / `pause`) · `reason` ·
`nextAction` · `expectedOutcome` · `confidence` · `progressDelta` · `unresolvedItems` · `wakeAt` ·
`requiredCapability` · `riskLevel` (+ `state` · `stopReason` · `evidenceRefs`)

**判定规则**:

- **有进展 → 继续** (进展 = 新的可核验证据 / 新的完成判据, 见 `ProgressDelta`)
- **等外部 → `awaiting_external`**, 由事件或 `wakeAt` 唤醒
- **连续无新证据 / 无新完成判据 → `stalled` → `needs_human`**
- **继续没有价值 → Agent 交 `stop_reason`** (`no_value_continuing` / `objective_unreachable` / `duplicate_work` / `out_of_scope`), 由 Supervisor 负责**真的停**

**保留三类硬底线** (`HardLimits`): 单 Run 时间上限 · 单 Goal 预算上限 · 无进展熔断阈值。
它们是**安全底线, 不是任务节奏**。**不再以「第几轮」作为主要继续依据。**

## 5. P1 — 强制收尾飞轮

Run 结束顺序**固定** (`RunClosureStep`):

```
主执行结束 → 读完整步骤与证据 → Final Review → 提取事实/教训/Skill候选 → 写 Memory
→ 写 Skill Candidate → 更新 Goal continuation → 生成用户汇报 → 决定是否继续
```

**成功 / 失败 / 中断恢复后的 Run 都必须走这条流水线** (不能只在成功时走)。

四类产物 (`ClosureArtifact`):

| 产物 | 内容 |
| --- | --- |
| **事实** | 写入 Memory: 发生了什么 / 哪些证据已确认 / 哪些**只是推测** |
| **教训** | 什么方法有效 / 什么方法失败 / 下次改什么 |
| **Skill 改进候选** | **仅**当: 重复出现 + 可复用 + 边界清晰 + 输入输出明确 + 有真实成功证据。**一次偶然成功不得直接成正式 Skill** |
| **下一步建议** | 下次先做什么 / 为何 / 等什么 / 需哪个 Agent 与 Skill |

## 6. P1b — Memory 分层 + Skill 更新流程

**Memory 分层** (`MemoryLayer`, 判别联合 `MemoryRecord`):

| 层 | 谁能写 | 关键约束 |
| --- | --- | --- |
| `run_fact` | 每次可自动写 | 必须区分 `confirmed` / `inferred` (推测**永不**当证据) |
| `lesson` | 需 Review 判为可复用 | 带 `reviewedBy` + `reviewVerdict` |
| `decision` | 涉用户偏好或重要取舍 | **必须保留来源** (`sourceRef` 必填) |
| `skill_signal` | 只生成候选 | `promotesDirectly: false` (类型级) |
| `temporary` | 自动写 | 任务结束**自动过期归档** |

**Skill 更新流程** (`SkillUpdateStep`):
`Run evidence → Review 提取候选 → 与现有 Skill 做相似度/版本比较 → 候选验证 → 新版本草案 → 跑 Skill 验收 → 批准后启用 → 写 contentHash + 变更原因`

- **自动更新不得覆盖正在执行的 Skill snapshot**: 当前 Goal 继续用**原版本**, 新版本只影响**下一次 Run** (`SkillPromotionRecord.snapshotScope = 'next_run_only'`)。
- **防 Skill 垃圾** (`SkillJunkReason`): 只成功一次 / 无明确输入输出 / 依赖临时路径 / 无失败边界 / 结果不可验证 / 只是一句经验 / 与已有重复 —— **均不得成 Skill**。
- 正式变更必须有: `sourceRunIds` · `evidenceRefs` · `failureCases` · `inputSchema` · `outputSchema` · `guarantees` · `doesNotGuarantee` · `contentHash` · `approval`。

命名说明: 本飞轮的候选类型叫 **`SkillImprovementCandidate`**, 刻意**不叫** `SkillCandidate` ——
后者已属于 `skill-writer.ts` 的 run-end 文本候选 (name/description/body/source/signature), 两者不是同一个东西。

## 7. P2 — 子 Agent 工作合同 (`AgentWorkContract`)

合同字段: `workId` · `goalId` · `parentRunId` · `childAgentId` · `capability` · `objective` · `inputs` ·
`allowedTools` · `budget` · `deadline` · `successCriteria` · `reportSchema` · `heartbeatIntervalMs` ·
`failurePolicy` · `cancelPolicy` · `requiredEvidence`

**子 Agent 不能只回一段文本** —— 必须回 (`AgentWorkReport`):
`status` · `summary` · `evidence` · `artifacts` · `checks` · `unresolvedItems` · `blockReason` · `nextRecommendation` · `duration`

职责划分:

| 父负责 | 子负责 | 子**不得** |
| --- | --- | --- |
| 目标拆解 / 分配 / 合并 / 最终判定 / 汇报 | 单一明确子目标 / 只用合同允许的工具 / 定期心跳 / 主动报阻塞 / 结构化结果 | 改父 Goal 状态 / 自行扩预算 / 派生无限子任务 / 把未验证结果标完成 / 私改成功判据 |

## 8. P3 — 阻塞监控 (`WorkMonitor`)

**现有 Watchdog 只看进程存活, 不等于看任务是否卡住** —— 这是本层存在的原因。

`BlockKind`: `no_heartbeat` · `waiting_dependency` · `repeated_failure` · `no_progress` · `tool_blocked` ·
`budget_blocked` · `permission_blocked` · `runner_unavailable` · `external_timeout` · `report_missing`

每种阻塞必带 (`BlockRecord`): `blockedAt` · `lastProgressAt` · `owner` · `dependency` · `suggestedAction` · `escalationAt`

处理规则:

| 情形 | 处理 |
| --- | --- |
| 子无心跳 | 标 `stalled` → **先查 lease** → 可接管则接管 / 不可则上报父 |
| 子无进展 | **先发一次调整指令** → 仍无进展则停或替换 |
| 报告不完整 | **不接受为完成** → 要求补充 → 超时转 `needs_human` |
| 工具/资源被阻 | 明确 `blockKind` → 允许父改计划 → **不自动绕过 Harness** |

**用户可见只暴露五类** (`UserVisibleState`): 正在执行 / 等待外部回复 / 子 Agent 被阻塞 / 暂时没有进展 / 需要你决定。
(`lease` · `reducer` · `internal status` · `retry counter` · `worker owner` **不出现**在用户视野。)

## 9. P4 — 新要求注入 (`GoalChangeRequest`) 与 P4b 两份输出

`GoalChangeRequest` 字段: `changeId` · `goalId` · `source` · `instruction` (原文逐字) · `priority` · `scope` ·
`effectiveAt` · `requiresReplan` · `status` (+ `kind` · `impact` · `interpreted`)

流程: 接收 → 记录原文与来源 → 判断是否影响目标/判据/预算/权限 → 生成变更摘要 →
评估当前 Run 是否继续 → 必要时暂停 → 重新规划 → 写入下一 Run。

分类 (`ChangeKind`): `clarification` / `priority_change` / `success_criteria_change` / `budget_change` /
`permission_change` / `scope_expansion` / `scope_reduction` / `abort`

规则 (`GoalChangeRule`):

1. **用户明确撤销优先级最高** (`user_revocation`)
2. **扩预算不得由 Agent 自动批准**
3. **改完成判据必须增版本号**
4. **当前 Run 历史不可被新要求改写** (新要求只影响后续)
5. **子 Agent 必须收到变更版本**

**P4b 收尾后两份输出**:

- **用户汇报** (`UserReport`): 当前结论 / 已完成 / 证据 / 仍未完成 / 阻塞原因 / 下一步 / 是否会继续 / 预计何时继续 —— **不得暴露** lease · reducer · internal status · retry counter · worker owner
- **机器继续记录** (`GoalContinuationRecord`, 写进 Goal continuation): `nextAction` / `wakeAt` / `wakeReason` /
  `autoContinue` / `requiredAgent` / `pendingReports` / `unresolvedItems`

**Goal 不允许进入「没有下一步」的悬空态**: 只有 `completed` / `failed` / `abandoned` / `needs_human` 可结束;
其余必须回答 **下一步是什么 / 何时继续 / 为何继续 / 谁来继续** (类型级表达见 `GoalContinuationEnvelope`)。

## 10. P5 — 统一长周期验收 (后续阶段跑, 本轮不跑)

| # | 用例 (`LongRunAcceptanceCase`) |
| --- | --- |
| 1 | 不设最大轮次, 按证据自行结束 |
| 2 | 无进展自动熔断 |
| 3 | 子 Agent 被阻塞 → 被发现 / 接管 / 升级 |
| 4 | 用户中途注入新要求 → 下一 Run 生效 |
| 5 | Run 结束自动写 Memory + Skill Candidate |
| 6 | 汇报后按 `wakeAt` / 事件自动继续 |
| **强负例 7** | 子 Agent 返回漂亮但**无证据**的结果 → 父 Goal **不完成** |
| **强负例 8** | Skill Candidate 只有一次偶然成功 → **不得**自动晋升正式 Skill |

> **M5 真跑验收 (2026-09-25 已完成)**: 上面这 8 条设计用例的**真跑版**落在 `scripts/acceptance/m5/` 的 10 个场景脚本里
> (真 Goal/Run Store + 每场景隔离 HOME + **注入时钟**), 结果与 **7 个真缺陷台账** 见
> [goal-flywheel-m5-acceptance-report.md](./goal-flywheel-m5-acceptance-report.md)。
> **本节设计口径一字未改** —— M5 真跑是执行证据, 不是新的设计约定。

## 11. 不做 (`FlywheelNonGoal`)

无限自主 Agent 群 · 自动生成大量子 Agent · 多级递归派遣 · Agent 自己管理 Agent 市场 ·
自动把所有结果写成 Skill · 自动覆盖正式 Skill · 无证据的智能评分 · 复杂 PM 看板 ·
多种任务数据库 · 另起 workflow engine · 以固定轮次伪装长期执行 · 用"继续运行"代替真实进展。

另有一条**框架上的不做**: 不把飞轮排成**产品功能项 / 产品路线图** —— 它是服务意图的**引擎**,
不按功能清单排期, 也不因为"能列进功能表"就去做 (见开头「意图的落位」)。

---

## 12. 接口冻结 (本轮已落地)

| 文件 | 内容 |
| --- | --- |
| `src/agents/goal-flywheel/types.ts` | 全部冻结类型 + 文档注释 (**零 import / 零 function / 零 async**) |
| `src/agents/goal-flywheel/index.ts` | 只做 `export * from './types.js'` |
| `src/test/goal-flywheel-types.test.ts` | 纯类型/不变式门 (**201** 条): 枚举完备性 · 必备字段不为 optional · 与现有类型不冲突 · 冻结层纯度 |

冻结的类型清单: `ContinuationState` · `ContinuationDecision` · `ProgressDelta` · `StopReason` · `HardLimits` ·
`RunClosureStep` · `ClosureArtifact` · `MemoryLayer` · `MemoryRecord` (判别联合 5 支) · `SkillJunkReason` ·
`SkillImprovementCandidate` · `SkillApproval` · `SkillPromotionRecord` · `AgentWorkContract` · `WorkBudget` ·
`ChildFailurePolicy` · `ChildCancelPolicy` · `AgentWorkReport` (含 `WorkEvidence` / `WorkArtifact` / `WorkCheck`) ·
`ChildProhibition` · `BlockKind` · `BlockRecord` · `BlockResolutionAction` · `UserVisibleState` ·
`GoalChangeRequest` · `ChangeKind` · `ChangeImpact` · `ChangeScope` · `GoalContinuationRecord` ·
`GoalContinuationEnvelope` · `UserReport` · `LongRunAcceptanceCase` · `FlywheelNonGoal`

**与现有类型的关系 (被门钉住, 不是嘴上说兼容)**:

- `goal-store.ts` 的 `GoalContinuation` 与 `GoalContinuationRecord` **共享调度核心**
  (`nextAction` / `wakeAt` / `wakeReason` / `autoContinue` / `updatedAt`), 旧类型可**整体读作**新类型;
  新类型新增 `requiredAgent` / `pendingReports` / `unresolvedItems` / `lastDecisionId` / `state` —— **只加不减, 不撞名**。
- `GoalStatus` ↔ `GoalLifecycleState`: 差集**恰好**是 `'open'` (还没起第一个 Run 的状态)。
- `contacts/policy.ts` 的 `BlockKind` (联系方式策略拒绝原因) 与本页的 `BlockKind` (长期执行阻塞类型)
  **同名不同域, 取值完全不相交, 永不合并**。
- `skill-writer.ts` 的 `SkillCandidate`(文本候选)**不满足**本模块的晋升契约, 且本模块**不再导出**同名类型。

## 13. P1–P4 的文件所有权划分 (避免并行冲突)

| 阶段 | **独占**新建 (只准自己写) | **不许碰** |
| --- | --- | --- |
| **接口冻结 / P0** | `src/agents/goal-flywheel/types.ts` · `index.ts` · `src/test/goal-flywheel-types.test.ts` | 其余全部 |
| **P0 节奏** | `continuation-decision.ts` · `src/test/goal-flywheel-continuation.test.ts` | `types.ts` · 其它阶段文件 · 现有调用方 |
| **P1 收尾** | `run-closure.ts` · `src/test/goal-flywheel-closure.test.ts` | 同上 |
| **P1b Memory/Skill** | `memory-layers.ts` · `skill-candidate.ts` · `src/test/goal-flywheel-memory.test.ts` · `src/test/goal-flywheel-skill-candidate.test.ts` | 同上 |
| **P2 合同** | `work-contract.ts` · `src/test/goal-flywheel-contract.test.ts` | 同上 |
| **P3 阻塞** | `work-monitor.ts` · `src/test/goal-flywheel-monitor.test.ts` | 同上 |
| **P4 变更** | `goal-change.ts` · `src/test/goal-flywheel-change.test.ts` | 同上 |
| **接线 (改现有调用方)** | — | **由 P1 独占且最后做**: `execution-supervisor.ts` · `goal-store.ts` · `pi-sdk.ts` · `skills-manager.ts` · `watchdog/心跳` · Web/CLI 视图。理由: 四个阶段同时改这几个文件必冲突 |

补充规则:

- `types.ts` 是**冻结面**: P1–P4 只读不写。真要改接口 → 单独一个提交, 且必须同时更新 `goal-flywheel-types.test.ts` 的计数。
- 每个阶段只 append **自己**的文件 + **自己的**测试 + `docs/wiki/log.md` 一行; 同一时刻不要让两个 agent 写 `log.md`。
- 阶段之间**只通过 `types.ts` 的类型**耦合 (依赖靠参数注入, 不靠 import 别的阶段的实现文件)。

## 14. 为了让 P1–P4 并行, 先定下的函数签名 (逐条)

```ts
// P0 — continuation-decision.ts
export function decideContinuation(input: {
  goal: GoalRecord; run: RunRecord; now: IsoTimestamp;
  progress: ProgressDelta; noProgressStreak: number; hardLimits: HardLimits;
}): ContinuationDecision;
export function applyHardLimits(d: ContinuationDecision, limits: HardLimits): ContinuationDecision; // 只能收紧
export function isRunnable(d: ContinuationDecision, now: IsoTimestamp): { runnable: boolean; reason: string };

// P1 — run-closure.ts (依赖全部按参数注入, 不 import 别的阶段的实现)
export function closeRun(input: {
  goalId: string; runId: string; run: RunRecord; finalReview: string; now: IsoTimestamp;
}, deps: {
  writeMemory: (records: MemoryRecord[], now: IsoTimestamp) => Promise<{ written: string[]; rejected: { memoryId: string; reason: string }[] }>;
  writeCandidate: (c: SkillImprovementCandidate) => Promise<string | null>;
  decide: (input: Parameters<typeof decideContinuation>[0]) => ContinuationDecision;
}): Promise<{ steps: RunClosureStep[]; facts: RunFactMemory[]; lessons: LessonMemory[];
  candidates: SkillImprovementCandidate[]; nextStep: string; decision: ContinuationDecision;
  userReport: UserReport; continuation: GoalContinuationRecord;
  skipped: { step: RunClosureStep; reason: string }[] }>;

// P1b — memory-layers.ts
export function writeMemoryRecords(home: string, records: MemoryRecord[], now: IsoTimestamp):
  Promise<{ written: string[]; rejected: { memoryId: string; reason: string }[] }>;
export function expireTemporary(records: MemoryRecord[], now: IsoTimestamp): { kept: MemoryRecord[]; archived: TemporaryMemory[] };

// P1b — skill-candidate.ts
export function assessCandidate(c: SkillImprovementCandidate, existing: { name: string; contentHash: string; version: string }[]):
  { junkReasons: SkillJunkReason[]; promotable: boolean; comparison: 'new' | 'duplicate' | 'version_bump' };
export function draftPromotion(c: SkillImprovementCandidate, existingVersion: string | null,
  changeReason: string, approvedBy: string, now: IsoTimestamp): SkillPromotionRecord;

// P2 — work-contract.ts
export function issueWorkContract(input: { goalId: string; parentRunId: string; childAgentId: string;
  capability: string; objective: string; inputs: Record<string, unknown>; allowedTools: string[];
  budget: WorkBudget; deadline: IsoTimestamp | null; successCriteria: string[]; now: IsoTimestamp; issuedBy: string }): AgentWorkContract;
export function validateChildReport(contract: AgentWorkContract, report: AgentWorkReport):
  { ok: boolean; missingFields: string[]; missingEvidence: string[]; violation: ChildProhibition | null };
export function acceptsAsComplete(contract: AgentWorkContract, report: AgentWorkReport): { accepted: boolean; reason: string };

// P3 — work-monitor.ts (纯函数; 副作用的接管/替换动作由接线层执行)
export function detectBlocks(input: { contract: AgentWorkContract; report: AgentWorkReport | null;
  lastHeartbeatAt: IsoTimestamp | null; lastProgressAt: IsoTimestamp; now: IsoTimestamp;
  leaseOwner: string | null; runnerAvailable: boolean }): BlockRecord[];
export function planBlockHandling(b: BlockRecord): BlockResolutionAction;
export function toUserVisibleState(c: GoalContinuationRecord | null, blocks: BlockRecord[], decision: ContinuationDecision | null): UserVisibleState;

// P4 — goal-change.ts
export function ingestChange(input: { goalId: string; source: ChangeSource; instruction: string;
  recordedBy: string; now: IsoTimestamp }): GoalChangeRequest;
export function classifyChange(r: GoalChangeRequest, goal: { successCriteria: string[]; budget?: unknown }): GoalChangeRequest;
export function applyChange(r: GoalChangeRequest, goal: { criteriaVersion: number }):
  { outcome: 'next_run' | 'pending_approval' | 'rejected'; requiresReplan: boolean;
    nextRunDirective: string; criteriaVersion: number; reason: string };
```

**共同约定 (所有阶段都一样)**: 纯函数优先 · 时间一律 `now: IsoTimestamp` 注入 (不读真实钟) ·
不做 I/O 的函数不许 import `fs` · 返回**结构化原因** (不许只返回 boolean) · 依赖靠参数注入。

## 15. 门禁 (本轮)

`npx tsc --noEmit` · `npx vitest run --bail=1` · `python scripts/wiki_check.py` ·
`python scripts/wiki_lint.py --strict=v2` · `python scripts/raw_manifest_check.py` · `python scripts/supersede_check.py`

后续阶段 (P0–P5) 各自新增验收脚本时, 统一放在 `scripts/verify-goal-flywheel-<阶段>.ts`,
且必须带**阴性对照** (拿掉关键判据要能判红), 不接受"零条目通过"。
