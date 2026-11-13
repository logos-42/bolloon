//! Bolloon Web — Web UI (hushforge 布局像素级复刻) + HTTP API
//!
//! 布局学 HUSHFUSION Forge 的 internal/webapp/assets/index.html:
//! - 单 HTML（内嵌 CSS/JS），深色主题 CSS 变量 + prefers-color-scheme 浅色
//! - 三栏 grid: 284px 侧栏（品牌/新智能体/列表/账号）| 主聊天区 | 360px room 面板（内部商议）
//! - API: /api/bootstrap /api/models /api/agents /api/groups /api/send
//!
//! 版本 0.6.13（与 TS 版保持一致）。

pub mod archive;
pub mod asr;
pub mod avatar;
pub mod native;
/// 邮件能力 HTTP 面 (`/api/mail/*`); CLI 直连 crate, 不走这里
pub mod mail_api;
/// AI 外呼 HTTP 面 (`/api/call/*`); 目前只有 Mock 服务商
pub mod call_api;
pub mod pay;
pub mod agent_wallet;
pub mod qr_login;
pub mod reco;
pub mod room_bus;
pub mod local_model;
pub mod specialize;
pub mod router;
pub mod server;
pub mod kernel_bus;
/// DIAP 跨 NAT HTTP 隧道 (可选 feature)
#[cfg(feature = "diap-backend")]
pub mod diap_hub;
pub mod feature_pack;
pub mod discovery;
/// 跨机会话状态机: 多轮上下文 / 消息落盘 / 自动接力
pub mod cross_chat;
/// 边缘目录客户端 (bolloon.cn / Cloudflare Workers 兼容契约)
pub mod rendezvous;
/// QUIC/DIAP 交流历史 (去中心化通道留痕)
pub mod transport_history;
/// 多设备自动同步 (会话记录增量合并)
pub mod device_sync;
/// 路径 B: libp2p Kademlia DHT 发现 (可选 feature)
#[cfg(feature = "dht-backend")]
pub mod dht;
pub mod contribution;
pub mod world_interact;
pub mod x402_buy;
pub mod updater;
pub mod vision;
pub mod wallet;
pub use server::*;
