//! Bolloon CLI — 命令入口（rust 原生版, 版本 0.6.10）
//!
//! 命令面（与 TS 版对齐的核心部分）:
//!   bolloon                        → 启动 web (默认 54188)
//!   bolloon web [--port N]         → 启动 web
//!   bolloon status                 → 状态
//!   bolloon memory remember|recall → 记忆 (落盘 ~/.bolloon/rust/memory.json)
//!   bolloon task publish|id        → 任务公告 (bolloon-task/1)
//!   bolloon --version              → 版本

use clap::{Parser, Subcommand};

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
        None => {
            // 无子命令 → 启动 web（对齐 TS: bolloon 默认起本地服务）
            print_banner();
            let llm = build_llm_from_env();
            let state = bolloon_web::AppState::new(llm);
            bolloon_web::serve(state, 54188).await?;
            Ok(())
        }
        Some(Commands::Web { port }) => {
            print_banner();
            let llm = build_llm_from_env();
            let state = bolloon_web::AppState::new(llm);
            bolloon_web::serve(state, port).await?;
            Ok(())
        }
        Some(Commands::Status) => {
            println!("bolloon 0.6.10 (rust native)");
            println!("双内核: Kernel (channel-actor/model-runtime/ha) + Harness (工具门)");
            println!("provider: {}", env_provider_or("未配置 (BOLLOON_BASE_URL)"));
            println!("web: http://127.0.0.1:54188");
            println!("data: {}", data_dir().display());
            Ok(())
        }
        Some(Commands::Memory { action }) => run_memory(action),
        Some(Commands::Task { action }) => run_task(action),
    }
}

fn print_banner() {
    println!("🜁 Bolloon 0.6.10 (rust native) — 去中心化智能体资源交流网络");
}

fn env_provider_or(default: &str) -> String {
    std::env::var("BOLLOON_BASE_URL").unwrap_or_else(|_| default.to_string())
}

/// rust 原生版数据目录 — **单一真源** (CLI/Web/App/SDK 同一口径: BolloonHome)
fn data_dir() -> std::path::PathBuf {
    bolloon_agent::home::BolloonHome::resolve().root().to_path_buf()
}

fn memory_path() -> std::path::PathBuf {
    data_dir().join("memory.json")
}

fn load_memory_store() -> bolloon_agent::MemoryStore {
    match std::fs::read_to_string(memory_path()) {
        Ok(raw) => serde_json::from_str::<Vec<bolloon_agent::MemoryEntry>>(&raw)
            .map(bolloon_agent::MemoryStore::from_snapshot)
            .unwrap_or_default(),
        Err(_) => bolloon_agent::MemoryStore::new(),
    }
}

fn save_memory_store(store: &bolloon_agent::MemoryStore) {
    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(raw) = serde_json::to_string_pretty(store.snapshot()) {
        let _ = std::fs::write(memory_path(), raw);
    }
}

fn run_memory(action: MemoryAction) -> anyhow::Result<()> {
    match action {
        MemoryAction::Remember { content, importance, layer } => {
            let layer = match layer.as_str() {
                "lesson" => bolloon_agent::MemoryLayer::Lesson,
                "decision" => bolloon_agent::MemoryLayer::Decision,
                "temporary" => bolloon_agent::MemoryLayer::Temporary,
                _ => bolloon_agent::MemoryLayer::RunFact,
            };
            let mut store = load_memory_store();
            let entry = store.remember(content, layer, importance, None).clone();
            save_memory_store(&store);
            println!("已记住 {} (layer={}, importance={:.2})", entry.id, entry.layer, entry.importance);
        }
        MemoryAction::Recall { query, top } => {
            let store = load_memory_store();
            let items = store.recall(query.as_deref(), top, chrono::Utc::now());
            if items.is_empty() {
                println!("(无匹配记忆)");
                return Ok(());
            }
            for e in items {
                println!("{} [{}] {:.2} — {}", e.id, e.layer, e.importance, e.content);
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
