//! screen.rs — 全屏面板壳 (**几何不抖** 的那层)
//!
//! **复用 TS 原文** `src/cli/ink-app.tsx` 的**几何纪律** (不是 React 那层壳, 是它定下的规矩):
//!
//!   · **三个固定行**: 分隔线 / 状态栏 / 输入行 —— 它们的位置**每帧都一样**, 靠它才有"不抖";
//!   · **帧高恒定** = 终端行数 (`height` 固定, `overflow: hidden`), 长内容靠滚动而不是把版面撑高;
//!   · **输入行号恒定** —— 正文怎么长, 输入行都不许被顶出视野;
//!   · **跟随可暂停** —— 默认贴底跟随新输出, 上滚即暂停 (`stick=false`), `End` 回底恢复。
//!
//! 这四条是 `docs/wiki/cli-startup-panel.md` 里真 pty 抓包验证过的判据:
//!   "60 列窄屏 42 帧: 输入行号恒 22 · 固定栏 20,22,24 · 帧高恒 24"。
//! 本模块把它们做成**纯函数** (`render_frame` 返回固定行数), 于是几何能直接单测, 不用抓包。
//!
//! 布局 (帧共 `rows` 行, 索引 0 起):
//!   ```text
//!   0 … rows-5   正文可视区 (body)
//!   rows-4       分隔线 (rule)      ← 固定行
//!   rows-3       状态栏 (status)    ← 固定行
//!   rows-2       输入行 (input)     ← 固定行
//!   rows-1       键位提示 (hint)    ← 固定行
//!   ```

use crate::scroll::{apply_scroll, resolve_normal_key, NormalAction, NormalCtx, RawKey};
use crate::width::{disp_width_safe, term_height, term_width, truncate_safe};

/// 正文区上方留出的固定行数 (分隔 + 状态 + 输入 + 提示)
pub const CHROME_LINES: usize = 4;

/** 面板壳状态 */
pub struct Screen {
    cols: usize,
    rows: usize,
    /// 正文全部行 (可长过屏幕, 靠滚动消化)
    lines: Vec<String>,
    /// 正文区顶部在哪一行
    scroll_top: usize,
    /// 贴底跟随 (新输出来了自动跟上); 上滚即暂停
    stick: bool,
    pub status: String,
    pub hint: String,
    pub input: String,
}

impl Screen {
    pub fn new(cols: Option<usize>, rows: Option<usize>) -> Self {
        Self {
            cols: cols.unwrap_or_else(term_width),
            rows: rows.unwrap_or_else(term_height).max(CHROME_LINES + 1),
            lines: Vec::new(),
            scroll_top: 0,
            stick: true,
            status: String::new(),
            hint: String::new(),
            input: String::new(),
        }
    }

    pub fn cols(&self) -> usize {
        self.cols
    }
    pub fn rows(&self) -> usize {
        self.rows
    }

    /** 正文区可视高度 */
    pub fn body_height(&self) -> usize {
        self.rows.saturating_sub(CHROME_LINES)
    }

    pub fn stick(&self) -> bool {
        self.stick
    }

    pub fn scroll_top(&self) -> usize {
        self.scroll_top
    }

    /** 正文是否可滚 (总高 > 可视区) */
    pub fn scrollable(&self) -> bool {
        self.lines.len() > self.body_height()
    }

    pub fn max_top(&self) -> usize {
        self.lines.len().saturating_sub(self.body_height())
    }

    /** 追加一行 (按显示宽度折行后入列, 保证一行就是屏幕上的一行) */
    pub fn push(&mut self, line: &str) {
        let w = self.cols.saturating_sub(1);
        if disp_width_safe(line) <= w {
            self.lines.push(line.to_string());
        } else {
            // 超宽先截断 (宁可短一列, 绝不超宽折行 —— 折行正是"版面被撑歪"的根源)
            self.lines.push(truncate_safe(line, w));
        }
        if self.stick {
            self.scroll_top = self.max_top();
        }
    }

    pub fn push_many(&mut self, block: &str) {
        for l in block.lines() {
            self.push(l);
        }
    }

    /** 处理一个滚动键 (键位表见 `scroll.rs`) */
    pub fn on_key(&mut self, key: &RawKey, input_ch: char) {
        let act = resolve_normal_key(
            key,
            &NormalCtx { scrollable: self.scrollable(), input: input_ch },
        );
        let page = self.body_height().max(1);
        let m = apply_scroll(act, self.scroll_top, page, self.max_top());
        self.scroll_top = m.next;
        if act != NormalAction::None {
            self.stick = m.stick;
        }
    }

    pub fn scroll(&mut self, act: NormalAction) {
        let page = self.body_height().max(1);
        let m = apply_scroll(act, self.scroll_top, page, self.max_top());
        self.scroll_top = m.next;
        if act != NormalAction::None {
            self.stick = m.stick;
        }
    }

    /**
     * 渲染一帧 —— **行数恒等于 `self.rows`**。
     *
     * 这是"几何不抖"的机器判据: 不管正文多长、状态栏写什么, 帧永远是 `rows` 行,
     * 输入行永远在 `rows-2`, 分隔线在 `rows-4`, 状态栏在 `rows-3`, 提示在 `rows-1`。
     */
    pub fn render(&self) -> String {
        let body_h = self.body_height();
        let top = self.scroll_top.min(self.max_top());
        let mut out: Vec<String> = Vec::with_capacity(self.rows);

        for i in 0..body_h {
            let l = self.lines.get(top + i).cloned().unwrap_or_default();
            out.push(truncate_safe(&l, self.cols.saturating_sub(1)));
        }
        // 分隔线取 `cols-1`: **绝不写正好等于终端宽的行** (那会触发终端自动折行)
        out.push(rule(self.cols.saturating_sub(1)));
        // 空行也要占一格: 内容为空的行若是空串, 拼出来的帧会**少一行** ⇒ "帧高恒定" 就不成立了
        out.push(nonempty(truncate_safe(&self.status, self.cols.saturating_sub(1))));
        out.push(truncate_safe(
            &format!("› {}", self.input),
            self.cols.saturating_sub(1),
        ));
        out.push(nonempty(truncate_safe(&self.hint, self.cols.saturating_sub(1))));

        out.join("\n")
    }

    /** 帧里的固定行号 (门里逐条核对) */
    pub fn fixed_line_numbers(&self) -> FixedLines {
        FixedLines {
            rule: self.rows - 4,
            status: self.rows - 3,
            input: self.rows - 2,
            hint: self.rows - 1,
        }
    }
}

/** 空行补一个空格 —— 让"帧高恒定"这条不变量在状态/提示为空时也成立 */
fn nonempty(s: String) -> String {
    if s.is_empty() {
        " ".to_string()
    } else {
        s
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedLines {
    pub rule: usize,
    pub status: usize,
    pub input: usize,
    pub hint: usize,
}

/**
 * 分隔线的字符 (默认 `─`, 可用 `BOLLOON_RULE_CHAR` 换)。
 *
 * 2026-10-01 定案: 默认**满宽实线** `─`; `BOLLOON_RULE_CHAR_WIDTH=2` 是给
 * "把 `─` 渲染成 2 列的终端"留的**一键对冲** (线短一半, 但不折行)。默认值不改 ——
 * 用户明确要这个观感 (「我不要这样的虚线」)。
 */
pub fn rule_char() -> char {
    std::env::var("BOLLOON_RULE_CHAR")
        .ok()
        .and_then(|s| s.chars().next())
        .unwrap_or('─')
}

/// 该字符在目标终端上算几列 (默认 1; Ambiguous 会渲染成 2 列的机器设成 2)
pub fn rule_per() -> usize {
    std::env::var("BOLLOON_RULE_CHAR_WIDTH")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1)
}

/// 一行能放几个分隔字符 (宽度 `width` 时)。**绝不写满整宽** ⇒ 调用方传 `cols-1`。
///
/// 底栏所有区域 (框宽、内容宽) 都从这里派生 —— 只有一处宽度口径, 不会各算各的。
pub fn rule_cells(width: usize) -> usize {
    (width / rule_per()).max(8)
}

/// 分隔线 —— 满宽实线 (见 `rule_char` / `rule_per`)
pub fn rule(width: usize) -> String {
    std::iter::repeat(rule_char()).take(rule_cells(width)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::disp_width;

    fn screen(rows: usize, cols: usize) -> Screen {
        Screen::new(Some(cols), Some(rows))
    }

    /// **帧高恒定**: 正文再长, 帧都是 rows 行 (这是不抖的第一判据)
    #[test]
    fn frame_height_is_constant() {
        for rows in [10usize, 24, 42] {
            let mut s = screen(rows, 60);
            assert_eq!(s.render().lines().count(), rows);
            for i in 0..200 {
                s.push(&format!("第 {i} 行"));
            }
            assert_eq!(s.render().lines().count(), rows, "正文 200 行后帧高仍须 = {rows}");
        }
    }

    /// **输入行号恒定**: 正文怎么长, 输入行都不许被顶出视野
    #[test]
    fn input_line_number_is_constant() {
        let mut s = screen(24, 60);
        s.input = "我在打字".to_string();
        for i in 0..100 {
            s.push(&format!("第 {i} 行"));
        }
        let after = s.render().lines().nth(s.fixed_line_numbers().input).unwrap().to_string();
        assert_eq!(s.fixed_line_numbers().input, 22);
        assert!(after.contains("我在打字"));
    }

    /// 四个固定行的**行号**逐条对上 (分隔线/状态/输入/提示)
    #[test]
    fn fixed_lines_sit_where_they_should() {
        let mut s = screen(24, 60);
        s.status = "⚙ 0".to_string();
        s.hint = "Enter 发送".to_string();
        s.input = "hi".to_string();
        s.push("正文一行");
        let frame = s.render();
        let lines: Vec<&str> = frame.lines().collect();
        assert_eq!(s.fixed_line_numbers(), FixedLines { rule: 20, status: 21, input: 22, hint: 23 });
        assert!(lines[20].starts_with('─'), "{:?}", lines[20]);
        assert!(lines[21].contains("⚙ 0"));
        assert!(lines[22].contains("› hi"));
        assert!(lines[23].contains("Enter 发送"));
    }

    /// **跟随可暂停**: 默认贴底; Ctrl+U 上滚 ⇒ stick=false (屏上要能看出"已暂停跟随")
    #[test]
    fn follow_can_be_paused() {
        let mut s = screen(24, 60);
        for i in 0..100 {
            s.push(&format!("第 {i} 行"));
        }
        assert!(s.stick(), "默认贴底跟随");
        assert_eq!(s.scroll_top(), s.max_top());

        s.on_key(&RawKey { ctrl: true, ..Default::default() }, 'u');
        assert!(!s.stick(), "上滚 ⇒ 暂停跟随");
        assert!(s.scroll_top() < s.max_top());

        s.scroll(NormalAction::ScrollEnd);
        assert!(s.stick(), "End ⇒ 回底恢复跟随");
        assert_eq!(s.scroll_top(), s.max_top());
    }

    /// 不可滚时按滚动键**一律不动** (看着像"页面在跳"就是这个)
    #[test]
    fn not_scrollable_means_nothing_moves() {
        let mut s = screen(24, 60);
        s.push("只有一行");
        assert!(!s.scrollable());
        s.on_key(&RawKey { ctrl: true, ..Default::default() }, 'u');
        assert_eq!(s.scroll_top(), 0);
        assert!(s.stick());
    }

    /// 超宽行**先截断不折行** —— 折行正是版面被撑歪的根源
    #[test]
    fn wide_lines_are_truncated_not_wrapped() {
        let mut s = screen(12, 20);
        s.push(&"长".repeat(100));
        assert_eq!(s.render().lines().count(), 12);
    }

    /// 分隔线默认满宽实线 (`─`), 可用 `BOLLOON_RULE_CHAR_WIDTH` 退回半宽
    #[test]
    fn rule_is_full_width_by_default() {
        let r = rule(20);
        assert_eq!(r.chars().count(), 20);
        assert!(r.starts_with('─'));
    }

    /// 20 列窄屏: 每行都按 cols-1 截断 (**绝不因为正好等于终端宽而自动折行**)
    ///
    /// 判据用 `disp_width` 而不是 `disp_width_safe`: 分隔线走的是 TS 那条"默认满宽实线"的口径
    ///   (`─` 按 1 列算 ⇒ 满宽 ✓); 真遇到把 `─` 渲染成 2 列的终端, 用
    ///   `BOLLOON_RULE_CHAR_WIDTH=2` 退回半宽 (线短一半, 但不折行)。
    #[test]
    fn narrow_screen_never_hits_terminal_width() {
        let mut s = screen(12, 20);
        s.status = "⚙ 2 · ◷ 1.2s · 会话标题".to_string();
        s.hint = "Enter 发送 · ↑↓ 历史 · Esc 取消".to_string();
        s.input = "一句比较长的输入".to_string();
        s.push("正文也来一句比较长的话");
        for l in s.render().lines() {
            assert!(disp_width(l) <= 19, "行超宽: {l:?}");
        }
    }
}
