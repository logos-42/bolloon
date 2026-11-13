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

/// v2 签名正文: **把 DIAP 地址一起签进去**。
/// 2026-11-13: v1 只签 topic/did/ts，中间人可拿一条合法签名把 `diap` 换成自己的
/// 地址（目录/边缘服务器不可信时这就是投毒面）。v2 覆盖地址后，改一个字节都验不过。
fn signed_message_v2(topic: &str, did: &str, ts: u64, diap: &Value) -> String {
    format!("bolloon-discovery|2|{topic}|{did}|{ts}|{diap}")
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
    // v1 记录仍可验（兼容过渡）；边缘目录只接受 v2。
    let msg = if v["v"].as_u64().unwrap_or(1) >= 2 {
        signed_message_v2(topic, did, ts, &v["diap"])
    } else {
        signed_message(topic, did, ts)
    };
    bolloon_p2p::KeyPair::verify(&pk, msg.as_bytes(), &sig)
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
    signed_record_for(st, "phone", phone)
}

/// 通用签名记录：kind = phone / email / did。记录里带 kind，客户端可核对。
pub fn signed_record_for(st: &AppState, kind: &str, value: &str) -> Value {
    let topic = bolloon_agent::directory::discovery_topic_for_hex(kind, value);
    let did = st.identity.did.as_str().to_string();
    let ts = now_ms();
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
    let sig = hex::encode(
        st.identity.sign(signed_message_v2(&topic, &did, ts, &diap).as_bytes()),
    );
    serde_json::json!({
        "v": 2, "kind": kind,
        "topic": topic, "did": did, "diap": diap,
        "ts_ms": ts, "sig": sig, "hops": 0,
    })
}

pub async fn announce_self(st: &AppState, phone: &str) -> Value {
    announce_self_for(st, "phone", phone).await
}

/// 发布邮箱 / DID 的发现记录（与手机号同一套签名与 gossip 转发）。
pub async fn announce_self_for(st: &AppState, kind: &str, value: &str) -> Value {
    let rec = signed_record_for(st, kind, value);
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
    lookup_topic(&discovery_topic_hex(phone))
}

/// 按 topic 直接查（边缘目录的查询入口；服务端从不需要知道手机号明文）。
pub fn lookup_topic(topic: &str) -> Option<Value> {
    read_map().get(topic).cloned()
}

/// 按 kind + 明文查（本机 gossip 缓存）。
pub fn lookup_for(kind: &str, value: &str) -> Option<Value> {
    lookup_topic(&bolloon_agent::directory::discovery_topic_for_hex(kind, value))
}

/// POST /api/discovery/announce-self {kind, value}
/// 邮箱 / DID 的发布入口（手机号走 /api/phone/bind 自动发布）。
pub async fn remote_announce_self(
    State(st): State<AppState>,
    Json(req): Json<Value>,
) -> Json<Value> {
    let kind = req["kind"].as_str().unwrap_or("phone").trim().to_ascii_lowercase();
    let value = req["value"].as_str().unwrap_or_default().trim().to_string();
    if value.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 value" }));
    }
    if !matches!(kind.as_str(), "phone" | "email" | "did") {
        return Json(serde_json::json!({ "ok": false, "error": "kind 只支持 phone/email/did" }));
    }
    Json(announce_self_for(&st, &kind, &value).await)
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

// ───────────── 边缘目录端点 (2026-11-13) ─────────────
// 任何 bolloon 节点都能当「电话簿」: bolloon.cn 只要跑一个 `bolloon web` 即可，
// Cloudflare Worker 也可以实现同一契约。服务端**只存带签名的记录**，
// 客户端拿到后自己验签 ⇒ 服务端被投毒/被篡改也冒充不了别人。
// 与 gossip 的 /announce 区别: 这里**不转发**，避免把边缘节点变成广播源。

const REMOTE_MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

fn valid_topic(t: &str) -> bool {
    t.len() == 64 && t.chars().all(|c| c.is_ascii_hexdigit())
}

/// POST /api/discovery/remote/announce —— 存一条 v2 签名记录（按 topic 索引）。
pub async fn remote_announce(Json(req): Json<Value>) -> Json<Value> {
    let rec = if req["record"].is_object() {
        req["record"].clone()
    } else {
        req.clone()
    };
    let topic = rec["topic"].as_str().unwrap_or_default();
    if !valid_topic(topic) {
        return Json(serde_json::json!({ "ok": false, "error": "topic 必须是 64 位 hex" }));
    }
    // 边缘目录只收 v2: 签名必须覆盖 DIAP 地址，否则目录可换地址做中间人
    if rec["v"].as_u64().unwrap_or(1) < 2 {
        return Json(serde_json::json!({ "ok": false, "error": "只接受 v2 记录 (签名覆盖地址)" }));
    }
    if !verify_record(&rec) {
        return Json(serde_json::json!({ "ok": false, "error": "记录验签不过: 已拒收" }));
    }
    let ts = rec["ts_ms"].as_u64().unwrap_or(0);
    if now_ms().abs_diff(ts) > REMOTE_MAX_AGE_MS {
        return Json(serde_json::json!({ "ok": false, "error": "记录时间戳过期 (>30d): 已拒收" }));
    }
    let fresh = put(&rec);
    Json(serde_json::json!({ "ok": true, "topic": topic, "fresh": fresh }))
}

/// GET /api/discovery/remote/find?topic=<64hex> —— 只按哈希查，服务端看不到手机号明文。
pub async fn remote_find(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let topic = q.get("topic").cloned().unwrap_or_default();
    if !valid_topic(&topic) {
        return Json(serde_json::json!({ "ok": false, "error": "topic 必须是 64 位 hex" }));
    }
    match lookup_topic(&topic) {
        Some(rec) => Json(serde_json::json!({ "ok": true, "found": true, "record": rec })),
        None => Json(serde_json::json!({ "ok": true, "found": false })),
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_p2p::KeyPair;

    fn did_of(kp: &KeyPair) -> String {
        format!("did:pi:{}", bolloon_p2p::b58_encode(&kp.public_bytes()))
    }

    fn signed_v2(diap: &Value) -> Value {
        let kp = KeyPair::from_seed(&[9u8; 32]);
        let did = did_of(&kp);
        let topic = "ab".repeat(32);
        let ts = 1_700_000_000_000u64;
        let sig = hex::encode(kp.sign(signed_message_v2(&topic, &did, ts, diap).as_bytes()));
        serde_json::json!({
            "v": 2, "topic": topic, "did": did, "diap": diap,
            "ts_ms": ts, "sig": sig, "hops": 0,
        })
    }

    /// 边缘目录不可信：把记录里的 DIAP 地址换成中间人地址必须验不过。
    #[test]
    fn v2_signature_covers_diap_address() {
        let rec = signed_v2(&serde_json::json!({"addrs":[{"Ip":"1.2.3.4:54188"}],"id":"node-a"}));
        assert!(verify_record(&rec));
        let mut tampered = rec.clone();
        tampered["diap"] = serde_json::json!({"addrs":[{"Ip":"6.6.6.6:6666"}],"id":"attacker"});
        assert!(!verify_record(&tampered), "改地址必须验不过");
        let mut forged = rec.clone();
        forged["sig"] = serde_json::json!("00".repeat(64));
        assert!(!verify_record(&forged), "伪造签名必须验不过");
    }

    /// v1 记录为了兼容旧节点仍可验，但边缘目录只收 v2（签名覆盖地址）。
    #[test]
    fn v1_is_compatible_but_not_accepted_by_remote_directory() {
        let kp = KeyPair::from_seed(&[3u8; 32]);
        let did = did_of(&kp);
        let topic = "cd".repeat(32);
        let ts = 1_700_000_000_000u64;
        let sig = hex::encode(kp.sign(signed_message(&topic, &did, ts).as_bytes()));
        let v1 = serde_json::json!({
            "topic": topic, "did": did, "diap": {"addrs": []}, "ts_ms": ts, "sig": sig,
        });
        assert!(verify_record(&v1), "旧记录仍可验");
        assert!(v1["v"].as_u64().unwrap_or(1) < 2, "但边缘目录只收 v2");
    }

    #[tokio::test]
    async fn remote_announce_rejects_v1_and_bad_topic() {
        let r = remote_announce(axum::Json(serde_json::json!({
            "topic": "ab".repeat(32), "v": 1, "did": "did:pi:x", "sig": "00",
        })))
        .await
        .0;
        assert_eq!(r["ok"], false, "v1 必须被边缘目录拒收");
        let r2 = remote_announce(axum::Json(serde_json::json!({
            "topic": "not-hex", "v": 2,
        })))
        .await
        .0;
        assert_eq!(r2["ok"], false, "非法 topic 必须被拒收");
    }
}
