//! Bolloon P2P — 去中心化协作
//!
//! 接口先行（磁盘/编译友好）：DID 身份 + 群聊 store + 传输抽象。
//! DIAP 后端通过 feature 注入（见 Cargo.toml 注释）。

pub mod identity;
pub mod group_store;
pub use identity::*;
pub use group_store::*;