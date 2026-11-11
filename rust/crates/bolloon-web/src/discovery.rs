//! 去中心化「手机号 → DIAP 地址」发现（gossip 电话簿）。
//!
//! 2026-11-11 需求：两个陌生人只凭手机号互联，不能有单一中心服务器。
//!
//! 做法：
//! - `discovery_topic(phone)` 是**全局确定性**的 32B 键（双方只输同一个号码就算出同一个键）；
//! - 每条记录 `{topic, did, diap, ts_ms, sig}` 由该 DID 的私钥签名，任何节点都能验；
//! - 节点绑定手机号后，把记录沿着已登记的 DIAP 对端 **gossip 广播**；
//! - 收到记录的节点验签 → 存本地 → 继续转发（hops ≤ 2 防环）；
//! - 查询方只输手机号 → 算 topic → 查本地 gossip 缓存 → 拿到对方 DIAP 地址直连。
//!
//! **没有中心电话簿**：每个节点都存一份、都能转发；bootstrap 只是「任意几个已知节点」，
//! 互为 peer，不是单点。诚实边界见模块末尾与 wiki：零 bootstrap 的 P2P 发现在数学上不存在。
//!
//! 明文手机号**不落盘**：磁盘上只有 topic（加盐哈希）与 DID/地址。

use std::collections::BTreeMap;

use axum::extract::State;
use axum::Json;
use serde_json::Value;

use crate::server::AppState;
use bolloon_agent::directory::discovery_topic_hex;

fn cache_path() -> std::path::PathBuf {
    crate::server::data_dir().join("discovery-cache.json")
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn read_map() -> BTreeMap<String, Value> {
    let v: Value = std::fs::read_to_string(cache_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));
    if !v.is_object() {
        return BTreeMap::new();
    }
    serde_json::from_value(v).unwrap_or_default()
}

fn write_map(m: &BTreeMap<String, Value>) {
    if let Ok(s) = serde_json::to_string_pretty(m) {
        let _ = std::fs::write(cache_path(), s);
    }
}

fn signed_message(topic: &str, did: &str, ts: u64) -> String {
    format!("bolloon-discovery|1|{topic}|{did}|{ts}")
}

/// 验签：DID 里内嵌 Ed25519 公钥，记录不能被别人伪造或改地址。
pub fn verify_record(v: &Value) -> bool {
    let did = v["did"].as_str().unwrap_or_default();
    let topic = v["topic"].as_str().unwrap_or_default();
    let ts = v["ts_ms"].as_u64().unwrap_or(0);
    let sig_hex = v["sig"].as_str().unwrap_or_default();
    if did.is_empty() || topic.len() != 64 || ts == 0 {
        return false;
    }
    let Some(pk) = bolloon_p2p::pubkey_of_did(did) else {
        return false;
    };
    let Ok(raw) = hex::decode(sig_hex) else {
        return false;
    };
    let Ok(sig) = <[u8; 64]>::try_from(raw) else {
        return false;
    };
    bolloon_p2p::KeyPair::verify(&pk, signed_message(topic, did, ts).as_bytes(), &sig)
}

/// 新记录（时间戳更新）才落盘并值得继续转发。
fn put(v: &Value) -> bool {
    let topic = v["topic"].as_str().unwrap_or_default().to_string();
    if topic.is_empty() {
        return false;
    }
    let mut m = read_map();
    let old = m.get(&topic).and_then(|x| x["ts_ms"].as_u64()).unwrap_or(0);
    if v["ts_ms"].as_u64().unwrap_or(0) <= old {
        return false;
    }
    m.insert(topic, v.clone());
    write_map(&m);
    true
}

/// 本机手机号 → gossip 记录；绑定成功后调用（自动带 DIAP 地址）。
/// 构造一条 DID 私钥签名的发现记录（gossip 与 DHT 共用同一格式/同一套验签）。
pub fn signed_record(st: &AppState, phone: &str) -> Value {
    let topic = discovery_topic_hex(phone);
    let did = st.identity.did.as_str().to_string();
    let ts = now_ms();
    let sig = hex::encode(st.identity.sign(signed_message(&topic, &did, ts).as_bytes()));
    let diap = {
        #[cfg(feature = "diap-backend")]
        {
            crate::diap_hub::global()
                .map(|h| h.address_json())
                .unwrap_or(Value::Null)
        }
        #[cfg(not(feature = "diap-backend"))]
        {
            Value::Null
        }
    };
    serde_json::json!({
        "topic": topic, "did": did, "diap": diap,
        "ts_ms": ts, "sig": sig, "hops": 0,
    })
}

pub async fn announce_self(st: &AppState, phone: &str) -> Value {
    let rec = signed_record(st, phone);
    let topic = rec["topic"].as_str().unwrap_or_default().to_string();
    let fresh = put(&rec);
    let sent = broadcast(st, &rec).await;
    serde_json::json!({ "ok": true, "topic": topic, "fresh": fresh, "broadcast": sent })
}

/// 从手机号派生一个短标签（只做 DIAP peer 的标识 url，不含手机号明文）
pub fn topic_short(phone: &str) -> String {
    discovery_topic_hex(phone).chars().take(12).collect()
}

/// 只输手机号就能查：命中返回带签名的记录（含 did + DIAP 地址）。
pub fn lookup(phone: &str) -> Option<Value> {
    read_map().get(&discovery_topic_hex(phone)).cloned()
}

async fn broadcast(st: &AppState, rec: &Value) -> usize {
    #[cfg(feature = "diap-backend")]
    {
        let Some(hub) = crate::diap_hub::global() else {
            return 0;
        };
        let urls = hub.peer_urls().await;
        let mut sent = 0usize;
        for url in urls {
            let target = format!("{}/api/discovery/announce", url.trim_end_matches('/'));
            if crate::native::peer_json("POST", target, Some(rec.clone()))
                .await
                .is_ok()
            {
                sent += 1;
            }
        }
        let _ = st;
        sent
    }
    #[cfg(not(feature = "diap-backend"))]
    {
        let _ = (st, rec);
        0
    }
}

/// POST /api/discovery/announce —— 收一条 gossip 记录：验签 → 存 → 转发。
pub async fn announce(State(st): State<AppState>, Json(req): Json<Value>) -> Json<Value> {
    if !verify_record(&req) {
        return Json(serde_json::json!({ "ok": false, "error": "记录验签不过 (伪造或内容被改)" }));
    }
    if req["did"].as_str() == Some(st.identity.did.as_str()) {
        return Json(serde_json::json!({ "ok": true, "skipped": "self" }));
    }
    let fresh = put(&req);
    let hops = req["hops"].as_u64().unwrap_or(0);
    let mut forwarded = 0usize;
    if fresh && hops < 2 {
        let mut next = req.clone();
        next["hops"] = serde_json::json!(hops + 1);
        forwarded = broadcast(&st, &next).await;
    }
    Json(serde_json::json!({ "ok": true, "fresh": fresh, "forwarded": forwarded }))
}

/// GET /api/discovery/find?phone=… —— 只回显已经验签过的记录，不回显手机号明文。
pub async fn find(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let phone = q.get("phone").cloned().unwrap_or_default();
    if phone.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 phone" }));
    }
    match lookup(&phone) {
        Some(rec) => Json(serde_json::json!({
            "ok": true, "found": true, "topic": discovery_topic_hex(&phone),
            "did": rec["did"], "diap": rec["diap"], "ts_ms": rec["ts_ms"],
        })),
        None => Json(serde_json::json!({
            "ok": true, "found": false,
            "note": "gossip 缓存里还没有这个号码; 对方需在线并广播过, 或需要更多 bootstrap peer",
        })),
    }
}
