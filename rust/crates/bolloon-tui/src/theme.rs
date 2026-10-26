//! theme.rs — bolloon TUI 主题 token (**唯一颜色事实源**)
//!
//! **复用 TS 原文 `src/cli/theme.ts`** (与 Web UI 同一套 bolloon 色系:
//! 主色 `#c4d640` · 正文 `#d8d8c8` · 警告 `#f59e0b` · 成功 `#22c55e` · 错误 `#ef4444`)。
//!
//! 纪律与 TS 一致: 组件一律引用这里的 token, **不许散落 hex 字面量**;
//! 颜色只是**第二通道** —— 语义本体永远写在符号/文字里 (`●` 可用 / `○` 未配置 / `← 当前` / `✓`/`✗`/`⚠`),
//! 所以 `NO_COLOR` / `TERM=dumb` / 非终端下关掉颜色, **信息一点都不丢**。

pub const RESET: &str = "\x1b[0m";
pub const BOLD: &str = "\x1b[1m";

// ── 调色板 (TS `THEME`, 逐字搬) ────────────────────────────
pub const THEME_ACCENT: &str = "#c4d640"; // 主色 (bolloon 绿)
pub const THEME_TEXT: &str = "#d8d8c8"; // 正文
pub const THEME_MUTED: &str = "#606058"; // 次要/暗层
pub const THEME_DIM: &str = "#909088"; // 更暗
pub const THEME_OK: &str = "#22c55e"; // 成功
pub const THEME_ERROR: &str = "#ef4444"; // 错误
pub const THEME_WARN: &str = "#f59e0b"; // 警告
pub const THEME_BORDER: &str = "#3a3a36"; // 暗描边
pub const THEME_BORDER_BRIGHT: &str = "#8a8a7e"; // 对话框边框提亮
/// 光标行字色 (压在 accent 底上的近黑, 对比度 ~11:1)
pub const THEME_CURSOR: &str = "#141410";
/// 纯白 (2026-08-07: 用户要求回复字体白色显眼) — 来自 `loading-tui.ts` 的 C_WHITE
pub const THEME_WHITE: &str = "#ffffff";
/// diff 的 `@@` 行蓝 — 来自 `loading-tui.ts` 的 `fg(0x21,0x96,0xf3)`
pub const THEME_BLUE: &str = "#2196f3";

/// `'#c4d640'` → `'\x1b[38;2;196;214;64m'` (ANSI 前景色码)
pub fn fg(hex: &str) -> String {
    let (r, g, b) = rgb_of(hex);
    format!("\x1b[38;2;{r};{g};{b}m")
}

/// `'#c4d640'` → `'\x1b[48;2;196;214;64m'` (ANSI **背景**色码)
pub fn bg(hex: &str) -> String {
    let (r, g, b) = rgb_of(hex);
    format!("\x1b[48;2;{r};{g};{b}m")
}

fn rgb_of(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    let p = |i: usize| -> u8 {
        if h.len() == 6 {
            u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0)
        } else {
            0
        }
    };
    (p(0), p(2), p(4))
}

// ── 语义调子 (TS `Tone` / `TONE_TOKEN`) ────────────────────
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Accent,
    Ok,
    Warn,
    Error,
    Muted,
    Dim,
    Text,
    /// 无调子 = 正文
    Plain,
}

/** 调子 → 调色板 token (**唯一映射**) */
pub fn tone_token(t: Tone) -> &'static str {
    match t {
        Tone::Accent => THEME_ACCENT,
        Tone::Ok => THEME_OK,
        Tone::Warn => THEME_WARN,
        Tone::Error => THEME_ERROR,
        Tone::Muted => THEME_MUTED,
        Tone::Dim => THEME_DIM,
        Tone::Text | Tone::Plain => THEME_TEXT,
    }
}

/** 调子 → 前景 SGR (`plain` 不上色, 与 TS 的 `TONE` 表同口径) */
pub fn tone_fg(t: Tone) -> String {
    if t == Tone::Plain {
        String::new()
    } else {
        fg(tone_token(t))
    }
}

/**
 * 给**一整行**套上调子的前景色 (主屏/选择器都走这里)。
 * `color == false` → 原样返回 (**一个字节的 SGR 都不加**)。
 */
pub fn tint(line: &str, tone: Tone, color: bool) -> String {
    if !color {
        return line.to_string();
    }
    format!("{}{}{}", tone_fg(tone), line, RESET)
}

/**
 * 要不要上色 —— **唯一判据** (与 TS `colorEnabled` 同口径; 这里把 env 显式传进来, 便于测):
 *   ① 输出得是真终端; ② 没设 `NO_COLOR`; ③ `TERM` 不是 `dumb`。
 */
pub fn color_enabled_env(is_tty: bool, no_color: Option<&str>, term: Option<&str>) -> bool {
    if !is_tty {
        return false;
    }
    let no_color = no_color.map(|s| !s.trim().is_empty()).unwrap_or(false);
    let dumb = term
        .map(|t| t.eq_ignore_ascii_case("dumb"))
        .unwrap_or(false);
    !no_color && !dumb
}

/** 真机版: 直接读进程环境 + stdout 是否 TTY */
pub fn color_enabled() -> bool {
    let is_tty = unsafe { libc::isatty(libc::STDOUT_FILENO) == 1 };
    color_enabled_env(
        is_tty,
        std::env::var("NO_COLOR").ok().as_deref(),
        std::env::var("TERM").ok().as_deref(),
    )
}

// ── 面板/仪表盘用的派生色 (TS `loading-tui.ts` 顶部那批常量) ──
//
// 写成 `const` 字面量是为了能在 `format!("{C_ACCENT}…")` 里直接用 (内联格式参数要 `Display`);
// **来源仍然只有一个**: 文件末尾的 `derived_colors_match_palette` 逐条断言
//   `C_* === fg(THEME_*)` / `bg(THEME_*)` —— 谁改了调色板而忘了改常量, 测试立刻红。
pub const C_ACCENT: &str = "\x1b[38;2;196;214;64m"; // fg(#c4d640)
pub const C_ACCENT_BG: &str = "\x1b[48;2;196;214;64m"; // bg(#c4d640)
pub const C_TEXT: &str = "\x1b[38;2;216;216;200m"; // fg(#d8d8c8)
pub const C_WHITE: &str = "\x1b[38;2;255;255;255m"; // fg(#ffffff)
pub const C_DIM: &str = "\x1b[38;2;144;144;136m"; // fg(#909088)
pub const C_MUTED: &str = "\x1b[38;2;96;96;88m"; // fg(#606058)
pub const C_OK: &str = "\x1b[38;2;34;197;94m"; // fg(#22c55e)
pub const C_ERROR: &str = "\x1b[38;2;239;68;68m"; // fg(#ef4444)
pub const C_WARN: &str = "\x1b[38;2;245;158;11m"; // fg(#f59e0b)
pub const C_BORDER_BRIGHT: &str = "\x1b[38;2;138;138;126m"; // fg(#8a8a7e)
pub const C_BLUE: &str = "\x1b[38;2;33;150;243m"; // fg(#2196f3) diff 的 @@ 行

#[cfg(test)]
mod tests {
    use super::*;

    /// TS: `fg('#c4d640')` === `\x1b[38;2;196;214;64m`
    #[test]
    fn fg_matches_ts() {
        assert_eq!(fg(THEME_ACCENT), "\x1b[38;2;196;214;64m");
        assert_eq!(fg(THEME_TEXT), "\x1b[38;2;216;216;200m");
        assert_eq!(fg(THEME_WHITE), "\x1b[38;2;255;255;255m");
        assert_eq!(fg(THEME_CURSOR), "\x1b[38;2;20;20;16m");
    }

    #[test]
    fn bg_matches_ts() {
        assert_eq!(bg(THEME_ACCENT), "\x1b[48;2;196;214;64m");
    }

    /// token 表逐字对齐 `src/cli/theme.ts`
    #[test]
    fn tokens_match_ts_verbatim() {
        assert_eq!(THEME_ACCENT, "#c4d640");
        assert_eq!(THEME_TEXT, "#d8d8c8");
        assert_eq!(THEME_MUTED, "#606058");
        assert_eq!(THEME_DIM, "#909088");
        assert_eq!(THEME_OK, "#22c55e");
        assert_eq!(THEME_ERROR, "#ef4444");
        assert_eq!(THEME_WARN, "#f59e0b");
        assert_eq!(THEME_BORDER, "#3a3a36");
        assert_eq!(THEME_BORDER_BRIGHT, "#8a8a7e");
        assert_eq!(THEME_CURSOR, "#141410");
    }

    /// 关掉颜色时一个 SGR 字节都不加
    #[test]
    fn tint_off_adds_no_sgr() {
        assert_eq!(tint("● 可用", Tone::Ok, false), "● 可用");
        assert_eq!(
            tint("● 可用", Tone::Ok, true),
            "\x1b[38;2;34;197;94m● 可用\x1b[0m"
        );
    }

    /// **颜色只有一个来源**: 这些 `C_*` 字面量必须逐条等于 `fg/bg(THEME_*)`。
    /// 改调色板忘了改常量 ⇒ 这里立刻红。
    #[test]
    fn derived_colors_match_palette() {
        assert_eq!(C_ACCENT, fg(THEME_ACCENT));
        assert_eq!(C_ACCENT_BG, bg(THEME_ACCENT));
        assert_eq!(C_TEXT, fg(THEME_TEXT));
        assert_eq!(C_WHITE, fg(THEME_WHITE));
        assert_eq!(C_DIM, fg(THEME_DIM));
        assert_eq!(C_MUTED, fg(THEME_MUTED));
        assert_eq!(C_OK, fg(THEME_OK));
        assert_eq!(C_ERROR, fg(THEME_ERROR));
        assert_eq!(C_WARN, fg(THEME_WARN));
        assert_eq!(C_BORDER_BRIGHT, fg(THEME_BORDER_BRIGHT));
        assert_eq!(C_BLUE, fg(THEME_BLUE));
    }

    #[test]
    fn color_enabled_three_conditions() {
        assert!(!color_enabled_env(false, None, None));
        assert!(!color_enabled_env(true, Some("1"), None));
        assert!(!color_enabled_env(true, None, Some("dumb")));
        assert!(color_enabled_env(true, None, Some("xterm-256color")));
    }
}
