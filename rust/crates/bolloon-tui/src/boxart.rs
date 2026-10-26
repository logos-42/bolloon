//! boxart.rs — 通用边框构件 (方角 / 圆角)
//!
//! **复用 TS 原文** `src/cli/loading-tui.ts`:
//!   · 方角 `SQ` (启动仪表盘 / 对话框 / 引用框)
//!   · 圆角 `RD` (工具调用显示 / 智能体回复内容)
//!   · `boxTop` / `boxRow` / `boxBottom` / `centerAnsi` / `fitLeft`

use crate::width::{disp_width, is_wide, truncate};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Corners {
    pub tl: char,
    pub tr: char,
    pub bl: char,
    pub br: char,
    pub v: char,
    pub h: char,
}

/** 方角 (启动仪表盘 / 对话框 / 引用框) */
pub const SQ: Corners = Corners {
    tl: '┌',
    tr: '┐',
    bl: '└',
    br: '┘',
    v: '│',
    h: '─',
};

/** 圆角 (工具调用显示 / 智能体回复内容) */
pub const RD: Corners = Corners {
    tl: '╭',
    tr: '╮',
    bl: '╰',
    br: '╯',
    v: '│',
    h: '─',
};

/** 标题居中嵌进上边框 (TS `boxTop`) */
pub fn box_top(title: &str, width: usize, corners: Corners) -> String {
    let inner = width.saturating_sub(2);
    let mut t = if title.is_empty() {
        String::new()
    } else {
        format!(" {title} ")
    };
    if disp_width(&t) > inner {
        t = truncate(&t, inner);
    }
    let pad = inner.saturating_sub(disp_width(&t));
    let left = pad / 2;
    let right = pad - left;
    format!(
        "{}{}{}{}{}",
        corners.tl,
        corners.h.to_string().repeat(left),
        t,
        corners.h.to_string().repeat(right),
        corners.tr
    )
}

/** 内容行 (TS `boxRow`) */
pub fn box_row(content: &str, width: usize, align: Align, corners: Corners) -> String {
    let inner = width.saturating_sub(4);
    let body = match align {
        Align::Center => center_ansi(content, inner),
        Align::Left => fit_left(content, inner),
    };
    format!("{} {body} {}", corners.v, corners.v)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
}

/** 下边框 (TS `boxBottom`) */
pub fn box_bottom(width: usize, corners: Corners) -> String {
    format!(
        "{}{}{}",
        corners.bl,
        corners.h.to_string().repeat(width.saturating_sub(2)),
        corners.br
    )
}

/** 按显示宽度居中 (两侧补空格) */
pub fn center_ansi(text: &str, inner: usize) -> String {
    let pad = inner.saturating_sub(disp_width(text));
    let left = pad / 2;
    let right = pad - left;
    format!("{}{text}{}", " ".repeat(left), " ".repeat(right))
}

/** 左侧对齐并按显示宽度填充/截断到 inner; 截断时末尾 `…` */
pub fn fit_left(text: &str, inner: usize) -> String {
    let vis = disp_width(text);
    if vis <= inner {
        return format!("{text}{}", " ".repeat(inner - vis));
    }
    let limit = inner.saturating_sub(1);
    let mut out = String::new();
    let mut w = 0usize;
    for ch in text.chars() {
        let cw = if is_wide(ch) { 2 } else { 1 };
        if w + cw > limit {
            break;
        }
        out.push(ch);
        w += cw;
    }
    format!("{out}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn box_top_centers_title() {
        let s = box_top("Bolloon Agent · 仪表盘", 30, SQ);
        assert!(s.starts_with('┌'));
        assert!(s.ends_with('┐'));
        assert_eq!(disp_width(&s), 30);
        assert!(s.contains("Bolloon Agent · 仪表盘"));
    }

    #[test]
    fn box_top_truncates_long_title() {
        let s = box_top(&"长".repeat(100), 20, SQ);
        assert_eq!(disp_width(&s), 20);
    }

    #[test]
    fn box_row_geometry_is_exact() {
        let s = box_row("● ok", 20, Align::Left, SQ);
        assert_eq!(disp_width(&s), 20);
        assert!(s.starts_with("│ ● ok"));
        assert!(s.ends_with("│"));
    }

    #[test]
    fn box_row_center_is_symmetric() {
        let s = box_row("ab", 10, Align::Center, RD);
        assert_eq!(disp_width(&s), 10);
        // 中间行的左右两边都是**竖线** (圆角只体现在上/下边框的四个角)
        assert_eq!(s, "│   ab   │");
    }

    #[test]
    fn box_bottom_width_matches_top() {
        assert_eq!(disp_width(&box_bottom(12, SQ)), 12);
        assert_eq!(box_bottom(4, SQ), "└──┘");
    }

    #[test]
    fn fit_left_pads_then_truncates() {
        assert_eq!(fit_left("ab", 5), "ab   ");
        assert_eq!(disp_width(&fit_left("中文中文", 5)), 5);
    }

    /// 圆角 vs 方角字符与 TS 逐字一致
    #[test]
    fn corners_match_ts() {
        assert_eq!(SQ.tl, '┌');
        assert_eq!(SQ.br, '┘');
        assert_eq!(RD.tl, '╭');
        assert_eq!(RD.br, '╯');
        assert_eq!(RD.v, '│');
        assert_eq!(RD.h, '─');
    }
}
