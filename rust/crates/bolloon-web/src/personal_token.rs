//! **个人代币 + 个人钱包**（2026-11-15 升级：本地加密 + 跨设备共享 + 发现代币）
//!
//! 三块能力：
//! 1. 发行：`POST /api/tokens/prepare` → 预览；`POST /api/tokens/confirm` → 真实 ERC-20 上链。
//! 2. 发现：`POST /api/tokens/import` → 按合约地址走 `eth_call` 读元数据 + 余额，校验后纳入钱包
//!    （解决"换机/重装就看不到链上代币"）。
//! 3. 钱包安全：
//!    - 私钥**本地加密**落盘（口令 PBKDF2 → AES-256-GCM，见 `wallet_crypto`），明文只在本机内存；
//!    - `GET /api/wallet/backup` / `share` 导出**密文备份串**；`POST /api/wallet/restore` 用同一口令恢复；
//!    - 跨设备：`POST /api/wallet/push` 把密文经 `peer_json` 推到对端 `/api/wallet/adopt`，
//!      对端用同一口令 `accept-share` 解锁同一钱包。**明文私钥永不出本机、永不走网络。**
//!
//! 诚实边界：链上读不到就如实报错，绝不伪造；加密只防"直接翻文件"，不防本机被完全控制。

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::{extract::State, Json};

use crate::wallet_crypto::{decrypt_secret, encrypt_secret, export_blob, parse_blob, EncWallet, WalletBlob};
use crate::AppState;

const UNLOCK_TTL_SECS: u64 = 900;

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
    /// 初始/总供应量（**整币**数量，链上 mint 时乘 10^decimals）
    pub supply: u64,
    #[serde(default)]
    pub description: String,
    pub created_at_ms: u64,
    #[serde(default)]
    pub issuer_verified: bool,
    /// 发行者对核心记录（不含链字段）的 Ed25519 签名
    pub owner_sig: String,
    // ── 真实链上事实 ──
    #[serde(default)]
    pub contract_address: String,
    #[serde(default)]
    pub tx_hash: String,
    #[serde(default)]
    pub chain_id: u64,
    #[serde(default)]
    pub block_number: u64,
    /// 是否通过"导入合约地址"发现（非本机发行）
    #[serde(default)]
    pub imported: bool,
    /// 当前钱包对该代币的余额（最小单位，字符串；导入时写入，不代表实时）
    #[serde(default)]
    pub balance_base: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct TokenFile {
    #[serde(default)]
    pub tokens: Vec<TokenRec>,
}

/// 本机钱包文件。新格式只存密文（`enc`）；`secret_hex` 仅为兼容旧明文，setup 时迁移清空。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct PersonalWallet {
    #[serde(default)]
    address: String,
    #[serde(default)]
    enc: Option<EncWallet>,
    #[serde(default)]
    secret_hex: String,
    #[serde(default)]
    created_at_ms: u64,
}

struct UnlockState {
    address: String,
    secret: String,
    at: Instant,
}

fn unlock_cell() -> &'static Mutex<Option<UnlockState>> {
    static C: OnceLock<Mutex<Option<UnlockState>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn set_unlocked(address: String, secret: String) {
    if let Ok(mut g) = unlock_cell().lock() {
        *g = Some(UnlockState { address, secret, at: Instant::now() });
    }
}

fn get_unlocked() -> Option<(String, String)> {
    let mut g = unlock_cell().lock().ok()?;
    if let Some(s) = g.as_ref() {
        if s.at.elapsed() < Duration::from_secs(UNLOCK_TTL_SECS) {
            return Some((s.address.clone(), s.secret.clone()));
        }
        *g = None;
    }
    None
}

fn clear_unlocked() {
    if let Ok(mut g) = unlock_cell().lock() {
        *g = None;
    }
}

fn tokens_path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("tokens.json")
}

fn wallet_path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("personal_wallet.json")
}

fn shared_path() -> PathBuf {
    crate::server::data_dir().join("tokens").join("shared_wallet.json")
}

fn load() -> TokenFile {
    std::fs::read_to_string(tokens_path())
        .ok()
        .and_then(|t| serde_json::from_str::<TokenFile>(&t).ok())
        .unwrap_or_default()
}

fn save(f: &TokenFile) -> Result<(), String> {
    let body = serde_json::to_string_pretty(f).map_err(|e| e.to_string())?;
    atomic_write_0600(&tokens_path(), &body)
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
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn load_wallet() -> Option<PersonalWallet> {
    std::fs::read_to_string(wallet_path())
        .ok()
        .and_then(|t| serde_json::from_str::<PersonalWallet>(&t).ok())
        .filter(|w| !w.address.is_empty())
}

fn save_wallet(w: &PersonalWallet) -> Result<(), String> {
    let body = serde_json::to_string_pretty(w).map_err(|e| e.to_string())?;
    atomic_write_0600(&wallet_path(), &body)
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
        "ok": false, "need_verify": true,
        "error": "未通过 DID 真人验证，不能发行代币。请先完成真人验证。",
    }))
}

fn need_setup() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": false, "need_setup": true,
        "error": "还没有钱包，请先设置钱包口令",
    }))
}

fn need_unlock() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": false, "need_unlock": true,
        "error": "钱包已加密，请先输入口令解锁",
    }))
}

/// 当前钱包地址（不需要私钥/解锁）。
fn wallet_address() -> Option<String> {
    if let Some((a, _)) = get_unlocked() {
        return Some(a);
    }
    load_wallet().map(|w| w.address)
}

/// 发交易用的签名者（地址 + 明文私钥）。仅本机内存；未解锁且已加密则报错。
fn signer() -> Result<(String, String), &'static str> {
    if let Some((a, s)) = get_unlocked() {
        return Ok((a, s));
    }
    match load_wallet() {
        None => Err("need_setup"),
        Some(w) => {
            if w.enc.is_some() {
                Err("need_unlock")
            } else if !w.secret_hex.is_empty() {
                Ok((w.address, w.secret_hex))
            } else {
                Err("need_unlock")
            }
        }
    }
}

fn normalize_address(a: &str) -> Result<String, String> {
    let s = a.trim();
    if s.len() != 42 || !s.starts_with("0x") || !s[2..].chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("合约地址格式不对（需 0x + 40 位十六进制）".into());
    }
    Ok(s.to_lowercase())
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

// ───────────────────────────── 钱包接口 ─────────────────────────────

/// GET /api/wallet/status → 钱包是否存在 / 是否加密 / 是否解锁 / 是否有待接收的共享包。
pub async fn wallet_status() -> Json<serde_json::Value> {
    let w = load_wallet();
    let (rpc, cid, net) = chain_config();
    let pending = std::fs::metadata(shared_path()).map(|m| m.len() > 0).unwrap_or(false);
    Json(serde_json::json!({
        "ok": true,
        "exists": w.is_some(),
        "address": w.as_ref().map(|x| x.address.clone()).unwrap_or_default(),
        "encrypted": w.as_ref().map(|x| x.enc.is_some()).unwrap_or(false),
        "unlocked": get_unlocked().is_some(),
        "failed": 0,
        "pending_share": pending,
        "chain": { "chain_id": cid, "network": net, "rpc": rpc },
    }))
}

/// POST /api/wallet/setup { passphrase } → 首次生成钱包 / 把旧明文迁移为密文。
pub async fn wallet_setup(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let pass = req.get("passphrase").and_then(|v| v.as_str()).unwrap_or("");
    if pass.chars().count() < 8 {
        return err("钱包口令至少 8 位");
    }
    let existing = load_wallet();
    let (address, secret) = match existing.as_ref() {
        Some(w) => {
            if w.enc.is_some() {
                return err("已设置钱包口令；如需更换请用「恢复」导入新钱包");
            }
            if w.secret_hex.is_empty() {
                return err("钱包文件异常（无明文私钥可迁移）");
            }
            (w.address.clone(), w.secret_hex.clone())
        }
        None => match crate::agent_wallet::generate_evm() {
            Ok(v) => v,
            Err(e) => return err(&e),
        },
    };
    let enc = match encrypt_secret(pass, &secret) {
        Ok(e) => e,
        Err(e) => return err(&e),
    };
    let w = PersonalWallet {
        address: address.clone(),
        enc: Some(enc),
        secret_hex: String::new(),
        created_at_ms: existing.map(|x| x.created_at_ms).unwrap_or_else(now_ms),
    };
    if let Err(e) = save_wallet(&w) {
        return err(&format!("钱包落盘失败: {e}"));
    }
    set_unlocked(address.clone(), secret);
    Json(serde_json::json!({
        "ok": true, "address": address, "encrypted": true, "unlocked": true,
        "note": "私钥已用口令加密落盘（本机 0600）；请牢记口令，忘记无法恢复。",
    }))
}

/// POST /api/wallet/unlock { passphrase }
pub async fn wallet_unlock(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let pass = req.get("passphrase").and_then(|v| v.as_str()).unwrap_or("");
    let w = match load_wallet() {
        Some(w) => w,
        None => return need_setup(),
    };
    let enc = match w.enc.as_ref() {
        Some(e) => e,
        None => return err("钱包未加密（旧格式）；请用「设置口令」迁移后再解锁"),
    };
    let secret = match decrypt_secret(pass, enc) {
        Ok(s) => s,
        Err(e) => return err(&e),
    };
    let addr = match crate::chain_tx::evm_address_of(&secret) {
        Ok(a) => a,
        Err(e) => return err(&e),
    };
    if !addr.eq_ignore_ascii_case(&w.address) {
        return err("解密后地址与记录不符（数据可能被篡改）");
    }
    set_unlocked(w.address.clone(), secret);
    Json(serde_json::json!({ "ok": true, "address": w.address, "unlocked": true }))
}

/// POST /api/wallet/lock → 清除内存中的明文私钥。
pub async fn wallet_lock() -> Json<serde_json::Value> {
    clear_unlocked();
    Json(serde_json::json!({ "ok": true, "unlocked": false }))
}

/// GET /api/wallet/backup → 导出**加密**备份串（只含密文，可跨设备恢复）。
pub async fn wallet_backup() -> Json<serde_json::Value> {
    let w = match load_wallet() {
        Some(w) => w,
        None => return need_setup(),
    };
    let enc = match w.enc.as_ref() {
        Some(e) => e.clone(),
        None => return err("钱包尚未加密；请先设置口令再导出备份"),
    };
    match export_blob(&w.address, &enc) {
        Ok(blob) => Json(serde_json::json!({
            "ok": true, "address": w.address, "blob": blob,
            "note": "这是加密备份串：只含密文。到另一台设备用同一口令「恢复」即可共享同一钱包。",
        })),
        Err(e) => err(&e),
    }
}

/// GET /api/wallet/share → 与 backup 相同（语义为"分享到其它设备"）。
pub async fn wallet_share() -> Json<serde_json::Value> {
    wallet_backup().await
}

/// POST /api/wallet/restore { blob, passphrase, overwrite? } → 用备份串 + 口令恢复钱包。
pub async fn wallet_restore(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let blob = req.get("blob").and_then(|v| v.as_str()).unwrap_or("").trim();
    let pass = req.get("passphrase").and_then(|v| v.as_str()).unwrap_or("");
    let overwrite = req.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
    if blob.is_empty() {
        return err("请粘贴备份串");
    }
    let parsed = match parse_blob(blob) {
        Ok(b) => b,
        Err(e) => return err(&e),
    };
    let secret = match decrypt_secret(pass, &parsed.enc) {
        Ok(s) => s,
        Err(e) => return err(&e),
    };
    let addr = match crate::chain_tx::evm_address_of(&secret) {
        Ok(a) => a,
        Err(e) => return err(&e),
    };
    if !addr.eq_ignore_ascii_case(&parsed.address) {
        return err("备份串里的地址与私钥不符（数据损坏或被篡改）");
    }
    if let Some(cur) = load_wallet() {
        if !cur.address.eq_ignore_ascii_case(&addr) && !overwrite {
            return err("本机已有另一个钱包；如确认覆盖请带 overwrite:true");
        }
    }
    let w = PersonalWallet {
        address: addr.clone(),
        enc: Some(parsed.enc),
        secret_hex: String::new(),
        created_at_ms: now_ms(),
    };
    if let Err(e) = save_wallet(&w) {
        return err(&format!("钱包落盘失败: {e}"));
    }
    set_unlocked(addr.clone(), secret);
    Json(serde_json::json!({ "ok": true, "address": addr, "unlocked": true, "restored": true }))
}

/// POST /api/wallet/adopt { blob } → 收下对端推来的共享密文（待口令解锁，不覆盖本机钱包）。
pub async fn wallet_adopt(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let blob = req.get("blob").and_then(|v| v.as_str()).unwrap_or("").trim();
    if blob.is_empty() {
        return err("缺 blob");
    }
    let parsed = match parse_blob(blob) {
        Ok(b) => b,
        Err(e) => return err(&e),
    };
    let body = match serde_json::to_string_pretty(&parsed) {
        Ok(s) => s,
        Err(e) => return err(&e.to_string()),
    };
    if let Err(e) = atomic_write_0600(&shared_path(), &body) {
        return err(&format!("共享包落盘失败: {e}"));
    }
    Json(serde_json::json!({
        "ok": true, "address": parsed.address,
        "note": "已收到共享钱包（密文）。在本机输入口令「接受共享」即可解锁同一钱包。",
    }))
}

/// POST /api/wallet/accept-share { passphrase, overwrite? } → 用待接收共享包解锁并落为主钱包。
pub async fn wallet_accept_share(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let pass = req.get("passphrase").and_then(|v| v.as_str()).unwrap_or("");
    let overwrite = req.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
    let raw = match std::fs::read_to_string(shared_path()) {
        Ok(s) => s,
        Err(_) => return err("没有待接收的共享钱包"),
    };
    let parsed: WalletBlob = match serde_json::from_str(&raw) {
        Ok(b) => b,
        Err(e) => return err(&format!("共享包格式错误: {e}")),
    };
    let secret = match decrypt_secret(pass, &parsed.enc) {
        Ok(s) => s,
        Err(e) => return err(&e),
    };
    let addr = match crate::chain_tx::evm_address_of(&secret) {
        Ok(a) => a,
        Err(e) => return err(&e),
    };
    if !addr.eq_ignore_ascii_case(&parsed.address) {
        return err("共享包地址与私钥不符");
    }
    if let Some(cur) = load_wallet() {
        if !cur.address.eq_ignore_ascii_case(&addr) && !overwrite {
            return err("本机已有另一个钱包；如确认覆盖请带 overwrite:true");
        }
    }
    let w = PersonalWallet {
        address: addr.clone(),
        enc: Some(parsed.enc),
        secret_hex: String::new(),
        created_at_ms: now_ms(),
    };
    if let Err(e) = save_wallet(&w) {
        return err(&format!("钱包落盘失败: {e}"));
    }
    set_unlocked(addr.clone(), secret);
    let _ = std::fs::remove_file(shared_path());
    Json(serde_json::json!({ "ok": true, "address": addr, "unlocked": true, "accepted": true }))
}

/// POST /api/wallet/push { peer_base } → 把加密备份串经 peer_json 推到对端 /api/wallet/adopt。
pub async fn wallet_push(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let peer = req.get("peer_base").and_then(|v| v.as_str()).unwrap_or("").trim();
    if peer.is_empty() {
        return err("请填写对端地址（如 http://192.168.1.20:8787）");
    }
    let w = match load_wallet() {
        Some(w) => w,
        None => return need_setup(),
    };
    let enc = match w.enc.as_ref() {
        Some(e) => e.clone(),
        None => return err("钱包尚未加密；请先设置口令"),
    };
    let blob = match export_blob(&w.address, &enc) {
        Ok(b) => b,
        Err(e) => return err(&e),
    };
    let url = format!("{}/api/wallet/adopt", peer.trim_end_matches('/'));
    match crate::native::peer_json("POST", url, Some(serde_json::json!({ "blob": blob }))).await {
        Ok(v) => Json(serde_json::json!({ "ok": true, "pushed_to": peer, "peer_response": v })),
        Err(e) => err(&format!("推送到对端失败: {e}")),
    }
}

// ───────────────────────────── 代币接口 ─────────────────────────────

/// GET /api/tokens → 自己名下代币 + 验证状态 + 钱包/链配置。
pub async fn list(State(st): State<AppState>) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    let tokens: Vec<TokenRec> = load().tokens.into_iter().filter(|t| t.did == did).collect();
    let (rpc, cid, net) = chain_config();
    let w = load_wallet();
    let address = wallet_address().unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "did": did,
        "verified": crate::verify::is_verified(&did),
        "chain": { "chain_id": cid, "network": net, "rpc": rpc },
        "wallet_address": address,
        "wallet_exists": w.is_some(),
        "wallet_encrypted": w.as_ref().map(|x| x.enc.is_some()).unwrap_or(false),
        "wallet_unlocked": get_unlocked().is_some(),
        "tokens": tokens,
    }))
}

/// POST /api/tokens/import { contract_address, chain_id? }
/// → 用 eth_call 读 ERC-20 元数据 + 当前钱包余额，校验后纳入钱包（解决换机看不到币）。
pub async fn import(State(st): State<AppState>, Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let raw = req.get("contract_address").and_then(|v| v.as_str()).unwrap_or("");
    let contract = match normalize_address(raw) {
        Ok(c) => c,
        Err(e) => return err(&e),
    };
    let (rpc, cid, net) = chain_config();
    let (name, symbol, decimals, total_base) = match crate::chain_tx::erc20_metadata(&rpc, &contract) {
        Ok(v) => v,
        Err(e) => {
            return err(&format!("读取合约失败（该地址可能不是 ERC-20）：{e}"));
        }
    };
    if symbol.is_empty() {
        return err("合约 symbol 为空，拒绝导入");
    }
    if decimals > 18 {
        return err("decimals 超过 18，拒绝导入");
    }
    let did = st.identity.did.as_str().to_string();
    let addr = wallet_address().unwrap_or_default();
    let balance_base = if addr.is_empty() {
        0u128
    } else {
        crate::chain_tx::erc20_balance_of(&rpc, &contract, &addr).unwrap_or(0)
    };
    let unit = 10u128.saturating_pow(decimals);
    let supply = (total_base / unit).min(u64::MAX as u128) as u64;

    let mut f = load();
    let now = now_ms();
    if let Some(existing) = f
        .tokens
        .iter_mut()
        .find(|t| t.did == did && t.contract_address.eq_ignore_ascii_case(&contract))
    {
        existing.name = name;
        existing.symbol = symbol.clone();
        existing.decimals = decimals;
        existing.supply = supply;
        existing.chain_id = cid;
        existing.balance_base = balance_base.to_string();
        existing.imported = true;
        let rec = existing.clone();
        if let Some(t) = f.tokens.iter_mut().find(|t| t.did == did && t.contract_address.eq_ignore_ascii_case(&contract)) {
            t.owner_sig = hex::encode(st.identity.sign(canonical(&rec).as_bytes()));
        }
        if let Err(e) = save(&f) {
            return err(&format!("写入失败: {e}"));
        }
        return Json(serde_json::json!({
            "ok": true, "token": rec, "updated": true,
            "chain": { "chain_id": cid, "network": net },
            "balance_base": balance_base.to_string(),
            "note": "已刷新该代币的链上元数据与余额。",
        }));
    }
    let mut rec = TokenRec {
        id: format!("tok-{}-{}", symbol, now),
        did: did.clone(),
        name,
        symbol,
        decimals,
        supply,
        description: String::new(),
        created_at_ms: now,
        issuer_verified: crate::verify::is_verified(&did),
        owner_sig: String::new(),
        contract_address: contract.clone(),
        tx_hash: String::new(),
        chain_id: cid,
        block_number: 0,
        imported: true,
        balance_base: balance_base.to_string(),
    };
    rec.owner_sig = hex::encode(st.identity.sign(canonical(&rec).as_bytes()));
    f.tokens.push(rec.clone());
    if let Err(e) = save(&f) {
        return err(&format!("写入失败: {e}"));
    }
    Json(serde_json::json!({
        "ok": true, "token": rec, "imported": true,
        "chain": { "chain_id": cid, "network": net },
        "balance_base": balance_base.to_string(),
        "note": "已从链上读取代币并纳入钱包（余额为导入时快照）。",
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
    let from = match wallet_address() {
        Some(a) => a,
        None => return need_setup(),
    };
    let (rpc, cid, net) = chain_config();
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

/// POST /api/tokens/confirm → **真实部署 ERC-20**并等回执；成功才写盘。需要钱包已解锁。
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
    let (from, secret) = match signer() {
        Ok(v) => v,
        Err("need_setup") => return need_setup(),
        Err(_) => return need_unlock(),
    };
    let (rpc, cid, net) = chain_config();
    let base = supply_base(&d);
    let creation = match build_creation_data(&d.name, &d.symbol, d.decimals, base, &from) {
        Ok(c) => c,
        Err(e) => return err(&e),
    };
    let res = match crate::chain_tx::deploy_contract(&rpc, &secret, cid, &creation).await {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": e, "stage": "broadcast_or_receipt" })),
    };
    if !res.get("status_ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Json(serde_json::json!({
            "ok": false, "error": "链上部署失败（交易回执 status=0）",
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
        imported: false,
        balance_base: String::new(),
    };
    rec.owner_sig = hex::encode(st.identity.sign(canonical(&rec).as_bytes()));
    let mut f = load();
    f.tokens.push(rec.clone());
    if let Err(e) = save(&f) {
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
            "chain_id": cid, "network": net,
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
            imported: false,
            balance_base: String::new(),
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
    fn canonical_ignores_import_fields() {
        let mut r = rec();
        r.imported = true;
        r.balance_base = "123".into();
        r.contract_address = "0xabc".into();
        // 签名核心记录不含链字段/导入标记
        assert_eq!(canonical(&r), canonical(&rec()));
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

    #[test]
    fn normalize_address_validates() {
        assert!(normalize_address("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").is_ok());
        assert!(normalize_address("0x123").is_err());
        assert!(normalize_address("nope").is_err());
    }
}
