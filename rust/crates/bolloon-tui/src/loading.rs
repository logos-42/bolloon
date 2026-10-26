//! loading.rs — 原地刷新的启动仪表盘
//!
//! **复用 TS 原文** `src/cli/loading-tui.ts` 的 `LoadingTUI` 与 `LOADING_FRAMES`。
//!
//! 2026-09-08 (Hermes TUI 学习): 帧序列**单一来源** —— TS 侧原来 `FRAMES` / `KAOMOJI` 两份拷贝会漂移,
//!   所以这里也只留一份, 思考动画与启动仪表盘共用。
//!
//! 三条与 TS 同一口径的纪律:
//!   ① 每次 draw **实时算宽度** (原首次缓存 → 启动中 resize 会让整框错位);
//!   ② 仪表盘区域行数 = 上边框 + 艺术字 + steps + spinner + 下边框, 靠它回退光标做**原地刷新**;
//!   ③ `stop()` 一定把光标**显示回来** (HIDE/SHOW 成对)。

use crate::boxart::{box_bottom, box_row, box_top, Align, SQ};
use crate::brand::{pick_banner, robot_head};
use crate::panel::status_symbol;
use crate::theme::{C_WARN, RESET};
use crate::width::{disp_width, term_width};

use std::io::Write;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/** 帧序列 (**单一来源**, 与 TS `LOADING_FRAMES` 逐字一致) */
pub const LOADING_FRAMES: [&str; 6] = [
    "(｀・ω・´)",
    "(´･_･`)",
    "(｡•́︿•̀｡)",
    "ᕙ(▀̿̿Ĺ̯̿̿▀̿ ̿)ᕗ",
    "(◕‿◕)",
    "ヽ(´▽｀)/",
];

const HIDE: &str = "\x1b[?25l";
const SHOW: &str = "\x1b[?25h";

#[derive(Debug, Clone)]
pub struct LoadingStep {
    pub label: String,
    /// pending | active | ok | warn | error
    pub status: String,
}

#[derive(Debug, Clone)]
struct Inner {
    steps: Vec<LoadingStep>,
    current: String,
    frame: usize,
    finished: bool,
    ok: bool,
}

/**
 * 框内艺术字: **装得下就上, 装不下就降档** (大 61 → 小 37 → 文字)。
 *
 * 与 `renderDashboard` 的 `useArt` 判据同一口径 —— TS 的 `LoadingTUI.draw` 那一版**没加这道闸**
 *   (80 列终端下 77 列艺术字塞进 74 列内宽 ⇒ 行被折成两截), 这里按 2026-09-30 定下的规矩补上。
 *   这是本模块对 TS 的**唯一一处**刻意偏离, 在文件头与台账里都写明了。
 */
/** 艺术字**最大**可能宽度 (机器人头 + 2 + 大号艺术字) —— 定宽度用, 不递归降档 */
fn max_art_width() -> usize {
    let icon = robot_head();
    let icon_w = icon.iter().map(|l| disp_width(l)).max().unwrap_or(1).max(1);
    let banner_w = crate::brand::bolloon_banner()
        .iter()
        .map(|l| disp_width(l))
        .max()
        .unwrap_or(0);
    icon_w + 2 + banner_w
}

fn art_for(steps: &[LoadingStep], current: &str) -> Vec<String> {
    let w = compute_width(steps, current);
    let inner = w.saturating_sub(4);
    let icon = robot_head();
    let icon_w = icon.iter().map(|l| disp_width(l)).max().unwrap_or(1).max(1);
    let budget = inner.saturating_sub(icon_w + 2);
    let banner = pick_banner(budget);
    let art: Vec<String> = (0..icon.len().max(banner.len()))
        .map(|i| {
            let il = icon.get(i).cloned().unwrap_or_default();
            let bl = banner.get(i).cloned().unwrap_or_default();
            let pad = icon_w.saturating_sub(disp_width(&il));
            format!("{il}{}{bl}", " ".repeat(pad + 2))
        })
        .collect();
    // 兜底: 即便降档后仍装不下 (极窄终端) ⇒ 宁可不画, 也不让它被折行
    let art_w = art.iter().map(|l| disp_width(l)).max().unwrap_or(0);
    if art_w <= inner {
        art
    } else {
        Vec::new()
    }
}

/** 仪表盘当前一帧 (**纯函数**, 可单测) — 与 TS `LoadingTUI.draw` 拼的内容逐行对齐 */
pub fn render_dashboard_frame(
    steps: &[LoadingStep],
    current: &str,
    frame_idx: usize,
    show_spinner: bool,
) -> String {
    let art = art_for(steps, current);
    let w = compute_width(steps, current);
    let mut out: Vec<String> = Vec::new();
    out.push(box_top("Bolloon Agent · 启动仪表盘", w, SQ));
    for l in &art {
        out.push(box_row(l, w, Align::Center, SQ));
    }
    for s in steps {
        out.push(box_row(&format!("{} {}", status_symbol(&s.status), s.label), w, Align::Left, SQ));
    }
    if show_spinner {
        let sp = format!("{C_WARN}{}{RESET}", LOADING_FRAMES[frame_idx % LOADING_FRAMES.len()]);
        out.push(box_row(&format!("{sp} {current}"), w, Align::Left, SQ));
    } else {
        out.push(box_row(&format!("{} Bolloon ready", status_symbol("ok")), w, Align::Left, SQ));
    }
    out.push(box_bottom(w, SQ));
    out.join("\n")
}

/** 仪表盘区域总行数: 上边框 + 艺术字 + steps + spinner + 下边框 (**原地刷新靠它回退光标**) */
pub fn region_lines(steps: &[LoadingStep], current: &str) -> usize {
    1 + art_for(steps, current).len() + steps.len() + 1 + 1
}

/** TS `computeWidth`: 每次实时算 (启动中 resize 也不会错位) */
pub fn compute_width(steps: &[LoadingStep], current: &str) -> usize {
    let cols = term_width();
    let max_cols = if cols > 30 { cols - 2 } else { 60 };
    let art_w = max_art_width();
    let mut needed = 40usize.max(art_w);
    for s in steps {
        needed = needed.max(s.label.chars().count() + 8);
    }
    needed = needed.max(current.chars().count() + 6);
    max_cols.min(needed + 4)
}

/**
 * 原地刷新的启动仪表盘。
 *
 * 用法与 TS 一致: `set_steps` → `start` → (`start_step` / `complete_step` / `set_message`) → `stop`。
 * 后台线程每 100ms 推进一帧 (与 TS `setInterval(…, 100)` 同频)。
 */
pub struct LoadingTui {
    inner: Arc<Mutex<Inner>>,
    tx: Option<Sender<()>>,
    handle: Option<JoinHandle<()>>,
}

impl LoadingTui {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                steps: Vec::new(),
                current: "Bolloon loading...".to_string(),
                frame: 0,
                finished: false,
                ok: true,
            })),
            tx: None,
            handle: None,
        }
    }

    /** 只渲染不打印 (测试 / 非终端用) */
    pub fn frame(&self, show_spinner: bool) -> String {
        let g = self.inner.lock().unwrap();
        render_dashboard_frame(&g.steps, &g.current, g.frame, show_spinner)
    }

    pub fn set_steps(&self, steps: &[&str]) {
        {
            let mut g = self.inner.lock().unwrap();
            g.steps = steps
                .iter()
                .map(|l| LoadingStep { label: (*l).to_string(), status: "pending".to_string() })
                .collect();
        }
        if self.tx.is_some() {
            self.draw(true);
        }
    }

    pub fn start_step(&self, index: usize, label: Option<&str>) {
        self.mutate_step(index, Some("active"), label);
    }

    pub fn complete_step(&self, index: usize, status: Option<&str>, label: Option<&str>) {
        self.mutate_step(index, status.or(Some("ok")), label);
    }

    fn mutate_step(&self, index: usize, status: Option<&str>, label: Option<&str>) {
        {
            let mut g = self.inner.lock().unwrap();
            if index >= g.steps.len() {
                return;
            }
            if let Some(s) = status {
                g.steps[index].status = s.to_string();
            }
            if let Some(l) = label {
                g.steps[index].label = l.to_string();
            }
        }
        if self.tx.is_some() {
            self.draw(true);
        }
    }

    pub fn set_message(&self, msg: &str) {
        {
            let mut g = self.inner.lock().unwrap();
            g.current = msg.to_string();
        }
        if self.tx.is_some() {
            self.draw(true);
        }
    }

    pub fn start(&mut self, msg: &str) {
        if self.tx.is_some() {
            return;
        }
        {
            let mut g = self.inner.lock().unwrap();
            g.current = msg.to_string();
        }
        print!("{HIDE}");
        let _ = std::io::stdout().flush();
        self.draw(true);

        let (tx, rx): (Sender<()>, Receiver<()>) = channel();
        self.tx = Some(tx);
        let inner = Arc::clone(&self.inner);
        let handle = std::thread::spawn(move || tick_loop(inner, rx));
        self.handle = Some(handle);
    }

    /** 收尾: 画最后一帧 (不带 spinner) 并把光标显示回来 */
    pub fn stop(&mut self, ok: bool) {
        {
            let mut g = self.inner.lock().unwrap();
            g.finished = true;
            g.ok = ok;
        }
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        self.draw(false);
        print!("{SHOW}");
        let _ = std::io::stdout().flush();
    }

    fn draw(&self, show_spinner: bool) {
        let (frame, up) = {
            let g = self.inner.lock().unwrap();
            (
                render_dashboard_frame(&g.steps, &g.current, g.frame, show_spinner),
                region_lines(&g.steps, &g.current),
            )
        };
        print!("{frame}\x1b[{up}A");
        let _ = std::io::stdout().flush();
    }

    pub fn is_finished(&self) -> bool {
        self.inner.lock().unwrap().finished
    }

    pub fn was_ok(&self) -> bool {
        self.inner.lock().unwrap().ok
    }
}

impl Default for LoadingTui {
    fn default() -> Self {
        Self::new()
    }
}

fn tick_loop(inner: Arc<Mutex<Inner>>, rx: Receiver<()>) {
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {
                let (frame, up, finished) = {
                    let mut g = inner.lock().unwrap();
                    if g.finished {
                        return;
                    }
                    g.frame += 1;
                    (
                        render_dashboard_frame(&g.steps, &g.current, g.frame, true),
                        region_lines(&g.steps, &g.current),
                        g.finished,
                    )
                };
                if finished {
                    return;
                }
                print!("{frame}\x1b[{up}A");
                let _ = std::io::stdout().flush();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 帧序列逐字对齐 TS `LOADING_FRAMES`
    #[test]
    fn frames_match_ts_verbatim() {
        assert_eq!(
            LOADING_FRAMES,
            [
                "(｀・ω・´)",
                "(´･_･`)",
                "(｡•́︿•̀｡)",
                "ᕙ(▀̿̿Ĺ̯̿̿▀̿ ̿)ᕗ",
                "(◕‿◕)",
                "ヽ(´▽｀)/",
            ]
        );
    }

    fn steps() -> Vec<LoadingStep> {
        vec![
            LoadingStep { label: "身份".into(), status: "ok".into() },
            LoadingStep { label: "记忆".into(), status: "active".into() },
            LoadingStep { label: "内核".into(), status: "pending".into() },
        ]
    }

    /// 帧行数 = 上边框 + 艺术字 + steps + spinner + 下边框 (**原地刷新靠它回退光标**)
    #[test]
    fn frame_line_count_is_stable() {
        let s = steps();
        let frame = render_dashboard_frame(&s, "加载中…", 0, true);
        assert_eq!(frame.lines().count(), region_lines(&s, "加载中…"));
        // 1 顶框 + N 艺术字 + 3 steps + 1 spinner + 1 底框
        assert_eq!(frame.lines().count(), 1 + art_for(&s, "加载中…").len() + 3 + 1 + 1);
    }

    /// 窄屏: 装不下大号艺术字就降档 (**绝不折行** —— 折行会把光标数学打乱, 整块重画)
    #[test]
    fn narrow_terminal_downgrades_art_not_wrap() {
        let _g = crate::width::test_lock().lock().unwrap();
        crate::width::set_term_size(40, 24);
        let s = steps();
        let frame = render_dashboard_frame(&s, "加载中…", 0, true);
        let widths: Vec<usize> = frame.lines().map(disp_width).collect();
        let first = widths[0];
        assert!(widths.iter().all(|w| *w == first), "窄屏下行宽不一致: {widths:?}");
        assert!(first <= 38, "帧宽不得超过 term_width()-2: {first}");
        crate::width::clear_term_size();
    }

    /// 帧里每一行宽度一致 (仪表盘不歪)
    #[test]
    fn frame_rows_are_uniform_width() {
        let _g = crate::width::test_lock().lock().unwrap();
        let s = steps();
        let frame = render_dashboard_frame(&s, "加载中…", 0, true);
        let widths: Vec<usize> = frame.lines().map(disp_width).collect();
        let first = widths[0];
        assert!(widths.iter().all(|w| *w == first), "{widths:?}");
    }

    /// 收尾帧带 `Bolloon ready`, 不再有 spinner
    #[test]
    fn final_frame_says_ready() {
        let s = steps();
        let frame = render_dashboard_frame(&s, "加载中…", 3, false);
        assert!(frame.contains("Bolloon ready"));
        assert!(!frame.contains(LOADING_FRAMES[3]));
    }

    /// 走完一轮生命周期: 帧内容真的跟着 steps 变
    #[test]
    fn lifecycle_updates_steps() {
        let t = LoadingTui::new();
        t.set_steps(&["身份", "记忆"]);
        t.start_step(0, None);
        let f = t.frame(true);
        assert!(f.contains("身份") && f.contains("⠹"), "active 状态要带 ⠹: {f:?}");
        t.complete_step(0, None, None);
        let f = t.frame(true);
        assert!(f.contains("身份") && f.contains("✓"), "ok 状态要带 ✓: {f:?}");
        t.set_message("收尾");
        assert!(t.frame(true).contains("收尾"));
    }
}
