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
export const KERNEL_FILES: readonly string[] = ['kernel/channel-actor.ts', 'kernel/control.ts', 'kernel/gate-scan.ts', 'kernel/model-runtime.ts', 'kernel/plan-harness.ts', 'kernel/plan-modelruntime.ts', 'kernel/plan-constraint.ts', 'kernel/plan-channel-actor.ts', 'kernel/plan-deletion.ts', 'kernel/plan-runcontext.ts', 'kernel/plan-communication.ts', 'kernel/plan.ts', 'kernel/roster.ts'];

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
  K9: 'partial',          // 2026-10-02: **不能算 done** —— 设计页的 K9 要求"最小 Native Adapter 必须通过与 Pi **完全相同**的五套验收"; 已过: model call (真端点 200+回复) · tool call 经 Harness 门恰一次/拒绝零执行 · CLI 非流式真跑 · 名字净化/回程还原 · 超时/退避/abort/4xx 不重试。**未过** (2026-10-02 第二次补门后缩减为): checkpoint/finish 经适配器的真跑 · Durable Run / Supervisor 两套验收 (适配器层的并发/取消/流式回调已由 ⑧⑨⑩ 覆盖: 3 条并发各自拿到自己的回复 · abort 中途打断且适配器之后仍可用 · 真 loop 的 onStream 收到 token/reply-preview)。以下是已落地部分:  **第二个 (非 Pi) 推理适配器** `src/llm/native-adapter.ts` (fetch 直连 OpenAI 兼容端点, 源码不 import 任何 Pi 模块) + 唯一选择点 `BOLLOON_NATIVE_ADAPTER=1`; 门 `k9-native-adapter.test.ts` **8/8** (机械: 不许是 Pi 的壳 · 行为: 回复/tokens · native tool_calls 原样 · 429 退避重试 · abort 透传 · 4xx 不重试 · **出程名字净化+回程还原** · **过同一套门**: 适配器的 tool_call 经受门端口恰执行一次, 拒绝⇒零执行); **真跑**: 非流式 `prompt` 走该适配器打真端点 ⇒ 回 `适配器切换成功` (HTTP 200)。**顺带修掉一处隐式 Pi 依赖**: pivot 入口的 `!minimaxAvailable ⇒ fallback` 改成问**当前适配器**。**如实范围**: 适配器只实现接口所需的 chat 契约 + 超时/退避/abort/名字净化; Pi 侧的 KV 前缀/轻量分流等属 Pi 自身特性, 不在接口面内
  K10: 'not-started',
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
export const KERNEL_LINE_BUDGET = 2918;   // 2026-10-02: +1 (K4-B: gate-scan 复位阈值注释)   // 2026-10-02: +5 (K8 正刀: gate-scan 加"收口字段数 3→1"+ queue 反回归)   // 2026-10-02: +54 (K8: gate-scan 加 K8 判据)   // 2026-10-02: +2 (STAGE_STATUS 拆 K4-A/K4-B + K6/K7 如实修正)

/** 预算冻结值 (棘轮: 只许减; 想抬预算必须同时改上面那个数字 ⇒ 一次显式动作, diff 里看得见) */
export const KERNEL_LINE_BUDGET_FROZEN_AT = 2918;   // 同步至 2026-10-02 真实值

/**
 * K3b —— **台账数据**单独一档预算 (`src/kernel/plan.ts`)。
 *
 * 为什么分开: K3 要防的是「逻辑回流到内核代码」; 台账是**数据** (owner 名册 / 入口图 / 删除候选),
 * 把它算进代码预算会逼着人抬代码上限, 棘轮的信号就废了。两档各自冻结, 都只许减。
 */
export const KERNEL_PLAN_LINE_BUDGET = 1439;   // 2026-10-02: **收紧** -2 (queue 字段条目删除: 8 字段 → 7)   // 2026-10-02: +14 (K8 前置自纠: 把错的"check-then-set 非原子"换成已核实的"handoff 丢消息")   // 2026-10-02: K7 tscTool 端到端取证 (evidence 字段 + 变异/踩坑记录) ⇒ 显式抬档 +1   // 2026-10-02: K8 通道状态台账+门落地 ⇒ 显式抬档 (棘轮只许减, 抬档要一次显式动作)   // 真实值 (删 ENTRY_GRAPH 一行后); 变异用例要求预算 == 真实值   // 2026-10-02: +91 (K8 台账 plan-communication.ts 落地)   // 2026-10-02: +12 (K7 第二步 b: 旁路 status/symbol/evidence 字段 + 卫生规则注释 + 防漂用例)

/** 台账预算冻结值 (棘轮: 只许减) */
export const KERNEL_PLAN_LINE_BUDGET_FROZEN_AT = 1439;   // 同步至 2026-10-02 真实值
