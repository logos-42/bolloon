//! width.rs — 显示宽度 / 截断 / 终端尺寸
//!
//! **复用 TS 原文**:
//!   · `dispWidth` / `truncate`   ← `src/cli/loading-tui.ts`
//!   · `dispWidthSafe` / `truncateSafe` ← `src/cli/status-segments.ts`
//!   · `termWidth` / `termHeight` / `waitForTermSize` ← `src/cli/loading-tui.ts`
//!
//! 为什么单独一份: 面板几何抖不抖全是这些函数说了算 (见 `docs/wiki/cli-startup-panel.md`:
//! 60 列窄屏 42 帧里输入行号恒 `22`, 靠的就是"宽度算得准")。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ── 显示宽度 ───────────────────────────────────────────────
/**
 * 显示宽度: CJK / 全角符号算 2, 其余算 1 (**ANSI 转义不计入**)。
 * 判据逐条搬自 TS `dispWidth` (East Asian Width 的 W/F 区)。
 */
pub fn disp_width(s: &str) -> usize {
    let clean = strip_ansi(s);
    clean.chars().map(|c| if is_wide(c) { 2 } else { 1 }).sum()
}

/** 该字符是否按 2 列渲染 (East Asian Width 的 W/F 区) */
pub fn is_wide(ch: char) -> bool {
    let c = ch as u32;
    c > 0x1100
        && (c <= 0x115f
            || c == 0x2329
            || c == 0x232a
            || (0x2e80..=0xa4cf).contains(&c)
            || (0xac00..=0xd7a3).contains(&c)
            || (0xf900..=0xfaff).contains(&c)
            || (0xfe30..=0xfe4f).contains(&c)
            || (0xff00..=0xff60).contains(&c)
            || (0xffe0..=0xffe6).contains(&c))
}

/** 剥掉 SGR 转义 (`\x1b[<n;…>m`) — TS `s.replace(/\x1b\[[0-9;]*m/g, '')` */
pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut skip_until = 0usize;
    for (i, ch) in s.char_indices() {
        if i < skip_until {
            continue;
        }
        if ch == '\x1b' {
            if let Some(len) = sgr_len(&s[i..]) {
                skip_until = i + len;
                continue;
            }
        }
        out.push(ch);
    }
    out
}

fn sgr_len(rest: &str) -> Option<usize> {
    let b = rest.as_bytes();
    if b.len() < 3 || b[1] != b'[' {
        return None;
    }
    let mut j = 2;
    while j < b.len() && (b[j].is_ascii_digit() || b[j] == b';') {
        j += 1;
    }
    if j < b.len() && b[j] == b'm' {
        Some(j + 1)
    } else {
        None
    }
}

/// 跳过整个 ANSI 转义序列 (CSI: `\x1b[...<letter>`; 其它: `\x1b<单字节>`), 宽度记 0,
/// 与 `disp_width`(先 `strip_ansi` 再量) 口径一致 —— 否则含颜色的行会被过度截断。
fn consume_escape(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut seq = String::from('\x1b');
    match it.peek() {
        Some('[') => {
            it.next();
            seq.push('[');
            while let Some(&c) = it.peek() {
                seq.push(c);
                it.next();
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
        }
        _ => {
            if let Some(c) = it.next() {
                seq.push(c);
            }
        }
    }
    seq
}

/// 截断实现: 可见宽度记宽, ANSI 转义当 0 宽 (保留颜色), 超 `max` 加 `…`。
fn truncate_impl(text: &str, max: usize, safe: bool) -> String {
    let cur = if safe { disp_width_safe(text) } else { disp_width(text) };
    if cur <= max {
        return text.to_string();
    }
    let mut it = text.chars().peekable();
    let mut out = String::new();
    let mut w = 0usize;
    while let Some(ch) = it.next() {
        if ch == '\x1b' {
            out.push_str(&consume_escape(&mut it));
            continue;
        }
        let cw = if safe { disp_width_safe_char(ch) } else { disp_width_char(ch) };
        if w + cw > max.saturating_sub(1) {
            break;
        }
        out.push(ch);
        w += cw;
    }
    format!("{out}…")
}

/** 按显示宽度截断并加省略号 (TS `truncate`) */
pub fn truncate(text: &str, max: usize) -> String {
    truncate_impl(text, max, false)
}

fn disp_width_char(ch: char) -> usize {
    // 单字符: 只有 ESC 开头且能凑成完整 SGR 才算 0 宽; 与 TS 逐字符 dispWidth 的口径一致
    if ch == '\x1b' {
        1
    } else if is_wide(ch) {
        2
    } else {
        1
    }
}

// ── 保守宽度 (Ambiguous 区按 2 列) ─────────────────────────
/**
 * **保守子集** (TS `AMBIGUOUS_AS_WIDE`): 我们在状态栏/底栏**确实用到**的 Ambiguous 字符。
 *
 * 背景: 这些字符 (U+2500 `─` / U+2502 `│` / U+2191 `↑` / U+25CE `◎` / U+00B7 `·` …) 在
 * **部分终端/字体**下占 2 列, 而我们按 1 列算 ⇒ 整行超宽 ⇒ 终端自动折行 ⇒ 光标数学错位
 * ⇒ **整块底栏被重复打印**。口径: 这里一律按 **2 列**算 (宁可短一列, 绝不超宽)。
 */
const AMBIGUOUS_AS_WIDE: &[char] = &[
    '·', '↑', '↓', '◎', '≈', '│', '─', '—', '↕', '§', '¶', '×', '÷', '±', '°', 'µ', '∞', '≠',
];

/** 保守宽度: `disp_width` + Ambiguous 字符每个再加 1 列 */
pub fn disp_width_safe(s: &str) -> usize {
    let plain = strip_ansi(s);
    let extra = plain.chars().filter(|c| AMBIGUOUS_AS_WIDE.contains(c)).count();
    // 必须量**剥掉 ANSI 之后**的正文: 带着转义序列量会把 `\x1b[38;2;…m` 当可见字符
    disp_width(&plain) + extra
}

/** 按**保守宽度**截断 (TS `truncateSafe`) */
pub fn truncate_safe(s: &str, max_width: usize) -> String {
    truncate_impl(s, max_width, true)
}

/// 右补齐到显示宽度 `w` (用 ASCII 空格, 宽度安全); 超宽则按 `truncate` 截断后补到 `w`。
///
/// **用 `disp_width` (框线/特殊符号按终端真实 1 列), 不用 `disp_width_safe`**:
/// `disp_width_safe` 把 `─`/`│`/`·` 等 Ambiguous 字符按 2 列算, 而终端里它们占 1 列 ——
/// 用 safe 宽度去补列宽会把双栏 Dashboard 的竖分隔符推远一截, 出现大空隙。
/// 这里内容受控、且用 `truncate`(同口径)兜底超宽, 所以直接用真实显示宽度对齐。
pub fn pad_to_width(s: &str, w: usize) -> String {
    let dw = disp_width(s);
    if dw >= w {
        // `truncate(w)` 在边界处可能给 `w-1` (末字被 `…` 替换后少 1), 这里再用空格补到精确 `w`
        let t = truncate(s, w);
        let tw = disp_width(&t);
        let mut out = t;
        for _ in 0..w.saturating_sub(tw) {
            out.push(' ');
        }
        return out;
    }
    let mut out = s.to_string();
    for _ in 0..(w - dw) {
        out.push(' ');
    }
    out
}


fn disp_width_safe_char(ch: char) -> usize {
    let base = if is_wide(ch) { 2 } else { 1 };
    if AMBIGUOUS_AS_WIDE.contains(&ch) {
        base + 1
    } else {
        base
    }
}

// ── 终端尺寸 ───────────────────────────────────────────────
static OVERRIDE: OnceLock<Mutex<Option<(usize, usize)>>> = OnceLock::new();

/// 测试串行锁: 钉尺寸的用例必须拿它 —— 否则并行跑时一条用例改的尺寸会被另一条读到
static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub fn test_lock() -> &'static Mutex<()> {
    TEST_LOCK.get_or_init(|| Mutex::new(()))
}

/**
 * 钉死终端尺寸 (测试 / 窄屏验收用)。
 *
 * 这是 TS `termSize(out, override)` 里那个 `override` 的等价物 —— 真机读 ioctl, 门里钉尺寸。
 */
pub fn set_term_size(cols: usize, rows: usize) {
    let lock = OVERRIDE.get_or_init(|| Mutex::new(None));
    *lock.lock().unwrap() = Some((cols, rows));
}

/** 取消钉死, 回到真机尺寸 */
pub fn clear_term_size() {
    let lock = OVERRIDE.get_or_init(|| Mutex::new(None));
    *lock.lock().unwrap() = None;
}

fn override_size() -> Option<(usize, usize)> {
    OVERRIDE.get_or_init(|| Mutex::new(None)).lock().unwrap().clone()
}

/** 终端列数 (TS `termWidth`: 拿到且 > 24 才信, 否则 80) */
pub fn term_width() -> usize {
    if let Some((c, _)) = override_size() {
        return c;
    }
    // 拿到任意合法值就信 (不再要求 > 24): 窄终端也要按真宽渲染, 否则框线换行漂移
    match winsize() {
        Some((c, _)) if c >= 20 => c,
        _ => 80,
    }
}

/** 终端行数 (TS `termHeight`: 拿到就信, 否则 24) */
pub fn term_height() -> usize {
    if let Some((_, r)) = override_size() {
        return r;
    }
    match winsize() {
        Some((_, r)) if r >= 8 => r,
        _ => 24,
    }
}

#[cfg(unix)]
fn winsize() -> Option<(usize, usize)> {
    unsafe {
        let mut ws: libc::winsize = std::mem::zeroed();
        // 优先读 STDIN: 聊天时整段会话持 raw 模式的就是 stdin tty, 它最可靠;
        // stdout 可能被管道/重定向, 读出来是 0 或占位尺寸。
        if libc::ioctl(libc::STDIN_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            return Some((ws.ws_col as usize, ws.ws_row as usize));
        }
        if libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) == 0 && ws.ws_col > 0 {
            return Some((ws.ws_col as usize, ws.ws_row as usize));
        }
        None
    }
}

#[cfg(not(unix))]
fn winsize() -> Option<(usize, usize)> {
    None
}

/**
 * 等真实终端尺寸就位 (TS `waitForTermSize`, 默认 600ms)。
 *
 * 为什么要等: 真 pty 下 `ws_col` 在启动最初那一刻可能**还没被写进来** ⇒ 面板先按兜底的 80 列
 * 渲染一次, 等真尺寸到位后又渲染一次 —— 面板落在滚动区里覆盖不掉旧内容, 于是**每渲染一次
 * 就多留一条顶框**, 宽度还在变 (实测 24x120: 110 → 120)。
 */
pub fn wait_for_term_size(timeout_ms: u64) {
    let in_place = || matches!(winsize(), Some((c, _)) if c > 24);
    if override_size().is_some() || in_place() {
        return;
    }
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        if in_place() || Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TS 判据: CJK/全角 = 2, 其余 = 1, ANSI 不计宽
    #[test]
    fn disp_width_cjk_and_ansi() {
        assert_eq!(disp_width("abc"), 3);
        assert_eq!(disp_width("中文"), 4);
        assert_eq!(disp_width("·"), 1); // 00B7 不在 W/F 区
        assert_eq!(disp_width("\x1b[38;2;196;214;64m●\x1b[0m"), 1);
        assert_eq!(disp_width("╭───────╮"), 9);
    }

    #[test]
    fn strip_ansi_removes_only_sgr() {
        assert_eq!(strip_ansi("a\x1b[1mb\x1b[0m"), "ab");
        assert_eq!(strip_ansi("a\x1b[2Jb"), "a\x1b[2Jb"); // 非 SGR 不动
    }

    /// `truncate` 与 TS 同口径: 超宽才截, 末尾补 `…`
    #[test]
    fn truncate_matches_ts() {
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(truncate("abcdef", 3), "ab…");
        assert_eq!(truncate("中文测试", 4), "中…");
    }

    /// 保守宽度: Ambiguous 字符每个多算 1 列
    #[test]
    fn disp_width_safe_counts_ambiguous() {
        assert_eq!(disp_width_safe("·"), 2);
        assert_eq!(disp_width_safe("↑"), 2);
        assert_eq!(disp_width_safe("中文"), 4);
        assert_eq!(disp_width_safe("───"), 6);
    }

    #[test]
    fn truncate_safe_uses_safe_width() {
        assert_eq!(truncate_safe("─", 2), "─"); // 保守宽 2 ≤ 2
        assert_eq!(truncate_safe("───", 2), "…");
    }

    /// 钉死尺寸 / 取消钉死 —— 同一条用例里串行跑 (这两个函数共用一份全局尺寸, 不能并行测)
    #[test]
    fn term_size_pin_and_fallback() {
        let _g = test_lock().lock().unwrap();
        clear_term_size();
        if winsize().is_none() {
            // 未钉尺寸且非 TTY → 兜底 80 / 24 (与 TS 同)
            assert_eq!(term_width(), 80);
            assert_eq!(term_height(), 24);
        }
        set_term_size(60, 24);
        assert_eq!(term_width(), 60);
        assert_eq!(term_height(), 24);
        clear_term_size();
    }
}
