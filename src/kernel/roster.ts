/**
 * Bolloon Native Macro-Kernel —— K0 模块名册与越权禁令 (冻结面, **数据, 零逻辑, 零 import**)
 *
 * 设计页: docs/wiki/bolloon-native-macro-kernel.md
 * 门:     src/test/kernel-boundary.test.ts (K1 目录边界 / K3 行数棘轮)
 *         src/test/kernel-authority.test.ts (K2 五条越权禁令)
 * 判据:   src/test/kernel-gate-scan.ts (纯函数吃源码文本; 变异验证在测试里每次真跑)
 *
 * 本文件为什么零 import: 它自己就是「内核目录不许 import 业务模块」这条规则的第一个样本 ——
 * 规则若在本文件上都成立不了, 那道门就是装饰。**别在这里加 import。**
 *
 * 为什么名册要机器校验而不是靠人记: 「模块不许互相越权」写成文档 = 半年后没人知道有没有被绕过;
 * 写成这张表 + 两道门 = 绕过它当场判红。仓里先例: goal-flywheel/wiring/seams.ts + wiring-freeze 门。
 */

export type LayerId =
  | 'kernel'
  | 'llm'
  | 'policy'
  | 'state'
  | 'tools'
  | 'channel'
  | 'adapter'
  | 'delegate';

export interface LayerSpec {
  id: LayerId;
  /** 归属该层的路径 (相对 src/, 目录以 / 结尾, 文件写全名) */
  paths: readonly string[];
  role: string;
}

/**
 * 层划分 —— **按真实目录/文件声明**, 不是理想蓝图。
 * 这份划分是 K0 的冻结面: 改它等于改门的判据, 必须同时说明为什么 (留 diff)。
 */
export const LAYERS: readonly LayerSpec[] = [
  {
    id: 'kernel',
    paths: ['kernel/'],
    role: '内核: 调度 / 队列 / 并发 / 取消 / 超时 / 资源隔离 / 状态提交 / 事件派发 (只机制, 不业务判断)',
  },
  { id: 'llm', paths: ['llm/'], role: 'Model Runtime + 供应商/目录/发现/模型选择协议 (写口唯一)' },
  {
    id: 'policy',
    paths: [
      'security/',
      'agents/pi-harness.ts',
      'agents/deny-pipeline.ts',
      'agents/pre-tool-validator.ts',
      'agents/permission-mode.ts',
      'agents/shell-guard.ts',
    ],
    role: 'Policy / Harness: 拒绝与许可的唯一判定面',
  },
  {
    id: 'state',
    paths: [
      'agents/goal-store.ts',
      'agents/run-store.ts',
      'agents/transaction-store.ts',
      'agents/decision-store.ts',
      'agents/plan-store.ts',
    ],
    role: 'Goal / Run / 证据 / 恢复: **唯一事实来源**',
  },
  {
    id: 'tools',
    paths: [
      'agents/pi-sdk-tools.ts',
      'agents/patch-tool.ts',
      'agents/computer-use.ts',
      'agents/browser-cdp.ts',
      'agents/tool-subset.ts',
      'agents/managed-services.ts',
      'agents/tool-path-args.ts',
      'agents/tool-result-gate.ts',
      'agents/tool-telemetry.ts',
      'lsp/lsp-tools.ts',
    ],
    role: 'Tool Runtime: 工具实现 (副作用在这里, 权限判定不在这里)',
  },
  {
    id: 'channel',
    paths: [
      'web/',
      'agents/pi-sdk-session-manager.ts',
      'agents/pi-sdk-session-factory.ts',
      'agents/session-store.ts',
    ],
    role: 'Channel Runtime: 通道/会话/入站出站 (将来是一个 Actor)',
  },
  {
    id: 'adapter',
    paths: [
      'agents/pi-sdk.ts',
      'agents/workflow-pivot-loop.ts',
      'agents/loop-review.ts',
      'agents/react-loop.ts',
    ],
    role: '推理适配器 (当前实现 = Pi; 将来可被第二个实现替换)',
  },
  {
    id: 'delegate',
    paths: ['external-engines/', 'agents/runner-resolver.ts'],
    role: '子 Agent / 外部引擎委派',
  },
];

/**
 * K1 —— kernel 目录允许 import 的前缀 (相对 src/)。
 *
 * 现阶段**只许 kernel 内部**: 内核需要的对外能力一律通过 contracts / ports / adapters 传入,
 * 不许自己伸手去摸业务模块 (那正是 pi-sdk.ts 变成 4099 行单体的成因)。
 */
export const KERNEL_ALLOWED_IMPORT_PREFIXES: readonly string[] = ['kernel/'];

/**
 * 名册登记的 kernel 目录文件 (相对 src/)。
 * 判据是**双向相等**: 盘上多一个未登记文件 ⇒ 红; 名册有而盘上没有 ⇒ 红。
 * (先例: SEAM_ROSTER 的「名册外无人越界」)
 */
export const KERNEL_FILES: readonly string[] = ['kernel/channel-actor.ts', 'kernel/control.ts', 'kernel/run-lifecycle.ts', 'kernel/transport.ts', 'kernel/session-lifecycle.ts', 'kernel/code-write-gate.ts', 'kernel/turn-selfcheck.ts', 'kernel/gate-scan.ts', 'kernel/model-runtime.ts', 'kernel/plan-harness.ts', 'kernel/plan-modelruntime.ts', 'kernel/plan-constraint.ts', 'kernel/plan-channel-actor.ts', 'kernel/plan-deletion.ts', 'kernel/plan-runcontext.ts', 'kernel/plan-communication.ts', 'kernel/plan.ts', 'kernel/roster.ts'];

export type DetectionMode = 'import-edge' | 'write-call';

export interface Prohibition {
  id: string;
  /** 与设计页 §1 五条禁令逐字对应; derivedFrom 非空 = 从路线里的其它阶段派生 */
  rule: string;
  derivedFrom?: string;
  /** 被禁止发起动作的层 */
  fromLayer: LayerId;
  mode: DetectionMode;
  /** import-edge 用: 禁止 import 的目标模块 (相对 src/, 无扩展名) */
  targets?: readonly string[];
  /** write-call 用: 只禁这些「写/改」入口 —— 读不算 (这是本门与「不许 import 整层」的关键区别) */
  writeCalls?: readonly string[];
}

/** Goal 事实的写入口 (goal-store.ts 的导出中带副作用的那些) */
export const GOAL_WRITES: readonly string[] = [
  'createGoal',
  'updateGoal',
  'attachRun',
  'markCriterion',
  'setUnresolved',
  'addEvidence',
  'setCriteria',
  'completeGoalIfEligible',
  'setContinuation',
  'bumpContinuationAttempts',
  'resetContinuationAttempts',
  'claimGoal',
  'heartbeatGoal',
  'releaseGoal',
];

/** Run 事实的写入口 (run-store.ts 的导出中带副作用的那些) */
export const RUN_WRITES: readonly string[] = [
  'startRun',
  'setRunStatus',
  'saveCheckpoint',
  'recordRecovery',
  'recordHarnessEvent',
  'recordModelSwitch',
  'addRunEvidence',
  'recordStep',
  'finishRun',
  'markRunRunning',
  'setOnRunTerminal',
];

/** 权限的写入口 (allowTool/denyTool 在会话上是真改权限面; permission-mode 的测试重置口也算) */
export const PERMISSION_WRITES: readonly string[] = [
  'allowTool',
  'denyTool',
  'setPermissionMode',
  'clearDeniedTools',
  '_resetPermissionModeForTest',
];

export const PROHIBITIONS: readonly Prohibition[] = [
  {
    id: 'model-must-not-execute-tool',
    rule: 'Model 不能直接执行 Tool',
    fromLayer: 'llm',
    mode: 'import-edge',
    targets: [
      'agents/pi-sdk-tools',
      'agents/patch-tool',
      'agents/managed-services',
      'agents/computer-use',
      'agents/browser-cdp',
      'lsp/lsp-tools',
    ],
  },
  {
    id: 'provider-must-not-write-run',
    rule: 'Provider 不能直接写 Run',
    fromLayer: 'llm',
    mode: 'write-call',
    writeCalls: RUN_WRITES,
  },
  {
    id: 'tool-must-not-change-permission',
    rule: 'Tool 不能直接改权限',
    fromLayer: 'tools',
    mode: 'write-call',
    writeCalls: PERMISSION_WRITES,
  },
  {
    id: 'channel-must-not-write-goal',
    rule: 'Channel 不能直接改 Goal',
    fromLayer: 'channel',
    mode: 'write-call',
    writeCalls: GOAL_WRITES,
  },
  {
    id: 'channel-must-not-write-run',
    rule: 'Channel 不能直接写 Run',
    derivedFrom: '路线 K3「入口收口」—— 所有入口统一走 submit(request) → enqueue → RunContext → execute → close',
    fromLayer: 'channel',
    mode: 'write-call',
    writeCalls: RUN_WRITES,
  },
  {
    id: 'child-must-not-end-goal',
    rule: '子 Agent 不能直接结束 Goal',
    fromLayer: 'delegate',
    mode: 'write-call',
    writeCalls: ['completeGoalIfEligible', 'updateGoal', 'setCriteria', 'createGoal'],
  },
];

export interface DebtEntry {
  prohibition: string;
  /** 相对 src/ */
  file: string;
  call: string;
  count: number;
  /** 由哪个阶段还清 (路线里的 K 编号); 空 = 尚未排期 */
  payDownIn?: string;
  /** 重排原因 / 还款路径 (重排"哪个阶段还"时必须写明, 判据强制) */
  note?: string;
}

/**
 * **阶段完工状态** (数据) —— 供判据核"欠账记着由某阶段还, 而那个阶段已经收工"。
 *   只许按事实填: 说 `done` 就要有对应的完工判据支撑 (K5 有 `K5_STEP8` + `scanStep8Completion`)。
 */
export const STAGE_STATUS: Readonly<Record<string, 'done' | 'partial' | 'not-started'>> = {
  K0: 'done',
  K1: 'partial',
  K2: 'done',
  K3: 'done',
  K5: 'done',
  // 2026-10-02 (leo 拍板): K4 = **Kernel Execution Core**, 拆两半, 不许两个含义共用一个编号
  'K4-A': 'done',         // 内核控制面 / Goal·Run 写权限收口 (AUTHORITY_DEBT 3 → 0, 经 kernel/control.ts)
  'K4-B': 'done',         // 2026-10-02 合并完成: 老 `runReActLoop` (1123 行) **已删除**, 所有入口只跑 pivot (`usePivotLoop` 默认 true); 同时补回只存在于老 loop 的门面阶段 (sessionStart/sessionEnd/beforeModelCall/afterModelCall/afterToolCall) + TS 记账上移到唯一执行点 + 自检三路径。**如实两条边界**: ① `reviewFinal` 已恢复调用与留痕, 但它的判定**不参与流程** (pivot 收尾仍由自己的质量判定决定) ② 老 loop 的 `IterationBudget` (净用量+批处理退还) 随它退休, pivot 用复杂度画像预算 (行为差量)      // 合并两套 Agent Loop —— 已落: 默认切 pivot (所有入口一套) + 收尾自检抽成 runTurnEndTypecheck 挂**三条路径**(原先生产 pivot 路径从没跑过自检, 见 K7 evidence 补正); 待做: 删老 `runReActLoop` (~1100 行, 需先核清两条入口 finally/尾段差异)
  K6: 'done',             // 2026-10-02 修正: 能力 9/9 全 done (capabilities-done) —— 原写 not-started 是台账滞后
  K7: 'done',             // 2026-10-02 收尾: 旁路 **3 → 0** (pivot ✅ · skill ✅ 两路端到端 · tscTool ✅ 端到端取证含两条变异 · getSkillRegistry ✅ 受门包装) — 提交 5483e3a / 1af7e46
  K8: 'partial',          // 台账+门已落 · 直连 12 → **0** · 各通道状态 37/33 · didFixQueue 经邮箱 · **正刀已落地** (每条消息都进邮箱, 删掉重复的第二条路径, 提交 2fc197e, 真跑: 一条不丢/严格串行/FIFO) ⇒ 剩 `abortController` 语义定夺 (目标是 ExecutionRequest.signal), 显式留下不随队列顺手合并
  K9: 'done',            // 2026-10-02: **转 done (口径已重述并逐条取证)** —— 设计页那条"与 Pi 完全相同的五套验收"里, 4 套全过; 第 5 套("Durable Run/checkpoint 经适配器")经核实**按字面不可造**(startRun/recordStep 的真调用者只有 真钱 M1 任务 / x402 付费 / 回退路径, 与"适配器只在 LLM 可用时生效"互斥) ⇒ 重述为两半并各自取证: ① durable 写入经内核端口 = K10 ① (门 8/8 + 4/4, 两处变异判红); ② 适配器驱动真跑 = CLI + Web 真跑(会话落库)。 要合成一条"经适配器 + durable"的验收需先补**不含真钱**的 durable-run 路径 ⇒ 已登记为产品/验收设计待办, **不阻塞 K9 收口** (不假装跑过)。原始逐条记录见本条尾部。          // 2026-10-02: **不能算 done** —— 设计页的 K9 要求"最小 Native Adapter 必须通过与 Pi **完全相同**的五套验收"; 已过: model call (真端点 200+回复) · tool call 经 Harness 门恰一次/拒绝零执行 · CLI 非流式真跑 · 名字净化/回程还原 · 超时/退避/abort/4xx 不重试。**未过 → 2026-10-02 口径重述 (有证据)**: "Durable Run / checkpoint 经适配器"这条**按字面不可造** —— 核实三处: ① `startRun` 的真调用者只有 **`agents/task/task-runner.ts:358`(M1 任务, **走真钱/预算**) · `x402/goal-run-bridge.ts`(付费信息场景) · pi-sdk 回退路径(本机不可达)**; ② `recordStep`(每步写 checkpoint) 的调用者也全在这三条路径上; ③ checkpoint 字段实际由 `recordStep`(每步)/`prepareResume`(resume) 写, `saveCheckpoint` 本身**无人调**。 ⇒ 可选路径里**没有一条既不含真钱又能经适配器**(适配器只在 LLM 可用时生效, 而"回退路径"按定义要求 LLM 不可用 ⇒ 互斥)。**诚实处置**: 该条拆成两半分别验 —— ① "durable 写入经内核端口" = K10 ① (门 8/8 + 4/4 + 两处变异); ② "适配器驱动真跑" = CLI(`三面通过`)+Web(会话落库) 真跑。要合成一条"经适配器 + durable"的验收, 得先补一条**不含真钱**的 durable-run 路径 ⇒ 属产品/验收设计, 需拍板。 (适配器层的并发/取消/流式回调已由 ⑧⑨⑩ 覆盖: 3 条并发各自拿到自己的回复 · abort 中途打断且适配器之后仍可用 · 真 loop 的 onStream 收到 token/reply-preview)。以下是已落地部分:  **第二个 (非 Pi) 推理适配器** `src/llm/native-adapter.ts` (fetch 直连 OpenAI 兼容端点, 源码不 import 任何 Pi 模块) + 唯一选择点 `BOLLOON_NATIVE_ADAPTER=1`; 门 `k9-native-adapter.test.ts` **8/8** (机械: 不许是 Pi 的壳 · 行为: 回复/tokens · native tool_calls 原样 · 429 退避重试 · abort 透传 · 4xx 不重试 · **出程名字净化+回程还原** · **过同一套门**: 适配器的 tool_call 经受门端口恰执行一次, 拒绝⇒零执行); **真跑**: 非流式 `prompt` 走该适配器打真端点 ⇒ 回 `适配器切换成功` (HTTP 200)。**顺带修掉一处隐式 Pi 依赖**: pivot 入口的 `!minimaxAvailable ⇒ fallback` 改成问**当前适配器**。**如实范围**: 适配器只实现接口所需的 chat 契约 + 超时/退避/abort/名字净化; Pi 侧的 KV 前缀/轻量分流等属 Pi 自身特性, 不在接口面内
  K10: 'done',            // 2026-10-02: **八步全落地** —— ① 4/4 (门 8/8 + 4/4, 两处变异) · ② 轻版落地 (内核运行时进生产路径, 门 6/6 + 变异 + 真跑) · ③ 实质完成 · ④ 全接线 (门 26/26 + 变异) · ⑤⑥ 早完成 (K7/K4-B) · ⑦ 已查清处置 (接上死机制, 其余登记保留) · ⑧ 按判据给出结论 (不宣称替换成功 · 不物理删)。**余项(不阻塞)**: 6 处辅助调用仍拿现成 handle; `checkMinimax` 仍 Pi 专有。**12.3% 运行/通道接线的第一刀已落 (2026-10-02)**: 新增内核模块 `kernel/session-lifecycle.ts` (278 行) —— 把四处**规则**搬进内核: ① `save-session` 的消息→持久形态映射 + key 校验 (原在 `saveCurrentSession` 方法体里) ② `peek-history` / `hydrate` 的**读回过滤/水合规则** (原为 `_filterToMessage` —— 全仓唯一副本, **已删**) ③ `seed-run` 的运行种子合并顺序 (`composeRunSeed`: 活跃运行打底 · extra 覆盖, 与同步调用点共用同一条) · I/O (actor 快照 / SessionStore / 上下文工厂) 全部端口注入。**门** `k10-session-lifecycle-port.test.ts` **16/16** (纯规则四条"必须保留/必须剔" + 端口语义 + 审计 + 源级反回归) + **变异判红** (把过滤副本塞回 pi-sdk ⇒ 反回归精确判红)。**扣减**: pi-sdk **3497 → 3479 行 (-18)**; K3 显式抬档 +278 (真实值 3583)。 **第二刀 (2026-10-02)**: ① `src/agents/code-write-gate.ts` (**49 行纯规则** —— 哪个写操作产出 TS · 收尾要不要跑 tsc · 结果怎么压成一行) **整条搬进内核** (`kernel/code-write-gate.ts`) ⇒ agent 侧**少一个模块** (减法); ② 两条恢复规则搬进 `kernel/run-lifecycle.ts`: `decideResumeReinstall` (一致**不**重装 · 漂了/核对不了才装 · **无结论不装**) 与 `pickRunIdForResume` (显式 lastRunId 优先 · 回落活跃运行); 两条都补了门断言 + **变异判红** (把重装判据改成恒 false ⇒ 门红)。K3 抬档 **3660** (真实值)。 **第三刀 (2026-10-02)**: `runTurnEndTypecheck` 的**编排与政策**整条搬进内核 (`kernel/turn-selfcheck.ts`) —— 该不该跑 (纯规则在 `code-write-gate.ts`) · **系统自检也过门** · **被拒/门抛错 ⇒ 零执行且可见** (fail-closed) · 执行抛错 ⇒ 一行"没能跑起来"且**从不抛**; pi-sdk 的方法体 **40 → 26 行**, 只剩三个端口实现 (取工具 / 问门 / 上报)。门 `k10-turn-selfcheck.test.ts` **10/10** (含"被拒零执行"与"门抛错"两条政策) + **变异判红**; K7 端到端 (真模型) 仍绿 ⇒ 换主人后行为不变。K3 抬档 **3752** (真实值)。         // 2026-10-02 起手 (先量后删): pi-sdk.ts **3353 行**; 8 步现状 —— **⑤ 旧工具 gate ✅ (K7 已做)** · **⑥ 旧 loop ✅ (K4-B 删 runReActLoop 1123 行)** · **① Pi 的 Goal/Run 写入 = 已接线 4/4** (端口 `kernel/run-lifecycle.ts` 落地 + 回退路径三处 `start-run/record-step/finish-run` 改经端口 + `assertLifecycleOk` 响失; 门 `k10-run-lifecycle-port.test.ts` 8/8 + 变异判红; **真跑待补**: 该分支需 `getMinimax()` 真抛, 本机模型总能构造 ⇒ 不可达; 第 4 处 = `safeSetRunStatus` 的状态迁移**已改经控制面** (`submitRunControl(kind:"set-run-status")` + `runControlPorts()` 注入; 口径保真: 被拒⇒false 且不记降级 · 未注入/抛错⇒false 并记降级), 门 `k10-run-control-wiring.test.ts` **4/4**(真调私有方法体三态 + 反回归) + **变异判红**(绕过控制面 ⇒ 4 条全红)): 写点 4 处 (1244 `startRun` / 1254 `recordStep` / 1255 `finishRun` = 回退路径落 run 事实; 1999 在 `setGoalId` 里 = Pi 的 Goal 写入), 内核**已有控制面** `kernel/control.ts` (`RunControlRequest{kind,origin,runId,goalId,payload}` → `RunControlPorts{recordRecovery,setRunStatus,setContinuation}`), 但它是**命令式控制面** (供 web/cli/supervisor 发 pause/resume/abort/recover), **不是 run 生命周期写口** ⇒ ① 的正确下一刀 = **照 control.ts 的形状新增 run-lifecycle 端口** (`startRun/recordStep/finishRun/saveCheckpoint`, 同样端口注入 + 未注入即拒), 再把 4 处改经它 (禁直接调 run-store); 不许把生命周期写入硬塞进控制面的 `kind` 里 (语义不同: 一个是"谁命令我停", 一个是"我这一轮的事实") · **② 模型配置解析 = 轻版落地** (回合的模型**先向内核运行时取租约** —— `ModelRuntime.acquire(snapshot)` 只读入手, 超时/取消/退避/熔断/回退/记账/连接池/能力检查由 K6 运行时负责; **传输仍是 Pi 客户端** (端口 `openPiConnection` 注入) ⇒ 行为不变; 取不到就**如实记**"内核租约不可用 ⇒ 回落 Pi 直连"(不假装); 新增只读投影 `snapshotFromSelection`(缺 provider/model ⇒ null, 不许编); 门 `k10-model-runtime-wiring.test.ts` **5/5** + 变异判红; **真跑**: `推理适配器 = kernel-model-runtime (只读 acquire 租约)` + 回复 `内核租约` ✓ ⇒ K6 那个"造了没人用"的运行时**进生产路径了**。**② 余下 (预留升级)**: 6 处辅助调用的 `getMinimax()` 仍拿现成 handle; `checkMinimax` 仍是 Pi 专有探针 —— 两条都属"下一刀", 已点名) (10 处: 6 处 `getMinimax()` 供辅助功能自取自用 [judgment hint 2625 · suggestRename 2915/2946 · summarizeDocument 2970 · improveDocument 3003 · 自动压缩注入 1392] + `checkMinimax` 1127 + 适配器回落 1735 + 注释 2; 内核已有 `class ModelRuntime`(517 行, `acquire(snapshot): ModelLease` 只读) 与能力 9/9 ⇒ **缺的不是运行时, 是取舍**: ① snapshot 由谁传给 Pi (Run 级 vs 会话级) ② 辅助调用拿 lease 还是拿现 handle ③ `checkMinimax` 这种 Pi 专有探针是否保留 —— 三条都影响公开行为, 须拍板后再动, 不许硬编) · **③ Channel 状态 = 已量清, 实质完成** (Pi **无自有**通道状态字段: `this.channelId/currentSessionId/sessionKey/channelName` 赋值与读点均 **0**; 剩余 8 处 `actor.state.channelId` 读的正是 K5 actor —— 归属已在内核) · **⑦ 已查清处置**: 查 6 个导出时挖出 **`verifyWriteOutcome` 是"写后读回"纪律的唯一实现却 0 调用点, 且函数体用 `require('node:fs')`(ESM 产物里必炸、被自己 catch 吞成 `[未核对] … require is not defined` ⇒ 它一次都没成功过)** ⇒ 按"无替代路径不许删"**改为接上**: 拆成 `src/agents/write-verify.ts`(静态 import) + `withWriteVerified` 接进 `write_file`/`edit_file` 成功返回; 门 `k10-write-verify-wiring.test.ts` **10/10**(含两条端到端真跑) + **变异判红**(拆接线 ⇒ 2 条红); 其余 4 导出各有测试与用途 ⇒ **登记保留**, 不删 ·  · **④ 通信入口 = 首刀落地** (新增内核端口 `kernel/transport.ts`: `send/broadcast/peers` 三动作, 端口注入 + 未注入即拒 + `{ok:false}` 归一化 + 审计, 与 control/run-lifecycle 同一套写法; pi-sdk 的 `sendMessage`/`broadcast` 改经端口 + **失败一律抛**(发送有副作用: 静默丢消息比抛错更糟); 门 `k10-transport-port.test.ts` **8/8**(含真调方法体两条) + **变异判红**(绕过端口 ⇒ 3 条红, 直连真传输那次的失效形态正是 `Node not initialized`); **④ 后半已落地 = ④ 全接线**: 加**同步**读入口 `transportPeersSync(ports)` + `peersSync` 端口 (不硬塞进 async 的 `submitTransport` —— 分开是因为**签名**不是语义: 上层有同步调用点, sync 签名不能凭空变 async); `getPeers()`/`listPeers()` 改经端口: `listPeers` 在端口未注入时**明说"读不到"**(不假装"没有对端"), `getPeers()` 未注入时回落直读并 `console.warn` 留痕; 门扩到 **11/11**(同步入口两种注入态 + 真调方法体三态) + **变异判红**(同步读绕过端口 ⇒ `listPeers` 谎报"无对端", 门抓到)) · **⑦ 兼容层 6 个导出面** · **⑧ 是否删 Pi Adapter 本身 = 已按判据给出结论 (不物理删)**。量占比 (**行数口径**, 方法: 按方法块归类, 脚本在 `docs/wiki/log.md`): `pi-sdk.ts` **3497 行** ⇒ 传输/供应商 **14.4%** · turn-glue **14.0%** · 运行/通道/通信接线 **12.3%** · 文档辅助 **9.2%** · 其余 50.1% 通用编排/装配。**职责口径**: K0–K10 已把「循环 (K4-B) · 工具门 (K7) · Run 事实 (①) · 通道状态 (③) · 通信 (④) · 模型选择 (②)」**全部搬出 Pi** ⇒ 岗位职责只剩"传输适配 + 供应商/Harness 特性 + 文档辅助 + 端口接线"。**结论**: 按判据「迁移后 Pi 职责仍超原职责 30% ⇒ 不许宣称替换成功」—— 行数口径下 Pi 仍是本仓最大单体 ⇒ **不宣称替换成功** (诚实口径); **不物理删** (五个删除条件不满足: 传输在 Pi 有专有实现、无替代路径; 且属公开契约)。**下一刀候选** (已点名): 继续薄化那 12.3% 的运行/通道**接线**与 turn-glue 里的生命周期部分。
};

/**
 * **越权欠账台账 (棘轮)** —— 判据是「实际违规多重集 == 本表逐字相等」, 不是「⊆」:
 *   · 新增一条违规 ⇒ 门立刻红 (要登记就得改这张表, diff 里看得见)
 *   · 修掉一条却没同步删 ⇒ 门也红 (强制台账与事实同步, 不许台账烂在上面)
 * 条数另有 `AUTHORITY_DEBT_FROZEN_AT` 冻死, **只许减不许增**。
 */
export const AUTHORITY_DEBT: readonly DebtEntry[] = [
  // **K4 已全部还清 (3 → 0)**: 三条越权写 (setContinuation / setRunStatus ×2 / recordRecovery)
  //   都改成"channel 提交请求 → 内核控制面执行写" (kernel/control.ts)。
  //   这张表保持**空**是有判据盯着的事实: 任何一处新的 channel 直写都会让双向判据报 missing ⇒ 立刻红。
];

/** 欠账条数冻结值 (只许减; 要加必须同时改这里 → 在 diff 里是一次显式动作) */
export const AUTHORITY_DEBT_FROZEN_AT = 0;   // 3 → 0 (K4 用内核控制面还清全部三条越权写)

/**
 * K3 —— kernel 目录行数预算 (棘轮, 只许减不许增)。
 *
 * 目的只有一个: **不许所有逻辑回流到 kernel.ts**。要加就得显式抬这个数字, 留下痕迹。
 * 数值 = 当前 kernel 目录真实行数, 不留余量。
 */
export const KERNEL_LINE_BUDGET = 3752   // 2026-10-02: 收尾自检规则 `kernel/code-write-gate.ts` 从 agents 侧整条搬入 (+49, 减法: agent 侧少一个模块)   // 2026-10-02: 会话生命周期端口 `kernel/session-lifecycle.ts` (278 行) + `gate-scan` 播种锚点跟形状 (+4) —— **显式抬档 +282** (K10 余项; pi-sdk 本批 -18 行);   // 2026-10-02 **显式抬档 +22** (K8 收尾: channel-actor 加 `abortActorsOfChannel` + 台账/门同步)   // 2026-10-02 **显式抬档 +16** (K10 ④ 后半: transport.ts 加同步读入口 `transportPeersSync` + `peersSync` 端口)   // 2026-10-02 **显式抬档 +145** (K10 ④: 新增内核模块 kernel/transport.ts —— 通信入口端口)   // 2026-10-02 **显式抬档 +184** (K10 ①: 新增内核模块 kernel/run-lifecycle.ts —— 运行生命周期写口, 与 control.ts 的控制面分开; 预算 == 真实值)   // 2026-10-02: +1 (K4-B: gate-scan 复位阈值注释)   // 2026-10-02: +5 (K8 正刀: gate-scan 加"收口字段数 3→1"+ queue 反回归)   // 2026-10-02: +54 (K8: gate-scan 加 K8 判据)   // 2026-10-02: +2 (STAGE_STATUS 拆 K4-A/K4-B + K6/K7 如实修正)

/** 预算冻结值 (棘轮: 只许减; 想抬预算必须同时改上面那个数字 ⇒ 一次显式动作, diff 里看得见) */
export const KERNEL_LINE_BUDGET_FROZEN_AT = 3752;   // 同步至 2026-10-02 真实值 (K10 ④ 新增 transport.ts 后)

/**
 * K3b —— **台账数据**单独一档预算 (`src/kernel/plan.ts`)。
 *
 * 为什么分开: K3 要防的是「逻辑回流到内核代码」; 台账是**数据** (owner 名册 / 入口图 / 删除候选),
 * 把它算进代码预算会逼着人抬代码上限, 棘轮的信号就废了。两档各自冻结, 都只许减。
 */
export const KERNEL_PLAN_LINE_BUDGET = 1443;   // 2026-10-02: Harness 台账登记「收尾自检执行点」搬进 kernel/turn-selfcheck.ts (+1)   // 2026-10-02 **显式抬档 +3** (K8 收尾: plan-communication 把 abortController 条目改成删除说明)   // 2026-10-02: **收紧** -2 (queue 字段条目删除: 8 字段 → 7)   // 2026-10-02: +14 (K8 前置自纠: 把错的"check-then-set 非原子"换成已核实的"handoff 丢消息")   // 2026-10-02: K7 tscTool 端到端取证 (evidence 字段 + 变异/踩坑记录) ⇒ 显式抬档 +1   // 2026-10-02: K8 通道状态台账+门落地 ⇒ 显式抬档 (棘轮只许减, 抬档要一次显式动作)   // 真实值 (删 ENTRY_GRAPH 一行后); 变异用例要求预算 == 真实值   // 2026-10-02: +91 (K8 台账 plan-communication.ts 落地)   // 2026-10-02: +12 (K7 第二步 b: 旁路 status/symbol/evidence 字段 + 卫生规则注释 + 防漂用例)

/** 台账预算冻结值 (棘轮: 只许减) */
export const KERNEL_PLAN_LINE_BUDGET_FROZEN_AT = 1443;   // 同步至 2026-10-02 真实值
