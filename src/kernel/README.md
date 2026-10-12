# @bolloon/bolloon-kernel

**Bolloon Native Macro-Kernel** — 进程内 Agent 内核机制层 SDK。

统一调度 · 共享状态受控 · 端口注入 · **零业务依赖**（除 `node:` 内置外无任何运行时依赖）。

## 是什么

一个进程内的高性能 Agent 操作系统核心的**机制层**：

- **ChannelActor** — 同 channel 串行、异 channel 并发、ALS 重入
- **ModelRuntime** — 只读模型租约（连接复用 / 超时 / 取消 / 退避 / 熔断）
- **Run / Session 生命周期** — 生命周期写口 + 会话规则（端口注入，未注入即拒）
- **Transport / Control** — 通信端口与命令式控制面
- **恢复 / 自检编排** — resume 编排（单次语义）+ 回合末 tsc 自检（fail-closed）

**设计原则**（源自 Bolloon 宏内核架构，见 `docs/wiki/bolloon-native-macro-kernel.md`）：

1. **Kernel 只做机制，不判业务** — 不判"该不该继续"、不判"算不算完成"，只把事实与许可交给调用方。
2. **所有 I/O 走端口注入** — 每个模块的持久化 / 模型调用 / 通信由调用方注入，内核不 import 任何业务模块。
3. **五条越权禁令** — Channel 不能直接改 Goal · Model 不能直接执行 Tool · Tool 不能直接改权限 · Provider 不能直接写 Run · 子 Agent 不能直接结束 Goal。

## 安装

```bash
npm install @bolloon/bolloon-kernel
```

## 快速上手

```ts
import {
  ChannelActor,
  ModelRuntime,
  submitRunLifecycle,
  submitTransport,
  submitRunControl,
} from '@bolloon/bolloon-kernel';

// Channel Actor: 同 channel 串行队列 (submit 串行执行, ALS 重入)
const actor = new ChannelActor({ channelId: 'channel-1', kind: 'chat' });
await actor.submit(async (state) => {
  // 你的执行逻辑 (串行, 同 channel 内不并发)
});

// ModelRuntime: 只读模型租约（I/O 端口注入）
const runtime = new ModelRuntime({
  openConnection: async (snapshot) => connection,
  // ...
});
const lease = await runtime.acquire({ provider: 'openai', model: 'gpt-4o' });

// Run 生命周期写口: 未注入端口即拒（fail-closed）
const out = await submitRunLifecycle(
  { kind: 'record-step', runId: 'r1', tool: 'write_file', ok: true },
  { recordStep: async (runId, step) => ({ ok: true }) },
);

// 通信端口 (op: 'send' | 'broadcast' | 'peers'; origin 必填用于审计)
await submitTransport(
  { op: 'send', origin: 'my-project', peerId: 'did:key:xxx', kind: 'message', payload: 'hello' },
  { send: async (peerId, kind, payload) => ({ ok: true }) },
);
```

## 模块

| 模块 | 说明 | 关键导出 |
| --- | --- | --- |
| `channel-actor` | Channel Actor + SerialMailbox（K5） | `ChannelActor` · `SerialMailbox` · `getOrCreateActor` · `deliverThroughActor` |
| `model-runtime` | 只读模型租约（K6） | `ModelRuntime` · `ModelLease` · `snapshotFromSelection` · `backoffDelayMs` |
| `control` | 命令式控制面 | `submitRunControl` · `RunControlPorts` · `runControlAudit` |
| `run-lifecycle` | Run 生命周期写口 | `submitRunLifecycle` · `decideResumeReinstall` · `pickRunIdForResume` |
| `session-lifecycle` | 会话规则 | `toPersistedMessages` · `filterSessionMessages` · `composeRunSeed` · `submitSessionOp` |
| `run-resume` | 恢复编排 | `resumeRunViaKernel` · `ResumePorts` |
| `turn-selfcheck` | 回合末自检 | `runTurnEndSelfCheck` · `TURN_SELFCHECK_TOOL` |
| `code-write-gate` | 写代码工具判定 | `CODE_WRITE_TOOLS` · `decideTypecheck` · `formatTypecheckResult` |
| `transport` | 通信端口 | `submitTransport` · `transportPeersSync` |

## 设计边界（诚实口径）

- **不包含** Bolloon 仓库治理件（`gate-scan` / `roster` / `plan-*`）—— 那些是 Bolloon 的目录边界门与阶段台账，面向源码文本，属于仓库治理而非 SDK 面。
- **不包含** `constraint-runtime`（领域工具库）—— Wallet / Polymarket / Safe 等领域能力按架构决议留在外部，经 capability adapter 接入。
- **不包含** 具体推理适配器（Pi / Native Adapter）—— 它们属于消费者侧，经 Adapter 接口接入内核。

## 跨项目使用

本包零业务依赖 + 端口注入，可被任何需要进程内 Agent 内核的项目直接使用（如 hushfusion-forge 这类非 Bolloon 项目）：

- 需要调度 / 队列 / 模型租约 / Run 生命周期时直接 import 对应模块；
- 持久化与外部 I/O 一律由你的项目注入端口实现；
- 五条越权禁令与"只机制不判断"的原则在项目间通用。

## License

MIT
