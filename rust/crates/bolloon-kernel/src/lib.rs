//! Bolloon Native Macro-Kernel — 进程内 Agent 内核机制层
//!
//! 统一调度 · 共享状态受控 · 端口注入 · 零业务依赖。
//! 只导出「机制」——不导出任何业务判定（Kernel 判据: 不判"该不该继续"、不判"算不算完成"）。
//!
//! 模块速览 (对应 TS 版 src/kernel):
//! - channel-actor   K5  ChannelActor + SerialMailbox（同 channel 串行、异 channel 并发、ALS 重入）
//! - model-runtime   K6  ModelRuntime.acquire(snapshot) 只读租约（连接复用/超时/取消/退避/熔断）
//! - control         命令式控制面（pause / resume / abort / recover）
//! - run-lifecycle   Run 生命周期写口（start-run / record-step / finish-run / save-checkpoint）
//! - session-lifecycle 会话规则（持久化映射 / 过滤水合 / 运行种子合并）
//! - transport       通信端口（send / broadcast / peers，未注入即拒）
//! - ha              Kernel 双活 — 心跳仲裁 (纯机制) + 守护循环 (端口注入)
//! - dual_core       双核 Kernel — 对等互维互保 + 间隔相位心跳 (staggered phase)

pub mod channel_actor;
pub mod model_runtime;
pub mod control;
pub mod run_lifecycle;
pub mod session_lifecycle;
pub mod transport;
pub mod cron;
pub mod ha;
pub mod dual_core;
pub mod orphan_recovery;

pub use channel_actor::{
    ChannelActor, ChannelEvent, ChannelHandle, ChannelId, SerialMailbox,
};
pub use model_runtime::{
    ModelRuntime, ModelLease, ModelSnapshot, ProviderId, RuntimeError,
};
pub use control::{Control, ControlCommand, ControlHandle, ControlState};
pub use run_lifecycle::{
    RunLifecycle, RunEvent, RunId, RunStatus, RunStore, StepRecord, NoopRunStore,
};
pub use session_lifecycle::{
    SessionLifecycle, SessionState, SessionEvent, SessionId, SessionMessage,
    SessionStore, MemorySessionStore, is_internal_chatter,
};
pub use transport::{Transport, TransportPort, PeerInfo, TransportMessage, TransportError};
pub use ha::{HeartbeatArbiter, HeartbeatGuard, HeartbeatState, GuardStatus, RecoveryAction};
pub use dual_core::{
    BeatSchedule, Beat, CoreId, FencingToken, PeerHealth, TakeoverDecision, HeartbeatStore,
    DualArbiter, DualGuard,
};
