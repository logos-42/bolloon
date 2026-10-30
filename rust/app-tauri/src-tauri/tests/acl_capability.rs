//! 门: 桌面壳的 ACL 必须真的覆盖内嵌服务的来源。
//!
//! 背景 (2026-10-30 用户实测): 更新按钮报 `Command check_update not allowed by ACL`。
//! 根因**不是** permissions 没写 —— permissions/bolloon.json 里早就写了 allow-check-update,
//! capability 也引用了 bolloon-default; 真正缺的是 `remote.urls`:
//! 主窗口加载的是 `http://127.0.0.1:<随机端口>/?app=desktop`, 对 Tauri 而言这是**远程来源**
//! (`Origin::Remote`); capability 缺省 `local: true` 只覆盖 tauri:// 本地内容,
//! `resolve_access` 里 `Origin::matches` 直接 false ⇒ 任何 IPC 都被拒。
//!
//! 这个门用 tauri-utils 自己的 `RemoteUrlPattern` 判据(与运行时同一套代码)去测:
//! capability 里声明的 remote 模式能不能匹配**运行时真实会用的 URL**。
//! 只写 permissions 不写 remote、或把 remote 写成别的 host/端口形状, 这里就红。

use std::str::FromStr;
use tauri::utils::acl::RemoteUrlPattern;

const CAPABILITY: &str = include_str!("../capabilities/default.json");
const PERMISSIONS: &str = include_str!("../permissions/bolloon.json");
const LIB_RS: &str = include_str!("../src/lib.rs");

/// 与 src/lib.rs 里建窗口时的 URL 形状一致: `http://127.0.0.1:{port}/?app=desktop`
const PORT_RANGE: std::ops::RangeInclusive<u16> = 20000..=40000;

#[test]
fn capability_declares_main_window_and_shell_permissions() {
    let cap: serde_json::Value =
        serde_json::from_str(CAPABILITY).expect("capability 必须是合法 JSON");
    let windows: Vec<&str> = cap["windows"]
        .as_array()
        .expect("capability 必须有 windows")
        .iter()
        .filter_map(|w| w.as_str())
        .collect();
    assert!(
        windows.contains(&"main"),
        "capability 必须指向主窗口 \"main\", 实得 {windows:?}"
    );

    let perms: Vec<String> = cap["permissions"]
        .as_array()
        .expect("capability 必须有 permissions")
        .iter()
        .map(|p| p.as_str().unwrap_or_default().to_string())
        .collect();
    for need in ["core:default", "updater:default", "bolloon-default"] {
        assert!(
            perms.iter().any(|p| p == need),
            "capability 缺权限 {need}, 实得 {perms:?}"
        );
    }
}

#[test]
fn shell_permission_set_covers_all_three_commands() {
    let perm: serde_json::Value =
        serde_json::from_str(PERMISSIONS).expect("permissions 必须是合法 JSON");

    // 权限集 bolloon-default 必须把三条命令的 allow-* 都列上
    let set = perm["set"]
        .as_array()
        .expect("permissions 必须有 set")
        .iter()
        .find(|s| s["identifier"] == "bolloon-default")
        .expect("permissions 缺 bolloon-default 集合")
        .clone();
    let listed: Vec<String> = set["permissions"]
        .as_array()
        .expect("bolloon-default 的 permissions 必须是数组")
        .iter()
        .map(|p| p.as_str().unwrap_or_default().to_string())
        .collect();

    // 每条 allow-* 必须真的定义了, 且 commands.allow 里是壳注册的命令名
    let mut allowed_commands: Vec<String> = Vec::new();
    for entry in perm["permission"]
        .as_array()
        .expect("permissions 必须有 permission 数组")
    {
        let id = entry["identifier"].as_str().unwrap_or_default();
        if id.starts_with("allow-") {
            assert!(
                listed.iter().any(|l| l == id),
                "权限 {id} 没被 bolloon-default 引用 ⇒ 装了也没授权"
            );
            for c in entry["commands"]["allow"]
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                allowed_commands.push(c.as_str().unwrap_or_default().to_string());
            }
        }
    }
    for cmd in ["check_update", "update_install", "relaunch"] {
        assert!(
            allowed_commands.iter().any(|c| c == cmd),
            "permissions 没授权命令 {cmd}, 实得 {allowed_commands:?}"
        );
    }
}

#[test]
fn remote_origin_is_covered_by_capability() {
    let cap: serde_json::Value =
        serde_json::from_str(CAPABILITY).expect("capability 必须是合法 JSON");
    let urls: Vec<String> = cap["remote"]["urls"]
        .as_array()
        .unwrap_or_else(|| panic!("capability 缺 remote.urls ⇒ 内嵌服务来源(http://127.0.0.1:*)的所有 IPC 都会被 ACL 拒"))
        .iter()
        .filter_map(|u| u.as_str())
        .map(|u| u.to_string())
        .collect();

    let patterns: Vec<RemoteUrlPattern> = urls
        .iter()
        .map(|u| {
            RemoteUrlPattern::from_str(u)
                .unwrap_or_else(|e| panic!("remote.urls 里的 {u} 不是合法 URL 模式: {e}"))
        })
        .collect();

    // 端口是随机分配的: 头/尾/中间都验, 不能只对某一个固定端口成立
    let probes = [*PORT_RANGE.start(), 23456, *PORT_RANGE.end()];
    for port in probes {
        let real: tauri::Url = format!("http://127.0.0.1:{port}/?app=desktop")
            .parse()
            .expect("运行时 URL 必须能解析");
        assert!(
            patterns.iter().any(|p| p.test(&real)),
            "ACL remote 模式 {urls:?} 匹配不上运行时来源 {real} ⇒ IPC 会被拒 (not allowed by ACL)"
        );
    }

    // 反向: 别的来源不该被这个模式放行 (写宽了就是把本机权限给了任意站点)
    for host in ["http://example.com:23456/", "https://127.0.0.1:23456/"] {
        let other: tauri::Url = host.parse().unwrap();
        assert!(
            !patterns.iter().any(|p| p.test(&other)),
            "ACL remote 模式 {urls:?} 放行了不该放行的来源 {host}"
        );
    }
}

#[test]
fn drag_region_permission_is_granted() {
    // 前端 #primaryRail / #topBar 用 data-tauri-drag-region="deep" 拖窗, 背后是
    // `plugin:window|start_dragging` ⇒ 必须授权 core:window:allow-start-dragging。
    // 实测 (2026-10-30): core:window:default **不含** start-dragging (只含 internal-toggle-maximize),
    // 缺了它拖拽静默失效 (用户: 「为什么无法拖拽」), 而且不会有任何报错提示。
    let cap: serde_json::Value = serde_json::from_str(CAPABILITY).expect("capability 必须是合法 JSON");
    let perms: Vec<String> = cap["permissions"]
        .as_array()
        .expect("capability 必须有 permissions")
        .iter()
        .map(|p| p.as_str().unwrap_or_default().to_string())
        .collect();
    assert!(
        perms.iter().any(|p| p == "core:window:allow-start-dragging"),
        "capability 缺 core:window:allow-start-dragging ⇒ 拖拽区点下去没反应, 实得 {perms:?}"
    );
}

#[test]
fn window_url_is_the_one_acl_probes_check() {
    // 门自己也要钉住「真实加载的 URL 形状」: 一旦壳改成别的 host/路径, remote 模式就必须跟着改
    assert!(
        LIB_RS.contains("http://127.0.0.1:{port}/?app=desktop"),
        "lib.rs 建窗口的 URL 形状变了 —— 同步 capabilities/default.json 的 remote.urls 与本门"
    );
    assert!(
        LIB_RS.contains("20000 + (rand::random::<u16>() % 20000)"),
        "端口公式变了 —— 同步本门的 PORT_RANGE"
    );
}
