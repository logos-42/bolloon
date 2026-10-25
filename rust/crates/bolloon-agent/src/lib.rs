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
pub mod setup;
pub mod subagents;
pub mod judgeness;
pub mod documents;
pub mod task_group;
pub mod wallet;
pub mod workflow;
pub mod mcp;
pub mod migration;
pub mod lsp;
pub mod git;
pub mod terminal;
pub mod home;
pub mod runtime;
pub mod memory_db;
pub mod process;
pub mod workspace;
pub mod dispatch_check;
pub mod clarity;
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