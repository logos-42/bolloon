//! DID **真人验证门** —— 个人代币发行的前置 (2026-11-15)。
//!
//! 发币要求「DID 身份完成真人验证；未验证不许发币」。这里只做**门与状态**，判据诚实分级：
//!
//! 1. **归属证明（强）**：提交手机号/邮箱的 ownership attestation
//!    （`bolloon_p2p::attestation`），验签通过且 `owner_did` == 当前 DID
//!    ⇒ 证明「控制了一个真实联系方式」。
//! 2. **邀请码（运营放行）**：提交与环境变量 `BOLLOON_VERIFY_INVITE` 一致的 `code`。
//! 3. **本地开放（开发/自托管）**：`BOLLOON_VERIFY_OPEN=1` 直接放行，`method` 如实记 `open`。
//!
//! 没有任何外部信号就不可能证「你是真人」——所以这里不伪造判据；拿不到就如实拒。

use std::path::PathBuf;

use axum::{Json, extract::State};

use crate::AppState;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct VerifyRec {
    pub verified: bool,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub at_ms: u64,
    /// 归属证明 id（proof 方式）或 code 来源
    #[serde(default)]
    pub proof_id: String,
    /// 盲化哈希前缀（phone/email，不存明文）
    #[serde(default)]
    pub subject_hint: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct VerifyFile {
    #[serde(default)]
    pub dids: std::collections::BTreeMap<String, VerifyRec>,
    /// 扫脸采集回执：只证明「收到了一张图」，**不证明是真人/本人**
    #[serde(default)]
    pub faces: std::collections::BTreeMap<String, FaceRec>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct FaceRec {
    pub at_ms: u64,
    pub bytes: usize,
    pub sha256: String,
    #[serde(default)]
    pub note: String,
}

fn path() -> PathBuf {
    crate::server::data_dir()
        .join("verify")
        .join("verified.json")
}

fn load() -> VerifyFile {
    std::fs::read_to_string(path())
        .ok()
        .and_then(|t| serde_json::from_str::<VerifyFile>(&t).ok())
        .unwrap_or_default()
}

fn save(f: &VerifyFile) -> Result<(), String> {
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

/// POST /api/verify/face {image} —— 接收 DataURL/base64 自拍，落地**采集回执**。
/// 明确不伪造认证：这里没有人脸检测/活体/比对服务，verified 恒 false。
pub async fn face_capture(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let input = req["image"].as_str().unwrap_or_default().trim();
    let raw = input.split(',').last().unwrap_or("");
    use base64::Engine;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(raw) {
        Ok(b) => b,
        Err(e) => {
            return Json(serde_json::json!({ "ok": false, "error": format!("图片解码失败: {e}") }))
        }
    };
    if bytes.is_empty() || bytes.len() > 2_000_000 {
        return Json(serde_json::json!({
            "ok": false, "error": "图片大小必须在 1B–2MB 之间"
        }));
    }
    use sha2::Digest;
    let hash = hex::encode(sha2::Sha256::digest(&bytes));
    let did = st.identity.did.as_str().to_string();
    let mut f = load();
    f.faces.insert(
        did.clone(),
        FaceRec {
            at_ms: now_ms(),
            bytes: bytes.len(),
            sha256: hash.clone(),
            note: "仅采集回执；无人脸核验服务，未完成实名".into(),
        },
    );
    if let Err(e) = save(&f) {
        return Json(serde_json::json!({ "ok": false, "error": format!("保存失败: {e}") }));
    }
    Json(serde_json::json!({
        "ok": true, "verified": false, "did": did,
        "method": "face_capture_pending", "receipt_id": hash,
        "note": "已保存采集回执；后端未接入人脸比对，实名状态未改变"
    }))
}

/// 该 DID 是否已完成真人验证（发币门只认这个）。
pub fn is_verified(did: &str) -> bool {
    load().dids.get(did).map(|r| r.verified).unwrap_or(false)
}

/// GET /api/verify/status → { did, verified, method, at_ms, note }
pub async fn status(State(st): State<AppState>) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();
    let rec = load().dids.get(&did).cloned().unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "did": did,
        "verified": rec.verified,
        "method": rec.method,
        "at_ms": rec.at_ms,
        "proof_id": rec.proof_id,
        "subject_hint": rec.subject_hint,
        "note": if rec.verified {
            "已通过真人验证，可以发行个人代币"
        } else {
            "未通过真人验证 —— 发币前需完成验证（绑定并证明手机号/邮箱归属，或使用邀请码）"
        },
    }))
}

/// POST /api/verify/personhood
///   { proof?: <ownership attestation json> } | { code: "..." }（也接受 BOLLOON_VERIFY_OPEN=1）
pub async fn personhood(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let did = st.identity.did.as_str().to_string();

    // ① 本地开放（开发/自托管）
    let open = std::env::var("BOLLOON_VERIFY_OPEN")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if open {
        return finish(did, "open".into(), "env-open".into(), String::new());
    }

    // ② 邀请码（运营放行）
    if let Some(code) = req.get("code").and_then(|v| v.as_str()) {
        let want = std::env::var("BOLLOON_VERIFY_INVITE").unwrap_or_default();
        if want.is_empty() {
            return Json(serde_json::json!({
                "ok": false,
                "error": "本机未配置邀请码 (BOLLOON_VERIFY_INVITE)；请改用手机号/邮箱归属证明",
            }));
        }
        if code == want {
            return finish(did, "invite".into(), "invite".into(), String::new());
        }
        return Json(serde_json::json!({ "ok": false, "error": "邀请码不正确" }));
    }

    // ③ 手机号/邮箱归属证明（强）
    let Some(proof) = req.get("proof") else {
        return Json(serde_json::json!({
            "ok": false,
            "need_proof": true,
            "error": "需要提供 proof（手机号/邮箱 ownership attestation）或邀请码，才能完成真人验证",
        }));
    };
    let att: bolloon_p2p::attestation::OwnershipAttestation =
        match serde_json::from_value(proof.clone()) {
            Ok(a) => a,
            Err(e) => {
                return Json(
                    serde_json::json!({ "ok": false, "error": format!("proof 解析失败: {e}") }),
                );
            }
        };
    let kind = att.statement.subject_kind;
    if !matches!(
        kind,
        bolloon_p2p::attestation::SubjectKind::Phone | bolloon_p2p::attestation::SubjectKind::Email
    ) {
        return Json(serde_json::json!({
            "ok": false,
            "error": "真人验证只接受手机号/邮箱 ownership 证明（agent/wallet 归属不算真人证明）",
        }));
    }
    if att.statement.owner_did != did {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("proof 的 owner_did ({}) 不是当前 DID ({})", att.statement.owner_did, did),
        }));
    }
    let v = bolloon_p2p::attestation::verify_ownership(
        &att,
        &bolloon_p2p::attestation::VerifyOpts {
            now_ms: now_ms(),
            ..Default::default()
        },
    );
    if !v.ok || !v.owner_sig_ok {
        return Json(serde_json::json!({
            "ok": false,
            "error": format!("proof 验签不通过: {}", v.reasons.join(" | ")),
        }));
    }
    let hint = att.statement.subject_id.chars().take(8).collect::<String>();
    finish(did, kind.as_str().into(), att.id.clone(), hint)
}

fn finish(
    did: String,
    method: String,
    proof_id: String,
    subject_hint: String,
) -> Json<serde_json::Value> {
    let mut f = load();
    f.dids.insert(
        did.clone(),
        VerifyRec {
            verified: true,
            method: method.clone(),
            at_ms: now_ms(),
            proof_id,
            subject_hint,
        },
    );
    if let Err(e) = save(&f) {
        return Json(serde_json::json!({ "ok": false, "error": format!("写入验证状态失败: {e}") }));
    }
    Json(serde_json::json!({
        "ok": true,
        "did": did,
        "verified": true,
        "method": method,
        "note": "真人验证通过，可以发行个人代币",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_did_is_not_verified() {
        // 读盘但不写：一个永不存在的 did 一定是未验证（不依赖 BOLLOON_HOME 写入，避免测试竞态）
        assert!(!is_verified("did:pi:never-verified-test-xyz"));
    }
}
