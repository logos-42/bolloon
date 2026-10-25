//! 签名信封 (`bolloon-envelope/1`) — 去中心化协作的最小信任原语
//!
//! 对齐 TS 版 world-cards / opportunity-inbox 的纪律:
//! - canonical 正文 = 键排序 + 无空格 (与 TS `canonicalize` 同语义)
//! - 证据 = 发送者 Ed25519 签名 (对 canonical 字节串)
//! - 验签不过 → 一律拒收, 不静默降级
//! - 协议名不对 → 拒收

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::KeyPair;

/// 当前协议名 (冻结)
pub const ENVELOPE_PROTOCOL: &str = "bolloon-envelope/1";

/// 签名信封
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SignedEnvelope {
    pub protocol: String,
    /// 发送者 DID (`did:pi:<pubkey-b58>`)
    pub sender: String,
    /// 发送者公钥 (b58, 与 DID 后缀一致)
    pub pubkey: String,
    /// 主题 (群消息 / 任务公告 / 心跳 …)
    pub topic: String,
    /// 正文 (任意 JSON 值; 签名覆盖其 canonical 形态)
    pub payload: serde_json::Value,
    /// 毫秒时间戳
    pub ts: u64,
    /// Ed25519 签名 (b58, 对 canonical_bytes())
    pub signature: String,
}

/// 信封错误
#[derive(Debug, thiserror::Error)]
pub enum EnvelopeError {
    #[error("协议名不对: {0}")]
    BadProtocol(String),
    #[error("公钥与 DID 不一致")]
    PubkeyDidMismatch,
    #[error("签名无效")]
    BadSignature,
    #[error("编解码失败: {0}")]
    Codec(String),
}

impl SignedEnvelope {
    /// 签名并构造信封
    pub fn seal(
        kp: &KeyPair,
        topic: impl Into<String>,
        payload: serde_json::Value,
        ts_ms: u64,
    ) -> Self {
        let pubkey_b58 = bs58::encode(kp.public_bytes()).into_string();
        let mut env = Self {
            protocol: ENVELOPE_PROTOCOL.to_string(),
            sender: kp.did.as_str().to_string(),
            pubkey: pubkey_b58,
            topic: topic.into(),
            payload,
            ts: ts_ms,
            signature: String::new(),
        };
        let bytes = env.canonical_bytes();
        let sig = kp.sign(&bytes);
        env.signature = bs58::encode(sig).into_string();
        env
    }

    /// canonical 字节串 = 键排序 + 无空格的 JSON (不含 signature 字段)
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let unsigned = UnsignedView {
            protocol: &self.protocol,
            sender: &self.sender,
            pubkey: &self.pubkey,
            topic: &self.topic,
            payload: &self.payload,
            ts: self.ts,
        };
        canonical_json(&unsigned).into_bytes()
    }

    /// 内容哈希 (sha256 hex, 用于去重/日志, 不含 signature)
    pub fn content_hash(&self) -> String {
        let d = Sha256::digest(self.canonical_bytes());
        hex::encode(d)
    }

    /// 验签: 协议名 + DID/公钥一致性 + Ed25519。任一不过即拒。
    pub fn verify(&self) -> Result<(), EnvelopeError> {
        if self.protocol != ENVELOPE_PROTOCOL {
            return Err(EnvelopeError::BadProtocol(self.protocol.clone()));
        }
        // DID 后缀必须与公钥一致
        let did_suffix = self
            .sender
            .strip_prefix("did:pi:")
            .ok_or(EnvelopeError::PubkeyDidMismatch)?;
        if did_suffix != self.pubkey {
            return Err(EnvelopeError::PubkeyDidMismatch);
        }
        // 公钥解析 + 验签
        let mut pk = [0u8; 32];
        let raw = bs58::decode(&self.pubkey)
            .into_vec()
            .map_err(|e| EnvelopeError::Codec(format!("pubkey b58: {e}")))?;
        if raw.len() != 32 {
            return Err(EnvelopeError::PubkeyDidMismatch);
        }
        pk.copy_from_slice(&raw);
        let sig_raw = bs58::decode(&self.signature)
            .into_vec()
            .map_err(|e| EnvelopeError::Codec(format!("signature b58: {e}")))?;
        let sig: [u8; 64] = sig_raw
            .try_into()
            .map_err(|_| EnvelopeError::BadSignature)?;
        if !KeyPair::verify(&pk, &self.canonical_bytes(), &sig) {
            return Err(EnvelopeError::BadSignature);
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct UnsignedView<'a> {
    protocol: &'a str,
    sender: &'a str,
    pubkey: &'a str,
    topic: &'a str,
    payload: &'a serde_json::Value,
    ts: u64,
}

/// canonical JSON：键排序 + 无空格（与 TS `canonicalize` 同语义）
pub fn canonical_json(v: &impl Serialize) -> String {
    let val = serde_json::to_value(v).expect("serialize to value");
    let mut out = String::new();
    write_canonical(&val, &mut out);
    out
}

fn write_canonical(v: &serde_json::Value, out: &mut String) {
    match v {
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        serde_json::Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        other => {
            out.push_str(&serde_json::to_string(other).unwrap());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::KeyPair;

    #[test]
    fn seal_verify_roundtrip() {
        let kp = KeyPair::generate();
        let env = SignedEnvelope::seal(
            &kp,
            "group.msg",
            serde_json::json!({"text": "你好", "group": "g1"}),
            1_000,
        );
        assert!(env.verify().is_ok(), "完整信封必须验签通过");
    }

    #[test]
    fn tampered_payload_rejected() {
        let kp = KeyPair::generate();
        let mut env = SignedEnvelope::seal(&kp, "t", serde_json::json!({"a": 1}), 1);
        env.payload = serde_json::json!({"a": 2});
        assert!(matches!(env.verify(), Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn tampered_ts_rejected() {
        let kp = KeyPair::generate();
        let mut env = SignedEnvelope::seal(&kp, "t", serde_json::json!({}), 1);
        env.ts = 2;
        assert!(matches!(env.verify(), Err(EnvelopeError::BadSignature)));
    }

    #[test]
    fn bad_protocol_rejected() {
        let kp = KeyPair::generate();
        let mut env = SignedEnvelope::seal(&kp, "t", serde_json::json!({}), 1);
        env.protocol = "bolloon-envelope/2".into();
        assert!(matches!(env.verify(), Err(EnvelopeError::BadProtocol(_))));
    }

    #[test]
    fn pubkey_did_mismatch_rejected() {
        let kp = KeyPair::generate();
        let other = KeyPair::generate();
        let mut env = SignedEnvelope::seal(&kp, "t", serde_json::json!({}), 1);
        env.pubkey = bs58::encode(other.public_bytes()).into_string();
        assert!(matches!(env.verify(), Err(EnvelopeError::PubkeyDidMismatch)));
    }

    #[test]
    fn canonical_json_is_sorted_and_tight() {
        let v = serde_json::json!({"b": 1, "a": {"z": [1, 2], "y": "文本"}});
        let s = canonical_json(&v);
        assert_eq!(s, r#"{"a":{"y":"文本","z":[1,2]},"b":1}"#);
    }

    #[test]
    fn content_hash_stable() {
        let kp = KeyPair::generate();
        let e1 = SignedEnvelope::seal(&kp, "t", serde_json::json!({"x": 1}), 42);
        let e2 = SignedEnvelope::seal(&kp, "t", serde_json::json!({"x": 1}), 42);
        assert_eq!(e1.content_hash(), e2.content_hash(), "同内容同哈希 (与签名无关)");
    }
}
