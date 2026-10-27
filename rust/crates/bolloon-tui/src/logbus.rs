//! logbus.rs — 日志与 TUI 的**唯一隔离层**
//!
//! ## 为什么需要它
//!
//! 2026-10-27 真机报障: `bolloon_llm::runtime` 的 WARN 直接插进正在绘制的 TUI,
//! 输入框/状态栏/日志三者互相覆盖。根因不是"日志格式不对", 而是**两条独立的输出通道
//! 抢同一块终端**: `tracing_subscriber` 写 stderr (tty 上与 stdout 同屏),
//! TUI 用绝对行号写 stdout —— 日志落点的光标位置由 TUI 上一帧决定, 于是每一行日志
//! 都把底栏往下推一行, 下一帧的绝对行号就全部对不上。
//!
//! ## 规矩 (三条)
//!
//! 1. **日志永远先落盘** (`<BOLLOON_HOME>/rust/logs/bolloon.log`) —— 级别/模块/上下文/
//!    时间戳一个不丢, 这是诊断能力的唯一真源, 任何"界面干净"都不许拿它换;
//! 2. **TUI 运行期间不写 stderr** —— 改推进本模块的队列, 由 TUI (唯一渲染者) 消费;
//! 3. **非 TUI / 日志重定向场景照原样写 stderr** —— 管道、cron、`bolloon web` 行为不变。
//!
//! 队列是**有界**的 (满了丢最老的, 并如实记一条丢弃计数), 免得后台刷屏把内存吃穿。

use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

/// 队列上限 (界面只展示最近这些; 更早的在日志文件里)
const MAX_EVENTS: usize = 64;

static TUI_ACTIVE: AtomicBool = AtomicBool::new(false);
static DROPPED: AtomicU64 = AtomicU64::new(0);
static EVENTS: Mutex<Vec<LogEvent>> = Mutex::new(Vec::new());

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    /// 严重度字形 (符号通道: 不靠颜色也分得清)
    pub fn icon(self) -> &'static str {
        match self {
            LogLevel::Info => "·",
            LogLevel::Warn => "⚠",
            LogLevel::Error => "✗",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LogLevel::Info => "INFO",
            LogLevel::Warn => "WARN",
            LogLevel::Error => "ERROR",
        }
    }
}

/// 一条进界面的日志事件 (已经是**单行**文本)
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogEvent {
    pub level: LogLevel,
    /// 模块名 (`bolloon_llm::runtime` 这类), 原样保留
    pub target: String,
    /// 事件正文 (不含时间戳/级别前缀)
    pub message: String,
}

impl LogEvent {
    /// 界面上的一行: `⚠ bolloon_llm::runtime · llm retry after backoff …`
    pub fn display(&self) -> String {
        if self.target.is_empty() {
            format!("{} {}", self.level.icon(), self.message)
        } else {
            format!("{} {} · {}", self.level.icon(), self.target, self.message)
        }
    }
}

/// TUI 是否正在独占终端 (决定日志去 stderr 还是去队列)
pub fn tui_active() -> bool {
    TUI_ACTIVE.load(Ordering::Relaxed)
}

pub fn set_tui_active(on: bool) {
    TUI_ACTIVE.store(on, Ordering::Relaxed);
}

/// 进入 TUI 的守卫: 退出 (含提前 return / panic 展开) 时自动放开 stderr
pub struct TuiGuard;

impl TuiGuard {
    pub fn new() -> Self {
        set_tui_active(true);
        Self
    }
}

impl Default for TuiGuard {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for TuiGuard {
    fn drop(&mut self) {
        set_tui_active(false);
    }
}

/// 取走积压事件 (FIFO)。TUI 每次重绘前后各调一次即可。
pub fn drain() -> Vec<LogEvent> {
    let mut g = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *g)
}

/// 因队列满被丢弃的条数 (如实上报, 不假装一条没丢)
pub fn dropped_count() -> u64 {
    DROPPED.load(Ordering::Relaxed)
}

/// 推一条事件 (满了丢最老的)
pub fn push(level: LogLevel, target: &str, message: &str) {
    let ev = LogEvent {
        level,
        target: target.to_string(),
        message: message.replace(['\n', '\r'], " "),
    };
    let mut g = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    if g.len() >= MAX_EVENTS {
        g.remove(0);
        DROPPED.fetch_add(1, Ordering::Relaxed);
    }
    g.push(ev);
}

/// 日志文件路径: `<BOLLOON_HOME 或缺省 ~/.bolloon>/rust/logs/bolloon.log`
pub fn log_path() -> PathBuf {
    let base = std::env::var("BOLLOON_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .map(|h| PathBuf::from(h).join(".bolloon"))
        })
        .unwrap_or_else(|| PathBuf::from(".bolloon"));
    base.join("rust").join("logs").join("bolloon.log")
}

/// 追加一行到日志文件 (尽力而为: 写不了就算了, 绝不让日志拖垮程序)
pub fn append_line(line: &str) {
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut f) = opts.open(&path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 从 tracing 的格式化行里切出 (级别, 模块, 正文)。
///
/// `tracing_subscriber::fmt` 的默认行形如
/// `2026-10-27T06:44:01.123456Z  WARN bolloon_llm::runtime: llm retry after backoff status=429`
/// —— 时间戳可缺 (自定义格式), 所以按**第一个出现的级别词**定位, 不做位置硬编码。
pub fn parse_line(line: &str) -> (LogLevel, String, String) {
    let mut level = LogLevel::Info;
    let mut rest = line.trim();
    let mut target = String::new();

    let mut consumed = 0usize;
    for tok in rest.split_whitespace().take(4) {
        consumed += tok.len() + 1;
        match tok {
            "ERROR" => {
                level = LogLevel::Error;
                rest = &rest[consumed.min(rest.len())..];
                break;
            }
            "WARN" => {
                level = LogLevel::Warn;
                rest = &rest[consumed.min(rest.len())..];
                break;
            }
            "INFO" => {
                level = LogLevel::Info;
                rest = &rest[consumed.min(rest.len())..];
                break;
            }
            "DEBUG" | "TRACE" => {
                level = LogLevel::Info;
                rest = &rest[consumed.min(rest.len())..];
                break;
            }
            _ => {}
        }
    }
    // `target: message` (模块名里没有空格, 冒号后是正文)
    if let Some((t, m)) = rest.trim().split_once(": ") {
        if !t.contains(' ') {
            target = t.to_string();
            rest = m;
        }
    } else if let Some(t) = rest.trim().strip_suffix(':') {
        if !t.contains(' ') {
            target = t.to_string();
            rest = "";
        }
    }
    (level, target, rest.trim().to_string())
}

/// `tracing_subscriber` 的写入器: 落盘 → (TUI 运行时) 进队列 / (否则) 写 stderr
pub struct LogWriter;

impl LogWriter {
    pub fn new() -> Self {
        Self
    }
}

impl Default for LogWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        for raw in text.split('\n') {
            let line = raw.trim_end_matches('\r');
            if line.trim().is_empty() {
                continue;
            }
            complete_line(line);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 去掉 SGR 转义 (`\x1b[…m`) —— 日志文件是给 grep/awk 用的, 不许混进颜色码
fn strip_sgr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < b.len() {
        if b[i] == '\x1b' && i + 1 < b.len() && b[i + 1] == '[' {
            let mut j = i + 2;
            while j < b.len() && !b[j].is_ascii_alphabetic() {
                j += 1;
            }
            i = if j < b.len() { j + 1 } else { b.len() };
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// 一条完整日志行的归属: 盘上必留 (纯净文本), 界面只在需要时收
fn complete_line(raw: &str) {
    let line = strip_sgr(raw);
    let line = line.as_str();
    append_line(line);
    let (level, target, message) = parse_line(line);
    if tui_active() {
        // 界面只要"用户该知道的": INFO 级别的启动细节只留盘
        if level != LogLevel::Info {
            push(level, &target, &message);
        }
    } else {
        let _ = writeln!(io::stderr(), "{line}");
    }
}

/// panic 也要走同一条路: 否则 panic 文本直接砸进 TUI, 把最后的现场覆盖掉。
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("{info}").replace('\n', " ");
        append_line(&format!("ERROR panic: {msg}"));
        if tui_active() {
            push(LogLevel::Error, "panic", &msg);
        } else {
            prev(info);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 队列/标志都是**进程级全局**: 并行跑测试会互相抢事件 ⇒ 这一组必须串行
    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn seq() -> std::sync::MutexGuard<'static, ()> {
        TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn parses_tracing_default_line() {
        let (lv, t, m) = parse_line(
            "2026-10-27T06:44:01.123456Z  WARN bolloon_llm::runtime: llm retry after backoff status=429",
        );
        assert_eq!(lv, LogLevel::Warn);
        assert_eq!(t, "bolloon_llm::runtime");
        assert!(m.contains("status=429"), "{m}");
    }

    #[test]
    fn parses_line_without_timestamp() {
        let (lv, t, m) = parse_line("ERROR bolloon_kernel::ha: 心跳丢失");
        assert_eq!(lv, LogLevel::Error);
        assert_eq!(t, "bolloon_kernel::ha");
        assert_eq!(m, "心跳丢失");
    }

    #[test]
    fn target_without_message_still_parses() {
        let (lv, t, _) = parse_line("2026-10-27T06:44:01Z INFO bolloon_web::server:");
        assert_eq!(lv, LogLevel::Info);
        assert_eq!(t, "bolloon_web::server");
    }

    /// 队列有界: 满了两条纪律 —— 丢最老的 + 如实计数
    #[test]
    fn queue_is_bounded_and_counts_drops() {
        let _g = seq();
        set_tui_active(true);
        let _ = drain();
        for i in 0..(MAX_EVENTS + 5) {
            push(LogLevel::Warn, "t", &format!("m{i}"));
        }
        let got = drain();
        assert_eq!(got.len(), MAX_EVENTS);
        assert_eq!(got[0].message, format!("m{}", 5), "丢的是最老的");
        assert!(dropped_count() >= 5);
        set_tui_active(false);
    }

    /// TUI 运行时 WARN 进队列 (不写 stderr); 关掉之后不再进队列
    #[test]
    fn tui_flag_routes_events_to_queue() {
        let _g = seq();
        set_tui_active(true);
        let _ = drain();
        complete_line("2026-10-27T00:00:00Z WARN x::y: boom");
        assert_eq!(drain().len(), 1);

        set_tui_active(false);
        complete_line("2026-10-27T00:00:00Z WARN x::y: boom");
        assert!(drain().is_empty(), "非 TUI 不进队列 (直接 stderr)");
    }

    /// INFO 在 TUI 期间只落盘 —— 界面只收"用户该知道的"
    #[test]
    fn info_does_not_reach_the_ui() {
        let _g = seq();
        set_tui_active(true);
        let _ = drain();
        complete_line("2026-10-27T00:00:00Z INFO x::y: 启动细节");
        assert!(drain().is_empty(), "INFO 不该上界面");
        set_tui_active(false);
    }

    /// 守卫退出后自动放开 stderr (含提前 return / panic 展开)
    #[test]
    fn guard_restores_stderr_on_drop() {
        let _g = seq();
        {
            let _g = TuiGuard::new();
            assert!(tui_active());
        }
        assert!(!tui_active());
    }

    /// 界面行带模块名与严重度字形 —— 诊断信息不因为"进界面"而丢
    #[test]
    fn display_line_keeps_level_and_target() {
        let ev = LogEvent {
            level: LogLevel::Warn,
            target: "bolloon_llm::runtime".into(),
            message: "llm retry after backoff status=429".into(),
        };
        let s = ev.display();
        assert!(s.starts_with('⚠'), "{s}");
        assert!(s.contains("bolloon_llm::runtime"), "{s}");
        assert!(s.contains("status=429"), "{s}");
    }

    /// 多行正文在进界面前压成一行 (否则一行事件会把底栏顶歪)
    #[test]
    fn multiline_message_is_flattened() {
        let _g = seq();
        set_tui_active(true);
        let _ = drain();
        push(LogLevel::Error, "t", "第一行\n第二行\r第三行");
        let ev = &drain()[0];
        assert!(!ev.message.contains('\n'), "{:?}", ev.message);
        set_tui_active(false);
    }
}
