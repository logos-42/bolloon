---
title: Goal 长期执行飞轮 · P5 统一长周期验收 (独立真跑 6 场景 + 2 强负例, 逐条证据 + 已知缺口 + 修复台账)
source: session (leo 2026-09-25 P5 验收线; 设计稿 docs/wiki/goal-continuation-flywheel.md §10 §11 §15)
created: 2026-09-25
last_confirmed: 2026-09-25
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [goal, continuation, flywheel, p5, acceptance, verification, supervisor, work-contract, block-monitor, goal-change, memory, skill-candidate, gap, fix-log]
---

# Goal 长期执行飞轮 · P5 统一长周期验收

> **角色**: 发现者 + (2026-09-25 收口线) 修理工。发现缺陷 → 写清最小复现 + 证据, 然后**修掉能被证明的**,
> 每一处修复都要有 红→绿证据 + 变异验证; 修不掉的如实留在 §2/§5 (不粉饰)。
> **怎么证**: 每个场景都真跑 —— 临时 HOME + 真 `goal-store` / `run-store` / `ExecutionSupervisor` /
> `closeGoalRun` / `work-contract` / `external-events`, 不 stub 被验对象; 树内唯一被替换的是"执行器"
> (由测试注入, 这正是 `GoalRunner` 的设计入口)。**阴性对照**在文件头注释里逐条写明 (把哪一项改掉, 门就该翻红)。
> **修复台账** (§2A): 逐条 改前 → 改后 → 红绿证据 → 变异验证。
>
> 逐条可重跑: `npx vitest run src/test/goal-flywheel-p5-acceptance.test.ts`
> 单场景: `npx vitest run src/test/goal-flywheel-p5-acceptance.test.ts -t "P5-③"`
> 页面真 DOM: `npx tsx scripts/verify-goal-flywheel-p5-ui.ts` (退出码 0 全过 / 2 环境不满足)

## 0. 这一页的判定口径

| 口径 | 含义 |
| --- | --- |
| **通过** | 场景要求的行为在真跑里出现, 且有**可重跑**的断言 (含"反例不成立"的对照) |
| **不通过** | 要求的行为在真跑里**没有**出现 (有最小复现) |
| **跑不了** | 环境/前置条件不满足, 明确写清为什么 (不拿"看起来对"顶替) |
| **缺口** | 要求的行为**一半成立** (例如: 发现成立、处置不落地) —— 记进 §已知缺口, 不粉饰 |

## 1. 逐场景结论 (八个场景)

### ① 不设最大轮次, 按证据进展自结束 —— **通过**

- **怎么造的**: 3 个判据的 Goal; 执行器每轮用真 `markCriterion` 满足**一条**判据 + `addRunEvidence`
  写一条 Run 级证据 (真进展)。同一个 Goal 形状跑三遍, 只改 `maxRetries` = **0 / 1 / 5**。
- **看了什么证据**: 三种轮次上限下**结论完全一致** —— 都是 3 个 Run 走完, 收尾决策序列
  `continue → continue → complete`, 最终 `status=completed`; 两条 `continue` 的 reason 都指向
  "新的可核验进展/新增证据", `complete` 的 reason 指向"完成门通过"。
- **反证 (关键反问的答案)**: 同一形状的 Goal, 执行器**不产证据**时, 把轮次上限抬到 50 也**完不成**
  (`status≠completed`, 判据一条都不会自己变满足); 上限 = 1 时更早判停。
  ⇒ 结论随"有没有新证据"变, **不随轮次上限变** —— 不是碰巧撞上固定次数。
- **能独立重跑**: 是 (用例内两个 `it`)。

### ② 无进展自动熔断, 不无限循环 —— **通过**

- **怎么造的**: 判据永远不满足 + 执行器每轮 `failed` 且**零 ok 步骤**(= 零证据); `maxRetries=2`
  ⇒ 熔断阈值 = 3 (默认 `HARD_LIMIT_DEFAULTS.noProgressCircuitBreaker`)。
- **看了什么证据**: Goal 走到 `needs_human` + `continuation.autoContinue=false` + `state=needs_human`;
  决策记录里那条 `state='no_progress'` 的 reason 明确写"**熔断**"、"**无进展**"、"**第几轮本来就不是继续的依据**",
  `noProgressStreak=3` (锚在证据链上, 不是计数器); 熔断后再 tick 三次: `executed=0`, `runs` 数不变
  (不空转、不烧轮次)。
- **能独立重跑**: 是。

### ③ 子 Agent 阻塞: 被发现 / 有处置 / 不越权接管 —— **通过** (注: 处置动作大多「只记账」= 缺口 4, **未修**)

四种情形都在真 API 上跑过 (`dispatchChildWork` → 真合同 → `collectWorkBlocks` → `applyBlockHandling`):

| 情形 | 怎么造 | 结论 |
| --- | --- | --- |
| 心跳停 + 执行权**被占** | 合同发出后从不写心跳; `claimGoal` 真持 1h 租约 | 抓到 `no_heartbeat`; `dependency='互斥执行权正在被占用'`; 动作 = `escalate_parent`, **不是** `takeover`; Goal → `needs_human` + `unresolvedItems` 记名 |
| 心跳停 + 执行权**空闲** | 同上但不占租约; 真合同的 `failurePolicy.onHeartbeatMiss` | 真合同策略是 `'stall'` ⇒ 仍只 `escalate_parent`。**接管**要用 `onHeartbeatMiss='takeover'` 的合同才走到 (用真 `detectBlocks` 验证该分支确实给 `takeover`) ⇒ 真签发路径产不出这种合同, 接管分支**可达性低** |
| 有心跳但无进展 | 心跳正常 (199s 前), 无进展窗口 = `heartbeatIntervalMs*6` = 180s | 第一档 (200s) = `send_adjustment`; 第二档 (400s > 2×窗口) = `replace_child` |
| 报告缺失 | 到期未回 (宽限 60s 内 / 超宽限 3 倍) / 报告回来但**无逐条证据** | 宽限内 = `request_report`; 超宽限 = `needs_human` 且 Goal 真升级; "自称完成但零证据"仍判 `report_missing`, note 明写"**不接受为完成**" |

- **能独立重跑**: 是 (四个 `it`)。

### ④ 用户中途注入新要求, 下一 Run 采用 —— **通过**

- **怎么造的**: 真 Run 跑完一轮 → `ingestGoalChange(原话, source='user')` → 再 tick。
- **看了什么证据**: ① 原话**逐字**进 `persistedPath` 的变更档案; ② 第二个 Run 的执行指令里**真含原话**
  (并且带"只影响后续 Run"的条款); ③ **当前 Run 的记录逐字节不变** (前后 JSON 字符串相等,
  注入后再次比对仍然相等); ④ 放宽类 (agent 提"把预算上限提高到 999 个 Run") ⇒
  `outcome=pending_approval` + `requiresReplan=true` + reason 点名规则 `[agent_cannot_approve_budget]`,
  Goal 的 `budget` 逐字节不变、判据版本不变、"下一 Run 指令"不含 999; ⑤ 用户撤销 ⇒
  `abandoned` + `autoContinue=false`, 之后再 tick `executed=0`。
- **能独立重跑**: 是。

### ⑤ Run 结束自动写 Memory + Skill 候选 (成功 / 失败 / 中断恢复三条路径) —— **通过** (候选落盘原为缺口 5, 已修)

- **怎么造的**: 三条真实路径各一条 Run —— 成功 (`done`) / 失败 (`failed` + 失败步骤) /
  **中断恢复** (`interrupted` + 真 `recordRecovery({errorClass:'crash'})`), 都调 `closeGoalRun`。
- **看了什么证据**: 三条路径**都**产出: 9 步流水线顺序与 `RUN_CLOSURE_STEPS` 完全一致;
  `run_fact` / `lesson` / `skill_signal` 三个 Memory 层目录真的落文件 (中断路径以恢复记录进 `run_fact`,
  且文件数比失败路径多); 用户汇报 JSON 的 `visibleState` 落在六类枚举内、且**不含** `MUST_NOT_EXPOSE_FIELDS`;
  决策记录落盘。候选对象带齐冻结契约字段
  (`sourceRunIds/evidenceRefs/failureCases/inputSchema/outputSchema/guarantees/doesNotGuarantee/contentHash/approval`),
  `sourceRunIds` = 真 runId, `approval.state='not_requested'`。
- **快照保护**: 真建一份"正在执行的 Skill" (`~/.bolloon/skills/<name>/SKILL.md`), 记 sha256 前缀;
  写入候选后 —— `appliesToRunningRun=false`、`snapshotScope='next_run_only'`、
  `runningSnapshotHash` = 该前缀, 且 `SKILL.md` **逐字节未变**、`skills/` 目录无新增文件。
- **能独立重跑**: 是 (三个 `it`)。

### ⑥ 汇报后按 wakeAt / 事件自动继续 —— **通过** (时间型 / 事件型 / 手动唤醒 / 长等待 四条都绿; 手动唤醒与长等待原为缺口 1/2, 已修)

- **时间型 (通过)**: `wakeAt = now+10min` ⇒ 未到点 tick `executed=0` 且 skipped 写明未到唤醒时间;
  到点 (=+11min) 后同一个 Goal 真开下一个 Run (`runs: 1 → 2`)。
- **事件型 (通过, 走真协议)**: `bindExternalWait` 绑定等待 (requestId/continuationId/来源/过期) → 连续 3 次 tick
  `executed=0` (**不空转**、不烧轮次), 飞轮对"没有 wakeAt 的等待"的裁决是 `wait` + `runnable=false`
  + "只能由事件唤醒"; 真 `deliverExternalEvent` 投递 → `delivered`, Goal `status: awaiting_external → active`,
  事件写成 Goal 证据 → 下一 tick 真开新 Run。**等待不会无限等**: 等待过期后 tick 开头把它转成
  `needs_human` + `autoContinue=false` + 证据记"外部事件超时"。
- **汇报自洽**: `closeGoalRun` 对等外部的 Run 给出 `decision=wait`, 机器继续记录 `wakeAt` 与用户汇报的
  `expectedResumeAt` **同值**, `autoContinue=true`。
- **原先不通过的两条 (已修, 见 §2A-1 / §2A-2)**: 手动唤醒 (`notifyExternal`, 即 CLI `/wake` 与 `POST /api/goals/:id/wake`) 与 **超过 30 分钟的长等待** —— 两条现在都断言修复后行为, 并各带一条阴性对照: 手动唤醒 ⇒ 盘上 status/state 拉回 active 且下一 tick 真跑 (而「还在 running 的超长 Run」照样交人); 长等待 ⇒ 40 分钟后事件按时到达即 executed=1。
- **能独立重跑**: 是 (五个 `it`; 原两条「缺口记录」已翻成断言修复后行为)。

### ⑦ 强负例: 子回报漂亮但无证据 → 父 Goal 不完成 —— **通过 (两条独立路径)**

- **路径 A (直调合同门)**: `validateChildReport` 判 `mark_unverified_as_complete`,
  `acceptsAsComplete=false`, `handleChildReport` 给 `outcome='incomplete'`;
  父 Goal `status≠completed`, 且 `completeGoalIfEligible` 明确 false, `pendingReports` 里留着这条工作。
  **正控**: 按合同协议把 `requiredEvidence` 逐条填进 `evidence`、按 `successCriteria` 逐条 `pass` ⇒ 立刻 `accepted=true`
  (证明这门不是永远判红)。
- **路径 B (SubAgentManager 真路径)**: `delegateTask(..., {goalId, successCriteria})` 真签合同 →
  回一句"全部做完了, 一切顺利, 质量很好, 可以直接合并" ⇒ 任务**不**被标完成 (`status≠completed`,
  `error` 含"不接受为完成"), 父 Goal `pendingReports` 留名; 换成带 `workId/checks/evidence` 的 JSON 报告 ⇒ 真完成,
  `pendingReports` 清掉。
- **能独立重跑**: 是。

### ⑧ 强负例: 只有一次偶然成功的 Skill 候选不得转正 —— **通过**

- **怎么造的**: 候选 `occurrences=1`、`boundaryClear=false`、无 IO schema、无 failureCases、`evidenceRefs=[]`、
  `contentHash=null`。
- **看了什么证据**: `assessCandidate.promotable=false`, 垃圾理由含 `single_success` / `no_io_schema` /
  `no_failure_boundary`; `writeSkillCandidate` 返回 `null` ⇒ 盘上 `skill-candidates/` 与 `skills/` **都是空**;
  `draftPromotion` 抛"不得晋升"; 收尾流水线对同一份评审给出 `status='rejected'` + `candidatePaths=[]`
  + skipped 记 `no_promotable_candidate`。**对照**: 同形状但 `occurrences=3` + IO/边界齐的候选,
  `promotable=true` (门不是永远拒绝)。
- **能独立重跑**: 是。

## 2. 已知缺口 (逐条: 最小复现 + 证据 + 建议修法)

> 本节是**发现时**的原始记录 (最小复现 + 改前证据), 原文保留 —— 它同时是每一处修复的"改前"基线。
> **哪些已经修掉、怎么修、红→绿证据与变异验证** → 见 §2A 修复台账。
> 缺口 1 / 2 / 3 / 5 + 原话条款 (真 DOM §3) 已修; 缺口 4 / 6 未修 (原判不动)。

### 缺口 1 (高) 手动 `/wake` 只清等待事实, 不改 `goal.status` ⇒ 唤醒后目标仍跑不动 —— **已修 (§2A-1)**

- **复现**: Goal 处于 `awaiting_external` + `continuation.needsExternal` → `supervisor.notifyExternal(goalId)`
  (CLI `/wake`、`POST /api/goals/:id/wake` 走的都是它) → 再 tick。
- **证据**: `notifyExternal` 返回 true、`wakeReason='active'`、`needsExternal` 已清, 但
  `goal.status` **仍是** `awaiting_external` ⇒ tick `executed=0`, skip 理由
  `awaiting_external: 等外部事件, 不重复发送`; 飞轮 preflight 同时给 `wait` + `只能由事件唤醒` (自相矛盾)。
  真 DOM 侧同样观测到: 页面点「唤醒」→ 接口回话 `{ok:true, woke:true, note:'已唤醒: 下一次 Supervisor tick 会推进它'}`,
  而页面刷新后该行**仍显示"等外部回复"**, 盘上状态也仍是 `awaiting_external`。
- **对照 (说明不是"等待机制本身不行")**: 走真事件协议 `deliverExternalEvent` 会把状态拉回 `active` (见场景 ⑥)。
  ⇒ 两条唤醒路径行为**不一致**: 事件投递会改状态, 手动 `/wake` 不会。
- **复跑**: `-t "手动 /wake"` (用例名已从"缺口记录"翻成断言修复后行为; 改前红/改后绿见 §2A-1)。
- **建议**: `notifyExternal` 里对齐 `deliverExternalEvent` 的做法 —— 若 `status ∈ {awaiting_external, retry_wait, recovering}`
  则 `updateGoal(status='active')`, 并把 `continuation.state` 从 `waiting_external` 拉回 `progressing`。

### 缺口 2 (高) 单 Run 时间上限用 `now - run.startedAt` 算, 已结束的 Run 也算 ⇒ 长等待 (>30min) 永远醒不过来 —— **已修 (§2A-2)**

- **复现**: Goal 有 1 条**已结束**的 Run; 绑定外部等待 (TTL 6h) → 40 分钟后事件**按时到达** (`delivered`) → tick。
- **证据**: `executed=0`, 决策记录 reason:
  `本轮已超出单 Run 时间上限 (5459999ms > 1800000ms, 从 <run.startedAt> 到 <now>)`,
  `runnable=false`; 再等 2 小时仍 `executed=0` (`runs` 停在 1)。
- **为什么严重**: 任何"等待 > 30 分钟"的自动化都失效 —— 包括 `wakeAt` 设得远一点的定时继续、
  等一个慢对端的 P2P 回执。表面上 Goal 还在 `active`, 实际每个 tick 都被判"本轮超时"并交人;
  而"交人"这条路径不会自己恢复。
- **复跑**: `-t "超过单 Run 上限"` (同上: 已翻成断言修复后行为, 并带阴性对照 "还在跑的 Run 超时照样交人")。
- **建议**: 判定用 `(run.finishedAt ?? now) - run.startedAt` (已结束的 Run 用真实时长), 或只对
  `status ∈ {queued, running}` 的 Run 计龄; 等待态 (waiting) 由 `wakeAt` / 事件负责, 不该被 Run 时长兜底。

### 缺口 3 (中) 真实运行里"合同签发 / 回报核验"这条链**是空转的** —— **已修 (§2A-3, 四处)**

自报弱项复核 —— **定论: 成立**。三条独立证据:

1. **飞轮要派遣, 但真 tick 里被技能门禁截断**: 目标声明一个本节点没有的能力 ⇒ `decideGoalStep`
   给 `delegate` + `requiredCapability` + `runnable=true`, 但真 tick 的结果是
   `status='blocked_by_skills'`、Goal → `needs_human`、skip 理由"技能未就绪: 必需技能缺失";
   `report.workContracts` 空、`.bolloon/goal-works/` 目录都**没被创建** ⇒ 一条合同都没签发。
2. **阻塞巡检没有输入**: 普通 Goal 真跑一轮后, `report.blocks=[]`、`continuation.pendingReports=[]`;
   全仓唯一会写 `pendingReports` 的地方只有 `dispatchChildWork` (即 ① 那条被门禁截断的路)。
3. **唯一的生产派遣调用方不传 `goalId`**: CLI `--delegate` 用 `manager.delegateTask('cli-user', task, caps)`
   五参形状 ⇒ `workContract === undefined`; 运行时复现: 一句"全部做完了"即可把任务标成 `completed`
   (合同门完全不生效)。源码级扫描 (非测试 `.ts`) 里 `contractOptions` / `DelegateContractOptions`
   只出现在 `agents/subagent-manager.ts` 自己 —— **没有任何调用方传**。

- **复跑**: `-t "① 飞轮要 delegate"` / `-t "③ CLI --delegate"` (原"额外必查"三条已翻成断言修复后行为)。
- **建议**: ① 让缺技能时的 `delegate` 决策能真的走到签发 (或明确"派遣需要人先批技能", 别让 `runnable=true` 骗人);
  ② CLI/网页的 delegate 入口把 `goalId` 传下去; ③ 否则 P2/P3 两层的自动化在真路径上等于零 —— 现在只有单测在证明它们。

### 缺口 4 (中) 处置动作大多"只记账, 不落地" —— **未修**

- **证据**: `applyBlockHandling` 只对 `needs_human` / `escalate_parent` / `change_plan` 真的改 Goal 状态
  (→ `needs_human`) 或清 `pendingReports` (takeover); 而
  `send_adjustment` / `request_report` / **`replace_child`** 只被塞进 `requests` 字符串列表 ——
  **没有**真的下发调整指令、**没有**真的换人、**没有**重派新合同 (第二档"换人"用例里: Goal 状态不变、
  `pendingReports` 数不变、work 目录文件列表逐项不变)。
- **含义**: "被发现"是真的, "处置"目前是"记下来等人/等父做"。这符合"不越权"的红线, 但要在文档里说清楚,
  否则会被读成"系统会自动换人"。
- **复跑**: `-t "无进展"` (③ 的第三个 `it`)。

### 缺口 5 (低) 收尾提出的 Skill 候选落不了盘 (第二道门以 `contentHash=null` 拒收) —— **已修 (§2A-4)**

- **证据**: 结构化评审 (occurrences=2、边界清晰、IO/失败面齐) 的候选在收尾结果里 `status='draft'`,
  但 `candidatePaths=[]` 且 skipped 记 `candidate_not_written` —— 因为收尾产出的候选 `contentHash` 恒为
  `null`, 而 `assessCandidate` 把 `unverifiable_result` 当垃圾理由。**同一份候选**手工补上 `contentHash`
  后 `writeSkillCandidate` 才落盘 (该路径在 ⑤ 的快照用例里已验证)。
- **含义**: "自动写 Skill 候选"目前只走到"内存里有候选 + skipped 记账", 盘上不留候选;
  对人没有可审的东西 ⇒ 这条自动化实际收益为零。
- **复跑**: `-t "成功路径"` (已翻成"候选真落盘": `status='draft'` + `contentHash` 非空 + `skill-candidates/` 有文件)。
- **建议**: 让收尾真的生成草案并算 `contentHash` (哪怕是最小草案), 或把"缺 contentHash"降级为
  "写入候选但标 `approval.state='needs_approval'`", 而不是静默丢弃。

### 缺口 6 (低, 只是要知道) 两个易误读的语义 —— **未修 (只是要知道, 无需修)**

- `report.executed` 记的是"认领后尝试过的 Goal", **包括被门禁拦下的尝试** (`status='blocked_by_skills'`),
  所以"跑没跑"要看 `runs`, 不能看 `executed.length`。
- `BOLLOON_RUN_FINAL_REVIEW` 这个注入通道**只被 Supervisor 读**; 直调 `closeGoalRun` 必须显式传 `finalReview`
  (否则走"散文评审"分支, 只记"非结构化")。
- `replace_child` / `escalate_parent` 在 Goal 层都收敛到 `needs_human` (父=人) —— 这是当前接线的真实语义。

## 2A. 修复台账 (2026-09-25 P5 收口线: 已修 / 未修 + 改前 → 改后 → 证据)

> 口径: **改前** = §2 那条缺口的最小复现 (就是同一条用例当时的红态); **改后** = 生产代码改动;
> **证据** = 同一处缺口从红翻绿的那条断言 (用例名 / 真 DOM 检查名); **变异验证** = 把改动改坏后,
> 该证据必须立刻翻红 (改坏 → 红 → 恢复), 并附**阴性对照**说明没把不该动的东西一起放宽。
> 全部数字见 §4; 逐条重跑命令见 §2 各条 `复跑`。

| # | 缺口 | 结论 | 红→绿证据 | 变异验证 |
| --- | --- | --- | --- | --- |
| 2A-1 | §2 缺口 1 手动 `/wake` 唤醒空转 | **已修** | `-t "手动 /wake"` + 真 DOM §4 四项 ★ | 删掉状态回拉 → 红 |
| 2A-2 | §2 缺口 2 长等待 (>30min) 醒不过来 | **已修** | `-t "超过单 Run 上限"` | 判龄退回 `now-startedAt` → 红 |
| 2A-3a | §2 缺口 3-① delegate 被技能门禁截断 | **已修** | `-t "① 飞轮要 delegate"` | 门禁不放行 → 红 |
| 2A-3b | §2 缺口 3-① 能力来源断在判定层 | **已修** | 同上 (合同数 ≥1) | 去掉 preflight 回落 → 红 |
| 2A-3c | 合同签发顺序覆盖 `pendingReports` (本轮新发现) | **已修** | 同上 (父 Goal 记下"等回报") | 换回原顺序 → 红 |
| 2A-3d | §2 缺口 3-③ CLI `--delegate` 不传 `goalId` | **已修** | `-t "③ CLI --delegate"` | 去掉第 6 参 → 红 |
| 2A-4 | §2 缺口 5 收尾候选 `contentHash=null` 落不了盘 | **已修** | `-t "成功路径"` | 去掉注入 → 红 |
| 2A-5 | 真 DOM §3 用户原话没进 `nextRunDirective`/`nextAction` | **已修** | `-t "原话逐字入档"` + 真 DOM §3 三项 ★ | 去掉原话条款 → 红 |
| 2A-6 | ① 转义: `/goals` 页内联脚本被 `\'` 截断 | **已修** | 真 DOM 从 12 过/19 败 → 全过 (见 §4) | 改回 `\'` → 真 DOM 大批红 |
| — | §2 缺口 4 处置动作只记账不落地 | **未修** | — | — |
| — | §2 缺口 6 两个易误读语义 | **未修** (只是要知道) | — | — |

### 2A-1 缺口 1: 唤醒空转 (改前 → 改后 → 证据)

- **改前**: `notifyExternal` 只清 `wakeReason / needsExternal / autoContinue / wakeAt` —— `goal.status` 留在
  `awaiting_external` ⇒ 下一次 tick `executed=0`; 界面读的 `continuation.state` 也还是 `awaiting_external`
  ⇒ `toUserVisibleState` 给 `waiting_external_reply` (页面说"已唤醒", 行里写"等待外部回复")。
- **改后**: ① `goal.status === 'awaiting_external'` → 拉回 `active`; ② `continuation.state` 从等待类
  (`awaiting_external` / `retry_wait`) 同步成 `active` ⇒ 接口回话 / 页面 / 盘上三处一致。
- **证据 (红→绿)**: 用例 `手动 /wake 把等待类状态拉回 active 后真能继续` —— 新断言
  `status === 'active'`、`continuation.state === 'active'`、`toUserVisibleState(...) === 'executing'`、
  且下一 tick `executed===1` (改前这条用例的红就是"唤醒后跑不动")。
  真 DOM 侧: §4 的四项 ★ (盘上 `active` / `state=active` / API `visible=executing` / 状态列显示"正在执行")
  在改前全部是红 (那时页面仍显示"等待外部回复")。
- **变异验证**: 删掉 `if (g.status === 'awaiting_external') { updateGoal(active) }` → 用例红;
  删掉 `state: 'active'` 那一半 → 用例红 (两半各管一件事, 缺一即红)。
- **阴性对照**: 走真事件协议的 `deliverExternalEvent` 行为不变 (场景 ⑥ 仍全绿);
  真 DOM 里同页面另一个目标 (A) 的记录在"唤醒 B"前后**逐字节相等** ⇒ 唤醒没有连带改别的目标。

### 2A-2 缺口 2: 长等待判龄 (改前 → 改后 → 证据)

- **改前**: 单 Run 时间上限用 `now - run.startedAt` —— 已结束的 Run 也被算成"本轮跑了 40 分钟" ⇒
  等待 >30 分钟的目标每个 tick 都被判"超出单 Run 时间上限"并交人, 长等待永久醒不过来。
- **改后**: 判龄用**这一段 Run 自己的时长** —— 已结束 / 已收干净的 Run 用 `updatedAt` (≈ 结束时刻),
  **还在跑**的 (`queued` / `running` / `failed` / `interrupted` / `stalled` = 没给出结束结论的) 才用 `now`。
- **证据 (红→绿)**: 用例 `超过单 Run 上限 (30min) 的长等待也能被事件唤醒` —— 40 分钟后事件按时到达 ⇒ tick
  `executed=1`、`runs: 1 → 2`; 改前是 `executed=0` + reason `本轮已超出单 Run 时间上限 (5459999ms > 1800000ms)`。
- **变异验证**: 把 `runEndMs` 改回 `nowMs` → 用例红。
- **阴性对照 (硬底线没被拆)**: 同形状但最后一条 Run **还在 running** 且 `startedAt` 在 45 分钟前 ⇒
  tick 照样 `executed=0`、skip 记"需要人决定", 决策记录 reason 含"超出单 Run 时间上限 / 仍在跑"。

### 2A-3 缺口 3: "合同签发 / 回报核验"这条链 (改前 → 改后 → 证据)

- **改前** (三条独立断点, 缺一条链就断): ① 飞轮裁决 `delegate` (缺本地能力) 却先被**本地技能门禁**拦成
  `blocked_by_skills` + `needs_human` ⇒ 合同 0 份、`goal-works/` 目录都不建; ② 就算放行, 收尾决策
  **拿不到"缺哪个能力"**这条输入 ⇒ `capabilityWanted` 为空 ⇒ 合同仍是 0 份 (`dispatchIfDelegate` 是死代码);
  ③ CLI `--delegate` 五参调用 ⇒ `workContract === undefined` ⇒ 合同门在生产路径上完全空转
  (运行时复现: 一句"全部做完了"就能把任务标成 `completed`)。
- **改后**:
  ① `delegate` 裁决时本地技能门禁**不适用** (这一步本来就不由本节点执行), 照跑并改成签发工作合同;
  但"本地缺什么"**照记不误** (`recordSkillReadiness` 写 `continuation.skillReadiness.missing`, 页面可查) ——
  其余裁决 (`continue` / `first_run` / ...) 门禁一点没放松。
  ② 能力来源改成三级回落: 收尾决策点名的 → `continuation.requiredAgent` → **本轮跑之前** preflight 判定的能力
  (且本地**仍然**缺它)。
  ③ **签发顺序**: 先 `applyDecision` 写状态, 再签合同 —— 否则 `dispatchChildWork` 刚登记的
  `pendingReports` 会被整份 continuation 覆盖成空 ("父 Goal 记着等回报"又丢了)。
  ④ CLI 新增 `--goal <goalId>` 并把 `goalId` 传进 `delegateTask` 第 6 参; 没给 `--goal` 时
  `ensureDelegateGoal` 为这次委派建一个目标 (合同必须有目标上下文)。
- **证据 (红→绿)**:
  · `-t "① 飞轮要 delegate"`: 改后 = 裁决 `delegate` + `runnable=true`、tick 里该 Goal **真跑** (2 条 Run)、
    `report.workContracts` ≥ 1、合同文件真落 `goal-works/`、父 Goal 的 `pendingReports` 含该 `workId`
    (改前: `status='blocked_by_skills'`、合同 0 份、目录都没建);
  · `-t "③ CLI --delegate"`: 按 CLI 修复后的调用形状派遣 ⇒ 有合同; 回"全部做完了" ⇒ 任务**不**被标完成
    (`in_progress` + error 含"不接受为完成"), 父 Goal `pendingReports` 留名; 逐条证据的 JSON 报告 ⇒ 真完成;
    另有一条**阴性对照**证明"没有合同就没有这道门" (五参形状 ⇒ 漂亮话即完成) —— 所以 CLI 必须一直传 `goalId`;
  · 源码级事实 (可重跑): CLI 的 `delegateTask` 调用形状含 `goalId`、`--goal` 解析与帮助文本都在。
- **变异验证**: 门禁不放行 (`flywheelDelegates=false`) → 红; 去掉 preflight 回落 → 红 (合同 0 份);
  把签发挪回"状态写之前" → 红 (`pendingReports` 又空); 去掉 CLI 第 6 参 → 红。
- **负面对照**: 用例 ② 断言"飞轮**没说** delegate 的普通目标真 tick 后 `pendingReports`/`goal-works/` 仍为空"
  ⇒ 这条链只对真需要派遣的目标生效, 不是无差别乱发合同。

### 2A-4 缺口 5: 收尾候选的 `contentHash` (改前 → 改后 → 证据)

- **改前**: 收尾产出的候选 `contentHash` 恒为 `null` ⇒ `assessCandidate` 以 `unverifiable_result` 拒收,
  `writeSkillCandidate` 返回 `null` ⇒ 盘上 `skill-candidates/` 不留候选 ("自动写候选"收益为零)。
- **改后**: `run-closure` 通过**注入**的 `contentHashOf` 拿内容哈希 (接线层用 `work-contract.stableHash` 实现) ——
  这里刻意不 `import` 别的阶段实现, 守住 `run-closure.ts` 文件头声明的模块边界。
- **证据 (红→绿)**: `-t "成功路径"` ⇒ 收尾结果里 `status='draft'` **且** `contentHash` 非空, 候选真落到
  `<home>/.bolloon/skill-candidates/` (改前: `candidatePaths=[]` + skipped `candidate_not_written`)。
- **变异验证**: 去掉接线层的 `contentHashOf` 注入 → 用例红 (候选又落不了盘)。
- **阴性对照**: ⑧ 的"垃圾候选"用例仍全绿 (补齐 `contentHash` 不等于放宽晋升门)。

### 2A-5 真 DOM §3: 用户原话进"下一 Run 指令" (改前 → 改后 → 证据)

- **改前**: `compose()` 只把按 `kind` 生成的摘要 (`补充说明: 只作为下一次 Run 的上下文 (v1)…`) 放进
  `nextRunDirective` ⇒ 接口回话 / `continuation.nextAction` / 页面都**看不到用户自己提的那句话**。
- **改后**: `next_run` 生效的变更在指令里加**原话逐字**条款 (接口回话 + 落盘 `nextAction` + 下一 Run 指令三处同源)。
- **证据 (红→绿)**: 用例 `原话逐字入档` (改前红: `nextRunDirective` 不含原话) + 真 DOM §3 三项:
  接口回话的 `nextRunDirective` 含原话、盘上 `continuation.nextAction` 含原话、已发生的 Run 逐字节不变。
- **变异验证**: 去掉原话条款 → 用例红。
- **阴性对照**: `pending_approval` 的变更 (例: agent 提"把预算上限提高到 999 个 Run") 的
  `nextRunDirective` **不含**原话条款, 也不含 999 ⇒ 未批准的要求不会被当成已生效指令去执行。

### 2A-6 `/goals` 页内联脚本转义 (改前 → 改后 → 证据)

- **改前**: 页面内联脚本里 `onclick="view(\''+g.goalId+'\'")` 这类字符串在**生成的 HTML** 里提前闭合 ⇒
  内联脚本语法错 ⇒ 整页 JS 不执行 (`refresh()` 不跑, 表格空, 点按无效)。真 DOM 验收当时 **12 过 / 19 败**。
- **改后**: 两行 (共 28 处) `\'` → `\\'` (生成的 HTML 里就是合法的 `\'`), 内联脚本可执行。
- **证据**: 真 DOM 脚本 `scripts/verify-goal-flywheel-p5-ui.ts` —— 同一批检查 (含 ★ 修复项) **全过**
  (真数字见 §4; 每次运行都要真起 web server + 真 Chrome)。
- **变异验证**: 把其中一行改回 `\'` (只改目标表那一行) → 真 DOM 大批红 (页面 JS 不执行)。
- **说明**: 本项**只有真浏览器**能验 —— grep 源码看不出"生成的 HTML 里字符串提前闭合"。

## 3. 页面 / CLI 的真实验证

### 3.1 长期执行面板 `/goals` (真 server + 真 headless Chrome 真 DOM)

见 §4 结果表 (脚本: `scripts/verify-goal-flywheel-p5-ui.ts`, 退出码 2 = 本机没有 Chrome)。
关键点: 真起 web server 子进程 (真路由/真存储) + 真 Chrome 真 DOM: 状态列只出现**六类用户可见态**
(zh 标签 + 原 code), 页面文本里**不出现** `retry_wait` / `stalled` / `recovering` / `leaseId` 等内部词;
真点按「新要求」→ 真 POST → 真改写下一 Run 指令 (**原话逐字**) 且已发生 Run 逐字节不变;
真点按「唤醒」→ **接口回话 / 页面状态列 / 盘上 Goal 三处一致** (四项 ★ 检查, 见 §2A-1; 另有一条阴性对照:
同页面另一个目标的记录逐字节没被这次唤醒改动)。

**最新一次真数字 (2026-09-25 收口后)**: **34 过 / 0 失败, 退出码 0** ——
改前同一批检查是 **12 过 / 19 败** (内联脚本被 `\'` 截断, 页面 JS 根本不执行)。
另做**变异验证**: 只把目标表那一行的转义改回 `\'` ⇒ 真 DOM 大批红 (⇒ 这 34 项不是"恒绿")。

### 3.2 CLI 侧

| 入口 | 结果 |
| --- | --- |
| `bolloon --supervise --supervise-once` (独立 Supervisor 宿主, 真进程) | **通过**: 真跑一轮调度, 输出 `调度周期 #1: 认领 0 · 执行 0 · 跳过 1` + `跳过 <goalId>: needs_human: 等人工 approve (needs_human)` + `supervisor 宿主: owner=… worker=… ticks=1 状态文件=~/.bolloon/supervisor.json`, 与盘上 Goal 事实一致 |
| REPL `/supervise` | **未验证 (跑不了)**: 本机 `~/.bolloon` 未完成 setup, CLI 交互启动的硬门禁在进入 REPL 前就转 onboard 并 fail-closed (`Onboard 模式: setup · 从 用户身份 开始` → `readline was closed`), 因此**没能**在真会话里看到 `/supervise` 的输出 |

## 4. 门禁真数字 (本机, 2026-09-25)

| 门 | 真数字 |
| --- | --- |
| `npx tsc --noEmit` | **0 错** (含本线新增的测试与脚本; 每次改完生产代码都重跑) |
| 新验收用例 | `src/test/goal-flywheel-p5-acceptance.test.ts` **22 用例全绿** (≈3.9s) |
| 全量 `npx vitest run` | **见下方"全量"行** (基线 220 文件 / 3390 测 = 3389 过 + 1 条 20s 超时红 `runtime-bootstrap` 的 npm 用例; 该文件**单独跑 32/32 绿** ⇒ 负载超时, 非真红) |
| 手机线复跑 (它自报"真做过"的部分) | `src/test/{mobile-flywheel-view,mobile-tasks,mobile-task-views,mobile-task-actions}.test.ts` **4 文件 / 80 测全绿**; `scripts/verify-mobile-tasks-ui.ts` **41 过 / 0 失败, 退出码 0** |
| 页面真 DOM | `scripts/verify-goal-flywheel-p5-ui.ts`: **34 过 / 0 失败, 退出码 0** (改前 12 过 / 19 败; 变异: 改回转义 → 大批红) |
| 变异验证 (8+1 处修复) | 每处一处变异: 改坏 → 对应用例必红 → 恢复 → 全绿 (明细见 §2A 表格每行"变异验证") |

## 5. 未验证 / 不确定 (一律写"未验证", 不推测)

- **REPL `/supervise` 的真会话输出**: 未验证 (setup 门禁把交互 CLI 挡在 onboarding, 见 §3.2)。
- **iOS / Android 原生构建与真机**: 未验证 —— 与手机线自报一致 (本机 macOS 13 无签名环境); 本线**没有**复跑这一部分。
- **长周期 (小时/天级) 的真实调度**: 未验证 —— 验收用注入时钟推进, 没有跑真实长时钟。
- **多进程/多 worker 竞争下的租约与让路**: 只有既有 `supervisor-lease` 单测覆盖, 本线未新增真跑。
- **`takeover` 在真签发路径上的可达性**: 未验证 —— 真合同策略恒为 `'stall'`, 只有手工改策略才走到 (见场景 ③)。
- **收尾候选转正的完整链路 (人批准 → 写正式 Skill)**: 只验证到"垃圾候选被拒 + 补齐 contentHash 后能落候选",
  未验证批准后的正式写入 (那属于既有 `skills-manager` 的职责, 本线未跑)。
- **`deliverExternalEvent` 的去重**: 重复投递的返回是 `no_match` (等待已被清), 不是 `duplicate` —— 行为已钉住,
  但"去重表 (`deliveredEventIds`) 到底在什么条件下才会命中"未验证。

## 6. 修复线收口后的下一步 (按剩余严重度)

> 本节原为"建议父线接下来修的顺序"; 其中 1 / 2 / 3 / 5 已在本轮修掉 (台账见 §2A), 原文保留在下方"历史"里。
> **现在还没做的**:

1. **缺口 4**: 把 `replace_child` / `request_report` / `send_adjustment` 的落地动作写清 (或明确标成"只登记") ——
   目前仍是"被发现是真的、处置是记账", 不要被读成"系统会自动换人"。
2. **候选转正的完整链路**: 人批准 → 写正式 Skill (属 `skills-manager` 职责, 本线未跑)。
3. **真时钟 / 多进程**: 小时/天级调度、多 worker 租约让路, 仍只有单测覆盖。
4. **`takeover` 在真签发路径上的可达性** (真合同策略恒为 `'stall'`)。

<details><summary>历史 (修复前的建议顺序, 已完成)</summary>

1. ~~缺口 2: 单 Run 时间上限对已结束 Run 的计龄~~ → 已修 (2A-2)。
2. ~~缺口 1: `notifyExternal` 与 `deliverExternalEvent` 的状态收敛对齐~~ → 已修 (2A-1)。
3. ~~缺口 3: 打通"合同签发 / 回报核验"的真路径~~ → 已修 (2A-3a/3b/3c/3d)。
4. 缺口 4: 处置动作落地 → **仍未修** (见上)。
5. ~~缺口 5: 收尾候选的 `contentHash`~~ → 已修 (2A-4)。

</details>
