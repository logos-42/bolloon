//! theme.rs — bolloon TUI 主题 token (**唯一颜色事实源**)
//!
//! **复用 TS 原文 `src/cli/theme.ts`** (与 Web UI 同一套 bolloon 色系:
//! 主色 `#c4d640` · 正文 `#d8d8c8` · 警告 `#f59e0b` · 成功 `#22c55e` · 错误 `#ef4444`)。
//!
//! 纪律与 TS 一致: 组件一律引用这里的 token, **不许散落 hex 字面量**;
//! 颜色只是**第二通道** —— 语义本体永远写在符号/文字里 (`●` 可用 / `○` 未配置 / `← 当前` / `✓`/`✗`/`⚠`),
//! 所以 `NO_COLOR` / `TERM=dumb` / 非终端下关掉颜色, **信息一点都不丢**。

use std::sync::LazyLock;

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
// 全部由上面的 token 生成 —— 颜色只有一个来源。
pub static C_ACCENT: LazyLock<String> = LazyLock::new(|| fg(THEME_ACCENT));
pub static C_ACCENT_BG: LazyLock<String> = LazyLock::new(|| bg(THEME_ACCENT));
pub static C_TEXT: LazyLock<String> = LazyLock::new(|| fg(THEME_TEXT));
pub static C_WHITE: LazyLock<String> = LazyLock::new(|| fg(THEME_WHITE));
pub static C_DIM: LazyLock<String> = LazyLock::new(|| fg(THEME_DIM));
pub static C_MUTED: LazyLock<String> = LazyLock::new(|| fg(THEME_MUTED));
pub static C_OK: LazyLock<String> = LazyLock::new(|| fg(THEME_OK));
pub static C_ERROR: LazyLock<String> = LazyLock::new(|| fg(THEME_ERROR));
pub static C_WARN: LazyLock<String> = LazyLock::new(|| fg(THEME_WARN));
pub static C_BORDER_BRIGHT: LazyLock<String> = LazyLock::new(|| fg(THEME_BORDER_BRIGHT));
pub static C_BLUE: LazyLock<String> = LazyLock::new(|| fg(THEME_BLUE));

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

    #[test]
    fn color_enabled_three_conditions() {
        assert!(!color_enabled_env(false, None, None));
        assert!(!color_enabled_env(true, Some("1"), None));
        assert!(!color_enabled_env(true, None, Some("dumb")));
        assert!(color_enabled_env(true, None, Some("xterm-256color")));
    }
}
