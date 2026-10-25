//! Bolloon X402 — x402 微支付协议 (Rust 原生)
//!
//! - `order_identity`: 订单标识 BOL1 (EIP-3009 nonce 自证"买的是哪件", 真链实测值对表)
//! - `paid_info`: 付费信息协议 `bolloon-x402-info/1` (四层结构 + 验真四档)
//! - `direct_payment`: 去中心化直付 8 判据 (判定纯函数, ≥2 RPC 一致才算事实, 矛盾不交付)
//!
//! 判定路径不动钱; 私钥只从调用方注入, 不进任何输出。

pub mod order_identity;
pub mod paid_info;
pub mod direct_payment;
pub mod settlement_state;
pub mod payment_recovery;
pub mod seller_signing;
pub use order_identity::*;
pub use paid_info::*;
pub use direct_payment::*;
pub use settlement_state::*;
pub use payment_recovery::*;
pub use seller_signing::*;
