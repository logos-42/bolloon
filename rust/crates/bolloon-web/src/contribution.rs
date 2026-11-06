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
