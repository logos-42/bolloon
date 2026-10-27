//! Bolloon CLI — 命令入口（rust 原生版, 版本取 Cargo 包版本）
//!
//! 命令面（与 TS 版对齐的核心部分）:
//!   bolloon                        → 启动 web (默认 54188)
//!   bolloon web [--port N]         → 启动 web
//!   bolloon status                 → 状态
//!   bolloon memory remember|recall → 记忆 (落盘 ~/.bolloon/rust/memory.json)
//!   bolloon task publish|id        → 任务公告 (bolloon-task/1)
//!   bolloon --version              → 版本
//!   bolloon chat [--channel X]      → 交互式会话 (消息框/输入历史复用原 TS CLI TUI)
//!   bolloon model                   → 选模型供应商 (全屏光标选择器 + 掩码输入)
//!   bolloon dream [主题]            → 做梦 (整理记忆与经验, 升级 skills)
//!
//! **终端 UI 复用原 TS 的 CLI TUI** (`src/cli/` 那套纯 ANSI 视觉层), 见 `tui` 模块的来源对照表。
//! 本文件只做"接线": 品牌 banner / 启动仪表盘 / 状态面板 / 消息框 / 选择器全走 `tui`, 不在这里画字符。

use bolloon_llm::LlmRuntime;
use bolloon_tui as tui;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

mod chat_command;
mod learning;
mod slash;

#[derive(Parser)]
#[command(
    name = "bolloon",
    // npm 包里可执行文件叫 bolloon-native-<平台>-<架构>, 但帮助里必须仍显示 bolloon
    bin_name = "bolloon",
    version = env!("CARGO_PKG_VERSION"),
    about = "Bolloon — 去中心化智能体资源交流网络 (Rust 原生版)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 启动 Web UI（默认 http://127.0.0.1:54188）
    Web {
        #[arg(long, default_value_t = 54188)]
        port: u16,
    },
    /// 显示运行状态
    Status,
    /// 记忆 (importance/decay 分层)
    Memory {
        #[command(subcommand)]
        action: MemoryAction,
    },
    /// 任务公告板 (bolloon-task/1)
    Task {
        #[command(subcommand)]
        action: TaskAction,
    },
    /// 交互式会话 (Enter 发送 · Ctrl+J 换行 · Ctrl+G 草稿 · Alt+V 贴图 · ↑↓ 历史 · /help)
    Chat {
        /// 渠道名 (输入历史**一渠道一文件**, 隔离不串)
        #[arg(long, default_value = "default")]
        channel: String,
        /// 直接接着某个会话聊 (序号 / id / id 前缀 / 标题 都认; 见 /sessions)
        #[arg(long)]
        resume: Option<String>,
    },
    /// 选模型供应商 (全量 200+ 家: 内置 13 + 目录 + 自定义; 密钥掩码输入, 落盘 0600)
    Model {
        /// 直接选这家 (不给 = 进全屏选择器)
        provider: Option<String>,
        /// 只列可用的家 (有 key 或本机服务)
        #[arg(long)]
        usable: bool,
        /// 关键词筛选 (id / 名称 / 协议)
        #[arg(long)]
        filter: Option<String>,
        /// 直接指定模型 (跳过交互)
        #[arg(long)]
        model: Option<String>,
        /// 自定义家的 API 基址 (目录里没有的 id 必须给; 也可用于临时改目录家的基址)
        #[arg(long)]
        base_url: Option<String>,
        /// 从 stdin 读一行当 key (不进 shell history / 不落 ps)
        #[arg(long)]
        api_key_stdin: bool,
    },
    /// 自动更新 (有新版本才会提示)
    Update {
        #[command(subcommand)]
        action: UpdateAction,
    },
    /// 做梦 (整理记忆与经验, 升级项目 skills)
    Dream {
        /// 主题 (给了就写梦想文档)
        topic: Option<String>,
        #[arg(long, default_value = "all")]
        domain: String,
    },
}

#[derive(clap::Subcommand)]
enum UpdateAction {
    /// 检查更新
    Check,
    /// 一键内部安装并重启 (无弹窗)
    Install,
}

#[derive(Subcommand)]
enum MemoryAction {
    /// 记住一条
    Remember {
        #[arg(long)]
        content: String,
        #[arg(long, default_value_t = 0.5)]
        importance: f64,
        /// run_fact | lesson | decision | temporary
        #[arg(long, default_value = "run_fact")]
        layer: String,
    },
    /// 召回 top-k
    Recall {
        #[arg(long)]
        query: Option<String>,
        #[arg(long, default_value_t = 5)]
        top: usize,
    },
}

#[derive(Subcommand)]
enum TaskAction {
    /// 发布任务公告 (打印稳定 id)
    Publish {
        #[arg(long)]
        capability: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        budget: String,
    },
    /// 展示某 (capability,digest,budget) 的公告 id
    Id {
        #[arg(long)]
        capability: String,
        #[arg(long)]
        digest: String,
        #[arg(long)]
        budget: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 日志的唯一出口 (`bolloon_tui::logbus`):
    //   ① **永远先落盘** (<BOLLOON_HOME>/rust/logs/bolloon.log) —— 级别/模块/上下文/时间戳不丢;
    //   ② TUI 运行中**不写 stderr** (那会和底栏抢同一块终端) —— 改推事件队列, 由 Chrome 展示;
    //   ③ 非交互/重定向/`bolloon web` 照原样写 stderr (行为不变)。
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .with_ansi(std::io::stderr().is_terminal())
        .with_writer(bolloon_tui::logbus::LogWriter::new)
        .init();
    bolloon_tui::logbus::install_panic_hook();

    // 双核 Kernel HA: 按 BOLLOON_HA 启用; 两进程各选 A/B 经心跳文件互维互保。
    // 接管动作 = 真孤儿接管 (reconcileOrphans + prepareResume), 不再接 NoopRecovery。
    let _ha = bolloon_kernel::dual_core::spawn_kernel_ha_from_env(Arc::new(
        bolloon_kernel::orphan_recovery::OrphanRecovery::new(
            bolloon_kernel::orphan_recovery::runs_dir(),
        ),
    ));

    let cli = Cli::parse();

    match cli.command {
        None => run_web(54188).await, // 无子命令 → 启动 web（对齐 TS: bolloon 默认起本地服务）
        Some(Commands::Web { port }) => run_web(port).await,
        Some(Commands::Status) => run_status(),
        Some(Commands::Memory { action }) => run_memory(action),
        Some(Commands::Task { action }) => run_task(action),
        Some(Commands::Chat { channel, resume }) => run_chat(&channel, resume.as_deref()).await,
        Some(Commands::Model { provider, usable, filter, model, base_url, api_key_stdin }) => {
            run_model(provider, usable, filter, model, base_url, api_key_stdin)
        }
        Some(Commands::Update { action }) => run_update(action),
        Some(Commands::Dream { topic, domain }) => run_dream(topic, &domain),
    }
}

/// 启动 web —— 启动期走**品牌仪表盘** (`tui::LoadingTui`, 复用 TS `LoadingTUI`)
async fn run_web(port: u16) -> anyhow::Result<()> {
    let llm = build_llm_from_env();
    let state = bolloon_web::AppState::new(llm);

    // 2026-09-30 leo 口径: 真 pty 下终端尺寸可能还没就位 ⇒ 出第一帧之前先等一下
    //   (不等 ⇒ 先按 80 列画一帧, 真尺寸到了再画一帧 ⇒ 顶框重复 + 宽度一路涨)
    tui::width::wait_for_term_size(600);

    if tui::color_enabled() {
        let mut loading = tui::LoadingTui::new();
        loading.set_steps(&["数据目录 / DID 身份", "LLM provider", "双内核", "本地服务"]);
        loading.start("Bolloon 启动中…");

        loading.start_step(0, None);
        let _ = data_dir();
        let _ = load_identity_or_create();
        loading.complete_step(0, None, None);

        loading.start_step(1, None);
        let has_key = std::env::var("BOLLOON_API_KEY").is_ok();
        loading.complete_step(
            1,
            Some(if has_key { "ok" } else { "warn" }),
            Some(&format!(
                "provider {} (key={})",
                env_provider_or("未配置"),
                if has_key { "有" } else { "无" }
            )),
        );

        loading.start_step(2, None);
        loading.complete_step(2, None, Some("Kernel (channel-actor/model-runtime/ha) + Harness (工具门)"));

        loading.start_step(3, None);
        loading.complete_step(3, None, Some(&format!("http://127.0.0.1:{port}")));
        loading.stop(true);
    } else {
        // 非终端 (管道/重定向/NO_COLOR): 一行说清, 不画 ANSI 框
        println!(
            "🜁 Bolloon {} (rust native) — http://127.0.0.1:{} · data={}",
            env!("CARGO_PKG_VERSION"),
            port,
            data_dir().display()
        );
    }

    bolloon_web::serve(state, port).await
}

/// 状态 —— 面板走**品牌仪表盘** (`tui::render_dashboard`)
fn run_status() -> anyhow::Result<()> {
    let has_key = std::env::var("BOLLOON_API_KEY").is_ok();
    let rows = vec![
        tui::panel::DashRow {
            label: format!("bolloon {} (rust native)", env!("CARGO_PKG_VERSION")),
            status: Some("ok".into()),
            detail: Some("双内核: Kernel + Harness".into()),
        },
        tui::panel::DashRow {
            label: format!("provider {}", env_provider_or("未配置")),
            status: Some(if has_key { "ok".into() } else { "warn".into() }),
            detail: Some(format!(
                "model {}",
                std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".into())
            )),
        },
        tui::panel::DashRow {
            label: "web http://127.0.0.1:54188".to_string(),
            status: Some("info".into()),
            detail: None,
        },
        tui::panel::DashRow {
            label: format!("data {}", data_dir().display()),
            status: Some("info".into()),
            detail: None,
        },
    ];
    let mut out = tui::render_dashboard(&tui::panel::DashboardOpts {
        title: Some("Bolloon Agent · 仪表盘".into()),
        rows,
        brand: Some(true),
        width: None,
    });
    // tip 栏: **有更新才显示** (未检测到/检测不到都不出现)
    if let Some(tip) = update_tip() {
        out.push('\n');
        out.push_str(&tip);
    }
    println!("{out}");
    Ok(())
}

/// 交互式会话 —— **复刻 TS `ink-app.tsx` 的分区账本**
///
/// ```text
///   行 1 … history   历史区 (直接 println 进终端 scrollback, 永不重绘)
///   活动行            思考颜文字 / 工具秒表 / 提示 (固定 1 行)
///   ────────────
///   状态栏            左段 model │ ctx │ ◷ │ ↑ │ ⚙ + 右对齐 ▸标题
///   ────────────
///   ❯ 输入            恒 1 行 (单行编辑器, 带反显光标)
///   ────────────
/// ```
///
/// 与旧实现的关键差别: 不再"整屏自绘 + 固定高正文区", 而是 TS 2026-09-30 定下的
/// 「历史进 scrollback、程序只管底部 6 行」—— 用户上滚/框选/复制都不跟程序抢屏幕。
/// `@` 补全: 列当前目录条目 (按查询串前缀过滤), 目录名带尾 `/`。
/// 纯 IO, 不碰终端; 失败 (无权限/路径没了) 就给空列表, 不卡住输入。
fn cwd_candidates(q: &str) -> Vec<tui::ComplItem> {
    let dir = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let q = q.to_ascii_lowercase();
    let mut out: Vec<tui::ComplItem> = Vec::new();
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !q.is_empty() && !name.to_ascii_lowercase().contains(&q) {
            continue;
        }
        let is_dir = e.path().is_dir();
        let value = if is_dir {
            format!("{name}/")
        } else {
            name.clone()
        };
        out.push(tui::ComplItem {
            label: format!("@{name}"),
            value,
            hint: Some(if is_dir { "目录".to_string() } else { "文件".to_string() }),
        });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out
}

async fn run_chat(channel: &str, resume: Option<&str>) -> anyhow::Result<()> {
    // 从这里起日志不再直写 stderr (退出/panic 展开时自动放开)
    let _tui_log = tui::logbus::TuiGuard::new();
    let (llm, model) = build_chat_llm();

    // 权限模式（对齐 TS `BOLLOON_PERM_MODE`）: bypass = 完全访问 = **所有权限开放**
    let mode = bolloon_agent::permission_mode::mode_from_env();
    let bypass = mode.is_bypass();

    // 会话级取消标志: Ctrl+C 置位 ⇒ shell 的当前/下一条命令被 kill（决策 3: 取消是统一机制）。
    // 只 spawn **一个**常驻监听（不每轮泄漏），send_one 每轮开头重置。
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    {
        let c = cancel.clone();
        tokio::spawn(async move {
            while tokio::signal::ctrl_c().await.is_ok() {
                c.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        });
    }

    let mut history = tui::load_input_history(Some(channel));
    // 会话本体 (消息/标题/模型/附件 + 落盘): 命令逻辑全在 `chat_command`, 这里只做接线
    let mut sess = chat_command::ChatSession::new(&model, channel);
    // 经验闭环 (记忆 / 判断力 / 技能) 从 `<BOLLOON_HOME>` 读进来 —— 终端也要带上历史来聊,
    // 而不是每次从白纸开始 (leo: 「自动初始化加载 skills 和记忆」)。
    let mut learn = learning::Learning::load(
        &std::path::PathBuf::from(
            std::env::var("BOLLOON_HOME").unwrap_or_else(|_| {
                let h = std::env::var("HOME").unwrap_or_default();
                format!("{h}/.bolloon")
            }),
        ),
        "coding",
    );
    // `--resume <序号|id|标题>`: 启动就接上旧会话 (面板上的标题/模型/消息数都是它的)
    if let Some(key) = resume {
        match sess.load_into(key) {
            Ok(()) => {}
            Err(e) => {
                eprintln!("{e}");
                eprintln!("(从新会话开始; 进会话后 /sessions 看可恢复的列表)");
            }
        }
    }
    let jobs = chat_command::Jobs::new();
    let ctx = chat_command::ChatCtx {
        llm: Arc::clone(&llm),
        jobs: &jobs,
    };

    // 只有真终端才用 chrome; 非 TTY 走纯 println (免得往管道里灌 ANSI)
    let full = tui::select::tui_capable();
    let session_started = std::time::Instant::now();
    let mut chrome = tui::Chrome::new(tui::width::term_height(), tui::width::term_width());
    chrome.status.session_started = Some(session_started);
    chrome.hint = tui::help::HINT.to_string();
    refresh_status(&mut chrome, &sess);

    // 启动 Dashboard (仿 Hermes 欢迎界面): 圆角边框 + 左侧 Logo + 右侧 Tools/MCP/Skills + 状态栏
    // 一次性静态屏: **从顶部打印**, 再让 chrome 钉在最底 6 行。绝不能用 `print_above`
    // (它把光标移到 chrome 顶行上方再**向下** println, 会与最底 chrome 重叠并被擦掉)。
    let wide_enough = tui::width::term_width() >= 64 && tui::width::term_height() >= 24;
    if wide_enough {
        let dash = build_dashboard(&sess);
        let lines = tui::render_startup_dashboard(&dash);
        if full {
            chrome.reset_screen(); // 清屏, 去掉残留的 shell 提示符 (如 `rust %`)
            for l in &lines {
                println!("{l}");
            }
            // flow 布局: chrome 跟在 dashboard 下一行, 不再钉底 —— 消除
            // "dashboard 在顶、chrome 在底、中间整块空白"的老问题。
            // +1 = dashboard 后留一个空行; reset_screen 已把 flow_top 置 1。
            chrome.set_flow_top(lines.len() + 2);
            chrome.draw();
        } else {
            // 非 TTY: 同样一块面板, 但**不带任何颜色/光标控制** (管道里要能直接 grep)
            for l in &lines {
                println!("{}", plain(l));
            }
        }
    } else if full {
        tui::print_banner(Some(env!("CARGO_PKG_VERSION")));
    } else {
        println!("BOLLOON {} (rust native)", env!("CARGO_PKG_VERSION"));
    }

    // 启动即如实报一句: 这次到底加载了多少记忆 / 判断力 / 技能 (0 也照报, 不假装)
    if wide_enough || !full {
        if full {
            chrome.print_above(&[learn.summary_line()]);
            chrome.draw();
        } else {
            println!("{}", learn.summary_line());
        }
    }

    // **整段会话持 raw 模式**: 提交后到下一次输入之间也必须是 raw, 否则抢先敲的 `\r` 会被
    //   cooked 行规程换成 `\n`。机制见 `tui::input::RawState`。
    let raw = tui::input::hold_raw_mode();
    // 毫秒时钟: 轮末 agent 循环判 loop 任务是否"到点"
    let now_ms = || SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u128;

    // 完全访问 = 所有权限开放 ⇒ **必须让用户看见**（不能开着却没人知道）
    if bypass {
        emit(
            &mut chrome,
            full,
            &[format!(
                "⚠ {} — shell 的命令白名单 / 路径保护 / 高危 denylist 均不拦截（超时·取消·预算·审计仍在）",
                mode.label()
            )],
        );
    }

    // 命令改出来的回填内容 (`/undo` `/retry`)
    let mut prefill = String::new();

    loop {
        chrome.refresh_size();
        refresh_status(&mut chrome, &sess);
        if matches!(chrome.activity, tui::Activity::Thinking { .. }) {
            chrome.activity = tui::Activity::Idle;
        }
        // 后台日志事件: 空闲时落进历史区 (用户能看见告警), 生成中只走活动行
        flush_logs(&mut chrome, full, false);
        if full {
            chrome.draw();
        }

        // 轮末 agent 循环: 到点的 loop → steer → queue 优先自动跑;
        // 只有没自动任务时才阻塞等用户输入 (auto 条目不进输入历史)
        let (text, is_auto) = if let Some(sched) = sess.next_scheduled(now_ms()) {
            (format!("{} {}", sched.marker(), sched.text()), true)
        } else if full {
            // 输入区由 `Chrome` 自己画 (固定高度 + 绝对行号)。这里只喂状态源:
            // `/ @ !` 补全候选来自 slash::specs / 当前目录, 缓冲区/光标在 Chrome 里。
            let outcome = chrome.read_compose(&history, &prefill, &|kind: tui::ComplKind,
                                                                      q: &str| {
                match kind {
                    tui::ComplKind::Slash => slash::specs()
                        .iter()
                        .map(|s| tui::ComplItem {
                            label: s.name.to_string(),
                            value: s.name.trim_start_matches('/').to_string(),
                            hint: Some(s.summary.to_string()),
                        })
                        .collect(),
                    tui::ComplKind::At => cwd_candidates(q),
                    tui::ComplKind::Bang => Vec::new(), // 无候选: 状态行给 Shell 模式提示
                }
            });
            prefill.clear();
            match outcome {
                // Ctrl+D / 管道断了 / **空闲时一次 Ctrl+C** —— 都走退出 (下面统一落盘)
                tui::InputOutcome::Eof | tui::InputOutcome::Quit => break,
                tui::InputOutcome::Cancelled => {
                    // Esc = 只丢这一行, 会话不退 (leo: 退出只认 Ctrl+C / Ctrl+D / /exit)
                    emit(
                        &mut chrome,
                        full,
                        &[format!(
                            "{}· 已取消当前输入 (会话继续 · Ctrl+C 退出){}",
                            tui::theme::C_DIM,
                            tui::theme::RESET
                        )],
                    );
                    continue;
                }
                tui::InputOutcome::Line(v) => (v.trim().to_string(), false),
            }
        } else {
            let r = tui::ask_line_with("› ", &history, &prefill, false);
            prefill.clear();
            if r.eof {
                break;
            }
            if r.cancelled {
                println!("(已取消当前输入 · 退出用 /exit 或 Ctrl+D)");
                continue;
            }
            (r.value.trim().to_string(), false)
        };
        if text.is_empty() {
            continue;
        }
        if !is_auto {
            if tui::append_input_history(&text, Some(channel)) && !history.contains(&text) {
                history.push(text.clone());
            }
        }

        // ── 命令面 ──────────────────────────────────────────
        // `?` 是 `/help` 的快捷写法 (老习惯, 保留)
        let line = if text == "?" { "/help".to_string() } else { text.clone() };
        let mut prompt = text.clone();
        if let Some((spec, args)) = slash::parse(&line) {
            match sess.exec(&ctx, spec, &args).await {
                chat_command::Cmd::Say(lines) => {
                    emit(&mut chrome, full, &lines);
                    refresh_status(&mut chrome, &sess);
                    continue;
                }
                chat_command::Cmd::Prefill(back) => {
                    prefill = back;
                    continue;
                }
                chat_command::Cmd::Clear | chat_command::Cmd::Redraw => {
                    // 真清屏: 历史也一起没了 (`/clear` 的语义就是"从头来")
                    chrome.reset_screen();
                    refresh_status(&mut chrome, &sess);
                    continue;
                }
                chat_command::Cmd::Update { install } => {
                    let action = if install { UpdateAction::Install } else { UpdateAction::Check };
                    let lines = match run_update(action) {
                        Ok(()) => vec!["✓ 更新流程已执行 (输出见上)".to_string()],
                        Err(e) => vec![format!("✗ 更新失败: {e}")],
                    };
                    emit(&mut chrome, full, &lines);
                    continue;
                }
                chat_command::Cmd::Pick(kind) => {
                    let rows = sess.pick_rows(kind);
                    if rows.is_empty() {
                        emit(&mut chrome, full, &["没有可选项".to_string()]);
                        continue;
                    }
                    let items: Vec<tui::TuiChoice> = rows
                        .iter()
                        .map(|r| tui::TuiChoice {
                            value: r.value.clone(),
                            label: r.label.clone(),
                            hint: r.hint.clone(),
                            group: None,
                            cancel: false,
                        })
                        .collect();
                    // 全屏选择器要独占终端: 先把底栏让出来, 退出后再整屏重算
                    chrome.clear();
                    let opts = tui::SelectOptions::default();
                    let picked = tui::tui_select(&sess.pick_title(kind), &items, &opts);
                    chrome.reset_screen();
                    if let Some(v) = picked {
                        let lines = match sess.apply_pick(kind, &v) {
                            Ok(l) => l,
                            Err(e) => vec![format!("✗ {e}")],
                        };
                        emit(&mut chrome, full, &lines);
                        refresh_status(&mut chrome, &sess);
                    }
                    continue;
                }
                chat_command::Cmd::Quit { .. } => break,
                chat_command::Cmd::Send(p) => {
                    // `/retry` `/prompt` 走这里: 用这条内容代替用户输入
                    prompt = p;
                }
            }
        } else if text.starts_with('/') {
            // 未知命令: 如实说, 不把它当普通消息发给模型
            emit(
                &mut chrome,
                full,
                &[format!("✗ 没有这个命令: {text} (用 /help 看全部)")],
            );
            continue;
        }

        // **秘密不写历史**: 只有用户真输入才进输入历史; 自动跑的 loop/steer/queue 条目不写
        if !is_auto
            && tui::append_input_history(&prompt, Some(channel))
            && !history.contains(&prompt)
        {
            history.push(prompt.clone());
        }

        match send_one(&mut chrome, full, &mut sess, &mut learn, &llm, &prompt, &cancel, bypass).await {
            Ok(()) => {}
            Err(e) => emit(&mut chrome, full, &[format!("✗ {e}")]),
        }

        // ── 轮末 agent 循环 ── 到点的 loop → steer → queue 自动跑。
        // **成功/失败都要跑**: 没配 key 时也要把队列/插话/loop 推完 (每轮失败就停, 不刷屏)。
        // 单次会话内最多 6 轮自动, 防止把终端吞住; 用户下次输入仍优先。
        let mut auto_rounds = 0usize;
        loop {
            auto_rounds += 1;
            if auto_rounds > 6 {
                emit(
                    &mut chrome,
                    full,
                    &["… 自动循环已连跑 6 轮, 先停下 (/busy interrupt 可整体暂停)".to_string()],
                );
                break;
            }
            let Some(sched) = sess.next_scheduled(now_ms()) else { break };
            let auto_text = format!("{} {}", sched.marker(), sched.text());
            let is_loop = matches!(sched, chat_command::Scheduled::Loop(_));
            match send_one(&mut chrome, full, &mut sess, &mut learn, &llm, &auto_text, &cancel, bypass).await {
                Ok(()) => {
                    if is_loop {
                        for l in sess.after_loop_turn(&ctx).await {
                            emit(&mut chrome, full, &[l]);
                        }
                    }
                    refresh_status(&mut chrome, &sess);
                }
                Err(e) => {
                    emit(&mut chrome, full, &[format!("✗ 自动循环: {e}")]);
                    break;
                }
            }
        }
    }
    chrome.clear();
    // 退出前把会话落盘 (空闲 Ctrl+C / Ctrl+D / 正常 /exit 都走这里)
    let saved_ok = sess.save().is_ok();
    // 退出前做一次梦 (整理这一会话攒下的记忆 → 判断力/技能), 并把三份档案落盘
    let dream_line = learning::report_line(&learn.dream_now());
    let learn_saved = learn.save();
    let summary = sess.exit_summary(session_started.elapsed());
    drop(raw); // 先还终端, 再打印收尾 (不然输出会粘在输入行上)
    println!("{}", plain(&format!("{}── 会话结束 ──{}", tui::theme::C_DIM, tui::theme::RESET)));
    for l in &summary {
        println!("{}", plain(l));
    }
    println!("{}", plain(&format!("{}经验    {}{}", "", learn.summary_line(), "")));
    println!("{}", plain(&dream_line));
    if !saved_ok {
        println!("{}", plain("⚠ 会话落盘失败 —— 内容仍在内存, 别急着关终端"));
    }
    if let Err(e) = learn_saved {
        println!("{}", plain(&format!("⚠ 经验落盘失败: {e}")));
    }
    Ok(())
}

/// 发一条用户消息: 用户框先上屏 → 活动行进入"思考中" → 拿到结果后工具行 + 回复框上屏。
///
/// 模型调用期间用 `select!` 喂 100ms tick, 活动行的颜文字与秒表真的在动 ——
/// 旧实现是阻塞 await, 那几秒屏幕完全静止 (用户以为卡死)。
async fn send_one(
    chrome: &mut tui::Chrome,
    full: bool,
    sess: &mut chat_command::ChatSession,
    learn: &mut learning::Learning,
    llm: &LlmRuntime,
    text: &str,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
    bypass: bool,
) -> Result<(), String> {
    let user_msg = match sess.build_user_message(text) {
        Ok(m) => m,
        Err(e) => return Err(format!("附件发送失败: {e} (附件已保留)")),
    };
    sess.attachments.clear();

    let user_box = tui::render_user_message(&user_msg.content);
    if full {
        let lines: Vec<String> = user_box.split('\n').map(|s| s.to_string()).collect();
        chrome.print_above(&lines);
    } else {
        println!("{}", plain(&user_box));
    }
    sess.messages.push(bolloon_llm::ChatMessage {
        role: "user".into(),
        content: user_msg.content.clone(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: user_msg.images,
    });
    // 状态栏的会话摘要跟着首条用户消息走 (语义标题, 不是时间戳)
    sess.refresh_title();
    let _ = sess.save();

    // 装配 bolloon 身份 system prompt: 单一真源 = `bolloon_agent::prompt::build_system_prompt`
    // (与 web/App 完全一致); 按 channel 选全局(home)/项目内(project) 身份文件 (soul/agent/persona).
    // 一轮对话最多允许的「模型 ⇄ 工具」往返轮数 (防死循环; 达上限如实上报, 不伪造完成)
    const MAX_TOOL_TURNS: u32 = 8;
    // Harness 预算: 单轮工具调用次数上限 / 单次调用耗时上限 (ms)
    const MAX_TOOL_CALLS_PER_TURN: u32 = 20;

    // ── 工具运行时 (最小闭环): 注册表 + 真实执行器 + Harness ──
    // Rust 侧**第一次**真正把工具交给模型并执行 (2026-10-26 迁移第一步)。
    // 此前 `params.tools` 恒空 + 零生产执行器 ⇒ function calling 从未启用,
    // 模型返回的 tool_calls 只被渲染、从未执行、也从未回传续轮。
    // 每轮开头清掉上一轮的取消标志（Ctrl+C 只中断当前轮）
    cancel.store(false, std::sync::atomic::Ordering::Relaxed);

    let registry = std::sync::Arc::new(bolloon_harness::ToolRegistry::new());
    bolloon_agent::builtin_tools::register_builtin_tools(&registry).await;
    // 授予范围: 完全访问 = 所有已注册工具都不再逐次授权; 默认 = 只授予高风险 shell
    let granted: Vec<String> = if bypass {
        registry.list().await.iter().map(|d| d.name.clone()).collect()
    } else {
        vec![
            // 高风险 shell + 可逆写入（显式授予，不是默认放行）
            "shell".to_string(),
            "write_file".to_string(),
            "edit_file".to_string(),
            "mkdir".to_string(),
            "move_file".to_string(),
            // delete_file **不在**此列: 不可逆 ⇒ 需显式授权（决策 2 分级）
            // git: 本地写（add/commit）授予；git_push（不可逆外部）**不默认授予**
            "git_add".to_string(),
            "git_commit".to_string(),
        ]
    };
    let granted_refs: Vec<&str> = granted.iter().map(|s| s.as_str()).collect();
    let harness = std::sync::Arc::new(
        bolloon_harness::Harness::new(
            registry.clone(),
            std::sync::Arc::new(bolloon_agent::builtin_tools::BuiltinExecutor::new(
                cancel.clone(),
                bypass,
            )),
            bolloon_harness::Budget::new(MAX_TOOL_CALLS_PER_TURN, 120_000),
        )
        // 高风险工具**显式授予**而非默认放行; 完全访问下授予全部（安全门由 bypass 跳过）
        .with_granted(&granted_refs),
    );
    // `ToolDef → ToolSchema` 桥接 (此前完全缺失的一环): 注册表里的定义终于能发给模型
    let tool_schemas = bolloon_agent::builtin_tools::tool_defs_to_schemas(&registry.list().await);

    let mut convo: Vec<bolloon_llm::ChatMessage> = vec![bolloon_llm::ChatMessage {
        role: "system".into(),
        content: {
            let base = build_bolloon_system(&sess.channel);
            let extra = learn.context_block(text, learning::DEFAULT_BUDGET);
            if extra.trim().is_empty() {
                base
            } else {
                format!("{base}\n\n# 经验 (跨会话, 按需取用)\n{extra}")
            }
        },
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: vec![],
    }];
    convo.extend(sess.messages.clone());

    let started = std::time::Instant::now();
    // 流式预览块: **先预留固定 4 行** (滚出来占住), 每帧就地重画, 收尾整段交还历史区。
    // 旧做法是"向上借历史行 + 收尾擦白" ⇒ 发送框与回复框之间出现大洞。
    let stream_block = full && chrome.reserve_stream(tui::STREAM_ROWS);
    // 等模型/工具期间的按键监听 (只认 Ctrl+C / Esc ⇒ 中断这一回合)
    let mut watch = tui::input::watch_interrupts(cancel.clone());
    let mut interrupted = false;
    let mut tools_used: u32 = 0;
    let mut used_tool_names: Vec<String> = Vec::new();
    let mut turn = 0u32;
    let (final_content, usage) = loop {
        turn += 1;
        let params = {
            let mut p = bolloon_llm::GenerateParams::new(&sess.model, convo.clone());
            p.tools = tool_schemas.clone(); // ← 工具 schema 真正注入模型
            p
        };
        if full {
            chrome.activity = tui::Activity::Thinking { started, chars: 0 };
            chrome.draw();
        }
        // 首轮走流式 (面板生长); 续轮 (工具结果整理) 非流式, 活动行照常显示 Thinking
        let res = if full && turn == 1 {
            // 统一事件循环: 模型流 + 增量通道 + 100ms tick 三路 select。
            // 流式预览画在**预留的固定 4 行**里 (行号恒定, 不借历史行), 见 reserve_stream。
            let (tx, mut rx) = tokio::sync::mpsc::channel::<String>(256);
            let mut fut = std::pin::pin!(llm.generate_streaming("env", params, move |d| {
                // 非阻塞投递: 缓冲满就丢增量 (最终完整文本来自 `res`, 不靠逐帧)
                let _ = tx.try_send(d.to_string());
            }));
            let mut acc = String::new();
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
            let mut last_paint = std::time::Instant::now()
                .checked_sub(std::time::Duration::from_secs(1))
                .unwrap_or_else(std::time::Instant::now);
            let r = loop {
                tokio::select! {
                    rr = &mut fut => break rr,
                    maybe = rx.recv() => {
                        if let Some(d) = maybe {
                            acc.push_str(&d);
                        }
                    }
                    // **一次 Ctrl+C = 中断这一回合** (raw 模式下不会有 SIGINT, 只能读键)
                    _ = watch.recv() => {
                        interrupted = true;
                        break Err(bolloon_llm::LlmError::Network("用户中断".into()));
                    }
                    _ = tick.tick() => {
                        chrome.tick();
                        chrome.refresh_size();
                        flush_logs(chrome, full, true);
                        chrome.draw();
                    }
                }
                // 节流 ~11 FPS 重绘: 增量到达或 tick 都走这里
                if last_paint.elapsed() >= std::time::Duration::from_millis(90) {
                    let chars = acc.chars().count();
                    chrome.activity = tui::Activity::Thinking { started, chars };
                    if stream_block && chars > 0 {
                        let secs = started.elapsed().as_millis() as f64 / 1000.0;
                        let status = format!("◉ Generating · {secs:.1}s · {chars} 字 (Enter 后落成消息)");
                        let frame = tui::render_preview_frame(
                            &acc,
                            "Bolloon Agent",
                            &status,
                            chrome.cols,
                            tui::STREAM_ROWS,
                        );
                        chrome.draw_stream(&frame);
                    }
                    chrome.draw();
                    last_paint = std::time::Instant::now();
                }
            };
            if stream_block {
                chrome.end_stream();
            }
            // 经验闭环: 这一轮的事实入记忆, 攒够轮数就做一次梦 (纯函数整理, 不调模型)
            learn.remember_turn(text, &used_tool_names, true);
            if let Some(rep) = learn.maybe_dream() {
                let line = learning::report_line(&rep);
                emit(chrome, full, &[line]);
            }
            r
        } else {
            tokio::select! {
                r = llm.generate("env", params) => r,
                _ = watch.recv() => {
                    interrupted = true;
                    Err(bolloon_llm::LlmError::Network("用户中断".into()))
                }
            }
        };
        let res = match res {
            Ok(r) => r,
            Err(_) if interrupted => {
                chrome.activity = tui::Activity::Idle;
                flush_logs(chrome, full, false);
                refresh_status(chrome, sess);
                return Err("已中断 (Ctrl+C) · 本回合未完成 (用户消息已保留)".to_string());
            }
            Err(e) => {
                refresh_status(chrome, sess);
                return Err(format!("LLM 调用失败: {e}（已记日志, 不冒充成功回复）"));
            }
        };
        let usage = Some(res.usage);

        // 模型没要工具 ⇒ 本轮就是最终答复, 收口
        if res.tool_calls.is_empty() {
            break (res.content, usage);
        }

        // ── 执行工具 (全部走 Harness 门: discover/permission/policy/budget/idempotency/execute/verify/evidence) ──
        let mut tool_lines: Vec<String> =
            vec![tui::panel::render_tool_calls_header(res.tool_calls.len())];
        let mut tool_msgs: Vec<bolloon_llm::ChatMessage> = vec![];
        for tc in &res.tool_calls {
            let call = bolloon_harness::ToolCall {
                id: tc.id.clone(),
                name: tc.function.name.clone(),
                arguments: serde_json::from_str(&tc.function.arguments)
                    .unwrap_or_else(|_| serde_json::json!({})),
            };
            // 工具是阻塞的: 把 `gate()` 和 100ms tick 放进同一个 select,
            // 谁先到都重绘一次底栏 —— 否则工具跑 8 秒, 输入框动画就冻 8 秒。
            let outcome = {
                let label = tui::trace::trace_label(&tc.function.name).to_string();
                let tool_started = std::time::Instant::now();
                let fut = harness.gate(call);
                tokio::pin!(fut);
                let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        r = &mut fut => break r,
                        _ = tick.tick() => {
                            if full {
                                chrome.activity = tui::Activity::Tool {
                                    name: label.clone(),
                                    started: tool_started,
                                };
                                chrome.draw();
                            }
                        }
                    }
                }
            };
            if full {
                chrome.activity = tui::Activity::Thinking { started, chars: 0 };
            }
            let (out_txt, ok) = if let Some(d) = &outcome.denied {
                (format!("DENIED: {}", d.reason), false)
            } else {
                let r = outcome.result.clone().expect("非 denied 必有 result");
                (r.output.clone(), r.ok)
            };
            tools_used += 1;
            if !used_tool_names.contains(&tc.function.name) {
                used_tool_names.push(tc.function.name.clone());
            }
            let args = serde_json::from_str(&tc.function.arguments).ok();
            let item = tui::panel::ToolCallListItem {
                tool: tui::trace::trace_label(&tc.function.name),
                status: if ok { "ok" } else { "error" }.into(),
                duration_ms: Some(outcome.elapsed_ms), // 真时长 (不再是 None 假行)
                args,
                output: None,
                // 失败显示**结构化**错误码（调用方据此决定重试/改参/重规划），没有人话兜底
                error: if ok {
                    None
                } else {
                    Some(
                        outcome
                            .result
                            .as_ref()
                            .and_then(|r| r.evidence.as_ref())
                            .and_then(|e| bolloon_agent::tool_contract::format_error(Some(e)))
                            .unwrap_or_else(|| out_txt.clone()),
                    )
                },
            };
            tool_lines.push(tui::panel::render_tool_call_list_item(
                &item,
                0,
                res.tool_calls.len(),
            ));
            // 编辑类工具: 把 diff **节选**直接打在工具行下面 (改动看得见, 不靠"已替换"三个字)
            if ok {
                tool_lines.extend(tui::panel::render_diff_excerpt(&out_txt, chrome.cols, 24));
            }
            tool_msgs.push(bolloon_llm::ChatMessage {
                role: "tool".into(),
                content: out_txt,
                name: None,
                tool_call_id: Some(tc.id.clone()),
                images: vec![],
                tool_calls: None,
            });
        }
        if full {
            chrome.print_above(&tool_lines);
        } else {
            for l in &tool_lines {
                println!("{}", plain(l));
            }
        }

        // 回传: assistant(带 tool_calls) + tool 结果 ⇒ 模型据此续轮
        // (此前生产侧写死 `tool_calls: None`, 工具调用在历史上直接丢失, 无法续轮)
        convo.push(bolloon_llm::ChatMessage {
            role: "assistant".into(),
            content: res.content.clone(),
            name: None,
            tool_call_id: None,
            images: vec![],
            tool_calls: Some(
                res.tool_calls
                    .iter()
                    .map(|tc| bolloon_llm::ToolCallMsg {
                        id: tc.id.clone(),
                        call_type: "function".into(),
                        function: tc.function.clone(),
                    })
                    .collect(),
            ),
        });
        convo.extend(tool_msgs);

        if turn >= MAX_TOOL_TURNS {
            // 达上限: 用最后产出的正文收口; 没有正文就如实说没完成, 不伪造"已完成"
            break (
                if res.content.trim().is_empty() {
                    format!("（已连续调用工具 {MAX_TOOL_TURNS} 轮仍未产出最终答复 —— 如实上报, 不冒充完成）")
                } else {
                    res.content.clone()
                },
                usage,
            );
        }
    };

    let elapsed_ms = started.elapsed().as_millis();
    if full {
        chrome.activity = tui::Activity::Idle;
    }

    // 生成期间攒下的日志行 (WARN/ERROR) 先落进历史 —— 告警不许因为"怕脏界面"被吞
    let queued = chrome.take_queued_history();
    if !queued.is_empty() {
        emit(chrome, full, &queued);
    }

    // 空回复**不出空框** —— `render_agent_message` 是唯一收口点
    let boxed = tui::render_agent_message(&final_content);
    let above: Vec<String> = boxed.split('\n').map(|s| s.to_string()).collect();
    if full {
        chrome.print_above(&above);
    } else {
        for l in &above {
            println!("{}", plain(l));
        }
    }

    // 状态栏活数据段: 上游 usage 是真的就拿真的 (没给就不显示, 不编)
    let (ctx_tokens, completion_tokens) = match usage {
        Some(u) => (u.prompt_tokens + u.completion_tokens, u.completion_tokens),
        None => (0, 0),
    };
    let tps = if elapsed_ms > 0 {
        (completion_tokens as u128 * 1000 / elapsed_ms) as u32
    } else {
        0
    };
    chrome.status.stats = tui::TurnStats {
        ctx_tokens,
        elapsed_ms,
        tps,
        tools: tools_used,
    };

    // 会话历史 = 完整轨迹 (含 assistant 的 tool_calls 与 tool 结果); system 提示每轮重建, 不落盘
    sess.messages = convo.into_iter().skip(1).collect();
    let _ = sess.save();
    refresh_status(chrome, sess);
    Ok(())
}

/// 非 TTY (管道 / 重定向 / NO_COLOR) ⇒ **剥掉 ANSI**: 别往管道里灌颜色和光标控制。
///
/// 颜色常量是编译期的 SGR 串, 各个渲染函数都会带上; 所以闸门只放在**真正写 stdout 的那一层**
/// (`emit` / 直接 println 的几处), 一处收口 —— 不逐个渲染函数加开关。
fn plain(line: &str) -> String {
    if tui::color_enabled() {
        line.to_string()
    } else {
        tui::width::strip_ansi(line)
    }
}

/// 按**显示列**截断 (中文 2 列 / Emoji 2 列), 超了用 `…` 收尾。
///
/// 会话标题、状态栏摘要都走它 —— 绝不用字符数或字节数冒充列宽。
pub(crate) fn truncate_display(s: &str, max: usize) -> String {
    tui::width::truncate_safe(s, max)
}

/// 状态栏: 模型名去掉 provider 前缀 (TS `index.ts` L1126-1129), 标题跟着会话走
fn refresh_status(chrome: &mut tui::Chrome, sess: &chat_command::ChatSession) {
    let model = sess
        .model
        .rsplit('/')
        .next()
        .unwrap_or(&sess.model)
        .to_string();
    chrome.status.model = model;
    chrome.status.agent = sess.channel.clone();
    chrome.status.title = sess.title.clone();
}

/// 把几行文本送进历史区 (全屏) 或 stdout (非 TTY)
fn emit(chrome: &mut tui::Chrome, full: bool, lines: &[String]) {
    if full {
        let flat: Vec<String> = lines
            .iter()
            .flat_map(|l| l.split('\n').map(|s| s.to_string()))
            .collect();
        chrome.print_above(&flat);
    } else {
        for l in lines {
            println!("{}", plain(l));
        }
    }
}

/// 把日志队列里的事件搬进界面 (**唯一通道**: 后台任务永远不直接往终端写字)。
///
/// `streaming = true` 时只更新活动行 (流式面板正在长, 不能插历史行把它顶掉);
/// 否则作为历史行落下 —— 告警/错误是用户该看见的东西, 不许"为了界面干净"吞掉。
fn flush_logs(chrome: &mut tui::Chrome, full: bool, streaming: bool) {
    let evs = tui::logbus::drain();
    if evs.is_empty() {
        return;
    }
    if streaming {
        if let Some(last) = evs.last() {
            chrome.note(last.display());
        }
        // 生成中错过的这些照样要在回合收尾时落进历史, 不丢
        for e in &evs {
            if e.level != tui::LogLevel::Info {
                chrome.queue_history_line(e.display());
            }
        }
        return;
    }
    let lines: Vec<String> = evs.iter().map(|e| e.display()).collect();
    emit(chrome, full, &lines);
}

/// CLI 记忆召回文本 (top-N, 复用 MemoryStore::recall 的 importance×decay 打分; 与 Web 同源 SQLite)
fn cli_memory_recall_text() -> String {
    let Ok(db) = memory_db() else { return String::new() };
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let Ok(rows) = db.recall("local", None, 500, now_ms) else { return String::new() };
    let store = bolloon_agent::memory::MemoryStore::from_snapshot(
        rows.into_iter()
            .map(|r| bolloon_agent::memory::MemoryEntry {
                id: format!("mem-{:06}", r.id),
                content: r.content,
                layer: match r.layer.as_str() {
                    "lesson" => bolloon_agent::memory::MemoryLayer::Lesson,
                    "decision" => bolloon_agent::memory::MemoryLayer::Decision,
                    "temporary" => bolloon_agent::memory::MemoryLayer::Temporary,
                    _ => bolloon_agent::memory::MemoryLayer::RunFact,
                },
                importance: r.importance,
                created_at: chrono::DateTime::from_timestamp_millis(r.created_at_ms as i64)
                    .unwrap_or_else(chrono::Utc::now),
                expires_at: r
                    .expires_at_ms
                    .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64)),
            })
            .collect(),
    );
    let hits = store.recall(None, 6, chrono::Utc::now());
    if hits.is_empty() {
        String::new()
    } else {
        hits.iter()
            .map(|e| format!("• {}", e.content))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// 装配 bolloon 身份 system prompt: 单一真源 = `bolloon_agent::prompt::build_system_prompt`
/// (与 web/App 完全一致). 按 `channel` 选全局(home)/项目内(project) 身份文件 (soul/agent/persona).
/// 装配失败降级为最小 bolloon 文本, 绝不因此打断聊天.
fn build_bolloon_system(channel: &str) -> String {
    let home = bolloon_agent::home::BolloonHome::resolve();
    let project = std::env::current_dir().unwrap_or_default();
    let docs = bolloon_agent::home::AgentDocs::freeze_with(&home, "bolloon", channel, &project)
        .unwrap_or_else(|_| bolloon_agent::home::AgentDocs::freeze(&home, "bolloon").unwrap());
    let ctx = bolloon_agent::prompt::AssembleContext {
        channel,
        role: None,
        tool: None,
    };
    // 记忆召回 (top-N) 接进 system prompt —— 之前这一项恒为空, 记忆从未进 prompt
    let memory_text = cli_memory_recall_text();
    bolloon_agent::prompt::build_system_prompt(&docs, None, None, None, 0, "", Some(&memory_text), &ctx).text
}

/// 组装启动 Dashboard 的数据快照 (全部从运行时读, 不硬编码示例)
fn build_dashboard(sess: &chat_command::ChatSession) -> tui::DashboardData {
    let model = sess.model.rsplit('/').next().unwrap_or(&sess.model).to_string();
    // 运行目录: home 折成 ~ (显示用)
    let home = bolloon_agent::home::BolloonHome::resolve()
        .root()
        .to_string_lossy()
        .to_string();
    let dir = sess
        .dir
        .to_string_lossy()
        .replacen(&home, "~", 1)
        .to_string();
    // 技能: 全局 (~/.bolloon/skills.json) + 项目 (sess.dir/../skills.json) 合并, 跨文件夹复用
    let home_path = std::path::PathBuf::from(&home);
    let mut skills: Vec<String> = Vec::new();
    let global_skills = home_path.join("skills.json");
    if global_skills.exists() {
        skills.extend(
            bolloon_agent::skills_runtime::SkillEvolver::load_json(&global_skills)
                .registry
                .names(),
        );
    }
    let proj_skills = sess
        .dir
        .parent()
        .map(|p| p.join("skills.json"))
        .unwrap_or_else(|| std::path::PathBuf::from("skills.json"));
    if proj_skills.exists() {
        for n in bolloon_agent::skills_runtime::SkillEvolver::load_json(&proj_skills)
            .registry
            .names()
        {
            if !skills.contains(&n) {
                skills.push(n);
            }
        }
    }
    // 技能: 除了会话内注册表 (~/.bolloon/skills.json), **还要扫全机已有的 skill 库**。
    // leo 2026-10-27: 「skills 也是全局配置的, 不只是会话内获取, 要在电脑搜集其他已有的 skills,
    // 可以折叠压缩, 不全部显示」。做法 = 目录名即技能名 (不读文件, 1297 个也只要几毫秒),
    // 上限封顶; 面板只列前 8 个 + `… 还有 N 个` (list_block 已有这套折叠)。
    for n in learning::machine_skills(&std::path::PathBuf::from(&home), 2000) {
        if !skills.contains(&n) {
            skills.push(n);
        }
    }

    // MCP: 全局 (~/.bolloon/mcp.json) + 项目 (mcp.json, 含父目录) 合并 server 名
    let mcp = load_mcp_server_names(&home_path, &sess.dir);
    tui::DashboardData {
        product: "BOLLOON".into(),
        version: env!("CARGO_PKG_VERSION").into(),
        build: "local".into(),
        date: chrono::Local::now().format("%Y-%m-%d").to_string(),
        model,
        dir,
        session_id: sess.id.chars().take(8).collect(),
        // 真实注册且**能执行**的工具 (单一真源 = builtin_tool_defs; 迁移中随工具族增长)
        tools: bolloon_agent::builtin_tools::builtin_tool_defs()
            .iter()
            .map(|d| d.name.clone())
            .collect(),
        mcp,
        skills,
        update_status: "⚙ 本地构建".into(),
    }
}

/// 全局 (~/.bolloon/mcp.json) + 项目 (mcp.json, 含父目录) 合并 MCP server 名 (跨文件夹复用)
fn load_mcp_server_names(home: &std::path::Path, project: &std::path::Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |p: &std::path::Path| {
        if !p.exists() {
            return;
        }
        let v: serde_json::Value = match std::fs::read_to_string(p)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(v) => v,
            None => return,
        };
        // 兼容 {"mcpServers": {...}} 与 {"<name>": {...}} 两种形态
        let obj = v
            .get("mcpServers")
            .and_then(|x| x.as_object())
            .or_else(|| v.as_object());
        if let Some(o) = obj {
            for k in o.keys() {
                if !out.contains(k) {
                    out.push(k.clone());
                }
            }
        }
    };
    add(&home.join("mcp.json"));
    add(&project.join("mcp.json"));
    if let Some(parent) = project.parent() {
        add(&parent.join("mcp.json"));
    }
    out
}

/// 选模型供应商 —— 全量 200+ 家 (内置 13 + 目录 223 + 自定义)
///
/// 交互: 全屏光标选择器 (`tui::tui_select`, 支持输入筛选) + 模型行输入 + 密钥**掩码输入**;
/// 落盘: `~/.bolloon/bolloon-config.json` (0600, 与 TS/web 同一份)。
fn run_model(
    provider: Option<String>,
    usable_only: bool,
    filter: Option<String>,
    model_arg: Option<String>,
    base_url: Option<String>,
    api_key_stdin: bool,
) -> anyhow::Result<()> {
    let cfg = bolloon_llm::config_store::load();

    // 目录 → 选择项 (已配置的排在"已配置"组, 其余按来源分组)
    let mut choices: Vec<tui::TuiChoice> = vec![];
    let kw = filter.unwrap_or_default().trim().to_lowercase();
    for e in bolloon_llm::list_with_catalog() {
        let has_key = !e.requires_api_key
            || bolloon_llm::config_store::key_of(&cfg, &e).is_some();
        let is_active = cfg.active_provider.trim() == e.id;
        if usable_only && !has_key {
            continue;
        }
        if !kw.is_empty() {
            let hay = format!(
                "{} {} {} {}",
                e.id,
                e.display_name,
                e.protocol.as_str(),
                e.origin.as_str()
            )
            .to_lowercase();
            if !hay.contains(&kw) {
                continue;
            }
        }
        let group = if is_active {
            "当前".to_string()
        } else if has_key {
            "已配置".to_string()
        } else if e.origin == bolloon_llm::Origin::Builtin {
            "内置".to_string()
        } else {
            "目录".to_string()
        };
        let mark = if is_active { "▶" } else if has_key { "●" } else { "○" };
        let label = format!(
            "{mark} {} · {}{}",
            e.display_name,
            e.id,
            if has_key { "" } else { " (无 key)" }
        );
        let hint = format!(
            "{} · {} · {} 模型 · {}",
            e.protocol.as_str(),
            e.origin.as_str(),
            e.models.len(),
            if e.default_base_url.is_empty() {
                "目录未给基址".to_string()
            } else {
                e.default_base_url.clone()
            }
        );
        choices.push(tui::TuiChoice {
            value: e.id,
            label,
            hint: Some(hint),
            group: Some(group),
            cancel: false,
        });
    }

    let total = bolloon_llm::list_with_catalog().len();
    println!("共 {total} 家可选 (内置 13 + 目录 + 自定义), 当前筛选出 {} 家", choices.len());

    // 非终端 / 显式给了 provider ⇒ 不弹全屏菜单
    let interactive = provider.is_none();
    let picked: Option<String> = if let Some(p) = provider.clone() {
        Some(p)
    } else if !tui::select::tui_capable() {
        for c in choices.iter().take(40) {
            println!(
                "  [{}] {} {}",
                c.group.clone().unwrap_or_default(),
                c.label,
                c.hint.clone().unwrap_or_default()
            );
        }
        println!("用法: bolloon model <provider> [--model <模型>]   (密钥: 交互式掩码输入或环境变量)");
        return Ok(());
    } else {
        let opts = tui::select::SelectOptions {
            unit: "家".to_string(),
            cancel_label: "Cancel (保持当前配置)".into(),
            ..Default::default()
        };
        tui::tui_select("选一个模型供应商", &choices, &opts)
    };

    let Some(id) = picked else {
        println!("已取消 (配置未变)");
        return Ok(());
    };
    // 目录/内置里没有的 id = **自定义家** (必须有 base_url; 交互式会问)
    let mut custom_base: Option<String> = base_url.clone().filter(|b| !b.trim().is_empty());
    let entry = match bolloon_llm::provider_registry::get(&id) {
        Some(e) => e,
        // 已经配过的自定义家 → 沿用它的 base_url/模型/协议 (不用每次重填)
        None if cfg.custom_providers.contains_key(&id) => {
            let c = cfg.custom_providers.get(&id).expect("刚判过存在");
            if custom_base.is_none() && !c.base_url.trim().is_empty() {
                custom_base = Some(c.base_url.clone());
            }
            bolloon_llm::provider_registry::ProviderRegistryEntry {
                id: id.clone(),
                display_name: if c.display_name.is_empty() { id.clone() } else { c.display_name.clone() },
                origin: bolloon_llm::Origin::Custom,
                protocol: c
                    .protocol
                    .unwrap_or_else(|| bolloon_llm::Protocol::infer_from_base_url(&c.base_url)),
                default_base_url: c.base_url.clone(),
                default_model: c.model.clone(),
                api_key_env_vars: vec![],
                auth: bolloon_llm::AuthKind::Bearer,
                auth_supported: true,
                auth_note: "自定义 (自己填的 base_url/协议)".to_string(),
                requires_api_key: false,
                is_local: false,
                family_signal: "自定义".to_string(),
                models: vec![],
            }
        }
        None => {
            let base = match custom_base.clone() {
                Some(b) => b,
                None if tui::select::tui_capable() => {
                    let line = tui::ask_line(
                        &format!("{id} 不在目录里 → API 基址 base_url (例 https://api.xxx.com/v1) › "),
                        &[],
                        false,
                    );
                    if line.cancelled || line.eof || line.value.trim().is_empty() {
                        println!("已取消 (自定义家必须给 base_url)");
                        return Ok(());
                    }
                    line.value.trim().to_string()
                }
                None => anyhow::bail!(
                    "{id} 不在目录里 — 自定义家必须给基址: bolloon model {id} --base-url https://api.xxx.com/v1 --model <模型>"
                ),
            };
            custom_base = Some(base.clone());
            bolloon_llm::provider_registry::ProviderRegistryEntry {
                id: id.clone(),
                display_name: id.clone(),
                origin: bolloon_llm::Origin::Custom,
                protocol: bolloon_llm::Protocol::infer_from_base_url(&base),
                default_base_url: base.clone(),
                default_model: String::new(),
                api_key_env_vars: vec![],
                auth: bolloon_llm::AuthKind::Bearer,
                auth_supported: true,
                auth_note: "自定义 (自己填的 base_url/协议)".to_string(),
                requires_api_key: false,
                is_local: false,
                family_signal: "自定义".to_string(),
                models: vec![],
            }
        }
    };

    // 模型: 命令行给的 → 交互输入 (提示默认与可选数) → 内置默认
    let model = if let Some(m) = model_arg {
        m
    } else if tui::select::tui_capable() && interactive {
        let hint = if entry.default_model.is_empty() {
            if entry.models.len() == 1 {
                entry.models[0].id.clone()
            } else {
                String::new()
            }
        } else {
            entry.default_model.clone()
        };
        println!(
            "{} 有 {} 个模型可选{}",
            entry.display_name,
            entry.models.len(),
            if entry.models.is_empty() {
                String::new()
            } else {
                format!("（前几个: {}）", entry.models.iter().take(5).map(|m| m.id.clone()).collect::<Vec<_>>().join(", "))
            }
        );
        let line = tui::ask_line(&format!("model (回车 = {}) › ", if hint.is_empty() { "手填" } else { &hint }), &[], false);
        if line.cancelled || line.eof {
            println!("已取消 (配置未变)");
            return Ok(());
        }
        if line.value.trim().is_empty() {
            hint
        } else {
            line.value.trim().to_string()
        }
    } else {
        entry.default_model.clone()
    };

    // 密钥: --api-key-stdin 优先 → 否则已有则留空不改 → 交互式掩码输入
    let mut api_key: Option<String> = None;
    if api_key_stdin {
        use std::io::BufRead;
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line)?;
        let k = line.trim().to_string();
        if k.is_empty() {
            anyhow::bail!("--api-key-stdin 但 stdin 是空的");
        }
        api_key = Some(k);
    }
    let already = bolloon_llm::config_store::key_of(&cfg, &entry);
    if api_key.is_none() && entry.requires_api_key && tui::select::tui_capable() {
        let prompt = match &already {
            Some((_, src)) => format!("api_key (已存于 {}, 留空不改) › ", src.as_str()),
            None => "api_key (掩码, 不上屏) › ".to_string(),
        };
        if already.is_some() {
            let line = tui::ask_masked(&prompt);
            if !line.cancelled && !line.eof && !line.value.trim().is_empty() {
                api_key = Some(line.value.trim().to_string());
            }
        } else {
            let line = tui::ask_masked(&prompt);
            if line.cancelled || line.eof {
                println!("已取消 (未读取密钥)");
                return Ok(());
            }
            if !line.value.trim().is_empty() {
                api_key = Some(line.value.trim().to_string());
            }
        }
    }

    // base_url: 命令行给的 / 自定义家已问过 / 目录没给基址的再问一次
    let mut base_override: Option<String> = custom_base.clone();
    if base_override.is_none() && entry.default_base_url.is_empty() {
        if tui::select::tui_capable() {
            let line = tui::ask_line("这家目录里没给 API 基址 → base_url › ", &[], false);
            if line.cancelled || line.eof || line.value.trim().is_empty() {
                println!("未填 base_url — 已取消");
                return Ok(());
            }
            base_override = Some(line.value.trim().to_string());
        } else {
            anyhow::bail!("{id} 目录里没给基址 — 用 --base-url 或 web 界面填");
        }
    }

    let is_custom = bolloon_llm::provider_registry::get(&id).is_none();
    let mut cfg = bolloon_llm::config_store::load();
    if is_custom {
        let base = base_override.clone().unwrap_or_default();
        bolloon_llm::config_store::upsert_custom(
            &mut cfg,
            &id,
            &id,
            &base,
            None,
            api_key.as_deref(),
            if model.trim().is_empty() { None } else { Some(model.trim()) },
        );
    }
    bolloon_llm::config_store::apply_provider(
        &mut cfg,
        &id,
        api_key.as_deref(),
        base_override.as_deref(),
        if model.trim().is_empty() { None } else { Some(model.trim()) },
    );
    bolloon_llm::config_store::save(&cfg)?;

    // 回显: 只报 authRef 与解析结果, 绝不回显密钥
    match bolloon_llm::config_store::resolve(&cfg, &id) {
        Ok(r) => {
            println!("\n✓ 已保存 ({})", bolloon_llm::config_store::config_path().display());
            println!("  provider: {}  ({})", r.id, r.protocol.as_str());
            println!("  base_url: {}", r.base_url);
            println!("  model:    {}", r.model);
            println!("  鉴权:     {}", r.auth_ref());
        }
        Err(e) => {
            println!("\n⚠ 配置已存, 但还不能调用: {e}");
        }
    }
    Ok(())
}

/// 做梦: 整理记忆与经验 → 升级项目 skills
fn run_dream(topic: Option<String>, domain: &str) -> anyhow::Result<()> {
    let home = bolloon_agent::home::BolloonHome::resolve();
    home.ensure_agent("cli")?;
    // 记忆素材 (SQLite 记忆库)
    let db = bolloon_agent::memory_db::MemoryDb::open(
        home.root().join("memory.db").to_str().unwrap_or("memory.db"),
    )?;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let memories: Vec<bolloon_agent::memory::MemoryEntry> = db
        .recall("local", None, 500, now_ms)?
        .into_iter()
        .map(|r| bolloon_agent::memory::MemoryEntry {
            id: format!("mem-{:06}", r.id),
            content: r.content,
            layer: match r.layer.as_str() {
                "lesson" => bolloon_agent::memory::MemoryLayer::Lesson,
                "decision" => bolloon_agent::memory::MemoryLayer::Decision,
                "temporary" => bolloon_agent::memory::MemoryLayer::Temporary,
                _ => bolloon_agent::memory::MemoryLayer::RunFact,
            },
            importance: r.importance,
            created_at: chrono::DateTime::from_timestamp_millis(r.created_at_ms as i64)
                .unwrap_or_else(chrono::Utc::now),
            expires_at: r
                .expires_at_ms
                .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64)),
        })
        .collect();

    // 判断力与 skills 落盘 (跨进程积累: 一夜一夜地升级, 不是每次从零)
    let jpath = home.root().join("judgments.json");
    let spath = home.root().join("skills.json");
    let mut judgments = bolloon_agent::judgment::JudgmentStore::load_json(&jpath);
    let mut skills = bolloon_agent::skills_runtime::SkillEvolver::load_json(&spath);
    let report = bolloon_agent::dream::dream(
        &bolloon_agent::dream::DreamInput { memories: &memories, now_ms },
        &mut judgments,
        &mut skills,
        domain,
    );

    println!("🌙 做梦报告 (domain={domain})");
    println!("  扫描记忆: {} 条 | 过期清除: {} | 归并经验: {} 条", report.scanned, report.expired, report.consolidated);
    println!("  判断力: 新建 {} · 并入 {} · 反向冲突 {}", report.judgments_created, report.judgments_merged, report.judgments_contradicted);
    println!("  skills: 晋升 {} · 被拒 {}", report.skills_promoted, report.skills_rejected);
    if let Some(ins) = &report.insight {
        println!("  🌙 {ins}");
    } else {
        println!("  🌙 梦境空空 — 多对话让记忆沉淀出洞察后, /dream 就有素材了");
    }
    for n in &report.notes {
        println!("  {n}");
    }
    // 落盘 (下次做梦接着升级)
    let _ = judgments.save_json(&jpath);
    let _ = skills.save_json(&spath);
    println!("  ✓ 已沉淀: {} (判断力) · {} (skills)", jpath.display(), spath.display());
    // 主题 → 梦想文档
    if let Some(t) = topic {
        let doc = bolloon_agent::dream::dream_doc(&t, "cli", "cli", &chrono::Utc::now().to_rfc3339());
        let dir = home.root().join("dreams");
        std::fs::create_dir_all(&dir)?;
        let safe: String = t.chars().filter(|c| c.is_alphanumeric() || *c == '-').take(40).collect();
        let path = dir.join(format!("{}-{}.md", chrono::Utc::now().format("%Y-%m-%d"), safe));
        std::fs::write(&path, doc.as_bytes())?;
        println!("  ✓ 梦想文档: {}", path.display());
    }
    Ok(())
}

/// 更新 tip (有更新才 Some; 检测不到/同版本 → None, tip 栏不出现)
fn update_tip() -> Option<String> {
    struct Rel;
    impl bolloon_agent::updater::UpdateSource for Rel {
        fn latest_version(&self) -> Result<String, String> {
            let body: serde_json::Value = ureq::get(
                "https://api.github.com/repos/logos-42/bolloon/releases/latest",
            )
            .timeout(std::time::Duration::from_secs(5))
            .set("User-Agent", "bolloon-updater")
            .call()
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())?;
            body["tag_name"].as_str().map(|s| s.to_string()).ok_or_else(|| "无 tag".into())
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            Err("CLI 用 `bolloon update install` (同 web 一条龙)".into())
        }
    }
    let info = bolloon_agent::updater::check(&Rel);
    if info.update_available {
        Some(format!(
            "tip: ⬆ 有新版本 {} 可用 (当前 {}) — 运行 `bolloon update install` 一键更新",
            info.latest, info.current
        ))
    } else {
        None
    }
}

fn run_update(action: UpdateAction) -> anyhow::Result<()> {
    match action {
        UpdateAction::Check => {
            struct Rel;
            impl bolloon_agent::updater::UpdateSource for Rel {
                fn latest_version(&self) -> Result<String, String> {
                    let body: serde_json::Value = ureq::get(
                        "https://api.github.com/repos/logos-42/bolloon/releases/latest",
                    )
                    .timeout(std::time::Duration::from_secs(5))
                    .set("User-Agent", "bolloon-updater")
                    .call()
                    .map_err(|e| e.to_string())?
                    .into_json()
                    .map_err(|e| e.to_string())?;
                    body["tag_name"].as_str().map(|s| s.to_string()).ok_or_else(|| "无 tag".into())
                }
                fn download(&self) -> Result<Vec<u8>, String> {
                    Ok(vec![])
                }
            }
            let info = bolloon_agent::updater::check(&Rel);
            println!("当前版本: {}", info.current);
            println!("检查状态: {}", info.status);
            if info.update_available {
                println!("⬆ 有新版本 {} 可用 — 运行 `bolloon update install`", info.latest);
                if let Some(n) = info.notes {
                    println!("说明: {n}");
                }
            } else {
                println!("已是最新版本 (无更新提示)");
            }
            Ok(())
        }
        UpdateAction::Install => {
            struct Rel;
            impl bolloon_agent::updater::UpdateSource for Rel {
                fn latest_version(&self) -> Result<String, String> {
                    Ok("latest".into())
                }
                fn download(&self) -> Result<Vec<u8>, String> {
                    let bytes = ureq::get(
                        "https://github.com/logos-42/bolloon/releases/latest/download/bolloon-bin",
                    )
                    .timeout(std::time::Duration::from_secs(120))
                    .call()
                    .map_err(|e| e.to_string())?;
                    let mut out = Vec::new();
                    use std::io::Read;
                    bytes.into_reader().read_to_end(&mut out).map_err(|e| e.to_string())?;
                    Ok(out)
                }
            }
            let self_path = std::env::current_exe()?;
            println!("下载并替换中… (无弹窗, 完成后自动重启)");
            let report = bolloon_agent::updater::install(&Rel, &self_path)?;
            println!("已替换 ({} 字节), 重启中…", report.downloaded_bytes);
            let args: Vec<String> = std::env::args().skip(1).collect();
            match bolloon_agent::updater::restart(&self_path, &args) {
                Ok(pid) => {
                    println!("✅ 新进程已启动 (pid {pid}) — 本进程退出");
                    std::process::exit(0);
                }
                Err(e) => println!("⚠ 重启失败 ({e}) — 新二进制已就位, 请手动重跑"),
            }
            Ok(())
        }
    }
}

fn env_provider_or(default: &str) -> String {
    std::env::var("BOLLOON_BASE_URL").unwrap_or_else(|_| default.to_string())
}

/// rust 原生版数据目录 — **单一真源** (CLI/Web/App/SDK 同一口径: BolloonHome)
fn data_dir() -> std::path::PathBuf {
    bolloon_agent::home::BolloonHome::resolve().root().to_path_buf()
}

/// 记忆库 (SQLite 单一真源 — 与 Web 同源; 做梦/召回都读它)
fn memory_db() -> anyhow::Result<bolloon_agent::memory_db::MemoryDb> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir)?;
    Ok(bolloon_agent::memory_db::MemoryDb::open(
        dir.join("memory.db").to_str().unwrap_or("memory.db"),
    )?)
}

fn layer_name(layer: &str) -> &'static str {
    match layer {
        "lesson" => "lesson",
        "decision" => "decision",
        "temporary" => "temporary",
        _ => "run_fact",
    }
}

fn run_memory(action: MemoryAction) -> anyhow::Result<()> {
    let db = memory_db()?;
    match action {
        MemoryAction::Remember { content, importance, layer } => {
            let name = layer_name(&layer);
            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
            // temporary 层给 1h TTL (与 memory.rs 衰减语义一致)
            let ttl = if name == "temporary" { Some(3_600_000u64) } else { None };
            let row = db.remember("local", name, &content, importance, now_ms, ttl)?;
            println!("已记住 mem-{:06} (layer={}, importance={:.2})", row.id, row.layer, row.importance);
        }
        MemoryAction::Recall { query, top } => {
            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
            let items = db.recall("local", query.as_deref(), top, now_ms)?;
            if items.is_empty() {
                println!("(无匹配记忆)");
                return Ok(());
            }
            for r in items {
                println!("mem-{:06} [{}] {:.2} — {}", r.id, r.layer, r.importance, r.content);
            }
        }
    }
    Ok(())
}

fn run_task(action: TaskAction) -> anyhow::Result<()> {
    match action {
        TaskAction::Publish { capability, digest, budget } => {
            let kp = load_identity_or_create()?;
            let mut board = load_task_board();
            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
            let (id, dup) = board.publish(&kp, &capability, &digest, &budget, None, now_ms);
            save_task_board(&board);
            if dup {
                println!("已存在同内容公告 (dup=true): {id}");
            } else {
                println!("已发布公告 {id} (protocol={}, issuer={})", bolloon_agent::TASK_PROTOCOL, kp.did);
            }
        }
        TaskAction::Id { capability, digest, budget } => {
            let kp = load_identity_or_create()?;
            let mut board = bolloon_agent::TaskBoard::new();
            let (id, _) = board.publish(&kp, &capability, &digest, &budget, None, 0);
            println!("{id}");
        }
    }
    Ok(())
}

/// 公告板落盘 (跨进程 dup 判定才真生效) — 与 web server 同一份文件
fn task_board_path() -> std::path::PathBuf {
    data_dir().join("task-board.json")
}

fn load_task_board() -> bolloon_agent::TaskBoard {
    bolloon_agent::TaskBoard::load_json(&task_board_path())
}

fn save_task_board(board: &bolloon_agent::TaskBoard) {
    let _ = board.save_json(&task_board_path());
}

/// 加载 (或创建) DID 身份 — 与 web server 同一文件
fn load_identity_or_create() -> anyhow::Result<bolloon_p2p::KeyPair> {
    let dir = data_dir();
    let path = dir.join("identity.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(hex_seed) = v["seed_hex"].as_str() {
                if let Ok(seed) = hex::decode(hex_seed) {
                    if seed.len() == 32 {
                        let mut s = [0u8; 32];
                        s.copy_from_slice(&seed);
                        return Ok(bolloon_p2p::KeyPair::from_seed(&s));
                    }
                }
            }
        }
    }
    let kp = bolloon_p2p::KeyPair::generate();
    let _ = std::fs::create_dir_all(&dir);
    let body = serde_json::json!({
        "did": kp.did.as_str(),
        "seed_hex": hex::encode(kp.secret_bytes()),
    });
    std::fs::write(&path, serde_json::to_string_pretty(&body)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(kp)
}

/// chat 的模型通路 —— **与 web / `bolloon model` 同一份配置**
///
/// 顺序: 配置文件里的 activeProvider（`bolloon model` 选的）→ 环境变量三件套 → 本机可用家。
/// 老代码固定用 provider 槽位 `"env"`；这里把选中的那家**装进 `"env"` 槽位**（协议一起带过去），
/// 所以 200+ 家里任何一家（anthropic/gemini/ollama/openai 兼容）都能直接对话。
fn build_chat_llm() -> (Arc<bolloon_llm::LlmRuntime>, String) {
    let cfg = bolloon_llm::config_store::load();
    let mut rt = bolloon_llm::LlmRuntime::from_config(&cfg, 2);
    let mut model = std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());

    let picked = if !cfg.active_provider.trim().is_empty() {
        bolloon_llm::config_store::resolve(&cfg, cfg.active_provider.trim()).ok()
    } else {
        None
    };

    match picked {
        Some(r) => {
            if !r.model.is_empty() {
                model = r.model.clone();
            }
            rt.add_provider_with(
                bolloon_llm::ProviderConfig {
                    id: "env".into(),
                    base_url: r.base_url.clone(),
                    api_key: r.api_key.clone(),
                    default_model: r.model.clone(),
                },
                r.protocol,
            );
        }
        None => {
            // 配置里没有可用家 → 环境变量兜底
            let key = std::env::var("BOLLOON_API_KEY").ok().filter(|k| !k.trim().is_empty());
            if let Some(key) = key {
                let base_url = std::env::var("BOLLOON_BASE_URL")
                    .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string());
                rt.add_provider(bolloon_llm::ProviderConfig {
                    id: "env".into(),
                    base_url,
                    api_key: Some(key),
                    default_model: model.clone(),
                });
            }
        }
    }
    (Arc::new(rt), model)
}

/// 从环境变量构建 LLM runtime（不落盘密钥）
fn build_llm_from_env() -> bolloon_llm::LlmRuntime {
    let base_url = std::env::var("BOLLOON_BASE_URL")
        .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string());
    let api_key = std::env::var("BOLLOON_API_KEY").ok();
    let model = std::env::var("BOLLOON_MODEL")
        .unwrap_or_else(|_| "deepseek-chat".to_string());

    let provider = bolloon_llm::ProviderConfig {
        id: "env".to_string(),
        base_url,
        api_key,
        default_model: model,
    };
    tracing::info!(
        "LLM provider 已配置 (env); key={}",
        if provider.api_key.is_some() { "有" } else { "无" }
    );
    bolloon_llm::LlmRuntime::new(vec![provider], 2)
}
