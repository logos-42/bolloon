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
            // tip 栏: 有更新才显示 (未检测到/检测不到都不出现)
            if let Some(tip) = update_tip() {
                println!("{tip}");
            }
            Ok(())
        }
        Some(Commands::Memory { action }) => run_memory(action),
        Some(Commands::Task { action }) => run_task(action),
        Some(Commands::Update { action }) => run_update(action),
        Some(Commands::Dream { topic, domain }) => run_dream(topic, &domain),
    }
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
