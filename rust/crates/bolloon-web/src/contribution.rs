//! contribution.rs — 贡献记录 / 善意积分 / 求助意图卡片 (2026-11-06 leo)
//!
//! ## 价值观 (写进代码, 不是营销话术)
//! - 用户用 AI 为集体做的贡献 (分享卡片 / 发布技能 / 补能力 / 回答群问题) 留下**可验证记录**:
//!   DID 归属 + 内容哈希 + 时间; 可选锚定到 IPFS(CID) 或 ETH(tx_hash)。
//! - 记录折算成 `credit` = **声誉分**, 不是代币: 不可转账、不可兑换、不可购买; 对数压缩 + 封顶,
//!   防止"贡献多的人永远拿走全部注意力"。
//! - 求助卡片**零分也分发**: credit 只影响可见度权重 (有上限), 绝不设准入门槛。
//! - 与现有货币系统"绑定但不完全利用": x402 付费卡片是**可选结算通道**, 求助默认免费;
//!   credit 不锚定法币、不清算、不进账本余额。主要价值观 = **可以不利用金钱产生合作**。
//!
//! 诚实边界: 本机不代签链上交易、不编造 CID; 锚定失败如实返回"仅本地记录"。

use axum::{extract::State, Json};

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn ledger_path() -> std::path::PathBuf {
    crate::server::data_dir().join("contributions.jsonl")
}

fn load() -> Vec<serde_json::Value> {
    std::fs::read_to_string(ledger_path())
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// 声誉分: 对数压缩 + 封顶 (不可转账/不可兑换/不可购买)
pub fn credit_of(records: &[serde_json::Value]) -> f64 {
    let n = records.len() as f64;
    (2.0 * n.sqrt()).min(50.0)
}

fn append(rec: &serde_json::Value) {
    use std::io::Write;
    let p = ledger_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(rec).unwrap_or_default());
    }
}

/// POST /api/contribution/record {kind, summary, ref_id?} → 记一条真实贡献
pub async fn record(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let kind = req["kind"].as_str().unwrap_or_default().trim().to_string();
    let summary = req["summary"].as_str().unwrap_or_default().trim().to_string();
    if kind.is_empty() || summary.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 kind / summary" }));
    }
    let did = st.identity.did.as_str().to_string();
    let at = now_ms();
    let ref_id = req["ref_id"].as_str().unwrap_or_default().to_string();
    let canonical = format!("{did}|{at}|{kind}|{summary}|{ref_id}");
    let hash = bolloon_x402::paid_info::compute_content_hash(&canonical);
    let rec = serde_json::json!({
        "id": format!("contrib-{at}"),
        "did": did, "at_ms": at, "kind": kind,
        "summary": summary.chars().take(300).collect::<String>(),
        "ref_id": ref_id,
        "content_hash": hash,
        "anchor": serde_json::Value::Null,
    });
    append(&rec);
    let all = load();
    Json(serde_json::json!({
        "ok": true, "id": rec["id"], "content_hash": hash,
        "credit": credit_of(&all), "records": all.len(),
        "note": "声誉分不可转账/不可兑换/不可购买; 求助永远不需要积分门槛"
    }))
}

/// GET /api/contribution/ledger → 贡献记录与声誉分
pub async fn ledger() -> Json<serde_json::Value> {
    let all = load();
    Json(serde_json::json!({
        "ok": true,
        "records": all.iter().rev().take(50).cloned().collect::<Vec<_>>(),
        "count": all.len(),
        "credit": credit_of(&all),
        "policy": {
            "kind": "reputation_not_currency",
            "transferable": false, "redeemable": false, "purchasable": false,
            "help_requires_credit": false,
            "note": "与货币系统只在可选 x402 结算处相接; 合作默认不需要金钱"
        }
    }))
}

fn looks_like_cid(s: &str) -> bool {
    s.starts_with("Qm") && s.len() >= 46 || s.starts_with("bafy") && s.len() >= 50
}
fn looks_like_tx(s: &str) -> bool {
    s.len() == 66 && s.starts_with("0x") && s[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// POST /api/contribution/anchor {id, cid?, tx_hash?} → 锚定到 IPFS / ETH
///
/// 只接受**真实提供**且形状合法的 CID / tx_hash; 都没给就尝试本机 Kubo (`ipfs_add`),
/// 失败如实说"仅本地记录", 绝不编造 CID 或假装上链。
pub async fn anchor(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 id" }));
    }
    let mut all = load();
    let Some(r) = all.iter_mut().find(|r| r["id"].as_str() == Some(id.as_str())) else {
        return Json(serde_json::json!({ "ok": false, "error": "没有这条贡献记录" }));
    };
    let cid = req["cid"].as_str().unwrap_or_default().trim().to_string();
    let tx = req["tx_hash"].as_str().unwrap_or_default().trim().to_string();
    let mut anchors: Vec<serde_json::Value> = vec![];
    if !cid.is_empty() {
        if !looks_like_cid(&cid) {
            return Json(serde_json::json!({ "ok": false, "error": "CID 形状不对 (Qm… / bafy…)" }));
        }
        anchors.push(serde_json::json!({ "kind": "ipfs", "cid": cid, "verified_by": "user_provided" }));
    }
    if !tx.is_empty() {
        if !looks_like_tx(&tx) {
            return Json(serde_json::json!({ "ok": false, "error": "tx_hash 形状不对 (0x + 64 hex)" }));
        }
        anchors.push(serde_json::json!({ "kind": "eth", "tx_hash": tx, "verified_by": "user_provided", "note": "本机不代签链上交易" }));
    }
    if anchors.is_empty() {
        // 尝试本机 IPFS (Kubo); 阻塞 HTTP 放 blocking 线程, 不占 tokio worker
        let args = serde_json::json!({
            "content": serde_json::to_string(r).unwrap_or_default(),
            "name": format!("{id}.json"),
        });
        let out = tokio::task::spawn_blocking(move || {
            bolloon_agent::ipfs_tools::IpfsExecutor.run("ipfs_add", &args)
        })
        .await
        .ok()
        .and_then(|r| r.ok());
        if let Some(text) = out {
            let maybe = text.split_whitespace().find(|w| looks_like_cid(w.trim_matches(|ch: char| !ch.is_ascii_alphanumeric())));
            if let Some(c) = maybe {
                let clean = c.trim_matches(|ch: char| !ch.is_ascii_alphanumeric());
                anchors.push(serde_json::json!({ "kind": "ipfs", "cid": clean, "verified_by": "local_kubo" }));
            }
        }
        if anchors.is_empty() {
            return Json(serde_json::json!({
                "ok": false, "error": "本机 IPFS 未启动且未提供 CID/tx_hash — 贡献仍是本地签名记录, 未上链",
                "note": "绝不编造 CID; 启动 Kubo 后重试, 或填入真实 CID / ETH 交易哈希"
            }));
        }
    }
    r["anchor"] = serde_json::json!(anchors);
    let snapshot = r.clone();
    // append-only 账本: 追加一条 anchor 事件, 不改写历史行
    append(&serde_json::json!({
        "id": format!("anchor-{}", now_ms()), "kind": "anchor",
        "ref_id": id, "anchors": anchors, "at_ms": now_ms(),
    }));
    let _ = st;
    Json(serde_json::json!({ "ok": true, "record": snapshot, "note": "锚定已作为独立事件追加, 历史行不改" }))
}

/// POST /api/world/cards/help {text, urgency?} → 求助意图卡片 (善意优先分发)
///
/// 零贡献分也分发; credit 只加权可见度 (封顶), 不设门槛。
pub async fn help_card(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let text = req["text"].as_str().unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 text（说清你需要什么帮助）" }));
    }
    let credit = credit_of(&load());
    let at = now_ms();
    // 本机候选响应者: 名字/标签与求助文本有交集的智能体 (不编造跨机响应)
    let responders: Vec<serde_json::Value> = {
        let fs = st.forge.lock().await;
        fs.agents
            .iter()
            .filter(|a| {
                a.name.chars().any(|c| text.contains(c)) || a.id.chars().any(|c| text.contains(c))
            })
            .take(3)
            .map(|a| serde_json::json!({ "id": a.id, "name": a.name }))
            .collect()
    };
    let card = serde_json::json!({
        "title": format!("需要帮助：{}", text.chars().take(40).collect::<String>()),
        "summary": text,
        "media": [], "cover": serde_json::Value::Null,
        "provider_did": st.identity.did.as_str(), "scope": "public",
        "issued_at_ms": at, "verification": "verified", "category": serde_json::Value::Null,
        "tags": ["help", "intent"],
        "actions": [], "reply_to": serde_json::Value::Null,
    });
    // 双通道分发 (去中心化): public 走世界广播; private 副本定向投递给所有好友
    // —— 求助要"更多可能性到每个人的电脑/手机", 不能只挂公域等人来看。
    let share = crate::native::world_cards_share(State(st.clone()), Json(card.clone())).await.0;
    let mut private_card = card.clone();
    private_card["scope"] = serde_json::json!("private");
    let direct = crate::native::world_cards_share(State(st.clone()), Json(private_card)).await.0;
    // 特定智能体立刻想办法满足: 走差距→自动写方法型 skill (真实动作, 不是空话)
    let cls = bolloon_agent::world::classify_intent(&text);
    let intent = bolloon_agent::world::Intent {
        id: format!("help-intent-{at}"),
        text: text.clone(),
        tags: text.split_whitespace().take(6).map(String::from).collect(),
        active: true,
        created_at_ms: at,
        category: cls.category,
        want: cls.want,
        clarity: cls.clarity,
    };
    let workflow = crate::native::author_skill_for_intent(&st, &intent)
        .await
        .unwrap_or_else(|| "本轮无能力差距，已入意图与信念系统".into());
    // 本机世界流也放一张, 可见度 = 基础分 + 声誉加权(封顶), 零分也照样出现
    let visibility = (2.0 + (credit * 0.05).min(2.5)).min(5.0);
    let mut fs = st.forge.lock().await;
    let oid = format!("card-{:04}", fs.inbox.len() + 1);
    fs.inbox.push(serde_json::json!({
        "id": oid, "kind": "card", "score": visibility,
        "title": card["title"], "summary": text, "card": card,
        "source": "help-intent", "by": st.identity.did.as_str(), "ts": at,
        "help": { "credit": credit, "responders": responders, "free": true },
    }));
    fs.save(&crate::server::data_dir());
    drop(fs);
    let _ = crate::world_interact::record_interaction(
        &st,
        "accept",
        &oid,
        serde_json::json!({ "label": text.chars().take(60).collect::<String>(), "tags": ["help", "intent"] }),
    )
    .await;
    Json(serde_json::json!({
        "ok": true, "id": oid, "credit": credit,
        "visibility": visibility, "responders": responders,
        "delivery": share["delivery"], "direct_delivery": direct["delivery"],
        "workflow": workflow,
        "note": "善意优先: 零贡献分同样分发; 声誉只加权可见度(有上限), 不是付费门槛; 货币结算仅为可选项"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credit_is_compressed_and_capped() {
        let many: Vec<serde_json::Value> = (0..1000).map(|_| serde_json::json!({})).collect();
        assert!(credit_of(&many) <= 50.0);
        assert_eq!(credit_of(&[]), 0.0);
        assert!(credit_of(&many[..4]) < credit_of(&many[..16]));
    }

    #[test]
    fn anchor_shapes_are_validated() {
        assert!(looks_like_cid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
        assert!(looks_like_tx(&format!("0x{}", "a".repeat(64))));
        assert!(!looks_like_cid("not-a-cid"));
        assert!(!looks_like_tx("0x123"));
    }
}

// ─────────────── 跨机可验证 (2026-11-06 leo) ───────────────
//
// DID 本身就是 Ed25519 公钥 (did:pi:<b58 pubkey>), 所以对端**不需要**信任发送方、
// 也不需要中心目录: 拿到信封即可用 signer DID 反解公钥验签 + 重算内容哈希。
// 与 world.card 共用同一套 canonical_json / KeyPair::verify, 不另造密码学。

pub const CONTRIB_PROTOCOL: &str = "bolloon-contribution/v1";
pub const CONTRIB_TOPIC: &str = "contribution.record";

fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}
fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

fn canonical_record(rec: &serde_json::Value) -> String {
    bolloon_p2p::envelope::canonical_json(rec)
}

fn record_digest(rec: &serde_json::Value) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        rec["did"].as_str().unwrap_or(""),
        rec["at_ms"].as_u64().unwrap_or(0),
        rec["kind"].as_str().unwrap_or(""),
        rec["summary"].as_str().unwrap_or(""),
        rec["ref_id"].as_str().unwrap_or(""),
    )
}

/// 签名信封 (导出的 proof 不含任何私钥/口令)
pub fn make_proof(
    rec: &serde_json::Value,
    kp: &bolloon_p2p::identity::KeyPair,
) -> serde_json::Value {
    let sig = kp.sign(canonical_record(rec).as_bytes());
    serde_json::json!({
        "protocol": CONTRIB_PROTOCOL,
        "topic": CONTRIB_TOPIC,
        "record": rec.clone(),
        "signer": kp.did.as_str(),
        "signature": to_hex(&sig),
        "issued_at_ms": now_ms(),
    })
}

/// 验跨机贡献信封: 协议 → DID 一致 → 公钥反解 → 签名 → 内容哈希。任一步不过即拒。
pub fn verify_proof(proof: &serde_json::Value) -> Result<serde_json::Value, String> {
    if proof["protocol"].as_str() != Some(CONTRIB_PROTOCOL) {
        return Err("协议不对 (不是 bolloon-contribution/v1)".into());
    }
    if proof["topic"].as_str() != Some(CONTRIB_TOPIC) {
        return Err("topic 不对".into());
    }
    let rec = &proof["record"];
    let signer = proof["signer"].as_str().unwrap_or_default();
    if signer.is_empty() || rec["did"].as_str() != Some(signer) {
        return Err("记录里的 DID 与签名者不一致".into());
    }
    let pk = bolloon_p2p::identity::pubkey_of_did(signer)
        .ok_or_else(|| "DID 解析不出公钥".to_string())?;
    let raw = from_hex(proof["signature"].as_str().unwrap_or_default())
        .ok_or_else(|| "签名不是合法 hex".to_string())?;
    if raw.len() != 64 {
        return Err("签名长度不对 (应 64B)".into());
    }
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&raw);
    if !bolloon_p2p::identity::KeyPair::verify(&pk, canonical_record(rec).as_bytes(), &sig) {
        return Err("签名无效 (内容可能被改过)".into());
    }
    let expected = bolloon_x402::paid_info::compute_content_hash(&record_digest(rec));
    if rec["content_hash"].as_str() != Some(expected.as_str()) {
        return Err("内容哈希对不上".into());
    }
    Ok(rec.clone())
}

fn peers_path() -> std::path::PathBuf {
    crate::server::data_dir().join("peer-contributions.jsonl")
}
fn peer_records() -> Vec<serde_json::Value> {
    std::fs::read_to_string(peers_path())
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}
fn append_peer(rec: &serde_json::Value) {
    use std::io::Write;
    let p = peers_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(rec).unwrap_or_default());
    }
}

/// GET /api/contribution/proof?id= → 导出可交给别人的签名信封
pub async fn proof(
    State(st): State<crate::AppState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let id = q.get("id").cloned().unwrap_or_default();
    let Some(rec) = load().into_iter().find(|r| r["id"].as_str() == Some(id.as_str())) else {
        return Json(serde_json::json!({ "ok": false, "error": "没有这条贡献记录" }));
    };
    Json(serde_json::json!({ "ok": true, "proof": make_proof(&rec, &st.identity) }))
}

/// POST /api/contribution/verify {proof} → 纯验签 (不入库; 变异自检用这个)
pub async fn verify(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    match verify_proof(&req["proof"]) {
        Ok(rec) => Json(serde_json::json!({ "ok": true, "verified": true, "record": rec,
            "note": "用 signer DID 反解公钥验签 + 重算内容哈希, 不依赖中心目录" })),
        Err(e) => Json(serde_json::json!({ "ok": false, "verified": false, "error": e })),
    }
}

/// POST /api/contribution/inbox {proof} → 对端投递入口: 验签通过才入库
pub async fn inbox(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let rec = match verify_proof(&req["proof"]) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "ok": false, "verified": false, "error": e })),
    };
    let hash = rec["content_hash"].as_str().unwrap_or_default().to_string();
    if peer_records().iter().any(|r| r["content_hash"].as_str() == Some(hash.as_str())) {
        return Json(serde_json::json!({ "ok": true, "verified": true, "duplicate": true,
            "note": "同一贡献已验过, 不重复入库" }));
    }
    let mut stored = rec.clone();
    stored["received_at_ms"] = serde_json::json!(now_ms());
    append_peer(&stored);
    Json(serde_json::json!({ "ok": true, "verified": true, "duplicate": false,
        "id": rec["id"], "signer": rec["did"] }))
}

/// POST /api/contribution/announce {id, peer_url?|did?} → 把签名信封发给对端节点
pub async fn announce(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let Some(rec) = load().into_iter().find(|r| r["id"].as_str() == Some(id.as_str())) else {
        return Json(serde_json::json!({ "ok": false, "error": "没有这条贡献记录" }));
    };
    let proof = make_proof(&rec, &st.identity);
    let url = if let Some(u) = req["peer_url"].as_str().filter(|s| !s.is_empty()) {
        u.trim_end_matches('/').to_string()
    } else if let Some(did) = req["did"].as_str().filter(|s| !s.is_empty()) {
        match crate::native::peer_url_for_did(&st, did).await {
            Ok(u) => u,
            Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
        }
    } else {
        return Json(serde_json::json!({ "ok": false, "error": "缺 peer_url 或 did" }));
    };
    match crate::native::peer_json(
        "POST",
        format!("{url}/api/contribution/inbox"),
        Some(serde_json::json!({ "proof": proof })),
    ).await {
        Ok(v) => Json(serde_json::json!({ "ok": v["ok"] == serde_json::json!(true),
            "peer": v, "note": "对端独立验签; 本机说了不算" })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// GET /api/contribution/peers → 已通过验签的对端贡献
pub async fn peers() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "records": peer_records() }))
}

#[cfg(test)]
mod proof_tests {
    use super::*;

    fn rec_for(kp: &bolloon_p2p::identity::KeyPair) -> serde_json::Value {
        let did = kp.did.as_str().to_string();
        let at = 1_700_000_000_000u64;
        let (kind, summary, ref_id) = ("share_card", "分享资料给集体", "");
        let hash = bolloon_x402::paid_info::compute_content_hash(
            &format!("{did}|{at}|{kind}|{summary}|{ref_id}"),
        );
        serde_json::json!({
            "id": "contrib-test", "did": did, "at_ms": at, "kind": kind,
            "summary": summary, "ref_id": ref_id, "content_hash": hash,
            "anchor": serde_json::Value::Null,
        })
    }

    #[test]
    fn proof_roundtrip_and_tamper_is_refused() {
        let kp = bolloon_p2p::identity::KeyPair::generate();
        let proof = make_proof(&rec_for(&kp), &kp);
        assert!(verify_proof(&proof).is_ok(), "自己签的必须验得过");

        let mut tampered = proof.clone();
        tampered["record"]["summary"] = serde_json::json!("偷偷改成更大的贡献");
        assert!(verify_proof(&tampered).is_err(), "改内容必须验不过");

        let mut wrong_did = proof.clone();
        wrong_did["signer"] = serde_json::json!("did:pi:someoneelse");
        assert!(verify_proof(&wrong_did).is_err(), "换签名者必须验不过");

        let mut bad_hash = proof.clone();
        bad_hash["record"]["content_hash"] = serde_json::json!("deadbeef");
        assert!(verify_proof(&bad_hash).is_err(), "哈希对不上必须验不过");
    }

    #[test]
    fn proof_never_contains_private_material() {
        let kp = bolloon_p2p::identity::KeyPair::generate();
        let text = serde_json::to_string(&make_proof(&rec_for(&kp), &kp)).unwrap();
        assert!(!text.contains("secret"));
        assert!(text.len() < 4000);
    }
}
