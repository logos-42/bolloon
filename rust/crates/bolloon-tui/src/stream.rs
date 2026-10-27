//! stream.rs — 流式回复面板 (生成过程中"开底"生长, 完成后由完整消息框接管)
//!
//! 与既有产品结构的关系 (**不改变**): 每条回复仍然渲染成完整圆角框进 scrollback
//! (`panel::render_agent_message`)。本模块只负责**生成过程中**的临时视图:
//!
//! ```text
//! ╭─ ◉ Bolloon Agent ────────────────╮
//! │ 这里是实时生长的内容…             │
//! │ ◉ Generating · 流式输出中         │   ← 状态行
//! ```
//!
//! 纪律 (2026-10-27 收紧):
//!   · **没有底边框** —— 消息没完就不画 `╰`;
//!   · **固定行数**: 调用方先 `Chrome::reserve_stream(H)` 把 H 行**滚出来**占住,
//!     之后每帧只在这 H 行里就地重画 —— 面板不再"向上借历史行", 结束后也就不会
//!     留下一块被擦白的洞 (真机: 发送框与回复框之间出现大量空白就是这个);
//!   · 超出 H 行时**留尾** (看得见最新内容), 折掉多少写在首行;
//!   · 重画用**绝对行号** + `\x1b[2K` (与 `Chrome::draw` 同口径, 无相对位移);
//!   · 只有**一个**写入者: 调用方的事件循环。
//!
//! 纯渲染函数 `render_stream_frame` 可单测; IO 只剩 `print!` 一层。

use crate::width::{disp_width, term_width, truncate_safe};

/// 面板宽度: 不写满整宽 (满宽 ⇒ 终端折行 ⇒ 边框重复打印, TS 坑 2)
fn panel_width(cols: usize) -> usize {
    cols.saturating_sub(2).max(20)
}

/**
 * 渲染一帧流式面板 (**纯函数**)。
 *
 * `text` 是已收到的增量累积文本; `status` 是面板内状态行 (如 `◉ Thinking`);
 * `max_rows` 是允许占用的最大行数 (含顶边框与状态行), 超出时正文**留尾**,
 * 被折掉的行数写在首行 `… (+N 行)`。
 */
pub fn render_stream_frame(text: &str, title: &str, status: &str, cols: usize, max_rows: usize) -> Vec<String> {
    let width = panel_width(if cols > 0 { cols } else { term_width() });
    let inner = width.saturating_sub(4);

    let body = if text.trim().is_empty() {
        vec![String::new()]
    } else {
        crate::panel::wrap_text(text, inner)
    };

    let max_rows = max_rows.max(3); // 至少: 顶边框 + 1 行正文 + 状态行
    let body_budget = max_rows.saturating_sub(2);
    let skip = body.len().saturating_sub(body_budget);
    // 有折叠标记行时, 标记行也占预算 (否则总行数会超 max_rows 一行)
    let body_budget = if skip > 0 {
        max_rows.saturating_sub(3)
    } else {
        body_budget
    };
    let skip = body.len().saturating_sub(body_budget);

    let mut out: Vec<String> = Vec::new();
    // 顶边框 (标题嵌入; 超宽截断, 边框必须闭合)
    let label = format!(" ◉ {title} ");
    let label = truncate_safe(&label, width.saturating_sub(2));
    let dash = width.saturating_sub(2 + disp_width(&label));
    out.push(format!("╭{label}{}╮", "─".repeat(dash)));
    if skip > 0 {
        let mark = format!("… (+{skip} 行)");
        out.push(format!(
            "│ {}{} │",
            crate::theme::C_DIM,
            truncate_safe(&mark, inner)
        ));
    }
    for l in body.iter().skip(skip) {
        out.push(format!(
            "│ {}{}{} │",
            crate::theme::C_WHITE,
            truncate_safe(l, inner),
            " ".repeat(inner.saturating_sub(disp_width(l)))
        ));
    }
    // 状态行 (无底边框 —— 开底)
    out.push(format!(
        "│ {}{}{} │",
        crate::theme::C_WARN,
        truncate_safe(status, inner),
        " ".repeat(inner.saturating_sub(disp_width(status)))
    ));
    out
}


/// 流式预览的固定高度 (行): 顶边框 + 2 行正文 + 状态行。
///
/// 为什么是常数: 变高就要"借行", 借来的行收尾时只能擦白 ⇒ 框与框之间出现大洞。
/// 固定 4 行 ⇒ 收尾时这块区域可以整块交给历史区复用, 一个空行都不留。
pub const STREAM_ROWS: usize = 4;

/// 一帧流式预览 (**纯函数**): 固定 `rows` 行, 最后一行是状态行。
pub fn render_preview_frame(
    text: &str,
    title: &str,
    status: &str,
    cols: usize,
    rows: usize,
) -> Vec<String> {
    let mut v = render_stream_frame(text, title, status, cols, rows.max(3));
    // 补/裁到**精确 rows 行**: 调用方按行号整块重画, 行数对不上就会串行
    while v.len() < rows {
        let inner = panel_width(if cols > 0 { cols } else { term_width() }).saturating_sub(4);
        v.push(format!(
            "│ {}{}│",
            " ".repeat(inner),
            ""
        ));
    }
    if v.len() > rows {
        v.truncate(rows);
    }
    v
}
