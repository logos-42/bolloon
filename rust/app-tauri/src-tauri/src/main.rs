//! Bolloon Tauri 桌面外壳
//!
//! 架构纪律 (对齐 docs/wiki/desktop-app-plan.md):
//! - 壳只做: 窗口/托盘/单实例/生命周期 — **壳不写业务分支**
//! - 业务 = bolloon-web axum 服务 (直连 crate, 非 spawn), 随机 127.0.0.1 端口
//! - 数据目录 = ~/.bolloon/rust/ (BOLLOON_HOME 可重定向, 与 CLI 共享)
//! - 窗口加载 http://127.0.0.1:<port> (复用 hushforge 布局单页)

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            // ① 起内嵌业务服务 (随机端口, 只绑回环)
            let port: u16 = 20000 + (rand::random::<u16>() % 20000);
            let llm = build_llm_from_env();
            let state = bolloon_web::AppState::new(llm);
            let handle = app.handle().clone();
            let handle_for_task = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = bolloon_web::serve(state, port).await {
                    tracing::error!("内嵌服务退出: {e}");
                    handle_for_task.exit(1);
                }
            });

            // ② 主窗口加载内嵌服务
            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                "main",
                tauri::WebviewUrl::External(format!("http://127.0.0.1:{port}").parse().unwrap()),
            )
            .title("Bolloon — 去中心化智能体资源交流网络")
            .inner_size(1200.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            let _ = window;

            tracing::info!("bolloon tauri shell ready: http://127.0.0.1:{port}");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("tauri 启动失败");
}

/// 从环境变量构建 LLM runtime (与 CLI 同口径, 不落盘密钥)
fn build_llm_from_env() -> bolloon_llm::LlmRuntime {
    let base_url = std::env::var("BOLLOON_BASE_URL")
        .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string());
    let api_key = std::env::var("BOLLOON_API_KEY").ok();
    let model = std::env::var("BOLLOON_MODEL").unwrap_or_else(|_| "deepseek-chat".to_string());
    bolloon_llm::LlmRuntime::new(
        vec![bolloon_llm::ProviderConfig {
            id: "env".into(),
            base_url,
            api_key,
            default_model: model,
        }],
        2,
    )
}
