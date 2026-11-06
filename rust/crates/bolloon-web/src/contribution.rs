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

/// 积分权重 (2026-11-06 leo): **为别人提供服务才有大分**, 日常共享只给一点点。
/// 服务类不允许自报 —— 只能由真实交付回执 (验链成功 / 对方确认) 自动记。
pub const POINTS_BY_KIND: &[(&str, f64)] = &[
    ("service_paid", 5.0),
    ("service_delivered", 5.0),
    ("skill_share", 0.5),
    ("card_share", 0.3),
    ("contribution_card", 0.3),
    ("share_card", 0.3), // 旧台账里"贡献卡片"用的老 kind, 保留小分不归零
];
pub fn points_for(kind: &str) -> f64 {
    POINTS_BY_KIND.iter().find(|(k, _)| *k == kind).map(|(_, p)| *p).unwrap_or(0.0)
}
pub fn is_self_reportable(kind: &str) -> bool {
    matches!(kind, "skill_share" | "card_share" | "contribution_card" | "share_card")
}

/// 累计贡献分 earned: **只增不减**; 每条按权重求和, anchor/penalty 等元数据不算。
pub fn credit_of(records: &[serde_json::Value]) -> f64 {
    records.iter().filter(|r| {
        r["content_hash"].is_string() && r["at_ms"].is_u64()
            && r["kind"].as_str() != Some("anchor") && r["kind"].as_str() != Some("penalty")
    }).map(|r| {
        r["points"].as_f64().unwrap_or_else(|| points_for(r["kind"].as_str().unwrap_or("")))
    }).sum()
}

/// 内部加分入口: 只有代码里**真实交付点**才调用, 端点不直接暴露服务类。
/// 按 (did|kind|ref_id|evidence) 去重 —— 同一笔服务/同一次分享不重复刷分。
pub fn award(st: &crate::AppState, kind: &str, summary: &str, ref_id: &str, evidence: &str) -> f64 {
    let points = points_for(kind);
    if points <= 0.0 {
        return 0.0;
    }
    let did = st.identity.did.as_str().to_string();
    let key = format!("{did}|{kind}|{ref_id}|{evidence}");
    let hash = bolloon_x402::paid_info::compute_content_hash(&key);
    if load().iter().any(|r| r["content_hash"].as_str() == Some(hash.as_str())) {
        return 0.0;
    }
    let at = now_ms();
    append(&serde_json::json!({
        "id": format!("contrib-{at}"), "did": did, "at_ms": at,
        "kind": kind, "summary": summary.chars().take(300).collect::<String>(),
        "ref_id": ref_id, "evidence": evidence, "points": points,
        "content_hash": hash, "anchor": serde_json::Value::Null,
    }));
    points
}

/// 增值服务目录: 只列**真能兑现**的动作
pub const SERVICES: &[(&str, &str, i64)] = &[
    ("proof_export", "导出贡献签名证明（跨机可验）", 2),
    ("help_boost", "求助卡片加权并再分发一次", 3),
    ("card_boost", "世界卡片优先分发一次", 5),
];

fn spend_path() -> std::path::PathBuf {
    crate::server::data_dir().join("contribution-spend.jsonl")
}
fn spend_records() -> Vec<serde_json::Value> {
    std::fs::read_to_string(spend_path()).unwrap_or_default().lines()
        .filter_map(|l| serde_json::from_str(l).ok()).collect()
}
fn append_spend(rec: &serde_json::Value) {
    use std::io::Write;
    let p = spend_path();
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(rec).unwrap_or_default());
    }
}

/// (累计获得, 已消费, 惩罚扣减, 可用余额); 做坏事才有 penalty, 无自动判定默认 0
pub fn balance_state() -> (f64, f64, f64, f64) {
    let earned = credit_of(&load());
    let (mut spent, mut penalty) = (0.0f64, 0.0f64);
    for r in spend_records() {
        let v = r["points"].as_f64().unwrap_or(0.0);
        match r["kind"].as_str() {
            Some("spend") => spent += v, Some("penalty") => penalty += v, _ => {}
        }
    }
    (earned, spent, penalty, (earned - spent - penalty).max(0.0))
}

/// GET /api/contribution/balance → 左下角余额
pub async fn balance() -> Json<serde_json::Value> {
    let (earned, spent, penalty, available) = balance_state();
    Json(serde_json::json!({ "ok": true, "earned": earned, "spent": spent,
        "penalty": penalty, "balance": available,
        "services": SERVICES.iter().map(|(id,name,price)|
            serde_json::json!({"id":id,"name":name,"price":price})).collect::<Vec<_>>(),
        "note": "没做坏事只增不减；唯一消耗 = 购买增值服务；求助永不需要积分" }))
}

/// POST /api/contribution/spend {service, ref_id?} → 扣积分并**真兑现**
pub async fn spend(State(st): State<crate::AppState>, Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let service = req["service"].as_str().unwrap_or_default().trim().to_string();
    let Some((_, name, price)) = SERVICES.iter().find(|(id,_,_)| *id == service) else {
        return Json(serde_json::json!({"ok":false,"error":"没有这个增值服务",
            "services":SERVICES.iter().map(|(id,n,p)|serde_json::json!({"id":id,"name":n,"price":p})).collect::<Vec<_>>()}));
    };
    let before = balance_state().3;
    if before < *price as f64 {
        return Json(serde_json::json!({"ok":false,"error":"贡献积分不足","balance":before,"price":price}));
    }
    let ref_id = req["ref_id"].as_str().unwrap_or_default().to_string();
    let mut delivered = serde_json::json!({"service":service,"name":name});
    match service.as_str() {
        "proof_export" => {
            let Some(rec) = load().into_iter().find(|r| r["id"].as_str() == Some(ref_id.as_str())) else {
                return Json(serde_json::json!({"ok":false,"error":"proof_export 需要 ref_id = 贡献记录 id"}));
            };
            delivered["proof"] = make_proof(&rec, &st.identity);
        }
        "card_boost" | "help_boost" => {
            if ref_id.is_empty() {
                return Json(serde_json::json!({"ok":false,"error":"需要 ref_id = 卡片 id"}));
            }
            let found = {
                let mut fs = st.forge.lock().await;
                let hit = match fs.inbox.iter_mut().find(|x| x["id"].as_str() == Some(ref_id.as_str())) {
                    Some(it) => {
                        let cur = it["score"].as_f64().unwrap_or(0.0);
                        it["score"] = serde_json::json!(cur + 2.0);
                        Some(it["card"].clone())
                    }
                    None => None,
                };
                if hit.is_some() { fs.save(&crate::server::data_dir()); }
                hit
            };
            let Some(card) = found else {
                return Json(serde_json::json!({"ok":false,"error":"没有这张卡片"}));
            };
            delivered["score_bonus"] = serde_json::json!(2.0);
            if service == "help_boost" && card.is_object() {
                delivered["redelivery"] = crate::native::world_cards_share(State(st.clone()), Json(card)).await.0["delivery"].clone();
            }
        }
        _ => {}
    }
    append_spend(&serde_json::json!({"kind":"spend","service":service,"points":price,
        "ref_id":ref_id,"at_ms":now_ms()}));
    Json(serde_json::json!({"ok":true,"service":service,"price":price,
        "before":before,"balance":balance_state().3,"delivered":delivered,
        "note":"积分只在购买增值服务时消耗；earned 累计不减"}))
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
    // 服务类不允许自报: 必须由验链/交付回执自动记, 防止刷大分
    if !is_self_reportable(&kind) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "为别人提供服务的积分由真实交付回执自动记，不能自报",
            "self_reportable": ["skill_share", "card_share", "contribution_card"],
        }));
    }
    let ref_id = req["ref_id"].as_str().unwrap_or_default().to_string();
    let key = if ref_id.is_empty() { summary.chars().take(40).collect::<String>() } else { ref_id.clone() };
    let points = award(&st, &kind, &summary, &key, "self_report");
    Json(serde_json::json!({
        "ok": points > 0.0, "kind": kind, "points": points,
        "balance": balance_state().3, "records": load().len(),
        "note": if points > 0.0 { "日常共享记一小笔；重复分享同一内容不重复加分" }
                else { "这条已记过，不重复加分" }
    }))
}


/// GET /api/contribution/ledger → 贡献记录与声誉分
pub async fn ledger() -> Json<serde_json::Value> {
    let all = load();
    Json(serde_json::json!({
        "ok": true,
        "records": all.iter().rev().take(50).cloned().collect::<Vec<_>>(),
        "count": all.len(),
        "credit": balance_state().3,
        "earned": balance_state().0, "spent": balance_state().1,
        "balance": balance_state().3,
        "policy": {
            "kind": "reputation_not_currency",
            "transferable": false, "redeemable": false, "purchasable": false,
            "monotonic_earned": true, "spend_only_on_value_added_services": true,
            "help_requires_credit": false,
            "note": "累计贡献只增不减(做坏事才有惩罚); 唯一消耗是购买增值服务; 求助与合作默认不需要金钱"
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
    let credit = balance_state().3;
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

    fn rec(kind: &str, n: u64) -> serde_json::Value {
        serde_json::json!({ "id": n, "at_ms": n, "kind": kind,
            "summary": "贡献", "content_hash": format!("h{n}") })
    }

    #[test]
    fn service_is_big_and_sharing_is_small() {
        assert_eq!(points_for("service_paid"), 5.0);
        assert_eq!(points_for("skill_share"), 0.5);
        assert_eq!(points_for("card_share"), 0.3);
        assert!(points_for("service_paid") > points_for("skill_share"));
        assert!(!is_self_reportable("service_paid"), "服务大分不能自报");
        assert!(!is_self_reportable("service_delivered"));
        assert!(is_self_reportable("skill_share"));
        assert!(is_self_reportable("card_share"));
    }

    #[test]
    fn earned_only_increases_and_ignores_metadata_events() {
        assert_eq!(credit_of(&[]), 0.0);
        let a = vec![rec("service_paid", 1), rec("skill_share", 2), rec("card_share", 3)];
        assert!((credit_of(&a) - 5.8).abs() < 1e-9);
        let mut b = a.clone();
        b.push(serde_json::json!({ "kind": "anchor", "at_ms": 4, "anchors": [] }));
        b.push(serde_json::json!({ "kind": "penalty", "at_ms": 5, "points": 1 }));
        assert!((credit_of(&b) - 5.8).abs() < 1e-9, "元数据不许虚增积分");
        b.push(rec("service_delivered", 6));
        assert!((credit_of(&b) - 10.8).abs() < 1e-9, "新服务只增不减");
    }

    #[test]
    fn service_catalog_is_priced() {
        assert_eq!(SERVICES.len(), 3);
        assert!(SERVICES.iter().all(|(_, _, p)| *p > 0));
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
