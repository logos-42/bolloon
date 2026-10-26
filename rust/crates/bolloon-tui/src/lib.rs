//! tui — Bolloon 终端 UI (**复用原 TS 的 CLI TUI**, 不另写一套)
//!
//! 来源一一对应 (`src/cli/` 下那套纯 ANSI 视觉层, 逐字搬 + 逐条钉测试):
//!
//! | 本模块 | TS 原文 | 搬的是什么 |
//! | --- | --- | --- |
//! | `theme` | `src/cli/theme.ts` | THEME token 表 (唯一颜色事实源) + `fg`/`bg`/`tint`/`colorEnabled` |
//! | `width` | `loading-tui.ts` / `status-segments.ts` | `dispWidth` / `truncate` / `dispWidthSafe` / `truncateSafe` / 终端尺寸 |
//! | `boxart` | `loading-tui.ts` | 方角 `SQ` / 圆角 `RD` + `boxTop`/`boxRow`/`boxBottom` |
//! | `brand` | `loading-tui.ts` | 机器人头 + BOLLOON 艺术字 (大/小/文字三档) |
//! | `markdown` | `src/cli/markdown.ts` | `mdInline` 内联高亮 |
//! | `trace` | `src/cli/trace-line.ts` | 工具动作短语 + 参数摘要 |
//! | `panel` | `loading-tui.ts` | 仪表盘 / 对话框 / 消息框 / 工具行 / diff 着色 |
//! | `loading` | `loading-tui.ts` | `LoadingTUI` 原地刷新仪表盘 + `LOADING_FRAMES` |
//! | `select` | `src/cli/tui-select.ts` | 全屏可滚动光标选择器 (固定高度视窗 + 六种一等选择方式) |
//! | `scroll` | `src/cli/keymap.ts` | 滚动键位表 + 位移纯函数 (跟随/暂停) |
//! | `screen` | `src/cli/ink-app.tsx` 的**几何纪律** | 面板壳: 帧高恒定 / 输入行号恒定 / 四个固定行 / 跟随可暂停 |
//! | `history` | `src/cli/input-history.ts` | 输入历史落盘 (0600 · 一渠道一文件 · **秘密不写盘**) |
//! | `input` | `tui-select.ts` 的 `tuiAskLine`/`tuiAskMasked` | raw 模式行输入 (↑↓ 历史) + 掩码输入 (明文不上屏) |
//! | `compose` | (新增, 无 TS 对应) | 输入缓冲状态机: 多行/Ctrl+G 草稿/Alt+V 贴图的**纯函数**语义 |
//! | `help` | (新增, 无 TS 对应) | `bolloon chat` 键位文案**唯一事实源** (与 `compose` 的键位表逐条互钉) |
//! | `clipboard` | (新增, 无 TS 对应) | Alt+V 贴图: 剪贴板图片 → `~/.bolloon/rust/paste/*.png` |
//!
//! ## 为什么是"复用"不是"重写"
//!
//! TS 那套 TUI 是**纯 ANSI 字符串 + 纯函数**, 无外部依赖 —— 它的形状/配色/几何是**事实**:
//! 面板行号不抖、窄屏不折行、空回复不出空框, 这些都是踩过坑才定下来的 (见
//! `docs/wiki/cli-startup-panel.md` / `cli-reply-stream-hygiene.md`)。Rust 侧照搬同一套判据,
//! 用测试钉住逐字节一致, 而不是凭印象再设计一次。
//!
//! ## 诚实的偏离 (只有两处, 都写明了原因)
//!
//! 1. `loading`: TS 的 `LoadingTUI.draw` **没有** `renderDashboard` 那道"装不下就不画艺术字"的闸
//!    (80 列终端下 77 列艺术字塞进 74 列内宽 ⇒ 行被折成两截)。这里按 2026-09-30 定下的规矩补上:
//!    **降档** (大 61 → 小 37 → 文字), 装不下就不画。
//! 2. `select`: TS 版还带鼠标滚轮上报 (`?1006h`) 与 `SIGWINCH` 重绘; Rust 版只做**键盘**六种方式,
//!    鼠标与 resize 重绘**未移植** (功能不缺: ↑↓ / 数字 / 筛选 / 折叠都在)。
//!
//! ## 未移植 (如实列出, 不冒充已做)
//!
//! · `setup-wizard.ts` 七步向导 (称呼→供应商→key→模型→连通测试) —— 属于业务流;
//!   `bolloon setup` 需要先有 Rust 侧的 config store, 记在 `docs/wiki/rust-rewrite.md` 欠账里。
//! · OSC52 剪贴板 (`/copy`, 把**文本**送出去) —— 依赖终端能力且要起子进程, 暂无对应需求。
//!   (反方向的 Alt+V **贴图**已做, 见 `clipboard`)
//! · 多模态发送: `ChatMessage.content` 是单模态 `String`, Alt+V 只把 `@路径` 插进输入,
//!   像素要真进模型得先改 LLM 层 (欠账)。

pub mod boxart;
pub mod brand;
pub mod clipboard;
pub mod compose;
pub mod help;
pub mod history;
pub mod input;
pub mod loading;
pub mod markdown;
pub mod panel;
pub mod screen;
pub mod scroll;
pub mod select;
pub mod theme;
pub mod trace;
pub mod width;

pub use brand::print_banner;
pub use history::{append_input_history, load_input_history};
pub use input::{ask_line, ask_line_with, ask_masked};
pub use loading::{LoadingTui, LOADING_FRAMES};
pub use panel::{render_agent_message, render_dashboard, render_dialog, render_user_message};
pub use screen::Screen;
pub use select::{tui_select, TuiChoice};
pub use theme::color_enabled;
