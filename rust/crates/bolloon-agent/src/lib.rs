//! Bolloon Agent — KernelLoop + 多智能体群聊
//!
//! KernelLoop: prepare → model call → harness tool call → checkpoint → reducer → continuation → finish
//! 会话值：多人群聊中 agent 的参与逻辑（何时开口/冷却/幂等）

pub mod kernel_loop;
pub mod group_chat;
pub mod task_board;
pub mod memory;
pub mod session_store;
pub mod efficode;
pub mod hooks;
pub mod judgment;
pub mod world;
pub mod goal;
pub mod contacts;
pub mod heartbeat;
pub use kernel_loop::*;
pub use group_chat::*;
pub use task_board::*;
pub use memory::*;
pub use session_store::*;
pub use efficode::*;
pub use hooks::*;
pub use judgment::*;
pub use world::*;
pub use goal::*;
pub use contacts::*;
pub use heartbeat::*;