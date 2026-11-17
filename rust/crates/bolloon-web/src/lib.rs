//! Bolloon Web — Web UI (hushforge 布局像素级复刻) + HTTP API
//!
//! 布局学 HUSHFUSION Forge 的 internal/webapp/assets/index.html:
//! - 单 HTML（内嵌 CSS/JS），深色主题 CSS 变量 + prefers-color-scheme 浅色
//! - 三栏 grid: 284px 侧栏（品牌/新智能体/列表/账号）| 主聊天区 | 360px room 面板（内部商议）
//! - API: /api/bootstrap /api/models /api/agents /api/groups /api/send
//!
//! 版本 0.6.13（与 TS 版保持一致）。

pub mod agent_wallet;
pub mod archive;
pub mod asr;
pub mod avatar;
/// AI 外呼 HTTP 面 (`/api/call/*`); 目前只有 Mock 服务商
pub mod call_api;
/// 真实 EVM 交易签名 + 广播（个人代币部署上链）
pub mod chain_tx;
pub mod contribution;
/// 跨机会话状态机: 多轮上下文 / 消息落盘 / 自动接力
pub mod cross_chat;
/// 多设备自动同步 (会话记录增量合并)
pub mod device_sync;
/// 路径 B: libp2p Kademlia DHT 发现 (可选 feature)
#[cfg(feature = "dht-backend")]
pub mod dht;
/// DIAP 跨 NAT HTTP 隧道 (可选 feature)
#[cfg(feature = "diap-backend")]
pub mod diap_hub;
pub mod discovery;
pub mod feature_pack;
pub mod kernel_bus;
pub mod local_model;
/// 邮件能力 HTTP 面 (`/api/mail/*`); CLI 直连 crate, 不走这里
pub mod mail_api;
pub mod identity_pair;
pub mod native;
pub mod pay;
/// 个人代币发行（绑定 DID，未通过真人验证不许发币）
pub mod personal_token;
/// 插件栏（技能注册表的浏览 / 分享 / 导入）
pub mod plugins;
pub mod qr_login;
pub mod reco;
/// 边缘目录客户端 (bolloon.cn / Cloudflare Workers 兼容契约)
pub mod rendezvous;
pub mod room_bus;
pub mod router;
pub mod server;
pub mod sync_snapshot;
pub mod specialize;
/// QUIC/DIAP 交流历史 (去中心化通道留痕)
pub mod transport_history;
pub mod updater;
/// DID 真人验证门（个人发币前置）
pub mod verify;
pub mod vision;
pub mod wallet;
/// 钱包私钥本地加密（口令 PBKDF2 → AES-256-GCM；备份串可跨设备）
pub mod wallet_crypto;
pub mod world_interact;
pub mod x402_buy;
pub use server::*;
