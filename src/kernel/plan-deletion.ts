/**
 * **K1 删除就绪台账** —— 每个候选对象给出 verdict + **引用证据**, 不许写「看起来没用」。
 *
 * leo 的五个删除条件 (缺一不许删): ① 有唯一替代路径 ② 全仓无有效 import / 动态引用 / 路由引用
 * ③ 真跑覆盖旧能力 ④ 一次完整回归 + 一次故障恢复 ⑤ 留可回滚提交点。
 *
 * 本文件是 K1 第 ① 步的真实产出: **核验推翻了直觉排序** —— 原以为 dist/ 与 33 个空壳最该先删,
 * 实测两者都是**运行期依赖** (dist 是 main/exports 目标; 33 个 stub 引 reference_data 快照)。
 * 真正 0 引用的只有 2 个 15 行 stub。
 *
 * 判据: src/test/kernel-deletion.test.ts (verdict 必须与盘上引用面**同步**, 不许烂成借口)。
 */

export type Verdict = 'ready' | 'blocked' | 'done' | 'not-deletable';

export interface Blocker { file: string; why: string }
export interface DeletionVerdict {
  group: string;
  /** 判别名 (缺省 = target basename) —— 目录目标要显式给真耦合名, 否则判据没判别力 */
  needle?: string;
  /** 相对仓根的路径 (文件写全名, 目录以 / 结尾) */
  target: string;
  verdict: Verdict;
  blockers: readonly Blocker[];
  reason: string;
}

export const DELETION_VERDICTS: readonly DeletionVerdict[] = [
  { group: 'CR 源: migrations/', target: 'src/constraint-runtime/src/migrations/', verdict: 'done', blockers: [], reason: "15 行 stub; 仓内(含 constraint-runtime 自身与 dist) 0 引用; **不在 `CR/src/index.ts` 的导出面** ⇒ 可直删" },
  { group: 'CR 源: remote/', target: 'src/constraint-runtime/src/remote/', verdict: 'done', blockers: [], reason: "15 行 stub; 0 引用; 不在导出面 ⇒ 可直删" },
  { group: 'CR/dist 构建产物 (89 文件/1164 行)', target: 'src/constraint-runtime/dist/', verdict: 'blocked', blockers: [{ file: 'src/agents/pi-sdk-tools.ts', why: "动态 import ../constraint-runtime/dist/tools/{PolymarketSDK/*,SafeSDK/deploySafe}.js (6 处)" }, { file: 'Dockerfile', why: "第167行把 src/constraint-runtime/dist COPY 进 node_modules/@bolloon/constraint-runtime/dist" }, { file: 'src/constraint-runtime/package.json', why: "main/exports 指向 dist/index.js; files=['dist/**/*']" }], reason: "**dist 才是运行期目标** (源码树不是) ⇒ 删 dist 直接断掉 B 类工具与包入口。必须先做完 K7 (B 类改 Tool Capability) 才有资格谈" },
  { group: 'CR 源: reference_data/ (子系统快照数据)', target: 'src/constraint-runtime/src/reference_data/', verdict: 'blocked', blockers: [{ file: 'src/constraint-runtime/src/tools.ts', why: "同目录 tools_snapshot.json 是运行期派发台账 (PORTED_TOOLS + executeToolFromSnapshot 按 source_hint import) ⇒ 整个目录不能整删; subsystems/*.json 现在是**孤立数据** (读取者 _archive_helper 已删), 处置要单独决定" }], reason: "26 个存档壳删掉后 subsystems/*.json 只剩数据; 同目录混着运行期台账 ⇒ 需按文件分别判, 不是目录级删除" },  { group: 'CR 源: parity_audit.ts / remote_runtime.ts / native_ts/ / upstream_proxy/', target: 'src/constraint-runtime/src/parity_audit.ts', verdict: 'blocked', blockers: [{ file: 'src/constraint-runtime/src/index.ts', why: "第21-22行 re-export (runParityAudit / runRemoteMode / runSshMode / runTeleportMode)" }, { file: 'src/constraint-runtime/dist/index.js', why: "编译副本同样 re-export ⇒ 删源码还要重建 dist" }], reason: "可达包入口 ⇒ 删除要**同时改 index.ts + 重建 dist**, 属 K1-④ 的活, 不是纯删" },
  { group: 'src/bollharness/ (另一个项目的镜像)', target: 'src/bollharness/', verdict: 'blocked', blockers: [{ file: 'scripts/smoke-esm.mjs', why: "第38行引用 dist/bollharness/src/scripts/context_router.js" }, { file: 'scripts/gen-copyright-source.ts', why: "第25行明写: src/bollharness 是**第三方 vendored 框架** (版权属 bollharness contributors), 不进版权登记" }], reason: "**第三方 vendored 框架** (不是 Bolloon 代码) + 版权归属未处置 + smoke 脚本引用 ⇒ 处置要先定它的归属, 属第一批「审查」而非机械化删除" },
  { group: 'K1 第②步批二: 26 个移植存档壳', target: 'src/constraint-runtime/src/<26 个移植存档壳>/index.ts', verdict: 'done', blockers: [], reason: "包入口闭包外 + 主仓 0 引用 + 快照 0 点名; 自述为 Python placeholder package; 已删 (记录见 DELETION_LEDGER)" },
  { group: 'K1 第②步批二: _archive_helper', target: 'src/constraint-runtime/src/_archive_helper.ts', verdict: 'done', blockers: [], reason: "只被 26 个存档壳调用; 随它们一起删" },
  { group: 'K1 第②步批二: 6 个根级移植残留', target: 'src/constraint-runtime/src/<6 个根级移植残留>.ts', verdict: 'done', blockers: [], reason: "cost_hook/execution_registry/ink/port_manifest/query/system_init; 0 引用 0 点名; 已删" },
  // ★ 下面这条是被编译期抓回来的一类: **环境声明 .d.ts 不是"被 import"的对象, 但它是编译期依赖**
  { group: 'K1 第②步批二: platform.d.ts (撤回!)', target: 'src/constraint-runtime/src/platform.d.ts', verdict: 'not-deletable', blockers: [{ file: 'src/constraint-runtime/src/setup.ts', why: "靠 `declare module 'platform'` 编译; 删掉即 TS7016" }], reason: "**判错过一次**: 静态可达性看不见环境声明 ⇒ 删后 CR tsc 红 (TS7016), 已恢复。判据对 .d.ts 一律不判 ready" },
];

/** 五个删除条件的机器可核验部分 (人/真跑承担的部分写在删除记录的 acceptance 字段) */
export const DELETION_CONDITIONS: readonly string[] = [
  '① 有唯一替代路径',
  '② 全仓无有效 import / 动态引用 / CLI·Web 路由引用',
  '③ 真跑已覆盖旧路径对应能力',
  '④ 一次完整回归 + 一次故障恢复',
  '⑤ 留可回滚提交点 (不丢历史)',
];
