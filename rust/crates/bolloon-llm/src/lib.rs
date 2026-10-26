//! Bolloon LLM Runtime — 模型调用唯一咽喉
//!
//! 对应 TS 版 src/llm/pi-ai.ts 的职责：
//! - **4 条协议分支**: openai-compatible /chat/completions · anthropic /messages ·
//!   gemini :generateContent · ollama /api/chat
//! - 并发闸（withLlmConcurrency：同 provider 最多 N 个在途，其余排队）
//! - 超时 / 退避（429/5xx）/ 取消
//! - 工具调用解析（tool_calls → ToolCall）
//!
//! provider 能力（与 TS 同一份事实源）:
//! - `provider_catalog`: 目录 223 家（`src/llm/data/provider-catalog.json`，include_str 不复制）
//! - `provider_registry`: 内置 13 + 自定义 + 目录 → 同一形状；族/鉴权形状推断
//! - `config_store`: `~/.bolloon/bolloon-config.json`（0600 原子写）+ 环境变量兜底
//!
//! 密钥纪律：api_key 只在构造时持有，不落日志、不序列化输出。

pub mod compaction;
pub mod config_store;
pub mod provider_catalog;
pub mod provider_registry;
pub mod runtime;

pub use config_store::{
    active_resolved, resolve, LlmConfig, ProviderSettings, Resolved,
};
pub use provider_registry::{
    list_builtin, list_catalog, list_with_catalog, Origin, Protocol, ProviderModel,
    ProviderRegistryEntry,
};
pub use runtime::*;
