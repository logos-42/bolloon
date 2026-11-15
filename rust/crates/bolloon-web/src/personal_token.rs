//! **个人代币发行**（2026-11-15）。
//!
//! 每个个人用户可以在 bolloon 里发行自己的代币，**绑定 DID 身份**；发币前要求
//! `crate::verify::is_verified(did)` 为真（未通过真人验证不许发币）。
//!
//! 设计口径（诚实）：
//! - 代币是 DID 名下的一份**签名记录**（Ed25519 对 canonical 记录签名），用于自证"这就是我的币"；
//! - 不声称链上 ERC-20 部署 —— 本模块只做「个人代币登记 + 归属签名 + 真人门」；
//!   要上链需另走钱包/合约（`agent_wallet` 生成 EVM 地址可作接收地址）。
//! - 存储 `~/.bolloon/rust/tokens/tokens.json`（0600）。

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
    /// 发行者 DID（绑定身份）
    pub did: String,
    pub name: String,
    pub symbol: String,
    pub decimals: u32,
    /// 初始供应量（按最小单位计；展示时除以 10^decimals）
    pub supply: u64,
    #[serde(default)]
    pub description: String,
    pub created_at_ms: u64,
    /// 发币时发行者已通过真人验证（快照，便于审计）
    #[serde(default)]
    pub issuer_verified: bool,
    /// 发行者对 canonical 记录的 Ed25519 签名（hex）
    pub owner_sig: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TokenFile {
    #[serde(default)]
    pub tokens: Vec<TokenRec>,
}

fn path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("tokens.json")
}

fn load() -> TokenFile {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|t| serde_json::from_str::<TokenFile>(&t).ok())
        .unwrap_or_default()
}

fn save(f: &TokenFile) -> Result<(), String> {
    let p = path();
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

/// 被签名的 canonical 记录（键字母序，两侧重算一致）
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

/// GET /api/tokens → 自己名下代币 + 验证状态
pub async fn list(State(st): State<AppState>) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    let tokens: Vec<TokenRec> = load()
        .tokens
        .into_iter()
        .filter(|t| t.did == did)
        .collect();
    Json(serde_json::json!({
        "ok": true,
        "did": did,
        "verified": crate::verify::is_verified(&did),
        "tokens": tokens,
    }))
}

/// POST /api/tokens/issue { name, symbol, decimals, supply, description }
///
/// 门：`verify::is_verified(did)` 为假 ⇒ 拒绝（`need_verify: true`）。
pub async fn issue(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();

    // ── 真人验证门（未验证不许发币）──
    if !crate::verify::is_verified(&did) {
        return Json(serde_json::json!({
            "ok": false,
            "need_verify": true,
            "error": "未通过 DID 真人验证，不能发行代币。请先完成真人验证。",
        }));
    }

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

    // ── 校验 ──
    if name.is_empty() || name.chars().count() > 32 {
        return err("名称必填且不超过 32 字");
    }
    if symbol.len() < 2 || symbol.len() > 8 || !symbol.chars().all(|c| c.is_ascii_alphanumeric()) {
        return err("符号需为 2-8 位字母或数字");
    }
    if supply == 0 {
        return err("初始供应量必须大于 0");
    }

    let mut f = load();
    if f.tokens.iter().any(|t| t.did == did && t.symbol == symbol) {
        return err("你的 DID 已使用同一符号发行过代币");
    }

    let now = now_ms();
    let id = format!("tok-{}-{}", symbol, now);
    let mut rec = TokenRec {
        id,
        did: did.clone(),
        name,
        symbol,
        decimals,
        supply,
        description,
        created_at_ms: now,
        issuer_verified: true,
        owner_sig: String::new(),
    };
    let sig = st.identity.sign(canonical(&rec).as_bytes());
    rec.owner_sig = hex::encode(sig);

    f.tokens.push(rec.clone());
    if let Err(e) = save(&f) {
        return err(&format!("写入失败: {e}"));
    }
    Json(serde_json::json!({
        "ok": true,
        "token": rec,
        "note": "已登记你的个人代币（DID 名下的签名记录）。要上链请再走钱包/合约部署。",
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
        }
    }

    #[test]
    fn canonical_is_deterministic_and_stable() {
        let a = canonical(&rec());
        let b = canonical(&rec());
        assert_eq!(a, b, "同一记录 canonical 必须稳定");
        assert!(a.contains("\"protocol\":\"bolloon-personal-token/1\""));
        assert!(a.contains("\"did\":\"did:pi:alice\""));
    }
}
