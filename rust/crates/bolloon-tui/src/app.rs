//! app.rs — **唯一**的交互界面渲染者 (`Chrome`)
//!
//! ## 2026-10-27 的所有权收口 (为什么这个文件是这个形状)
//!
//! 真机报障: 打一个字就多一条横线 + 一份输入文本, 旧输入永不清理。根因不是某条线画错,
//! 而是**底栏有两个渲染者**:
//!
//!   · `Chrome::draw()` —— 绝对行号写固定行;
//!   · `input::ask_composer()` —— 另一套**相对位移**的帧 (补全菜单 + 顶线 + 输入块 + 底线 + 状态),
//!     每键"上移 N 行 + 清到屏末"重画。
//!
//! 那套帧**以 `\n` 结尾**: 光标落在末行**下一行**, 而上移量是 `drawn-1`
//! ⇒ 每次重画都少上移一行 ⇒ 上一帧第一行永远擦不掉, 一帧一帧往下堆
//! (真机观测: 打三个字, 屏幕多出三组横线 + 输入, 整块区域一路往上漂)。
//! 相对位移另有两个坑: 终端一旦折行 (宽字符 / East-Asian Ambiguous 按 2 列渲染) 行数就算错;
//! 两个渲染者的行号布局还不一样 ⇒ "等输入"与"等模型"切换时整块底栏上下跳。
//!
//! 收口后的规矩 (**本文件是唯一写底栏的地方**):
//!
//! 1. 底部只有**一帧固定高度**(`RESERVED_LINES = 5`), 永远用**绝对行号** + `\x1b[2K`
//!    整行擦重画 —— 全场没有一处相对位移 (`\x1b[nA`), 折行也不漂移;
//! 2. 键盘事件**只改状态** (`Compose` 缓冲/光标 · 补全 · 运行状态行), 之后由本模块重画;
//! 3. 流式 token / 工具调用 / 日志事件都"先入状态, 再重画", 没有人直接往底栏写字;
//! 4. 历史区仍是 `println!` 进终端 scrollback (用户框选/复制/上滚都不跟程序抢),
//!    进之前先擦底栏 (`print_above`), 出来再画一次。
//!
//! ## 布局 (底部固定 composer, 帧 5 行, 索引 0 起)
//!
//! ```text
//!   0  ── (｀・ω・´) Thinking · 3.2s ───────────────────────────────
//!   1  ❯ 你可以看到 Rust 项目的 CLI 吗                      ← 输入 (恒 1 行, 无框)
//!   2  ──────────────────────────────────────────────────────────
//!   3  ◉ kimi-k3 · ctx 3k · ⚙ 0                      ▸ 会话语义标题
//!   4  ◷ 9.5s · ↑ ≈108 t/s · ⏱ 12m 3s
//! ```
//!
//! 三块固定区域: **运行状态行**(0) / **输入 composer**(1) / **模型与指标栏**(2-4)。
//! 输入行**不加四边框** —— 一条水平分隔线就够 (边框多占两行, 窄屏上还最容易折行)。
//! 输入恒 1 行: 高度一变下面所有固定行就整体位移 (用户看到的是"打字时底栏在跳");
//! 多行缓冲只画**光标所在行**, 上下各有几行用 `…N行` 如实标注 (不假装看得到)。

use std::io::Write;
use std::time::Instant;

use crate::completion::{
    apply as apply_compl, detect as detect_compl, filter_items, ComplItem, ComplKind,
};
use crate::compose::{editor_row, resolve_action, Compose, EditAction};
use crate::select::{parse_keys, read_key_raw};
use crate::theme::{C_ACCENT, C_BORDER_BRIGHT, C_DIM, C_MUTED, C_WARN, RESET};
use crate::width::{
    disp_width, disp_width_safe, pad_to_width, term_height, term_width, truncate_safe,
};

/// 运行状态行 (Working / Thinking / 提示 / 补全候选) —— 固定 1 行
pub const STATUS_LINE_LINES: usize = 1;
/// 输入 composer —— 固定 1 行
pub const COMPOSER_LINES: usize = 1;
/// 分隔线 + 模型行 + 指标行
pub const FOOTER_LINES: usize = 3;
/// 底部固定区域总高
pub const RESERVED_LINES: usize = STATUS_LINE_LINES + COMPOSER_LINES + FOOTER_LINES;
/// 思考帧间隔 (`timing.ts` THINK_FRAME_MS)
pub const THINK_FRAME_MS: u128 = 600;
/// 粘贴折叠阈值 (`input-paste.ts` L23-24)
pub const PASTE_MIN_LINES: usize = 2;
pub const PASTE_MIN_CHARS: usize = 300;
/// 暂停/取消的二次确认窗口 (`timing.ts` ESC_DOUBLE_MS)
pub const DOUBLE_TAP_MS: u128 = 500;
/// 输入提示符 (`❯` 固定在输入区起始位置)
pub const PROMPT: &str = "❯ ";
/// 空输入时的引导文案 (有内容立刻消失)
pub const PLACEHOLDER: &str = "输入消息… @智能体 /命令 #文件";
/// 上下文容量环境变量 (真实容量只有用户/供应商知道; 没给就不画分母与进度条)
pub const CTX_LIMIT_ENV: &str = "BOLLOON_CTX_LIMIT";
/// 上下文条格数 (`index.ts` L1101)
const CTX_BAR_CELLS: usize = 10;

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

/// 运行状态行三态
#[derive(Debug, Clone)]
pub enum Activity {
    /// 空闲: 显示键位提示
    Idle,
    /// 模型在跑: 颜文字 + 秒表 (+ 已收到的字数, 0 = 还没开始吐字)
    Thinking { started: Instant, chars: usize },
    /// 工具在跑: 名字 + 秒表 (工具是**阻塞**的, 必须自己有 tick 驱动动画, 否则整个底栏冻住)
    Tool { name: String, started: Instant },
    /// 一次性提示 (中断/贴图/草稿/日志事件)
    Note(String),
}

/// 底部两行状态数据
#[derive(Debug, Clone, Default)]
pub struct StatusBar {
    pub model: String,
    pub agent: String,
    pub stats: TurnStats,
    /// 上下文容量 (上游/配置真给了才有值; 没给就不显示分母, 绝不编一个 1M)
    pub ctx_limit: u32,
    /// 右对齐的会话标题 (语义摘要, 不是时间戳)
    pub title: String,
    /// 会话开始时刻 (用来算真实任务持续时间 `⏱`)
    pub session_started: Option<Instant>,
}

impl StatusBar {
    /// 模型行: `◉ model · @agent · ctx/limit [bar] pct · ⚙ n` + 右对齐 `▸ 标题`
    ///
    /// 只显示**有真数据**的段: 没调过模型就没有 ctx (不编)。
    /// 窄屏丢段顺序: `ctx → ⚙ → 标题`; 模型名永不丢。
    pub fn render_model_row(&self, cols: usize) -> String {
        let budget = cols.max(8);
        let mut segs: Vec<String> = vec![];
        if !self.model.is_empty() {
            segs.push(format!("{C_ACCENT}{}{RESET}", self.model));
        }
        if !self.agent.is_empty() {
            segs.push(format!("{C_MUTED}@{}{RESET}", self.agent));
        }
        if self.stats.ctx_tokens > 0 {
            segs.push(ctx_segment(self.stats.ctx_tokens, self.ctx_limit()));
        }
        let tools = format!("{C_DIM}⚙ {}{RESET}", self.stats.tools);

        let mut left = join_segs(&segs);
        let with_tools = join_segs(&[left.clone(), tools.clone()]);
        if disp_width_safe(&with_tools) < budget {
            left = with_tools;
        }

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
            return format!("{left}{}{note}", " ".repeat(pad));
        }
        // 放不下标题 / 左段超宽: 退回"只有模型名"的最保守形态 (逐段丢, 不切转义序列)
        let plain_model = crate::width::strip_ansi(&format!("{C_ACCENT}{}{RESET}", self.model));
        format!("{C_ACCENT}{}{RESET}", truncate_safe(&plain_model, budget))
    }

    /// 指标行: `◷ 9.5s · ↑ ≈108 t/s · ⏱ 12m 3s` —— **只出现有真值的段**
    ///
    /// 三个数都是真的: 回合耗时 (`usage` 前后夹出来的墙钟) · 输出速率
    /// (`completion_tokens / 耗时`) · 会话持续时间 (会话创建到现在)。
    /// 没数据就空着 (不摆 0 冒充"我知道")。
    pub fn render_metrics_row(&self, cols: usize) -> String {
        let budget = cols.max(8);
        let mut segs: Vec<String> = vec![];
        if self.stats.elapsed_ms >= 1000 {
            segs.push(format!(
                "{C_DIM}◷ {:.1}s{RESET}",
                self.stats.elapsed_ms as f64 / 1000.0
            ));
        }
        if self.stats.tps > 0 {
            segs.push(format!("{C_DIM}↑ ≈{} t/s{RESET}", self.stats.tps));
        }
        if let Some(t0) = self.session_started {
            segs.push(format!(
                "{C_DIM}⏱ {}{RESET}",
                fmt_dur(t0.elapsed().as_secs())
            ));
        }
        // 逐段加, 放不下就停 (顺序 = 重要性: ◷ → ↑ → ⏱)
        let mut out = String::new();
        for s in &segs {
            let cand = if out.is_empty() {
                s.clone()
            } else {
                join_segs(&[out.clone(), s.clone()])
            };
            if disp_width_safe(&cand) > budget {
                break;
            }
            out = cand;
        }
        out
    }

    /// 容量: 显式配置优先 (`BOLLOON_CTX_LIMIT`), 否则 0 = 未知
    fn ctx_limit(&self) -> u32 {
        if self.ctx_limit > 0 {
            return self.ctx_limit;
        }
        std::env::var(CTX_LIMIT_ENV)
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .filter(|n| *n > 0)
            .unwrap_or(0)
    }
}

fn join_segs(segs: &[String]) -> String {
    segs.iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(&format!("{C_MUTED} · {RESET}"))
}

/// 时长: `1h 02m` / `12m 3s` / `9s`
fn fmt_dur(secs: u64) -> String {
    if secs >= 3600 {
        format!("{}h {:02}m", secs / 3600, (secs % 3600) / 60)
    } else if secs >= 60 {
        format!("{}m {}s", secs / 60, secs % 60)
    } else {
        format!("{secs}s")
    }
}

/// 上下文用量段。
///
/// **容量只在真有值时才写分母**: 容量未知 ⇒ 只显示用量 (`ctx 3k`), 不编一个 1M 出来 ——
/// 把"未知"画成"知道"是这一行最容易犯的谎。容量来源 = 调用方给的 `ctx_limit` 或
/// 环境变量 `BOLLOON_CTX_LIMIT` (用户/供应商知道自己模型的窗口时才设)。
fn ctx_segment(tokens: u32, limit: u32) -> String {
    if limit == 0 {
        return format!("{C_DIM}ctx {}{RESET}", fmt_k(tokens));
    }
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
    /// Esc: 这一行不要了 (会话继续)
    Cancelled,
    /// Ctrl+C (空闲时): 退出会话 —— 调用方负责落盘
    Quit,
    /// Ctrl+D / 管道关闭
    Eof,
}

/// 补全候选项来源 (调用方注入: `/` 来自 `slash::specs`, `@` 来自 cwd, `!` 来自 shell 提示)
pub type ComplSource = dyn Fn(ComplKind, &str) -> Vec<ComplItem>;

/// 底部固定区域: 运行状态行 + 输入 composer + 模型/指标栏 (**交互界面的唯一渲染者**)
pub struct Chrome {
    pub rows: usize,
    pub cols: usize,
    pub activity: Activity,
    pub status: StatusBar,
    /// 空闲时状态行上的键位提示 (默认取 `help::HINT`)
    pub hint: String,
    /// 输入缓冲 + 光标 (**唯一真源**; 渲染只读它)
    compose: Compose,
    /// 一次性提示 (贴图/草稿/历史到底/中断)
    notes: Vec<String>,
    /// 补全状态 (纯推导: `recompute`)
    compl: Option<(ComplKind, usize, String)>,
    items: Vec<ComplItem>,
    sel: usize,
    /// 用户 Esc/Tab 关掉过 ⇒ 不再自动重开, 直到下一次编辑
    dismissed: bool,
    /// 生成期间收到、但当时不能插历史区的行 (流式面板在那儿长) —— 收尾统一上屏
    queued_history: Vec<String>,
    drawn: bool,
    /// 底栏上方**归我们所有的空白行** (流式预览块结束/收尾后留下的), 历史区可先复用它们,
    /// 不必滚屏 —— 不记这个数, 每帧要么借行要么擦白, 框与框之间就会留洞。
    tail_free: usize,
    /// 是否真的把硬件光标藏起来了 (非 TTY 路径从不藏 ⇒ 退出时也不许乱发 `\x1b[?25h`)
    cursor_hidden: bool,
    anim: usize,
    paste_seq: u32,
    /// **flow 布局**: `Some(下一空闲行)` = 内容还没满屏, 底栏跟在内容下方;
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
            hint: crate::help::HINT.to_string(),
            compose: Compose::new(vec![], ""),
            notes: Vec::new(),
            compl: None,
            items: Vec::new(),
            sel: 0,
            dismissed: false,
            queued_history: Vec::new(),
            drawn: false,
            tail_free: 0,
            cursor_hidden: false,
            anim: 0,
            paste_seq: 0,
            flow_top: None,
        }
    }

    /// 尺寸变了就跟着变 (历史已上屏的回不来, 底栏必须跟上 — 否则行宽全错)
    pub fn refresh_size(&mut self) -> bool {
        let (c, r) = (term_width(), term_height());
        let changed = c != self.cols || r != self.rows;
        self.cols = c;
        self.rows = r.max(RESERVED_LINES + 1);
        changed
    }

    pub fn is_drawn(&self) -> bool {
        self.drawn
    }

    /// 动画推进一帧 (思考颜文字)
    pub fn tick(&mut self) {
        self.anim = self.anim.wrapping_add(1);
    }

    /// 塞一段文本进输入缓冲 (光标到末尾) —— 回填 `/undo` `/retry` 用
    pub fn set_input(&mut self, s: &str) {
        self.compose.set_buf(&s.replace(['\r', '\t'], " "));
        self.dismissed = false;
    }

    pub fn input(&self) -> &str {
        self.compose.buf()
    }

    /// 一次性提示 (状态行显示; 下一条工具/思考会覆盖它)
    pub fn note(&mut self, s: impl Into<String>) {
        self.activity = Activity::Note(s.into());
    }

    /// 生成期间收到、但当时不能插历史区的行 —— 收尾时统一上屏
    pub fn queue_history_line(&mut self, s: String) {
        self.queued_history.push(s);
    }

    /// 取走攒下的历史行
    pub fn take_queued_history(&mut self) -> Vec<String> {
        std::mem::take(&mut self.queued_history)
    }

    // ────────────────────────── 几何 ──────────────────────────

    /// 一行可用的显示列数: **绝不写满整宽** (满宽 ⇒ 终端自动折行 ⇒ 底栏重复打印)
    fn cells(&self) -> usize {
        crate::screen::rule_cells(self.cols.saturating_sub(1))
    }

    /// 钉底时底栏顶行 (1-based)
    fn pinned_top(&self) -> usize {
        self.rows.saturating_sub(RESERVED_LINES) + 1
    }

    /// 底栏顶部行 (1-based)。
    ///
    /// flow 模式 (`flow_top = Some(下一空闲行)`): 底栏跟在内容**下一行**之下,
    /// 中间不隔整块空白; 内容一旦装不下就永久钉底。
    fn chrome_top(&self) -> usize {
        match self.flow_top {
            Some(r) => (r + 1).min(self.pinned_top()),
            None => self.pinned_top(),
        }
    }

    /// 进入 flow 布局: `row` = 第一条空闲行 (启动 dashboard 打印完之后调)
    pub fn set_flow_top(&mut self, row: usize) {
        self.flow_top = Some(row.max(1));
    }

    /// 流式面板的底边锚点 (底栏顶行的上一行) —— 面板从这里向上生长
    pub fn panel_anchor(&self) -> usize {
        self.chrome_top().saturating_sub(1).max(2)
    }

    /// flow 判定 (纯函数, 便于单测)
    fn flow_overflows(&self, n: usize) -> bool {
        match self.flow_top {
            None => true,
            Some(r) => {
                let last = r + n.saturating_sub(1);
                last + RESERVED_LINES > self.rows
            }
        }
    }

    // ────────────────────────── 渲染 (纯函数部分) ──────────────────────────

    /// 底部固定区域的一帧 —— **行数恒等于 `RESERVED_LINES`**
    pub fn render_block(&self) -> Vec<String> {
        vec![
            self.status_line(),
            self.composer_row(),
            self.rule_row(),
            self.model_row(),
            self.metrics_row(),
        ]
    }

    /// 运行状态行: `── (｀・ω・´) Thinking · 3.2s ────────────`
    ///
    /// 左侧状态词, 右侧用分隔线填满 (与 Hermes 的 `── ⠸ Working… ────` 同构)。
    /// 补全打开时这一行改成候选条 —— 不另开浮层, 行数不变。
    fn status_line(&self) -> String {
        let cells = self.cells();
        let head: String = match (&self.compl, self.items.get(self.sel)) {
            (Some(_), Some(it)) => {
                let hint = it.hint.clone().unwrap_or_default();
                let mut s = format!("→ {}", it.label);
                if !hint.is_empty() {
                    s.push_str("  ");
                    s.push_str(&hint);
                }
                s.push_str(&format!(
                    " · {}/{} · Tab 接受 · Esc 关闭",
                    self.sel + 1,
                    self.items.len().max(1)
                ));
                format!("{C_ACCENT}{s}{RESET}")
            }
            (Some(_), None) => format!("{C_ACCENT}→ 没有匹配候选 · Esc 关闭{RESET}"),
            (None, _) => match &self.activity {
                Activity::Idle => {
                    let text = if self.notes.is_empty() {
                        if self.hint.is_empty() {
                            crate::help::HINT.to_string()
                        } else {
                            self.hint.clone()
                        }
                    } else {
                        self.notes.join(" · ")
                    };
                    format!("{C_DIM}{text}{RESET}")
                }
                Activity::Thinking { started, chars } => {
                    let frames = crate::loading::LOADING_FRAMES;
                    let kaomoji = frames[self.anim % frames.len()];
                    let secs = started.elapsed().as_millis() as f64 / 1000.0;
                    let label = crate::loading::shimmer("Thinking · 正在生成", self.anim);
                    // 已吐字就给字数 (比"流式输出中"这句套话有用): 用户能看出模型在动
                    let tail = if *chars > 0 {
                        format!("· {secs:.1}s · {chars} 字")
                    } else {
                        format!("· {secs:.1}s · 等待首字")
                    };
                    format!("{C_WARN}{kaomoji}{RESET} {label} {C_DIM}{tail}{RESET}")
                }
                Activity::Tool { name, started } => {
                    let frames = crate::loading::LOADING_FRAMES;
                    let kaomoji = frames[self.anim % frames.len()];
                    let secs = started.elapsed().as_millis() as f64 / 1000.0;
                    format!("{C_WARN}{kaomoji}{RESET} {name} {C_DIM}· {secs:.1}s · 执行中{RESET}")
                }
                Activity::Note(n) => format!("{C_DIM}{n}{RESET}"),
            },
        };
        // 形状 = `── ` + 文本 + ` ` + 填充线; 填充线至少 2 列 ⇒ 文本预算 = cells-6
        let plain = crate::width::strip_ansi(&head);
        let text = truncate_safe(&plain, cells.saturating_sub(6).max(4));
        let fill = cells.saturating_sub(disp_width(&text) + 4).max(2);
        format!(
            "{C_BORDER_BRIGHT}──{RESET} {C_DIM}{text}{RESET} {C_BORDER_BRIGHT}{}{RESET}",
            "─".repeat(fill)
        )
    }

    /// 输入行: `❯ <缓冲>`; 空缓冲显示引导文案, 有内容立刻消失
    fn composer_row(&self) -> String {
        let cells = self.cells();
        if self.compose.buf().is_empty() {
            return format!(
                "{C_ACCENT}{PROMPT}{RESET}{C_MUTED}{}{RESET}",
                truncate_safe(PLACEHOLDER, cells.saturating_sub(disp_width(PROMPT)))
            );
        }
        editor_row(PROMPT, self.compose.buf(), self.compose.cursor(), cells, true)
    }

    /// 分隔线 (模型栏上方那一条) —— 满宽实线, 但绝不写满整宽
    fn rule_row(&self) -> String {
        format!("{C_BORDER_BRIGHT}{}{RESET}", "─".repeat(self.cells()))
    }

    /// 模型行: `◉ model · ctx · ⚙ n` + 右对齐 `▸ 会话标题`
    fn model_row(&self) -> String {
        let cells = self.cells();
        let body = self.status.render_model_row(cells.saturating_sub(2));
        format!(
            "{C_ACCENT}◉{RESET} {}",
            pad_to_width(&body, cells.saturating_sub(2))
        )
    }

    /// 指标行: `◷ 9.5s · ↑ ≈108 t/s · ⏱ 12m 3s` (没数据就空一行占位)
    fn metrics_row(&self) -> String {
        let cells = self.cells();
        let s = self.status.render_metrics_row(cells);
        if s.trim().is_empty() {
            return " ".to_string(); // 空行也要占一格: 否则帧高少一行
        }
        pad_to_width(&s, cells)
    }

    // ────────────────────────── 屏上写入 (唯一出口) ──────────────────────────

    /// 画底部固定区域: **绝对行号 + 整行擦**, 每帧行数与行号完全一致 ⇒ 永不漂移、永不堆叠
    pub fn draw(&mut self) {
        self.refresh_size();
        let block = self.render_block();
        let top = self.chrome_top();
        let mut out = String::new();
        out.push_str(HIDE_CURSOR); // 光标由反显块表达, 免得硬件光标在别处闪
        for (i, line) in block.iter().enumerate() {
            out.push_str(&format!("\x1b[{}H\x1b[2K{}", top + i, line));
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
        self.drawn = true;
        self.cursor_hidden = true;
    }

    /// 擦掉底部区域 (要往历史里打印东西之前必须调, 否则文字会插进底栏)
    /// 擦掉从 `top` 起的整块底栏 (RESERVED_LINES 行)。
    ///
    /// 布局切换 (flow → 钉底) 时必须用它擦**老位置**: `clear()` 只认当前 `chrome_top()`,
    /// 一旦先把 `flow_top` 置 None, 擦的就是新位置, 老位置的底栏会留在屏上变成残影/洞
    /// (真机: "发消息后输入框和加载页面重复")。
    fn erase_block_at(&mut self, top: usize) {
        let mut out = String::new();
        for i in 0..RESERVED_LINES {
            out.push_str(&format!("\x1b[{}H\x1b[2K", top + i));
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
    }

    pub fn clear(&mut self) {
        if self.drawn {
            let top = self.chrome_top();
            let mut out = String::new();
            for i in 0..RESERVED_LINES {
                out.push_str(&format!("\x1b[{}H\x1b[2K", top + i));
            }
            out.push_str(SHOW_CURSOR);
            print!("{out}");
            let _ = std::io::stdout().flush();
            self.drawn = false;
            self.cursor_hidden = false;
        }
    }

    /// 往历史区追加 (先擦底栏 → 打印 → 重画底栏)。
    ///
    /// flow 模式下内容还**装得下** ⇒ 就地打印在 `flow_top`, 底栏跟着下移;
    /// 装不下 ⇒ 永久切换到钉底滚动模式 (终端自然上滚, 底栏行号恒定)。
    pub fn print_above(&mut self, lines: &[String]) {
        if lines.is_empty() {
            return;
        }
        // 历史按行精确入列: 带 `\n` 的整块先摊平 (否则行数算错 ⇒ 底栏被顶歪)
        let flat: Vec<String> = lines
            .iter()
            .flat_map(|l| l.split('\n').map(|s| s.to_string()))
            .collect();
        if flat.is_empty() {
            return;
        }
        if !self.flow_overflows(flat.len()) {
            let r = self.flow_top.unwrap_or(1);
            let last = r + flat.len() - 1;
            self.clear();
            print!("\x1b[{r}H");
            let _ = std::io::stdout().flush();
            for l in &flat {
                println!("{}", clamp_line(l, self.cells()));
            }
            self.flow_top = Some(last + 1);
            self.draw();
            return;
        }
        // 装不下 ⇒ 钉底 (本会话剩余时间都用滚动路径)。
        // **先擦老位置**, 再切布局: 否则老底栏留在屏上, 新底栏画在下面 ⇒ 两套并存。
        let old_top = self.chrome_top();
        self.flow_top = None;
        if self.drawn {
            self.erase_block_at(old_top);
            self.drawn = false;
        }
        self.clear();
        // 历史区底行 = 底栏顶行的上一行。
        // **先复用归我们自己的空白行** (流式预览块收尾留下的), 不够的部分才滚屏 ——
        // 无脑滚 n 行会把那几行空白顶上去变成洞 (真机"框里有大量空白")。
        let bottom = self.chrome_top().saturating_sub(1).max(1);
        let reuse = self.tail_free.min(flat.len());
        self.tail_free -= reuse;
        self.scroll_history(flat.len() - reuse);
        // 打印起点: 优先**接着刚擦掉的老底栏位置**往下排 (老位置就在历史区里),
        // 只有内容比这块空间更高时才退回"贴着历史区底部"排 —— 否则框与框之间留白洞。
        let pinned_top = (bottom + 1).saturating_sub(flat.len()).max(1);
        let top = if old_top + flat.len() <= bottom + 1 {
            old_top.max(1)
        } else {
            pinned_top
        };
        print!("\x1b[{};1H", top);
        let _ = std::io::stdout().flush();
        for l in &flat {
            println!("{}", clamp_line(l, self.cells()));
        }
        self.draw();
    }

    /// 让终端**整体上滚 `n` 行** (内容进 scrollback, 不会被擦掉)。
    ///
    /// 为什么需要它: 钉底模式下要往历史区追加内容, 而历史区已经被上屏内容占满。
    /// 老写法"在 chrome_top-1 处打印 n 行"**不会**触发滚动 (最后一行正好落在终端末行),
    /// 打印完再画底栏 ⇒ 刚打印的行被底栏盖掉 —— 真机上表现为"发出去的消息框不见了"。
    /// 正确做法是先滚 n 行腾出位置, 再打在历史区底部。
    pub fn scroll_history(&mut self, n: usize) {
        if n == 0 {
            return;
        }
        let mut out = format!("\x1b[{};1H", self.rows.max(1));
        for _ in 0..n {
            out.push('\n');
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
    }

    /// 给流式预览**预留** `h` 行: 先把终端滚 h 行腾出来, 这 h 行从此归预览块所有。
    ///
    /// 这是"修洞"的关键: 预览块**不再向上借历史行** (借来的行收尾时只能擦白),
    /// 而是自己占一段固定行数; 结束后整段交给历史区复用 (`tail_free`)。
    /// 返回 false = 这次**没用**预览块 (还在 flow 布局: 上方就是刚打印的用户框,
    /// 借行会把它盖住) —— 调用方改在状态行报进度即可。
    pub fn reserve_stream(&mut self, h: usize) -> bool {
        if h == 0 || self.flow_top.is_some() {
            return false;
        }
        self.scroll_history(h);
        self.tail_free = self.tail_free.max(h);
        true
    }

    /// 就地重画流式预览块 (行数 = 传进来的行数, 底边贴着底栏)
    pub fn draw_stream(&mut self, frame: &[String]) {
        if frame.is_empty() {
            return;
        }
        let top = self.chrome_top().saturating_sub(frame.len()).max(1);
        let mut out = String::new();
        for (i, line) in frame.iter().enumerate() {
            out.push_str(&format!("\x1b[{}H\x1b[2K{}", top + i, line));
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
    }

    /// 预览块收尾: 擦成空白并把这几行**记成可复用** (不还回去就会变成洞)
    pub fn end_stream(&mut self) {
        let h = crate::stream::STREAM_ROWS;
        let top = self.chrome_top().saturating_sub(h).max(1);
        let mut out = String::new();
        for i in 0..h {
            out.push_str(&format!("\x1b[{}H\x1b[2K", top + i));
        }
        print!("{out}");
        let _ = std::io::stdout().flush();
        self.tail_free = self.tail_free.max(h);
    }

    /// 硬清屏 (对齐 `/clear` `/redraw`); 清完回到 flow 布局
    pub fn reset_screen(&mut self) {
        print!("\x1b[2J\x1b[H");
        let _ = std::io::stdout().flush();
        self.drawn = false;
        self.flow_top = Some(1);
    }

    // ────────────────────────── 输入循环 ──────────────────────────

    /// 读一行 (**底部固定 composer**: 多行缓冲 + 光标 + `/ @ !` 补全 + 草稿 + 贴图)。
    ///
    /// 与旧实现的关键差别: 这里**不自己画帧**。每次按键只改状态, 然后让 `draw()` 用绝对
    /// 行号重画同一块固定区域 —— 打字时行数/行号一字不动, 也不可能留下旧横线
    /// (旧实现是相对位移 + 尾随换行 ⇒ 每次少上移一行 ⇒ 上一帧第一行永远擦不掉)。
    pub fn read_compose(
        &mut self,
        history: &[String],
        initial: &str,
        source: &ComplSource,
    ) -> InputOutcome {
        self.compose = Compose::new(history.to_vec(), initial);
        self.notes.clear();
        self.dismissed = false;
        self.recompute(source);
        self.refresh_size();
        self.draw();

        loop {
            // 生成期间被 interrupt watcher 读走、但**不是** Ctrl+C 的按键: 先补回来,
            // 不能让"边等边打字"丢字 (那是 watcher 唯一的副作用, 必须还给它)
            let pending = crate::input::take_pending();
            let bytes = if !pending.is_empty() {
                pending
            } else {
                match read_key_raw() {
                    Some(b) => b,
                    None => {
                        self.clear();
                        return InputOutcome::Eof;
                    }
                }
            };
            if bytes.is_empty() {
                // 只被缩放了 (没有按键): 按新尺寸重算底栏并重绘
                self.refresh_size();
                self.draw();
                continue;
            }
            for key in parse_keys(&bytes) {
                let mut repaint = true;
                match resolve_action(&key) {
                    EditAction::Submit => {
                        if self.compl.is_some() {
                            // 补全打开时 Enter = 接受候选, **不提交** (再按一次 Enter 才发)
                            self.accept(source);
                            self.dismissed = true;
                        } else {
                            let text = self.compose.buf().to_string();
                            self.clear();
                            self.notes.clear();
                            return InputOutcome::Line(self.fold_long_paste(&text).unwrap_or(text));
                        }
                    }
                    EditAction::Accept => {
                        if self.compl.is_some() {
                            self.accept(source);
                            self.dismissed = true;
                        } else {
                            repaint = false;
                        }
                    }
                    EditAction::Cancel => {
                        if self.compl.is_some() {
                            // Esc 先只收候选条, 不丢草稿
                            self.dismissed = true;
                        } else {
                            self.clear();
                            self.notes.clear();
                            return InputOutcome::Cancelled;
                        }
                    }
                    EditAction::Quit => {
                        // leo 口径: 空闲时 Ctrl+C **一次就退出** (运行中由 watcher 当"中断")
                        self.clear();
                        return InputOutcome::Quit;
                    }
                    EditAction::Eof => {
                        self.clear();
                        return InputOutcome::Eof;
                    }
                    EditAction::Newline => {
                        self.dismissed = true;
                        self.compose.newline();
                        self.notes.clear();
                    }
                    EditAction::Backspace => {
                        self.dismissed = false;
                        self.compose.backspace();
                        self.notes.clear();
                    }
                    EditAction::DeleteForward => {
                        self.dismissed = false;
                        self.compose.delete_forward();
                    }
                    EditAction::CursorLeft => self.compose.left(),
                    EditAction::CursorRight => self.compose.right(),
                    EditAction::LineHome => self.compose.line_home(),
                    EditAction::LineEnd => self.compose.line_end(),
                    EditAction::KillToLineStart => {
                        self.compose.kill_to_line_start();
                        self.notes.clear();
                    }
                    EditAction::Insert(c) => {
                        self.dismissed = false;
                        self.compose.insert(c);
                        self.notes.clear();
                    }
                    EditAction::HistoryPrev => {
                        if self.compose.history_prev() {
                            self.dismissed = false;
                            self.notes.clear();
                        } else {
                            self.notes = vec!["没有更早的历史".to_string()];
                        }
                    }
                    EditAction::HistoryNext => {
                        if self.compose.history_next() {
                            self.dismissed = false;
                            self.notes.clear();
                        } else {
                            self.notes = vec!["已经是最新一行".to_string()];
                        }
                    }
                    EditAction::OpenDraft => {
                        let notes = self.open_draft();
                        self.notes = notes;
                        self.dismissed = true;
                        // 编辑器占过屏 ⇒ 底栏位置未知, 直接按钉底重画
                        self.drawn = false;
                        self.flow_top = None;
                    }
                    EditAction::PasteImage => {
                        let notes = self.paste_image();
                        self.notes = notes;
                        self.dismissed = true;
                    }
                    EditAction::Ignore => repaint = false,
                }
                self.recompute(source);
                if repaint {
                    self.draw();
                }
            }
        }
    }

    /// 补全状态重算 (纯推导: 输入/关闭标志 → 候选)
    fn recompute(&mut self, source: &ComplSource) {
        if self.dismissed {
            self.compl = None;
            self.items.clear();
            self.sel = 0;
            return;
        }
        match detect_compl(self.compose.buf()) {
            Some((k, start, q)) => {
                let items = filter_items(&source(k, &q), &q);
                if self.sel >= items.len() {
                    self.sel = items.len().saturating_sub(1);
                }
                self.compl = Some((k, start, q));
                self.items = items;
            }
            None => {
                self.compl = None;
                self.items.clear();
                self.sel = 0;
            }
        }
    }

    /// 接受当前候选: 把触发符 + 查询那段替换成 `触发符+值`
    fn accept(&mut self, source: &ComplSource) {
        if let Some((k, start, q)) = &self.compl {
            if let Some(it) = self.items.get(self.sel) {
                let new = apply_compl(
                    self.compose.buf(),
                    *k,
                    *start,
                    q.chars().count(),
                    &it.value,
                );
                self.compose.set_buf(&new);
            }
        }
        self.recompute(source);
    }

    /// `Ctrl+G` —— 起 `$VISUAL` / `$EDITOR` 写草稿 (raw 模式临时交还终端)
    fn open_draft(&mut self) -> Vec<String> {
        let seed = self.compose.buf().to_string();
        let res = crate::input::with_raw_suspended(|| crate::input::compose_in_editor(&seed));
        match res {
            Ok(text) if text.trim().is_empty() => vec!["草稿是空的 · 保留原输入".to_string()],
            Ok(text) => {
                let lines = text.split('\n').count();
                self.compose.set_buf(&text);
                vec![format!("✓ 草稿已读入 · {lines} 行")]
            }
            Err(e) => vec![format!("✗ 草稿失败: {e} · 保留原输入")],
        }
    }

    /// `Alt+V` —— 贴剪贴板图片, 在光标处插入 `@<路径>`
    fn paste_image(&mut self) -> Vec<String> {
        crate::input::paste_image(&mut self.compose, false)
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

impl Drop for Chrome {
    fn drop(&mut self) {
        // 藏过才还 (非 TTY 路径压根没藏 ⇒ 不许往管道里塞光标控制序列)
        if self.cursor_hidden {
            print!("{SHOW_CURSOR}");
            let _ = std::io::stdout().flush();
        }
    }
}

const HIDE_CURSOR: &str = "\x1b[?25l";
const SHOW_CURSOR: &str = "\x1b[?25h";

/// 一行打印前的兜底: 带 ANSI 的按显示宽度剪裁 (不切转义序列)
fn clamp_line(line: &str, cells: usize) -> String {
    if disp_width(line) <= cells {
        return line.to_string();
    }
    truncate_safe(&crate::width::strip_ansi(line), cells)
}

/// 粘贴落盘目录: `~/.bolloon/pastes` (与 TS 同路径)
fn paste_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var("BOLLOON_HOME")
        .map(std::path::PathBuf::from)
        .ok()
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| std::path::PathBuf::from(h).join(".bolloon"))
        })?;
    Some(home.join("pastes"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_is_always_five_lines() {
        let c = Chrome::new(30, 100);
        assert_eq!(c.render_block().len(), RESERVED_LINES);
        assert_eq!(RESERVED_LINES, 5, "运行状态行 1 + 输入 1 + 分隔/模型/指标 3");
    }

    /// 帧高恒定的**机器判据**: 不管缓冲多长/状态多满, 都是 RESERVED_LINES 行
    #[test]
    fn frame_height_never_changes_while_typing() {
        let mut c = Chrome::new(30, 100);
        for i in 0..100 {
            c.set_input(&"你".repeat(i % 40));
            assert_eq!(c.render_block().len(), RESERVED_LINES, "第 {i} 次输入");
        }
        c.status.model = "kimi-k3".into();
        c.status.title = "一段很长的会话标题".into();
        c.status.stats = TurnStats {
            ctx_tokens: 3000,
            elapsed_ms: 9500,
            tps: 1,
            tools: 0,
        };
        assert_eq!(c.render_block().len(), RESERVED_LINES);
    }

    /// `❯` 固定在输入行起始位置, 输入从固定列开始
    #[test]
    fn prompt_sits_at_a_fixed_place() {
        let mut c = Chrome::new(30, 100);
        for s in ["", "你", "你好世界", &"x".repeat(200)] {
            c.set_input(s);
            let row = crate::width::strip_ansi(&c.render_block()[1]);
            assert!(row.starts_with("❯ "), "输入行必须以 `❯ ` 起头: {row:?}");
            assert!(disp_width(&row) <= c.cells(), "输入行不许超宽: {row:?}");
        }
    }

    /// 逐字输入不累积: 每帧的横线只有固定那几条 (老实现每键留一条顶线)
    #[test]
    fn typing_does_not_accumulate_rule_lines() {
        let mut c = Chrome::new(30, 100);
        let baseline = c
            .render_block()
            .iter()
            .filter(|l| crate::width::strip_ansi(l).contains('─'))
            .count();
        for i in 0..100 {
            c.set_input(&"你可以看到".chars().take(i % 5 + 1).collect::<String>());
            let rules = c
                .render_block()
                .iter()
                .filter(|l| crate::width::strip_ansi(l).contains('─'))
                .count();
            assert_eq!(rules, baseline, "第 {i} 次输入后横线条数变了: {rules} vs {baseline}");
        }
    }

    /// 区域里没有一行写满整宽 (满宽 ⇒ 终端折行 ⇒ 底栏重复打印)
    #[test]
    fn no_line_ever_hits_terminal_width() {
        for cols in [20usize, 40, 80, 120] {
            let mut c = Chrome::new(30, cols);
            c.set_input("这是一条很长很长的输入用来把输入行撑到超宽看看会不会折行");
            c.status.model = "deepseek-v4-flash".into();
            c.status.title = "一个很长很长的会话标题不该把行撑爆".into();
            c.status.stats = TurnStats {
                ctx_tokens: 320_000,
                elapsed_ms: 1234,
                tps: 42,
                tools: 3,
            };
            for line in c.render_block() {
                let real = disp_width(&line);
                assert!(real <= c.cells(), "超宽({real} > {}): {line:?}", c.cells());
                assert!(real < cols, "不许写满整宽({real} ≥ {cols}): {line:?}");
            }
        }
    }

    /// 补全候选条占**运行状态行**那同一行 (不额外开浮层, 行数不变)
    #[test]
    fn completion_bar_uses_the_status_line() {
        let mut c = Chrome::new(30, 100);
        c.set_input("/he");
        c.compl = Some((ComplKind::Slash, 0, "he".into()));
        c.items = vec![ComplItem {
            label: "/help".into(),
            value: "help".into(),
            hint: Some("看全部命令".into()),
        }];
        let block = c.render_block();
        assert_eq!(block.len(), RESERVED_LINES);
        let head = crate::width::strip_ansi(&block[0]);
        assert!(head.contains("/help"), "候选要在状态行: {head:?}");
        assert!(
            head.contains("Tab 接受"),
            "键位不能因为候选条消失: {head:?}"
        );
    }

    /// flow 布局: 底栏跟在内容下一行
    #[test]
    fn flow_mode_keeps_chrome_right_below_content() {
        let mut c = Chrome::new(24, 80);
        assert_eq!(c.chrome_top(), 20, "默认钉底: 24-5+1");
        c.set_flow_top(5);
        assert_eq!(c.chrome_top(), 6, "底栏紧跟内容下一行");
        assert!(!c.flow_overflows(3));
        assert!(c.flow_overflows(18), "5..22 打印 18 行 + 5 行底栏装不下");
    }

    #[test]
    fn flow_mode_caps_at_pinned_top() {
        let mut c = Chrome::new(24, 80);
        c.set_flow_top(100);
        assert_eq!(c.chrome_top(), 20, "越过钉底线 ⇒ 回到钉底位置");
    }

    #[test]
    fn reset_screen_returns_to_flow_layout() {
        let mut c = Chrome::new(24, 80);
        c.set_flow_top(10);
        c.reset_screen();
        assert_eq!(c.flow_top, Some(1), "清屏后内容从顶部重新生长");
    }

    /// 模型行字段语义: 模型 / 智能体 / 真用量 / 工具数 / 语义标题
    #[test]
    fn model_row_is_padded_to_full_width() {
        let mut c = Chrome::new(30, 100);
        c.status.model = "kimi-k3".into();
        c.status.agent = "default".into();
        c.status.title = "你可以看到 Rust 项目的 CLI 吗".into();
        c.status.stats = TurnStats {
            ctx_tokens: 3000,
            tools: 0,
            ..Default::default()
        };
        let raw = c.render_block()[3].clone();
        let plain = crate::width::strip_ansi(&raw);
        assert_eq!(disp_width(&plain), c.cells(), "模型行必须占满整行宽: {plain:?}");
        assert!(plain.starts_with("◉ kimi-k3"), "{plain}");
        assert!(plain.contains("@default"), "{plain}");
        assert!(plain.contains("ctx 3k"), "用量是真的就显示: {plain}");
        assert!(!plain.contains("1M"), "容量没真值就不许编分母: {plain}");
        assert!(plain.contains("⚙ 0"), "{plain}");
        assert!(plain.contains("▸ 你可以看到 Rust 项目的 CLI 吗"), "{plain}");
    }

    /// 指标行字段语义: 真耗时 / 真速率 / 真会话时长
    #[test]
    fn metrics_row_carries_real_numbers() {
        let mut c = Chrome::new(30, 140);
        c.status.model = "m".into();
        c.status.stats = TurnStats {
            ctx_tokens: 3000,
            elapsed_ms: 9500,
            tps: 108,
            tools: 0,
        };
        c.status.session_started = Some(Instant::now());
        let plain = crate::width::strip_ansi(&c.render_block()[4]);
        assert!(plain.contains("◷ 9.5s"), "{plain}");
        assert!(plain.contains("↑ ≈108 t/s"), "{plain}");
        assert!(plain.contains("⏱"), "会话时长是真的就显示: {plain}");
    }

    /// 给了真实容量才画 `303k/1M` 与进度条 (否则只说 ctx 303k)
    #[test]
    fn ctx_bar_only_when_capacity_is_known() {
        let mut c = Chrome::new(30, 140);
        c.status.model = "m".into();
        c.status.stats = TurnStats {
            ctx_tokens: 303_000,
            ..Default::default()
        };
        let unknown = crate::width::strip_ansi(&c.status.render_model_row(140));
        assert!(unknown.contains("ctx 303k"), "{unknown}");
        assert!(!unknown.contains('█'), "容量未知不许画进度条: {unknown}");

        c.status.ctx_limit = 1_000_000;
        let known = crate::width::strip_ansi(&c.status.render_model_row(140));
        assert!(known.contains("303k/1M"), "{known}");
        assert!(known.contains('█') && known.contains('░'), "容量已知就画条: {known}");
        assert!(known.contains("30%"), "{known}");
    }

    /// 没调过模型 ⇒ 不许出现速率/耗时/用量段 (别用 0 冒充)
    #[test]
    fn rows_omit_segments_without_data() {
        let mut c = Chrome::new(30, 140);
        c.status.model = "m".into();
        let model = crate::width::strip_ansi(&c.status.render_model_row(140));
        let metrics = crate::width::strip_ansi(&c.status.render_metrics_row(140));
        assert!(!model.contains("t/s"), "{model}");
        assert!(!model.contains("◷"), "{model}");
        assert!(!model.contains("ctx"), "{model}");
        assert!(model.contains("⚙ 0"), "工具数常显 (0 是真的 0): {model}");
        assert!(metrics.trim().is_empty(), "没数据就空着: {metrics:?}");
    }

    /// 窄屏丢段: 模型名永不丢
    #[test]
    fn model_never_dropped_on_narrow_screen() {
        let mut c = Chrome::new(30, 60);
        c.status.model = "m".into();
        c.status.stats = TurnStats {
            ctx_tokens: 320_000,
            elapsed_ms: 2000,
            tps: 88,
            tools: 7,
        };
        let wide = crate::width::strip_ansi(&c.status.render_model_row(120));
        assert!(wide.contains("ctx"), "宽屏要显示用量: {wide}");
        assert!(wide.contains("⚙ 7"), "工具数常显: {wide}");
        let narrow = crate::width::strip_ansi(&c.status.render_model_row(6));
        assert!(narrow.contains('m'), "模型永不丢: {narrow}");
    }

    #[test]
    fn thinking_activity_shows_kaomoji_and_elapsed() {
        let mut c = Chrome::new(30, 80);
        c.activity = Activity::Thinking {
            started: Instant::now(),
            chars: 0,
        };
        let line = crate::width::strip_ansi(&c.status_line());
        assert!(line.contains("Thinking"), "{line}");
        assert!(line.contains('s'), "要有秒表: {line}");
        assert!(line.contains("等待首字"), "还没吐字时如实说: {line}");

        c.activity = Activity::Thinking {
            started: Instant::now(),
            chars: 42,
        };
        let line = crate::width::strip_ansi(&c.status_line());
        assert!(line.contains("42 字"), "有字数就报字数: {line}");
        assert!(line.starts_with("──"), "状态行要有 Hermes 那种起头线: {line}");
    }

    /// 空输入给引导文案, 有内容立刻消失
    #[test]
    fn placeholder_disappears_once_typing_starts() {
        let mut c = Chrome::new(30, 100);
        let empty = crate::width::strip_ansi(&c.render_block()[1]);
        assert!(empty.contains('❯'), "{empty}");
        assert!(empty.contains("输入消息"), "{empty}");
        c.set_input("你");
        let typed = crate::width::strip_ansi(&c.render_block()[1]);
        assert!(
            !typed.contains("输入消息"),
            "有内容就不该还有引导文案: {typed}"
        );
        assert!(typed.starts_with("❯ 你"), "{typed}");
    }

    /// 帧里永远是这几块: 状态行 / 输入 / 分隔线 / 模型 / 指标
    #[test]
    fn frame_regions_are_in_a_fixed_order() {
        let c = Chrome::new(30, 100);
        let b: Vec<String> = c
            .render_block()
            .iter()
            .map(|l| crate::width::strip_ansi(l))
            .collect();
        assert!(b[0].starts_with("──"), "0 = 运行状态行: {:?}", b[0]);
        assert!(b[1].starts_with("❯ "), "1 = 输入 composer: {:?}", b[1]);
        assert!(b[2].chars().all(|c| c == '─'), "2 = 分隔线: {:?}", b[2]);
        assert!(b[3].starts_with("◉ "), "3 = 模型行: {:?}", b[3]);
        assert_eq!(b.len(), 5);
    }

    /// 多行缓冲: 输入区仍是 1 行, 但如实标出上面有几行
    #[test]
    fn multiline_buffer_folds_into_the_single_input_row() {
        let mut c = Chrome::new(30, 100);
        c.set_input("第一行\n第二行");
        let line = crate::width::strip_ansi(&c.render_block()[1]);
        assert!(line.contains("第二行"), "光标所在行可见: {line}");
        assert!(line.contains("…1行"), "上面还有 1 行要标: {line}");
    }
}
