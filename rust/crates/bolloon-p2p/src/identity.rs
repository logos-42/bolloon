//! DID 身份（对齐 DIAP 协议：did:pi / ed25519 / ZKP 验证占位）
//!
//! 接口先行：KeyPair 用 ed25519-dalek；DID 格式 did:pi:<pubkey-b58>。
//! 完整 ZKP 验证走 DIAP Rust SDK（feature 门控）。

use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::RngCore;

/// DID 字符串
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct Did(pub String);

impl Did {
    pub fn new(s: impl Into<String>) -> Self {
        Self(s.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for Did {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 密钥对（ed25519）
#[derive(Debug, Clone)]
pub struct KeyPair {
    signing: SigningKey,
    pub did: Did,
}

impl KeyPair {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut seed);
        Self::from_seed(&seed)
    }

    /// 从固定种子恢复（测试/跨进程）
    pub fn from_seed(seed: &[u8; 32]) -> Self {
        let signing = SigningKey::from_bytes(seed);
        Self::from_signing(signing)
    }

    fn from_signing(signing: SigningKey) -> Self {
        let verifying = signing.verifying_key();
        let did = Did(format!("did:pi:{}", bs58::encode(verifying.as_bytes()).into_string()));
        Self { signing, did }
    }

    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    pub fn public_bytes(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    /// 签名
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.signing.sign(msg).to_bytes()
    }

    /// 验签（静态方法，任何人可用）
    pub fn verify(pubkey: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
        let Ok(verifying) = VerifyingKey::from_bytes(pubkey) else {
            return false;
        };
        use ed25519_dalek::Verifier;
        let sig = ed25519_dalek::Signature::from_bytes(sig);
        verifying.verify(msg, &sig).is_ok()
    }
}

/// 只为测试提供（rand 是 dev-dep？不——直接用 OsRng 需要 rand crate）
const _: () = ();

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn did_format() {
        let kp = KeyPair::generate();
        assert!(kp.did.as_str().starts_with("did:pi:"));
    }

    #[test]
    fn sign_verify_roundtrip() {
        let kp = KeyPair::generate();
        let msg = b"hello bolloon";
        let sig = kp.sign(msg);
        assert!(KeyPair::verify(&kp.public_bytes(), msg, &sig));
    }

    #[test]
    fn verify_rejects_tampered() {
        let kp = KeyPair::generate();
        let msg = b"payload";
        let mut sig = kp.sign(msg);
        sig[0] ^= 0xff;
        assert!(!KeyPair::verify(&kp.public_bytes(), msg, &sig));
    }

    #[test]
    fn from_seed_is_deterministic() {
        let seed = [7u8; 32];
        let kp1 = KeyPair::from_seed(&seed);
        let kp2 = KeyPair::from_seed(&seed);
        assert_eq!(kp1.did, kp2.did, "同种子必须同一 DID");
    }
}