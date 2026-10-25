//! 卖方本机签名交付 — 待办队列 + 拒签守卫 + 取件 token
//!
//! 对齐 TS 版 `seller-signing.ts`:
//! - 私钥只在卖方本机; 服务器只持公钥, **没钉住就拒收** (SELLER_KEY_NOT_PINNED)
//! - 待办幂等: 同 txHash+同 item ⇒ 同一条待办 (receiptHash 幂等键)
//! - 本机 did ≠ 待办 providerDid / 内容哈希对不上 → **拒签**
//! - 取件走只读 token (不重放 X-PAYMENT)

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use bolloon_p2p::identity::KeyPair;

use crate::paid_info::{PaidInfoEnvelope, INFO_PROTOCOL};

/// 协议名 (冻结)
pub const SELLER_PROTOCOL: &str = "bolloon-x402-seller/1";
/// 认证协议名
pub const SELLER_AUTH_PROTOCOL: &str = "bolloon-x402-seller-auth/1";
/// 认证时间偏差上限
pub const AUTH_MAX_SKEW_MS: u64 = 5 * 60 * 1000;
/// 待办 TTL (7 天)
pub const PENDING_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;

/// 待办签名请求
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingSignRequest {
    pub pending_id: String,
    pub item_id: String,
    /// 内容哈希 ("sha256:…")
    pub content_hash: String,
    /// 付款凭据哈希 (幂等键的一部分)
    pub receipt_hash: String,
    pub tx_hash: String,
    /// 钉住的卖方 DID (服务器侧记录)
    pub pinned_did: String,
    /// 提供方 DID (item 里的)
    pub provider_did: String,
    pub created_at_ms: u64,
    /// 已签出的信封 (签完后填)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub envelope: Option<PaidInfoEnvelope>,
}

/// 待办错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SellerError {
    #[error("服务器没钉住卖方公钥, 拒收 (SELLER_KEY_NOT_PINNED)")]
    KeyNotPinned,
    #[error("本机 did ≠ 待办 providerDid, 拒签")]
    DidMismatch,
    #[error("内容哈希对不上, 拒签")]
    ContentHashMismatch,
    #[error("取件 token 无效或过期")]
    BadPickupToken,
    #[error("待办不存在")]
    NotFound,
}

/// receiptHash = sha256(txHash ‖ itemId) hex — 幂等键
pub fn receipt_hash_of(tx_hash: &str, item_id: &str) -> String {
    let mut h = Sha256::new();
    h.update(tx_hash.as_bytes());
    h.update(b"\x00");
    h.update(item_id.as_bytes());
    hex::encode(h.finalize())
}

/// pendingId = "pnd_" + receiptHash 前 12 hex
pub fn new_pending_id(receipt_hash: &str) -> String {
    format!("pnd_{}", &receipt_hash[..12.min(receipt_hash.len())])
}

/// 卖方本机待办簿
#[derive(Debug, Default)]
pub struct SellerPendingBook {
    /// pendingId → 待办
    pending: HashMap<String, PendingSignRequest>,
    /// 取件 token → pendingId (一次性)
    pickup_tokens: HashMap<String, String>,
    used_tokens: std::collections::HashSet<String>,
}

impl SellerPendingBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收到付款回执 → 建待办 (幂等: 同 txHash+同 item 同一条; 换资源 409 语义由调用方处理)
    pub fn receive_payment(
        &mut self,
        pinned_did: Option<&str>,
        provider_did: &str,
        tx_hash: &str,
        item_id: &str,
        content_hash: &str,
        now_ms: u64,
    ) -> Result<&PendingSignRequest, SellerError> {
        // 服务器没钉住卖方公钥就拒收 (不是"先信一次")
        let pinned = pinned_did.ok_or(SellerError::KeyNotPinned)?;
        let rh = receipt_hash_of(tx_hash, item_id);
        let id = new_pending_id(&rh);
        if let Some(existing) = self.pending.get(&id).cloned() {
            // 同 receiptHash 重投 = 同一条待办 (回执逐字相同语义)
            return Ok(self.pending.get(&existing.pending_id).unwrap());
        }
        let rec = PendingSignRequest {
            pending_id: id.clone(),
            item_id: item_id.into(),
            content_hash: content_hash.into(),
            receipt_hash: rh,
            tx_hash: tx_hash.into(),
            pinned_did: pinned.into(),
            provider_did: provider_did.into(),
            created_at_ms: now_ms,
            envelope: None,
        };
        self.pending.insert(id, rec.clone());
        Ok(self.pending.get(&rec.pending_id).unwrap())
    }

    /// 本机签收: 守卫全过才签 (did 不匹配 / 内容哈希不对 → 拒签)
    pub fn sign(
        &mut self,
        pending_id: &str,
        kp: &KeyPair,
        content: &str,
        now_ms: u64,
    ) -> Result<PaidInfoEnvelope, SellerError> {
        let rec = self.pending.get(pending_id).ok_or(SellerError::NotFound)?;
        // 守卫 1: 本机 did 必须 == 待办 providerDid
        if kp.did.as_str() != rec.provider_did {
            return Err(SellerError::DidMismatch);
        }
        // 守卫 2: 内容哈希必须对得上 (内容被改 = 拒)
        let actual = crate::paid_info::compute_content_hash(content);
        if actual != rec.content_hash {
            return Err(SellerError::ContentHashMismatch);
        }
        // 签名信封 (receiptHash 纳入签名绑定)
        let env = crate::paid_info::build_envelope(kp, &rec.item_id, content, &rec.receipt_hash, now_ms);
        if let Some(rec) = self.pending.get_mut(pending_id) {
            rec.envelope = Some(env.clone());
        }
        Ok(env)
    }

    /// 出取件 token (一次性, 只读取件不重放 X-PAYMENT)
    pub fn issue_pickup_token(&mut self, pending_id: &str, nonce: &str) -> Result<String, SellerError> {
        if !self.pending.contains_key(pending_id) {
            return Err(SellerError::NotFound);
        }
        let mut h = Sha256::new();
        h.update(pending_id.as_bytes());
        h.update(nonce.as_bytes());
        let token = format!("pk-{}", &hex::encode(h.finalize())[..24]);
        self.pickup_tokens.insert(token.clone(), pending_id.into());
        Ok(token)
    }

    /// 取件 (一次性 token; 用过即废)
    pub fn pick_up(&mut self, token: &str) -> Result<PaidInfoEnvelope, SellerError> {
        if self.used_tokens.contains(token) {
            return Err(SellerError::BadPickupToken);
        }
        let pid = self.pickup_tokens.get(token).ok_or(SellerError::BadPickupToken)?;
        self.used_tokens.insert(token.to_string());
        self.pending
            .get(pid)
            .and_then(|r| r.envelope.clone())
            .ok_or(SellerError::NotFound)
    }

    pub fn len(&self) -> usize {
        self.pending.len()
    }
}

/// 服务器侧认证签名: HMAC(method ‖ path ‖ ts ‖ nonce ‖ bodyHash), 先验签再记 nonce
pub fn compute_auth_signature(secret: &str, method: &str, path: &str, ts_ms: u64, nonce: &str) -> String {
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<Sha256>;
    let body_hash = Sha256::digest(b"");
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("hmac key");
    mac.update(method.as_bytes());
    mac.update(path.as_bytes());
    mac.update(ts_ms.to_string().as_bytes());
    mac.update(nonce.as_bytes());
    mac.update(&body_hash);
    hex::encode(mac.finalize().into_bytes())
}

/// 认证时间检查
pub fn auth_time_ok(ts_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(ts_ms) <= AUTH_MAX_SKEW_MS && ts_ms <= now_ms + AUTH_MAX_SKEW_MS
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paid_info::compute_content_hash;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    fn content() -> &'static str {
        "付费内容本体 v1"
    }

    #[test]
    fn key_not_pinned_rejected() {
        let mut book = SellerPendingBook::new();
        let err = book
            .receive_payment(None, "did:pi:seller", "0xtx", "item_1", "sha256:x", 1)
            .unwrap_err();
        assert_eq!(err, SellerError::KeyNotPinned, "没钉公钥就拒收, 不是先信一次");
    }

    #[test]
    fn idempotent_by_receipt_hash() {
        let mut book = SellerPendingBook::new();
        let ch = compute_content_hash(content());
        let a = book.receive_payment(Some("did:pi:s"), "did:pi:seller", "0xtx", "item_1", &ch, 1).unwrap().clone();
        let b = book.receive_payment(Some("did:pi:s"), "did:pi:seller", "0xtx", "item_1", &ch, 2).unwrap().clone();
        assert_eq!(a.pending_id, b.pending_id, "同 txHash+同 item = 同一条待办");
        assert_eq!(book.len(), 1);
        assert!(a.pending_id.starts_with("pnd_"));
    }

    #[test]
    fn sign_guards_did_mismatch() {
        let mut book = SellerPendingBook::new();
        let ch = compute_content_hash(content());
        book.receive_payment(Some("did:pi:s"), "did:pi:seller", "0xtx", "item_1", &ch, 1).unwrap();
        let impostor = kp(9);
        let err = book.sign(&new_pending_id(&receipt_hash_of("0xtx", "item_1")), &impostor, content(), 2).unwrap_err();
        assert_eq!(err, SellerError::DidMismatch, "本机 did ≠ 待办 providerDid → 拒签");
    }

    #[test]
    fn sign_guards_content_hash() {
        let seller = kp(1);
        let mut book = SellerPendingBook::new();
        book.receive_payment(Some("did:pi:s"), seller.did.as_str(), "0xtx", "item_1", "sha256:deadbeef", 1).unwrap();
        let err = book.sign(&new_pending_id(&receipt_hash_of("0xtx", "item_1")), &seller, content(), 2).unwrap_err();
        assert_eq!(err, SellerError::ContentHashMismatch, "内容对不上 → 拒签");
    }

    #[test]
    fn sign_and_pickup_roundtrip() {
        let seller = kp(1);
        let mut book = SellerPendingBook::new();
        let ch = compute_content_hash(content());
        let rec = book.receive_payment(Some("did:pi:s"), seller.did.as_str(), "0xtx", "item_1", &ch, 1).unwrap().clone();
        let env = book.sign(&rec.pending_id, &seller, content(), 2).unwrap();
        assert_eq!(env.protocol, INFO_PROTOCOL);
        assert_eq!(env.content_hash, ch);
        assert_eq!(env.receipt_hash, rec.receipt_hash, "回执哈希纳入签名绑定");

        let token = book.issue_pickup_token(&rec.pending_id, "nonce1").unwrap();
        let picked = book.pick_up(&token).unwrap();
        assert_eq!(picked.content, content());
        // token 一次性
        assert_eq!(book.pick_up(&token).unwrap_err(), SellerError::BadPickupToken);
    }

    #[test]
    fn pickup_without_signature_not_found() {
        let mut book = SellerPendingBook::new();
        let ch = compute_content_hash(content());
        let rec = book.receive_payment(Some("did:pi:s"), "did:pi:seller", "0xtx", "i", &ch, 1).unwrap().clone();
        let token = book.issue_pickup_token(&rec.pending_id, "n").unwrap();
        assert_eq!(book.pick_up(&token).unwrap_err(), SellerError::NotFound, "没签的待办无信封可取");
    }

    #[test]
    fn auth_signature_deterministic_and_time_window() {
        let s1 = compute_auth_signature("secret", "GET", "/api/x402/seller/pending", 1000, "n1");
        let s2 = compute_auth_signature("secret", "GET", "/api/x402/seller/pending", 1000, "n1");
        assert_eq!(s1, s2, "同输入同签名");
        let s3 = compute_auth_signature("secret", "GET", "/api/x402/seller/pending", 1000, "n2");
        assert_ne!(s1, s3, "nonce 参与签名 (防重放)");
        assert!(auth_time_ok(1000, 1000 + AUTH_MAX_SKEW_MS));
        assert!(!auth_time_ok(1000, 1000 + AUTH_MAX_SKEW_MS + 1), "超偏差拒");
    }

    #[test]
    fn pending_ttl_documented() {
        // 7 天, 与 TS 常量一致
        assert_eq!(PENDING_TTL_MS, 7 * 24 * 60 * 60 * 1000);
    }
}
