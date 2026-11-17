//! 跨设备全量快照同步：智能体 / 会话交流 / 群组 / 世界 / 联系人。
//!
//! 安全边界（2026-11-17）：
//! - 只搬运可公开或用户明确拥有的业务数据；
//! - **绝不**同步 DID seed、钱包私钥、联系人 pepper、LLM API Key、扫码 token；
//! - 写入按 id / hash 幂等，重复同步不会制造重复记录。
//!
//! 传输层由 `device_sync` 调用 `peer_json`，因此天然复用 DIAP/QUIC 隧道（失败回落 HTTP）。

use axum::{
    extract::{Query, State},
    Json,
};
use std::collections::HashMap;

use crate::server::AppState;

/// QUIC 分块接收缓冲： sender → id → (total, chunks)
type ChunkMap = std::collections::HashMap<String, (usize, Vec<Option<String>>)>;
static QUIC_CHUNKS: std::sync::OnceLock<std::sync::Mutex<ChunkMap>> = std::sync::OnceLock::new();

fn chunks() -> &'static std::sync::Mutex<ChunkMap> {
    QUIC_CHUNKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 从 QUIC `sync.snapshot.chunk` 信封收一块；收齐后直接幂等合并。
pub async fn ingest_chunk(st: &AppState, payload: &serde_json::Value) -> serde_json::Value {
    let id = match payload["id"].as_str() {
        Some(s) => s.to_string(),
        None => return serde_json::json!({ "ok": false, "error": "缺 id" }),
    };
    let idx = match payload["index"].as_u64() {
        Some(i) => i as usize,
        None => return serde_json::json!({ "ok": false, "error": "缺 index" }),
    };
    let total = match payload["total"].as_u64() {
        Some(t) => t as usize,
        None => return serde_json::json!({ "ok": false, "error": "缺 total" }),
    };
    let b64 = payload["data"].as_str().unwrap_or("");
    if total == 0 || total > 4096 || idx >= total {
        return serde_json::json!({ "ok": false, "error": "分块参数不合法" });
    }
    let done = {
        let mut m = chunks().lock().unwrap_or_else(|e| e.into_inner());
        let e = m.entry(id.clone()).or_insert_with(|| (total, vec![None; total]));
        if e.0 != total || e.1.len() != total {
            *e = (total, vec![None; total]);
        }
        e.1[idx] = Some(b64.to_string());
        e.1.iter().all(|x| x.is_some())
    };
    if !done {
        return serde_json::json!({ "ok": true, "done": false });
    }
    let parts = {
        let mut m = chunks().lock().unwrap_or_else(|e| e.into_inner());
        m.remove(&id).map(|(_, v)| v).unwrap_or_default()
    };
    let joined: String = parts.into_iter().filter_map(|x| x).collect();
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(joined) {
        Ok(b) => b,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("快照解码失败: {e}") }),
    };
    let snap: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return serde_json::json!({ "ok": false, "error": format!("快照 JSON 损坏: {e}") }),
    };
    let r = merge_snapshot(st, &snap).await;
    serde_json::json!({ "ok": r["ok"].as_bool().unwrap_or(false), "done": true, "result": r })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// GET /api/sync/export?since_ms= → 白名单全量快照（目前忽略 since，靠导入幂等）
pub async fn export(
    State(st): State<AppState>,
    Query(q): Query<HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let since = q
        .get("since_ms")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);

    let fs = st.forge.lock().await;
    let agents: Vec<serde_json::Value> = fs
        .agents
        .iter()
        .filter(|a| a.created_at_ms >= since)
        .filter_map(|a| serde_json::to_value(a).ok())
        .collect();
    let sessions: Vec<serde_json::Value> = fs
        .sessions
        .iter()
        .filter(|s| s.created_at_ms >= since)
        .filter_map(|s| serde_json::to_value(s).ok())
        .collect();
    let contacts: Vec<serde_json::Value> = fs
        .contacts
        .all()
        .iter()
        .map(|c| {
            serde_json::json!({
                "did": c.did, "name": c.name, "note": c.note,
                "source": c.source,
            })
        })
        .collect();
    let world = serde_json::json!({
        "inbox": fs.inbox.clone(),
        "thread": fs.world_thread.clone(),
        "intents": fs.intents.clone(),
        "accepted": fs.accepted.clone(),
        "ignored": fs.ignored.clone(),
    });
    let profile = serde_json::to_value(&fs.profile).unwrap_or(serde_json::Value::Null);
    drop(fs);

    // 群组：元数据 + 全量消息（from/signature 保留，导入时按 hash 去重）
    let metas = st.groups.list_groups();
    let mut groups = Vec::new();
    for m in metas {
        let msgs = st.groups.history(&m.id, 100_000).unwrap_or_default();
        groups.push(serde_json::json!({
            "meta": m,
            "messages": msgs,
        }));
    }

    Json(serde_json::json!({
        "ok": true,
        "version": 1,
        "did": st.identity.did.as_str(),
        "generated_at_ms": now_ms(),
        "agents": agents,
        "sessions": sessions,
        "contacts": contacts,
        "world": world,
        "profile": profile,
        "groups": groups,
        "note": "不含 DID seed / 钱包私钥 / pepper / API Key"
    }))
}

fn dedup_key(v: &serde_json::Value) -> String {
    if let Some(id) = v.get("id").and_then(|x| x.as_str()) {
        return format!("id:{id}");
    }
    if let Some(h) = v.get("hash").and_then(|x| x.as_str()) {
        return format!("hash:{h}");
    }
    serde_json::to_string(v).unwrap_or_default()
}

/// POST /api/sync/import {snapshot} → 幂等合并
pub async fn import(
    State(st): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    Json(merge_snapshot(&st, &body).await)
}

/// 供 device_sync 直接调用（同一进程内合并，避免多一次 HTTP 回环）
pub async fn merge_snapshot(st: &AppState, snap: &serde_json::Value) -> serde_json::Value {
    let mut added = serde_json::json!({
        "agents": 0, "sessions": 0, "messages": 0,
        "contacts": 0, "world": 0, "groups": 0, "group_messages": 0,
    });
    let mut seen_group_msgs: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 先读已同步过的群消息 hash，避免重复 append
    if let Ok(raw) = std::fs::read_to_string(crate::server::data_dir().join("synced-group-msgs.json")) {
        if let Ok(v) = serde_json::from_str::<Vec<String>>(&raw) {
            seen_group_msgs.extend(v);
        }
    }

    // ── 群组：建缺失群 + 追加缺失消息（保留原 from / 时间） ──
    if let Some(groups) = snap.get("groups").and_then(|x| x.as_array()) {
        for g in groups {
            let meta = &g["meta"];
            let gid = meta["id"].as_str().unwrap_or_default();
            if gid.is_empty() {
                continue;
            }
            let exists = st.groups.list_groups().iter().any(|x| x.id == gid);
            if !exists {
                let acl = serde_json::from_value(meta["acl"].clone())
                        .unwrap_or(bolloon_p2p::group_orbit::GroupAcl::OwnerOnly);
                st.groups.create_group(
                    gid,
                    meta["name"].as_str().unwrap_or(gid),
                    meta["owner"].as_str().unwrap_or(""),
                    acl,
                    meta["created_at_ms"].as_u64().unwrap_or_else(now_ms),
                );
                added["groups"] = serde_json::json!(added["groups"].as_u64().unwrap_or(0) + 1);
            }
            if let Some(msgs) = g.get("messages").and_then(|x| x.as_array()) {
                for m in msgs {
                    let h = m["hash"].as_str().unwrap_or_default();
                    if h.is_empty() || seen_group_msgs.contains(h) {
                        continue;
                    }
                    let kind = m["kind"].as_str().unwrap_or("message");
                    let from = m["from"].as_str().unwrap_or("");
                    let text = m["content"].as_str().or_else(|| m["text"].as_str()).unwrap_or("");
                    let ts = m["timestamp_ms"].as_u64().unwrap_or_else(now_ms);
                    if st.groups.append(gid, &st.identity, kind, from, text, None, ts).is_ok() {
                        seen_group_msgs.insert(h.to_string());
                        added["group_messages"] =
                            serde_json::json!(added["group_messages"].as_u64().unwrap_or(0) + 1);
                    }
                }
            }
        }
    }
    if let Ok(body) = serde_json::to_string(&seen_group_msgs.into_iter().collect::<Vec<_>>()) {
        let _ = std::fs::write(crate::server::data_dir().join("synced-group-msgs.json"), body);
    }

    // ── agents / sessions / contacts / world / profile ──
    let mut fs = st.forge.lock().await;
    let mut seen_agents: std::collections::HashSet<String> =
        fs.agents.iter().map(|a| a.id.clone()).collect();
    if let Some(list) = snap.get("agents").and_then(|x| x.as_array()) {
        for v in list {
            let id = v["id"].as_str().unwrap_or_default();
            if id.is_empty() || seen_agents.contains(id) {
                continue;
            }
            if let Ok(a) = serde_json::from_value::<crate::native::AgentView>(v.clone()) {
                fs.agents.push(a);
                seen_agents.insert(id.to_string());
                added["agents"] = serde_json::json!(added["agents"].as_u64().unwrap_or(0) + 1);
            }
        }
    }

    let mut seen_sessions: std::collections::HashSet<String> =
        fs.sessions.iter().map(|s| s.id.clone()).collect();
    if let Some(list) = snap.get("sessions").and_then(|x| x.as_array()) {
        for v in list {
            let id = v["id"].as_str().unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            if !seen_sessions.contains(id) {
                if let Ok(s) = serde_json::from_value::<crate::native::UiSession>(v.clone()) {
                    fs.sessions.push(s);
                    seen_sessions.insert(id.to_string());
                    added["sessions"] =
                        serde_json::json!(added["sessions"].as_u64().unwrap_or(0) + 1);
                }
                continue;
            }
            // 已存在：按 (role,text,time) 幂等追加消息
            if let (Some(sess), Some(msgs)) = (
                fs.sessions.iter_mut().find(|s| s.id == id),
                v.get("messages").and_then(|x| x.as_array()),
            ) {
                let mut seen: std::collections::HashSet<String> = sess
                    .messages
                    .iter()
                    .map(|m| format!("{}|{}|{}", m.role, m.text, m.time))
                    .collect();
                for m in msgs {
                    if let Ok(msg) = serde_json::from_value::<crate::native::UiMessage>(m.clone()) {
                        let k = format!("{}|{}|{}", msg.role, msg.text, msg.time);
                        if seen.insert(k) {
                            sess.messages.push(msg);
                            added["messages"] =
                                serde_json::json!(added["messages"].as_u64().unwrap_or(0) + 1);
                        }
                    }
                }
            }
        }
    }

    if let Some(list) = snap.get("contacts").and_then(|x| x.as_array()) {
        for c in list {
            let did = c["did"].as_str().unwrap_or_default();
            if did.is_empty() {
                continue;
            }
            if fs.contacts.all().iter().any(|x| x.did == did) {
                continue;
            }
            if fs
                .contacts
                .upsert(did, c["name"].as_str().unwrap_or(""), "synced", now_ms())
                .is_ok()
            {
                added["contacts"] =
                    serde_json::json!(added["contacts"].as_u64().unwrap_or(0) + 1);
            }
        }
    }

    if let Some(world) = snap.get("world") {
        let mut seen: std::collections::HashSet<String> =
            fs.inbox.iter().map(dedup_key).collect();
        if let Some(items) = world.get("inbox").and_then(|x| x.as_array()) {
            for item in items {
                let k = dedup_key(item);
                if seen.insert(k) {
                    fs.inbox.push(item.clone());
                    added["world"] = serde_json::json!(added["world"].as_u64().unwrap_or(0) + 1);
                }
            }
        }
        let mut seen_t: std::collections::HashSet<String> = fs
            .world_thread
            .iter()
            .map(|x| serde_json::to_string(x).unwrap_or_default())
            .collect();
        if let Some(items) = world.get("thread").and_then(|x| x.as_array()) {
            for item in items {
                let k = serde_json::to_string(item).unwrap_or_default();
                if seen_t.insert(k) {
                    if let Ok(msg) = serde_json::from_value(item.clone()) {
                        fs.world_thread.push(msg);
                        added["world"] =
                            serde_json::json!(added["world"].as_u64().unwrap_or(0) + 1);
                    }
                }
            }
        }
    }

    // 资料：只在本地还没填名字时接收，避免覆盖用户在另一台设备上的编辑
    if let Some(name) = snap["profile"]["name"].as_str() {
        if fs.profile.name.trim().is_empty() && !name.trim().is_empty() {
            fs.profile.name = name.to_string();
        }
    }

    fs.save(&crate::server::data_dir());
    drop(fs);

    serde_json::json!({ "ok": true, "added": added })
}
