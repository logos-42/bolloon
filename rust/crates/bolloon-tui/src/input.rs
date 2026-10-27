//! input.rs — raw 模式的行输入 + 终端状态 (草稿/贴图/中断监听)
//!
//! **复用 TS 原文** `src/cli/tui-select.ts` 的 `tuiAskLine` / `tuiAskMasked` 语义:
//!   · 屏幕上**只回显**输入 (掩码模式下只有 `•`), **不把明文写进任何日志/历史**
//!   · `Enter` 提交 · `Esc` / `Ctrl-C` 取消 · EOF (管道断了) 干净退出
//!   · ↑↓ 翻输入历史 (历史落盘见 `history.rs`)
//!
//! 2026-10-27 起**交互底栏的渲染不再在这里**: `chat` 的 composer 归 `app::Chrome`
//! (绝对行号 + 固定高度)。本文件只留"会被别的命令复用"的东西:
//!   · `ask_line` / `ask_masked` —— `bolloon model` 这类向导的一次性行输入;
//!   · `hold_raw_mode` —— 整段会话持 raw (提交后空档里抢先敲的键也要原样字节);
//!   · `with_raw_suspended` —— 起 `$EDITOR` / `pbcopy` 前把终端还回去;
//!   · `watch_interrupts` —— raw 模式下 `Ctrl+C` 不产生 SIGINT, 中断只能靠读键。

use crate::compose::{render_input, resolve_action, Compose, EditAction};
use crate::select::{parse_keys, read_key_raw};
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// 生成期间被 watcher 读走、但不是中断的按键 (预输入)。下一次读输入时原样补回。
static PENDING: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// 取走预输入字节 (空 = 没有)
pub fn take_pending() -> Vec<u8> {
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *g)
}

fn push_pending(bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    g.extend_from_slice(bytes);
    // 上限: 别让"一直等、一直打"把内存吃满 (超出部分丢最老的)
    const MAX: usize = 8192;
    if g.len() > MAX {
        let cut = g.len() - MAX;
        g.drain(..cut);
    }
}

/** 清到屏末 (重画输入块的起点) */
const ERASE_DOWN: &str = "\x1b[J";


/// 输入块最多占几行 (再多就留尾部 + `… (+N 行)`), 下限 1
pub const MAX_INPUT_LINES: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineResult {
    pub value: String,
    /// 输入流结束 (管道断了 / Ctrl-D)
    pub eof: bool,
    /// 用户主动取消 (Esc / Ctrl-C)
    pub cancelled: bool,
}

/// raw 模式的**可重入**状态: 深度 0→1 时记住原 termios, 回到 0 才恢复。
///
/// 为什么要可重入: `ask_line` 一返回就还原 cooked 的话, "提交后到下一次 `ask_line` 之间"
/// (画帧 + 等模型, 可能几百毫秒到几秒) 终端是 cooked 的 —— 这段时间**抢先敲的字**会走行规程:
/// `\r` 被 ICRNL 换成 `\n` (Enter 变换行 ⇒ 不提交), 没到换行前整行还压在 canonical 缓冲里
/// (两句并成一句)。这是机制上必然、时序上偶发, 所以 chat 循环整段持着 raw
/// (`hold_raw_mode`), `ask_line` 在里面再进一层, 谁都不提前还原。
struct RawState {
    depth: usize,
    orig: Option<libc::termios>,
}

static RAW: std::sync::Mutex<RawState> = std::sync::Mutex::new(RawState { depth: 0, orig: None });

fn lock_raw() -> std::sync::MutexGuard<'static, RawState> {
    RAW.lock().unwrap_or_else(|e| e.into_inner())
}

fn apply_raw(on: bool, orig: &Option<libc::termios>) -> bool {
    unsafe {
        match (on, orig.as_ref()) {
            (true, Some(base)) => {
                let mut t = *base;
                libc::cfmakeraw(&mut t);
                // **输出 post-processing 必须留回来**: cfmakeraw 把 OPOST|ONLCR 也清了,
                // 于是 `\n` 只下移不回第 0 列 ⇒ 所有 println! 打出来是阶梯状
                // (真机: 用户消息框 `╭─ ✓ 已发送 ─╮` 的边框和正文一路右移)。
                // 这是 eprintln 与「绝对行号绘制」都依赖的前提, 拆掉它就全歪。
                t.c_oflag |= libc::OPOST | libc::ONLCR;
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &t) == 0
            }
            (false, Some(base)) => {
                libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, base) == 0
            }
            _ => false,
        }
    }
}

struct RawGuard {
    /// 这一层是否真的拿到了 raw (非 TTY ⇒ false, 调用方走排队读一行)
    entered: bool,
}

impl RawGuard {
    fn enable() -> Self {
        let mut st = lock_raw();
        if st.depth == 0 {
            unsafe {
                let mut t: libc::termios = std::mem::zeroed();
                if libc::tcgetattr(libc::STDIN_FILENO, &mut t) != 0 {
                    return Self { entered: false };
                }
                st.orig = Some(t);
            }
            if !apply_raw(true, &st.orig) {
                st.orig = None;
                return Self { entered: false };
            }
        }
        st.depth += 1;
        Self { entered: true }
    }
    fn is_raw(&self) -> bool {
        self.entered
    }
    /** 临时交还终端 (起 `$EDITOR` 前必须调; 否则 vim 收不到回车) */
    fn suspend(&mut self) {
        if self.entered {
            let st = lock_raw();
            apply_raw(false, &st.orig);
        }
    }
    /** 编辑器回来后再进入 raw 模式 (与 `enable` 同一套参数) */
    fn resume(&mut self) {
        if self.entered {
            let st = lock_raw();
            apply_raw(true, &st.orig);
        }
    }
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        if !self.entered {
            return;
        }
        let mut st = lock_raw();
        if st.depth > 0 {
            st.depth -= 1;
        }
        if st.depth == 0 {
            apply_raw(false, &st.orig); // 最后一层退出才还原
        }
    }
}

/**
 * 整段会话持有 raw 模式 (chat 循环用)。
 *
 * 拿住它就别在中间还原终端 —— 提交后的空档里用户敲的键必须是**原样字节**,
 * 否则 `\r` 会被 cooked 模式换成 `\n`、多条输入并成一条 (真机踩过, 见 `RawState` 注释)。
 */
pub fn hold_raw_mode() -> impl Drop {
    RawGuard::enable()
}

/**
 * 临时把终端还回去 (起 `$EDITOR` / `pbcopy` / 外部进程之前必须调)。
 *
 * 与 `RawGuard::suspend` 的区别: 这里不需要那个 guard 实例 —— `chat` 会话的 raw 是
 * `hold_raw_mode()` 拿着的, `Chrome` 里拿不到它。做法是直接按**全局深度**判: 有会话在持
 * raw 就先还原 termios, 干完事再按同一套参数进入 raw (深度不变)。
 */
pub fn with_raw_suspended<T>(f: impl FnOnce() -> T) -> T {
    {
        let st = lock_raw();
        if st.depth > 0 {
            apply_raw(false, &st.orig);
        }
        let _ = &st;
    }
    let out = f();
    {
        let st = lock_raw();
        if st.depth > 0 {
            apply_raw(true, &st.orig);
        }
    }
    out
}

/**
 * 运行期间的中断监听 (raw 模式下 `Ctrl+C` **不产生 SIGINT** —— `cfmakeraw` 关掉了 `ISIG`,
 * 所以 `tokio::signal::ctrl_c` 在整个会话里是聋的, 中断只能靠**读键**)。
 *
 * 用法: 等模型/等工具的那段里 `let w = watch_interrupts(cancel.clone());` 然后
 * `select!` 里等 `w.recv()`; 收到就当作"用户要中断这一回合", drop 它即停。
 *
 * 纪律:
 *   · 只在**没有别的读者**的时候建 (输入框读键时不能同时有两个读者, 会把击键吞掉);
 *   · 只认 `Ctrl+C` (0x03) —— 运行期的"中断"就这一个键, 不猜别的;
 *   · **不是 Ctrl+C 的字节全部进预输入缓冲** (`take_pending`), 下一次读输入时补回去 ——
 *     否则"边等模型边打字"会被吃掉 (实打实的丢字);
 *   · 线程用 `poll(100ms)` 睡觉, 不是阻塞 read ⇒ drop 后 100ms 内必退, 不留孤儿线程。
 */
pub struct InterruptWatch {
    stop: Arc<AtomicBool>,
    rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl InterruptWatch {
    /// 等一次中断请求 (没有请求就永远 pending)
    pub async fn recv(&mut self) {
        let _ = self.rx.recv().await;
    }
}

impl Drop for InterruptWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

/// 起一个中断监听 (见 `InterruptWatch`); 命中时**同时**置 `cancel`, 让正在跑的工具/命令也收到
pub fn watch_interrupts(cancel: Arc<AtomicBool>) -> InterruptWatch {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let stop_thread = Arc::clone(&stop);
    let handle = std::thread::spawn(move || {
        while !stop_thread.load(Ordering::Relaxed) {
            let mut pfd = libc::pollfd {
                fd: libc::STDIN_FILENO,
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe { libc::poll(&mut pfd, 1, 100) };
            if ready <= 0 {
                continue; // 超时/被信号打断: 回去看 stop 标志
            }
            let mut buf = [0u8; 32];
            let n = unsafe {
                libc::read(
                    libc::STDIN_FILENO,
                    buf.as_mut_ptr() as *mut libc::c_void,
                    buf.len(),
                )
            };
            if n <= 0 {
                continue;
            }
            let chunk = &buf[..n as usize];
            if chunk.contains(&0x03) {
                // 中断: 同一次读到别的字节也留下去 (用户可能先打了字再按 Ctrl+C)
                let rest: Vec<u8> = chunk.iter().copied().filter(|b| *b != 0x03).collect();
                push_pending(&rest);
                cancel.store(true, Ordering::Relaxed);
                let _ = tx.send(());
                return;
            }
            push_pending(chunk);
        }
    });
    InterruptWatch { stop, rx, handle: Some(handle) }
}

/** 非 raw 模式的兜底: 一次读一行 (管道/重定向/没有终端时走这条) */
fn read_line_plain() -> LineResult {
    let mut s = String::new();
    match std::io::stdin().read_line(&mut s) {
        Ok(0) => LineResult { value: String::new(), eof: true, cancelled: false },
        Ok(_) => LineResult {
            value: s.trim_end_matches(['\n', '\r']).to_string(),
            eof: false,
            cancelled: false,
        },
        Err(_) => LineResult { value: String::new(), eof: true, cancelled: false },
    }
}

/**
 * 行输入 (兼容入口)。
 *
 * `history` 为**旧→新**顺序 (↑ 取最后一条); 掩码模式下 `masked = true`
 * ⇒ 屏幕上只有 `•`, **明文从不进屏幕**。
 */
pub fn ask_line(prompt: &str, history: &[String], masked: bool) -> LineResult {
    ask_line_with(prompt, history, "", masked)
}

/** 同 `ask_line`, 但接受一段**预置缓冲** (草稿/贴图重入时用) */
pub fn ask_line_with(
    prompt: &str,
    history: &[String],
    initial: &str,
    masked: bool,
) -> LineResult {
    let mut guard = RawGuard::enable();
    if !guard.is_raw() {
        // 没有 raw mode (非 TTY) ⇒ 退化为读一行, 交互不降级成"卡住"
        print!("{prompt}");
        let _ = std::io::stdout().flush();
        return read_line_plain();
    }

    let cols = crate::width::term_width();
    let max_in = max_input_lines();
    let mut cx = Compose::new(history.to_vec(), initial);
    let mut notes: Vec<String> = Vec::new();
    let mut drawn = 0usize;

    repaint(&mut drawn, prompt, &cx, masked, cols, max_in, &notes);

    loop {
        let Some(bytes) = read_key_raw() else {
            clear_block(drawn);
            return LineResult { value: String::new(), eof: true, cancelled: false };
        };
        if bytes.is_empty() {
            drawn = 0;
            repaint(&mut drawn, prompt, &cx, masked, cols, max_in, &notes);
            continue;
        }
        for key in parse_keys(&bytes) {
            match resolve_action(&key) {
                EditAction::Submit => {
                    clear_block(drawn);
                    let value = cx.buf().to_string();
                    return LineResult { value, eof: false, cancelled: false };
                }
                EditAction::Cancel => {
                    clear_block(drawn);
                    return LineResult { value: String::new(), eof: false, cancelled: true };
                }
                EditAction::Eof => {
                    clear_block(drawn);
                    return LineResult { value: String::new(), eof: true, cancelled: false };
                }
                // 向导里的 Ctrl+C 只当"取消这一步", 不替调用方退出整个流程
                EditAction::Quit => {
                    clear_block(drawn);
                    return LineResult { value: String::new(), eof: false, cancelled: true };
                }
                EditAction::Newline => {
                    if masked {
                        notes = vec!["掩码输入不能换行".to_string()];
                    } else {
                        cx.newline();
                        notes.clear();
                    }
                }
                EditAction::Backspace => {
                    cx.backspace();
                    notes.clear();
                }
                EditAction::DeleteForward => {
                    cx.delete_forward();
                    notes.clear();
                }
                EditAction::CursorLeft => cx.left(),
                EditAction::CursorRight => cx.right(),
                EditAction::LineHome => cx.line_home(),
                EditAction::LineEnd => cx.line_end(),
                EditAction::KillToLineStart => {
                    cx.kill_to_line_start();
                    notes.clear();
                }
                EditAction::Insert(c) => {
                    cx.insert(c);
                    notes.clear();
                }
                EditAction::HistoryPrev => {
                    if !masked && cx.history_prev() {
                        notes.clear();
                    }
                }
                EditAction::HistoryNext => {
                    if !masked && cx.history_next() {
                        notes.clear();
                    }
                }
                EditAction::OpenDraft => {
                    notes = open_draft(&mut guard, &mut cx, masked);
                    // 编辑器占过屏 ⇒ 输入块位置未知, 从当前行重新起一帧
                    print!("\r{ERASE_DOWN}");
                    drawn = 0;
                }
                EditAction::PasteImage => {
                    notes = paste_image(&mut cx, masked);
                }
                EditAction::Accept | EditAction::Ignore => {}
            }
            repaint(&mut drawn, prompt, &cx, masked, cols, max_in, &notes);
        }
    }
}

/** 掩码输入: 值只活在内存里, **从不进屏幕/日志/草稿/贴图** */
pub fn ask_masked(prompt: &str) -> LineResult {
    ask_line(prompt, &[], true)
}

/** 输入块最大行数: 别把整个屏幕吃掉, 也不能是 0 */
pub fn max_input_lines() -> usize {
    (crate::width::term_height().saturating_sub(6)).clamp(1, MAX_INPUT_LINES)
}

/**
 * 把输入块重画一遍。
 *
 * 做法: 先回到块首 (上移 `drawn-1` 行) + 清到屏末, 再整块打印。
 * 不用"擦掉多少字符"那套 —— 多行时长短不一, 按行重画才是几何上稳的。
 */
fn repaint(
    drawn: &mut usize,
    prompt: &str,
    cx: &Compose,
    masked: bool,
    cols: usize,
    max_lines: usize,
    notes: &[String],
) {
    let r = render_input(prompt, cx.buf(), masked, cols, max_lines, notes);
    if *drawn > 1 {
        print!("\x1b[{}A", *drawn - 1);
    }
    print!("\r{ERASE_DOWN}{}", r.text);
    let _ = std::io::stdout().flush();
    *drawn = r.lines;
}

/** 提交/取消时把整块输入擦干净 (光标回到输入区第一列的空白行) */
fn clear_block(drawn: usize) {
    if drawn > 1 {
        print!("\x1b[{}A", drawn - 1);
    }
    print!("\r{ERASE_DOWN}");
    let _ = std::io::stdout().flush();
}

/**
 * `Ctrl+G` —— 起 `$VISUAL` / `$EDITOR` 写草稿。
 *
 * 规矩: **先把 raw 模式交还** (不然编辑器收不到回车), 编辑器退出后读回文件;
 * 草稿里没有内容就保留原输入 (不把用户已经打的字弄丢)。
 */
fn open_draft(guard: &mut RawGuard, cx: &mut Compose, masked: bool) -> Vec<String> {
    if masked {
        return vec!["掩码输入不支持草稿 (秘密不落盘)".to_string()];
    }
    let seed = cx.buf().to_string();
    guard.suspend();
    let res = edit_in_editor(&seed);
    guard.resume();
    match res {
        Ok(text) if text.trim().is_empty() => {
            vec!["草稿是空的 · 保留原输入".to_string()]
        }
        Ok(text) => {
            let lines = text.split('\n').count();
            cx.set_buf(&text);
            vec![format!("✓ 草稿已读入 · {lines} 行")]
        }
        Err(e) => vec![format!("✗ 草稿失败: {e} · 保留原输入")],
    }
}

/** `Alt+V` —— 贴剪贴板图片, 在光标处插入 `@<路径>` */
pub fn paste_image(cx: &mut Compose, masked: bool) -> Vec<String> {
    if masked {
        return vec!["掩码输入不支持贴图".to_string()];
    }
    match crate::clipboard::paste_image() {
        Ok(p) => {
            // 前面没空白就补一个空格: 别把 `@路径` 粘在前一句话的最后一个字上
            let sep = if cx.buf().is_empty() || cx.buf().ends_with(char::is_whitespace) {
                ""
            } else {
                " "
            };
            cx.insert_str(&format!("{sep}@{} ", p.display()));
            vec![format!("✓ 已贴图 · {}", p.display())]
        }
        Err(e) => vec![format!("✗ 贴图失败: {e}")],
    }
}

/// 编辑器选择: `$VISUAL` > `$EDITOR` > 平台默认
pub fn editor_cmd() -> String {
    for var in ["VISUAL", "EDITOR"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    if cfg!(windows) { "notepad".to_string() } else { "vi".to_string() }
}

/// 草稿文件 (`BOLLOON_DRAFT_FILE` 可覆盖, 便于测试/自定义位置)
pub fn draft_path() -> PathBuf {
    if let Ok(p) = std::env::var("BOLLOON_DRAFT_FILE") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    std::env::temp_dir().join(format!("bolloon-draft-{}.md", std::process::id()))
}

/**
 * 公开入口: 在 `$VISUAL`/`$EDITOR` 里编辑一段文本 (markdown), 返回编辑后的内容。
 *
 * `/prompt`、`/compose`、`/plan` 都走这一个函数 —— **只有一处编辑器逻辑** (谁改都不会分叉)。
 * 调用前必须保证不在 raw 模式 (`ask_line` 返回后就是正常模式)。
 */
pub fn compose_in_editor(seed: &str) -> Result<String, String> {
    edit_in_editor(seed)
}

fn edit_in_editor(seed: &str) -> Result<String, String> {
    let path = draft_path();
    std::fs::write(&path, seed).map_err(|e| format!("写草稿失败: {e}"))?;
    let cmd = editor_cmd();
    let mut parts = cmd.split_whitespace();
    let bin = parts.next().ok_or_else(|| "$EDITOR 是空的".to_string())?;
    let status = std::process::Command::new(bin)
        .args(parts)
        .arg(&path)
        .status()
        .map_err(|e| format!("起不动 `{cmd}`: {e}"))?;
    if !status.success() {
        return Err(format!("`{cmd}` 退出码 {:?}", status.code()));
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读草稿失败: {e}"))?;
    let _ = std::fs::remove_file(&path);
    Ok(text.trim_end_matches(['\n', '\r']).to_string())
}

/** 提示行: 输入区上方那一行 (写清键位, 别让人猜) —— 文案在 `help.rs` */
pub fn input_hint(extra: &str) -> String {
    if extra.is_empty() {
        crate::help::HINT.to_string()
    } else {
        format!("{} · {extra}", crate::help::HINT)
    }
}

/** 把一行安全截断到 cols (多行输入在单行走不下时给人看的形状) */
pub fn fit_for_display(s: &str, cols: usize) -> String {
    crate::width::truncate_safe(s, cols)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::width::disp_width;

    /// 掩码: 屏幕上只有 `•`, **长度等于字符数** (不是字节数 —— 中文也算一个点)
    #[test]
    fn mask_is_one_bullet_per_char() {
        let s = "中文abc"; // 5 个字符
        let r = render_input("key › ", s, true, 40, 4, &[]);
        assert_eq!(r.text.matches('•').count(), 5);
        assert_eq!(disp_width(&r.text), disp_width("key › ") + 5);
    }

    // 注意: **不测** `ask_line` 本身 —— 它会真的去读 stdin (raw 模式下会等按键),
    //   单测里跑就是把整条套件挂住。真交互由 `bolloon chat` 手跑 + 门脚本覆盖。

    #[test]
    fn hint_text_is_complete() {
        assert!(input_hint("").contains("Enter 发送"));
        assert!(input_hint("").contains("Ctrl+J 换行"));
        assert!(input_hint("/exit 退出").contains("/exit 退出"));
    }

    #[test]
    fn fit_for_display_truncates() {
        let s = "x".repeat(200);
        assert!(disp_width(&fit_for_display(&s, 20)) <= 20);
    }

    /// 编辑器优先级: `$VISUAL` 胜过 `$EDITOR` (串行跑, 免得 env 串味)
    #[test]
    fn editor_prefers_visual() {
        let _g = crate::width::test_lock().lock().unwrap();
        let old_visual = std::env::var("VISUAL").ok();
        let old_editor = std::env::var("EDITOR").ok();
        unsafe {
            std::env::set_var("VISUAL", "vis-editor --wait");
            std::env::set_var("EDITOR", "ed-editor");
        }
        assert_eq!(editor_cmd(), "vis-editor --wait");
        unsafe { std::env::remove_var("VISUAL") };
        assert_eq!(editor_cmd(), "ed-editor");
        // 还原 (别污染其它用例)
        unsafe {
            match old_visual {
                Some(v) => std::env::set_var("VISUAL", v),
                None => std::env::remove_var("VISUAL"),
            }
            match old_editor {
                Some(v) => std::env::set_var("EDITOR", v),
                None => std::env::remove_var("EDITOR"),
            }
        }
    }

    /// 输入块行数上限: 屏幕矮的时候也不许 0 行 (否则帧少一行, 光标算错)
    #[test]
    fn max_input_lines_is_never_zero() {
        let _g = crate::width::test_lock().lock().unwrap();
        assert!(max_input_lines() >= 1);
        assert!(max_input_lines() <= MAX_INPUT_LINES);
    }
}
