//! 插件栏（2026-11-15）
//!
//! 把「智能体自己生成的插件」与「分享来的插件」统一成**一个可浏览 / 可分享的列表**。
//!
//! 真源就是既有技能注册表 `bolloon_agent::skills_runtime`（落盘 `data_dir()/skills.json`）：
//! - 智能体做梦 / 世界补能力时 `promote` 进去的，就是"自己生成的插件"——本模块不另存一份；
//! - 「分享」= 导出 base64 插件串（含 name / description / body）；
//! - 「导入」= 解析分享串 → 走同一批准门 `promote` 落盘（名字冲突 / 内容重复如实报错）。
//!
//! 纪律：不新造第二套存储；不复制已有技能；不伪造结果。

use std::collections::HashMap;

use axum::{
    extract::{Query, State},
    Json,
};
use base64::Engine;

use crate::AppState;

/// 分享串协议号（换格式即旧串拒收，避免误解析）。
const PLUGIN_PROTOCOL: &str = "bolloon-plugin/1";

fn skills_path() -> std::path::PathBuf {
    crate::server::data_dir().join("skills.json")
}

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn err(m: &str) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": false, "error": m }))
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PluginBlob {
    protocol: String,
    name: String,
    #[serde(default)]
    description: String,
    body: String,
}

/// GET /api/plugins → 列出全部插件（= 运行时技能注册表条目）
pub async fn list(State(st): State<AppState>) -> Json<serde_json::Value> {
    let ev = st.skills.lock().await;
    let items: Vec<serde_json::Value> = ev
        .registry
        .entries()
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "name": s.name,
                "description": s.description,
                "body": s.body,
                "origin": s.origin,
                "created_at_ms": s.created_at_ms,
            })
        })
        .collect();
    Json(serde_json::json!({
        "ok": true,
        "count": items.len(),
        "learned": ev.registry.learned_count(),
        "plugins": items,
    }))
}

/// 共用：把一个插件推进注册表并落盘（走 promote 批准门）
async fn promote_plugin(
    st: &AppState,
    name: String,
    description: String,
    body: String,
    source: &str,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("插件名不能为空".into());
    }
    if body.trim().is_empty() {
        return Err("插件内容不能为空".into());
    }
    let cand = bolloon_agent::skills_runtime::SkillCandidate {
        name: name.clone(),
        description: description.chars().take(60).collect(),
        body,
        source_run: source.to_string(),
    };
    let mut ev = st.skills.lock().await;
    ev.promote(&cand, now_ms()).map_err(|e| e.to_string())?;
    ev.save_json(&skills_path())
        .map_err(|e| format!("落盘失败: {e}"))?;
    Ok(name)
}

/// POST /api/plugins/create { name, description?, body }
/// 手动新建一个插件（智能体自动生成的走做梦/补能力那条路，不经过这里）。
pub async fn create(State(st): State<AppState>, Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let description = req.get("description").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let body = req.get("body").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    match promote_plugin(&st, name, description, body, "user-create").await {
        Ok(n) => Json(serde_json::json!({ "ok": true, "name": n, "note": "已创建并加入插件栏" })),
        Err(e) => err(&e),
    }
}

/// GET /api/plugins/share?name=xxx → 导出一个 base64 插件分享串
pub async fn share(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let name = q.get("name").cloned().unwrap_or_default();
    if name.is_empty() {
        return err("缺少 name");
    }
    let ev = st.skills.lock().await;
    let found = ev.registry.entries().into_iter().find(|s| s.name == name);
    let blob = match found {
        Some(s) => PluginBlob {
            protocol: PLUGIN_PROTOCOL.to_string(),
            name: s.name.clone(),
            description: s.description.clone(),
            body: s.body.clone(),
        },
        None => return err("没有这个插件"),
    };
    match serde_json::to_vec(&blob) {
        Ok(raw) => Json(serde_json::json!({
            "ok": true, "name": name, "blob": b64e(&raw),
            "note": "这是插件分享串，对方在「导入」里粘贴即可安装。",
        })),
        Err(e) => err(&e.to_string()),
    }
}

/// POST /api/plugins/import { blob } → 用分享串安装插件
pub async fn import(State(st): State<AppState>, Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let blob = req.get("blob").and_then(|v| v.as_str()).unwrap_or("").trim();
    if blob.is_empty() {
        return err("请粘贴插件分享串");
    }
    let raw = match b64d(blob) {
        Ok(r) => r,
        Err(e) => return err(&e),
    };
    let p: PluginBlob = match serde_json::from_slice(&raw) {
        Ok(p) => p,
        Err(e) => return err(&format!("分享串格式错误: {e}")),
    };
    if p.protocol != PLUGIN_PROTOCOL {
        return err("不支持的插件协议（可能是别的类型的分享串）");
    }
    match promote_plugin(&st, p.name, p.description, p.body, "import").await {
        Ok(n) => Json(serde_json::json!({ "ok": true, "name": n, "note": "已导入并加入插件栏" })),
        Err(e) => err(&e),
    }
}

/// POST /api/plugins/remove { name }
pub async fn remove(State(st): State<AppState>, Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return err("缺少 name");
    }
    let mut ev = st.skills.lock().await;
    if !ev.registry.remove(&name) {
        return err("没有这个插件");
    }
    if let Err(e) = ev.save_json(&skills_path()) {
        return err(&format!("落盘失败: {e}"));
    }
    Json(serde_json::json!({ "ok": true, "name": name, "removed": true }))
}
