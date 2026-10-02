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
  { file: 'agents/pi-sdk.ts', kind: 'adapter-internal', method: 'prompt', count: 1, path: 'direct', targetPhase: 'K4', note: "适配器内部 pivot 分派 (不是外部入口)" },
  { file: 'agents/pi-sdk.ts', kind: 'adapter-internal', method: 'promptWithPivotLoop', count: 2, path: 'direct', targetPhase: 'K4', note: "适配器内部 pivot 分派 (不是外部入口)" },
  { file: 'agents/runner-resolver.ts', kind: 'agent-entry', method: 'prompt', count: 1, path: 'direct', targetPhase: 'K3', note: "独立宿主: 目前直调" },
  { file: 'cli/interface.ts', kind: 'readline-tui', method: 'prompt', count: 3, path: 'queued', targetPhase: 'K3', note: "readline 输入提示, 非 agent 入口" },
  { file: 'index.ts', kind: 'agent-entry', method: 'prompt', count: 7, path: 'direct', targetPhase: 'K3', note: "CLI 装配点" },
  { file: 'index.ts', kind: 'agent-entry', method: 'promptStream', count: 1, path: 'direct', targetPhase: 'K3', note: "CLI 装配点" },
  { file: 'web/routes-tasks.ts', kind: 'agent-entry', method: 'prompt', count: 1, path: 'direct', targetPhase: 'K3', note: "任务路由: 目前直调" },
  { file: 'web/server.ts', kind: 'agent-entry', method: 'prompt', count: 3, path: 'direct', targetPhase: 'K3', note: "Web 主入口: 唯一有 per-channel queue, 但仍直调 11 处" },
  { file: 'web/server.ts', kind: 'agent-entry', method: 'promptStream', count: 8, path: 'direct', targetPhase: 'K3', note: "Web 主入口: 唯一有 per-channel queue, 但仍直调 11 处" },
];

/** 直调 `prompt*()` 的调用点总数 (K3 只许把它压到 0; 棘轮只许减) */
export const ENTRY_DIRECT_CALLS_FROZEN_AT = 24;

/**
 * ④ 旧代码删除台账 (leo 的 8 字段; 每批删除必写一条)。目前为空 —— 但**不是空门**:
 * 候选集由 DELETION_CANDIDATE_SHA256 冻结, 一增一删都判红; 记录格式由 validateDeletionRecord 判。
 */
export interface DeletionRecord {
  target: string;
  oldEntry: string;
  replacement: string;
  remainingRefs: number;
  runtimeHits: number;
  acceptance: string;
  rollbackCommit: string;
  deletedAt: string;
}

export const DELETION_LEDGER: readonly DeletionRecord[] = [];

/** 第一批删除候选 = 产品码里 **0 入边引用** 且非入口形态 (机械派生, 不手写) */
export const DELETION_CANDIDATE_COUNT = 96;
export const DELETION_CANDIDATE_SHA256 = 'ae4eb58afef92c4923f4051080b36f2ac214749e1deae3994204ca1e24bca374';
export const DELETION_CANDIDATE_DIRS: Readonly<Record<string, number>> = {"agents": 5, "bollharness-integration": 1, "bollharness": 61, "cli": 1, "(根)": 1, "judgeness": 3, "kernel": 2, "llm": 1, "network": 3, "orbitdb": 2, "scripts": 1, "social": 2, "utils": 3, "web": 10};
