//! QUIC / DIAP 交流历史 —— 去中心化通道上的每次请求/响应都留痕。
//!
//! 2026-11-13 需求：「去中心化的 quic 交流要留存历史记录」。跨机链路走 iroh（QUIC）隧道后，
//! 从本机 HTTP 访问日志里**看不到任何东西**，出问题也没法回溯。这里补一层：
//! 记录时间、对端、方法、路径、字节数、耗时、成败。
//!
//! 边界（不重复存敏感内容）：
//! - 本文件**不存正文**，只存摘要字段；聊天全文由 `cross_chat` 按会话落盘。
//! - 落盘 `~/.bolloon/rust/quic-history.jsonl`（追加写，一行一条）；
//! - 查询 `GET /api/quic/history?limit=50`（最新在前）。

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::Value;

pub const FILE_NAME: &str = "quic-history.jsonl";

fn path() -> PathBuf {
    crate::server::data_dir().join(FILE_NAME)
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn record_to(file: &Path, entry: &Value) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(f, "{entry}");
    }
}

/// 记录一次隧道收发。`direction` = `out`(本机发起) / `in`(对端请求本机)。
#[allow(clippy::too_many_arguments)]
pub fn record(
    direction: &str,
    peer: &str,
    transport: &str,
    method: &str,
    api_path: &str,
    req_bytes: usize,
    resp_bytes: usize,
    ok: bool,
    elapsed_ms: u64,
) {
    record_detail(
        direction, peer, transport, method, api_path, req_bytes, resp_bytes, ok, elapsed_ms,
        "api", "",
    );
}

/// 带语义的记录：`kind` = chat / command / api，`summary` 只对指令填（聊天不存正文）。
#[allow(clippy::too_many_arguments)]
pub fn record_detail(
    direction: &str,
    peer: &str,
    transport: &str,
    method: &str,
    api_path: &str,
    req_bytes: usize,
    resp_bytes: usize,
    ok: bool,
    elapsed_ms: u64,
    kind: &str,
    summary: &str,
) {
    let entry = serde_json::json!({
        "ts_ms": now_ms(),
        "transport": transport,
        "direction": direction,
        "peer": if peer.is_empty() { "unknown" } else { peer },
        "method": method,
        "path": api_path,
        "req_bytes": req_bytes,
        "resp_bytes": resp_bytes,
        "ok": ok,
        "elapsed_ms": elapsed_ms,
        "kind": kind,
        "summary": summary,
    });
    record_to(&path(), &entry);
}

/// 从隧道路径 + 请求体解析出语义，供历史展示。
/// 聊天只标 kind（正文已在会话历史），指令额外带一段摘要。
pub fn classify(api_path: &str, body: Option<&Value>) -> (&'static str, String) {
    if api_path.contains("/api/agents/public/command") {
        let ins = body
            .and_then(|b| b["instruction"].as_str())
            .unwrap_or_default();
        ("command", ins.chars().take(120).collect())
    } else if api_path.contains("/api/agents/public/chat") {
        ("chat", String::new())
    } else if api_path.contains("/api/node/connect") {
        ("connect", String::new())
    } else {
        ("api", String::new())
    }
}

/// 最近 `limit` 条（最新在前）。损坏行跳过，不让一条坏数据毁掉整个历史。
pub fn recent(limit: usize) -> Vec<Value> {
    let Ok(txt) = std::fs::read_to_string(path()) else {
        return Vec::new();
    };
    let mut all: Vec<Value> = txt
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect();
    all.reverse();
    all.truncate(limit);
    all
}

/// GET /api/quic/history?limit=50
pub async fn http_history(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    let limit = q
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(50)
        .clamp(1, 1000);
    let items = recent(limit);
    axum::Json(serde_json::json!({
        "ok": true,
        "count": items.len(),
        "file": path().display().to_string(),
        "items": items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpfile() -> PathBuf {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("bolloon-quic-history-{}-{n}.jsonl", std::process::id()))
    }

    #[test]
    fn record_appends_and_recent_returns_newest_first() {
        let f = tmpfile();
        for i in 0..3 {
            record_to(
                &f,
                &serde_json::json!({
                    "ts_ms": i, "transport": "t", "direction": "out",
                    "peer": "did:pi:x", "method": "POST", "path": "/api/x",
                    "req_bytes": i, "resp_bytes": i * 2, "ok": true, "elapsed_ms": 1
                }),
            );
        }
        let txt = std::fs::read_to_string(&f).unwrap();
        assert_eq!(txt.lines().count(), 3);
        let mut v: Vec<Value> = txt.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        v.reverse();
        assert_eq!(v[0]["req_bytes"], serde_json::json!(2));
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn corrupt_lines_do_not_break_reading() {
        let f = tmpfile();
        std::fs::write(&f, "not json\n{\"ok\":true}\n").unwrap();
        let txt = std::fs::read_to_string(&f).unwrap();
        let bad = txt.lines().filter(|l| serde_json::from_str::<Value>(l).is_err()).count();
        assert_eq!(bad, 1);
        let _ = std::fs::remove_file(&f);
    }
}
