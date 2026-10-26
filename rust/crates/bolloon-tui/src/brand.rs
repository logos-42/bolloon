//! brand.rs — Bolloon 终端品牌要素 (机器人头 + BOLLOON 艺术字)
//!
//! **复用 TS 原文** `src/cli/loading-tui.ts` (ROBOT_HEAD / BOLLOON_ICON / BOLLOON_BANNER /
//! BOLLOON_BANNER_SMALL / brandArtLines / printBanner)。
//!
//! 品牌要素与 TUI 一起维护 —— **艺术字逐字搬**, 一个字符都不重排。
//! 窄终端档 (`BOLLOON_BANNER_SMALL`) 是 2026-09-30 leo「我看不到我的 logo」的修法:
//! 宽 < ~97 列时整块 87 列艺术字会被挤掉, 所以按"装得下就上"挑档: 大(87) → 小(37) → 文字(兜底)。

use crate::theme::{BOLD, C_ACCENT, C_ACCENT_BG, C_DIM, C_TEXT, C_WHITE, RESET};
use crate::width::disp_width;

/// 版本 — 与 crate 版本同一来源 (TS 从 package.json 读; Rust 用 CARGO_PKG_VERSION)
pub const BOLLOON_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── 品牌图标: 笑脸机器人 (2026-08-09, bolloon 色系填充) ──────
//   头: 主色边框 + 亮绿填充 (C_ACCENT_BG); 眼睛 ◉ / 嘴 ◡ 用亮色填充;
//   末行 BOLLOON 主色艺术字 (仅 printBanner 用, brandArtLines 会裁掉避免双 logo).
pub fn robot_head() -> Vec<String> {
    vec![
        format!("{C_ACCENT}   ╭───────╮{RESET}"),
        format!("{C_ACCENT} ╭─╯{C_ACCENT_BG}  {C_WHITE}◉{C_ACCENT_BG} {C_WHITE}◉{C_ACCENT_BG}  {RESET}{C_ACCENT}╰─╮{RESET}"),
        format!("{C_ACCENT} │{C_ACCENT_BG}     {C_WHITE}◡{C_ACCENT_BG}     {RESET}{C_ACCENT}│{RESET}"),
        format!("{C_ACCENT} ╰─╮{C_ACCENT_BG}       {RESET}{C_ACCENT}╭─╯{RESET}"),
        format!("{C_ACCENT}   ╰───┬───╯{RESET}"),
        format!("{C_ACCENT}       │{RESET}"),
    ]
}

/** 机器人头 + BOLLOON 字样 (printBanner 用) */
pub fn bolloon_icon() -> String {
    let mut lines = robot_head();
    lines.push(format!("{C_ACCENT}{BOLD}     BOLLOON{RESET}"));
    lines.join("\n")
}

// ── 艺术字: BOLLOON (box 字体) + Bolloon Agent 副标题 ──
pub fn bolloon_banner() -> Vec<String> {
    vec![
        format!("{C_TEXT}{BOLD}██████╗  ██████╗ ██╗     ██╗      ██████╗  ██████╗ ███╗   ██╗{RESET}"),
        format!("{C_TEXT}{BOLD}██╔══██╗██╔═══██╗██║     ██║     ██╔═══██╗██╔═══██╗████╗  ██║{RESET}"),
        format!("{C_TEXT}{BOLD}██████╔╝██║   ██║██║     ██║     ██║   ██║██║   ██║██╔██╗ ██║{RESET}"),
        format!("{C_TEXT}{BOLD}██╔══██╗██║   ██║██║     ██║     ██║   ██║██║   ██║██║╚██╗██║{RESET}"),
        format!("{C_TEXT}{BOLD}██████╔╝╚██████╔╝███████╗███████╗╚██████╔╝╚██████╔╝██║ ╚████║{RESET}"),
        format!("{C_TEXT}{BOLD}╚═════╝  ╚═════╝ ╚══════╝╚══════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝{RESET}"),
        format!("{C_DIM}Bolloon Agent v{BOLLOON_VERSION}{RESET}"),
    ]
}

/** 窄终端档: 同一套风格的小号艺术字 (装不下大号时用, 保证任何宽度都有字标) */
pub fn bolloon_banner_small() -> Vec<String> {
    vec![
        format!("{C_TEXT}{BOLD} ___  ___  _    _    ___   ___  _  _{RESET}"),
        format!(r"{C_TEXT}{BOLD}| _ )/ _ \| |  | |  / _ \ / _ \| \| |{RESET}"),
        format!(r"{C_TEXT}{BOLD}| _ \ (_) | |__| |_| (_) | (_) | .` |{RESET}"),
        format!(r"{C_TEXT}{BOLD}|___/\___/|____|____\___/ \___/|_|\_|{RESET}"),
    ]
}

/**
 * 按"装得下就上"挑艺术字档: 大(87) → 小(37) → 文字(兜底)。
 * 返回的仍是**原文** (带 ANSI), 宽度判定用 dispWidth。
 */
pub fn pick_banner(inner_width: usize) -> Vec<String> {
    let big = bolloon_banner();
    let big_w = big.iter().map(|l| disp_width(l)).max().unwrap_or(0);
    if big_w <= inner_width {
        return big;
    }
    let small = bolloon_banner_small();
    let small_w = small.iter().map(|l| disp_width(l)).max().unwrap_or(0);
    if small_w <= inner_width {
        return small;
    }
    vec![format!(
        "{C_TEXT}{BOLD}BOLLOON{RESET} {C_DIM}v{BOLLOON_VERSION}{RESET}"
    )]
}

/** 艺术字全部行 (机器人头在左, BOLLOON 艺术字在右), 供框内渲染 */
pub fn brand_art_lines() -> Vec<String> {
    let icon = robot_head();
    let banner = bolloon_banner();
    let gap = 2;
    let icon_w = icon.iter().map(|l| disp_width(l)).max().unwrap_or(1).max(1);
    let rows: Vec<String> = (0..icon.len().max(banner.len()))
        .map(|i| {
            let il = icon.get(i).cloned().unwrap_or_default();
            let bl = banner.get(i).cloned().unwrap_or_default();
            let pad = icon_w.saturating_sub(disp_width(&il));
            format!("{il}{}{bl}", " ".repeat(pad + gap))
        })
        .collect();
    rows
}

pub fn print_banner(version: Option<&str>) {
    // 2026-08-09: 新品牌 logo = 笑脸机器人 (BOLLOON_ICON 自带 BOLLOON 文字),
    //   不再叠加旧 box 字体 banner (避免双 logo)
    println!("{}", bolloon_icon());
    if let Some(v) = version {
        println!("{C_DIM}  Bolloon Agent v{v}{RESET}");
    }
    println!("{C_DIM}  P2P AI Agent · 文档智能体{RESET}");
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 机器人头 6 行, 逐字对齐 TS `ROBOT_HEAD`
    #[test]
    fn robot_head_matches_ts() {
        let h = robot_head();
        assert_eq!(h.len(), 6);
        assert_eq!(h[0], "\x1b[38;2;196;214;64m   ╭───────╮\x1b[0m");
        assert_eq!(
            h[1],
            "\x1b[38;2;196;214;64m ╭─╯\x1b[48;2;196;214;64m  \x1b[38;2;255;255;255m◉\x1b[48;2;196;214;64m \x1b[38;2;255;255;255m◉\x1b[48;2;196;214;64m  \x1b[0m\x1b[38;2;196;214;64m╰─╮\x1b[0m"
        );
        assert_eq!(
            h[5],
            "\x1b[38;2;196;214;64m       │\x1b[0m"
        );
    }

    /// 艺术字档位宽度 —— **真测值** (从 TS 原文逐字搬过来后用 dispWidth 实测):
    /// 大号 **61** 列 / 小号 **37** 列。
    /// 诚实边界: `loading-tui.ts` 的注释里写的是「87 列」, 那是旧稿的估值 ——
    ///   实测 `BOLLOON_BANNER` 可见宽度是 **61** (逐字符 dispWidth 数出来的), 以实测为准。
    #[test]
    fn banner_tiers_have_expected_width() {
        let big = bolloon_banner();
        assert_eq!(big.len(), 7); // 6 行艺术字 + 版本行
        assert_eq!(big.iter().map(|l| disp_width(l)).max().unwrap(), 61);

        let small = bolloon_banner_small();
        assert_eq!(small.len(), 4);
        assert_eq!(small.iter().map(|l| disp_width(l)).max().unwrap(), 37);
    }

    /// 装得下就上: 宽 → 大号; 60 列 → 小号; 20 列 → 文字兜底
    #[test]
    fn pick_banner_falls_back_by_width() {
        assert_eq!(pick_banner(120).len(), 7);
        assert_eq!(pick_banner(60).len(), 4);
        assert_eq!(pick_banner(20).len(), 1);
    }

    /// `brandArtLines`: 机器人头在左 + 2 空格 + 艺术字在右, 行数取两者较大
    #[test]
    fn brand_art_lines_side_by_side() {
        let rows = brand_art_lines();
        assert_eq!(rows.len(), 7); // max(6 头, 7 banner)
        // 每一行 = 头部行 + 填充 + 2 空格 + banner 行
        assert!(rows[0].contains("╭───────╮"));
        assert!(rows[0].contains("██████╗"));
    }

    /// ICON 自带 BOLLOON 字样 (printBanner 用, 不再叠加艺术字)
    #[test]
    fn icon_has_wordmark() {
        let icon = bolloon_icon();
        assert_eq!(icon.lines().count(), 7);
        assert!(icon.contains("BOLLOON"));
    }
}
