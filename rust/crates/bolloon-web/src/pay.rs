//! 充值 / 按量扣费账本 — 「先充值，再按量扣」的最小真实实现。
//!
//! 设计口径 (2026-10-30 与 leo 定):
//! - **不发币**: 只收 USDC/ETH 到地址 + 支持支付宝/微信/PayPal, 人工核销; 账本只记额度。
//! - **按量计费**: 余额以 micro-USD (1e6 = 1 美元) 为整数单位累计, 每次模型调用按其 token 扣减。
//! - **不谎报**: 未确认的充值只进「待核销」, **不计入余额**; 余额不够就拒绝执行, 绝不静默欠费。
//! - **人工核销**: 支付宝/微信/加密转账都可能延迟到账 ⇒ 用户提交凭证 (tx 哈希/截图说明) 进 pending,
//!   本机 (收款人本人) 核对到账后 `confirm` 才记入余额。confirm 是本机动作, 没有远端接口。
//!
//! 落盘: `<data_dir>/pay/ledger.jsonl`, 一行一条事件 (append-only, 坏行跳过不猜)。
//! 事件类型: `topup_pending` (等核销) / `topup_confirmed` (钱到账) / `charge` (按量扣费) / `grant` (赠送)。

use std::path::PathBuf;

use axum::{extract::State, Json};

use crate::AppState;

/// 1 美元 = 1_000_000 micro-USD
pub const MICRO: i64 = 1_000_000;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PayEvent {
    pub id: String,
    /// topup_pending | topup_confirmed | charge | grant
    pub kind: String,
    /// 正数入账, 负数扣费 (micro-USD)
    pub amount_micro: i64,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub proof: String,
    #[serde(default)]
    pub note: String,
    pub ts_ms: u64,
    /// 针对哪条 pending 的确认 (kind=topup_confirmed 时)
    #[serde(default)]
    pub ref_id: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pay_dir(st: &AppState) -> PathBuf {
    // 与 web 其它本地状态同源 (data_dir 由 BOLLOON_HOME 决定)
    crate::server::data_dir().join("pay")
}

fn ledger_path(st: &AppState) -> PathBuf {
    let d = pay_dir(st);
    let _ = std::fs::create_dir_all(&d);
    let _ = st;
    d.join("ledger.jsonl")
}

/// 读账本 (坏行跳过, 不猜)
pub fn read_events(path: &std::path::Path) -> Vec<PayEvent> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<PayEvent>(l).ok())
        .collect()
}

fn append(path: &std::path::Path, ev: &PayEvent) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    writeln!(f, "{}", serde_json::to_string(ev).unwrap_or_default())
}

/// 账本汇总: (余额, 待核销合计, 已扣费合计, 已充值合计)
pub fn summarize(events: &[PayEvent]) -> (i64, i64, i64, i64) {
    let mut balance = 0i64;
    let mut pending = 0i64;
    let mut charged = 0i64;
    let mut topped = 0i64;
    let mut confirmed_refs: Vec<String> = vec![];
    for e in events {
        if e.kind == "topup_confirmed" && !e.ref_id.is_empty() {
            confirmed_refs.push(e.ref_id.clone());
        }
    }
    for e in events {
        match e.kind.as_str() {
            "topup_confirmed" => {
                balance += e.amount_micro;
                topped += e.amount_micro;
            }
            "charge" => {
                balance += e.amount_micro; // 负数
                charged += -e.amount_micro;
            }
            "grant" => {
                balance += e.amount_micro;
                topped += e.amount_micro;
            }
            "topup_pending" => {
                // 已被 confirm 的那条不再算 pending
                if !confirmed_refs.iter().any(|r| r == &e.id) {
                    pending += e.amount_micro;
                }
            }
            _ => {}
        }
    }
    (balance, pending, charged, topped)
}

/// 付费配置: 收款地址 + 通道 + 单价
fn config() -> serde_json::Value {
    // 允许用配置文件覆盖 (不放 git; 收款信息属于本机私事)
    let path = crate::server::data_dir().join("pay").join("config.json");
    if let Ok(t) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) {
            return v;
        }
    }
    serde_json::json!({
        "currency": "USD",
        "crypto": {
            "chain": "base",
            "address": std::env::var("BOLLOON_PAY_USDC_ADDRESS").unwrap_or_default(),
            "asset": "USDC",
            "note": "默认通道: 转到该地址后, 把交易哈希填进来, 本机确认到账后计入余额"
        },
        "alipay": { "qr": "", "note": "支付宝个人收款: 扫码转账后填交易号, 由收款人本人核对后手动确认" },
        "wechat": { "qr": "", "note": "微信个人收款: 同上" },
        "paypal": { "link": "", "note": "PayPal.Me 个人收款链接; 到账后填交易号" },
        // 只卖两款 (2026-10-30 用户定): DeepSeek V4.1 Flash / V4 Pro —— 都从本人的私有 key 扣。
        // 单价是 micro-USD / 1K tokens (1e6 = 1 美元), 按档位乘数再打折。
        "models": [
            { "id": "deepseek-flash",  "label": "DeepSeek V4.1 Flash", "per_1k_in": 140,  "per_1k_out": 560 },
            { "id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro",     "per_1k_in": 560,  "per_1k_out": 2240 }
        ],
        // 用户等级: multiplier 是折扣乘数 (1.0 原价 / 0.7 打七折 / 0 免费)
        "tiers": [
            { "id": "free",    "label": "免费 (仅本地/自带 key)", "multiplier": 0.0 },
            { "id": "standard","label": "标准",                  "multiplier": 1.0 },
            { "id": "friend",  "label": "朋友",                  "multiplier": 0.7 },
            { "id": "sponsor", "label": "赞助者",                "multiplier": 0.5 },
            { "id": "owner",   "label": "本人",                  "multiplier": 0.0 }
        ],
        // 特定用户覆盖 (did → tier / 每日次数上限) —— 只有本机能改
        "users": {},
        "min_topup_usd": 1,
        "free_trial_usd": 0
    })
}

/// GET /api/pay/info → 收款信息 + 余额 + 待核销 + 已用 + 单价表
pub async fn pay_info(State(st): State<AppState>) -> Json<serde_json::Value> {
    let path = ledger_path(&st);
    let events = read_events(&path);
    let (balance, pending, charged, topped) = summarize(&events);
    let (balance, pending, charged, topped) = (
        balance as f64 / MICRO as f64,
        pending as f64 / MICRO as f64,
        charged as f64 / MICRO as f64,
        topped as f64 / MICRO as f64,
    );
    Json(serde_json::json!({
        "ok": true,
        "config": config(),
        "balance_usd": balance,
        "pending_usd": pending,
        "charged_usd": charged,
        "topped_up_usd": topped,
        "events": events.iter().rev().take(20).collect::<Vec<_>>(),
    }))
}

/// POST /api/pay/claim {amount_usd, channel, proof} → 生成一条待核销记录 (不计入余额)
pub async fn pay_claim(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let amount_usd = req["amount_usd"].as_f64().unwrap_or(0.0);
    if !(0.01..=100_000.0).contains(&amount_usd) {
        return Json(serde_json::json!({ "error": "金额不合理 (0.01–100000 美元)" }));
    }
    let channel = req["channel"].as_str().unwrap_or("").trim().to_string();
    if !["crypto", "alipay", "wechat", "paypal"].contains(&channel.as_str()) {
        return Json(serde_json::json!({
            "error": "通道必须是 crypto | alipay | wechat | paypal"
        }));
    }
    let proof = req["proof"].as_str().unwrap_or("").trim().to_string();
    if proof.len() < 4 {
        return Json(serde_json::json!({
            "error": "请填凭证: 加密转账填交易哈希, 支付宝/微信/PayPal 填交易号或备注"
        }));
    }
    let ev = PayEvent {
        id: format!("topup-{}", now_ms()),
        kind: "topup_pending".into(),
        amount_micro: (amount_usd * MICRO as f64).round() as i64,
        channel,
        proof,
        note: req["note"].as_str().unwrap_or("").to_string(),
        ts_ms: now_ms(),
        ref_id: String::new(),
    };
    let path = ledger_path(&st);
    if let Err(e) = append(&path, &ev) {
        return Json(serde_json::json!({ "error": e.to_string() }));
    }
    Json(serde_json::json!({
        "ok": true,
        "pending": ev,
        "note": "已登记待核销 —— 核对到账后在本机「确认到账」才计入余额 (不自动加钱)",
    }))
}

/// POST /api/pay/confirm {id} → 收款人本人核对到账后确认 (真正的入账)
pub async fn pay_confirm(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({ "error": "缺待核销记录 id" }));
    }
    let path = ledger_path(&st);
    let events = read_events(&path);
    let Some(target) = events
        .iter()
        .find(|e| e.id == id && e.kind == "topup_pending")
        .cloned()
    else {
        return Json(serde_json::json!({ "error": "没有这条待核销记录 (或已确认过)" }));
    };
    if events
        .iter()
        .any(|e| e.kind == "topup_confirmed" && e.ref_id == id)
    {
        return Json(serde_json::json!({ "error": "这条已经确认过了 (重复确认会重复加钱, 已拒)" }));
    }
    let ev = PayEvent {
        id: format!("confirm-{}", now_ms()),
        kind: "topup_confirmed".into(),
        amount_micro: target.amount_micro,
        channel: target.channel.clone(),
        proof: target.proof.clone(),
        note: format!("人工核销: {}", req["note"].as_str().unwrap_or("")),
        ts_ms: now_ms(),
        ref_id: target.id.clone(),
    };
    if let Err(e) = append(&path, &ev) {
        return Json(serde_json::json!({ "error": e.to_string() }));
    }
    let events = read_events(&path);
    let (balance, pending, _, _) = summarize(&events);
    Json(serde_json::json!({
        "ok": true,
        "confirmed": ev,
        "balance_usd": balance as f64 / MICRO as f64,
        "pending_usd": pending as f64 / MICRO as f64,
    }))
}

/// 扣费 (按量): 余额不足返回 false, 调用方必须据此拒绝执行 (fail-closed)
pub fn charge(st: &AppState, micro_usd: i64, note: &str) -> Result<i64, String> {
    if micro_usd <= 0 {
        return Ok(0);
    }
    let path = ledger_path(st);
    let events = read_events(&path);
    let (balance, _, _, _) = summarize(&events);
    if balance < micro_usd {
        return Err(format!(
            "余额不足: 需要 {} 美元, 当前 {} 美元",
            micro_usd as f64 / MICRO as f64,
            balance as f64 / MICRO as f64
        ));
    }
    let ev = PayEvent {
        id: format!("charge-{}", now_ms()),
        kind: "charge".into(),
        amount_micro: -micro_usd,
        channel: String::new(),
        proof: String::new(),
        note: note.to_string(),
        ts_ms: now_ms(),
        ref_id: String::new(),
    };
    append(&path, &ev).map_err(|e| e.to_string())?;
    Ok(balance - micro_usd)
}

/// 取本机用户档案 (did → {tier, quota_calls_per_day, note})
fn user_entry(cfg: &serde_json::Value, did: &str) -> serde_json::Value {
    cfg.get("users")
        .and_then(|u| u.get(did))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "tier": "standard" }))
}

fn tier_multiplier(cfg: &serde_json::Value, tier: &str) -> f64 {
    cfg.get("tiers")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.iter().find(|x| x["id"] == tier))
        .and_then(|x| x["multiplier"].as_f64())
        .unwrap_or(1.0)
}

fn model_price(cfg: &serde_json::Value, model: &str) -> Option<(i64, i64)> {
    cfg.get("models")?
        .as_array()?
        .iter()
        .find(|m| m["id"] == model)
        .map(|m| {
            (
                m["per_1k_in"].as_i64().unwrap_or(0),
                m["per_1k_out"].as_i64().unwrap_or(0),
            )
        })
}

/// 一次调用该扣多少 micro-USD: 单价 × token/1000 × 用户等级乘数, 向上取整到 1 micro-USD。
/// **不认识的模型就报错**, 不按 0 处理 (否则漏算 = 免费送)。
pub fn price_for(
    cfg: &serde_json::Value,
    did: &str,
    model: &str,
    tokens_in: u64,
    tokens_out: u64,
) -> Result<i64, String> {
    let (pin, pout) = model_price(cfg, model).ok_or_else(|| format!("未配置的模型: {model}"))?;
    let tier = user_entry(cfg, did)["tier"].as_str().unwrap_or("standard").to_string();
    let mult = tier_multiplier(cfg, &tier);
    if mult <= 0.0 {
        return Ok(0);
    }
    let raw = (tokens_in as f64 / 1000.0) * pin as f64 + (tokens_out as f64 / 1000.0) * pout as f64;
    Ok((raw * mult).ceil() as i64)
}

/// 按模型 + 用户等级扣费 (余额不足返回 Err; 0 元只落用量事件, 不动余额)
pub fn charge_model(
    st: &AppState,
    did: &str,
    model: &str,
    tokens_in: u64,
    tokens_out: u64,
) -> Result<i64, String> {
    let cfg = config();
    let micro = price_for(&cfg, did, model, tokens_in, tokens_out)?;
    let note = format!(
        "model={model} in={tokens_in} out={tokens_out} did={}",
        if did.is_empty() { "local" } else { did }
    );
    if micro == 0 {
        // 免费额度 (本人/朋友 0 价): 只记用量, 不扣钱 —— 但事件要留痕, 否则统计里查不到
        let path = ledger_path(st);
        let ev = PayEvent {
            id: format!("usage-{}", now_ms()),
            kind: "usage".into(),
            amount_micro: 0,
            channel: String::new(),
            proof: String::new(),
            note,
            ts_ms: now_ms(),
            ref_id: String::new(),
        };
        append(&path, &ev).map_err(|e| e.to_string())?;
        let events = read_events(&path);
        return Ok(summarize(&events).0);
    }
    charge(st, micro, &note)
}

/// GET /api/pay/pricing → 两款模型单价 + 等级 + 用户覆盖 (给官网/控制台展示用)
pub async fn pay_pricing() -> Json<serde_json::Value> {
    let cfg = config();
    Json(serde_json::json!({
        "ok": true,
        "models": cfg.get("models").cloned().unwrap_or(serde_json::json!([])),
        "tiers": cfg.get("tiers").cloned().unwrap_or(serde_json::json!([])),
        "users": cfg.get("users").cloned().unwrap_or(serde_json::json!({})),
        "note": "单价单位: micro-USD / 1K tokens (1e6 = 1 美元); 实际扣费 = 单价 × token/1000 × 等级乘数",
    }))
}

/// POST /api/pay/user {did, tier, quota_calls_per_day?, note?} → 给特定用户定等级/配额
/// 只在本机写 config.json (收款/定价属于本人私事, 不开远端接口)。
pub async fn pay_set_user(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let did = req["did"].as_str().unwrap_or("").trim().to_string();
    let tier = req["tier"].as_str().unwrap_or("").trim().to_string();
    if did.is_empty() {
        return Json(serde_json::json!({ "error": "缺 did" }));
    }
    let mut cfg = config();
    let known = cfg["tiers"]
        .as_array()
        .map(|a| a.iter().any(|t| t["id"] == tier.as_str()))
        .unwrap_or(false);
    if !known {
        return Json(serde_json::json!({
            "error": format!("未知等级 {tier} (可选: free / standard / friend / sponsor / owner)")
        }));
    }
    if cfg.get("users").is_none() {
        cfg["users"] = serde_json::json!({});
    }
    cfg["users"][&did] = serde_json::json!({
        "tier": tier,
        "quota_calls_per_day": req["quota_calls_per_day"].as_u64().unwrap_or(0),
        "note": req["note"].as_str().unwrap_or(""),
    });
    let dir = crate::server::data_dir().join("pay");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("config.json");
    if let Err(e) = std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap_or_default()) {
        return Json(serde_json::json!({ "error": e.to_string() }));
    }
    Json(serde_json::json!({ "ok": true, "users": cfg["users"].clone(), "config_path": path }) )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: &str, kind: &str, amount: i64, ref_id: &str) -> PayEvent {
        PayEvent {
            id: id.into(),
            kind: kind.into(),
            amount_micro: amount,
            channel: "crypto".into(),
            proof: "0xabc".into(),
            note: String::new(),
            ts_ms: 0,
            ref_id: ref_id.into(),
        }
    }


    fn cfg_with_users() -> serde_json::Value {
        serde_json::json!({
            "models": [
                { "id": "deepseek-flash", "per_1k_in": 140, "per_1k_out": 560 },
                { "id": "deepseek-v4-pro", "per_1k_in": 560, "per_1k_out": 2240 }
            ],
            "tiers": [
                { "id": "free", "multiplier": 0.0 },
                { "id": "standard", "multiplier": 1.0 },
                { "id": "friend", "multiplier": 0.7 }
            ],
            "users": { "did:pi:friend": { "tier": "friend" }, "did:pi:free": { "tier": "free" } }
        })
    }

    #[test]
    fn price_follows_model_and_tier() {
        let cfg = cfg_with_users();
        // 标准用户 10k in + 2k out on flash: 10*140 + 2*560 = 1400+1120 = 2520 micro (=$0.00252)
        assert_eq!(price_for(&cfg, "did:pi:who", "deepseek-flash", 10_000, 2_000).unwrap(), 2520);
        // 同一用量换 pro: 10*560 + 2*2240 = 5600+4480 = 10080
        assert_eq!(price_for(&cfg, "did:pi:who", "deepseek-v4-pro", 10_000, 2_000).unwrap(), 10080);
        // 朋友 7 折: 2520*0.7 = 1764
        assert_eq!(price_for(&cfg, "did:pi:friend", "deepseek-flash", 10_000, 2_000).unwrap(), 1764);
        // 免费档 = 0 (只记用量, 不扣钱)
        assert_eq!(price_for(&cfg, "did:pi:free", "deepseek-flash", 10_000, 2_000).unwrap(), 0);
    }

    #[test]
    fn unknown_model_is_an_error_not_free() {
        let cfg = cfg_with_users();
        assert!(price_for(&cfg, "did:pi:who", "gpt-9-secret", 1000, 1000).is_err(),
            "未配置的模型必须报错, 不能按 0 处理 (漏算=白送)");
    }

    #[test]
    fn pending_does_not_count_until_confirmed() {
        let events = vec![
            ev("t1", "topup_pending", 5 * MICRO, ""),
            ev("c1", "topup_confirmed", 5 * MICRO, "t1"),
        ];
        let (balance, pending, _, topped) = summarize(&events);
        assert_eq!(balance, 5 * MICRO);
        assert_eq!(pending, 0, "已确认的那条不该再进待核销");
        assert_eq!(topped, 5 * MICRO);
    }

    #[test]
    fn unconfirmed_topup_is_not_balance() {
        let events = vec![ev("t1", "topup_pending", 3 * MICRO, "")];
        let (balance, pending, _, _) = summarize(&events);
        assert_eq!(balance, 0, "没核销就不能算钱");
        assert_eq!(pending, 3 * MICRO);
    }

    #[test]
    fn charge_reduces_balance_and_adds_to_charged() {
        let events = vec![
            ev("g1", "grant", 2 * MICRO, ""),
            ev("ch1", "charge", -(MICRO / 2), ""),
        ];
        let (balance, _, charged, _) = summarize(&events);
        assert_eq!(balance, 2 * MICRO - MICRO / 2);
        assert_eq!(charged, MICRO / 2);
    }
}
