/**
 * K0 ②③④ —— 模块 owner 名册 · 入口调用关系图 · 旧代码删除台账 (冻结面, 数据, 零 import)
 *
 * 这三样是 leo 修订版 K0 的缺项 (原 K0 只交了 import 白名单 / 越权检测 / 行数棘轮)。
 * 判据: src/test/kernel-plan.test.ts; 纯函数: src/kernel/gate-scan.ts。
 *
 * 生成口径 (防"好看的架构图"):
 *   · owner 名册由**真实文件清单机械生成** + 逐条处置 —— 门枚举 src/ 每个产品码文件, 必须恰好命中一条;
 *   · ENTRY_GRAPH 每行由**判据自己扫出来的**调用点填 (不手写): 门重扫一次必须逐字相等 (含 count);
 *   · 删除候选集用**集合 sha256** 冻结: 增/删/替换任一条都变哈希 ⇒ 红。
 */

export type Disposition = 'keep' | 'converge' | 'migrate' | 'freeze' | 'delete-candidate';

export interface ModuleOwner {
  /** 相对 src/ 的路径键 (目录以 / 结尾按前缀, 文件按全名相等); 归属按**最长前缀**判定 */
  key: string;
  module: string;
  /** 唯一 owner —— 写**角色线**不写人名 (人会走, 角色线不走) */
  owner: string;
  disposition: Disposition;
  /** 由哪个阶段处置 */
  phase: string;
  note: string;
}

/** ② 模块 owner 名册 —— 覆盖 src/ 全部产品码 (test/ 与 constraint-runtime/ 另册) */
export const MODULE_OWNERS: readonly ModuleOwner[] = [
  { key: 'kernel/', module: 'kernel', owner: '内核线', disposition: 'keep', phase: 'K0', note: "K1/K2/K3 三道门 + 台账" },
  { key: 'agents/pi-sdk.ts', module: 'adapter', owner: '推理适配器线', disposition: 'converge', phase: 'K2/K4/K10', note: "Pi 可变状态外置 → 拆 Adapter" },
  { key: 'agents/workflow-pivot-loop.ts', module: 'adapter', owner: '推理适配器线', disposition: 'converge', phase: 'K4', note: "旧 loop 降为策略" },
  { key: 'agents/loop-review.ts', module: 'adapter', owner: '推理适配器线', disposition: 'converge', phase: 'K4', note: "并进 KernelLoop 的 reducer 段" },
  { key: 'agents/react-loop.ts', module: 'adapter', owner: '推理适配器线', disposition: 'converge', phase: 'K4', note: "并进 KernelLoop" },
  { key: 'agents/pi-sdk-tools.ts', module: 'tools', owner: 'Tool 线', disposition: 'converge', phase: 'K7', note: "经 Harness 唯一门" },
  { key: 'agents/pi-harness.ts', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "已是唯一门面, 继续补齐" },
  { key: 'agents/deny-pipeline.ts', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'agents/pre-tool-validator.ts', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'agents/permission-mode.ts', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'agents/shell-guard.ts', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'agents/goal-store.ts', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "唯一事实来源" },
  { key: 'agents/run-store.ts', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "唯一事实来源" },
  { key: 'agents/decision-store.ts', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "" },
  { key: 'agents/plan-store.ts', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "" },
  { key: 'agents/pi-sdk-session-manager.ts', module: 'channel', owner: 'Channel 线', disposition: 'converge', phase: 'K2', note: "Session 不再是全局可变状态中心" },
  { key: 'agents/pi-sdk-session-factory.ts', module: 'channel', owner: 'Channel 线', disposition: 'converge', phase: 'K2', note: "" },
  { key: 'agents/session-store.ts', module: 'channel', owner: 'Channel 线', disposition: 'keep', phase: 'K2', note: "" },
  { key: 'agents/', module: 'agents-misc', owner: 'Agent 装配线', disposition: 'converge', phase: 'K2/K7', note: "逐个判归宿: 状态类→state, 工具类→tools" },
  { key: 'llm/', module: 'llm', owner: 'Model 线', disposition: 'keep', phase: 'K6', note: "唯一写口保留, 加 ModelRuntime 只读层" },
  { key: 'security/', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'web/', module: 'channel-web', owner: 'Channel 线', disposition: 'converge', phase: 'K3/K5', note: "入口只能投递事件" },
  { key: 'cli/', module: 'cli', owner: 'CLI 表面线', disposition: 'converge', phase: 'K3', note: "与 Web 共用同一 KernelLoop" },
  { key: 'external-engines/', module: 'delegate', owner: '子 Agent 线', disposition: 'converge', phase: 'K7', note: "子 Agent 不能结束 Goal" },
  { key: 'bollharness/', module: 'bollharness', owner: '外部项目镜像', disposition: 'freeze', phase: '第一批审查', note: "**不是 Bolloon 运行时**; 68 文件, 61 个 0 入边" },
  { key: 'bollharness-integration/', module: 'bollharness-integration', owner: 'Harness 集成线', disposition: 'freeze', phase: '第一批审查', note: "" },
  { key: 'bootstrap/', module: 'bootstrap', owner: '装配/上下文线', disposition: 'converge', phase: 'K2', note: "Context 归 RunContext/ChannelContext" },
  { key: 'context-compaction/', module: 'bootstrap', owner: '装配/上下文线', disposition: 'converge', phase: 'K2', note: "" },
  { key: 'cron/', module: 'channel', owner: 'Channel 线', disposition: 'converge', phase: 'K3', note: "入口只能投递事件" },
  { key: 'network/', module: 'communication', owner: '通信线', disposition: 'converge', phase: 'K8', note: "绝不能 transport → agent.promptStream" },
  { key: 'git-transport/', module: 'communication', owner: '通信线', disposition: 'converge', phase: 'K8', note: "" },
  { key: 'orbitdb/', module: 'communication', owner: '通信线', disposition: 'keep', phase: 'K8', note: "群/事件层已被 P0-P5 验收" },
  { key: 'heartbeat/', module: 'communication', owner: '通信线', disposition: 'converge', phase: 'K8', note: "" },
  { key: 'social/', module: 'communication', owner: '通信线', disposition: 'converge', phase: 'K8', note: "" },
  { key: 'pi-ecosystem-judgment/', module: 'judgment', owner: '判断力线', disposition: 'converge', phase: 'K7', note: "经 Harness 接入" },
  { key: 'judgeness/', module: 'judgment', owner: '判断力线', disposition: 'converge', phase: 'K7', note: "" },
  { key: 'pi-ecosystem-mcp/', module: 'judgment', owner: 'MCP 线', disposition: 'converge', phase: 'K7', note: "MCP 不能绕过 Harness" },
  { key: 'pi-ecosystem-a2ui/', module: 'judgment', owner: 'UI 桥线', disposition: 'freeze', phase: 'K7', note: "" },
  { key: 'pi-ecosystem-goals/', module: 'state', owner: 'Goal-Run 线', disposition: 'freeze', phase: 'K2', note: "与 goal-store 职责待收敛" },
  { key: 'workflows/', module: 'adapter', owner: '推理适配器线', disposition: 'converge', phase: 'K4', note: "" },
  { key: 'documents/', module: 'tools', owner: 'Tool 线', disposition: 'converge', phase: 'K7', note: "" },
  { key: 'lsp/', module: 'tools', owner: 'Tool 线', disposition: 'converge', phase: 'K7', note: "" },
  { key: 'hooks/', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "hooks-engine 属策略面" },
  { key: 'constraints/', module: 'policy', owner: 'Harness 线', disposition: 'keep', phase: 'K7', note: "" },
  { key: 'storage/', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "" },
  { key: 'setup/', module: 'bootstrap', owner: '装配/上下文线', disposition: 'converge', phase: 'K2', note: "" },
  { key: 'utils/', module: 'shared', owner: '共享原语线', disposition: 'keep', phase: '—', note: "全仓可用的纯工具" },
  { key: 'locales/', module: 'shared', owner: '共享原语线', disposition: 'keep', phase: '—', note: "" },
  { key: 'efficode/', module: 'efficode', owner: '对外协议线', disposition: 'freeze', phase: '第一批审查', note: "AI 间交流语言, 不属内核" },
  { key: 'electron/', module: 'electron', owner: '桌面壳', disposition: 'freeze', phase: '第一批审查', note: "" },
  { key: 'migration/', module: 'migration', owner: '迁移脚本', disposition: 'freeze', phase: '第一批审查', note: "一次性" },
  { key: 'scripts/', module: 'scripts', owner: '内嵌脚本', disposition: 'freeze', phase: '第一批审查', note: "" },
  { key: 'cli-entry.ts', module: 'entry', owner: '入口装配', disposition: 'converge', phase: 'K3', note: "CLI 入口: 只能投递事件" },
  { key: 'index.ts', module: 'entry', owner: '入口装配', disposition: 'converge', phase: 'K3', note: "CLI/Web 装配点; 8 处直调 prompt" },
  { key: 'electron.ts', module: 'electron', owner: '桌面壳', disposition: 'freeze', phase: '第一批审查', note: "" },
  { key: 'electron-preload.ts', module: 'electron', owner: '桌面壳', disposition: 'freeze', phase: '第一批审查', note: "" },
  { key: 'pi-ecosystem-subagents/', module: 'judgment', owner: '子智能体线', disposition: 'converge', phase: 'K7', note: "" },
  { key: 'pi-ecosystem/', module: 'judgment', owner: '判断力/MCP 线', disposition: 'converge', phase: 'K7', note: "" },
  { key: 'agents/x402/', module: 'state', owner: 'Goal-Run 线', disposition: 'keep', phase: 'K2', note: "交易/支付事实层" },
];

/** 名册外的根 (各有自己的册子, 不混进产品码覆盖判据) */
export const OUT_OF_SCOPE_ROOTS: readonly string[] = ['test/', 'constraint-runtime/'];

/**
 * ③ 入口调用关系图 —— 全仓 `prompt*()` 真实调用点, 必须与下表**逐字相等** (含 count)。
 * kind: `agent-entry` 外部入口 / `adapter-internal` 适配器内部 / `readline-tui` 终端提示 (非 agent 入口)。
 * path: `direct` = 直接调用 (K3 要治的旁路); `queued` = 已排队或非 agent 入口。
 */
export interface EntryPoint {
  file: string;
  kind: 'agent-entry' | 'adapter-internal' | 'readline-tui';
  method: string;
  count: number;
  path: 'direct' | 'queued';
  targetPhase: string;
  note: string;
}

export const ENTRY_GRAPH: readonly EntryPoint[] = [
  // K5 步骤⑦: `runExecution` (一次性请求的唯一入口) 内部派发 —— 新增 prompt/promptStream 各一处
  { file: 'agents/pi-sdk.ts', kind: 'adapter-internal', method: 'prompt', count: 2, path: 'direct', targetPhase: 'K4', note: "适配器内部 pivot 分派 + runExecution 的非流式派发 (都不是外部入口)" },
  { file: 'agents/pi-sdk.ts', kind: 'adapter-internal', method: 'promptStream', count: 1, path: 'direct', targetPhase: 'K4', note: "runExecution 的流式派发 (K5 步骤⑦ 新增)" },
  { file: 'agents/pi-sdk.ts', kind: 'adapter-internal', method: 'promptWithPivotLoop', count: 2, path: 'direct', targetPhase: 'K4', note: "适配器内部 pivot 分派 (不是外部入口)" },
  { file: 'agents/runner-resolver.ts', kind: 'agent-entry', method: 'prompt', count: 1, path: 'direct', targetPhase: 'K3', note: "独立宿主: 目前直调" },
  { file: 'cli/interface.ts', kind: 'readline-tui', method: 'prompt', count: 3, path: 'queued', targetPhase: 'K3', note: "readline 输入提示, 非 agent 入口" },
  { file: 'index.ts', kind: 'agent-entry', method: 'prompt', count: 7, path: 'direct', targetPhase: 'K3', note: "CLI 装配点" },
  { file: 'index.ts', kind: 'agent-entry', method: 'promptStream', count: 1, path: 'direct', targetPhase: 'K3', note: "CLI 装配点" },
  { file: 'web/routes-tasks.ts', kind: 'agent-entry', method: 'prompt', count: 1, path: 'direct', targetPhase: 'K3', note: "任务路由: 目前直调" },
  { file: 'web/server.ts', kind: 'agent-entry', method: 'prompt', count: 3, path: 'direct', targetPhase: 'K3', note: "Web 主入口 (非流式 3 处仍直调)" },
  { file: 'web/server.ts', kind: 'agent-entry', method: 'promptStream', count: 7, path: 'direct', targetPhase: 'K3', note: "Web 主入口: 1 处已改请求式 (K5 步骤⑦), 余 10 处仍直调" },
];

/**
 * 直调 `prompt*()` 的调用点总数 (K3 只许把它压到 0; 棘轮只许减)。
 * ⚠️ 24 → **25** (2026-10-02, K5 步骤⑦): `runExecution` 内部新增 `prompt`/`promptStream` 派发各 1 处 (+2),
 *    web/server.ts 用户消息路径改成请求式 (-1)。**这是"形态变化"不是"旁路复活"** —— 见 ENTRY_GRAPH 的两行 adapter-internal。
 */
export const ENTRY_DIRECT_CALLS_FROZEN_AT = 25;

/**
 * ④ 旧代码删除台账 (leo 的 8 字段; 每批删除必写一条)。目前为空 —— 但**不是空门**:
 * 候选集由 DELETION_CANDIDATE_SHA256 冻结, 一增一删都判红; 记录格式由 validateDeletionRecord 判。
 */
export interface DeletionRecord {
  target: string;
  /** 该条记录覆盖的**逐个文件** (相对仓根) —— 组记录必须列出成员, 便于逐条复核 */
  targets?: readonly string[];
  oldEntry: string;
  replacement: string;
  remainingRefs: number;
  runtimeHits: number;
  acceptance: string;
  rollbackCommit: string;
  deletedAt: string;
}

export const DELETION_LEDGER: readonly DeletionRecord[] = [
  {
    target: 'src/constraint-runtime/src/migrations/',
    oldEntry: '无 (0 引用; 不在 CR/src/index.ts 导出面)',
    replacement: '无 (0 引用; 不在 CR/src/index.ts 导出面)',
    remainingRefs: 0,
    runtimeHits: 0,
    acceptance: 'tsc --noEmit 0 错 · 四道 kernel 门 75/75 · 引用面核验 0 处 · pre-commit 聚焦套件',
    rollbackCommit: '9808e8e',
    deletedAt: '2026-10-02',
  },
  {
    target: 'src/constraint-runtime/src/remote/',
    oldEntry: '无 (0 引用; 不在 CR/src/index.ts 导出面)',
    replacement: '无 (0 引用; 不在 CR/src/index.ts 导出面)',
    remainingRefs: 0,
    runtimeHits: 0,
    acceptance: 'tsc --noEmit 0 错 · 四道 kernel 门 75/75 · 引用面核验 0 处 · pre-commit 聚焦套件',
    rollbackCommit: '9808e8e',
    deletedAt: '2026-10-02',
  },

  {
    target: 'src/constraint-runtime/src/<26 个移植存档壳>/index.ts',
    targets: ['src/constraint-runtime/src/assistant/index.ts', 'src/constraint-runtime/src/bootstrap/index.ts', 'src/constraint-runtime/src/bridge/index.ts', 'src/constraint-runtime/src/buddy/index.ts', 'src/constraint-runtime/src/cli/index.ts', 'src/constraint-runtime/src/components/index.ts', 'src/constraint-runtime/src/constants/index.ts', 'src/constraint-runtime/src/coordinator/index.ts', 'src/constraint-runtime/src/entrypoints/index.ts', 'src/constraint-runtime/src/hooks/index.ts', 'src/constraint-runtime/src/keybindings/index.ts', 'src/constraint-runtime/src/memdir/index.ts', 'src/constraint-runtime/src/moreright/index.ts', 'src/constraint-runtime/src/native_ts/index.ts', 'src/constraint-runtime/src/output_styles/index.ts', 'src/constraint-runtime/src/plugins/index.ts', 'src/constraint-runtime/src/schemas/index.ts', 'src/constraint-runtime/src/screens/index.ts', 'src/constraint-runtime/src/server/index.ts', 'src/constraint-runtime/src/services/index.ts', 'src/constraint-runtime/src/state/index.ts', 'src/constraint-runtime/src/types/index.ts', 'src/constraint-runtime/src/upstream_proxy/index.ts', 'src/constraint-runtime/src/utils/index.ts', 'src/constraint-runtime/src/vim/index.ts', 'src/constraint-runtime/src/voice/index.ts'],
    oldEntry: '26 个 15 行移植存档壳 (assistant/bootstrap/bridge/.../voice): 每个 import _archive_helper 并读 reference_data/subsystems/<name>.json 快照, 自述为 "Python placeholder package"',
    replacement: '无 (包入口闭包外 + 主仓 0 引用 + 不在任何快照的 source_hint 里)',
    remainingRefs: 0,
    runtimeHits: 0,
    acceptance: 'CR tsc 0 错 · 主仓 tsc 0 错 · 五道 kernel 门全绿 · 引用 CR 的两个主仓测试 20/20 · 运行期真跑 require(dist/index.js) 25 个导出完好 · 干净重建 dist 保留文件逐字节一致',
    rollbackCommit: '3b1bc42',
    deletedAt: '2026-10-02',
  },
  {
    target: 'src/constraint-runtime/src/_archive_helper.ts',
    targets: ['src/constraint-runtime/src/_archive_helper.ts'],
    oldEntry: 'loadArchiveMetadata(): 读 reference_data/subsystems/<name>.json —— 只被上面 26 个存档壳调用',
    replacement: '无 (随存档壳一起消失; reference_data/subsystems/*.json 变为孤立数据, 待第③批处置)',
    remainingRefs: 0,
    runtimeHits: 0,
    acceptance: '同上 (同一批)',
    rollbackCommit: '3b1bc42',
    deletedAt: '2026-10-02',
  },
  {
    target: 'src/constraint-runtime/src/<6 个根级移植残留>.ts',
    targets: ['src/constraint-runtime/src/_archive_helper.ts', 'src/constraint-runtime/src/cost_hook.ts', 'src/constraint-runtime/src/execution_registry.ts', 'src/constraint-runtime/src/ink.ts', 'src/constraint-runtime/src/port_manifest.ts', 'src/constraint-runtime/src/query.ts', 'src/constraint-runtime/src/system_init.ts'],
    oldEntry: 'cost_hook / execution_registry / ink / port_manifest / query / system_init —— 移植快照的根级镜像文件',
    replacement: '无 (闭包外 + 主仓 0 引用 + 快照 0 点名)',
    remainingRefs: 0,
    runtimeHits: 0,
    acceptance: '同上 (同一批)',
    rollbackCommit: '3b1bc42',
    deletedAt: '2026-10-02',
  },
];

/** 第一批删除候选 = 产品码里 **0 入边引用** 且非入口形态 (机械派生, 不手写) */
export const DELETION_CANDIDATE_COUNT = 94;
export const DELETION_CANDIDATE_SHA256 = '8ec437279513ddb82e0d909338c84d003486c3905143615b2b86f76d0d070112';
export const DELETION_CANDIDATE_DIRS: Readonly<Record<string, number>> = {"agents": 5, "bollharness-integration": 1, "bollharness": 61, "cli": 1, "(根)": 1, "judgeness": 3, "llm": 1, "network": 3, "orbitdb": 2, "scripts": 1, "social": 2, "utils": 3, "web": 10};
