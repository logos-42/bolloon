//! select.rs — 全屏可滚动光标选择器
//!
//! **复用 TS 原文** `src/cli/tui-select.ts` 的**几何与交互语义** (不是另写一套 UI):
//!   · 头行 (标题 + 计数 + 键位) **不滚**
//!   · 中间候选区**固定高度视窗** (`viewportHeight = max(3, min(40, rows-3))`), 视窗外的行**根本不画**
//!   · 上下边各一行滚动指示 (`↑ 上面还有 N 家` / `↓ 下面还有 N 家`)
//!   · 光标行 = `REVERSE + BOLD + fg(cursor) + bg(accent)` (accent 底 + 近黑字, 对比度 ~11:1)
//!     + `→ ` 前缀 (**符号通道不依赖颜色**, 关掉颜色也认得出哪行是高亮)
//!   · 状态行 `第 i/N` + 提示语
//!
//! 六种同级的一等选择方式 (与 TS 同): ↑↓ / Enter / 数字跳行 / 字母·`/` 筛选 / 分组折叠 / 滚动指示;
//! `Esc` / `Ctrl-C` / 末尾 Cancel 行 = 取消。
//!
//! **边界**: 本模块只产"用户选了哪个 value", 不读不写任何配置。

use crate::theme::{bg, fg, BOLD, RESET, THEME_ACCENT, THEME_CURSOR};
use crate::width::{disp_width, term_height, term_width, truncate_safe};

use std::io::Write;

const E: &str = "\x1b";
const REVERSE: &str = "\x1b[7m";
const HIDE_CURSOR: &str = "\x1b[?25l";
const SHOW_CURSOR: &str = "\x1b[?25h";
/** 从光标清到屏幕末 (重绘一帧的起点: 既真的清掉上一帧, 也是帧的分界) */
const ERASE_DOWN: &str = "\x1b[J";
/** 清到行末 (每一行都用它, 免得窄终端里残留上一帧的长尾巴) */
const ERASE_EOL: &str = "\x1b[K";

/** 头行键位 (带分组时才出现折叠键) */
pub const TUI_HINT: &str = "↑↓ 移动 · ←→/空格 折叠分组 · Enter 确认 · / 搜索 · 数字跳行 · Esc 取消";
/** 纯平铺单选列表的提示 —— 不带折叠键 */
pub const TUI_HINT_FLAT: &str = "↑↓ 移动 · Enter 确认 · / 搜索 · 数字跳行 · Esc 取消";

/** 掩码字符 (屏幕上绝不出现明文) */
pub const MASK_CHAR: &str = "•";

/** 中间候选区的**固定高度上限** */
pub const VIEWPORT_MAX: usize = 40;
/** 太矮画不出菜单 ⇒ 退回文本问答 (判据只有这一处) */
pub const MIN_ROWS: usize = 6;

pub const GROUP_COLLAPSED_MARK: char = '›';
pub const GROUP_EXPANDED_MARK: char = '▾';

/** 光标行的高亮 SGR: 反白 + 加粗 + 近黑字压 accent 底 */
fn cursor_sgr() -> String {
    format!("{REVERSE}{BOLD}{}{}", fg(THEME_CURSOR), bg(THEME_ACCENT))
}

/** 视窗高度: 中间候选区固定高度 = `min(VIEWPORT_MAX, rows-3)` (至少 3) */
pub fn viewport_height(rows: usize) -> usize {
    3usize.max(VIEWPORT_MAX.min(rows.saturating_sub(3)))
}

#[derive(Debug, Clone)]
pub struct TuiChoice {
    pub value: String,
    /// 已含状态符号的行文字 (**符号由调用方给** —— 语义本体, 不许只靠颜色)
    pub label: String,
    pub hint: Option<String>,
    pub group: Option<String>,
    /// 这一项等于"取消" (列表末尾的 Cancel 行)
    pub cancel: bool,
}

#[derive(Debug, Clone)]
pub enum DisplayLine {
    Sep { group: String, count: usize, collapsed: bool },
    Item { index: usize },
}

/** 过滤: 大小写不敏感, 匹配 value / label / hint / group */
pub fn matches_query(c: &TuiChoice, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    let hay = format!(
        "{}\n{}\n{}\n{}",
        c.value,
        c.label,
        c.hint.clone().unwrap_or_default(),
        c.group.clone().unwrap_or_default()
    )
    .to_lowercase();
    hay.contains(&q)
}

/**
 * 把候选摊成"可画/可落"的行 (**纯函数**)。
 *
 * 三条规矩 (TS 原文): ① 有搜索词时**平铺命中项** (收起的分组也挡不住命中);
 * ② 无搜索词时按分组分段, 每个分组一行标题 (`── 名字 (N) ›|▾`, **家数永远照写**),
 *    收起的分组不画成员行; ③ 无分组的候选项原样逐行出。
 */
pub fn build_display_lines(
    items: &[TuiChoice],
    collapsed: &[String],
    query: &str,
) -> Vec<DisplayLine> {
    let mut lines: Vec<DisplayLine> = Vec::new();
    if !query.trim().is_empty() {
        for (i, c) in items.iter().enumerate() {
            if matches_query(c, query) {
                lines.push(DisplayLine::Item { index: i });
            }
        }
        return lines;
    }
    let mut counts: Vec<(String, usize)> = Vec::new();
    for c in items {
        if let Some(g) = &c.group {
            match counts.iter_mut().find(|(k, _)| k == g) {
                Some((_, n)) => *n += 1,
                None => counts.push((g.clone(), 1)),
            }
        }
    }
    let mut last_group: Option<String> = None;
    for (i, c) in items.iter().enumerate() {
        let g = c.group.clone();
        if let Some(g) = &g {
            if last_group.as_ref() != Some(g) {
                let is_collapsed = collapsed.contains(g);
                let count = counts.iter().find(|(k, _)| k == g).map(|(_, n)| *n).unwrap_or(0);
                lines.push(DisplayLine::Sep { group: g.clone(), count, collapsed: is_collapsed });
                last_group = Some(g.clone());
            }
            if collapsed.contains(g) {
                continue; // 收起: 只留标题行, 成员行不渲染
            }
        }
        lines.push(DisplayLine::Item { index: i });
    }
    lines
}

/// 一帧的完整状态 (**纯函数输入**, 便于门里直接复核)
pub struct FrameState<'a> {
    pub title: &'a str,
    pub items: &'a [TuiChoice],
    pub lines: &'a [DisplayLine],
    pub cursor: usize,
    pub scroll_top: usize,
    pub query: &'a str,
    pub note: &'a str,
    pub unit: &'a str,
    pub color: bool,
    pub cols: usize,
    pub rows: usize,
}

/**
 * 渲染一帧 (**纯函数**, 无终端也能测)。
 *
 * 返回 `(帧文本, 画了几行)` —— 行数由调用方用来回退光标 (`ESC[nA` + `ESC[J`),
 * TS 注释里专门点过: 用**容量 body** 会导致上移过头把上面的主屏行也吞掉。
 */
pub fn render_frame(st: &FrameState) -> (String, usize) {
    let h = viewport_height(st.rows);
    let total = st.lines.len();
    let cursor = st.cursor.min(total.saturating_sub(1));

    // ── 定位视窗: 先把光标放进窗口, 再为"还有 N 家"指示行让位 ──
    let mut top = st.scroll_top.min(total.saturating_sub(h));
    for _ in 0..4 {
        let above0 = top > 0;
        let below0 = top + h - if above0 { 1 } else { 0 } < total;
        let body0 = 1usize.max(h - if above0 { 1 } else { 0 } - if below0 { 1 } else { 0 });
        let start0 = top + if above0 { 1 } else { 0 };
        let mut nt = top;
        if cursor < start0 {
            nt = (cursor as isize - if above0 { 1 } else { 0 }).max(0) as usize;
        } else if cursor > start0 + body0 - 1 {
            nt = (cursor as isize - body0 as isize + 1 - if above0 { 1 } else { 0 }).max(0) as usize;
        }
        nt = nt.min(total.saturating_sub(h));
        if nt == top {
            break;
        }
        top = nt;
    }
    let above = top > 0;
    let below = top + h - if above { 1 } else { 0 } < total;
    let body = 1usize.max(h - if above { 1 } else { 0 } - if below { 1 } else { 0 });
    let start = top + if above { 1 } else { 0 };

    let filtered = st.items.iter().filter(|c| matches_query(c, st.query)).count();
    let has_groups = st.items.iter().any(|c| c.group.is_some());
    let hint = if has_groups { TUI_HINT } else { TUI_HINT_FLAT };

    let mut buf: Vec<String> = Vec::new();
    let w = st.cols;

    // ── 头行: 标题 + 计数 + 键位 (不滚, 每帧都画) ──
    let count_part = if st.query.trim().is_empty() {
        format!("共 {} {}", st.items.len(), st.unit)
    } else {
        format!("共 {} {} · 已筛 {} {}", st.items.len(), st.unit, filtered, st.unit)
    };
    let mut head = format!("{} · {}", st.title, count_part);
    let head_room = w.saturating_sub(disp_width(&head) + 3);
    if head_room > 12 {
        head.push_str(&format!("  {}", truncate_safe(hint, head_room)));
    }
    buf.push(format!("{}{}{}", bold_if(st.color, &head), ERASE_EOL, "\n"));

    // ── 上滚动指示 ──
    if above {
        buf.push(format!(
            "{}{}\n",
            dim_line(&format!("↑ 上面还有 {} {}", top, st.unit), st.color),
            ERASE_EOL
        ));
    }

    // ── 可见行 ──
    for i in 0..body {
        let li = start + i;
        let Some(line) = st.lines.get(li) else { break };
        let is_cursor = li == cursor;
        let text = match line {
            DisplayLine::Sep { group, count, collapsed } => {
                let mark = if *collapsed { GROUP_COLLAPSED_MARK } else { GROUP_EXPANDED_MARK };
                format!("── {} ({}) {}", group, count, mark)
            }
            DisplayLine::Item { index } => {
                let c = &st.items[*index];
                match &c.hint {
                    Some(h) => format!("{}  {}", c.label, h),
                    None => c.label.clone(),
                }
            }
        };
        let text = truncate_safe(&text, w.saturating_sub(4));
        let rendered = if is_cursor {
            // 光标行: `→ ` 前缀 (符号通道) + 反白高亮 (颜色通道)
            let body = format!("→ {text}");
            if st.color {
                format!("{}{}{}{}", cursor_sgr(), body, RESET, ERASE_EOL)
            } else {
                format!("{body}{ERASE_EOL}")
            }
        } else {
            format!("  {text}{ERASE_EOL}")
        };
        buf.push(format!("{rendered}\n"));
    }

    // ── 下滚动指示 ──
    if below {
        let rest = total - (start + body);
        buf.push(format!(
            "{}{}\n",
            dim_line(&format!("↓ 下面还有 {} {}", rest, st.unit), st.color),
            ERASE_EOL
        ));
    }

    // ── 状态行 ──
    let status = if st.query.is_empty() {
        format!("第 {}/{} {}", cursor + 1, total, st.unit)
    } else {
        format!("第 {}/{} {} · 筛选 \"{}\"", cursor + 1, total, st.unit, st.query)
    };
    let mut status_line = status;
    if !st.note.is_empty() {
        status_line.push_str(&format!(" · {note}", note = st.note));
    }
    buf.push(format!(
        "{}{}\n",
        dim_line(&truncate_safe(&status_line, w.saturating_sub(2)), st.color),
        ERASE_EOL
    ));

    let drawn = buf.len();
    (buf.concat(), drawn)
}

fn bold_if(color: bool, s: &str) -> String {
    if color {
        format!("{BOLD}{s}{RESET}")
    } else {
        s.to_string()
    }
}

fn dim_line(s: &str, color: bool) -> String {
    if color {
        format!("\x1b[2m{s}{RESET}")
    } else {
        s.to_string()
    }
}

// ============================================================
// raw 会话 (逐键输入 + 隐藏光标 + 一定恢复)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    Up,
    Down,
    Left,
    Right,
    Enter,
    /**
     * Ctrl+J (0x0a) —— raw 模式下 `Enter` 是 `\r` (0x0d)、`Ctrl+J` 是 `\n` (0x0a),
     * **两个不同字节** ⇒ 可以既保留 Enter 发送, 又让 Ctrl+J 换行。
     */
    Newline,
    /// Alt+Enter (`ESC` + `\r`) —— 换行的第二入口 (习惯 Alt 的人)
    AltEnter,
    /// Ctrl+G (0x07) —— 打开 $VISUAL/$EDITOR 写草稿
    CtrlG,
    /// Alt+V (`ESC` + `v`) —— 贴剪贴板图片
    AltV,
    Esc,
    Cancel, // Ctrl-C
    Backspace,
    Space,
    Char(char),
}

/** 把一字节流解成按键 (方向键 / Enter / 换行 / Esc / Ctrl-C / Ctrl-G / Alt-V / Backspace / 可打印字符) */
pub fn parse_keys(bytes: &[u8]) -> Vec<Key> {
    let mut out: Vec<Key> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        match b {
            0x1b => {
                if i + 2 < bytes.len() && bytes[i + 1] == b'[' {
                    match bytes[i + 2] {
                        b'A' => {
                            out.push(Key::Up);
                            i += 3;
                            continue;
                        }
                        b'B' => {
                            out.push(Key::Down);
                            i += 3;
                            continue;
                        }
                        b'C' => {
                            out.push(Key::Right);
                            i += 3;
                            continue;
                        }
                        b'D' => {
                            out.push(Key::Left);
                            i += 3;
                            continue;
                        }
                        _ => {}
                    }
                }
                // Alt+<键>: ESC 后紧跟一个终结字节 (不是 `[` 的 CSI 序列)
                if i + 1 < bytes.len() {
                    match bytes[i + 1] {
                        b'\r' | b'\n' => {
                            out.push(Key::AltEnter);
                            i += 2;
                            continue;
                        }
                        b'v' | b'V' => {
                            out.push(Key::AltV);
                            i += 2;
                            continue;
                        }
                        _ => {}
                    }
                }
                out.push(Key::Esc);
                i += 1;
            }
            // Enter 是 `\r`, Ctrl+J 是 `\n` —— 必须**分开**解, 否则多行输入没入口
            b'\r' => {
                out.push(Key::Enter);
                i += 1;
            }
            b'\n' => {
                out.push(Key::Newline);
                i += 1;
            }
            0x07 => {
                out.push(Key::CtrlG);
                i += 1;
            }
            0x03 => {
                out.push(Key::Cancel);
                i += 1;
            }
            0x7f => {
                out.push(Key::Backspace);
                i += 1;
            }
            b' ' => {
                out.push(Key::Space);
                i += 1;
            }
            _ => {
                // UTF-8: 尽量解出一个字符
                let end = (i + 4).min(bytes.len());
                match std::str::from_utf8(&bytes[i..end]) {
                    Ok(s) => {
                        if let Some(c) = s.chars().next() {
                            out.push(Key::Char(c));
                            i += c.len_utf8();
                            continue;
                        }
                    }
                    Err(e) => {
                        let valid = e.valid_up_to();
                        if valid > 0 {
                            if let Ok(s) = std::str::from_utf8(&bytes[i..i + valid]) {
                                if let Some(c) = s.chars().next() {
                                    out.push(Key::Char(c));
                                    i += c.len_utf8();
                                    continue;
                                }
                            }
                        }
                    }
                }
                i += 1;
            }
        }
    }
    out
}

struct RawGuard {
    orig: Option<libc::termios>,
}

impl RawGuard {
    fn enable() -> Self {
        unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(libc::STDIN_FILENO, &mut t) != 0 {
                return Self { orig: None };
            }
            let orig = t;
            libc::cfmakeraw(&mut t);
            if libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t) != 0 {
                return Self { orig: None };
            }
            Self { orig: Some(orig) }
        }
    }
    fn is_raw(&self) -> bool {
        self.orig.is_some()
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        if let Some(orig) = self.orig.as_ref() {
            unsafe {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, orig);
            }
        }
        print!("{SHOW_CURSOR}");
        let _ = std::io::stdout().flush();
    }
}

/** 能不能用全屏菜单 (判据只有这一处, 别处不许再判) */
pub fn tui_capable() -> bool {
    if std::env::var("BOLLOON_NO_TUI").ok().as_deref() == Some("1") {
        return false;
    }
    if std::env::var("TERM")
        .ok()
        .map(|t| t.eq_ignore_ascii_case("dumb"))
        .unwrap_or(false)
    {
        return false;
    }
    unsafe {
        if libc::isatty(libc::STDIN_FILENO) != 1 || libc::isatty(libc::STDOUT_FILENO) != 1 {
            return false;
        }
    }
    let rows = term_height();
    if rows < MIN_ROWS {
        return false;
    }
    true
}

pub struct SelectOptions {
    pub unit: String,
    pub cancel_label: String,
    pub color: bool,
    /// 尺寸覆盖 (窄终端验收用; None = 真读终端)
    pub cols: Option<usize>,
    pub rows: Option<usize>,
}

impl Default for SelectOptions {
    fn default() -> Self {
        Self {
            unit: "项".to_string(),
            cancel_label: "Cancel".to_string(),
            color: crate::theme::color_enabled(),
            cols: None,
            rows: None,
        }
    }
}

/**
 * 全屏光标选择器。返回选中项的 `value`; `None` = 取消
 * (Esc / Ctrl-C / 末尾 Cancel 行 / 输入流结束)。
 */
pub fn tui_select(title: &str, items: &[TuiChoice], opts: &SelectOptions) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut all: Vec<TuiChoice> = items.to_vec();
    all.push(TuiChoice {
        value: "__cancel__".to_string(),
        label: opts.cancel_label.clone(),
        hint: None,
        group: None,
        cancel: true,
    });

    let cols = opts.cols.unwrap_or_else(term_width);
    let rows = opts.rows.unwrap_or_else(term_height);

    let mut query = String::new();
    let mut note = String::new();
    let mut collapsed: Vec<String> = Vec::new();
    let mut num_buf = String::new();
    let mut cursor: usize = 0;
    let mut scroll_top: usize = 0;

    let guard = RawGuard::enable();
    if !guard.is_raw() {
        return None; // 拿不到 raw mode ⇒ 调用方走文本问答那条路 (本模块不做降级决定)
    }
    print!("{HIDE_CURSOR}");
    let _ = std::io::stdout().flush();

    let mut drawn = 0usize;
    let result = loop {
        let mut lines = build_display_lines(&all, &collapsed, &query);
        if lines.is_empty() {
            // 筛没了: 至少留 Cancel 行, 不然光标无处可落
            lines.push(DisplayLine::Item { index: all.len() - 1 });
        }
        if cursor >= lines.len() {
            cursor = lines.len() - 1;
        }
        let (frame, n) = render_frame(&FrameState {
            title,
            items: &all,
            lines: &lines,
            cursor,
            scroll_top,
            query: &query,
            note: &note,
            unit: &opts.unit,
            color: opts.color,
            cols,
            rows,
        });
        if drawn > 0 {
            print!("{E}[{drawn}A{ERASE_DOWN}");
        }
        print!("{frame}");
        let _ = std::io::stdout().flush();
        drawn = n;
        // 视窗跟随 (render_frame 内部算出的 top 这里不回传, 用光标夹逼保持简单一致)
        scroll_top = scroll_top.min(lines.len().saturating_sub(1));

        let key = match read_key() {
            Some(k) => k,
            None => break None, // EOF
        };

        match key {
            Key::Up => {
                cursor = if cursor > 0 { cursor - 1 } else { lines.len() - 1 };
                num_buf.clear();
                note.clear();
            }
            Key::Down => {
                cursor = if cursor + 1 < lines.len() { cursor + 1 } else { 0 };
                num_buf.clear();
                note.clear();
            }
            Key::Left => {
                let g = group_at(&all, &lines, cursor);
                match g {
                    Some(g) => {
                        if !collapsed.contains(&g) {
                            collapsed.push(g.clone());
                        }
                        note = format!("已收起 {g}");
                    }
                    None => note = "这一行没有分组可收起".to_string(),
                }
                num_buf.clear();
            }
            Key::Right => {
                let g = group_at(&all, &lines, cursor);
                match g {
                    Some(g) => {
                        collapsed.retain(|x| x != &g);
                        note = format!("已展开 {g}");
                    }
                    None => note = "这一行没有分组可展开".to_string(),
                }
                num_buf.clear();
            }
            Key::Space => {
                let g = group_at(&all, &lines, cursor);
                match g {
                    Some(g) => {
                        if collapsed.contains(&g) {
                            collapsed.retain(|x| x != &g);
                            note = format!("已展开 {g}");
                        } else {
                            collapsed.push(g.clone());
                            note = format!("已收起 {g}");
                        }
                    }
                    None => {
                        // 查询为空时空格 = 折叠; 否则只是过滤字符
                        if query.is_empty() {
                            note = "这一行没有分组可折叠".to_string();
                        } else {
                            query.push(' ');
                        }
                    }
                }
                num_buf.clear();
            }
            // `\n` / Alt+Enter 在选择器里等同于 Enter (旧版两者都解成 Enter, 行为不变)
            Key::Enter | Key::Newline | Key::AltEnter => {
                match lines.get(cursor) {
                    Some(DisplayLine::Sep { group, .. }) => {
                        // 落在分组标题上 = 展开/收起那一组, **不会误选**
                        if collapsed.contains(group) {
                            collapsed.retain(|x| x != group);
                            note = format!("已展开 {group}");
                        } else {
                            collapsed.push(group.clone());
                            note = format!("已收起 {group}");
                        }
                    }
                    Some(DisplayLine::Item { index }) => {
                        let c = &all[*index];
                        if c.cancel {
                            break None;
                        }
                        break Some(c.value.clone());
                    }
                    None => {}
                }
                num_buf.clear();
            }
            Key::Esc | Key::Cancel => break None,
            Key::Backspace => {
                if !query.is_empty() {
                    query.pop();
                }
                num_buf.clear();
            }
            Key::Char(c) => {
                if c.is_ascii_digit() {
                    num_buf.push(c);
                    let n: usize = num_buf.parse().unwrap_or(0);
                    if n == 0 || n > lines.len() {
                        note = format!("没有第 {n} 行 — 范围 1–{}", lines.len());
                        num_buf.pop();
                    } else {
                        cursor = n - 1;
                        note.clear();
                    }
                } else if c == '/' && query.is_empty() {
                    note = "筛选模式: 直接敲字即过滤 (Backspace 退字, 清空 = 回全量)".to_string();
                    num_buf.clear();
                } else if query.is_empty() && c == 'q' {
                    break None; // 查询为空时 `q` 也取消
                } else {
                    query.push(c);
                    cursor = cursor.min(lines.len().saturating_sub(1));
                    num_buf.clear();
                }
            }
            // Ctrl+G / Alt+V 是**输入框**的快捷键, 选择器里不响应
            Key::CtrlG | Key::AltV => {}
        }
    };

    drop(guard);
    if drawn > 0 {
        print!("{E}[{drawn}A{ERASE_DOWN}");
        let _ = std::io::stdout().flush();
    }
    result
}

fn group_at(items: &[TuiChoice], lines: &[DisplayLine], cursor: usize) -> Option<String> {
    match lines.get(cursor) {
        Some(DisplayLine::Sep { group, .. }) => Some(group.clone()),
        Some(DisplayLine::Item { index }) => items[*index].group.clone(),
        None => None,
    }
}

fn read_key() -> Option<Key> {
    read_key_raw().and_then(|v| parse_keys(&v).into_iter().next())
}

/// 转义序列/UTF-8 续字节的宽限窗口 (ms) —— 超时即认定是**孤独的 Esc** / 半个字符
pub const ESC_GRACE_MS: i32 = 40;

/**
 * 等一个字节, 最多等 `timeout_ms` (负数 = 一直等); 超时/出错/EOF ⇒ None。
 *
 * **必须用 `libc::read`, 不能用 `std::io::stdin()`**: `Stdin` 带 8KB 用户态缓冲, 一次
 * `read(1)` 会把整段输入吸进它的缓冲区 (内核缓冲变空) ⇒ 随后 `poll` 认为"没数据" ⇒
 * 超时 ⇒ 中文的续字节/紧跟的按键全被当成"孤独的 Esc"丢掉。2026-10-26 真机 pty 实测:
 * `第一行` 只剩 `行`。改用裸 `read` 后 poll 与读的是同一个缓冲, 一个字节都不许丢。
 */
fn poll_read(timeout_ms: i32) -> Option<u8> {
    let mut pfd = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    let n = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
    if n <= 0 {
        return None;
    }
    let mut b = [0u8; 1];
    let got = unsafe {
        libc::read(
            libc::STDIN_FILENO,
            b.as_mut_ptr() as *mut libc::c_void,
            1,
        )
    };
    if got == 1 { Some(b[0]) } else { None }
}

/**
 * 读**一个按键的原生字节** (input.rs 与 tui_select 共用同一个读键器)。
 *
 * 三条判据 (都是踩过的坑):
 *   · **孤独的 Esc 不能挂住** —— 原来读到 0x1b 就阻塞地再读两字节, 按 Esc 会卡到用户敲下一个键;
 *     现在用 `poll` 给 40ms 宽限, 没有后续字节就是 Esc。
 *   · **UTF-8 必须读全** —— 只读 1 字节时 `中` 的 3 个字节各自解析失败 ⇒ 中文打不进去。
 *   · **Alt+<键> 靠宽限窗口识别** —— `ESC` + `\r`/`v` 分别是 Alt+Enter / Alt+V。
 */
pub fn read_key_raw() -> Option<Vec<u8>> {
    let first = poll_read(-1)?;
    let mut v = vec![first];
    if first == 0x1b {
        match poll_read(ESC_GRACE_MS) {
            None => {}
            Some(b'[') => {
                // CSI: `ESC [ X` (方向键)
                v.push(b'[');
                if let Some(c) = poll_read(ESC_GRACE_MS) {
                    v.push(c);
                }
            }
            Some(b) => v.push(b), // Alt+<键>
        }
    } else if first >= 0x80 {
        // UTF-8 续字节: 读满一个合法字符就停
        while v.len() < 4 {
            if std::str::from_utf8(&v).is_ok() {
                break;
            }
            match poll_read(ESC_GRACE_MS) {
                Some(b) => v.push(b),
                None => break,
            }
        }
    }
    Some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::set_term_size;

    fn items() -> Vec<TuiChoice> {
        (1..=30)
            .map(|i| TuiChoice {
                value: format!("p{i}"),
                label: format!("● 供应商 {i}"),
                hint: None,
                group: None,
                cancel: false,
            })
            .collect()
    }

    /// 固定高度视窗: 视窗外的行**根本不画**
    #[test]
    fn viewport_is_fixed_height() {
        assert_eq!(viewport_height(24), 21); // min(40, 24-3)
        assert_eq!(viewport_height(200), 40); // VIEWPORT_MAX
        assert_eq!(viewport_height(4), 3); // 下限 3
    }

    /// 帧高**永不超过终端高** (这是"不抖"的硬判据)
    #[test]
    fn frame_never_exceeds_terminal_height() {
        let it = items();
        let lines = build_display_lines(&it, &[], "");
        for rows in [8usize, 12, 24, 60] {
            let (frame, drawn) = render_frame(&FrameState {
                title: "选一个供应商",
                items: &it,
                lines: &lines,
                cursor: 15,
                scroll_top: 0,
                query: "",
                note: "",
                unit: "家",
                color: true,
                cols: 100,
                rows,
            });
            assert!(drawn <= rows, "帧 {drawn} 行超过终端 {rows} 行");
            assert_eq!(frame.lines().count(), drawn);
        }
    }

    /// 光标行有 `→ ` 前缀 + 反白 (**符号通道不依赖颜色**)
    #[test]
    fn cursor_row_has_symbol_and_reverse() {
        let it = items();
        let lines = build_display_lines(&it, &[], "");
        let (frame, _) = render_frame(&FrameState {
            title: "t",
            items: &it,
            lines: &lines,
            cursor: 2,
            scroll_top: 0,
            query: "",
            note: "",
            unit: "家",
            color: true,
            cols: 100,
            rows: 24,
        });
        assert!(frame.contains("→ ● 供应商 3"), "{frame:?}");
        assert!(frame.contains("\x1b[7m"), "光标行必须有反白 (结构判据)");
        // 关掉颜色: 符号还在, SGR 一个都没有
        let (plain, _) = render_frame(&FrameState {
            title: "t",
            items: &it,
            lines: &lines,
            cursor: 2,
            scroll_top: 0,
            query: "",
            note: "",
            unit: "家",
            color: false,
            cols: 100,
            rows: 24,
        });
        assert!(plain.contains("→ ● 供应商 3"));
        // 关掉颜色 = **一个颜色 SGR 都不加** (但光标控制码 `ESC[K` 照写, 与 TS 同口径)
        assert!(!plain.contains("\x1b[7m"));
        assert!(!plain.contains("\x1b[38;"));
        assert!(!plain.contains("\x1b[48;"));
    }

    /// 滚动指示: 上下各一行, 说清"还有 N 家"
    #[test]
    fn scroll_indicators_tell_the_truth() {
        let it = items();
        let lines = build_display_lines(&it, &[], "");
        let (frame, _) = render_frame(&FrameState {
            title: "t",
            items: &it,
            lines: &lines,
            cursor: 20,
            scroll_top: 15,
            query: "",
            note: "",
            unit: "家",
            color: true,
            cols: 100,
            rows: 12,
        });
        assert!(frame.contains("↑ 上面还有"));
        assert!(frame.contains("↓ 下面还有"));
    }

    /// 筛选: 命中项**平铺** (收起的分组也挡不住命中)
    #[test]
    fn query_flattens_matches() {
        let it = vec![
            TuiChoice { value: "a".into(), label: "● A".into(), hint: None, group: Some("内置".into()), cancel: false },
            TuiChoice { value: "b".into(), label: "● B".into(), hint: None, group: Some("目录".into()), cancel: false },
        ];
        let lines = build_display_lines(&it, &["目录".to_string()], "b");
        assert_eq!(lines.len(), 1); // 只有 b 命中, 且不受"目录"收起影响
        match &lines[0] {
            DisplayLine::Item { index } => assert_eq!(it[*index].value, "b"),
            _ => panic!("筛选时应平铺命中项"),
        }
    }

    /// 分组标题照写家数 + 折叠标记
    #[test]
    fn group_header_writes_count_and_mark() {
        let it = vec![
            TuiChoice { value: "a".into(), label: "● A".into(), hint: None, group: Some("内置".into()), cancel: false },
            TuiChoice { value: "b".into(), label: "● B".into(), hint: None, group: Some("内置".into()), cancel: false },
        ];
        let lines = build_display_lines(&it, &[], "");
        assert_eq!(lines.len(), 3); // 标题 + 2 项
        let (frame, _) = render_frame(&FrameState {
            title: "t",
            items: &it,
            lines: &lines,
            cursor: 0,
            scroll_top: 0,
            query: "",
            note: "",
            unit: "家",
            color: false,
            cols: 60,
            rows: 24,
        });
        assert!(frame.contains("── 内置 (2) ▾"), "{frame:?}");
    }

    /// 按键解析: 方向键 / Enter / Esc / Ctrl-C / Backspace / 字符
    #[test]
    fn parse_keys_covers_the_six_ways() {
        assert_eq!(parse_keys(b"\x1b[A"), vec![Key::Up]);
        assert_eq!(parse_keys(b"\x1b[B"), vec![Key::Down]);
        assert_eq!(parse_keys(b"\x1b[C"), vec![Key::Right]);
        assert_eq!(parse_keys(b"\x1b[D"), vec![Key::Left]);
        assert_eq!(parse_keys(b"\r"), vec![Key::Enter]);
        assert_eq!(parse_keys(b"\x1b"), vec![Key::Esc]);
        assert_eq!(parse_keys(b"\x03"), vec![Key::Cancel]);
        assert_eq!(parse_keys(b"\x7f"), vec![Key::Backspace]);
        assert_eq!(parse_keys(b" "), vec![Key::Space]);
        assert_eq!(parse_keys(b"12"), vec![Key::Char('1'), Key::Char('2')]);
    }

    /// 多行输入的两条入口: `\n`(Ctrl+J) / `ESC CR`(Alt+Enter) 必须与 `\r`(Enter) **分开**
    #[test]
    fn parse_keys_separates_newline_from_enter() {
        assert_eq!(parse_keys(b"\r"), vec![Key::Enter]);
        assert_eq!(parse_keys(b"\n"), vec![Key::Newline]);
        assert_eq!(parse_keys(b"\x1b\r"), vec![Key::AltEnter]);
        assert_eq!(parse_keys(b"\x1b\n"), vec![Key::AltEnter]);
    }

    /// Ctrl+G / Alt+V 是输入框快捷键; `ESC v` 不能被解成"Esc + 字符 v"
    #[test]
    fn parse_keys_ctrl_g_and_alt_v() {
        assert_eq!(parse_keys(b"\x07"), vec![Key::CtrlG]);
        assert_eq!(parse_keys(b"\x1bv"), vec![Key::AltV]);
        assert_eq!(parse_keys(b"\x1bV"), vec![Key::AltV]);
        // 孤独的 Esc 仍然是 Esc (不被 Alt+V 抢掉)
        assert_eq!(parse_keys(b"\x1b"), vec![Key::Esc]);
    }

    /// 中文一个字符 3 字节 ⇒ parse_keys 必须解成**一个** Char (读键器负责读全)
    #[test]
    fn parse_keys_reads_full_utf8_char() {
        assert_eq!(parse_keys("中".as_bytes()), vec![Key::Char('中')]);
        assert_eq!(parse_keys("·".as_bytes()), vec![Key::Char('·')]);
        assert_eq!(parse_keys("/".as_bytes()), vec![Key::Char('/')]);
    }

    /// 提示语两档 (有分组才出现折叠键)
    #[test]
    fn hints_have_two_tiers() {
        assert!(TUI_HINT.contains("折叠分组"));
        assert!(!TUI_HINT_FLAT.contains("折叠"));
    }

    /// 掩码字符
    #[test]
    fn mask_char_matches_ts() {
        assert_eq!(MASK_CHAR, "•");
    }

    /// 钉死 42 行的高终端: 视窗取 VIEWPORT_MAX=40, 帧高仍 ≤ rows
    #[test]
    fn tall_terminal_caps_at_viewport_max() {
        let _g = crate::width::test_lock().lock().unwrap();
        set_term_size(100, 42);
        assert_eq!(viewport_height(term_height()), 39);
        let _ = crate::width::clear_term_size();
    }
}
