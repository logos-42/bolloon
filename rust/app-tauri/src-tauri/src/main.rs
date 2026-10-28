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
            //    2026-10-26: URL 带 ?app=desktop — UI 侧据此启用三栏式侧边导航
            //    (浏览器直接访问同一端口不带该参数, 仍是原单侧栏布局, 网页端不变)
            let window = tauri::WebviewWindowBuilder::new(
                &handle,
                "main",
                tauri::WebviewUrl::External(
                    format!("http://127.0.0.1:{port}/?app=desktop").parse().unwrap(),
                ),
            )
            .title("Bolloon")
            // 2026-10-28 (用户): 自定义窗口外壳 — 透明标题栏, 由前端 #titlebar 自绘 (品牌 + 龙订阅)
            .title_bar_style(tauri::TitleBarStyle::Transparent)
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
