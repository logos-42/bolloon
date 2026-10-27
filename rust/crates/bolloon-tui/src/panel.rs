//! panel.rs — 仪表盘 / 对话框 / 消息框 / 工具行
//!
//! **复用 TS 原文** `src/cli/loading-tui.ts`:
//!   `STATUS_SYMBOL` · `wrapText` · `renderDashboard` · `renderDialog` · `renderMessageBox`
//!   · `renderUserMessage` · `renderAgentMessage` · `renderReference` · `renderToolCallListItem`
//!   · `renderToolCallsHeader` · `flowConnector` · `isDiffOutput` · `colorizeDiff` · `renderToolCall`
//!
//! 两条**不许违反**的纪律 (照搬 TS 注释):
//!   ① **空回复不许出空框** —— 模型这轮没给文本就如实说一句, 不当成正常回复渲染
//!      (2026-10-19 leo: 「还有一些空回复的问题」); 这里是**唯一收口点**。
//!   ② **几何不抖** —— 宽度一律 `min(term_width()-2, …)`, 宁可不显示艺术字也不让它被折行。

use crate::boxart::{box_bottom, box_row, box_top, Align, RD, SQ};
use crate::markdown::md_inline;
use crate::theme::{
    BOLD, C_ACCENT, C_BORDER_BRIGHT, C_DIM, C_ERROR, C_MUTED, C_OK, C_WARN, C_WHITE, RESET,
};
use crate::trace::tool_args_summary;
use crate::width::{disp_width, term_width, truncate, truncate_safe};

// ── 状态图标 ───────────────────────────────────────────────
pub fn status_symbol(status: &str) -> String {
    match status {
        "pending" => format!("{C_MUTED}○{RESET}"),
        "active" => format!("{C_WARN}⠹{RESET}"),
        "ok" => format!("{C_OK}✓{RESET}"),
        "warn" => format!("{C_WARN}⚠{RESET}"),
        "error" => format!("{C_ERROR}✗{RESET}"),
        _ => format!("{C_ACCENT}●{RESET}"), // info
    }
}

// ── 折行 ───────────────────────────────────────────────────
/**
 * 按显示宽度折行 (**保留 ANSI**, 优先在空格处断行; 超长无空格片段按字符硬断)。
 * 与 TS `wrapText` 同口径 —— 面板长过屏幕会把输入行顶出视野。
 */
pub fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if width <= 0 {
        return text.split('\n').map(|s| s.to_string()).collect();
    }
    let mut out: Vec<String> = Vec::new();
    for raw_line in text.split('\n') {
        if disp_width(raw_line) <= width {
            out.push(raw_line.to_string());
            continue;
        }
        // JS `rawLine.split(/(\s+)/)` — 分隔符也保留
        let words = split_keep_ws(raw_line);
        let mut cur = String::new();
        for w in words {
            if w.is_empty() {
                continue;
            }
            let wv = disp_width(&w);
            if wv > width {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                // 超长无空格片段 (如中文长句) → 按显示宽度硬断。
                // 必须用 ANSI 感知的断法: 样式序列是零宽原子, 逐字符断会把
                // `\x1b[…m` 拦腰截断 (边框缺失/乱码的头号根因)。
                let parts = crate::width::hard_break_ansi(&w, width);
                let last = parts.len().saturating_sub(1);
                for (i, p) in parts.into_iter().enumerate() {
                    if i < last {
                        out.push(p);
                    } else {
                        cur = p;
                    }
                }
                continue;
            }
            if disp_width(&cur) + wv > width && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
                cur = w.trim_start().to_string();
            } else {
                cur.push_str(&w);
            }
        }
        if !cur.is_empty() {
            out.push(cur);
        }
    }
    out
}

/** JS `s.split(/(\s+)/)`: 切成「连续空白段」与「连续非空白段」交替, 分隔符保留 */
fn split_keep_ws(s: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut buf_ws = false;
    for ch in s.chars() {
        let is_ws = ch.is_whitespace();
        if !buf.is_empty() && is_ws != buf_ws {
            out.push(std::mem::take(&mut buf));
        }
        buf.push(ch);
        buf_ws = is_ws;
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

// ── 仪表盘 / 对话框 ────────────────────────────────────────
pub struct DashRow {
    pub label: String,
    /// pending | active | ok | warn | error | info
    pub status: Option<String>,
    pub detail: Option<String>,
}

pub struct DashboardOpts {
    pub title: Option<String>,
    pub rows: Vec<DashRow>,
    /// 默认 true
    pub brand: Option<bool>,
    pub width: Option<usize>,
}

pub fn render_dashboard(opts: &DashboardOpts) -> String {
    use crate::brand::{pick_banner, robot_head};

    let show_brand = opts.brand.unwrap_or(true);
    let title = opts.title.clone().unwrap_or_else(|| "Bolloon Agent · 仪表盘".to_string());

    // 艺术字**按可用内宽挑档** —— 装不下就降档, 绝不让它被终端折行
    let icon = robot_head();
    let icon_w = icon.iter().map(|l| disp_width(l)).max().unwrap_or(1).max(1);
    let art_of = |w: usize| -> Vec<String> {
        if !show_brand {
            return vec![];
        }
        let banner = pick_banner(w.saturating_sub(icon_w + 2));
        let gap = 2;
        (0..icon.len().max(banner.len()))
            .map(|i| {
                let il = icon.get(i).cloned().unwrap_or_default();
                let bl = banner.get(i).cloned().unwrap_or_default();
                let pad = icon_w.saturating_sub(disp_width(&il));
                format!("{il}{}{bl}", " ".repeat(pad + gap))
            })
            .collect()
    };

    let max_row = opts
        .rows
        .iter()
        .map(|r| {
            disp_width(&r.label)
                + r.detail.as_ref().map(|d| disp_width(d) + 2).unwrap_or(0)
                + 4
        })
        .max()
        .unwrap_or(0);
    let max_title = disp_width(&title) + 4;

    // 先用"最小可用内宽"定一次宽度, 再按真实宽度挑档 (与 TS 的 `useArt` 判据同思路: 装不下不画)
    let probe = art_of(40);
    let max_art = probe.iter().map(|l| disp_width(l)).max().unwrap_or(0);
    let inner = 40usize.max(max_art).max(max_row).max(max_title);
    let width = (term_width() - 2).min(opts.width.unwrap_or(inner + 4));
    let inner_w = width.saturating_sub(4);

    let art = if show_brand {
        let a = art_of(inner_w);
        if a.iter().map(|l| disp_width(l)).max().unwrap_or(0) <= inner_w {
            a
        } else {
            vec![]
        }
    } else {
        vec![]
    };
    let mut lines: Vec<String> = Vec::new();
    lines.push(box_top(&title, width, SQ));
    for l in &art {
        lines.push(box_row(l, width, Align::Center, SQ));
    }
    for r in &opts.rows {
        let sym = status_symbol(r.status.as_deref().unwrap_or("info"));
        let detail = r
            .detail
            .as_ref()
            .map(|d| format!("  {C_DIM}{d}{RESET}"))
            .unwrap_or_default();
        lines.push(box_row(&format!("{sym} {}{}", r.label, detail), width, Align::Left, SQ));
    }
    lines.push(box_bottom(width, SQ));
    lines.join("\n")
}

pub struct DialogOpts {
    pub title: Option<String>,
    pub prompt: String,
    pub brand: Option<bool>,
    pub width: Option<usize>,
}

pub fn render_dialog(opts: &DialogOpts) -> String {
    use crate::brand::{pick_banner, robot_head};

    let show_brand = opts.brand.unwrap_or(true);
    let title = opts.title.clone().unwrap_or_else(|| "Bolloon Agent".to_string());
    let icon = robot_head();
    let icon_w = icon.iter().map(|l| disp_width(l)).max().unwrap_or(1).max(1);

    let banner_probe = pick_banner(40);
    let max_art = banner_probe
        .iter()
        .map(|l| disp_width(l) + icon_w + 2)
        .max()
        .unwrap_or(0);
    let inner = 40usize
        .max(max_art)
        .max(disp_width(&opts.prompt) + 4)
        .max(disp_width(&title) + 4);
    let width = (term_width() - 2).min(opts.width.unwrap_or(inner + 4));
    let inner_w = width.saturating_sub(4);

    let art: Vec<String> = if show_brand {
        let banner = pick_banner(inner_w.saturating_sub(icon_w + 2));
        (0..icon.len().max(banner.len()))
            .map(|i| {
                let il = icon.get(i).cloned().unwrap_or_default();
                let bl = banner.get(i).cloned().unwrap_or_default();
                let pad = icon_w.saturating_sub(disp_width(&il));
                format!("{il}{}{bl}", " ".repeat(pad + 2))
            })
            .collect()
    } else {
        vec![]
    };

    let mut lines: Vec<String> = Vec::new();
    lines.push(box_top(&title, width, SQ));
    for l in &art {
        lines.push(box_row(l, width, Align::Center, SQ));
    }
    lines.push(box_row(&opts.prompt, width, Align::Left, SQ));
    lines.push(box_bottom(width, SQ));
    lines.join("\n")
}

// ── 消息对话框 (聊天流: 已发送 / 智能体回复) ───────────────
pub struct MessageBoxOpts {
    pub title: Option<String>,
    pub body: String,
    pub color: Option<String>,
    pub width: Option<usize>,
    /// 显示截断: 超过此行数则截断 (**仅影响显示**, 原文仍发给 LLM)。0 或 None = 不限制
    pub max_lines: Option<usize>,
}

/** 对话框默认显示上限 (按高度截断) */
pub const DEFAULT_MAX_LINES: usize = 14;

pub fn render_message_box(opts: &MessageBoxOpts) -> String {
    let color = opts.color.clone().unwrap_or_else(|| C_ACCENT.to_string());
    let title = opts.title.clone().unwrap_or_else(|| "Bolloon Agent".to_string());
    let max_lines = opts.max_lines.unwrap_or(0);
    let body_lines = wrap_text(&opts.body, 1000);

    // 压缩: 用「引用」框代替被压缩的内容 (**仅影响显示**, 原文仍发给 LLM)
    if max_lines > 0 && body_lines.len() > max_lines {
        return render_reference(&title, &opts.body, &color, body_lines.len(), opts.width);
    }

    let max_line = body_lines.iter().map(|l| disp_width(l)).max().unwrap_or(0);
    let inner = 20usize.max(disp_width(&title) + 4).max(max_line);
    let width = (term_width() - 2).min(opts.width.unwrap_or(inner + 4));

    let mut lines: Vec<String> = Vec::new();
    // 2026-08-07: 边框提亮 (C_BORDER_BRIGHT), 正文纯白 (C_WHITE) — 告别灰白内容
    lines.push(format!(
        "{C_BORDER_BRIGHT}{}{RESET}",
        box_top(&format!("{color}{title}{RESET}"), width, RD)
    ));
    for l in wrap_text(&opts.body, width.saturating_sub(4)) {
        lines.push(format!(
            "{C_BORDER_BRIGHT}{}{RESET}",
            box_row(&format!("{C_WHITE}{l}{RESET}"), width, Align::Left, RD)
        ));
    }
    lines.push(format!("{C_BORDER_BRIGHT}{}{RESET}", box_bottom(width, RD)));
    lines.join("\n")
}

/** 取首条非空行作为预览 (按可见宽度截断, 加省略号) */
fn first_line_preview(text: &str, width: usize) -> String {
    for raw in text.split('\n') {
        let t = raw.trim();
        if !t.is_empty() {
            return truncate(t, width);
        }
    }
    String::new()
}

/** 压缩后的「引用」框: 代替被压缩的正文 */
fn render_reference(
    title: &str,
    body: &str,
    color: &str,
    hidden: usize,
    width: Option<usize>,
) -> String {
    let preview = first_line_preview(body, 60);
    let notice = format!("已压缩 {hidden} 行 · 完整内容已发送给智能体");
    let inner = 20usize
        .max(disp_width(title) + 8)
        .max(disp_width(&notice))
        .max(disp_width(&preview) + 2);
    let width = (term_width() - 2).min(width.unwrap_or(inner + 4));
    let mut lines: Vec<String> = Vec::new();
    lines.push(box_top(
        &format!("{C_DIM}引用{RESET} {color}{title}{RESET}"),
        width,
        RD,
    ));
    lines.push(box_row(&format!("{C_DIM}{notice}{RESET}"), width, Align::Left, RD));
    if !preview.is_empty() {
        lines.push(box_row(
            &format!("{C_DIM}▏ {preview}{RESET}"),
            width,
            Align::Left,
            RD,
        ));
    }
    lines.push(box_bottom(width, RD));
    lines.join("\n")
}

/** 已发送消息框 (用户输入) */
pub fn render_user_message(body: &str) -> String {
    render_message_box(&MessageBoxOpts {
        title: Some("✓ 已发送".to_string()),
        body: md_inline(body),
        color: Some(C_OK.to_string()),
        width: None,
        max_lines: Some(DEFAULT_MAX_LINES),
    })
}

/**
 * 智能体回复框 (**不压缩**, 用户需要看到完整回复)。
 *
 * 2026-10-19 (leo: 「还有一些空回复的问题」): 空正文**不许出空框** (`│  │` 那种)。
 *   先剥 ANSI 再 trim, 空 = 模型这轮没给文本 (只回思考/工具音/被超时打断) ⇒ 给一行如实说明,
 *   不当成正常回复渲染。这里是**唯一收口点**。
 */
pub fn render_agent_message(body: &str) -> String {
    let plain = crate::width::strip_ansi(body).trim().to_string();
    if plain.is_empty() {
        return format!(
            "{C_DIM}◉ 本轮无文本回复 (模型返回了空内容, 已记入 logs/startup.log){RESET}"
        );
    }
    render_message_box(&MessageBoxOpts {
        title: Some("◉ Bolloon Agent".to_string()),
        body: md_inline(body),
        color: Some(C_ACCENT.to_string()),
        width: None,
        max_lines: None,
    })
}

// ── 工具调用显示 ───────────────────────────────────────────
pub struct ToolCallListItem {
    pub tool: String,
    /// ok | error | active
    pub status: String,
    pub duration_ms: Option<u64>,
    pub args: Option<serde_json::Value>,
    pub output: Option<String>,
    pub error: Option<String>,
}

/** 渲染单条工具调用为紧凑列表项 (增量显示, 一行, 参数摘要) */
pub fn render_tool_call_list_item(item: &ToolCallListItem, _index: usize, _total: usize) -> String {
    let dur = item
        .duration_ms
        .map(|ms| format!(" {C_DIM}{ms}ms{RESET}"))
        .unwrap_or_default();
    let label = if item.status == "error" {
        format!("{C_ERROR}{}{RESET}", item.tool)
    } else {
        format!("{C_ACCENT}{}{RESET}", item.tool)
    };
    // 2026-10-14: 工具行附上参数摘要 (terminal→命令 / read_file→路径 / grep→pattern·dir),
    //   灰色、截断; 看不清过程的问题 = 之前只有工具名, 不知道它具体跑了什么。
    let sum = tool_args_summary(&item.tool, item.args.as_ref());
    let sum_part = if sum.is_empty() {
        String::new()
    } else {
        format!(" {C_DIM}{sum}{RESET}")
    };
    // 2026-10-01: 工具行也按**保守宽度**截断 —— 超宽会让终端折行、打乱光标
    truncate_safe(
        &format!("  🔧 {label}{sum_part}{dur}"),
        (term_width().max(1)) - 1,
    )
}

/** 增量列表标题行 (含步骤计数) */
pub fn render_tool_calls_header(count: usize) -> String {
    if count == 0 {
        return String::new();
    }
    format!("  {C_DIM}╭─ 工具调用 ({count} 步){RESET}")
}

/** 循环工作流连接线: 用 ╼ ╾ 串联相邻工具框 */
pub fn flow_connector(width: usize) -> String {
    let unit = "╼ ╾ ";
    let mut s = String::new();
    while s.chars().count() < width {
        s.push_str(unit);
    }
    s.chars().take(width).collect()
}

/** 判断输出是否包含 git diff / 补丁内容 (TS: `/^diff --git|^--- |^\+\+\+ |^@@ /m` + `/^[\+\-]\s+\S/m`) */
pub fn is_diff_output(text: &str) -> bool {
    text.lines().any(|l| {
        l.starts_with("diff --git")
            || l.starts_with("--- ")
            || l.starts_with("+++ ")
            || l.starts_with("@@ ")
            || is_added_or_removed_line(l)
    })
}

/** TS `/^[\+\-]\s+\S/`: 行首 `+`/`-`, 接着**至少一格空白**, 再接着一个非空白 */
fn is_added_or_removed_line(l: &str) -> bool {
    let mut it = l.chars();
    match it.next() {
        Some('+') | Some('-') => {}
        _ => return false,
    }
    let rest: Vec<char> = it.collect();
    match rest.first() {
        Some(c) if c.is_whitespace() => {}
        _ => return false,
    }
    rest.iter()
        .skip_while(|c| c.is_whitespace())
        .next()
        .map(|c| !c.is_whitespace())
        .unwrap_or(false)
}

/** 把 diff 内容着色: + 行绿色, - 行红色, @@ 行蓝色, 其余不变 */
pub fn colorize_diff(text: &str) -> String {
    use crate::theme::C_BLUE;
    text.lines()
        .map(|line| {
            if line.starts_with("diff --git") || line.starts_with("---") || line.starts_with("+++") {
                format!("{C_DIM}{line}{RESET}")
            } else if line.starts_with("@@") {
                format!("{C_BLUE}{line}{RESET}")
            } else if line.starts_with('+') {
                format!("{C_OK}{line}{RESET}")
            } else if line.starts_with('-') {
                format!("{C_ERROR}{line}{RESET}")
            } else if line.starts_with(' ') || line.starts_with('\t') {
                format!("{C_DIM}{line}{RESET}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/** 渲染单个工具调用为圆角框 (参数 / 状态 / 输出预览) — 旧版保留兼容 */
pub struct ToolCallView {
    pub tool: String,
    pub args: Option<serde_json::Value>,
    pub status: String,
    pub output: Option<String>,
    pub error: Option<String>,
    pub duration_ms: Option<u64>,
    pub width: Option<usize>,
}

pub fn render_tool_call(v: &ToolCallView) -> String {
    let color = if v.status == "ok" { C_OK } else { C_ERROR };
    let sym = if v.status == "ok" { "✅" } else { "❌" };
    let w = (term_width() - 2).min(v.width.unwrap_or(72));
    let mut rows: Vec<String> = Vec::new();
    let arg_str = match &v.args {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(o) => o.to_string(),
        None => String::new(),
    };
    if !arg_str.is_empty() {
        rows.push(format!("参数: {}", truncate(&arg_str, w.saturating_sub(10))));
    }
    let dur = v.duration_ms.map(|d| format!(" ({d}ms)")).unwrap_or_default();
    rows.push(format!(
        "状态: {sym} {}{dur}",
        if v.status == "ok" { "成功" } else { "失败" }
    ));
    let body = if v.status == "ok" { v.output.as_deref() } else { v.error.as_deref() };
    if let Some(body) = body {
        if is_diff_output(body) {
            rows.push(colorize_diff(body));
        } else {
            let wrapped = wrap_text(body, w.saturating_sub(6));
            for l in wrapped.iter().take(3) {
                rows.push(format!("▏ {l}"));
            }
            if wrapped.len() > 3 {
                rows.push(format!("▏ … 已压缩 {} 行", wrapped.len() - 3));
            }
        }
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(box_top(&format!("{color}◉ {}{RESET}", v.tool), w, RD));
    for l in &rows {
        lines.push(box_row(l, w, Align::Left, RD));
    }
    lines.push(box_bottom(w, RD));
    lines.join("\n")
}

/** 加粗一段文字 (面板里强调用) */
pub fn bold(s: &str) -> String {
    format!("{BOLD}{s}{RESET}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::strip_ansi;

    /// TS `STATUS_SYMBOL` 六种状态逐字对齐
    #[test]
    fn status_symbols_match_ts() {
        assert_eq!(status_symbol("pending"), "\x1b[38;2;96;96;88m○\x1b[0m");
        assert_eq!(status_symbol("ok"), "\x1b[38;2;34;197;94m✓\x1b[0m");
        assert_eq!(status_symbol("warn"), "\x1b[38;2;245;158;11m⚠\x1b[0m");
        assert_eq!(status_symbol("error"), "\x1b[38;2;239;68;68m✗\x1b[0m");
        assert_eq!(status_symbol("info"), "\x1b[38;2;196;214;64m●\x1b[0m");
        assert_eq!(status_symbol("active"), "\x1b[38;2;245;158;11m⠹\x1b[0m");
    }

    #[test]
    fn wrap_text_prefers_spaces_then_hard_breaks() {
        let v = wrap_text("aa bb cc", 5);
        assert!(v.iter().all(|l| disp_width(l) <= 5), "{v:?}");
        // 超长无空格 → 硬断
        let v2 = wrap_text("中文很长的句子没有空格", 6);
        assert!(v2.iter().all(|l| disp_width(l) <= 6), "{v2:?}");
        assert!(v2.len() > 1);
    }

    #[test]
    fn wrap_text_zero_width_returns_lines() {
        assert_eq!(wrap_text("a\nb", 0), vec!["a", "b"]);
    }

    /// 样式化中文长句 (无空格 ⇒ 必走硬断): ANSI 序列零宽原子, 不截断不丢字
    #[test]
    fn wrap_text_styled_cjk_keeps_ansi_atomic() {
        let styled = format!(
            "{}这是一段非常长的中文句子中间没有任何空格所以必然触发硬断{}结尾也要完整",
            "\x1b[38;5;208m",
            "\x1b[0m"
        );
        let parts = wrap_text(&styled, 10);
        assert!(parts.len() > 1, "{parts:?}");
        for p in &parts {
            assert!(disp_width(p) <= 10, "行超宽: {p:?}");
            assert!(!p.ends_with('\x1b') && !p.ends_with("\x1b["), "半截转义: {p:?}");
        }
        assert_eq!(strip_ansi(&parts.concat()), strip_ansi(&styled), "字符一个都不能丢");
    }

    /// 回复框: 样式化中文长内容下边框完整闭合、行宽一致、正文不出框
    #[test]
    fn agent_message_box_closes_with_styled_cjk() {
        let _g = crate::width::test_lock().lock().unwrap();
        crate::width::set_term_size(40, 24);
        let body = format!(
            "**加粗**开头{}然后是很长的中文内容没有空格必须自动换行`code`混排中文English mixed{}\n```\ncode block line\n```",
            "\x1b[38;5;208m",
            "\x1b[0m"
        );
        let s = render_agent_message(&body);
        let lines: Vec<&str> = s.lines().collect();
        assert!(lines.len() >= 3, "顶+正文+底: {lines:?}");
        assert!(strip_ansi(lines[0]).starts_with('╭'), "顶边框: {:?}", lines[0]);
        assert!(
            strip_ansi(lines.last().unwrap()).starts_with('╰'),
            "底边框: {:?}",
            lines.last().unwrap()
        );
        let w = crate::width::disp_width(lines[0]);
        for l in &lines {
            assert_eq!(crate::width::disp_width(l), w, "行宽不一致: {l:?}");
        }
        crate::width::clear_term_size();
    }

    /// 仪表盘: 每行宽度一致, 上/下边框闭合
    #[test]
    fn dashboard_rows_have_uniform_width() {
        // 依赖 `term_width()` ⇒ 必须与"钉尺寸"的用例串行 (否则读到别人钉的 40 列)
        let _g = crate::width::test_lock().lock().unwrap();
        let s = render_dashboard(&DashboardOpts {
            title: Some("Bolloon Agent · 仪表盘".into()),
            rows: vec![
                DashRow { label: "身份".into(), status: Some("ok".into()), detail: Some("did:pi:…".into()) },
                DashRow { label: "模型".into(), status: Some("pending".into()), detail: None },
            ],
            brand: Some(false),
            width: Some(40),
        });
        let lines: Vec<&str> = s.lines().collect();
        for l in &lines {
            assert_eq!(disp_width(l), 40, "行宽不一致: {l:?}");
        }
        assert!(lines[0].starts_with('┌'));
        assert!(lines.last().unwrap().starts_with('└'));
        assert_eq!(lines.len(), 4); // 顶 + 2 行 + 底 (brand=false ⇒ 无艺术字行)
    }

    /// 对话框: 提示行在框里
    #[test]
    fn dialog_contains_prompt() {
        let _g = crate::width::test_lock().lock().unwrap();
        let s = render_dialog(&DialogOpts {
            title: Some("Bolloon Agent".into()),
            prompt: "确认要切换模型吗?".into(),
            brand: Some(false),
            width: Some(30),
        });
        assert!(s.contains("确认要切换模型吗?"));
        assert!(s.lines().next().unwrap().starts_with('┌'));
    }

    /// **空回复不许出空框** —— 这是 TS 2026-10-19 修的那条, 必须有测试钉住
    #[test]
    fn empty_agent_reply_is_not_an_empty_box() {
        let s = render_agent_message("");
        assert!(!s.contains('│'), "空回复不该出框: {s:?}");
        assert!(s.contains("本轮无文本回复"));
        // 只有 ANSI 空白也算空
        assert!(render_agent_message("\x1b[0m   \x1b[1m").contains("本轮无文本回复"));
    }

    #[test]
    fn agent_message_is_not_compressed() {
        let body = (0..40).map(|i| format!("第 {i} 行")).collect::<Vec<_>>().join("\n");
        let s = render_agent_message(&body);
        assert!(!s.contains("已压缩"), "智能体回复不压缩: {s:?}");
        assert!(s.contains("第 39 行"));
    }

    /// 用户输入超过 14 行 → 折成「引用」框 (仅影响显示)
    #[test]
    fn long_user_message_collapses_to_reference() {
        let _g = crate::width::test_lock().lock().unwrap();
        let body = (0..30).map(|i| format!("第 {i} 行")).collect::<Vec<_>>().join("\n");
        let s = render_user_message(&body);
        assert!(s.contains("已压缩 30 行"));
        assert!(s.contains("完整内容已发送给智能体"));
    }

    /// 工具行: 带参数摘要 + 按保守宽度截断
    #[test]
    fn tool_call_item_has_args_summary() {
        let s = render_tool_call_list_item(
            &ToolCallListItem {
                tool: "terminal".into(),
                status: "ok".into(),
                duration_ms: Some(120),
                args: Some(serde_json::json!({"command": "cargo test"})),
                output: None,
                error: None,
            },
            0,
            1,
        );
        assert!(s.contains("cargo test"), "{s:?}");
        assert!(s.contains("120ms"));
        assert!(s.contains("🔧"));
    }

    #[test]
    fn tool_calls_header_and_connector() {
        assert_eq!(render_tool_calls_header(0), "");
        assert!(render_tool_calls_header(3).contains("工具调用 (3 步)"));
        assert_eq!(flow_connector(5).chars().count(), 5);
    }

    /// diff 着色: + 绿 / - 红 / @@ 蓝 / 头灰
    #[test]
    fn colorize_diff_assigns_channels() {
        let d = colorize_diff("--- a\n+++ b\n@@ -1 +1 @@\n+add\n-del");
        assert!(d.contains("\x1b[38;2;34;197;94m+add"));
        assert!(d.contains("\x1b[38;2;239;68;68m-del"));
        assert!(d.contains("\x1b[38;2;33;150;243m@@"));
    }

    #[test]
    fn diff_detection() {
        assert!(is_diff_output("diff --git a/x b/x\n@@ -1 +1 @@\n+a"));
        assert!(is_diff_output("+ hello"));
        assert!(!is_diff_output("just text"));
    }

}
/// 把工具输出里的 **diff 段落**渲染成终端行 (着色 + 限宽 + 封顶)。
///
/// leo 2026-10-27: 「编辑工具的结果要返回终端展示, 节选长度有限, 但是 diff 要展示出来」。
/// 所以这里只认真 diff (以 `--- a/` 开头的那一段), 不做任何臆造; 超过 `max` 行如实截断。
pub fn render_diff_excerpt(output: &str, cols: usize, max: usize) -> Vec<String> {
    use crate::theme::{C_DIM, C_OK, C_WARN, RESET};
    let lines: Vec<&str> = output.lines().collect();
    let Some(start) = lines.iter().position(|l| l.starts_with("--- a/")) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for l in lines[start..].iter() {
        if out.len() >= max {
            out.push(format!("{C_DIM}… diff 已截断 (最多 {max} 行){RESET}"));
            break;
        }
        if l.starts_with("+++") || l.starts_with("---") {
            out.push(format!("  {C_DIM}{}{RESET}", crate::width::truncate(l, cols)));
        } else if l.starts_with("@@") {
            out.push(format!("  {C_WARN}{}{RESET}", crate::width::truncate(l, cols)));
        } else if let Some(rest) = l.strip_prefix('+') {
            out.push(format!("  {C_OK}+{}{RESET}", crate::width::truncate(rest, cols.saturating_sub(3))));
        } else if let Some(rest) = l.strip_prefix('-') {
            out.push(format!("  {C_WARN}-{}{RESET}", crate::width::truncate(rest, cols.saturating_sub(3))));
        } else {
            out.push(format!("  {}", crate::width::truncate(l, cols)));
        }
    }
    out
}
