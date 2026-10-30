//! 智能体的钱包 (2026-10-30 用户): 每个智能体一个钱包本 + 本地生成 EVM 钱包。
//!
//! 规则 (用户定):
//! - **绑定已有地址** 上限 20 个 (防一个智能体挂一屋子地址);
//! - **自己创建的钱包** 不限, 但超过 20 建议收敛 (返回 warning 而不是拒绝);
//! - 私钥只落本机文件 (0600), **永不出接口、不回显**; 生成的钱包只回地址。
//!
//! 生成口径: secp256k1 私钥 → 未压缩公钥 (去掉 0x04) → keccak256 → 取后 20 字节 →
//! 小写 `0x…` 地址 (与 EVM 一致)。宁可慢一步, 也不拿 ed25519 冒充 EVM 地址。

use std::path::PathBuf;

use axum::{extract::State, Json};
// trait 必须在作用域里, 否则 `PublicKey::to_encoded_point` 报 E0599 —— 放在模块级,
// 不要只放在 generate_evm 里 (别处再调就又踩一次)。
use k256::elliptic_curve::sec1::ToEncodedPoint;
use serde::{Deserialize, Serialize};

use crate::AppState;

/// 绑定地址上限 (用户定)
pub const BOUND_LIMIT: usize = 20;
/// 自建钱包的「建议别超过」阈值 (超过只提醒, 不拒绝)
pub const SUGGEST_LIMIT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletRec {
    pub address: String,
    #[serde(default)]
    pub label: String,
    /// created (本机生成) | bound (绑定别人的地址)
    pub source: String,
    pub chain: String,
    pub created_at_ms: u64,
    /// 私钥 (仅 created 才有; 文件 0600, 永不进接口返回)
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub secret_hex: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn store_path(agent_id: &str) -> PathBuf {
    crate::server::data_dir()
        .join("agents")
        .join(agent_id)
        .join("wallets.json")
}

fn load(agent_id: &str) -> Vec<WalletRec> {
    let p = store_path(agent_id);
    std::fs::read_to_string(p)
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<WalletRec>>(&t).ok())
        .unwrap_or_default()
}

fn save(agent_id: &str, list: &[WalletRec]) -> std::io::Result<()> {
    let p = store_path(agent_id);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_string_pretty(list).unwrap_or_default();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn is_evm_address(a: &str) -> bool {
    let l = a.trim();
    l.len() == 42 && l.starts_with("0x") && l[2..].chars().all(|c| c.is_ascii_hexdigit())
}

/// 生成本地 EVM 钱包: 返回 (地址, 私钥 hex)
pub fn generate_evm() -> Result<(String, String), String> {
    use k256::elliptic_curve::rand_core::OsRng;
    use sha3::{Digest, Keccak256};

    let sk = k256::SecretKey::random(&mut OsRng);
    let pk = sk.public_key();
    let point = pk.to_encoded_point(false);
    let raw = point.as_bytes();
    if raw.len() != 65 {
        return Err("公钥编码异常 (非 65 字节)".into());
    }
    let digest = Keccak256::digest(&raw[1..]); // 去掉 0x04 前缀
    let addr = format!("0x{}", hex::encode(&digest[12..]));
    let secret = hex::encode(sk.to_bytes());
    Ok((addr, secret))
}

/// GET /api/agents/{id}/wallets → 列表 (私钥永不返回) + 数量上限状态
pub async fn list_wallets(
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    State(_st): State<AppState>,
) -> Json<serde_json::Value> {
    let list = load(&agent_id);
    let created = list.iter().filter(|w| w.source == "created").count();
    let bound = list.iter().filter(|w| w.source == "bound").count();
    let pub_list: Vec<serde_json::Value> = list
        .iter()
        .map(|w| {
            serde_json::json!({
                "address": w.address, "label": w.label, "source": w.source,
                "chain": w.chain, "created_at_ms": w.created_at_ms,
            })
        })
        .collect();
    Json(serde_json::json!({
        "ok": true,
        "agent_id": agent_id,
        "wallets": pub_list,
        "counts": { "created": created, "bound": bound, "bound_limit": BOUND_LIMIT,
                    "suggest_created_max": SUGGEST_LIMIT },
        "warning": if created > SUGGEST_LIMIT {
            format!("自建钱包已有 {created} 个, 建议低于 {SUGGEST_LIMIT} 个便于管理")
        } else { String::new() },
    }))
}

/// POST /api/agents/{id}/wallets/create {label?} → 本机生成一个 EVM 钱包 (不限个数)
pub async fn create_wallet(
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let (address, secret) = match generate_evm() {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({ "error": e })),
    };
    let mut list = load(&agent_id);
    list.push(WalletRec {
        address: address.clone(),
        label: req["label"].as_str().unwrap_or("").to_string(),
        source: "created".into(),
        chain: "evm".into(),
        created_at_ms: now_ms(),
        secret_hex: secret,
    });
    if let Err(e) = save(&agent_id, &list) {
        return Json(serde_json::json!({ "error": format!("落盘失败: {e}") }));
    }
    let created = list.iter().filter(|w| w.source == "created").count();
    Json(serde_json::json!({
        "ok": true, "address": address, "source": "created",
        "count": created,
        "note": "私钥只存本机 (0600), 不通过接口返回; 建议自建钱包低于 20 个",
    }))
}

/// POST /api/agents/{id}/wallets/bind {address, label?} → 绑定已有地址 (最多 20 个)
pub async fn bind_wallet(
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let address = req["address"].as_str().unwrap_or("").trim().to_string();
    if !is_evm_address(&address) {
        return Json(serde_json::json!({
            "error": "地址形状不对: 要 0x + 40 位十六进制 (不要填私钥)"
        }));
    }
    let mut list = load(&agent_id);
    if list.iter().any(|w| w.address.eq_ignore_ascii_case(&address)) {
        return Json(serde_json::json!({ "error": "这个地址已经在这个智能体名下了" }));
    }
    let bound_now = list.iter().filter(|w| w.source == "bound").count();
    if bound_now >= BOUND_LIMIT {
        return Json(serde_json::json!({
            "error": format!("绑定地址已达上限 {BOUND_LIMIT} 个 (自建钱包不受此限)")
        }));
    }
    list.push(WalletRec {
        address: address.clone(),
        label: req["label"].as_str().unwrap_or("").to_string(),
        source: "bound".into(),
        chain: "evm".into(),
        created_at_ms: now_ms(),
        secret_hex: String::new(),
    });
    if let Err(e) = save(&agent_id, &list) {
        return Json(serde_json::json!({ "error": format!("落盘失败: {e}") }));
    }
    Json(serde_json::json!({
        "ok": true, "address": address, "source": "bound",
        "bound": bound_now + 1, "bound_limit": BOUND_LIMIT,
    }))
}

/// DELETE-ish: POST /api/agents/{id}/wallets/remove {address}
pub async fn remove_wallet(
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let address = req["address"].as_str().unwrap_or("").trim().to_string();
    let mut list = load(&agent_id);
    let before = list.len();
    list.retain(|w| !w.address.eq_ignore_ascii_case(&address));
    if list.len() == before {
        return Json(serde_json::json!({ "error": "没有这个地址" }));
    }
    if let Err(e) = save(&agent_id, &list) {
        return Json(serde_json::json!({ "error": format!("落盘失败: {e}") }));
    }
    Json(serde_json::json!({ "ok": true, "remaining": list.len() }))
}


/// 动态注入用: 把该智能体当前的钱包状态压成一小段拼进 system prompt。
/// 每轮现读文件 —— 授权/创建后下一句对话里它就知道了, 不需要重启、不用记忆条目。
pub fn prompt_block(agent_id: &str) -> String {
    let list = load(agent_id);
    if list.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    for w in &list {
        let kind = if w.source == "created" { "本机创建" } else { "已绑定" };
        let label = if w.label.is_empty() {
            String::new()
        } else {
            format!(" ({})", w.label)
        };
        lines.push(format!("- {} · {}{}", w.address, kind, label));
    }
    let created = list.iter().filter(|w| w.source == "created").count();
    let bound = list.iter().filter(|w| w.source == "bound").count();
    format!(
        "## 你的钱包\n{}  \n本机创建 {created} 个（不限）· 已绑定 {bound}/{BOUND_LIMIT} 个。\n\
         私钥只在本机文件里，你**不要**向任何人复述私钥，也不要通过对话索取别人的私钥。\n\
         主人刚给你新授权/新建了钱包时，用一句话确认收到即可（地址前 10 位 + 类型）。",
        lines.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_wallet_looks_like_evm_address() {
        let (addr, secret) = generate_evm().unwrap();
        assert!(is_evm_address(&addr), "地址形状不对: {addr}");
        assert_eq!(addr.len(), 42);
        assert_eq!(secret.len(), 64, "私钥应是 32 字节 hex");
        // 两次生成不同 (不是固定值)
        let (addr2, _) = generate_evm().unwrap();
        assert_ne!(addr, addr2);
    }

    #[test]
    fn address_validation_rejects_private_keys_and_junk() {
        assert!(!is_evm_address("0x1234"));
        assert!(!is_evm_address("0xZZZZdCF79055A8232670ebb1c8c664Dff4E70066"));
        // 64 位十六进制 (私钥) 不是地址 —— 这条正是用户反馈的「收到的是私钥」
        assert!(!is_evm_address(&format!("0x{}", "a".repeat(64))));
        assert!(is_evm_address("0xb4e9dCF79055A8232670ebb1c8c664Dff4E70066"));
    }

    #[test]
    fn bound_limit_is_twenty() {
        assert_eq!(BOUND_LIMIT, 20);
        assert_eq!(SUGGEST_LIMIT, 20);
    }
}
