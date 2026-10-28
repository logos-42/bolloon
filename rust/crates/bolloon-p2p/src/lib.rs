//! Bolloon P2P — 去中心化协作
//!
//! 接口先行（磁盘/编译友好）：DID 身份 + 群聊 store + 传输抽象。
//! DIAP 后端通过 feature 注入（见 Cargo.toml 注释）。

pub mod identity;
pub mod envelope;
pub mod gossip;
#[cfg(feature = "quic-transport")]
pub mod quic_transport;
pub mod oplog;
pub mod replication;
pub mod orbit_store;
pub mod group_orbit;
pub mod attestation;
pub use identity::*;
pub use envelope::*;
pub use gossip::*;
pub use orbit_store::*;
pub use group_orbit::*;
pub use attestation::*;

/// b58 编码 (外部 crate 复用, 不重复引依赖)
pub fn b58_encode(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

/// b58 解码 (外部 crate 复用)
pub fn b58_decode(s: &str) -> Option<Vec<u8>> {
    bs58::decode(s).into_vec().ok()
}