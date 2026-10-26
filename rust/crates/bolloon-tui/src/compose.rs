//! compose.rs — 输入缓冲的状态机 (**纯函数**, 不碰终端)
//!
//! 为什么单独一层: `input.rs` 那套 raw 模式交互**没法单测** (它会真的去读 stdin, 跑起来就挂住)。
//! 把"按键 → 意图 → 缓冲变化 → 画成几行"全部抽成纯函数后, 多行输入/历史/草稿/贴图的**语义**
//! 都能在测试里逐条钉住, 剩下的只有 `read()` / `Command::status()` 这点 IO。
//!
//! 键位与文案的**唯一对应表**在 `help.rs` (文案与实现分叉是这类功能的头号事故源)。

use crate::select::Key;
use crate::width::{disp_width, truncate_safe};

/// 一次按键对输入缓冲的**意图**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditAction {
    /// 插入一个可打印字符
    Insert(char),
    /// 光标处换行 (Ctrl+J / Alt+Enter) —— **不发送**
    Newline,
    Backspace,
    /// Enter —— 提交
    Submit,
    /// Esc / Ctrl+C —— 取消 (buffer 不提交)
    Cancel,
    HistoryPrev,
    HistoryNext,
    /// Ctrl+G —— 交给 $VISUAL/$EDITOR 写草稿
    OpenDraft,
    /// Alt+V —— 贴剪贴板图片
    PasteImage,
    /// 其余键 (← → 等: 当前缓冲没有光标概念, 明确不响应而不是假装)
    Ignore,
}

/// 键 → 意图 (**唯一映射**; `help.rs` 的文案按这个表逐条钉)
pub fn resolve_action(key: &Key) -> EditAction {
    match key {
        Key::Enter => EditAction::Submit,
        Key::Newline | Key::AltEnter => EditAction::Newline,
        Key::CtrlG => EditAction::OpenDraft,
        Key::AltV => EditAction::PasteImage,
        Key::Esc | Key::Cancel => EditAction::Cancel,
        Key::Backspace => EditAction::Backspace,
        Key::Up => EditAction::HistoryPrev,
        Key::Down => EditAction::HistoryNext,
        Key::Space => EditAction::Insert(' '),
        Key::Char(c) if !c.is_control() => EditAction::Insert(*c),
        Key::Char(_) | Key::Left | Key::Right => EditAction::Ignore,
    }
}

/// 输入缓冲 + 历史游标
pub struct Compose {
    buf: String,
    /// **旧→新** (↑ 取最后一条)
    hist: Vec<String>,
    /// None = 正在编辑新行
    idx: Option<usize>,
    /// 翻历史前暂存的新行草稿 (↓ 翻回末尾时还回去)
    saved: String,
}

impl Compose {
    pub fn new(hist: Vec<String>, initial: &str) -> Self {
        Self { buf: initial.to_string(), hist, idx: None, saved: String::new() }
    }

    pub fn buf(&self) -> &str {
        &self.buf
    }

    pub fn set_buf(&mut self, s: &str) {
        self.buf = s.to_string();
        self.idx = None;
    }

    pub fn insert(&mut self, c: char) {
        self.buf.push(c);
    }

    pub fn insert_str(&mut self, s: &str) {
        self.buf.push_str(s);
    }

    pub fn newline(&mut self) {
        if !self.buf.ends_with('\n') {
            self.buf.push('\n');
        }
    }

    pub fn backspace(&mut self) {
        self.buf.pop();
    }

    pub fn is_empty(&self) -> bool {
        self.buf.trim().is_empty()
    }

    /// 逻辑行数 (空缓冲算 1 行)
    pub fn line_count(&self) -> usize {
        self.buf.split('\n').count().max(1)
    }

    /** 取上一条历史; 返回 false = 没有历史可翻 (调用方据此别再重画) */
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
 * 把输入缓冲画成**一帧文本**。
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
}
