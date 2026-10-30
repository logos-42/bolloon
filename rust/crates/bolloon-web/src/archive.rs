//! 判断力决策日志 / 意图 的自动存档 — POST /api/archive, GET /api/archive/summary
//!
//! 目录（都是**专门目录**，不混在 sessions 里；可用 BOLLOON_HOME 覆盖根）：
//! - `~/.bolloon/archive/judgment/YYYY-MM-DD.jsonl`
//! - `~/.bolloon/archive/intents/YYYY-MM-DD.jsonl`
//! - 带 `agent_id` 时同时落该智能体自己的账：`~/.bolloon/agents/<id>/archive/<kind>/YYYY-MM-DD.jsonl`
//!   （= "自动传递给智能体存档" 的落点：智能体目录里有一份属于它的记录）
//!
//! 只追加、不改写；一条一行 JSON（ts/kind/source + 原始 payload 字段），
//! 坏行不影响后续（读汇总时按行解析，解析不了就跳过并计数）。

use std::io::Write;
use std::path::{Path, PathBuf};

use axum::extract::Query;
use axum::Json;
use serde::Deserialize;

fn root() -> PathBuf {
    crate::server::data_dir()
}

fn safe_dir_name(kind: &str) -> &'static str {
    match kind {
        "judgment" => "judgment",
        "intent" => "intents",
        _ => "judgment",
    }
}

fn append_line(path: &Path, line: &str) -> std::io::Result<usize> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    f.flush()?;
    // 顺手报一下这个文件现在多少行（便于调用方确认真的进去了）
    Ok(std::fs::read_to_string(path)
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(0))
}

#[derive(Deserialize)]
pub struct ArchiveRequest {
    /// judgment | intent
    pub kind: String,
    /// 来源：glass-scan / glass-card / cli / web ...
    #[serde(default)]
    pub source: String,
    /// 归属智能体（可选）：给了就额外写进该智能体目录
    #[serde(default)]
    pub agent_id: String,
    /// 原始内容（任意字段），原样存
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// POST /api/archive
pub async fn archive(Json(req): Json<ArchiveRequest>) -> Json<serde_json::Value> {
    let kind = req.kind.trim().to_lowercase();
    if kind != "judgment" && kind != "intent" {
        return Json(serde_json::json!({
            "ok": false, "error": "kind 只能是 judgment 或 intent"
        }));
    }
    let dir_name = safe_dir_name(&kind);
    let now = chrono::Local::now();
    let file = format!("{}.jsonl", now.format("%Y-%m-%d"));

    let mut entry = serde_json::Map::new();
    entry.insert("ts".into(), serde_json::json!(now.to_rfc3339()));
    entry.insert("ts_ms".into(), serde_json::json!(now.timestamp_millis()));
    entry.insert("kind".into(), serde_json::json!(kind));
    entry.insert("source".into(), serde_json::json!(req.source));
    if let Some(obj) = req.payload.as_object() {
        for (k, v) in obj {
            entry.insert(k.clone(), v.clone());
        }
    } else if !req.payload.is_null() {
        entry.insert("payload".into(), req.payload.clone());
    }
    let line = serde_json::to_string(&serde_json::Value::Object(entry)).unwrap_or_default();

    // 1) 电脑侧总账
    let main_path = root().join("archive").join(dir_name).join(&file);
    let main_lines = match append_line(&main_path, &line) {
        Ok(n) => n,
        Err(e) => {
            return Json(serde_json::json!({
                "ok": false, "error": format!("写总账失败: {e}"), "path": main_path.display().to_string()
            }))
        }
    };

    // 2) 智能体侧账（"自动传递给智能体进行存档"）
    let mut agent_path: Option<String> = None;
    if !req.agent_id.trim().is_empty() {
        let id = req.agent_id.trim();
        if id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            let p = root().join("agents").join(id).join("archive").join(dir_name).join(&file);
            match append_line(&p, &line) {
                Ok(_) => agent_path = Some(p.display().to_string()),
                Err(e) => {
                    return Json(serde_json::json!({
                        "ok": false, "error": format!("写智能体账失败: {e}"),
                        "path": main_path.display().to_string()
                    }))
                }
            }
        } else {
            return Json(serde_json::json!({
                "ok": false, "error": "agent_id 含非法字符", "path": main_path.display().to_string()
            }));
        }
    }

    Json(serde_json::json!({
        "ok": true,
        "kind": kind,
        "path": main_path.display().to_string(),
        "agent_path": agent_path,
        "lines": main_lines,
    }))
}

#[derive(Deserialize)]
pub struct SummaryQuery {
    #[serde(default = "default_limit")]
    pub limit: usize,
}
fn default_limit() -> usize {
    5
}

/// GET /api/archive/summary → 每类的文件数 / 条数 / 最近几条
pub async fn summary(Query(q): Query<SummaryQuery>) -> Json<serde_json::Value> {
    let mut out = serde_json::Map::new();
    for (kind, dir_name) in [("judgment", "judgment"), ("intent", "intents")] {
        let dir = root().join("archive").join(dir_name);
        let mut files = 0usize;
        let mut lines = 0usize;
        let mut recent: Vec<serde_json::Value> = Vec::new();

        if let Ok(rd) = std::fs::read_dir(&dir) {
            let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
            paths.sort();
            files = paths.len();
            for p in &paths {
                if let Ok(text) = std::fs::read_to_string(p) {
                    for l in text.lines().filter(|l| !l.trim().is_empty()) {
                        lines += 1;
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l) {
                            recent.push(v);
                        }
                    }
                }
            }
        }
        let take = q.limit.clamp(1, 50);
        let start = recent.len().saturating_sub(take);
        out.insert(
            kind.to_string(),
            serde_json::json!({
                "dir": dir.display().to_string(),
                "files": files,
                "lines": lines,
                "recent": &recent[start..],
            }),
        );
    }
    Json(serde_json::Value::Object(out))
}
