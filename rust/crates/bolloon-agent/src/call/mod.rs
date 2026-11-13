//! 电话能力（AI 外呼）—— 端口 / 状态机 / 合规门。
//!
//! 分层（AGENTS.md §8）:
//! - `types` / `state`: 纯数据 + 纯函数状态机（无 IO，可单测）
//! - `guard`: 合规硬拒（AI 声明、单目标、拒接后不重拨、勿扰）
//! - `CallPort`: 与真实服务商（Twilio Media Streams / 阿里云 / SIP）说话的端口
//! - `service`: 装配 + 事件落盘
//!
//! **诚实边界**（写死在代码里，不许当成已完成）:
//! - 真音频链路（麦克风/电话音频 → ASR → LLM → TTS）**未接**；`CallPort` 只有 Mock 实现。
//! - Twilio Media Streams / SIP 未真连；实时延迟、回声消除、打断（barge-in）未验证。
//! - 手机 OS 不给第三方 App 通话音频；外呼只能经服务商/SIP 中继。

pub mod audio;
pub mod native;
pub mod service;
pub mod state;
/// Twilio Media Streams 协议编解码（只做形状，无 WebSocket 客户端）
pub mod twilio;
pub mod voice;

use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CallId(pub String);

impl std::fmt::Display for CallId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 外呼目标。`reason` 必填：没有目的的电话一律拒（防批量轮呼）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallTarget {
    /// E.164，例如 +8613800138000
    pub e164: String,
    /// 关联联系人 id（可选；不存明文姓名到 prompt）
    pub contact_id: Option<String>,
    /// 这次为什么打 —— 人工可读的一句话
    pub reason: String,
}

/// 通话状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallState {
    Idle,
    Dialing,
    Ringing,
    InProgress { turns: u32 },
    Completed { reason: String },
    Failed { error: String },
}

impl CallState {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Completed { .. } | Self::Failed { .. })
    }
}

/// 来自服务商 / 对方的事件
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallEvent {
    DialRequested,
    Ringing,
    Answered,
    /// 对方说的一句话（ASR 后）
    PeerUtterance(String),
    /// 对方按键
    PeerDtmf(String),
    Hangup { by: String },
    Error(String),
}

/// 状态机产出的副作用（由 service 执行，状态机本身不做 IO）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallEffect {
    /// 播报一段话（TTS）
    Speak(String),
    /// 进入聆听
    Listen,
    /// 挂断
    Hangup,
    /// 记录（审计 / 证据）
    Log(String),
}

/// 一次通话的审计记录（只追加落盘）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallRecord {
    pub id: CallId,
    pub target_e164: String,
    pub contact_id: Option<String>,
    pub reason: String,
    pub state: CallState,
    /// 每次状态迁移的时间线（脱敏：只存事件类型与轮次，不存对方原话）
    pub timeline: Vec<String>,
    pub started_ms: i64,
    pub ended_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CallPortError {
    pub kind: String,
    pub message: String,
}

impl CallPortError {
    pub fn new(kind: &str, msg: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: msg.into() }
    }
}

impl std::fmt::Display for CallPortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

pub type CallResult<T> = Result<T, CallPortError>;

/// 与真实服务商说话的端口。
///
/// 实现方负责把服务商协议翻译成 `CallEvent` / `CallEffect`；
/// **合规判断不在这里**（在 `state::check_dial` 与 `service`）。
#[async_trait]
pub trait CallPort: Send + Sync {
    fn provider(&self) -> &str;

    async fn dial(&self, target: &CallTarget, disclosure: &str) -> CallResult<CallId>;

    /// 阻塞直到下一个事件或超时（超时返回 `timeout`，不伪造事件）
    async fn next_event(&self, id: &CallId, timeout: Duration) -> CallResult<CallEvent>;

    async fn speak(&self, id: &CallId, text: &str) -> CallResult<()>;

    async fn hangup(&self, id: &CallId) -> CallResult<()>;
}
