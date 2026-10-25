//! Bolloon CLI — 命令入口（rust 原生版, 版本 0.6.10）
//!
//! 命令面（与 TS 版对齐的核心部分）:
//!   bolloon                 → 启动 web (默认 54188)
//!   bolloon web [--port N]  → 启动 web
//!   bolloon status          → 状态
//!   bolloon --version       → 版本

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