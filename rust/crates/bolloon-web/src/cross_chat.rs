//! 跨机会话状态机 —— 把「一次 HTTP 请求 / 一次回复」升级成**可延续的多轮交流**。
//!
//! 2026-11-13 之前的缺口（实测确认）：
//! - `friend_chat` 只把一句话 POST 出去，直接把对端响应回给调用方，本机不留任何记录；
//! - `agents_public_chat` 只构造**一条** user message、`session_id: None`，对端模型看不到上文；
//! - `agent_reach_out` 主动开口后，对方的回复不会回到发起方智能体继续接力。
//!
//! 本模块补的是**会话层**，不动传输/验签/授权链路：
//! - `session_id(a, b)` 由双方 DID 排序后哈希派生，两端各自算出同一个值，
//!   **不经网络传输** ⇒ 无法被伪造或篡改，也不改变既有签名体（旧版对端完全兼容）；
//! - 每轮消息以 JSONL 追加到 `~/.bolloon/rust/cross-chat/<sid>.jsonl`，
//!   `in` = 对方说的、`out` = 本机说的；明文手机号从不落盘（只存 DID 与文本）；
//! - 接收端用最近 N 轮拼 `ChatMessage` 上下文，模型因此能接着上一句聊；
//! - `chat/auto` 在此基础上做「智能体 ↔ 智能体」自动接力，带轮数预算，失败即停不伪造。

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// 上下文最多带多少条（含当前这一句），避免无限增长把 prompt 撑爆
pub const CONTEXT_TURNS: usize = 12;
/// 自动接力的默认与硬上限（每一轮都要过一次远端模型 + 本机模型，必须有预算）
pub const AUTO_DEFAULT_TURNS: usize = 3;
pub const AUTO_MAX_TURNS: usize = 5;

/// 同一对好友永远得到同一个会话 ID；不同 DID 对不会撞。
pub fn session_id(a: &str, b: &str) -> String {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut h = Sha256::new();
    h.update(b"bolloon/cross-chat/v1|");
    h.update(lo.as_bytes());
    h.update(b"|");
    h.update(hi.as_bytes());
    hex::encode(h.finalize())[..24].to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Turn {
    pub ts_ms: u64,
    pub session_id: String,
    /// 对端 DID（便于按好友核对；本机 DID 不需要重复存）
    pub peer_did: String,
    /// "in" = 对方说的 / "out" = 本机说的
    pub direction: String,
    pub text: String,
    pub agent_id: String,
}

fn store_dir(root: &Path) -> PathBuf {
    root.join("cross-chat")
}

fn session_path(root: &Path, sid: &str) -> PathBuf {
    // sid 是内部派生的 hex，不接受外部路径，这里仍做一次白名单校验防止路径穿越
    let safe: String = sid.chars().filter(|c| c.is_ascii_hexdigit()).take(64).collect();
    store_dir(root).join(format!("{safe}.jsonl"))
}

/// 追加一轮；落盘失败只如实返回 Err，不静默假装成功。
pub fn append(root: &Path, turn: &Turn) -> io::Result<()> {
    let dir = store_dir(root);
    fs::create_dir_all(&dir)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(session_path(root, &turn.session_id))?;
    let line = serde_json::to_string(turn)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    writeln!(f, "{line}")
}

/// 读最近 `limit` 轮（按写入顺序）。损坏行跳过，不让一条坏数据毁掉整个会话。
pub fn recent(root: &Path, sid: &str, limit: usize) -> Vec<Turn> {
    let Ok(txt) = fs::read_to_string(session_path(root, sid)) else {
        return Vec::new();
    };
    let mut out: Vec<Turn> = txt
        .lines()
        .filter_map(|l| serde_json::from_str::<Turn>(l).ok())
        .filter(|t| t.session_id == sid)
        .collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

/// 把历史轮次转成模型消息：`in`(对方) → user，`out`(本机) → assistant。
/// 返回的是 `Vec<(role, text)>`，由调用方组装成自己的 `ChatMessage` 类型，
/// 避免本模块反向依赖 llm 层。
pub fn as_context(turns: &[Turn]) -> Vec<(&'static str, String)> {
    turns
        .iter()
        .map(|t| {
            let role = if t.direction == "in" { "user" } else { "assistant" };
            (role, t.text.clone())
        })
        .collect()
}

// ───────────── 多设备共享通道 (2026-11-13) ─────────────
// 同一身份的多台设备，通过 export/import 合并会话历史；谁先拿到都行，
// 传输可以走 HTTP 也可以走 DIAP 隧道（同一套 JSON）。
// import 幂等：同 session + 时间 + 方向 + 文本视为同一条，重复导入不会翻倍。

/// 导出全部会话轮次（时间升序）。
pub fn export_all(root: &Path) -> Vec<Turn> {
    let mut all = Vec::new();
    if let Ok(rd) = fs::read_dir(store_dir(root)) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                continue;
            }
            if let Ok(txt) = fs::read_to_string(&p) {
                for line in txt.lines() {
                    if let Ok(t) = serde_json::from_str::<Turn>(line) {
                        all.push(t);
                    }
                }
            }
        }
    }
    all.sort_by_key(|t| t.ts_ms);
    all
}

/// 幂等导入，返回 (added, skipped)。
pub fn import_turns(root: &Path, turns: &[Turn]) -> (usize, usize) {
    use std::collections::HashSet;
    let mut seen: HashSet<(String, u64, String, String)> = export_all(root)
        .into_iter()
        .map(|t| (t.session_id, t.ts_ms, t.direction, t.text))
        .collect();
    let (mut added, mut skipped) = (0usize, 0usize);
    for t in turns {
        let key = (t.session_id.clone(), t.ts_ms, t.direction.clone(), t.text.clone());
        if !seen.insert(key) {
            skipped += 1;
            continue;
        }
        if append(root, t).is_ok() {
            added += 1;
        } else {
            skipped += 1;
        }
    }
    (added, skipped)
}

/// 会话索引：每个会话一条（对端、条数、首末时间）。
pub fn sessions(root: &Path) -> Vec<Value> {
    use std::collections::BTreeMap;
    let mut map: BTreeMap<String, (String, usize, u64, u64)> = BTreeMap::new();
    for t in export_all(root) {
        let e = map
            .entry(t.session_id.clone())
            .or_insert((t.peer_did.clone(), 0, 0, u64::MAX));
        e.1 += 1;
        e.2 = e.2.max(t.ts_ms);
        e.3 = e.3.min(t.ts_ms);
    }
    map.into_iter()
        .map(|(sid, (peer, cnt, last, first))| {
            serde_json::json!({
                "session_id": sid,
                "peer_did": peer,
                "count": cnt,
                "first_ts_ms": first,
                "last_ts_ms": last,
            })
        })
        .collect()
}

fn root() -> std::path::PathBuf {
    crate::server::data_dir()
}

/// GET /api/cross-chat/export?since_ms=
pub async fn http_export(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::Json<Value> {
    let since = q
        .get("since_ms")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let turns: Vec<Turn> = export_all(&root())
        .into_iter()
        .filter(|t| t.ts_ms >= since)
        .collect();
    axum::Json(serde_json::json!({
        "ok": true, "count": turns.len(), "turns": turns,
    }))
}

/// POST /api/cross-chat/import {turns:[...]}
pub async fn http_import(axum::Json(req): axum::Json<Value>) -> axum::Json<Value> {
    let raw = req["turns"].as_array().cloned().unwrap_or_default();
    let mut turns = Vec::new();
    for v in raw {
        if let Ok(t) = serde_json::from_value::<Turn>(v) {
            turns.push(t);
        }
    }
    let (added, skipped) = import_turns(&root(), &turns);
    axum::Json(serde_json::json!({
        "ok": true, "received": turns.len(), "added": added, "skipped": skipped,
    }))
}

/// GET /api/cross-chat/sessions
pub async fn http_sessions() -> axum::Json<Value> {
    let items = sessions(&root());
    axum::Json(serde_json::json!({
        "ok": true, "count": items.len(), "sessions": items,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        // 每个测试独立目录: 用原子序号, 不依赖纳秒分辨率 (并行时可能撞车)
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "bolloon-cross-chat-{}-{n}", std::process::id()
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn session_id_is_symmetric_and_pair_scoped() {
        let a = "did:pi:aaa";
        let b = "did:pi:bbb";
        assert_eq!(session_id(a, b), session_id(b, a));
        assert_ne!(session_id(a, b), session_id(a, "did:pi:ccc"));
        assert_eq!(session_id(a, b).len(), 24);
        assert!(session_id(a, b).chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn append_recent_roundtrip_keeps_order_and_limit() {
        let root = tmp();
        let sid = session_id("did:pi:a", "did:pi:b");
        for i in 0..5u64 {
            append(
                &root,
                &Turn {
                    ts_ms: 1000 + i,
                    session_id: sid.clone(),
                    peer_did: "did:pi:b".into(),
                    direction: if i % 2 == 0 { "in" } else { "out" }.into(),
                    text: format!("turn-{i}"),
                    agent_id: "agent-001".into(),
                },
            )
            .unwrap();
        }
        let all = recent(&root, &sid, 100);
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].text, "turn-0");
        assert_eq!(all[4].text, "turn-4");
        let last3 = recent(&root, &sid, 3);
        assert_eq!(last3.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(),
                   vec!["turn-2", "turn-3", "turn-4"]);
        let ctx = as_context(&last3);
        // turn-2 (i=2) = in, turn-3 = out, turn-4 = in
        assert_eq!(ctx[0].0, "user");
        assert_eq!(ctx[1].0, "assistant");
        assert_eq!(ctx[2].0, "user");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn export_import_is_idempotent_for_multi_device_sync() {
        let root = tmp();
        let sid = session_id("did:pi:a", "did:pi:b");
        for i in 0..3u64 {
            append(&root, &Turn {
                ts_ms: 100 + i, session_id: sid.clone(), peer_did: "did:pi:b".into(),
                direction: if i % 2 == 0 { "out" } else { "in" }.into(),
                text: format!("m{i}"), agent_id: "a".into(),
            }).unwrap();
        }
        let dumped = export_all(&root);
        assert_eq!(dumped.len(), 3);
        assert_eq!(sessions(&root).len(), 1);
        assert_eq!(sessions(&root)[0]["count"], 3);
        // 同设备再导入一次：全部跳过，不翻倍
        let (added, skipped) = import_turns(&root, &dumped);
        assert_eq!((added, skipped), (0, 3));
        // 另一台设备导入：全部新增
        let other = tmp();
        let (added2, skipped2) = import_turns(&other, &dumped);
        assert_eq!((added2, skipped2), (3, 0));
        assert_eq!(export_all(&other).len(), 3);
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&other).ok();
    }

    #[test]
    fn corrupt_lines_and_path_traversal_are_ignored() {
        let root = tmp();
        let sid = session_id("did:pi:a", "did:pi:b");
        let p = session_path(&root, &sid);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, "not json\n{\"broken\":1}\n").unwrap();
        assert!(recent(&root, &sid, 10).is_empty());
        // 外部字符串不能穿出目录
        assert!(session_path(&root, "../evil").starts_with(store_dir(&root)));
        fs::remove_dir_all(&root).unwrap();
    }
}
