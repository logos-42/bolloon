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
            // ⓪ 菜单: Tauri 缺省菜单是英文 (About Bolloon / Hide / Quit / File / Edit ...)。
            //    2026-10-30 (用户): 「bolloon 的左上角按钮打开也是英文的」⇒ 自己装一份中文菜单。
            //    菜单项全用 PredefinedMenuItem: 动作仍是系统标准实现 (退出/复制/粘贴/最小化…),
            //    壳不写业务; 只在文字上做本地化。
            #[cfg(desktop)]
            install_chinese_menu(app)?;
            // 菜单栏图标 (macOS 顶部菜单栏右侧) — 用户: 「Mac 栏的菜单栏图标要有」
            #[cfg(desktop)]
            install_tray(app.handle())?;

            // ① 先把端口**真的 bind 上** (backlog 会替我们排队), 再起异步服务。
            //    ⚠ 2026-10-30 (实测): 若先建窗、服务之后才 listen, 首次导航会打到还没起来的端口
            //    ⇒ 白页; 而窗口是 transparent 的, 白页 = 整窗看不见 (用户以为应用没启动)。
            //    反过来若把建窗推给 run_on_main_thread 异步建, 窗口/WebView 会建出来但不可见
            //    (实测: 页面 JS 在跑, 窗口却抓不到图)。所以顺序是: bind → 后台 serve → 同步建窗。
            let llm = build_llm_from_env();
            let state = bolloon_web::AppState::new(llm);
            let handle = app.handle().clone();
            #[cfg(desktop)]
            let _ = &handle; // 桌面只用 app.handle(), handle 留给移动端分支
            let handle_for_task = handle.clone();
            let listener = bind_loopback()?;
            let port = listener.local_addr()?.port();
            tauri::async_runtime::spawn(async move {
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(l) => l,
                    Err(e) => {
                        tracing::error!("内嵌服务监听器移交失败: {e}");
                        handle_for_task.exit(1);
                        return;
                    }
                };
                if let Err(e) = bolloon_web::serve_on(state, listener).await {
                    tracing::error!("内嵌服务退出: {e}");
                    handle_for_task.exit(1);
                }
            });

            // ② 主窗口加载内嵌服务 (主线程同步建, 端口此刻已在 listen)
            //    2026-10-26: URL 带 ?app=desktop — UI 侧据此启用三栏式侧边导航
            //    (浏览器直接访问同一端口不带该参数, 仍是原单侧栏布局, 网页端不变)
            #[cfg(desktop)]
            {
                // 2026-10-30: 建窗前用 poll 的同步退避版确认端口真可连 (bind 已完成 ⇒ 通常第一次就过),
                // 与 CLI/Web 用同一套节奏; 起不来也照建窗口 (但会记日志, 不再静默白页)。
                let addr = format!("127.0.0.1:{port}");
                match bolloon_agent::poll::wait_tcp_blocking(
                    &addr,
                    bolloon_agent::poll::PollConfig::default().max_retries(6),
                ) {
                    bolloon_agent::poll::PollResult::Success => {
                        tracing::info!("[boot] {addr} 已可连, 建主窗口");
                    }
                    other => tracing::error!("[boot] {addr} 连不上 ({other:?}), 仍建窗口"),
                }
                build_main_window(app.handle(), port)?;
                spawn_tray_badge(app.handle().clone(), port);
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

/// 绑一个随机回环端口 (20000–40000, 与 ACL 门/remote 模式同一口径)。
///
/// **先 bind 再建窗** 是刻意的: bind 成功 = 内核已经在 listen (backlog 会替我们排队),
/// 窗口首次导航就不会打到空端口 (白页 + 透明窗 = 整窗看不见)。
fn bind_loopback() -> std::io::Result<std::net::TcpListener> {
    let mut last: Option<std::io::Error> = None;
    for _ in 0..64 {
        let port: u16 = 20000 + (rand::random::<u16>() % 20000);
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                l.set_nonblocking(true)?;
                return Ok(l);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| std::io::Error::other("没有可用端口")))
}

/// 菜单栏图标 (macOS 系统托盘): 品牌 B 形模板图 + 左键唤回主窗 + 右键菜单 (显示/退出)。
///
/// 2026-10-30 用户: 「Mac 栏的菜单栏图标要有」。图标是 `icons/tray.png` (44×44, 纯黑+透明),
/// `icon_as_template(true)` ⇒ macOS 会按菜单栏明暗自动反色 (深色栏白、浅色栏黑)。
#[cfg(desktop)]
fn install_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let show = MenuItemBuilder::with_id("tray-show", "打开 Bolloon").build(app)?;
    let theme_sys = MenuItemBuilder::with_id("theme-system", "主题：跟随系统").build(app)?;
    let theme_dark = MenuItemBuilder::with_id("theme-dark", "主题：深色").build(app)?;
    let theme_light = MenuItemBuilder::with_id("theme-light", "主题：浅色").build(app)?;
    let quit = MenuItemBuilder::with_id("tray-quit", "退出 Bolloon").build(app)?;
    let theme_menu = tauri::menu::SubmenuBuilder::new(app, "主题外观")
        .items(&[&theme_sys, &theme_dark, &theme_light])
        .build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &theme_menu, &quit])
        .build()?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    TrayIconBuilder::with_id("bolloon-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Bolloon")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => reveal_main_window(app),
            "tray-quit" => app.exit(0),
            "theme-system" | "theme-dark" | "theme-light" => {
                let mode = event
                    .id()
                    .as_ref()
                    .trim_start_matches("theme-")
                    .to_string();
                apply_theme(app, &mode);
            }
            _ => {}
        })
        // 2026-10-30 (用户: 点菜单栏图标没反应): 左键 **按下就响应**, 不再只等 Up ——
        // 某些 macOS 配置/模板图只发 Down; 双击也一并兜住。
        .on_tray_icon_event(|tray, event| match event {
            tauri::tray::TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, .. } => {
                reveal_main_window(tray.app_handle());
            }
            tauri::tray::TrayIconEvent::DoubleClick { .. } => {
                reveal_main_window(tray.app_handle());
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}


/// 从菜单改主题: 直接写进页面 (localStorage + data-theme), 不整页重载。
#[cfg(desktop)]
fn apply_theme(app: &tauri::AppHandle, mode: &str) {
    let Some(w) = app.get_webview_window("main") else { return };
    let m = if mode == "system" { "" } else { mode };
    let js = format!(
        r#"(function(){{try{{localStorage.setItem('bolloon_theme',{m:?});var r=document.documentElement;{m:?}?r.setAttribute('data-theme',{m:?}):r.removeAttribute('data-theme');}}catch(e){{}}}})()"#,
        m = m
    );
    let _ = w.eval(&js);
}

/// 菜单栏角标: 每 20 秒问一次本机节点「有多少待处理」, >0 才显示数字。
#[cfg(desktop)]
fn spawn_tray_badge(app: tauri::AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
            // 不引 HTTP 客户端依赖: 本机回环上一条最小 GET 就够 (壳只读一个数)
            let n = tokio::task::spawn_blocking(move || -> u64 {
                use std::io::{Read, Write};
                let addr = format!("127.0.0.1:{port}");
                let Ok(mut s) = std::net::TcpStream::connect(&addr) else { return 0 };
                let _ = s.set_read_timeout(Some(std::time::Duration::from_secs(3)));
                let req = format!(
                    "GET /api/notify/count HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n"
                );
                if s.write_all(req.as_bytes()).is_err() {
                    return 0;
                }
                let mut buf = String::new();
                let _ = s.read_to_string(&mut buf);
                // body 里取 "count": N
                buf.find("\"count\"")
                    .and_then(|i| {
                        let rest = &buf[i..];
                        let colon = rest.find(':')?;
                        rest[colon + 1..]
                            .chars()
                            .skip_while(|c| c.is_whitespace())
                            .take_while(|c| c.is_ascii_digit())
                            .collect::<String>()
                            .parse::<u64>()
                            .ok()
                    })
                    .unwrap_or(0)
            })
            .await
            .unwrap_or(0);
            if let Some(tray) = app.tray_by_id("bolloon-tray") {
                let title = if n > 0 { Some(n.to_string()) } else { None };
                let _ = tray.set_title(title);
            }
        }
    });
}

/// 把主窗口拉回前台 (最小化/被盖住/被关掉都适用; 关掉时重建)。
#[cfg(desktop)]
fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 装一份中文菜单 (桌面)。
///
/// Tauri 的缺省菜单在 macOS 上固定是英文 (About Bolloon / Hide / Quit / File / Edit / View /
/// Window / Help)。2026-10-30 用户: 「bolloon 的左上角按钮打开也是英文的」⇒ 换成中文。
/// 纪律: 全部用 `PredefinedMenuItem` —— 退出/隐藏/复制/粘贴/最小化这些动作仍由系统实现,
/// 壳只负责文字, 不写业务逻辑。
#[cfg(desktop)]
fn install_chinese_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, PredefinedMenuItem as P, SubmenuBuilder};

    let app_menu = SubmenuBuilder::new(app, "Bolloon")
        .items(&[
            &P::about(app, Some("关于 Bolloon"), None)?,
            &P::separator(app)?,
            &P::hide(app, Some("隐藏 Bolloon"))?,
            &P::hide_others(app, Some("隐藏其他"))?,
            &P::separator(app)?,
            &P::quit(app, Some("退出 Bolloon"))?,
        ])
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .items(&[
            &P::undo(app, Some("撤销"))?,
            &P::redo(app, Some("重做"))?,
            &P::separator(app)?,
            &P::cut(app, Some("剪切"))?,
            &P::copy(app, Some("复制"))?,
            &P::paste(app, Some("粘贴"))?,
            &P::select_all(app, Some("全选"))?,
        ])
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "窗口")
        .items(&[
            &P::minimize(app, Some("最小化"))?,
            &P::fullscreen(app, Some("进入全屏"))?,
        ])
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// 建主窗口 (桌面)。内嵌服务**真的在 listen** 之后由主线程调用。
///
/// 2026-10-30 (用户): 不要再有「顶部外壳栏」那个独立位置 —— macOS 用 `Overlay` 标题栏
/// (红绿灯浮在内容之上, 不占一行), 前端把第一栏顶部留出 30px 交给红绿灯并自己当拖拽区。
#[cfg(desktop)]
fn build_main_window(app: &tauri::AppHandle, port: u16) -> tauri::Result<()> {
    #[allow(unused_mut)]
    let mut b = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(
            format!("http://127.0.0.1:{port}/?app=desktop").parse().unwrap(),
        ),
    )
    .title("Bolloon")
    .inner_size(1200.0, 800.0)
    .min_inner_size(900.0, 600.0)
    // 透明窗 = 左栏毛玻璃能虚化桌面 (macOS 需 macos-private-api 特性 + macOSPrivateApi)
    .transparent(true);

    #[cfg(target_os = "macos")]
    {
        // 2026-10-30 (用户, 第三轮): Overlay 标题栏 —— 红绿灯**原地不动** (macOS 默认位, 不调用
        // traffic_light_position: 用户明确 "红绿灯不动"), 它们浮在第一栏顶部;
        // 同一行的右侧就是顶部标签栏 (#topBar: 品牌 + 帛龙订阅), 顶栏与第一栏同色同毛玻璃
        // ⇒ 视觉上是一整块 L 形外壳, 没有单独的壳条, 也没有空带。
        b = b.title_bar_style(tauri::TitleBarStyle::Overlay);
    }

    b.build()?;
    Ok(())
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
    // 观测点 (2026-10-30): 这行出现 = IPC 已过 ACL (若 ACL 挡了, 函数根本不会被调用)
    tracing::info!("[update] check_update 被调用 (IPC 已放行)");
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
