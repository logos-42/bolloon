/**
 * **K1 —— constraint-runtime 三层分类名册 (primitives / runtime-adapters / domain-libraries)**
 *
 * 依据: leo 修订版 K1 —— ① 先统计真实 import ② 移除无调用模块 ③ 删假连接/placeholder
 * ④ 领域模块改显式 Tool Provider ⑤ 最后删旧导出与兼容层。**本文件是第 ① 步的产物** (统计 + 分类), 不是删除本身。
 *
 * 判据: src/test/kernel-constraint.test.ts; 纯函数: src/kernel/gate-scan.ts。
 *
 * K1 真读出来的四条事实 (写在这里, 免得下一轮重新发现):
 *   · 源码 **94 文件 / 2492 行** (A 15 / B 24 / C 55);
 *   · **33 个 ≤20 行的空壳 index.ts** (共 460 行) —— 移植留下的骨架;
 *   · **dist/ 里 89 个构建产物** (1164 行) 被 commit 进 src/ (本身不该在源码树里);
 *   · constraint-runtime **自带的 4 个测试从来不跑** —— 仓里 vitest 配置把整个 constraint-runtime 目录排除在外 (见 vitest.config.ts 的 exclude)。
 */

export type ConstraintClass = 'A' | 'B' | 'C' | 'BUILD' | 'META';

export interface ConstraintRule {
  /** 相对 src/constraint-runtime/ 的路径键 (目录以 / 结尾按前缀; 归属按**最长前缀**) */
  key: string;
  cls: ConstraintClass;
  why: string;
  phase: string;
}

/** 三层分类 (A 原语 / B 领域工具 / C 不进 Kernel) + BUILD/META */
export const CONSTRAINT_RULES: readonly ConstraintRule[] = [
  { key: '__pkg_entry__', cls: 'A', why: "包入口公开面 —— 主仓经它拿到的是原语/会话/技能类型 (具体哪个符号见 A_ENTRY_USES)", phase: 'K1' },
  { key: 'src/constraint/', cls: 'A', why: "约束原语: ToolPermissionContext + BudgetTracker (leo 点名的 A 类)", phase: 'K1' },
  { key: 'src/skills/', cls: 'A', why: "SkillRegistry (技能元数据注册; 与执行器分离)", phase: 'K1' },
  { key: 'src/agent/', cls: 'A', why: "AgentCoordinator: 子任务协调原语", phase: 'K1' },
  { key: 'src/thinking/', cls: 'A', why: "DeepThinkingEngine: 推理原语 (K1 里复核是否该归 adapter)", phase: 'K1' },
  { key: 'src/execution_registry.ts', cls: 'A', why: "执行登记 (幂等/在跑)", phase: 'K1' },
  { key: 'src/tool_pool.ts', cls: 'A', why: "工具池 (调度侧; 不负责副作用)", phase: 'K1' },
  { key: 'src/session_store.ts', cls: 'A', why: "Session 存取 (只读纯函数部分; 可变 Session 不在此册)", phase: 'K1' },
  { key: 'src/cost_tracker.ts', cls: 'A', why: "用量计数 (K6 usage 记录会用到)", phase: 'K1' },
  { key: 'src/models.ts', cls: 'A', why: "模型/能力描述 (capability registry)", phase: 'K1' },
  { key: 'src/cost_hook.ts', cls: 'A', why: "用量钩子", phase: 'K1' },
  { key: 'src/tools/WalletTools/', cls: 'B', why: "WalletTools: 经 Tool Capability 接入", phase: 'K7' },
  { key: 'src/tools/SafeSDK/', cls: 'B', why: "SafeSDK", phase: 'K7' },
  { key: 'src/tools/PolymarketSDK/', cls: 'B', why: "PolymarketSDK", phase: 'K7' },
  { key: 'src/tools/OpenCLI/', cls: 'B', why: "OpenCLI", phase: 'K7' },
  { key: 'src/remote/', cls: 'C', why: "remote/ssh/teleport 占位实现 —— 不进核心", phase: '第一批' },
  { key: 'src/remote_runtime.ts', cls: 'C', why: "假连接/假成功的 remote runtime (leo 第一批点名的清理对象)", phase: '第一批' },
  { key: 'src/upstream_proxy/', cls: 'C', why: "上游代理占位", phase: '第一批' },
  { key: 'src/_archive_helper.ts', cls: 'C', why: "archive 辅助 (不进运行时包)", phase: '第一批' },
  { key: 'src/reference_data/', cls: 'C', why: "reference 数据 (不进运行时包)", phase: '第一批' },
  { key: 'src/parity_audit.ts', cls: 'C', why: "迁移期 parity 审计 (一次性)", phase: '第一批' },
  { key: 'src/migrations/', cls: 'C', why: "迁移脚本 (一次性)", phase: '第一批' },
  { key: 'src/native_ts/', cls: 'C', why: "旧移植层 (native ts)", phase: '第一批' },
  { key: 'src/screens/', cls: 'C', why: "TUI 屏", phase: '第一批' },
  { key: 'src/components/', cls: 'C', why: "TUI 组件", phase: '第一批' },
  { key: 'src/keybindings/', cls: 'C', why: "键位表", phase: '第一批' },
  { key: 'src/vim/', cls: 'C', why: "vim 模式", phase: '第一批' },
  { key: 'src/voice/', cls: 'C', why: "语音", phase: '第一批' },
  { key: 'src/output_styles/', cls: 'C', why: "输出样式", phase: '第一批' },
  { key: 'src/moreright/', cls: 'C', why: "终端渲染 (移植层)", phase: '第一批' },
  { key: 'src/buddy/', cls: 'C', why: "彩蛋壳", phase: '第一批' },
  { key: 'src/assistant/', cls: 'C', why: "助手壳", phase: '第一批' },
  { key: 'src/ink.ts', cls: 'C', why: "ink 渲染入口", phase: '第一批' },
  { key: 'src/setup.ts', cls: 'C', why: "移植层 setup", phase: '第一批' },
  { key: 'src/system_init.ts', cls: 'C', why: "移植层初始化", phase: '第一批' },
  { key: 'src/deferred_init.ts', cls: 'C', why: "移植层延迟初始化", phase: '第一批' },
  { key: 'src/bootstrap_graph.ts', cls: 'C', why: "移植层依赖图", phase: '第一批' },
  { key: 'src/bootstrap/', cls: 'C', why: "移植层 bootstrap", phase: '第一批' },
  { key: 'src/command_graph.ts', cls: 'C', why: "移植层命令图", phase: '第一批' },
  { key: 'src/commands.ts', cls: 'C', why: "移植层命令表", phase: '第一批' },
  { key: 'src/direct_modes.ts', cls: 'C', why: "移植层直接模式", phase: '第一批' },
  { key: 'src/entrypoints/', cls: 'C', why: "移植层入口", phase: '第一批' },
  { key: 'src/cli/', cls: 'C', why: "移植层 CLI", phase: '第一批' },
  { key: 'src/schemas/', cls: 'C', why: "移植层 schema", phase: '第一批' },
  { key: 'src/services/', cls: 'C', why: "移植层服务", phase: '第一批' },
  { key: 'src/server/', cls: 'C', why: "移植层 server", phase: '第一批' },
  { key: 'src/state/', cls: 'C', why: "移植层 state", phase: '第一批' },
  { key: 'src/memdir/', cls: 'C', why: "移植层 memory dir", phase: '第一批' },
  { key: 'src/history.ts', cls: 'C', why: "移植层 history", phase: '第一批' },
  { key: 'src/context.ts', cls: 'C', why: "移植层 context", phase: '第一批' },
  { key: 'src/prefetch.ts', cls: 'C', why: "移植层 prefetch", phase: '第一批' },
  { key: 'src/query.ts', cls: 'C', why: "移植层 query", phase: '第一批' },
  { key: 'src/bridge/', cls: 'C', why: "移植层 bridge", phase: '第一批' },
  { key: 'src/coordinator/', cls: 'C', why: "移植层 coordinator 壳", phase: '第一批' },
  { key: 'src/plugins/', cls: 'C', why: "移植层插件", phase: '第一批' },
  { key: 'src/types/', cls: 'C', why: "移植层类型", phase: '第一批' },
  { key: 'src/utils/', cls: 'C', why: "移植层 utils", phase: '第一批' },
  { key: 'src/constants/', cls: 'C', why: "移植层常量", phase: '第一批' },
  { key: 'src/runtime/', cls: 'C', why: "移植层 runtime", phase: '第一批' },
  { key: 'src/hooks/', cls: 'C', why: "移植层 hooks (与主仓 hooks-engine 无关)", phase: '第一批' },
  { key: 'src/dynamic-tool-loader.ts', cls: 'C', why: "动态工具加载 (占位)", phase: '第一批' },
  { key: 'src/tools.ts', cls: 'C', why: "移植层 tools 聚合", phase: '第一批' },
  { key: 'src/transcript.ts', cls: 'C', why: "移植层 transcript", phase: '第一批' },
  { key: 'src/index.ts', cls: 'C', why: "移植层包入口 (Kernel 不用; 主仓用的是包入口的公开导出)", phase: '第一批' },
  { key: 'src/port_manifest.ts', cls: 'C', why: "移植清单", phase: '第一批' },
  { key: 'src/platform.d.ts', cls: 'C', why: "类型垫片", phase: '第一批' },
  { key: 'dist/', cls: 'BUILD', why: "构建产物 (99 个 .d.ts/.js) —— **不该进 src/**; 不入三层名单, 单独冻结计数", phase: '第一批' },
  { key: 'tests/', cls: 'C', why: "constraint-runtime 自带测试 (4 文件) —— 但 vitest 配置 `**/constraint-runtime/**` 把整个目录排除了 ⇒ **它们从来不跑** (K1 真发现)", phase: '第一批' },
  { key: 'package.json', cls: 'META', why: "包元数据", phase: 'K1' },
  { key: 'package-lock.json', cls: 'META', why: "锁文件", phase: 'K1' },
  { key: 'tsconfig.json', cls: 'META', why: "包 tsconfig", phase: 'K1' },
  { key: 'node_modules/', cls: 'META', why: "依赖 (不入仓判断)", phase: 'K1' },
];

/** 扫描基座 (相对 src/) + 不算源码的子树 */
export const CONSTRAINT_ROOT = 'constraint-runtime/';
export const CONSTRAINT_NON_SOURCE = ['dist/', 'node_modules/'];

/** 冻结量: 源码 / 空壳 / 构建产物 (棘轮: 只许减) */
export const CONSTRAINT_SRC_FILES = 92;
export const CONSTRAINT_SRC_LINES = 2460;
export const CONSTRAINT_STUB_FILES = 31;
export const CONSTRAINT_STUB_LINES = 428;
export const CONSTRAINT_DIST_FILES = 89;
export const CONSTRAINT_DIST_LINES = 1164;

/** 各层文件数 / 行数冻结值 */
export const CONSTRAINT_CLASS_FILES: Readonly<Record<string, number>> = {"C": 53, "A": 15, "B": 24};
export const CONSTRAINT_CLASS_LINES: Readonly<Record<string, number>> = {"C": 1262, "A": 401, "B": 797};

/**
 * A 类原语的**接入说明** —— 不能自称「原语」就算数:
 *   `pkg-entry`  = 主仓经 `@bolloon/constraint-runtime` 包入口拿到 (有引用者作证);
 *   `unused-debt` = **没有任何证据说明被用** —— 登记在册, K1 复核后决定留/删 (棘轮只许减)。
 */
export interface AEntryUse { key: string; usedVia: 'pkg-entry' | 'unused-debt'; evidence: string; }
export const A_ENTRY_USES: readonly AEntryUse[] = [
  { key: 'src/constraint/', usedVia: 'pkg-entry', evidence: 'agents/constraint-layer.ts 取 ToolPermissionContext / BudgetTracker' },
  { key: 'src/skills/', usedVia: 'pkg-entry', evidence: 'pi-sdk.ts / skill-loader.ts / bollharness skill-adapter 取 SkillRegistry' },
  { key: 'src/agent/', usedVia: 'pkg-entry', evidence: 'pi-sdk.ts 取 AgentCoordinator' },
  { key: 'src/thinking/', usedVia: 'pkg-entry', evidence: 'pi-sdk.ts 取 DeepThinkingEngine' },
  { key: 'src/session_store.ts', usedVia: 'pkg-entry', evidence: 'pi-sdk.ts / pi-sdk-session-manager.ts 取 Session/saveSession/loadSession' },
  { key: 'src/execution_registry.ts', usedVia: 'unused-debt', evidence: '主仓 0 引用 —— 待复核' },
  { key: 'src/tool_pool.ts', usedVia: 'unused-debt', evidence: '主仓 0 引用 —— 待复核' },
  { key: 'src/cost_tracker.ts', usedVia: 'unused-debt', evidence: '主仓 0 引用; K6 的 usage 记录若要用则转 pkg-entry' },
  { key: 'src/cost_hook.ts', usedVia: 'unused-debt', evidence: '主仓 0 引用 —— 待复核' },
  { key: 'src/models.ts', usedVia: 'unused-debt', evidence: '主仓 0 引用; 能力描述可与主仓 provider-registry 合并' },
];

/** A 类里「主仓 0 引用」的条数冻结值 (棘轮: 只许减) */
export const A_UNUSED_DEBT_FROZEN_AT = 5;

/** ② 主仓对 constraint-runtime 的真实引用台账 (只有这些点; 多一个就红) */
export interface ConstraintUse { file: string; target: string; count: number; kind: 'prod' | 'test'; cls: ConstraintClass; }
export const CONSTRAINT_USES: readonly ConstraintUse[] = [
  { file: 'agents/constraint-layer.ts', target: '__pkg_entry__', count: 1, kind: 'prod', cls: 'A' },
  { file: 'agents/pi-sdk-session-manager.ts', target: '__pkg_entry__', count: 1, kind: 'prod', cls: 'A' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/cancelOrder', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/createOrder', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/getMarket', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/getOrders', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/listMarkets', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/SafeSDK/deploySafe', count: 2, kind: 'prod', cls: 'B' },
  { file: 'agents/pi-sdk.ts', target: '__pkg_entry__', count: 2, kind: 'prod', cls: 'A' },
  { file: 'agents/skill-loader.ts', target: '__pkg_entry__', count: 1, kind: 'prod', cls: 'A' },
  { file: 'bollharness-integration/gate-state-machine.ts', target: '__pkg_entry__', count: 1, kind: 'prod', cls: 'A' },
  { file: 'bollharness-integration/skill-adapter.ts', target: '__pkg_entry__', count: 1, kind: 'prod', cls: 'A' },
  { file: 'test/econ-integration.test.ts', target: 'tools/PolymarketSDK/econ-integration', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/cancelOrder', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/clobShared', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/createOrder', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/getMarket', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/getOrders', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/PolymarketSDK/listMarkets', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/WalletTools/createWallet', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/WalletTools/getBalance', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/WalletTools/importWallet', count: 1, kind: 'test', cls: 'B' },
  { file: 'test/wallet-polymarket-verify.test.ts', target: 'tools/WalletTools/signMessage', count: 1, kind: 'test', cls: 'B' },
];

/**
 * ③ **B 类欠账**: 领域库 (Wallet/Safe/Polymarket/OpenCLI) 只能经 **Tool Capability** 接入,
 * 而实测它们被主仓**直接 import** —— 全部登记, 由 K7 (Harness 唯一系统调用门) 还清。棘轮: 只许减。
 */
export interface BDirectImport { file: string; target: string; count: number; payDownIn: 'K7'; }
export const B_DIRECT_IMPORT_DEBT: readonly BDirectImport[] = [
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/cancelOrder', count: 2, payDownIn: 'K7' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/createOrder', count: 2, payDownIn: 'K7' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/getMarket', count: 2, payDownIn: 'K7' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/getOrders', count: 2, payDownIn: 'K7' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/PolymarketSDK/listMarkets', count: 2, payDownIn: 'K7' },
  { file: 'agents/pi-sdk-tools.ts', target: 'tools/SafeSDK/deploySafe', count: 2, payDownIn: 'K7' },
];
export const B_DIRECT_IMPORT_FROZEN_AT = 12;

/**
 * 引用台账的扫描面**排除名单** (冻结, 只许减):
 * 本门自己的测试文件里有"人造引用"探针串 (判别力自证用), 不排掉它就会被当成一条真引用
 * —— 这就是本仓那条老规矩: 拿子串当判据前, 先排除自己刚写的东西。
 */
export const CONSTRAINT_SCAN_EXCLUSIONS: readonly string[] = ['test/kernel-*.test.ts'];
