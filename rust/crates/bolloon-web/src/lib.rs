//! Bolloon Web — Web UI (hushforge 布局像素级复刻) + HTTP API
//!
//! 布局学 HUSHFUSION Forge 的 internal/webapp/assets/index.html:
//! - 单 HTML（内嵌 CSS/JS），深色主题 CSS 变量 + prefers-color-scheme 浅色
//! - 三栏 grid: 284px 侧栏（品牌/新智能体/列表/账号）| 主聊天区 | 360px room 面板（内部商议）
//! - API: /api/bootstrap /api/models /api/agents /api/groups /api/send
//!
//! 版本 0.6.13（与 TS 版保持一致）。

pub mod avatar;
pub mod native;
pub mod room_bus;
pub mod server;
pub use server::*;
