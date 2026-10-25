//! Bolloon Harness — 系统调用唯一门
//!
//! discover → permission → budget → idempotency → execute → verify → evidence → event
//! 任何绕过 Harness 的代码都视为架构缺陷（对应 TS 版 K7）。

mod harness;
pub mod security;
pub use harness::*;
pub use security::{guard_shell, guard_tool_arg, GuardError};
