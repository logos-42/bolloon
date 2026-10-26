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
//! 纪律:
//!   · **没有底边框** —— 消息没完就不画 `╰` (绝不在错误位置提前固定);
//!   · 高度封顶 (不越过 chrome 顶部), 超出**留尾** (光标语义: 看得见最新内容);
//!   · 重画用**绝对行号** + `\x1b[2K` 整行擦 (与 `Chrome::draw` 同口径, 绝不靠
//!     相对位移 —— 折一行就全盘漂移的老坑不重踩);
//!   · 只有**一个**写入者: 调用方的事件循环 (deltas + tick 在同一个 select! 里)。
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

/// 流式面板的临时视图 (生成完毕必须 `finish`, 否则残框挂在屏幕上)
pub struct StreamPanel {
    drawn: usize,
}

impl Default for StreamPanel {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamPanel {
    pub fn new() -> Self {
        Self { drawn: 0 }
    }

    pub fn is_showing(&self) -> bool {
        self.drawn > 0
    }

    /// 重画一帧。`above_row` = 面板**底边**所在行 (面板从这里向上生长)。
    pub fn show(&mut self, text: &str, title: &str, status: &str, cols: usize, above_row: usize) {
        let above_row = above_row.max(2);
        let max_rows = above_row - 1; // 顶部留第 1 行, 绝不顶到屏幕外
        let frame = render_stream_frame(text, title, status, cols, max_rows);
        let bottom = above_row - 1;
        // 不越过第 1 行: 小终端 / 首轮 dashboard 紧贴顶部时也安全 (绝不把边框画到行 0)
        let h = frame.len().min(bottom);
        let top = bottom - h + 1;

        let mut out = String::new();
        // 擦掉上一帧 (可能比这一帧高): 从更高的那帧顶擦到底边
        let prev_top = bottom.saturating_sub(self.drawn.saturating_sub(1));
        let erase_top = top.min(prev_top);
        for row in erase_top..=bottom {
            out.push_str(&format!("\x1b[{row}H\x1b[2K"));
        }
        for (i, line) in frame.iter().enumerate() {
            out.push_str(&format!("\x1b[{}H{}", top + i, line));
        }
        print!("{out}");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        self.drawn = h;
    }

    /// 擦除面板 (完成/失败/取消后调; 完整回复框由 `print_above` 接管)
    pub fn finish(&mut self, above_row: usize) {
        if self.drawn == 0 {
            return;
        }
        let above_row = above_row.max(2);
        let bottom = above_row - 1;
        let h = self.drawn.min(bottom);
        let top = bottom - h + 1;
        let mut out = String::new();
        for row in top..=bottom {
            out.push_str(&format!("\x1b[{row}H\x1b[2K"));
        }
        print!("{out}");
        let _ = std::io::Write::flush(&mut std::io::stdout());
        self.drawn = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 开底: 顶边框闭合, **绝不出现底边框** (消息没完不画 ╰)
    #[test]
    fn frame_has_top_but_no_bottom_border() {
        let v = render_stream_frame("你好", "Bolloon Agent", "◉ Generating", 60, 10);
        assert!(v[0].starts_with('╭'), "顶边框: {:?}", v[0]);
        assert!(v[0].ends_with('╮'), "顶边框闭合: {:?}", v[0]);
        assert!(v.last().unwrap().contains("Generating"), "状态行: {:?}", v.last().unwrap());
        for l in &v {
            assert!(!l.starts_with('╰'), "开底面板不许有底边框: {l:?}");
        }
    }

    /// 正文始终在左右边框之间, 行宽一致, 不越界
    #[test]
    fn body_stays_inside_borders() {
        let text = "这是一段很长的中文内容没有空格必须自动换行还要混排 English mixed text 也很长".repeat(3);
        let v = render_stream_frame(&text, "Agent", "◉ Thinking", 40, 50);
        let w = disp_width(&v[0]);
        for l in &v {
            assert_eq!(disp_width(l), w, "行宽不一致: {l:?}");
        }
        for l in &v[1..] {
            assert!(l.starts_with('│') && l.ends_with('│'), "正文行必须在边框内: {l:?}");
        }
    }

    /// 高度封顶: 超出 max_rows 留尾 (+N 行), 最新内容看得见
    #[test]
    fn tall_content_caps_and_keeps_tail() {
        let text = (1..=30).map(|i| format!("第{i}行")).collect::<Vec<_>>().join("\n");
        let v = render_stream_frame(&text, "Agent", "◉", 60, 6);
        assert!(v.len() <= 6, "必须封顶: {}", v.len());
        assert!(v.iter().any(|l| l.contains("(+")), "要有折叠标记");
        assert!(v.iter().any(|l| l.contains("第30行")), "尾部必须在");
        assert!(!v.iter().any(|l| l.contains("第1行") && !l.contains("(+")), "头部该被折掉");
    }

    /// 空文本也有一帧 (顶边框 + 空行 + 状态行) —— 慢响应时"思考中"有处可画
    #[test]
    fn empty_text_still_renders_frame() {
        let v = render_stream_frame("", "Agent", "◉ Thinking", 40, 10);
        assert_eq!(v.len(), 3);
    }
}
