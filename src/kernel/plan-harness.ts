/**
 * plan-harness.ts — K7 台账: **Harness 作为唯一系统调用门**
 *
 * K7 的目标形态 (设计页 §7 第 164 行原文):
 *   `discover → permission → policy → budget → idempotency → execute → verify → evidence → event`
 *   覆盖 普通工具 / MCP / Skill / delegate / 子 Agent / 联系人 / 支付 / 文件写入 / 外部通信
 *   判据: **任何绕过 Harness 的代码都视为架构缺陷**; 工具旁路全删。
 *
 * 关键判断 (开工前已定, 不是新建): **Harness 作系统调用门是「提升」不是「新建」** ——
 *   `deny → pre-tool-validator → react-harness` 这条顺序**已经存在**且被源码级断言锁着
 *   (`src/test/pi-harness.test.ts`: "那唯一一处对 pre-tool-validator 的引用在门面内部 (注入), 不在调用点")。
 *   K7 要补的是: ① 把 9 个阶段与 9 个覆盖面**清单化** ② 把"谁在执行"数出来并登记 ③ 收敛旁路。
 *
 * 本文件是**台账 (数据)**, 不含运行时逻辑 —— 与 K3 分档一致 (台账档 ≠ 代码档)。
 */

/** 9 个阶段 (顺序即契约; gate = 现在**已经**承担该阶段的东西, 不是待建) */
export interface HarnessStage {
  stage: string;
  /** 现在承担该阶段的实现 (文件 / 判据名) */
  gate: string;
  why: string;
}

export const HARNESS_STAGES: readonly HarnessStage[] = [
  { stage: 'discover', gate: 'src/kernel/roster.ts 的模块名册 + src/agents/tool-registry.ts 的工具名册', why: '模型能看到的工具集合必须是冻结名册的子集 (K0 ⑤ import 白名单 + 工具名册双源)' },
  { stage: 'permission', gate: 'src/agents/deny-pipeline.ts', why: 'deny 最先: 被禁的动作不进后续任何阶段 (顺序不可换)' },
  { stage: 'policy', gate: 'src/agents/pre-tool-validator.ts (经 src/agents/pi-harness.ts 门面注入)', why: '参数级校验 + 策略拒绝; 唯一引用在门面内部 ⇒ 调用点无法绕过' },
  { stage: 'budget', gate: 'src/agents/goal-flywheel/run-closure.ts (HardLimits) + Run 预算', why: '预算穷尽要能在**执行前**拒 (花掉才发现就晚了)' },
  { stage: 'idempotency', gate: 'src/agents/x402/* + src/agents/contacts/* 的幂等键 + 写操作读回自证', why: '支付/联系人/写文件这三类是"重复执行有真实副作用"的, 幂等键必须在门内' },
  { stage: 'execute', gate: 'src/agents/pi-sdk.ts 主执行点 (经门链) + src/agents/tool-registry.ts 统一执行口', why: '执行必须只有一条咽喉; 台账里逐点登记谁在执行 (含旁路)' },
  { stage: 'verify', gate: 'src/agents/pi-sdk-tools.ts 写类工具读回核对', why: '"工具说成功 ≠ 任务成功" 要从规矩变成机制' },
  { stage: 'evidence', gate: 'src/agents/x402/direct-payment.ts 台账 + Run 落盘', why: '有副作用的动作要留可核验证据' },
  { stage: 'event', gate: 'runCtx.eventSink (K2 外置面) → Web/CLI 双面', why: '事件面只许有一个出口 (K2 外置面的 eventSink)' },
];

/** 9 个覆盖面 (每个都要说清"现在谁管它" —— 拿不到就拒跑) */
export interface HarnessSurface {
  surface: string;
  /** 现在承担它的**真文件** (判据会核它真的存在) */
  canonical: string;
  why: string;
}

export const HARNESS_SURFACES: readonly HarnessSurface[] = [
  { surface: 'tool', canonical: 'src/agents/tool-registry.ts', why: '普通工具的统一执行口' },
  { surface: 'mcp', canonical: 'src/agents/pi-sdk-tools.ts', why: 'MCP 工具经这里执行 (台账里 1 处)' },
  { surface: 'skill', canonical: 'src/bollharness-integration/skill-adapter.ts', why: 'Skill 执行; **注意现在有两条 skill 路径** (见旁路候选)' },
  { surface: 'delegate', canonical: 'src/web/agent-delegate-server.ts', why: '委派执行面' },
  { surface: 'subagent', canonical: 'src/agents/runner-resolver.ts', why: '子 Agent 经 runner-resolver 拿 session (K5 已接线)' },
  { surface: 'contact', canonical: 'src/agents/contacts/consent.ts', why: '联系人/同意门 (consent 单次 vs grant 长期)' },
  { surface: 'payment', canonical: 'src/agents/x402/direct-payment.ts', why: '支付/收款: 幂等 + 链上核验' },
  { surface: 'file-write', canonical: 'src/agents/tool-path-args.ts', why: '路径参数统一处理 + 敏感子目录护栏' },
  { surface: 'external-comm', canonical: 'src/agents/pi-sdk-tools.ts', why: '外部通信 (HTTP/SSRF 面) 与 MCP 同文件' },
];

/**
 * 执行点普查 (口径 = **剥掉块注释与行注释后**数 `\.execute\s*\(|executeTool` 的匹配次数)。
 * 每个站点按"它到底是什么"分类 —— 这一步照出真旁路, 不是把所有 `.execute` 一律当工具执行。
 */
export type ExecKind =
  | 'main'          // 主路径工具执行 (经门链)
  | 'skill'         // skill 执行
  | 'mcp'           // MCP 执行
  | 'registry'      // 注册表统一执行口
  | 'bypass'        // **真旁路**: 第二条执行路径, K7 要收敛
  | 'homonym'       // 同名不同物 (loop.execute / session.execute / params.execute …)
  | 'port-callback' // **注入的执行器端口被调用** (执行发生在注入方那一侧, 不是这里)
  | 'decl'          // 函数**定义**
  | 'import'        // import 列表里的名字
  | 'ledger-string'; // 台账/文档字符串里的字面

export interface ExecSite {
  file: string;
  count: number;
  kinds: readonly ExecKind[];
  why: string;
}

/** 实测 (2026-10-02, 剥注释后共 17 处) —— 数的口径写在 countHarnessExecSites 里, 判据会重算比对 */
export const HARNESS_EXEC_SITES: readonly ExecSite[] = [
  { file: 'src/agents/pi-sdk.ts', count: 5, kinds: ['main', 'skill', 'bypass', 'homonym'], why: '主执行点 1 (2715) · skill 2 (989 `sk.execute` / 4144 `skillRegistry.execute`) · 内置 tscTool 直调 1 (1330, bypass) · loop.execute 1 (1831, homonym)' },
  { file: 'src/agents/workflow-pivot-loop.ts', count: 2, kinds: ['bypass', 'homonym'], why: '**pivot loop 直接执行工具** 1 (613, bypass) · loop.execute 1 (1129, homonym)' },
  { file: 'src/agents/tool-registry.ts', count: 1, kinds: ['registry'], why: '注册表统一执行口 (唯一咽喉候选)' },
  { file: 'src/agents/pi-sdk-tools.ts', count: 1, kinds: ['mcp'], why: 'MCP executeTool 1 (2570)' },
  { file: 'src/bollharness-integration/skill-adapter.ts', count: 1, kinds: ['skill'], why: 'skill 第二条路径 (registry.execute, 673)' },
  { file: 'src/agents/browser-cdp.ts', count: 1, kinds: ['homonym'], why: 'CDP `session.execute` (799) —— 浏览器命令, 不是工具执行' },
  { file: 'src/agents/chain/chain-wallet.ts', count: 1, kinds: ['homonym'], why: '`params.execute(signer)` (246) —— 钱包动作, 不是工具执行' },
  { file: 'src/web/agent-delegate-server.ts', count: 1, kinds: ['port-callback'], why: '`options.execute({...})` (200) —— 2026-10-02 定性: 它是**注入的执行器端口** (`execute?: (req: DelegateExecutionRequest) => Promise<DelegateExecutionResult>`, 见该文件 66 行), 委派服务器**自己不执行工具** ⇒ 不是旁路; 但"注入的那个执行器有没有走门"是 delegate 覆盖面(K7 覆盖面清单)的事, 不在这条普查里' },
  { file: 'src/bollharness-integration/index.ts', count: 1, kinds: ['import'], why: 'import 列表里的名字 (53)' },
  { file: 'src/pi-ecosystem/index.ts', count: 1, kinds: ['import'], why: 'import 列表里的名字 (38)' },
  { file: 'src/pi-ecosystem-mcp/index.ts', count: 1, kinds: ['decl'], why: '`export async function executeTool(` (272) —— 定义' },
  { file: 'src/kernel/plan-deletion.ts', count: 1, kinds: ['ledger-string'], why: '台账字符串里的字面 (32)' },
];

/** K7 要收敛的**真旁路** (每条都要写清拿什么替代 —— 五条件里第 ① 条) */
export interface HarnessBypass {
  target: string;
  /** 收敛到哪 (替代路径) */
  replacesWith: string;
  why: string;
}

export const K7_BYPASS_CANDIDATES: readonly HarnessBypass[] = [
  { target: 'src/agents/workflow-pivot-loop.ts:613 `tool.execute(toolCall.args ?? {})`', replacesWith: '走 Harness 门链 (与 pi-sdk 主执行点同一条咽喉)', why: 'pivot loop 是第二条工具执行路径 ⇒ 未经 deny/policy 就能执行工具 (架构缺陷定义的那一类)' },
  { target: 'src/agents/pi-sdk.ts:1330 `tscTool.execute({})`', replacesWith: '经门链执行, 或在台账里登记为"内部诊断白名单"并写明理由', why: '内置诊断工具直调: 要么走门, 要么**显式登记**为白名单 —— 不许处于"没人知道它绕过"的状态' },
  { target: 'src/agents/pi-sdk.ts:4144 (skillRegistry.execute)', replacesWith: '与 src/bollharness-integration/skill-adapter.ts:673 (registry.execute) 收敛成唯一 skill 执行入口', why: 'skill 有两条执行路径 ⇒ 必然一条有门一条没有 ("同一个能力只许有一套实现" 的同型教训)' },
];

/** K7 验收 (与设计页 §7 的判据对应) */
export const K7_ACCEPTANCE: readonly string[] = [
  '9 个阶段**顺序**即契约, 且每阶段的 gate 是真存在的文件/判据 (不是待建)',
  '9 个覆盖面每个都能说出"现在谁管它", canonical 文件真存在',
  '执行点普查与盘上**逐字一致** (增 = 新旁路未登记 · 减 = 改了盘没改账)',
  '旁路候选逐条有替代路径; 收敛后**旁路数只许减**',
  '收敛动作必须走五条件 (唯一替代路径 · 无有效引用 · 真跑覆盖 · 完整回归 + 故障恢复 · 可回滚提交点)',
];

export interface K7Progress {
  stage: 'not-started' | 'ledger-landed' | 'bypass-converged' | 'single-gate-complete';
  /** 台账落地时盘上的执行点数 (棘轮基线) */
  execSitesTotal: number;
  /** 台账落地时登记的旁路数 (棘轮基线) */
  bypasses: number;
}

export const K7_PROGRESS: K7Progress = {
  stage: 'ledger-landed',
  execSitesTotal: 17,
  bypasses: 3,
};
