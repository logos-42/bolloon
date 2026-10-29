//! Bolloon Tauri 桌面外壳
//!
//! 架构纪律 (对齐 docs/wiki/desktop-app-plan.md):
//! - 壳只做: 窗口/托盘/单实例/生命周期 — **壳不写业务分支**
//! - 业务 = bolloon-web axum 服务 (直连 crate, 非 spawn), 随机 127.0.0.1 端口
//! - 数据目录 = ~/.bolloon/rust/ (BOLLOON_HOME 可重定向, 与 CLI 共享)
//! - 窗口加载 http://127.0.0.1:<port> (复用 hushforge 布局单页)
//!
//! 更新 (2026-10-29): 用官方 `tauri-plugin-updater` (v2 兼容) 做**机制层**:
//! 版本检查 / 下载 / **签名验证** / 安装 / 重启全部由插件完成, 壳只暴露两个薄命令
//! (`check_update` / `update_install`) + 一个 `relaunch`, 不写任何业务判断。
//! 前端 (embedded index.html) 持有状态机与 UI, 把"想更新"翻译成 IPC 调用。


use std::sync::atomic::{AtomicBool, Ordering};
use serde_json::json;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// 安装互斥: 同一应用只允许一条安装流 (重复点击/并发 invoke 不重复下载替换)
static UPDATING: AtomicBool = AtomicBool::new(false);

/// RAII 守卫: 离开作用域时复位 UPDATING (无论成功/失败/提前返回)
struct UpdatingGuard;
impl Drop for UpdatingGuard {
    fn drop(&mut self) { UPDATING.store(false, Ordering::SeqCst); }
}

/// 入口: 桌面与移动端共用。
/// 桌面: 起内嵌服务 + 自建主窗口 (加载 127.0.0.1:<port>)。
/// 移动端: 起内嵌服务 + 把 Tauri 的 WebView 导航到同一地址 (界面请求都是相对 /api,
///         必须与 axum 同源, 所以不能用 frontendDist 直接当界面)。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            #[cfg(desktop)]
            {
                #[allow(unused_mut)]
                let mut window_builder = tauri::WebviewWindowBuilder::new(
                    &handle,
                    "main",
                    tauri::WebviewUrl::External(
                        format!("http://127.0.0.1:{port}/?app=desktop").parse().unwrap(),
                    ),
                )
                .title("Bolloon")
                .inner_size(1200.0, 800.0)
                .min_inner_size(900.0, 600.0);

                // 2026-10-28 (用户): 自定义窗口外壳 — 透明标题栏, 由前端 #titlebar 自绘 (品牌+龙订阅)
                // title_bar_style 仅 macOS 可用; Windows/Linux 用默认标题栏。
                #[cfg(target_os = "macos")]
                {
                    window_builder =
                        window_builder.title_bar_style(tauri::TitleBarStyle::Transparent);
                }

                let window = window_builder.build()?;
                let _ = window;
            }

            #[cfg(mobile)]
            {
                // 移动端 WebView 已由 Tauri 创建: 等它可用后导航到内嵌服务 (同源 /api)
                let nav_handle = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let url = format!("http://127.0.0.1:{port}/?app=mobile");
                    for _ in 0..50 {
                        if let Some(w) = nav_handle.get_webview_window("main") {
                            let js = format!("window.location.replace({:?});", url);
                            let _r: Result<(), _> = w.eval(js.as_str());
                            if _r.is_ok() {
                                tracing::info!("mobile webview → {url}");
                                return;
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    }
                    tracing::error!("mobile webview 导航失败: 找不到 main window");
                });
            }

            tracing::info!("bolloon tauri shell ready: http://127.0.0.1:{port}");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_update,
            update_install,
            relaunch
        ])
        .run(tauri::generate_context!())
        .expect("tauri 启动失败");
}

/// 构造 updater, 统一的 30s 网络超时 (要求: 网络超时可配置)。
fn make_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("updater 初始化失败: {e}"))
}

/// 向前端广播状态机状态 (idle/checking/up-to-date/update-available/downloading/
/// verifying/installing/restart-required/completed/failed)。
fn emit_state(app: &tauri::AppHandle, state: &str, extra: serde_json::Value) {
    let payload = json!({ "state": state, "detail": extra });
    let _ = app.emit("update-state", payload);
}

/// 手动/启动检查更新。
///
/// 返回:
/// - `{ available: false, current_version, reason? }` — 已是最新 / 检查失败也带 reason
/// - `{ available: true, current_version, version, notes, date }` — 有新版本
///
/// 关键: 任何错误都显式返回 reason, **绝不**谎报"已是最新"。
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let updater = make_updater(&app)?;
    let current = app.package_info().version.to_string();
    emit_state(&app, "checking", json!({}));
    let update = match updater.check().await {
        Ok(u) => u,
        Err(e) => {
            // 网络/清单不可达 ≠ 最新: 明确报错, 让前端显示"检查失败"并可重试
            emit_state(&app, "failed", json!({ "stage": "checking", "reason": e.to_string() }));
            return Err(format!("检查更新失败: {e}"));
        }
    };
    match update {
        Some(u) => {
            emit_state(
                &app,
                "update-available",
                json!({ "version": u.version, "current_version": current }),
            );
            Ok(json!({
                "available": true,
                "current_version": current,
                "version": u.version,
                "notes": u.body,
                "date": u.date.map(|d| d.to_string()),
            }))
        }
        None => {
            emit_state(&app, "up-to-date", json!({ "current_version": current }));
            Ok(json!({
                "available": false,
                "current_version": current,
            }))
        }
    }
}

/// 下载 + (插件自动)签名验证 + 安装。进度与状态通过事件流给前端。
///
/// 流程: downloading(真实进度) → verifying(插件验签, 验不过直接失败) → installing →
///       重启交给前端调用 `relaunch` (显式重启, 给用户保存工作的窗口)。
///
/// 注意: 验签失败由 `tauri-plugin-updater` 在 `download_and_install` 内部抛出,
///       我们把它映射成错误 → failed(signature_failed:true), **绝不安装**。
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // 安装互斥: 已有安装流在跑则直接拒绝 (重复点击/并发 invoke)
    if UPDATING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        emit_state(&app, "failed", json!({ "stage": "install", "reason": "已有更新正在安装，请勿重复点击" }));
        return Err("已有更新正在安装".into());
    }
    let _guard = UpdatingGuard;
    let updater = make_updater(&app)?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            emit_state(&app, "failed", json!({ "stage": "install", "reason": "没有可安装的新版本" }));
            return Err("没有可安装的新版本".into());
        }
        Err(e) => {
            emit_state(&app, "failed", json!({ "stage": "checking", "reason": e.to_string() }));
            return Err(format!("检查更新失败: {e}"));
        }
    };
    let target_version = update.version.clone();

    // 进度回调只给 (本次 chunk 字节, 总字节 Option) — 累计已下载量需自己维护
    let dl_app = app.clone();
    let verify_app = app.clone();
    let mut downloaded: u64 = 0;
    emit_state(&app, "downloading", json!({ "version": target_version }));
    let result = update
        .download_and_install(
            move |chunk_len: usize, content_length: Option<u64>| {
                downloaded += chunk_len as u64;
                let total = content_length.unwrap_or(0);
                let percent = if total > 0 {
                    ((downloaded as f64 / total as f64) * 100.0).round() as u32
                } else {
                    0
                };
                let _ = dl_app.emit(
                    "update-progress",
                    json!({
                        "downloaded": downloaded,
                        "total": total,
                        "percent": percent,
                    }),
                );
            },
            move || {
                // 下载完成 → 进入验签+安装前 (插件在 install 阶段真正验签)
                let _ = verify_app.emit("update-progress", json!({ "downloaded": 0, "total": 0, "percent": 100 }));
            },
        )
        .await;

    match result {
        Ok(()) => {
            // 验签 + 安装成功。先标记 installing, 再交前端显式重启。
            let _ = app.emit("update-state", json!({ "state": "installing", "detail": json!({}) }));
            emit_state(&app, "restart-required", json!({ "version": target_version }));
            Ok(json!({ "ok": true, "installed": true, "version": target_version }))
        }
        Err(e) => {
            let reason = e.to_string();
            // 区分签名失败 / 网络失败 / 损坏包
            let is_sig = reason.to_lowercase().contains("sign") || reason.to_lowercase().contains("signature");
            emit_state(
                &app,
                "failed",
                json!({
                    "stage": if is_sig { "verifying" } else { "downloading" },
                    "reason": reason,
                    "signature_failed": is_sig,
                }),
            );
            Err(reason)
        }
    }
}

/// 安装完成后显式重启应用 (前端"立即重启"按钮调用)。
///
/// macOS 替换的是 `.app` 包内的可执行文件, Windows/Linux 同理; 重启由 Tauri 负责
/// 拉起新版本二进制。数据目录在 `~/.bolloon`, 与 app 包分离, 重启不丢数据。
#[tauri::command]
async fn relaunch(app: tauri::AppHandle) {
    tracing::info!("更新安装完成, 用户确认重启 → relaunch");
    // AppHandle::restart() 重启当前应用 (macOS/Linux 必须; Windows 安装器已自退出)。
    app.restart();
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
