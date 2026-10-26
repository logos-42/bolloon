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

    /// 反解 Ed25519 公钥 (验签用; 本命 did:pi: 直接就是公钥编码, 天然可反解)
    pub fn pubkey(&self) -> Option<[u8; 32]> {
        pubkey_of_did(self.as_str())
    }

    /// 由 Ed25519 公钥推**本命** DID `did:pi:<b58 pubkey>`
    /// (与 `pubkey_of_did` 互逆; 口径同 `KeyPair::from_signing` / `KeyPair::did_from_public`)
    pub fn from_public(pk: &[u8; 32]) -> Self {
        Self(format!("did:pi:{}", bs58::encode(pk).into_string()))
    }
}

/// 从 DID 反解 Ed25519 公钥 —— 支持 **DIAP 本命** `did:pi:<b58 pubkey>` 与互认用的 `did:key:z…`。
///
/// 注意方向: `did:pi:` 是 Bolloon/DIAP 的本命 DID 体系 (本项目不做替换);
/// `did:key:` 只是外部/W3C 表示, 这里**能读**是为了跨实现互验, 不是为了改成它。
pub fn pubkey_of_did(did: &str) -> Option<[u8; 32]> {
    let raw = if let Some(b58) = did.strip_prefix("did:pi:") {
        bs58::decode(b58).into_vec().ok()?
    } else if let Some(b58) = did.strip_prefix("did:key:z") {
        // did:key = multibase base58btc( multicodec 0xed01 ‖ 32B 公钥 )
        let v = bs58::decode(b58).into_vec().ok()?;
        if v.len() != 34 || v[0] != 0xed || v[1] != 0x01 {
            return None;
        }
        v[2..].to_vec()
    } else {
        return None;
    };
    raw.try_into().ok()
}

/// 本命 `did:pi:` → W3C `did:key:z…` (**只给需要与外部互认时用**, 本仓库存的仍是 did:pi:)
pub fn did_pi_to_key(pi_did: &str) -> Option<String> {
    let pk = pubkey_of_did(pi_did)?;
    let mut bytes = vec![0xed, 0x01];
    bytes.extend_from_slice(&pk);
    Some(format!("did:key:z{}", bs58::encode(bytes).into_string()))
}

/// W3C `did:key:z…` → 本命 `did:pi:` (把外部 DID 读进我们的体系)
pub fn did_key_to_pi(key_did: &str) -> Option<String> {
    let pk = pubkey_of_did(key_did)?;
    Some(Did::from_public(&pk).as_str().to_string())
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

    /// 私钥种子 (持久化 identity.json 用; 调用方负责 0600)
    pub fn secret_bytes(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// 签名
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        use ed25519_dalek::Signer;
        self.signing.sign(msg).to_bytes()
    }

    /// 由公钥推 DID (`did:pi:<b58 pubkey>`) —— 校验"manifest 的 owner 就是签名者本人"用
    pub fn did_from_public(pubkey: &[u8; 32]) -> Did {
        Did(format!("did:pi:{}", bs58::encode(pubkey).into_string()))
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

    #[test]
    fn did_pi_roundtrips_pubkey() {
        // did:pi 的内容**就是**公钥本身的 b58 ⇒ 天然可反解 (验签的基础)
        let kp = KeyPair::from_seed(&[9u8; 32]);
        let pk = kp.public_bytes();
        assert_eq!(pubkey_of_did(kp.did.as_str()), Some(pk));
        assert_eq!(kp.did, KeyPair::did_from_public(&pk), "同一公钥 ⇒ 同一 DID");
    }

    #[test]
    fn did_pi_and_did_key_interop_without_changing_native_form() {
        let kp = KeyPair::from_seed(&[11u8; 32]);
        let key_did = did_pi_to_key(kp.did.as_str()).unwrap();
        assert!(key_did.starts_with("did:key:z"), "{key_did}");
        assert_eq!(
            pubkey_of_did(&key_did),
            Some(kp.public_bytes()),
            "did:key 也能反解同一把公钥 (跨实现互验)"
        );
        assert_eq!(
            did_key_to_pi(&key_did).unwrap(),
            kp.did.as_str(),
            "did:key → 本命 did:pi 往返一致 (本命格式不变)"
        );
    }

    #[test]
    fn unresolvable_did_returns_none() {
        assert_eq!(pubkey_of_did("not-a-did"), None);
        assert_eq!(pubkey_of_did("did:key:z6Mkabc"), None, "长度不对 ⇒ None");
        assert_eq!(pubkey_of_did("did:pi:!@#"), None, "非法 b58 ⇒ None (不 panic)");
    }

    #[test]
    fn verify_works_from_did_alone() {
        // 验签只需要 DID 字符串 (公钥内嵌在 did:pi 里) — 这是目录/归属验签的落点
        let kp = KeyPair::from_seed(&[13u8; 32]);
        let msg = b"someone claims something";
        let sig = kp.sign(msg);
        let pk = pubkey_of_did(kp.did.as_str()).unwrap();
        assert!(KeyPair::verify(&pk, msg, &sig));
        let other = KeyPair::from_seed(&[14u8; 32]);
        let other_pk = pubkey_of_did(other.did.as_str()).unwrap();
        assert!(!KeyPair::verify(&other_pk, msg, &sig), "换一把公钥 ⇒ 验不过");
    }
}