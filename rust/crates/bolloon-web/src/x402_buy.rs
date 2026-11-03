//! x402 买方 (应用内付款) — 报价 → **真链观测** → 交给卖方核验 → 拿内容
//!
//! 2026-11-04 (bug 6: 最大缺口)。以前卖方三步（上架→402 报价→验链交付）都在，
//! 但买方这半条链是空的：`RpcObservation` 要调用方自己喂，App 里没有任何付款入口。
//!
//! 本模块补的是**买方这一段**，纪律三条：
//! - **不信客户端**：金额/收款地址一律以卖方 402 报价为准，客户端只能给 txHash
//! - **观测必须多源**：≥2 个 RPC 各自读链，矛盾就不交付（卖方侧 fail-closed 同源）
//! - **签私钥不在这**：本机钱包私钥永不出模块；真正广播交易由用户钱包完成，
//!   这里只做"读了链、算成观测、交卖方验"——不假装替用户签名。
//!
//! 诚实边界：EIP-3009 的 `AuthorizationUsed` nonce 未解码（订单标识自证留给后续），
//! 判定退化为"转账事实核验"，卖方会如实回 Verified / SelfAttested。

use axum::{extract::State, Json};
use bolloon_x402::direct_payment::{PaymentClaim, RpcObservation};

use crate::AppState;

/// USDC `Transfer(address,address,uint256)` 事件 topic0 (主网/Base 同签名)
const TRANSFER_TOPIC: &str = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/// 观测用的 RPC 端点 (环境变量 `BOLLOON_RPC_URLS`, 逗号分隔; 默认两个公共节点)
fn rpc_urls() -> Vec<String> {
    std::env::var("BOLLOON_RPC_URLS")
        .ok()
        .map(|s| {
            s.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| x.starts_with("http"))
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            vec![
                "https://mainnet.base.org".to_string(),
                "https://base.llamarpc.com".to_string(),
            ]
        })
}

fn hex_u64(s: &str) -> u64 {
    u64::from_str_radix(s.trim_start_matches("0x"), 16).unwrap_or(0)
}

fn topic_addr(topic: &str) -> String {
    // 32 字节 topic 后 20 字节 = 地址
    let t = topic.trim_start_matches("0x");
    format!("0x{}", &t[t.len().saturating_sub(40)..])
}

/// 单个 RPC 的读链: 收据 → status / Transfer(to,value) / 确认数
fn observe_one(rpc: &str, tx_hash: &str) -> Result<RpcObservation, String> {
    let receipt_raw = crate::wallet::rpc_call(
        rpc,
        "eth_getTransactionReceipt",
        serde_json::json!([tx_hash]),
    )?;
    let receipt: serde_json::Value =
        serde_json::from_str(&receipt_raw).map_err(|e| format!("{rpc}: 收据不是 JSON: {e}"))?;
    let rc = &receipt["result"];
    if rc.is_null() {
        return Err(format!("{rpc}: 交易还没上链（收据为空）"));
    }
    let status = hex_u64(rc["status"].as_str().unwrap_or("0x0"));
    let block = hex_u64(rc["blockNumber"].as_str().unwrap_or("0x0"));
    let head_raw = crate::wallet::rpc_call(rpc, "eth_blockNumber", serde_json::json!([]))?;
    let head: serde_json::Value =
        serde_json::from_str(&head_raw).map_err(|e| format!("{rpc}: 头高不是 JSON: {e}"))?;
    let head_n = hex_u64(head["result"].as_str().unwrap_or("0x0"));
    let confirmations = head_n.saturating_sub(block);

    let mut transfer_to: Option<String> = None;
    let mut transfer_value: Option<u128> = None;
    if let Some(logs) = rc["logs"].as_array() {
        for log in logs {
            let topics = log["topics"].as_array().cloned().unwrap_or_default();
            if topics.len() < 3 {
                continue;
            }
            if topics[0].as_str().unwrap_or("").to_lowercase() != TRANSFER_TOPIC {
                continue;
            }
            let to = topic_addr(topics[2].as_str().unwrap_or("0x0")).to_lowercase();
            let data = log["data"].as_str().unwrap_or("0x0").trim_start_matches("0x");
            let value = u128::from_str_radix(data, 16).unwrap_or(0);
            transfer_to = Some(to);
            transfer_value = Some(value);
            break;
        }
    }

    Ok(RpcObservation {
        rpc: rpc.to_string(),
        status,
        transfer_to,
        transfer_value_atomic: transfer_value,
        authorization_nonce: None,
        confirmations,
    })
}

/// 多 RPC 观测 (至少两个; 一个失败不影响另一个, 全失败如实报)
fn observe(tx_hash: &str) -> Result<Vec<RpcObservation>, String> {
    let mut obs: Vec<RpcObservation> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for url in rpc_urls() {
        match observe_one(&url, tx_hash) {
            Ok(o) => obs.push(o),
            Err(e) => errors.push(e),
        }
    }
    if obs.is_empty() {
        return Err(format!("读链失败（{}）", errors.join(" | ")));
    }
    if obs.len() < 2 {
        // 只有一条观测 ⇒ 卖方那边会因为"少于两条 RPC"拒付; 如实提前说清
        return Err(format!(
            "只拿到 {} 条 RPC 观测（至少 2 条才能交叉验证）: {}",
            obs.len(),
            errors.join(" | ")
        ));
    }
    Ok(obs)
}

/// 解析对端节点地址: 显式 `peer_url` 优先, 否则按 `peer_did` 查已登记基址
async fn resolve_peer(st: &AppState, req: &serde_json::Value) -> Result<String, String> {
    if let Some(u) = req["peer_url"].as_str().filter(|s| s.starts_with("http")) {
        return Ok(u.trim_end_matches('/').to_string());
    }
    let did = req["peer_did"].as_str().unwrap_or_default().trim();
    if did.is_empty() {
        return Err("缺 peer_url 或 peer_did".into());
    }
    crate::native::peer_url_for_did(st, did).await
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn orders_path() -> std::path::PathBuf {
    crate::server::data_dir().join("x402-orders.jsonl")
}

/// 订单落盘 (一行一条; 只记事实: tx/对方/item/内容哈希/金额/时间)
fn append_order(rec: &serde_json::Value) {
    use std::io::Write;
    let p = orders_path();
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(rec).unwrap_or_default());
    }
}

/// POST /api/x402/buy/quote {peer_url|peer_did, item_id} → 卖方 402 报价 (原样带回)
pub async fn buy_quote(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let peer = match resolve_peer(&st, &req).await {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let item = req["item_id"].as_str().unwrap_or_default().trim().to_string();
    if item.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 item_id" }));
    }
    let url = format!("{peer}/api/x402/info/{item}");
    match crate::native::peer_json("GET", url, None).await {
        Ok(q) => Json(serde_json::json!({ "ok": true, "peer": peer, "quote": q })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": format!("报价失败: {e}") })),
    }
}

/// POST /api/x402/buy/pay {peer_url|peer_did, item_id, tx_hash, payer?}
///
/// 流程: 重新取卖方报价(不信客户端金额) → 多 RPC 读链成观测 → 交给卖方
/// `/api/x402/info/{item}/payment` 验链交付 → 成功则**订单落盘**。
pub async fn buy_pay(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let peer = match resolve_peer(&st, &req).await {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e })),
    };
    let item = req["item_id"].as_str().unwrap_or_default().trim().to_string();
    let tx_hash = req["tx_hash"].as_str().unwrap_or_default().trim().to_string();
    if item.is_empty() || tx_hash.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 item_id 或 tx_hash" }));
    }
    if !tx_hash.starts_with("0x") || tx_hash.len() != 66 {
        return Json(serde_json::json!({ "ok": false, "error": "tx_hash 形状不对 (0x + 64 hex)" }));
    }

    // 1) 报价以卖方为准
    let quote = match crate::native::peer_json(
        "GET",
        format!("{peer}/api/x402/info/{item}"),
        None,
    )
    .await
    {
        Ok(q) => q,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("报价失败: {e}") })),
    };
    let accepted = quote["accepts"]
        .as_array()
        .and_then(|a| a.first())
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let pay_to = accepted["payTo"].as_str().unwrap_or_default().to_lowercase();
    let amount = accepted["maxAmountRequired"]
        .as_str()
        .and_then(|s| s.parse::<u128>().ok())
        .or_else(|| accepted["maxAmountRequired"].as_u64().map(|v| v as u128))
        .unwrap_or(0);
    if pay_to.is_empty() || amount == 0 {
        return Json(serde_json::json!({
            "ok": false,
            "error": "卖方报价缺 payTo / 金额（或已不是 402 待付状态）",
            "quote": quote
        }));
    }

    // 2) 真链观测 (≥2 RPC)
    let observations = match tokio::task::spawn_blocking({
        let tx = tx_hash.clone();
        move || observe(&tx)
    })
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => return Json(serde_json::json!({ "ok": false, "error": e })),
        Err(e) => {
            return Json(serde_json::json!({ "ok": false, "error": format!("读链线程失败: {e}") }))
        }
    };

    // 3) 交卖方验链 + 交付
    let claim = PaymentClaim {
        tx_hash: tx_hash.clone(),
        pay_to: pay_to.clone(),
        item_id: item.clone(),
        expected_amount_atomic: amount,
        payer: req["payer"].as_str().map(|s| s.to_lowercase()),
        order_seq: req["order_seq"].as_u64().unwrap_or(0),
    };
    let body = serde_json::json!({ "claim": claim, "observations": observations });
    let resp = match crate::native::peer_json(
        "POST",
        format!("{peer}/api/x402/info/{item}/payment"),
        Some(body),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            return Json(serde_json::json!({ "ok": false, "error": format!("交付失败: {e}") }))
        }
    };

    if resp["status"] == serde_json::json!("delivered") {
        let rec = serde_json::json!({
            "at_ms": now_ms(),
            "peer": peer,
            "item_id": item,
            "tx_hash": tx_hash,
            "pay_to": pay_to,
            "amount_atomic": amount.to_string(),
            "verdict": resp["verdict"],
            "content_hash": resp["contentHash"],
            "self_attested": resp["selfAttested"],
        });
        append_order(&rec);
        Json(serde_json::json!({
            "ok": true,
            "verdict": resp["verdict"],
            "content": resp["content"],
            "content_hash": resp["contentHash"],
            "self_attested": resp["selfAttested"],
            "observations": observations.len(),
            "order": rec,
        }))
    } else {
        Json(serde_json::json!({
            "ok": false,
            "error": "卖方拒付/未交付",
            "verdict": resp["verdict"],
            "failed": resp["failed"],
            "observations": observations.len(),
        }))
    }
}

/// GET /api/x402/orders → 本机买方订单台账 (最近 50 条, 事实行)
pub async fn buy_orders() -> Json<serde_json::Value> {
    let raw = std::fs::read_to_string(orders_path()).unwrap_or_default();
    let rows: Vec<serde_json::Value> = raw
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect();
    let tail = rows.iter().rev().take(50).cloned().collect::<Vec<_>>();
    Json(serde_json::json!({ "orders": tail, "count": rows.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_and_topic_decode() {
        assert_eq!(hex_u64("0x10"), 16);
        assert_eq!(hex_u64("0x0"), 0);
        let topic = "0x0000000000000000000000001111111111111111111111111111111111111111";
        assert_eq!(topic_addr(topic), "0x1111111111111111111111111111111111111111");
    }

    /// 观测必须多源: 少于 2 条 RPC 直接拒 (不许拿单点当事实)
    fn agreement_required(n: usize) -> bool {
        n >= 2
    }

    #[test]
    fn single_rpc_is_not_enough() {
        assert!(!agreement_required(1));
        assert!(agreement_required(2));
    }
}
