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

// ───────────────────────────────────────────────────────────────────────────
// 启动 Dashboard (仿 Hermes Agent 欢迎界面)
//
// 复刻 `src/cli/ink-app.tsx` 的「启动欢迎面板」: 圆角 Unicode 边框 + 左侧 ASCII Logo
// (垂直居中) + 右侧 Tools / MCP / Skills 分区 + 底部状态栏。所有数据从运行时读,
// 按**终端显示列宽**对齐 (CJK 全角算 2 列, 绝不按字符串长度), 可复用、可换数据。
// ───────────────────────────────────────────────────────────────────────────

/// Dashboard 的数据快照 —— 渲染逻辑与此结构**分离**, 换数据不用改布局
pub struct DashboardData {
    pub product: String,
    pub version: String,
    pub build: String,
    pub date: String,
    pub model: String,
    /// 运行目录 (已把 home 折成 ~)
    pub dir: String,
    /// 会话 ID (短)
    pub session_id: String,
    /// 可用工具名 (内置 harness 工具, 真实)
    pub tools: Vec<String>,
    /// MCP 服务名 (无配置则空)
    pub mcp: Vec<String>,
    /// 已学技能名
    pub skills: Vec<String>,
    /// 更新状态描述
    pub update_status: String,
}

fn dash(w: usize) -> String {
    "─".repeat(w)
}

/// 顶栏: `╭─ BOLLOON v0.6.10 · 2026-10-26 · local ──────────╮`
/// 顶栏: `╭─ BOLLOON v0.6.10 · 2026-10-26 · local ──────────╮`
///
/// 标题两侧各留 1 空格, 剩余用横线**对称**填充 (`left_dash + 1 + tw + 1 + right_dash = inner`)。
/// 总长恒为 `inner + 2 = w`, 边框闭合。
fn dash_top(title: &str, w: usize) -> String {
    use crate::width::{disp_width, truncate};
    use crate::theme::{C_ACCENT, C_BORDER_BRIGHT, RESET};
    let inner = w.saturating_sub(2);
    let t = truncate(title, inner.saturating_sub(2));
    let tw = disp_width(&t);
    let total_pad = inner.saturating_sub(tw).saturating_sub(2); // 去掉标题两侧各 1 空格
    let left_dash = total_pad / 2;
    let right_dash = total_pad - left_dash;
    format!(
        "{C_BORDER_BRIGHT}╭{ld} {C_ACCENT}{t}{RESET} {C_BORDER_BRIGHT}{rd}╮{RESET}",
        ld = dash(left_dash),
        rd = dash(right_dash),
    )
}

/// 右列单个分区最多列出几个条目（**压缩显示**）。
///
/// 工具族会一路涨到 186 个 —— 全铺进启动面板会把面板撑爆、也读不出重点。
/// 口径: 只列前 N 个做代表, 其余折叠成一行「…还有 X 个」；
/// **总数在分区标题行仍然是真实的**（压缩的是名字, 不是事实）。
const RIGHT_LIST_MAX: usize = 8;

/// 右列一个分区: 标题（真实总数）+ 压缩后的条目行
fn list_block(title: &str, items: &[String], empty_note: &str) -> Vec<String> {
    use crate::theme::{C_ACCENT, C_DIM, C_MUTED, RESET};
    let mut out = vec![format!(
        "{C_ACCENT}{title}{RESET}  {C_DIM}{}{RESET}",
        items.len()
    )];
    if items.is_empty() {
        out.push(format!("  {C_MUTED}·{RESET} {C_DIM}{empty_note}{RESET}"));
    } else {
        for t in items.iter().take(RIGHT_LIST_MAX) {
            out.push(format!("  {C_MUTED}·{RESET} {t}"));
        }
        let rest = items.len().saturating_sub(RIGHT_LIST_MAX);
        if rest > 0 {
            out.push(format!("  {C_DIM}… 还有 {rest} 个{RESET}"));
        }
    }
    out
}

/// 底栏: `╰──────────────────────────────────────────────╯`
fn dash_bottom(w: usize) -> String {
    use crate::theme::{C_BORDER_BRIGHT, RESET};
    format!("{C_BORDER_BRIGHT}╰{}╯{RESET}", dash(w.saturating_sub(2)))
}


/// 渲染启动 Dashboard, 返回逐行字符串 (含圆角边框与分区)
pub fn render_startup_dashboard(d: &DashboardData) -> Vec<String> {
    use crate::theme::{BOLD, C_ACCENT, C_BORDER_BRIGHT, C_DIM, C_OK, RESET};
    use crate::width::pad_to_width;
    let w = crate::width::term_width().clamp(64, 120);
    let inner = w.saturating_sub(2);
    let sep = 1usize;
    let left_w = ((inner.saturating_sub(sep)) * 2 / 5).max(20).min(40);
    let right_w = inner.saturating_sub(sep).saturating_sub(left_w);

    let mut out: Vec<String> = Vec::new();

    // ── 框**上面**先放品牌艺术字 (leo 2026-10-27: 「bolloon 艺术字没在终端出现, 放在框上面」) ──
    // 宽度不够时 `pick_banner` 自动降档 (大 → 小 → 文字), 绝不折行。
    for art in pick_banner(w) {
        let lw = crate::width::disp_width(&art);
        let left = w.saturating_sub(lw) / 2;
        // 左右都补到**正好 w 列**: 只补左边会让艺术字行比框窄 2 列 (面板右边缘参差)
        out.push(format!(
            "{}{}{}",
            " ".repeat(left),
            art,
            " ".repeat(w.saturating_sub(lw).saturating_sub(left))
        ));
    }
    // 空行也按 w 列占位: 面板是"宽度恒定"的矩形, 空行窄了右边就参差
    out.push(" ".repeat(w));

    let title = format!("{} v{} · {} · {}", d.product, d.version, d.date, d.build);
    out.push(dash_top(&title, w));

    // ── 左列: 机器人头 + 字标 + 标语 (垂直居中靠后面补空行) ──
    let mut left: Vec<String> = robot_head();
    left.push(format!("{C_ACCENT}{BOLD}     BOLLOON{RESET}"));
    left.push(format!("{C_DIM}  Bolloon Agent{RESET}"));
    left.push(format!("{C_DIM}  P2P AI Agent · 文档智能体{RESET}"));

    // ── 右列: Tools / MCP / Skills 三个分区 ──
    let mut right: Vec<String> = Vec::new();
    // 三个分区统一压缩显示（总数真实, 名字不全铺 —— 工具族会涨到 186）
    right.extend(list_block("Available Tools", &d.tools, "无"));
    right.extend(list_block("MCP Servers", &d.mcp, "未配置 (按 mcp.json 加载)"));
    right.extend(list_block(
        "Available Skills",
        &d.skills,
        "暂无 (对话中自动蒸馏)",
    ));

    // 垂直居中: 较短的一列在上/下各补一半空行, 使两列视觉同轴
    let rows = left.len().max(right.len());
    let pad_top_l = (rows - left.len()) / 2;
    let pad_top_r = (rows - right.len()) / 2;
    let blank_l = pad_to_width("", left_w);
    let blank_r = pad_to_width("", right_w);
    for i in 0..rows {
        let l = if i < pad_top_l {
            blank_l.clone()
        } else {
            left.get(i - pad_top_l).cloned().unwrap_or_else(|| blank_l.clone())
        };
        let r = if i < pad_top_r {
            blank_r.clone()
        } else {
            right.get(i - pad_top_r).cloned().unwrap_or_else(|| blank_r.clone())
        };
        out.push(format!(
            "{C_BORDER_BRIGHT}│{RESET}{}{C_BORDER_BRIGHT}│{RESET}{}{C_BORDER_BRIGHT}│{RESET}",
            pad_to_width(&l, left_w),
            pad_to_width(&r, right_w),
        ));
    }

    // ── 底部状态栏 ──
    let status = format!(
        "model {model} · {dir} · #{sid} · tools {tn} · skills {sk} · {upd}",
        model = d.model,
        dir = d.dir,
        sid = d.session_id,
        tn = d.tools.len(),
        sk = d.skills.len(),
        upd = d.update_status,
    );
    out.push(format!(
        "{C_BORDER_BRIGHT}│ {RESET}{}{C_BORDER_BRIGHT} │{RESET}",
        pad_to_width(&status, inner.saturating_sub(2)),
    ));
    out.push(dash_bottom(w));

    // 框外 Welcome 提示
    out.push(format!(
        "{C_OK}▸ Ready.{RESET} {C_DIM}输入消息开始对话 (Enter 发送 · /help 看命令){RESET}"
    ));
    out
}


#[cfg(test)]
mod tests {
    use super::*;

    /// 直接渲染 Dashboard (不走 pty, 真实 UTF-8) 验证每行显示宽度恒等于终端宽
    #[test]
    fn dashboard_width_is_constant() {
        crate::width::set_term_size(64, 30);
        let d = DashboardData {
            product: "BOLLOON".into(),
            version: "0.6.10".into(),
            build: "local".into(),
            date: "2026-10-26".into(),
            model: "kimi-k3".into(),
            dir: "~/chat".into(),
            session_id: "20261026".into(),
            tools: vec!["read_file".into(), "shell".into()],
            mcp: vec![],
            skills: vec![],
            update_status: "本地构建".into(),
        };
        let lines = render_startup_dashboard(&d);
        for (i, l) in lines.iter().enumerate() {
            let w = crate::width::disp_width(l);
            if i < lines.len() - 1 {
                // 倒数第 1 行是框外 Welcome, 不锁宽
                assert_eq!(w, 64, "row {i} width={w}: {l:?}");
            }
        }
        crate::width::clear_term_size();
    }

    /// **压缩显示**: 工具多了不全铺 —— 只列前 8 个 + 「…还有 N 个」;
    /// 但分区标题的**总数仍是真实的**（压缩的是名字, 不是事实），且行宽仍恒定。
    #[test]
    fn tools_list_is_compressed_but_count_is_true() {
        crate::width::set_term_size(64, 40);
        let tools: Vec<String> = (0..20).map(|i| format!("tool_{i}")).collect();
        let d = DashboardData {
            product: "BOLLOON".into(),
            version: "0.6.10".into(),
            build: "local".into(),
            date: "2026-10-27".into(),
            model: "kimi-k3".into(),
            dir: "~/chat".into(),
            session_id: "20261027".into(),
            tools,
            mcp: vec![],
            skills: vec![],
            update_status: "本地构建".into(),
        };
        let lines = render_startup_dashboard(&d);

        // 总数真实（不许把 20 压成 8 来"看起来少"）
        let head = lines
            .iter()
            .find(|l| l.contains("Available Tools"))
            .expect("应有分区标题行");
        assert!(head.contains("20"), "总数必须为真: {head:?}");

        // 只列前 8 个代表, 其余折叠
        let flat = lines.join("\n");
        assert!(flat.contains("tool_0") && flat.contains("tool_7"), "前 8 个应列出");
        assert!(flat.contains("还有 12 个"), "应折叠 12 个: {flat}");
        assert!(!flat.contains("tool_8"), "第 9 个起不该全铺: {flat}");

        // 压缩不该破坏行宽恒定
        for (i, l) in lines.iter().enumerate() {
            if i < lines.len() - 1 {
                assert_eq!(crate::width::disp_width(l), 64, "row {i} width: {l:?}");
            }
        }
        crate::width::clear_term_size();
    }

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
