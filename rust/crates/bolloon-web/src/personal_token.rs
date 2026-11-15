//! **个人代币发行（真实上链）**（2026-11-15）。
//!
//! 每个个人用户可以在 bolloon 里发行自己的代币，**绑定 DID 身份**；发币前要求
//! `crate::verify::is_verified(did)` 为真（未通过真人验证不许发币）。
//!
//! 两步确认（2026-11-15 升级）：
//! - `POST /api/tokens/prepare` → 校验 + 返回**预览**（链 / 发行地址 / 估算 gas 费 / 余额是否够）。
//! - `POST /api/tokens/confirm` → **真实链上部署**：广播一笔合约创建交易（ERC-20 `PersonalToken`），
//!   等回执后把 `contract_address / tx_hash / block_number / chain_id` 写进代币记录。
//!
//! 口径：这是**真实区块链**（Base Sepolia / 可配置），不是本地记账；广播失败/无回执一律如实报错，
//! 绝不伪造 tx_hash 或合约地址。发行者的 EVM 钱包自动生成本机保存（0600），需有原生 gas 才能部署。

use std::path::PathBuf;

use axum::{extract::State, Json};

use crate::AppState;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TokenRec {
    pub id: String,
    pub did: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    /// 初始供应量（**整币**数量，链上 mint 时乘 10^decimals）
    pub supply: u64,
    #[serde(default)]
    pub description: String,
    pub created_at_ms: u64,
    #[serde(default)]
    pub issuer_verified: bool,
    /// 发行者对核心记录（不含链字段）的 Ed25519 签名
    pub owner_sig: String,
    // ── 真实链上部署事实 ──
    #[serde(default)]
    pub contract_address: String,
    #[serde(default)]
    pub tx_hash: String,
    #[serde(default)]
    pub chain_id: u64,
    #[serde(default)]
    pub block_number: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TokenFile {
    #[serde(default)]
    pub tokens: Vec<TokenRec>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersonalWallet {
    address: String,
    secret_hex: String,
    created_at_ms: u64,
}

fn tokens_path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("tokens.json")
}

fn wallet_path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("personal_wallet.json")
}

fn load() -> TokenFile {
    std::fs::read_to_string(tokens_path())
        .ok()
        .and_then(|t| serde_json::from_str::<TokenFile>(&t).ok())
        .unwrap_or_default()
}

fn save(f: &TokenFile) -> Result<(), String> {
    let p = tokens_path();
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    Ok(())
}

fn atomic_write_0600(p: &std::path::Path, body: &str) -> Result<(), String> {
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())?;
    Ok(())
}

/// 取（或首次生成）本 DID 的 EVM 发行钱包。私钥只落本机 0600，永不返回接口。
fn ensure_wallet() -> Result<(String, String), String> {
    if let Ok(t) = std::fs::read_to_string(wallet_path()) {
        if let Ok(w) = serde_json::from_str::<PersonalWallet>(&t) {
            if !w.address.is_empty() && !w.secret_hex.is_empty() {
                return Ok((w.address, w.secret_hex));
            }
        }
    }
    let (address, secret_hex) = crate::agent_wallet::generate_evm()?;
    let body = serde_json::to_string_pretty(&PersonalWallet {
        address: address.clone(),
        secret_hex: secret_hex.clone(),
        created_at_ms: now_ms(),
    })
    .map_err(|e| e.to_string())?;
    atomic_write_0600(&wallet_path(), &body)?;
    Ok((address, secret_hex))
}

fn chain_config() -> (String, u64, String) {
    let rpc = std::env::var("BOLLOON_CHAIN_RPC")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://sepolia.base.org".to_string());
    let cid: u64 = std::env::var("BOLLOON_CHAIN_ID")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(84532);
    let net = match cid {
        84532 => "base-sepolia",
        8453 => "base",
        31337 => "local-dev",
        _ => "custom",
    }
    .to_string();
    (rpc, cid, net)
}

fn build_creation_data(
    name: &str,
    symbol: &str,
    decimals: u32,
    supply_base: u128,
    owner: &str,
) -> Result<Vec<u8>, String> {
    let hexstr = include_str!("../assets/personal_token.hex").trim();
    let bc = hex::decode(hexstr.trim_start_matches("0x"))
        .map_err(|e| format!("合约 bytecode 解码失败: {e}"))?;
    if bc.is_empty() {
        return Err("合约 bytecode 为空（未编译嵌入）".into());
    }
    let args = crate::chain_tx::abi_encode_ctor(name, symbol, decimals as u8, supply_base, owner)?;
    let mut out = bc;
    out.extend_from_slice(&args);
    Ok(out)
}

/// 被签名/校验的 canonical 核心记录（不含链字段）。
fn canonical(t: &TokenRec) -> String {
    serde_json::json!({
        "did": t.did,
        "name": t.name,
        "symbol": t.symbol,
        "decimals": t.decimals,
        "supply": t.supply,
        "created_at_ms": t.created_at_ms,
        "protocol": "bolloon-personal-token/1",
    })
    .to_string()
}

fn err(msg: &str) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": false, "error": msg }))
}

fn need_verify() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": false,
        "need_verify": true,
        "error": "未通过 DID 真人验证，不能发行代币。请先完成真人验证。",
    }))
}

struct Draft {
    name: String,
    symbol: String,
    decimals: u32,
    supply: u64,
    description: String,
}

fn parse_draft(req: &serde_json::Value) -> Result<Draft, String> {
    let name = req.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    let symbol = req
        .get("symbol")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_uppercase();
    let decimals = req.get("decimals").and_then(|v| v.as_u64()).unwrap_or(0).min(18) as u32;
    let supply = req.get("supply").and_then(|v| v.as_u64()).unwrap_or(0);
    let description = req
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(200)
        .collect::<String>();
    if name.is_empty() || name.chars().count() > 32 {
        return Err("名称必填且不超过 32 字".into());
    }
    if symbol.len() < 2 || symbol.len() > 8 || !symbol.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("符号需为 2-8 位字母或数字".into());
    }
    if supply == 0 {
        return Err("初始供应量必须大于 0".into());
    }
    Ok(Draft { name, symbol, decimals, supply, description })
}

fn supply_base(d: &Draft) -> u128 {
    (d.supply as u128).saturating_mul(10u128.saturating_pow(d.decimals))
}

/// GET /api/tokens → 自己名下代币 + 验证状态 + 链配置
pub async fn list(State(st): State<AppState>) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    let tokens: Vec<TokenRec> = load().tokens.into_iter().filter(|t| t.did == did).collect();
    let (rpc, cid, net) = chain_config();
    let wallet = ensure_wallet().map(|(a, _)| a).unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "did": did,
        "verified": crate::verify::is_verified(&did),
        "chain": { "chain_id": cid, "network": net, "rpc": rpc },
        "wallet_address": wallet,
        "tokens": tokens,
    }))
}

/// POST /api/tokens/prepare { name, symbol, decimals, supply, description }
/// → 预览（链 / 发行地址 / 估算 gas / 余额是否足够），**不写盘、不广播**。
pub async fn prepare(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    if !crate::verify::is_verified(&did) {
        return need_verify();
    }
    let d = match parse_draft(&req) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    if load().tokens.iter().any(|t| t.did == did && t.symbol == d.symbol) {
        return err("你的 DID 已使用同一符号发行过代币");
    }
    let (rpc, cid, net) = chain_config();
    let (from, _secret) = match ensure_wallet() {
        Ok(w) => w,
        Err(e) => return err(&e),
    };
    let base = supply_base(&d);
    let creation = match build_creation_data(&d.name, &d.symbol, d.decimals, base, &from) {
        Ok(c) => c,
        Err(e) => return err(&e),
    };
    let gp = crate::chain_tx::gas_price(&rpc).unwrap_or(0);
    let est = crate::chain_tx::estimate_deploy_gas(&rpc, &from, &creation).unwrap_or(300_000);
    let gas_limit = est + 80_000;
    let cost = gp.saturating_mul(gas_limit);
    let bal = crate::chain_tx::native_balance(&rpc, &from).unwrap_or(0);
    Json(serde_json::json!({
        "ok": true,
        "preview": {
            "name": d.name, "symbol": d.symbol, "decimals": d.decimals, "supply": d.supply,
            "supply_base": base.to_string(),
            "chain_id": cid, "network": net, "rpc": rpc, "from": from,
            "gas_price_wei": gp.to_string(), "est_gas": est.to_string(),
            "cost_wei": cost.to_string(), "balance_wei": bal.to_string(),
            "sufficient_native": bal >= cost,
        },
        "note": "确认为真实链上部署：会广播一笔合约创建交易，等回执后写入你的代币",
    }))
}

/// POST /api/tokens/confirm { name, symbol, decimals, supply, description }
/// → **真实部署 ERC-20 合约**并等回执；成功才写盘。
pub async fn confirm(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    if !crate::verify::is_verified(&did) {
        return need_verify();
    }
    let d = match parse_draft(&req) {
        Ok(d) => d,
        Err(e) => return err(&e),
    };
    if load().tokens.iter().any(|t| t.did == did && t.symbol == d.symbol) {
        return err("你的 DID 已使用同一符号发行过代币");
    }
    let (rpc, cid, net) = chain_config();
    let (from, secret) = match ensure_wallet() {
        Ok(w) => w,
        Err(e) => return err(&e),
    };
    let base = supply_base(&d);
    let creation = match build_creation_data(&d.name, &d.symbol, d.decimals, base, &from) {
        Ok(c) => c,
        Err(e) => return err(&e),
    };

    // 真实广播 + 等回执
    let res = match crate::chain_tx::deploy_contract(&rpc, &secret, cid, &creation).await {
        Ok(v) => v,
        Err(e) => {
            return Json(serde_json::json!({ "ok": false, "error": e, "stage": "broadcast_or_receipt" }))
        }
    };
    if !res.get("status_ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "链上部署失败（交易回执 status=0）",
            "tx_hash": res.get("tx_hash").cloned().unwrap_or(serde_json::Value::Null),
        }));
    }
    let contract_address = res.get("contract_address").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if contract_address.is_empty() {
        return err("回执里没有 contractAddress（部署未成功）");
    }

    let now = now_ms();
    let mut rec = TokenRec {
        id: format!("tok-{}-{}", d.symbol, now),
        did: did.clone(),
        name: d.name,
        symbol: d.symbol,
        decimals: d.decimals,
        supply: d.supply,
        description: d.description,
        created_at_ms: now,
        issuer_verified: true,
        owner_sig: String::new(),
        contract_address: contract_address.clone(),
        tx_hash: res.get("tx_hash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        chain_id: cid,
        block_number: res.get("block_number").and_then(|v| v.as_u64()).unwrap_or(0),
    };
    rec.owner_sig = hex::encode(st.identity.sign(canonical(&rec).as_bytes()));

    let mut f = load();
    f.tokens.push(rec.clone());
    if let Err(e) = save(&f) {
        // 部署已成功但本地落盘失败：如实说明（链上币已存在）
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("链上部署已成功，但本地记录写入失败: {e}"),
            "tx_hash": rec.tx_hash, "contract_address": contract_address,
        }));
    }
    Json(serde_json::json!({
        "ok": true,
        "token": rec,
        "chain": {
            "tx_hash": res.get("tx_hash").cloned().unwrap_or(serde_json::Value::Null),
            "contract_address": contract_address,
            "block_number": res.get("block_number").cloned().unwrap_or(serde_json::Value::Null),
            "chain_id": cid,
            "network": net,
        },
        "note": "已真实部署到链上（ERC-20 PersonalToken）；可用区块浏览器按 tx_hash 查证。",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> TokenRec {
        TokenRec {
            id: "tok-X-1".into(),
            did: "did:pi:alice".into(),
            name: "Alice Coin".into(),
            symbol: "ALC".into(),
            decimals: 6,
            supply: 1_000_000,
            description: String::new(),
            created_at_ms: 1,
            issuer_verified: true,
            owner_sig: String::new(),
            contract_address: String::new(),
            tx_hash: String::new(),
            chain_id: 0,
            block_number: 0,
        }
    }

    #[test]
    fn canonical_is_deterministic_and_stable() {
        let a = canonical(&rec());
        let b = canonical(&rec());
        assert_eq!(a, b);
        assert!(a.contains("\"protocol\":\"bolloon-personal-token/1\""));
        assert!(a.contains("\"did\":\"did:pi:alice\""));
    }

    #[test]
    fn supply_base_scales_by_decimals() {
        let d = Draft { name: "x".into(), symbol: "X".into(), decimals: 6, supply: 1000, description: String::new() };
        assert_eq!(supply_base(&d), 1_000_000_000u128);
    }

    #[test]
    fn embedded_bytecode_is_nonempty() {
        let hexstr = include_str!("../assets/personal_token.hex").trim();
        assert!(hexstr.starts_with("0x"));
        assert!(hexstr.len() > 100);
    }
}
