//! Chrome — 复刻 TS `src/cli/ink-app.tsx` 的全屏壳
//!
//! TS 的分区账本 (`ink-app.tsx` L49-70) 照抄, 只是把 Ink 换成手写 ANSI:
//!
//! ```text
//!   行 1 … history        ← 历史区 (进终端 scrollback, **永不重绘**)
//!   行 history+1          ← 活动行 (思考/工具/提示; 固定预留 1 行)
//!   ────────────────      ← 分隔线
//!   状态栏                ← 左段 + 右对齐标题
//!   ────────────────      ← 分隔线
//!   ❯ 输入                ← **恒 1 行** (按住不换行: 带 \n 会把底栏顶高, TS 踩过)
//!   ────────────────      ← 分隔线
//! ```
//!
//! 为什么不是"整屏自绘 + 虚拟滚动": TS 2026-09-30 起就把 app 内滚动整套关掉了
//! (`ink-app.tsx` L813 `const visible = msgs; // 全部内容交给 <Static>`),
//! 滚动交给终端自己的回滚缓冲 —— 用户框选/复制/上滚都不跟程序抢。
//! 这里同样: 已经上屏的消息就是普通 `println!`, 程序只负责下面这 6 行。
//!
//! 三条纪律 (都来自 TS 的踩坑记录):
//! 1. **chrome 恒 6 行** —— 少一行多一行都会让整块往上/下漂, 行号数学全乱
//! 2. **每行绝不写满终端宽** (`cols-1`) —— 写满触发终端自动折行, 底栏会被重复打印
//! 3. **输入恒 1 行** —— 多行值会把底栏撑高 (`input-paste.ts` L154-158)

use std::io::Write;
use std::time::Instant;

use crate::select::{parse_keys, read_key_raw, Key};
use crate::theme::{C_ACCENT, C_BORDER_BRIGHT, C_DIM, C_MUTED, C_WARN, RESET};
use crate::width::{disp_width_safe, term_height, term_width, truncate_safe};

/// 活动行 (思考/工具/提示) —— 固定预留 1 行
pub const ACTIVITY_LINES: usize = 1;
/// 分隔线 + 状态栏 + 分隔线 + 输入行 + 分隔线
pub const CHROME_LINES: usize = 5;
/// chrome 总高 (活动行 + 固定 5 行)
pub const RESERVED_LINES: usize = ACTIVITY_LINES + CHROME_LINES;
/// 思考帧间隔 (`timing.ts` THINK_FRAME_MS)
pub const THINK_FRAME_MS: u128 = 600;
/// 粘贴折叠阈值 (`input-paste.ts` L23-24)
pub const PASTE_MIN_LINES: usize = 2;
pub const PASTE_MIN_CHARS: usize = 300;
/// 上下文条格数 (`index.ts` L1101)
const CTX_BAR_CELLS: usize = 10;
/// 暂停/取消的二次确认窗口 (`timing.ts` ESC_DOUBLE_MS)
pub const DOUBLE_TAP_MS: u128 = 500;

/// 本回合用量 (状态栏活数据段; 只有真调过模型才有值)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct TurnStats {
    /// 上下文 token (prompt + completion, 上游给的 usage)
    pub ctx_tokens: u32,
    /// 本回合耗时
    pub elapsed_ms: u128,
    /// 输出速率 (t/s)
    pub tps: u32,
    /// 本回合工具调用数
    pub tools: u32,
}

/// 活动行三态 (对齐 `ink-app.tsx` L862-874)
#[derive(Debug, Clone)]
pub enum Activity {
    /// 空闲: 显示按键提示
    Idle,
    /// 模型在跑: 颜文字 + 秒表
    Thinking { started: Instant },
    /// 一次性提示 (暂停跟随 / 自动整理中 / 错误摘要)
    Note(String),
}

/// 状态栏内容 (`status-segments.ts` 的分段口径)
#[derive(Debug, Clone, Default)]
pub struct StatusBar {
    pub model: String,
    pub agent: String,
    pub stats: TurnStats,
    pub ctx_limit: u32,
    /// 右对齐的会话标题 (`▸ 标题`)
    pub title: String,
}

impl StatusBar {
    /// 拼一行状态栏: 左段 `model │ ctx │ ◷ │ ↑ │ ⚙` + 右对齐 `▸ 标题`
    ///
    /// 窄屏丢弃顺序照 TS `fitSegments` (`status-segments.ts` L79-93): `↑` → `◷`,
    /// `⚙` 与 model 永不丢; 标题放不下就整段不显示 (不挤成半截)。
    pub fn render(&self, cols: usize) -> String {
        let budget = cols.saturating_sub(1); // 绝不写满整宽
        let mut segs: Vec<String> = vec![];
        if !self.model.is_empty() {
            segs.push(format!("{C_ACCENT}{}{RESET}", self.model));
        }
        if !self.agent.is_empty() {
            segs.push(format!("{C_MUTED}@{}{RESET}", self.agent));
        }
        if self.stats.ctx_tokens > 0 {
            segs.push(ctx_segment(self.stats.ctx_tokens, self.ctx_limit));
        }
        let elapsed = if self.stats.elapsed_ms >= 1000 {
            format!("{C_DIM}◷ {:.1}s{RESET}", self.stats.elapsed_ms as f64 / 1000.0)
        } else {
            String::new()
        };
        let tps = if self.stats.tps > 0 {
            format!("{C_DIM}↑ ≈{} t/s{RESET}", self.stats.tps)
        } else {
            String::new()
        };
        let tools = format!("{C_DIM}⚙ {}{RESET}", self.stats.tools);

        let mut left = join_segs(&segs);
        // 丢段: 速率 → 耗时 (工具数与模型永不丢)
        for extra in [&tps, &elapsed] {
            if extra.is_empty() {
                continue;
            }
            let cand = join_segs(&[left.clone(), extra.clone()]);
            if disp_width_safe(&cand) < budget {
                left = cand;
            }
        }
        let with_tools = join_segs(&[left.clone(), tools.clone()]);
        if disp_width_safe(&with_tools) < budget {
            left = with_tools;
        }

        // 右对齐标题: pad < 1 就不显示 (TS `rightAlignPad` 口径)
        if self.title.is_empty() {
            return if disp_width_safe(&left) <= budget {
                left
            } else {
                format!("{C_ACCENT}{}{RESET}", truncate_safe(&self.model, budget))
            };
        }
        let note = format!("{C_DIM}▸ {}{RESET}", self.title);
        let lw = disp_width_safe(&left);
        let nw = disp_width_safe(&note);
        if budget > lw + nw + 1 {
            let pad = budget - lw - nw;
            let line = format!("{left}{}{note}", " ".repeat(pad));
            return line;
        }
        // 放不下标题/左段超宽: 退回"只有模型名"的最保守形态 (逐段丢, 不切转义序列)
        let plain_model = crate::width::strip_ansi(&format!("{C_ACCENT}{}{RESET}", self.model));
        format!("{C_ACCENT}{}{RESET}", truncate_safe(&plain_model, budget))
    }
}

fn join_segs(segs: &[String]) -> String {
    segs.iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(&format!("{C_MUTED} │ {RESET}"))
}

/// `320k/1M [██████░░░░] 32%` —— 千位缩写与百分比口径照 TS (`index.ts` L1101-1119)
fn ctx_segment(tokens: u32, limit: u32) -> String {
    let limit = if limit == 0 { 1_000_000 } else { limit };
    let pct = (tokens as f64 / limit as f64 * 100.0).min(100.0);
    let filled = ((pct / 100.0) * CTX_BAR_CELLS as f64).round() as usize;
    let bar: String = (0..CTX_BAR_CELLS)
        .map(|i| if i < filled { '█' } else { '░' })
        .collect();
    let pct_s = if pct >= 10.0 {
        format!("{pct:.0}%")
    } else if pct >= 1.0 {
        format!("{pct:.1}%")
    } else {
        format!("{pct:.2}%")
    };
    format!(
        "{C_DIM}{}/{}{RESET} {C_ACCENT}[{bar}]{RESET} {C_DIM}{pct_s}{RESET}",
        fmt_k(tokens),
        fmt_k(limit)
    )
}

fn fmt_k(n: u32) -> String {
    if n >= 1_000_000 {
        format!("{:.0}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.0}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

/// 输入结果
pub enum InputOutcome {
    Line(String),
    /// Esc / Ctrl+C: 这一行不要了 (调用方决定"双击退出")
    Cancelled,
    /// Ctrl+D / 管道关闭
    Eof,
}

/// 底部壳: 活动行 + 3 条分隔线 + 状态栏 + 单行输入
pub struct Chrome {
    pub rows: usize,
    pub cols: usize,
    pub activity: Activity,
    pub status: StatusBar,
    /// 单行输入缓冲 (恒无 `\n`)
    input: String,
    /// 光标位置 (字符下标)
    cursor: usize,
    pub hint: String,
    drawn: bool,
    anim: usize,
    paste_seq: u32,
    hist: Vec<String>,
    hist_idx: Option<usize>,
    hist_saved: String,
    /// **flow 布局**: `Some(下一空闲行)` = 内容还没满屏, chrome 跟在内容下方
    /// (消除"启动 dashboard 钉在顶部、chrome 钉在底部、中间整块空白");
    /// `None` = 内容已满屏, 永久钉底 (终端滚动接管)。
    flow_top: Option<usize>,
}

impl Chrome {
    pub fn new(rows: usize, cols: usize) -> Self {
        Self {
            rows,
            cols,
            activity: Activity::Idle,
            status: StatusBar::default(),
            input: String::new(),
            cursor: 0,
            hint: "输入消息... @智能体 /命令 #文件 · Esc 双击退出".to_string(),
            drawn: false,
            anim: 0,
            paste_seq: 0,
            hist: vec![],
            hist_idx: None,
            hist_saved: String::new(),
            flow_top: None,
        }
    }

    /// 尺寸变了就跟着变 (历史已上屏的回不来, chrome 必须跟上 — 否则行宽全错)
    pub fn refresh_size(&mut self) -> bool {
        let (c, r) = (term_width(), term_height());
        let changed = c != self.cols || r != self.rows;
        self.cols = c;
        self.rows = r;
        changed
    }

    pub fn is_drawn(&self) -> bool {
        self.drawn
    }

    /// 活动行推进一帧 (思考颜文字)
    pub fn tick(&mut self) {
        self.anim = self.anim.wrapping_add(1);
    }

    pub fn set_input(&mut self, s: &str) {
        self.input = s.replace(['\n', '\r', '\t'], " ");
        self.cursor = self.input.chars().count();
        self.hist_idx = None;
    }

    pub fn input(&self) -> &str {
        &self.input
    }

    // ────────────────────────── 渲染 ──────────────────────────

    /// 6 行 chrome (不含历史)
    pub fn render_block(&self) -> Vec<String> {
        vec![
            self.activity_line(),
            self.rule(),
            self.status.render(self.cols),
            self.rule(),
            self.input_line(),
            self.rule(),
        ]
    }

    fn rule(&self) -> String {
        // 分隔线绝不写满整宽 (满宽 ⇒ 终端自动折行 ⇒ 底栏被重复打印)
        format!("{C_BORDER_BRIGHT}{}{RESET}", crate::screen::rule(self.cols.saturating_sub(1)))
    }

    fn activity_line(&self) -> String {
        let s = match &self.activity {
            Activity::Idle => format!(
                "{C_DIM}· 回车发送 · ↑↓ 历史 · /help 看命令 · Esc 双击退出{RESET}"
            ),
            Activity::Thinking { started } => {
                let frames = crate::loading::LOADING_FRAMES;
                let kaomoji = frames[self.anim % frames.len()];
                let secs = started.elapsed().as_millis() as f64 / 1000.0;
                // 流光扫过状态词 (10 FPS, 随 tick 前进); 关颜色自动降级为纯文本
                let label = crate::loading::shimmer("Thinking · 正在生成", self.anim);
                format!("{C_WARN}{kaomoji}{RESET} {label} {C_DIM}· {secs:.1}s · 流式输出中{RESET}")
            }
            Activity::Note(n) => format!("{C_DIM}{n}{RESET}"),
        };
        // 已按 cols-1 造好; 只在真的超宽时按**纯文本**截 (不切转义序列)
        if disp_width_safe(&s) > self.cols.saturating_sub(1) {
            let plain = crate::width::strip_ansi(&s);
            return format!("{C_DIM}{}{RESET}", truncate_safe(&plain, self.cols.saturating_sub(1)));
        }
        s
    }

    fn input_line(&self) -> String {
        let avail = self.cols.saturating_sub(4).max(6); // `❯ `(2) + 左截断「…」(1) + 末列余量
        let chars: Vec<char> = self.input.chars().collect();
        if chars.is_empty() {
            // 空输入也保留 1 列截断指示位 (空格), 与有输入起点对齐, 不跳变
            return format!(
                "{C_ACCENT}❯ {RESET} {C_MUTED}{}{RESET}",
                truncate_safe(&self.hint, avail)
            );
        }
        // 水平窗口: **按显示宽度**算 (中文 2 列), 保证光标可见且整行不超 cols-1
        let cw = |c: char| crate::width::disp_width(&c.to_string()).max(1);
        let mut start = self.cursor.min(chars.len());
        let mut used = 0usize;
        while start > 0 {
            let w = cw(chars[start - 1]);
            if used + w > avail.saturating_sub(2) {
                break;
            }
            used += w;
            start -= 1;
        }
        let mut end = start;
        let mut used2 = 0usize;
        let budget = avail.saturating_sub(if start > 0 { 1 } else { 0 });
        while end < chars.len() {
            let w = cw(chars[end]);
            if used2 + w > budget {
                break;
            }
            used2 += w;
            end += 1;
        }
        let mut body = String::new();
        for (i, ch) in chars[start..end].iter().enumerate() {
            let abs = start + i;
            if abs == self.cursor {
                // 反显光标 (TS 用 ink-text-input 的反显)
                body.push_str(&format!("\x1b[7m{ch}\x1b[0m"));
            } else {
                body.push(*ch);
            }
        }
        if self.cursor >= chars.len() {
            body.push_str("\x1b[7m \x1b[0m"); // 末尾光标
        }
        // 截断指示位**始终占 1 列** (未截断留空格): 文本起点恒定, 不随宽度/是否截断跳变
        let trunc_marker = if start > 0 { "…" } else { " " };
        format!("{C_ACCENT}❯ {RESET}{trunc_marker}{body}")
    }

    /// 钉底时的 chrome 顶行 (1-based)
    fn pinned_top(&self) -> usize {
        self.rows.saturating_sub(RESERVED_LINES) + 1
    }

    /// chrome 顶部行 (1-based)。
    ///
    /// flow 模式 (`flow_top = Some(下一空闲行)`): chrome 跟在内容**下一行**之下,
    /// 中间不隔整块空白; 内容一旦装不下就永久钉底。`None` = 钉在终端最底
    /// `RESERVED_LINES` 行 (老行为)。
    fn chrome_top(&self) -> usize {
        match self.flow_top {
            Some(r) => (r + 1).min(self.pinned_top()),
            None => self.pinned_top(),
        }
    }

    /// 进入 flow 布局: `row` = 第一条空闲行 (启动 dashboard 打印完之后调)。
    pub fn set_flow_top(&mut self, row: usize) {
        self.flow_top = Some(row.max(1));
    }

    /// 流式面板的底边锚点 (chrome 顶行的上一行) —— 面板从这里向上生长
    pub fn panel_anchor(&self) -> usize {
        self.chrome_top().saturating_sub(1).max(2)
    }

    /// flow 判定 (纯函数, 便于单测): 从 `flow_top` 打印 `n` 行、chrome 跟在后面,
    /// 是否**装不下** (装不下 ⇒ 放弃 flow, 永久钉底走滚动路径)。
    fn flow_overflows(&self, n: usize) -> bool {
        match self.flow_top {
            None => true,
            Some(r) => {
                let last = r + n.saturating_sub(1);
                last + RESERVED_LINES > self.rows
            }
        }
    }

    /// 画 (用**绝对行号**重绘 6 行 —— 永不漂移, 不管上方历史怎么换行/滚动)
    ///
    /// 旧实现用 `\r\x1b[5A` 相对上移: 一旦某条线在终端里折行 (宽度判定偏大时必然),
    /// 上移行数就少算 ⇒ 整块右移并重复。绝对行号 + `\x1b[2K`(整行擦) 从根上杜绝漂移。
    pub fn draw(&mut self) {
        self.refresh_size();
        let block = self.render_block();
        let top = self.chrome_top();
        let mut out = String::new();
        for (i, line) in block.iter().enumerate() {
            out.push_str(&format!("\x1b[{}H\x1b[2K{}", top + i, line));
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
        self.drawn = true;
    }

    /// 擦掉 chrome (要往历史里打印东西之前必须调, 否则文字会插进底栏)
    pub fn clear(&mut self) {
        if self.drawn {
            let top = self.chrome_top();
            let mut out = String::new();
            for i in 0..RESERVED_LINES {
                out.push_str(&format!("\x1b[{}H\x1b[2K", top + i));
            }
            print!("{out}");
            let _ = std::io::stdout().flush();
            self.drawn = false;
        }
    }

    /// 往历史区追加 (先擦 chrome → 打印 → 重画 chrome)。
    ///
    /// flow 模式下内容还**装得下** ⇒ 就地打印在 `flow_top`, chrome 跟着下移
    /// (第一条回复紧跟 dashboard, 中间没有整块空白);
    /// 装不下 ⇒ 永久切换到钉底滚动模式 (老路径, 终端自然上滚, chrome 行号恒定)。
    pub fn print_above(&mut self, lines: &[String]) {
        if lines.is_empty() {
            return;
        }
        if !self.flow_overflows(lines.len()) {
            let r = self.flow_top.unwrap_or(1);
            let last = r + lines.len() - 1;
            self.clear();
            print!("\x1b[{r}H");
            let _ = std::io::stdout().flush();
            for l in lines {
                println!("{l}");
            }
            self.flow_top = Some(last + 1);
            self.draw();
            return;
        }
        self.flow_top = None; // 装不下 ⇒ 钉底 (本会话剩余时间都用滚动路径)
        self.clear();
        // 光标移到 chrome 顶行上一行; 内容超出则终端自然上滚, chrome 行号恒定不受影响
        let above = self.chrome_top().saturating_sub(1).max(1);
        print!("\x1b[{}H", above);
        let _ = std::io::stdout().flush();
        for l in lines {
            println!("{l}");
        }
        self.draw();
    }

    /// 硬清屏 (对齐 `/clear` `/redraw`); 清完回到 flow 布局 (内容从顶部重新生长,
    /// 不然空屏 + 钉底 chrome 又是一整块空白)
    pub fn reset_screen(&mut self) {
        print!("\x1b[2J\x1b[H");
        let _ = std::io::stdout().flush();
        self.drawn = false;
        self.flow_top = Some(1);
    }

    // ────────────────────────── 输入循环 ──────────────────────────

    /// 读一行 (单行编辑器; Enter 提交 · Esc/Ctrl+C 取消 · Ctrl+D EOF)
    pub fn read_line(&mut self, history: &[String], initial: &str) -> InputOutcome {
        self.hist = history.to_vec();
        self.hist_idx = None;
        self.hist_saved = initial.to_string();
        self.set_input(initial);
        self.refresh_size();
        self.draw();
        loop {
            let Some(bytes) = read_key_raw() else {
                return InputOutcome::Eof;
            };
            for key in parse_keys(&bytes) {
                match key {
                    Key::Enter | Key::Newline => {
                        let text = self.input.clone();
                        self.clear();
                        if let Some(folded) = self.fold_long_paste(&text) {
                            return InputOutcome::Line(folded);
                        }
                        return InputOutcome::Line(text);
                    }
                    Key::Esc | Key::Cancel => {
                        self.clear();
                        return InputOutcome::Cancelled;
                    }
                    Key::Backspace => {
                        self.delete_before();
                    }
                    Key::Left => {
                        self.cursor = self.cursor.saturating_sub(1);
                    }
                    Key::Right => {
                        let n = self.input.chars().count();
                        if self.cursor < n {
                            self.cursor += 1;
                        }
                    }
                    Key::Up => {
                        self.history_prev();
                    }
                    Key::Down => {
                        self.history_next();
                    }
                    Key::Space => self.insert_char(' '),
                    Key::AltEnter => self.insert_char(' '), // 单行: 换行折成空格
                    Key::Char(c) if !c.is_control() => self.insert_char(c),
                    Key::Tab => {} // 单行壳无补全 (composer 才响应 Tab)
                    Key::CtrlG | Key::AltV | Key::Char(_) => {
                        // 单行壳里不做草稿/贴图 (TS 的 ink-app 也没有 Ctrl+G/Alt+V)
                    }
                }
            }
            self.refresh_size();
            self.draw();
        }
    }

    fn insert_char(&mut self, c: char) {
        let mut chars: Vec<char> = self.input.chars().collect();
        let at = self.cursor.min(chars.len());
        chars.insert(at, c);
        self.input = chars.into_iter().collect();
        self.cursor = at + 1;
        self.hist_idx = None;
    }

    fn delete_before(&mut self) {
        let mut chars: Vec<char> = self.input.chars().collect();
        if self.cursor == 0 || chars.is_empty() {
            return;
        }
        let at = self.cursor.min(chars.len()) - 1;
        chars.remove(at);
        self.input = chars.into_iter().collect();
        self.cursor = at;
        self.hist_idx = None;
    }

    fn history_prev(&mut self) {
        if self.hist.is_empty() {
            return;
        }
        let idx = match self.hist_idx {
            None => {
                self.hist_saved = self.input.clone();
                self.hist.len() - 1
            }
            Some(0) => 0,
            Some(i) => i - 1,
        };
        self.hist_idx = Some(idx);
        let v = self.hist[idx].clone();
        self.input = v;
        self.cursor = self.input.chars().count();
    }

    fn history_next(&mut self) {
        let Some(i) = self.hist_idx else { return };
        if i + 1 >= self.hist.len() {
            self.hist_idx = None;
            self.input = self.hist_saved.clone();
        } else {
            self.hist_idx = Some(i + 1);
            self.input = self.hist[i + 1].clone();
        }
        self.cursor = self.input.chars().count();
    }

    /// 长粘贴 → 落文件 + 一行引用 (`input-paste.ts` L55-92 口径)
    fn fold_long_paste(&mut self, text: &str) -> Option<String> {
        let lines = text.lines().count();
        let chars = text.chars().count();
        if lines < PASTE_MIN_LINES && chars < PASTE_MIN_CHARS {
            return None;
        }
        self.paste_seq += 1;
        let dir = paste_dir()?;
        let _ = std::fs::create_dir_all(&dir);
        let name = format!(
            "p{}_{}.txt",
            self.paste_seq,
            chrono::Local::now().format("%H%M%S")
        );
        let path = dir.join(&name);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path).ok()?;
        f.write_all(text.as_bytes()).ok()?;
        Some(format!(
            "[粘贴 #{}: {} 行 → {}]\n(整段已存到 {} —— 需要看细节就 read_file 读它, 不用我重述)",
            self.paste_seq,
            lines,
            path.display(),
            path.display()
        ))
    }
}

/// 粘贴落盘目录: `~/.bolloon/pastes` (与 TS 同路径)
fn paste_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var("BOLLOON_HOME")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(|| std::env::var("HOME").ok().map(|h| std::path::PathBuf::from(h).join(".bolloon")))?;
    Some(home.join("pastes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_is_always_six_lines() {
        let c = Chrome::new(30, 100);
        assert_eq!(c.render_block().len(), RESERVED_LINES);
        assert_eq!(RESERVED_LINES, 6, "TS: 活动行 1 + rule/status/rule/input/rule");
    }

    /// flow 布局: chrome 跟在内容下一行, 不再钉底留整块空白
    #[test]
    fn flow_mode_keeps_chrome_right_below_content() {
        let mut c = Chrome::new(24, 80);
        assert_eq!(c.chrome_top(), 19, "默认钉底: 24-6+1");
        c.set_flow_top(5); // 内容占 1..4
        assert_eq!(c.chrome_top(), 6, "chrome 紧跟内容下一行");
        assert!(!c.flow_overflows(3), "5..7 打印 3 行 + 6 行 chrome = 13 行, 装得下");
        assert!(c.flow_overflows(18), "5..22 打印 18 行 + chrome 装不下");
    }

    /// flow 越过钉底线 ⇒ 自动封顶 (绝不把 chrome 推出屏幕)
    #[test]
    fn flow_mode_caps_at_pinned_top() {
        let mut c = Chrome::new(24, 80);
        c.set_flow_top(100);
        assert_eq!(c.chrome_top(), 19, "越过钉底线 ⇒ 回到钉底位置");
    }

    /// /clear 后回到 flow: 空屏 + 钉底 chrome = 又一块大空白 (老坑)
    #[test]
    fn reset_screen_returns_to_flow_layout() {
        let mut c = Chrome::new(24, 80);
        c.set_flow_top(10);
        c.reset_screen();
        assert_eq!(c.flow_top, Some(1), "清屏后内容从顶部重新生长");
    }

    #[test]
    fn every_line_stays_inside_terminal_width() {
        // 写满整宽会触发终端自动折行 ⇒ 底栏重复打印 (TS 坑 2)
        let mut c = Chrome::new(30, 40);
        c.set_input("这是一条很长很长的输入用来把输入行撑到超宽看看会不会折行");
        c.status.model = "deepseek-v4-flash".into();
        c.status.title = "一个很长很长的会话标题不该把行撑爆".into();
        c.status.stats = TurnStats { ctx_tokens: 320_000, elapsed_ms: 1234, tps: 42, tools: 3 };
        for line in c.render_block() {
            let real = crate::width::disp_width(&crate::width::strip_ansi(&line));
            assert!(real < 40, "超宽了({real}): {line:?}");
        }
    }

    #[test]
    fn status_drops_rate_before_tools() {
        let mut c = Chrome::new(30, 60);
        c.status.model = "m".into();
        c.status.stats = TurnStats { ctx_tokens: 1000, elapsed_ms: 2000, tps: 88, tools: 7 };
        let wide = c.status.render(120);
        assert!(wide.contains("t/s"), "宽屏要显示速率: {wide}");
        assert!(wide.contains("⚙ 7"), "工具数常显: {wide}");
        let narrow = c.status.render(28);
        assert!(!narrow.contains("t/s"), "先丢速率: {narrow}");
        assert!(narrow.contains('m'), "模型永不丢: {narrow}");
    }

    #[test]
    fn thinking_activity_shows_kaomoji_and_elapsed() {
        let mut c = Chrome::new(30, 80);
        c.activity = Activity::Thinking { started: Instant::now() };
        let line = c.activity_line();
        assert!(line.contains("Thinking"), "{line}");
        assert!(line.contains('s'), "要有秒表: {line}");
        assert!(line.contains("流式输出"), "流式语义要如实: {line}");
    }

    #[test]
    fn input_window_keeps_cursor_visible() {
        let mut c = Chrome::new(30, 24);
        c.set_input("0123456789abcdefghijklmnopqrstuvwxyz");
        c.cursor = 30; // 末尾
        let line = c.input_line();
        let real = crate::width::disp_width(&crate::width::strip_ansi(&line));
        assert!(real < 24, "输入行别写满整宽({real}): {line}");
        assert!(line.contains('…'), "超宽要出左截断标记: {line}");
    }

    #[test]
    fn empty_input_shows_placeholder() {
        let c = Chrome::new(30, 100);
        let line = c.input_line();
        assert!(line.contains('❯'), "{line}");
        assert!(line.contains("输入消息"), "空输入给提示词: {line}");
    }
}
