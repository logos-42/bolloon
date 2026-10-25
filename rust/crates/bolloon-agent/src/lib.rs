//! Bolloon Agent — KernelLoop + 多智能体群聊
//!
//! KernelLoop: prepare → model call → harness tool call → checkpoint → reducer → continuation → finish
//! 会话值：多人群聊中 agent 的参与逻辑（何时开口/冷却/幂等）

pub mod kernel_loop;
pub mod group_chat;
pub mod task_board;
pub mod memory;
pub mod session_store;
pub use kernel_loop::*;
pub use group_chat::*;
pub use task_board::*;
pub use memory::*;
pub use session_store::*;