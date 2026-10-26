//! Bolloon CLI — 命令入口（rust 原生版, 版本 0.6.10）
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
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

mod chat_command;
mod slash;

#[derive(Parser)]
#[command(name = "bolloon", version = "0.6.10", about = "Bolloon — 去中心化智能体资源交流网络 (Rust 原生版)")]
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
    },
    /// 选模型供应商 (全屏光标选择器 + 掩码输入, 复用原 TS tui-select)
    Model,
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
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cli = Cli::parse();

    match cli.command {
        None => run_web(54188).await, // 无子命令 → 启动 web（对齐 TS: bolloon 默认起本地服务）
        Some(Commands::Web { port }) => run_web(port).await,
        Some(Commands::Status) => run_status(),
        Some(Commands::Memory { action }) => run_memory(action),
        Some(Commands::Task { action }) => run_task(action),
        Some(Commands::Chat { channel }) => run_chat(&channel).await,
        Some(Commands::Model) => run_model(),
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

/// 交互式会话 —— 消息框走 `tui::render_user_message` / `render_agent_message`
async fn run_chat(channel: &str) -> anyhow::Result<()> {
    let llm = Arc::new(build_llm_from_env());
    let model = std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());

    tui::print_banner(Some(env!("CARGO_PKG_VERSION")));

    let mut history = tui::load_input_history(Some(channel));
    // 会话本体 (消息/标题/模型/附件 + 落盘): 命令逻辑全在 `chat_command`, 这里只做接线
    let mut sess = chat_command::ChatSession::new(&model, channel);
    let jobs = chat_command::Jobs::new();
    let ctx = chat_command::ChatCtx {
        llm: Arc::clone(&llm),
        jobs: &jobs,
    };

    // 全屏面板壳 (**几何不抖**: 帧高恒定 / 输入行号恒定 / 跟随可暂停) —— 只有真终端才用;
    //   非 TTY 走下面的纯 println 分支, 免得往管道里灌 ANSI。
    let full = tui::select::tui_capable();
    // 帧高 = 终端行数 **减 1**: 最后一行留给输入块 (`ask_line` 就在它上面原地重画)。
    //   不减这一行的话, 单行输入也会把整帧顶上去一格 (帧顶那条永远看不到); 多行输入
    //   (`Ctrl+J`) 再额外占行, 靠往上滚消化 —— 这是**有意的**, 与 `screen` 的帧内几何无关。
    let frame_rows = if full {
        Some(tui::width::term_height().saturating_sub(1))
    } else {
        None
    };
    let mut screen = tui::Screen::new(None, frame_rows);
    // 提示行是 Screen 的最后一个固定行 (rows-1); 文案唯一事实源在 `tui::help`
    screen.hint = tui::help::HINT.to_string();
    screen.status = status_line(&sess);
    let mut drawn: usize = 0;
    // `/undo` 回退出来的那条消息放这里, 下一轮直接进输入框 (不替人自动发送)
    let mut prefill = String::new();
    // **整段会话持有 raw 模式**: 提交后到下一次输入之间(画帧/等模型)也必须是 raw,
    //   否则抢先敲的 `\r` 会被 cooked 行规程换成 `\n`(Enter 变换行), 整行还会压在
    //   canonical 缓冲里等换行 ⇒ 两句并成一句。机制见 `tui::input::RawState`。
    let raw = tui::input::hold_raw_mode();
    // 毫秒时钟: 轮末 agent 循环判 loop 任务是否"到点"
    let now_ms = || SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u128;

    loop {
        if full {
            if drawn > 0 {
                // 回到帧首 + 清到屏末 (重绘一帧的起点, 也是帧的分界)
                print!("\x1b[{drawn}A\x1b[J");
            }
            print!("{}", screen.render());
            println!(); // 输入行单独占一行 (ask_line 在它上面原地重画)
            drawn = screen.rows() + 1;
        } else if sess.messages.is_empty() {
            println!("{}", screen.hint);
        }

        // 轮末 agent 循环: 到点的 loop → steer → queue 优先自动跑;
        // 只有没自动任务时才阻塞等用户输入 (auto 条目不进输入历史)
        let (text, is_auto) = if let Some(sched) = sess.next_scheduled(now_ms()) {
            (format!("{} {}", sched.marker(), sched.text()), true)
        } else {
            let r = tui::ask_line_with("› ", &history, &prefill, false);
            prefill.clear();
            if r.eof {
                break; // Ctrl+D / 管道断了
            }
            if r.cancelled {
                // Esc / Ctrl+C 只**丢掉这一行输入** (以前是直接退出会话 —— 回填/改稿时太容易误杀);
                //   退出走 `/exit` 或 Ctrl+D
                emit(
                    &mut screen,
                    full,
                    &["(已取消当前输入 · 退出用 /exit 或 Ctrl+D)".to_string()],
                );
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
                    emit(&mut screen, full, &lines);
                    screen.status = status_line(&sess);
                    continue;
                }
                chat_command::Cmd::Prefill(back) => {
                    prefill = back;
                    continue;
                }
                chat_command::Cmd::Clear | chat_command::Cmd::Redraw => {
                    // 真清屏: 从 0 重画 (正文也一起没了 —— /clear 的语义就是"从头来")
                    print!("\x1b[2J\x1b[H");
                    drawn = 0;
                    screen.status = status_line(&sess);
                    continue;
                }
                chat_command::Cmd::Update { install } => {
                    let action = if install { UpdateAction::Install } else { UpdateAction::Check };
                    let lines = match run_update(action) {
                        Ok(()) => vec!["✓ 更新流程已执行 (输出见上)".to_string()],
                        Err(e) => vec![format!("✗ 更新失败: {e}")],
                    };
                    emit(&mut screen, full, &lines);
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
                &mut screen,
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

        // 附件 (`/image` `/paste`) 真进模型: build_user_message 把文件读成 base64 data URL
        // 塞进 ChatMessage.images (OpenAI 视觉数组), 正文仍留 @路径供人核对; 失败时附件原样保留
        let user_msg = match sess.build_user_message(&prompt) {
            Ok(m) => m,
            Err(e) => {
                emit(
                    &mut screen,
                    full,
                    &[
                        format!("✗ 附件没发出去: {e}"),
                        "  (附件已保留; 换支持视觉的模型, 或 BOLLOON_VISION=1 强制重发)".to_string(),
                    ],
                );
                continue;
            }
        };
        sess.attachments.clear();

        let user_box = tui::render_user_message(&user_msg.content);
        if full {
            screen.push_many(&user_box);
            screen.status = status_line(&sess);
        } else {
            println!("{user_box}");
        }
        sess.messages.push(bolloon_llm::ChatMessage {
            role: "user".into(),
            content: user_msg.content.clone(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: user_msg.images,
        });
        let _ = sess.save();

        let params = bolloon_llm::GenerateParams::new(&sess.model, sess.messages.clone());
        match llm.generate("env", params).await {
            Ok(res) => {
                // 工具调用行: 一行说清**它在做什么** (复用 TS trace-line 的中文动作短语)
                if !res.tool_calls.is_empty() {
                    let header = tui::panel::render_tool_calls_header(res.tool_calls.len());
                    if full {
                        screen.push(&header);
                    } else {
                        println!("{header}");
                    }
                    for c in &res.tool_calls {
                        let item = tui::panel::ToolCallListItem {
                            tool: c.function.name.clone(),
                            status: "ok".into(),
                            duration_ms: None,
                            args: serde_json::from_str(&c.function.arguments).ok(),
                            output: None,
                            error: None,
                        };
                        let line = tui::panel::render_tool_call_list_item(&item, 0, res.tool_calls.len());
                        if full {
                            screen.push(&line);
                        } else {
                            println!("{line}");
                        }
                    }
                }
                // 空回复**不出空框** —— `render_agent_message` 是唯一收口点
                let boxed = tui::render_agent_message(&res.content);
                if full {
                    screen.push_many(&boxed);
                } else {
                    println!("{boxed}");
                }
                sess.messages.push(bolloon_llm::ChatMessage {
                    role: "assistant".into(),
                    content: res.content,
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                });
                let _ = sess.save();
            }
            Err(e) => {
                let msg = format!("✗ LLM 调用失败: {e}（已记日志, 不冒充成功回复）");
                if full {
                    screen.push(&msg);
                } else {
                    println!("{msg}");
                }
            }
        }

        // ── 轮末 agent 循环 ── 到点的 loop → steer → queue 自动跑。
        // **成功/失败都要跑**: 没配 key 时也要把队列/插话/loop 推完 (每轮失败就停, 不刷屏)。
        // 单次会话内最多 6 轮自动, 防止把终端吞住; 用户下次输入仍优先。
        let mut auto_rounds = 0usize;
        loop {
            auto_rounds += 1;
            if auto_rounds > 6 {
                emit(
                    &mut screen,
                    full,
                    &["… 自动循环已连跑 6 轮, 先停下 (/busy interrupt 可整体暂停)".to_string()],
                );
                break;
            }
            let Some(sched) = sess.next_scheduled(now_ms()) else { break };
            let auto_text = format!("{} {}", sched.marker(), sched.text());
            let is_loop = matches!(sched, chat_command::Scheduled::Loop(_));
            match send_one(&mut screen, full, &mut sess, &llm, &auto_text).await {
                Ok(()) => {
                    if is_loop {
                        for l in sess.after_loop_turn(&ctx).await {
                            emit(&mut screen, full, &[l]);
                        }
                    }
                    screen.status = status_line(&sess);
                }
                Err(e) => {
                    emit(&mut screen, full, &[format!("✗ 自动循环: {e}")]);
                    break;
                }
            }
        }
    }
    drop(raw); // 先还终端, 再打印收尾 (不然输出会粘在输入行上)
    println!("{}已退出会话{}", tui::theme::C_DIM, tui::theme::RESET);
    Ok(())
}

/// 发一条用户消息, 把模型回复贴进屏与会话。
/// 附件已在 `build_user_message` 里读成 base64 data URL 进 `ChatMessage.images` (多模态, 真进模型)。
async fn send_one(
    screen: &mut tui::Screen,
    full: bool,
    sess: &mut chat_command::ChatSession,
    llm: &LlmRuntime,
    text: &str,
) -> Result<(), String> {
    let user_msg = match sess.build_user_message(text) {
        Ok(m) => m,
        Err(e) => return Err(format!("附件发送失败: {e} (附件已保留)")),
    };
    sess.attachments.clear();

    let user_box = tui::render_user_message(&user_msg.content);
    if full {
        screen.push_many(&user_box);
        screen.status = status_line(sess);
    } else {
        println!("{user_box}");
    }
    sess.messages.push(bolloon_llm::ChatMessage {
        role: "user".into(),
        content: user_msg.content.clone(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: user_msg.images,
    });
    let _ = sess.save();

    let params = bolloon_llm::GenerateParams::new(&sess.model, sess.messages.clone());
    match llm.generate("env", params).await {
        Ok(res) => {
            if !res.tool_calls.is_empty() {
                let header = tui::panel::render_tool_calls_header(res.tool_calls.len());
                if full {
                    screen.push(&header);
                } else {
                    println!("{header}");
                }
                for c in &res.tool_calls {
                    let item = tui::panel::ToolCallListItem {
                        tool: c.function.name.clone(),
                        status: "ok".into(),
                        duration_ms: None,
                        args: serde_json::from_str(&c.function.arguments).ok(),
                        output: None,
                        error: None,
                    };
                    let line = tui::panel::render_tool_call_list_item(&item, 0, res.tool_calls.len());
                    if full {
                        screen.push(&line);
                    } else {
                        println!("{line}");
                    }
                }
            }
            let boxed = tui::render_agent_message(&res.content);
            if full {
                screen.push_many(&boxed);
            } else {
                println!("{boxed}");
            }
            sess.messages.push(bolloon_llm::ChatMessage {
                role: "assistant".into(),
                content: res.content,
                name: None,
                tool_call_id: None,
                images: vec![],
                tool_calls: None,
            });
            let _ = sess.save();
            Ok(())
        }
        Err(e) => Err(format!("LLM 调用失败: {e}（已记日志, 不冒充成功回复）")),
    }
}

/// 状态栏文案 (会话 ID 短尾 + 模型 + 渠道) —— 命令改了模型/标题后要跟着变
fn status_line(sess: &chat_command::ChatSession) -> String {
    let tail: String = sess.id.chars().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect();
    format!("model {} · 会话 {} · {}", sess.model, sess.channel, tail)
}

/// 把几行文本送进 transcript (全屏) 或 stdout (非 TTY)
fn emit(screen: &mut tui::Screen, full: bool, lines: &[String]) {
    if full {
        screen.push_many(&lines.join("\n"));
    } else {
        for l in lines {
            println!("{l}");
        }
    }
}

/// 选模型供应商 —— 全屏光标选择器 (`tui::tui_select`) + 密钥走**掩码输入** (明文不上屏)
fn run_model() -> anyhow::Result<()> {
    let llm = build_llm_from_env();
    let mut choices: Vec<tui::TuiChoice> = llm
        .provider_ids()
        .iter()
        .map(|id| tui::TuiChoice {
            value: id.clone(),
            label: format!("● {id} (已配置)"),
            hint: llm.provider(id).map(|p| p.base_url.clone()),
            group: Some("已配置".into()),
            cancel: false,
        })
        .collect();
    for (id, url) in [
        ("openai", "https://api.openai.com/v1"),
        ("deepseek", "https://api.deepseek.com/v1"),
        ("minimaxi", "https://api.minimaxi.com/v1"),
        ("ollama", "http://127.0.0.1:11434/v1"),
        ("custom", "(自定义 base_url)"),
    ] {
        choices.push(tui::TuiChoice {
            value: id.to_string(),
            label: format!("○ {id}"),
            hint: Some(url.to_string()),
            group: Some("内置".into()),
            cancel: false,
        });
    }

    let opts = tui::select::SelectOptions {
        unit: "家".to_string(),
        cancel_label: "Cancel (保持当前配置)".into(),
        ..Default::default()
    };

    if !tui::select::tui_capable() {
        // 非终端 ⇒ 不进全屏菜单 (与 TS 同: 本模块不做降级决定, 由调用方分流)
        for (i, c) in choices.iter().enumerate() {
            println!("{:>3}. {} {}", i + 1, c.label, c.hint.clone().unwrap_or_default());
        }
        println!("用法: BOLLOON_BASE_URL / BOLLOON_API_KEY / BOLLOON_MODEL 三个环境变量生效");
        return Ok(());
    }

    match tui::tui_select("选一个模型供应商", &choices, &opts) {
        None => println!("已取消 (配置未变)"),
        Some(id) => {
            println!("已选: {id}");
            let base = tui::ask_line("base_url › ", &[], false);
            if base.cancelled || base.eof || base.value.trim().is_empty() {
                println!(
                    "未填 base_url — 沿用 {}",
                    llm.provider("env").map(|p| p.base_url.clone()).unwrap_or_default()
                );
                return Ok(());
            }
            let key = tui::ask_masked("api_key (掩码, 不上屏) › ");
            if key.cancelled || key.eof {
                println!("已取消 (未读取密钥)");
                return Ok(());
            }
            // **诚实边界**: Rust 侧还没有 config store ⇒ 本命令**不落盘**, 只给出 env 用法,
            //   且**绝不回显密钥** (只报长度)。
            println!("\n生效方式 (当前进程):");
            println!("  export BOLLOON_BASE_URL={}", base.value.trim());
            println!(
                "  export BOLLOON_API_KEY=<你的密钥: 已读入 {} 个字符, 不回显>",
                key.value.chars().count()
            );
            println!("\n注: Rust 侧暂无 config store, 本命令不写盘; 落盘待 setup 那条线。");
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
