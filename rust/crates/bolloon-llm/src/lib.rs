//! Bolloon LLM Runtime — 模型调用唯一咽喉
//!
//! 对应 TS 版 src/llm/pi-ai.ts 的职责：
//! - OpenAI-compatible /chat/completions
//! - 并发闸（withLlmConcurrency：同 provider 最多 N 个在途，其余排队）
//! - 超时 / 退避（429/5xx）/ 取消
//! - 工具调用解析（tool_calls → ToolCall）
//!
//! 密钥纪律：api_key 只在构造时持有，不落日志、不序列化输出。

pub mod runtime;
pub mod compaction;
pub use runtime::*;
