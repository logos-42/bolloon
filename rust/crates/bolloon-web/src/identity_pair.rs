//! 手机/电脑使用同一个 DID：通过口令加密导出 seed，扫码或粘贴配对码导入。
//!
//! 私钥明文只在内存与 0600 的 identity.json 中存在；配对码里是加密后的 blob。
//! 导入后必须重启进程（KeyPair 在启动时加载），UI 用 /api/identity/check 校验唯一性。

use axum::{extract::State, Json};
use crate::server::AppState;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn local_diap() -> Option<serde_json::Value> {
    #[cfg(feature = "diap-backend")]
    {
        crate::diap_hub::global().map(|h| h.address_json())
    }
    #[cfg(not(feature = "diap-backend"))]
    {
        None
    }
}

fn identity_path() -> std::path::PathBuf {
    crate::server::data_dir().join("identity.json")
}

fn expected_path() -> std::path::PathBuf {
    crate::server::data_dir().join("identity-expected.json")
}

fn write_0600(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    std::fs::write(path, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// POST /api/identity/pair-code {passphrase} → bolloon://pair?p=...
pub async fn pair_code(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let pass = req["passphrase"].as_str().unwrap_or("");
    if pass.len() < 8 {
        return Json(serde_json::json!({ "ok": false, "error": "口令至少 8 位" }));
    }
    let raw = match std::fs::read_to_string(identity_path()) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("读取身份失败: {e}") })),
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("身份文件损坏: {e}") })),
    };
    let seed_hex = v["seed_hex"].as_str().unwrap_or("");
    if seed_hex.len() != 64 {
        return Json(serde_json::json!({ "ok": false, "error": "seed 不合法" }));
    }
    let enc = match crate::wallet_crypto::encrypt_secret(pass, seed_hex) {
        Ok(e) => e,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("加密失败: {e}") })),
    };
    let base = std::env::var("BOLLOON_PUBLIC_URL")
        .or_else(|_| std::env::var("BOLLOON_LOCAL_API"))
        .unwrap_or_default();
    let quic = match &st.quic {
        Some(q) => q.node_addr().await.ok().map(|a| a.to_string()),
        None => None,
    };
    let payload = serde_json::json!({
        "v": 1,
        "kind": "bolloon-identity",
        "did": st.identity.did.as_str(),
        "blob": enc,
        "url": base,
        "diap": local_diap(),
        "quic": quic,
        "at_ms": now_ms(),
    });
    use base64::Engine;
    let p = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap_or_default());
    Json(serde_json::json!({
        "ok": true,
        "did": st.identity.did.as_str(),
        "code": format!("bolloon://pair?p={p}"),
        "payload": p,
        "note": "配对码含加密 seed；口令不要通过不安全渠道传递"
    }))
}

/// POST /api/identity/pair {code|payload, passphrase} → 写入本机身份（重启生效）
pub async fn pair(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let pass = req["passphrase"].as_str().unwrap_or("");
    if pass.len() < 8 {
        return Json(serde_json::json!({ "ok": false, "error": "口令至少 8 位" }));
    }
    let _ = &st;
    let code = req["code"].as_str().or_else(|| req["payload"].as_str()).unwrap_or("");
    let p = if let Some(q) = code.split("p=").nth(1) {
        q.split('&').next().unwrap_or("")
    } else {
        code
    };
    use base64::Engine;
    let raw = match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(p) {
        Ok(b) => b,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("配对码解析失败: {e}") })),
    };
    let v: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(v) => v,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("配对码损坏: {e}") })),
    };
    if v["kind"].as_str() != Some("bolloon-identity") {
        return Json(serde_json::json!({ "ok": false, "error": "不是 DID 配对码" }));
    }
    let enc: crate::wallet_crypto::EncWallet = match serde_json::from_value(v["blob"].clone()) {
        Ok(e) => e,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("密文格式错误: {e}") })),
    };
    let seed_hex = match crate::wallet_crypto::decrypt_secret(pass, &enc) {
        Ok(s) => s,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("口令错误或解密失败: {e}") })),
    };
    let seed = match hex::decode(&seed_hex) {
        Ok(s) if s.len() == 32 => s,
        _ => return Json(serde_json::json!({ "ok": false, "error": "seed 不合法" })),
    };
    let kp = bolloon_p2p::KeyPair::from_seed(&{
        let mut b = [0u8; 32];
        b.copy_from_slice(&seed);
        b
    });
    let did = v["did"].as_str().unwrap_or("");
    if did != kp.did.as_str() {
        return Json(serde_json::json!({ "ok": false, "error": "配对码 DID 与 seed 不一致（拒绝导入）" }));
    }
    let body = serde_json::json!({ "did": did, "seed_hex": seed_hex });
    if let Err(e) = write_0600(
        &identity_path(),
        &serde_json::to_string_pretty(&body).unwrap_or_default(),
    ) {
        return Json(serde_json::json!({ "ok": false, "error": format!("写入身份失败: {e}") }));
    }
    let exp = serde_json::json!({ "did": did, "at_ms": now_ms() });
    let _ = write_0600(
        &expected_path(),
        &serde_json::to_string_pretty(&exp).unwrap_or_default(),
    );

    // 配对码里的 DIAP/QUIC 地址 → 落盘设备表 + 注入内存 hub
    let url = v["url"].as_str().unwrap_or("");
    let diap = v.get("diap").filter(|x| !x.is_null()).cloned();
    // QUIC 对端地址：原生 quic_transport，直接登记即可用于快照推送
    if let Some(addr) = v["quic"].as_str().and_then(|a| a.parse::<std::net::SocketAddr>().ok()) {
        if let Some(q) = st.quic.as_ref() {
            q.add_peer(did, addr);
        }
    }
    if !url.is_empty() {
        crate::device_sync::register(&st, url, did, diap.clone());
        #[cfg(feature = "diap-backend")]
        if let Some(addr) = diap {
            if let Some(hub) = crate::diap_hub::global() {
                hub.register(url, addr).await;
            }
        }
    }
    Json(serde_json::json!({
        "ok": true, "did": did, "restart_required": true,
        "note": "身份已写入；请重启手机/电脑端使其生效"
    }))
}

/// GET /api/identity/check —— 登录时确认唯一 DID
pub async fn check(State(st): State<AppState>) -> Json<serde_json::Value> {
    let current = st.identity.did.as_str().to_string();
    let expected = std::fs::read_to_string(expected_path())
        .ok()
        .and_then(|r| serde_json::from_str::<serde_json::Value>(&r).ok())
        .and_then(|v| v["did"].as_str().map(|s| s.to_string()));
    let matched = expected.as_deref().map(|e| e == current).unwrap_or(true);
    Json(serde_json::json!({
        "ok": true, "did": current, "expected": expected,
        "unique": matched,
        "note": if matched { "本机 DID 与配对目标一致" } else { "DID 不一致：请重新导入配对码或重启" }
    }))
}
