//! compose.rs — 输入缓冲的状态机 (**纯函数**, 不碰终端)
//!
//! 为什么单独一层: raw 模式交互**没法单测** (它会真的去读 stdin, 跑起来就挂住)。
//! 把"按键 → 意图 → 缓冲变化 → 画成几行"全部抽成纯函数后, 多行输入/光标/历史/草稿/贴图
//! 的**语义**都能在测试里逐条钉住, 剩下的只有 `read()` 这点 IO。
//!
//! 键位与文案的**唯一对应表**在 `help.rs` (文案与实现分叉是这类功能的头号事故源)。
//!
//! 2026-10-27: 加**光标** (左/右/Home/End/Delete/Ctrl+A/E/U)。此前 `←→` 被明确忽略
//! ("缓冲没有光标概念"), 于是"退格只能删末尾、改中间必须整条重打" —— 那是缺口不是设计。

use crate::select::Key;
use crate::width::{disp_width, truncate_safe};

/// 一次按键对输入缓冲的**意图**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditAction {
    /// 插入一个可打印字符
    Insert(char),
    /// 光标处换行 (Ctrl+J / Alt+Enter) —— **不发送**
    Newline,
    /// 删光标前一个字符
    Backspace,
    /// 删光标处字符 (Delete)
    DeleteForward,
    /// 光标左移 / 右移
    CursorLeft,
    CursorRight,
    /// 行首 / 行尾 (Home / End, Ctrl+A / Ctrl+E)
    LineHome,
    LineEnd,
    /// 删光标到行首 (Ctrl+U)
    KillToLineStart,
    /// Enter —— 提交
    Submit,
    /// Tab —— 接受当前补全候选 (无补全时等同 Ignore)
    Accept,
    /// Esc —— 取消当前这一行 (会话不退)
    Cancel,
    /// Ctrl+C —— 退出会话 (空闲时一次就退; 运行中的 Ctrl+C 由 interrupt watcher 处理)
    Quit,
    /// Ctrl+D —— 结束输入 (退出会话)
    Eof,
    HistoryPrev,
    HistoryNext,
    /// Ctrl+G —— 交给 `$VISUAL/$EDITOR` 写草稿
    OpenDraft,
    /// Alt+V —— 贴剪贴板图片
    PasteImage,
    /// 其余键 (明确不响应, 而不是假装)
    Ignore,
}

/// 键 → 意图 (**唯一映射**; `help.rs` 的文案按这个表逐条钉)
pub fn resolve_action(key: &Key) -> EditAction {
    match key {
        Key::WheelUp | Key::WheelDown => EditAction::Ignore,

        Key::Enter => EditAction::Submit,
        Key::Tab => EditAction::Accept,
        Key::Newline | Key::AltEnter => EditAction::Newline,
        Key::CtrlG => EditAction::OpenDraft,
        Key::CtrlA => EditAction::LineHome,
        Key::CtrlE => EditAction::LineEnd,
        Key::CtrlU => EditAction::KillToLineStart,
        Key::AltV => EditAction::PasteImage,
        Key::Esc => EditAction::Cancel,
        Key::Cancel => EditAction::Quit,
        Key::Eof => EditAction::Eof,
        Key::Backspace => EditAction::Backspace,
        Key::Delete => EditAction::DeleteForward,
        Key::Left => EditAction::CursorLeft,
        Key::Right => EditAction::CursorRight,
        Key::Home => EditAction::LineHome,
        Key::End => EditAction::LineEnd,
        Key::Up => EditAction::HistoryPrev,
        Key::Down => EditAction::HistoryNext,
        Key::Space => EditAction::Insert(' '),
        Key::Char(c) if !c.is_control() => EditAction::Insert(*c),
        Key::Char(_) => EditAction::Ignore,
    }
}

/// 输入缓冲 + 光标 + 历史游标
///
/// 光标是**字符下标** (0..=字符数) —— 不是字节下标: 用字节会把中文/Emoji 切一半。
pub struct Compose {
    buf: String,
    cursor: usize,
    /// **旧→新** (↑ 取最后一条)
    hist: Vec<String>,
    /// None = 正在编辑新行
    idx: Option<usize>,
    /// 翻历史前暂存的新行草稿 (↓ 翻回末尾时还回去)
    saved: String,
}

impl Compose {
    pub fn new(hist: Vec<String>, initial: &str) -> Self {
        let cursor = initial.chars().count();
        Self { buf: initial.to_string(), cursor, hist, idx: None, saved: String::new() }
    }

    pub fn buf(&self) -> &str {
        &self.buf
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    /// 设光标 (越界自动夹到 0..=字符数)
    pub fn set_cursor(&mut self, n: usize) {
        self.cursor = n.min(self.char_len());
    }

    pub fn char_len(&self) -> usize {
        self.buf.chars().count()
    }

    /// 整体替换 (补全/草稿/历史); 光标落在末尾
    pub fn set_buf(&mut self, s: &str) {
        self.buf = s.to_string();
        self.cursor = self.char_len();
        self.idx = None;
    }

    /// 光标处插入
    pub fn insert(&mut self, c: char) {
        let mut chars: Vec<char> = self.buf.chars().collect();
        let at = self.cursor.min(chars.len());
        chars.insert(at, c);
        self.buf = chars.into_iter().collect();
        self.cursor = at + 1;
    }

    /// 光标处插入一段
    pub fn insert_str(&mut self, s: &str) {
        let mut chars: Vec<char> = self.buf.chars().collect();
        let at = self.cursor.min(chars.len());
        for c in s.chars().rev() {
            chars.insert(at, c);
        }
        self.buf = chars.into_iter().collect();
        self.cursor = at + s.chars().count();
    }

    /// 光标处换行 (**不发送**); 连续按不产生多余空段
    pub fn newline(&mut self) {
        let before = self.chars_vec();
        if self.cursor > 0 && before.get(self.cursor - 1) == Some(&'\n') {
            return;
        }
        self.insert('\n');
    }

    /// 删光标前一个字符
    pub fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        let mut chars = self.chars_vec();
        let at = self.cursor.min(chars.len()) - 1;
        chars.remove(at);
        self.buf = chars.into_iter().collect();
        self.cursor = at;
        self.idx = None;
    }

    /// 删光标处字符 (Delete)
    pub fn delete_forward(&mut self) {
        let mut chars = self.chars_vec();
        if self.cursor >= chars.len() {
            return;
        }
        chars.remove(self.cursor);
        self.buf = chars.into_iter().collect();
        self.idx = None;
    }

    /// 删光标到行首 (Ctrl+U)
    pub fn kill_to_line_start(&mut self) {
        let chars = self.chars_vec();
        let at = self.cursor.min(chars.len());
        let start = chars[..at]
            .iter()
            .rposition(|c| *c == '\n')
            .map(|i| i + 1)
            .unwrap_or(0);
        if start == at {
            return;
        }
        let rest: String = chars[at..].iter().collect();
        let head: String = chars[..start].iter().collect();
        self.buf = format!("{head}{rest}");
        self.cursor = start;
        self.idx = None;
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        self.cursor = (self.cursor + 1).min(self.char_len());
    }

    /// 光标到本行行首
    pub fn line_home(&mut self) {
        let chars = self.chars_vec();
        let at = self.cursor.min(chars.len());
        self.cursor = chars[..at]
            .iter()
            .rposition(|c| *c == '\n')
            .map(|i| i + 1)
            .unwrap_or(0);
    }

    /// 光标到本行行尾
    pub fn line_end(&mut self) {
        let chars = self.chars_vec();
        let at = self.cursor.min(chars.len());
        self.cursor = chars[at..]
            .iter()
            .position(|c| *c == '\n')
            .map(|i| at + i)
            .unwrap_or(chars.len());
    }

    pub fn is_empty(&self) -> bool {
        self.buf.trim().is_empty()
    }

    /// 逻辑行数 (空缓冲算 1 行)
    pub fn line_count(&self) -> usize {
        self.buf.split('\n').count().max(1)
    }

    /// 光标所在 (行号, 行内字符列) —— 都从 0 起
    pub fn line_col(&self) -> (usize, usize) {
        let chars = self.chars_vec();
        let at = self.cursor.min(chars.len());
        let line = chars[..at].iter().filter(|c| **c == '\n').count();
        let col = chars[..at]
            .iter()
            .rposition(|c| *c == '\n')
            .map(|i| at - i - 1)
            .unwrap_or(at);
        (line, col)
    }

    fn chars_vec(&self) -> Vec<char> {
        self.buf.chars().collect()
    }

    /** 取上一条历史; 返回 false = 没有历史可翻 */
    pub fn history_prev(&mut self) -> bool {
        if self.hist.is_empty() {
            return false;
        }
        let next = match self.idx {
            None => {
                self.saved = self.buf.clone();
                self.hist.len() - 1
            }
            Some(0) => 0,
            Some(i) => i - 1,
        };
        self.idx = Some(next);
        self.buf = self.hist[next].clone();
        self.cursor = self.char_len();
        true
    }

    /** 取下一条历史 (到末尾就还回暂存的新行) */
    pub fn history_next(&mut self) -> bool {
        let Some(i) = self.idx else {
            return false;
        };
        if i + 1 < self.hist.len() {
            self.idx = Some(i + 1);
            self.buf = self.hist[i + 1].clone();
        } else {
            self.idx = None;
            self.buf = self.saved.clone();
        }
        self.cursor = self.char_len();
        true
    }
}

/// 输入区一帧: 要打印的文本 + 占了几行
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputRender {
    pub text: String,
    pub lines: usize,
}

/// 状态行的前缀 (成功/失败都靠**符号**表达, 不靠颜色)
pub const NOTE_PREFIX: &str = "  ⎿ ";
/// 上面还有多少行被折叠时的标记
pub const FOLD_MARK: &str = "… (+{} 行)";

/**
 * 把输入缓冲画成**一帧文本** (掩码输入 / 非 TUI 行输入用)。
 *
 * 判据 (与 `screen.rs` 同口径 —— 一行就是屏幕上的一行, 绝不靠终端折行):
 *   · 每行按**保守宽度**截断到 `cols-1`;
 *   · 超过 `max_lines` 时**留尾部** (光标永远在末尾, 让人看得见自己在打什么),
 *     被折掉的行数写在第一行 `… (+N 行)`;
 *   · 首行用 `prompt`, 续行用等宽空格对齐 (行首不歪)。
 */
pub fn render_input(
    prompt: &str,
    buf: &str,
    masked: bool,
    cols: usize,
    max_lines: usize,
    notes: &[String],
) -> InputRender {
    let width = cols.saturating_sub(1).max(8);
    let prompt_w = disp_width(prompt);
    let pad = " ".repeat(prompt_w);

    let shown: String = if masked {
        // 掩码: 一个字符一个 `•` (换行也按一个点算, 明文绝不出现)
        mask_bullets(buf)
    } else {
        buf.to_string()
    };

    let all: Vec<&str> = shown.split('\n').collect();
    let max_lines = max_lines.max(1);
    let skip = all.len().saturating_sub(max_lines);
    let fold = if skip > 0 { Some(skip) } else { None };

    let mut out: Vec<String> = Vec::new();
    for (i, line) in all.iter().enumerate().skip(skip) {
        let prefix = if i == skip { prompt } else { pad.as_str() };
        let mut text = if i == skip && fold.is_some() {
            format!("{prefix}{}{line}", FOLD_MARK.replace("{}", &skip.to_string()))
        } else {
            format!("{prefix}{line}")
        };
        text = truncate_safe(&text, width);
        out.push(text);
    }
    if out.is_empty() {
        out.push(prompt.to_string());
    }

    // 状态行: 贴图/草稿的结果就地显示在输入块下方 (不额外打印, 免得把版面顶乱)
    for n in notes {
        out.push(truncate_safe(&format!("{NOTE_PREFIX}{n}"), width));
    }

    InputRender { text: out.join("\n"), lines: out.len() }
}

/**
 * 单行编辑器的一行 (固定高度输入框的**唯一**渲染函数)。
 *
 * 为什么只有一行: 输入区高度一变, 底下所有固定行 (状态栏/提示栏/边框) 的行号就跟着变
 * ⇒ 用户会看到"打字时整块底栏在跳"。leo 的硬口径是**固定高度**, 所以多行缓冲在这里
 * 只显示**光标所在那一行**, 上下各有几行用 `…N行` 标记如实标出 (不假装看得到)。
 *
 * 宽度口径: `width` 是**可用显示列数** (框内宽), 返回串的显示宽度 ≤ `width`;
 * 中文按 2 列、Emoji 按 2 列 (`width::disp_width`), 绝不用字节长度顶替列宽。
 * 超宽时按光标位置开窗 (左端补 `…`), 保证光标永远可见。
 */
pub fn editor_row(prompt: &str, buf: &str, cursor: usize, width: usize, show_cursor: bool) -> String {
    let width = width.max(4);
    let chars: Vec<char> = buf.chars().collect();
    let at = cursor.min(chars.len());
    let line_idx = chars[..at].iter().filter(|c| **c == '\n').count();
    let line_start = chars[..at]
        .iter()
        .rposition(|c| *c == '\n')
        .map(|i| i + 1)
        .unwrap_or(0);
    let line_end = chars[at..]
        .iter()
        .position(|c| *c == '\n')
        .map(|i| at + i)
        .unwrap_or(chars.len());
    let total_lines = buf.split('\n').count().max(1);
    let lines_below = total_lines - line_idx - 1;

    // 折叠标记 (多行缓冲在单行输入框里的诚实表示)
    let above = if line_idx > 0 {
        format!("…{line_idx}行 ")
    } else {
        String::new()
    };
    let below = if lines_below > 0 {
        format!(" …{lines_below}行")
    } else {
        String::new()
    };

    let prompt_w = if line_idx == 0 { disp_width(prompt) } else { disp_width(prompt) };
    let keep = width
        .saturating_sub(disp_width(&above))
        .saturating_sub(disp_width(&below))
        .saturating_sub(prompt_w)
        .max(2);

    // 水平开窗: **光标必须在窗口内** (老实现从 start 起算, 光标会掉到窗口外 ⇒ 看不见自己在打哪)。
    // 做法 = 先给光标格留位置, 左侧取一半预算, 右侧把剩下的填满。
    let cell = |c: char| disp_width(&c.to_string()).max(1);
    let cursor_cell = if at < line_end { cell(chars[at]) } else { 1 };
    let mut start = at;
    let mut used = cursor_cell;
    let left_budget = keep.saturating_sub(cursor_cell).saturating_sub(1) / 2;
    while start > line_start {
        let w = cell(chars[start - 1]);
        if used + w + 1 > keep || (used - cursor_cell) + w > left_budget {
            break;
        }
        used += w;
        start -= 1;
    }
    let marker = if start > line_start { 1 } else { 0 };
    let mut end = at;
    let mut total = used;
    while end < line_end {
        let w = cell(chars[end]);
        if total + w + marker > keep {
            break;
        }
        total += w;
        end += 1;
    }

    let mut body = String::new();
    if start > line_start {
        body.push('…');
    }
    for i in start..end {
        if i == at && show_cursor {
            // 反显光标 (符号通道: 不靠颜色也看得出光标在哪)
            body.push_str(&format!("\x1b[7m{}\x1b[0m", chars[i]));
        } else {
            body.push(chars[i]);
        }
    }
    if at >= line_end && show_cursor {
        body.push_str("\x1b[7m \x1b[0m"); // 行尾光标
    }

    let prompt = if line_idx == 0 { prompt.to_string() } else { " ".repeat(disp_width(prompt)) };
    let s = format!("{above}{prompt}{body}{below}");
    // 兜底: 标记占宽算不准时按纯文本截 (不切转义序列)
    if disp_width(&s) > width {
        return truncate_safe(&crate::width::strip_ansi(&s), width);
    }
    s
}

/// 掩码: 一个字符一个 `•` (不是字节数 —— 中文也算一个点)
fn mask_bullets(s: &str) -> String {
    crate::select::MASK_CHAR.repeat(s.chars().count())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::disp_width_safe;

    fn cx(hist: &[&str]) -> Compose {
        Compose::new(hist.iter().map(|s| s.to_string()).collect(), "")
    }

    /// Ctrl+J / Alt+Enter = 换行, Enter = 提交 (**同一张表**)
    #[test]
    fn newline_keys_do_not_submit() {
        assert_eq!(resolve_action(&Key::Enter), EditAction::Submit);
        assert_eq!(resolve_action(&Key::Newline), EditAction::Newline);
        assert_eq!(resolve_action(&Key::AltEnter), EditAction::Newline);
        assert_eq!(resolve_action(&Key::CtrlG), EditAction::OpenDraft);
        assert_eq!(resolve_action(&Key::AltV), EditAction::PasteImage);
        assert_eq!(resolve_action(&Key::Esc), EditAction::Cancel);
        assert_eq!(resolve_action(&Key::Cancel), EditAction::Quit);
        assert_eq!(resolve_action(&Key::Delete), EditAction::DeleteForward);
        assert_eq!(resolve_action(&Key::Home), EditAction::LineHome);
        assert_eq!(resolve_action(&Key::End), EditAction::LineEnd);
        assert_eq!(resolve_action(&Key::CtrlA), EditAction::LineHome);
        assert_eq!(resolve_action(&Key::CtrlE), EditAction::LineEnd);
        assert_eq!(resolve_action(&Key::CtrlU), EditAction::KillToLineStart);
        assert_eq!(resolve_action(&Key::Left), EditAction::CursorLeft);
    }

    /// 多行缓冲: 换行不吞字符, 行数正确
    #[test]
    fn newline_accumulates_lines() {
        let mut c = cx(&[]);
        for ch in "第一行".chars() {
            c.insert(ch);
        }
        c.newline();
        for ch in "第二行".chars() {
            c.insert(ch);
        }
        assert_eq!(c.buf(), "第一行\n第二行");
        assert_eq!(c.line_count(), 2);
        // 连续按两次 Ctrl+J 不产生第三个空行 (手抖不该多出空段)
        c.newline();
        c.newline();
        assert_eq!(c.line_count(), 3);
    }

    /// 光标: 插在中间而不是末尾; 退格删光标前; Delete 删光标处
    #[test]
    fn cursor_edits_in_the_middle() {
        let mut c = cx(&[]);
        for ch in "abc".chars() {
            c.insert(ch);
        }
        c.set_cursor(1);
        c.insert('X');
        assert_eq!(c.buf(), "aXbc");
        assert_eq!(c.cursor(), 2);
        c.delete_forward();
        assert_eq!(c.buf(), "aXc", "Delete 删的是光标处");
        c.backspace();
        assert_eq!(c.buf(), "ac", "Backspace 删的是光标前");
    }

    /// 左右移动 / Home / End —— 中文字符按**字符**走, 不按字节
    #[test]
    fn cursor_moves_by_char_not_byte() {
        let mut c = cx(&[]);
        for ch in "中文ab".chars() {
            c.insert(ch);
        }
        assert_eq!(c.cursor(), 4);
        c.left();
        c.left();
        assert_eq!(c.cursor(), 2);
        assert_eq!(c.line_col(), (0, 2));
        c.line_home();
        assert_eq!(c.cursor(), 0);
        c.line_end();
        assert_eq!(c.cursor(), 4);
    }

    /// 多行时 Home/End 只在本行内跳; Ctrl+U 只删到本行行首
    #[test]
    fn home_end_stay_inside_current_line() {
        let mut c = Compose::new(vec![], "ab\ncdef");
        c.set_cursor(5); // a b \n c d | e f
        assert_eq!(c.line_col(), (1, 2));
        c.line_home();
        assert_eq!(c.cursor(), 3, "回到第二行行首");
        c.line_end();
        assert_eq!(c.cursor(), 7);
        c.set_cursor(5);
        c.kill_to_line_start();
        assert_eq!(c.buf(), "ab\nef");
        assert_eq!(c.cursor(), 3);
    }

    /// 历史: ↑ 取最后一条, ↓ 到底还回暂存的新行
    #[test]
    fn history_round_trip() {
        let mut c = cx(&["第一条", "第二条"]);
        for ch in "草稿".chars() {
            c.insert(ch);
        }
        assert!(c.history_prev());
        assert_eq!(c.buf(), "第二条");
        assert!(c.history_prev());
        assert_eq!(c.buf(), "第一条");
        assert!(c.history_prev());
        assert_eq!(c.buf(), "第一条", "到顶不再越界");
        assert!(c.history_next());
        assert_eq!(c.buf(), "第二条");
        assert!(c.history_next());
        assert_eq!(c.buf(), "草稿", "↓ 到底要还回未提交的新行");
        assert!(!c.history_next(), "已经在新行上, 再按 ↓ 不动");
    }

    /// 空历史: ↑↓ 都不动
    #[test]
    fn empty_history_is_noop() {
        let mut c = cx(&[]);
        assert!(!c.history_prev());
        assert!(!c.history_next());
        assert_eq!(c.buf(), "");
    }

    /// 掩码渲染: 明文绝不出现, 点数 = 字符数
    #[test]
    fn masked_render_hides_plaintext() {
        let r = render_input("key › ", "sk-中文abc", true, 60, 4, &[]);
        assert!(!r.text.contains("sk-"));
        assert_eq!(r.text.matches('•').count(), 8, "8 个字符 ⇒ 8 个点 (中文也只算一个)");
        assert_eq!(r.lines, 1);
    }

    /// 多行渲染: **每行都不超过 cols-1**, 行数 = 逻辑行数
    #[test]
    fn multiline_render_never_exceeds_width() {
        let buf = "第一行比较长的一句话\n第二行也不短的一句话\n第三行";
        let r = render_input("› ", buf, false, 20, 8, &[]);
        for l in r.text.lines() {
            assert!(disp_width_safe(l) <= 19, "行超宽: {l:?}");
        }
        assert_eq!(r.lines, 3);
    }

    /// 行数超过 max_lines ⇒ **留尾部** + 首行写 `… (+N 行)` (光标在末尾, 得看得见)
    #[test]
    fn overflow_keeps_tail_and_marks_fold() {
        let buf = (1..=6).map(|i| format!("第{i}行")).collect::<Vec<_>>().join("\n");
        let r = render_input("› ", &buf, false, 40, 3, &[]);
        assert_eq!(r.lines, 3);
        let first = r.text.lines().next().unwrap();
        assert!(first.contains("(+3 行)"), "{first:?}");
        assert!(r.text.contains("第6行"), "最后一行必须在: {r:?}");
        assert!(!r.text.contains("第1行"), "头部该被折掉: {r:?}");
    }

    /// 状态行挂在输入块后面 (贴图/草稿的结果), 同样不许超宽
    #[test]
    fn notes_are_rendered_below_and_fit() {
        let notes = vec!["✓ 已贴图 · /tmp/paste-1.png".to_string()];
        let r = render_input("› ", "hi", false, 24, 4, &notes);
        assert_eq!(r.lines, 2);
        for l in r.text.lines() {
            assert!(disp_width_safe(l) <= 23, "行超宽: {l:?}");
        }
        assert!(r.text.contains("已贴图"));
    }

    /// 首次空缓冲也要画一行 (否则输入行会少一行, 光标位置算错)
    #[test]
    fn empty_buffer_still_renders_prompt() {
        let r = render_input("› ", "", false, 40, 4, &[]);
        assert_eq!(r.lines, 1);
        assert_eq!(r.text, "› ");
    }

    /// 续行与首行**左对齐**: 前缀宽度一致 (视觉上不歪)
    #[test]
    fn continuation_lines_align_with_prompt_width() {
        let r = render_input("› ", "a\nb", false, 40, 4, &[]);
        let lines: Vec<&str> = r.text.lines().collect();
        assert_eq!(disp_width(lines[0].split('a').next().unwrap()), 2);
        assert!(lines[1].starts_with("  b"), "{:?}", lines[1]);
    }

    // ── 单行编辑器 (固定高度输入框) ──────────────────────────

    /// 中文/Emoji 按**显示列**算宽度, 绝不按字节
    #[test]
    fn editor_row_measures_columns_not_bytes() {
        let s = editor_row("❯ ", "你好😀", 3, 30, false);
        assert_eq!(
            disp_width(&s),
            2 + 2 + 2 + 2,
            "提示 2 列 + 你 2 + 好 2 + 😀 2: {s:?}"
        );
    }

    /// 输入永远不超宽 (窄屏 20 列也不许), 且光标始终在可见窗口里
    #[test]
    fn editor_row_never_overflows_and_keeps_cursor_visible() {
        let buf = "这是一段很长很长的中文输入用来把窗口撑爆还有 English mixed 内容".repeat(2);
        for cols in [8usize, 20, 40, 80] {
            for cur in [0usize, 3, buf.chars().count() / 2, buf.chars().count()] {
                let s = editor_row("❯ ", &buf, cur, cols, true);
                assert!(disp_width(&s) <= cols, "超宽 cols={cols} cur={cur}: {s:?}");
                assert!(s.contains('\x1b'), "光标必须在场: {s:?}");
            }
        }
    }

    /// 多行缓冲: 只画光标所在行, 上下各有几行**如实标注** (不假装看得到)
    #[test]
    fn editor_row_folds_multiline_honestly() {
        let buf = "第一行\n第二行\n第三行\n第四行";
        let at_line3 = "第一行\n第二行\n".chars().count(); // 第三行行首
        let s = editor_row("❯ ", buf, at_line3, 40, false);
        assert!(s.contains("…2行"), "上面还有 2 行要标出来: {s:?}");
        assert!(s.contains("…1行"), "下面还有 1 行要标出来: {s:?}");
        assert!(s.contains("第三行"), "光标所在行必须可见: {s:?}");
        assert!(!s.contains("第一行") && !s.contains("第四行"), "别的行不该混进来: {s:?}");
        // 续行不再重复 ❯ (缩进对齐)
        assert_eq!(s.matches('❯').count(), 0, "非首行不画提示符: {s:?}");
    }

    /// 单行: 没有折叠标记
    #[test]
    fn editor_row_single_line_has_no_fold_markers() {
        let s = editor_row("❯ ", "你可以", 3, 40, true);
        assert!(!s.contains("…"), "{s:?}");
        assert!(s.starts_with("❯ 你可以"), "{s:?}");
    }
}
