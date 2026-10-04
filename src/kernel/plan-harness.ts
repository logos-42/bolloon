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

/**
 * 实测 (2026-10-02, 剥注释后共 18 处) —— 数的口径写在 countHarnessExecSites 里, 判据会重算比对。
 *
 * **规则 (2026-10-02 立): 台账按「符号」不按「行号」。** 行号会随任何一次编辑漂移, 而判据只核**计数**
 *   不核行号 ⇒ 行号一旦写进台账, 它迟早会**指向错的位置而没人发现** (K7 第二步 b 当场发生:
 *   在 pi-sdk 插入 ~35 行后, 台账里的 4144 实际已变 4176)。说清"是哪一处"用函数名/类名/调用形态。
 */
export const HARNESS_EXEC_SITES: readonly ExecSite[] = [
  { file: 'src/agents/pi-sdk.ts', count: 6, kinds: ['main', 'skill', 'bypass', 'homonym', 'registry'], why: '主执行点 1 (`runReActLoop` 内的执行, 经门链) · skill 2 (`getSkillRegistry()` 暴露的 `skillRegistry.execute` + 内置 `sk.execute`; **2026-10-02 量到: 这两条在生产代码里零调用者** —— 但 `PiAgentSession.executeSkill`/`getSkillRegistry` 是**已发布 npm 包的公开方法** ⇒ 属"不擅动公开契约", 删/收口都要等用户口径) · 内置 tscTool 直调 1 (bypass) · `loop.execute` 1 (homonym) · **K7 第二步 b 新增 1**: pivot loop 的 `guardedExecute` 端口内 `return tool.execute(args)` (在门之后, 属同一扇门的通过分支, 不是旁路)' },
  { file: 'src/agents/workflow-pivot-loop.ts', count: 2, kinds: ['bypass', 'homonym'], why: '**pivot loop 直接执行工具** 1 (bypass —— 2026-10-02 已收敛: 走注入的 `guardedExecute` 门端口) · `loop.execute` 1 (homonym)' },
  { file: 'src/agents/tool-registry.ts', count: 1, kinds: ['registry'], why: '注册表统一执行口 (唯一咽喉候选)' },
  { file: 'src/agents/pi-sdk-tools.ts', count: 1, kinds: ['mcp'], why: 'MCP `executeTool` 1' },
  { file: 'src/bollharness-integration/skill-adapter.ts', count: 1, kinds: ['skill'], why: 'skill 第二条路径 (`SkillAdapter.executeSkill` → `registry.execute`)' },
  { file: 'src/agents/browser-cdp.ts', count: 1, kinds: ['homonym'], why: 'CDP `session.execute` —— 浏览器命令, 不是工具执行' },
  { file: 'src/agents/chain/chain-wallet.ts', count: 1, kinds: ['homonym'], why: '`params.execute(signer)` —— 钱包动作, 不是工具执行' },
  { file: 'src/web/agent-delegate-server.ts', count: 1, kinds: ['port-callback'], why: '`options.execute({...})` —— 2026-10-02 定性: 它是**注入的执行器端口** (`execute?: (req: DelegateExecutionRequest) => Promise<DelegateExecutionResult>`, 见该文件顶部接口定义), 委派服务器**自己不执行工具** ⇒ 不是旁路; 但"注入的那个执行器有没有走门"属 delegate 覆盖面的事, 不在这条普查里' },
  { file: 'src/bollharness-integration/index.ts', count: 1, kinds: ['import'], why: 'import 列表里的名字' },
  { file: 'src/pi-ecosystem/index.ts', count: 1, kinds: ['import'], why: 'import 列表里的名字' },
  { file: 'src/pi-ecosystem-mcp/index.ts', count: 1, kinds: ['decl'], why: '`export async function executeTool(` —— 函数定义' },
  { file: 'src/kernel/plan-deletion.ts', count: 1, kinds: ['ledger-string'], why: '台账字符串里的字面' },
];

/** K7 要收敛的**真旁路** (每条都要写清拿什么替代 —— 五条件里第 ① 条) */
export interface HarnessBypass {
  target: string;
  /** 收敛到哪 (替代路径) */
  replacesWith: string;
  why: string;
  /** 指位置用的记号 (判据会核它**真出现在 target 文件里**) —— 行号会漂, 符号不会 */
  symbol: string;
  /** 收敛状态; `converged` 必须带 evidence (判据会核) */
  status: 'open' | 'converged';
  /** 收敛的证据 (提交/测试/判据名); converged 时不许为空 */
  evidence?: string;
}

export const K7_BYPASS_CANDIDATES: readonly HarnessBypass[] = [
  { target: 'src/agents/workflow-pivot-loop.ts', symbol: 'guardedExecute', replacesWith: '走 Harness 门链 (与 pi-sdk 主执行点同一条咽喉)', why: 'pivot loop 是第二条工具执行路径 ⇒ 未经 deny/policy 就能执行工具 (架构缺陷定义的那一类)', status: 'converged', evidence: '2026-10-02: `PivotLoopConfig.guardedExecute` 端口 (`044cde2`) + pi-sdk 在 `promptWithPivotLoop` 注入同一 `piHarness().beforeToolCall` (`69397f6`); 用例: 未注入行为不变 / 注入后 `tool.execute` 计数 0 / 端口抛错不执行 / 机械接线断言' },
  { target: 'src/agents/pi-sdk.ts', symbol: 'tscTool.execute', status: 'converged', replacesWith: '经门链执行, 或在台账里登记为"内部诊断白名单"并写明理由', why: '内置诊断工具直调: 要么走门, 要么**显式登记**为白名单 —— 不许处于"没人知道它绕过"的状态。**2026-10-02 选"走门"并已接线**: 回合末尾 TS 自检先问 `beforeToolCall({tool: tsc_check, args: {}, ctx: harnessCtx(), permissionMode})`, 被拒或抛错 ⇒ **不执行**且**可见**报出 (拒绝不静默); 机械断言: 判定在 `tscTool.execute` 之前 + `if (!tscAllowed)` 分支存在 + 拒绝文案存在。**端到端未单独取证** (该路径由"本回合改过 TS"的收尾自检触发, 需要真 LLM 回合) ⇒ **2026-10-02 端到端取证完成** (`src/test/k7-tsc-tool-e2e.test.ts`, 真 LLM 回合 + 真门实例): ① 允许路 —— 门被问过 `tsc_check` 且恰执行一次 (门被问到 `read_file, edit_file, tsc_check`), 结论 `🔎 类型检查` 进对话流; ② 拒绝路 —— 门拒绝 ⇒ `tsc_check` **零执行** + 拒绝文案 (带门给出的理由) 进对话流。**两条变异都真做且判红**: 变异①把问门时的工具名改掉 ⇒ 允许路判红 (`expected [...] to include 「tsc_check」`); 变异②把拒绝分支改成 fail-open (`if (false && !tscAllowed)`) ⇒ 拒绝路判红 (`被门拒绝 ⇒ 一次都不许执行: expected 1 to be +0`)。**如实记边界**: 拒绝路里"拒绝"这个判定是测试注入的 (沿用仓里端口注入法), 产品侧被证的是"**先问门、被拒后不执行**"这一半; "门自己判出来的拒绝"由 pre-tool-validator/react-harness 既有用例覆盖。**踩坑两条**: (a) 少了 `initMinimax()` 装配 ⇒ session 走未初始化模型兜底路 (回显、不调工具), 门一次都不会被问 ⇒ 假红; (b) 少了 `resetAgentSession()` ⇒ `createAgentSession` 复用上一条用例的 session (带着"我改过这个文件了"的记忆) ⇒ 第二条用例的模型回"需求已完整满足"不调工具 ⇒ 前提假红。两条都写进用例头。',
    evidence: '2026-10-02 端到端: `src/test/k7-tsc-tool-e2e.test.ts` (真 LLM 回合 + 真门实例包裹) —— 允许路: 门被问过 `tsc_check` 且恰执行一次, `🔎 类型检查` 进对话流; 拒绝路 (判定注入): `tsc_check` 零执行 + 拒绝文案带理由进对话流。变异①(问门工具名改掉)⇒允许路判红; 变异②(拒绝分支改 fail-open)⇒拒绝路判红。**2026-10-02 K4-B 侦查补正**: 上面两条用的是**默认配置** (老 `runReActLoop`), 而**生产里 web 走 pivot 路径** (`usePivotLoop: true` + 流式入口原先"提前 return") ⇒ 那条自检在生产**一次都没跑过** (早先证据只覆盖非生产形状)。已修: 抽成 `runTurnEndTypecheck()`, **三条路径全挂** (pivot prompt / 老 loop / 流式 pivot); 用例补第三条"生产形状" (注入 touched 状态 ⇒ 判**接线**), **变异 (撤掉流式路径那行) ⇒ 判红** (`expected [] to include tsc_check`)。' },
  { target: 'src/agents/pi-sdk.ts', symbol: 'getSkillRegistry', replacesWith: '返回**受门包装** (`GuardedSkillRegistry`): `execute` / `get().execute` / `list()[].execute` 三条都经 `executeSkill` ⇒ Harness', status: 'converged', evidence: '2026-10-02 按 leo 口径 **(b)** 落地 (原选 a 为纸面约定, leo 裁定走 b): ① 包装堵住**三条**隐藏路径 —— 只堵 `execute` 不够, `get()`/`list()` 返回的 `Skill` 自带裸 `execute`; ② 真跑 `k7-session-skill-gate.test.ts` ⑥: allow 时三条各恰一次 (计数 3), `denyTool` 后**三条全零执行** (计数仍 3); ③ 真变异两条 (`list` 裸透传 / `get` 裸透传) 均判红 (`expected FACADE_EXECUTED to match /^拒绝: /`), 还原回绿; ④ 机械断言: 方法体内无 `return this.skillRegistry;`、`list` 过 `guarded` 映射、**零** `this.skillRegistry.execute(` 直连。⚠️ 行为变更 (可能属破坏性, leo 已知并裁定): 旧 `.execute()` 被拒时**不再执行**, 改为返回 `拒绝: [...]`; 方法名/签名不变 ⇒ 源码级兼容。**管不到的一条 (如实记)**: 调用方自己 `register` 时传进来的那个对象仍有裸 `execute` —— 那是调用方的对象, 不属本出口能管的面', why: '**未过门的原始出口**: 拿到裸 registry 就有三条绕过 Harness 的路径 (`execute` / `get().execute` / `list()[].execute`) —— 公开兼容面不许无声删, 但也**不许不登记** (leo 的最终要求: 任何 skill 执行入口只能经 Harness)' },
  { target: 'src/bollharness-integration/skill-adapter.ts', symbol: 'registry.execute', replacesWith: '收敛成唯一 skill 执行入口 (且该入口经门)', status: 'converged', evidence: '2026-10-02 两条路都真跑取证+变异验证: ① adapter 路 `k7-skill-denylist-e2e.test.ts` (真 session→真 Harness→integration→adapter) ② 公开出口路 `k7-session-skill-gate.test.ts` (`executeSkill` 探针 skill 计数: 允许恰 1 次执行返回标记 · deny **零执行** · 重试仍拒 · 放开又能执行); 两处变异(拆保护/门永远放行)均判红 ⇒ 用例承重', why: 'skill 有两条执行路径 ⇒ 必然一条有门一条没有 ("同一个能力只许有一套实现" 的同型教训). **2026-10-02 实测**: 活路径 = `SkillAdapter.executeSkill` (`bollharness-integration/integration.ts` ← `index.ts` 的 harness 入口); `PiAgentSession.executeSkill` **生产零调用者** (但属公开契约 ⇒ 删除待用户口径). 活路径已接线: 端口 (`setGuardedExecute`, **判定**契约) + integration 透传 (`setSkillGuard`) + `index.ts` 活路径注入 (门建不起来 ⇒ deny-all); **真跑已通 (allow 路)**: `node dist/index.js --harness-skill arch get_gate` 真执行并返回真实 skill 输出 —— **注意读的地方**: 响应经"启动期日志闸门"写进 `~/.bolloon/logs/startup.log` (`[boot] 🎯 Skill <name> 执行结果:`), **stdout 里看不到** (我上一轮据此误判"没走到分发器", 是假阴性); 且无 `[K7] skill 门未能建立` 警告 ⇒ 门确实建起来了。**deny 路已取得 ★真跑**: `k7-skill-denylist-e2e.test.ts` 走**真链** (真 session → 真 Harness 的 deny-list checker → integration → adapter → registry): allow 基线不被拒 · 把 `skill:arch` 放进拒绝列表 ⇒ 结果 `拒绝: [deny-list]` 且拿不到 skill 真实输出 · 重试仍被拒 · 放开名单 ⇒ 又能执行; **变异** (拆掉 adapter 的门分支) ⇒ 该用例判红, 还原 ⇒ 回绿且无 diff ⇒ **用例承重**。**状态仍 open**: 本条目含两条路径, 公开兼容面 (`PiAgentSession.executeSkill`) 未收敛 (leo 第 4 步: 降为兼容转发 ⇒ 唯一 SkillExecutionPort)' },
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
  execSitesTotal: 18,   // 17 (普查基线) + 1 (K7 第二步 b: pivot loop 的端口内执行, 在门之后)
  bypasses: 0,          // 3 → 2 (pivot loop) → 1 (getSkillRegistry 受门包装, leo 口径 (b)) → **0** (tscTool 端到端取证完成: 允许路/拒绝路真回合 + 两条变异, 2026-10-02)
};
