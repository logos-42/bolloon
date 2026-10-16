/**
 * @bolloon/bolloon-kernel — Bolloon Native Macro-Kernel SDK 出口
 *
 * 进程内 Agent 内核机制层（统一调度 · 共享状态受控 · 端口注入 · 零业务依赖）。
 *
 * 设计页: docs/wiki/bolloon-native-macro-kernel.md
 * 出口纪律:
 *   · 只导出「机制」—— 不导出任何业务判定（Kernel 判据: 不判"该不该继续"、不判"算不算完成"）。
 *   · 只导出「运行时机制」—— gate-scan / roster / plan-* 是 Bolloon 仓库治理件（判据与台账），
 *     面向本仓的门（kernel-boundary / kernel-authority / kernel-gate-scan 等测试）直接吃源码，
 *     不进 SDK 出口。
 *   · 依赖面: 除 node: 内置外零依赖 —— 每个模块的 I/O 走端口注入，调用方给什么就用什么。
 *
 * 模块速览:
 *   channel-actor   K5  ChannelActor + SerialMailbox（同 channel 串行、异 channel 并发、ALS 重入）
 *   model-runtime   K6  ModelRuntime.acquire(snapshot) 只读租约（连接复用/超时/取消/退避/熔断）
 *   control         命令式控制面（pause / resume / abort / recover）
 *   run-lifecycle   Run 生命周期写口（start-run / record-step / finish-run / save-checkpoint）
 *   session-lifecycle 会话规则（持久化映射 / 过滤水合 / 运行种子合并）
 *   run-resume      恢复编排（漂移上报 / 核对失败不阻塞 / 单次语义）
 *   turn-selfcheck  回合末自检编排（fail-closed: 被拒/门抛错 ⇒ 零执行且可见）
 *   code-write-gate 写代码工具判定（哪个写操作产出 TS · 收尾要不要跑 tsc）
 *   transport       通信端口（send / broadcast / peers，未注入即拒）
 */
export * from './channel-actor.js';
export * from './model-runtime.js';
export * from './control.js';
export * from './run-lifecycle.js';
export * from './session-lifecycle.js';
export * from './run-resume.js';
export * from './turn-selfcheck.js';
export * from './code-write-gate.js';
export * from './transport.js';
// 2026-10-16 (leo: 双内核冗余): Kernel 双活 — 心跳仲裁 (纯机制) + 守护循环 (端口注入)
export * from './ha/ha-arbiter.js';
export * from './ha/ha-guard.js';