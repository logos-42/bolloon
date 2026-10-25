//! 付费信息协议 (`bolloon-x402-info/1`) — 智能体把"特定信息"标价提供
//!
//! 对齐 TS 版 `paid-info-protocol.ts` 的核心:
//! - 四层结构: item (公开元数据) / content (付款后返回) / proof (DIAP Ed25519) / payment (x402 凭据)
//! - 签名载荷纳入 contentHash + payment.receiptHash ⇒ 拿 A 内容回执冒充 B 内容直接破签名
//! - 验真四档, 不把"能解出内容"说成"信息可信":
//!   verified / self-attested / content-only / unverified

use sha2::{Digest, Sha256};

use bolloon_p2p::identity::KeyPair;

/// 协议名 (冻结)
pub const INFO_PROTOCOL: &str = "bolloon-x402-info/1";

/// 信息类别
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InfoCategory {
    Data,
    Skill,
    Goods,
    Art,
    Other,
}

/// 价格
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InfoPrice {
    /// 人类可读金额, 如 "0.002"
    pub amount: String,
    /// 原子单位 (USDC 6 位小数)
    pub amount_atomic: u64,
    pub currency: String,
    /// base | base-sepolia | sepolia | mainnet
    pub network: String,
    /// 收款地址 (0x…)
    pub pay_to: String,
}

/// 公开元数据 (付款前可见, 可索引转发)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PaidInfoItem {
    pub protocol: String,
    pub id: String,
    pub title: String,
    pub category: InfoCategory,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub price: InfoPrice,
    pub provider_did: String,
    /// "sha256:<hex>"
    pub content_hash: String,
    pub issued_at_ms: u64,
}

/// 内容信封 (付款后返回)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PaidInfoEnvelope {
    pub protocol: String,
    pub item_id: String,
    pub content: String,
    /// "sha256:<hex>" — 内容摘要
    pub content_hash: String,
    /// 支付凭据哈希 (纳入签名绑定)
    pub receipt_hash: String,
    /// 提供方 Ed25519 签名 (对 canonical 载荷)
    pub signature: String,
    pub provider_did: String,
    pub issued_at_ms: u64,
}

/// 验真结论 (四档, 显式区分)
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyVerdict {
    /// 签名 + 内容哈希 + 支付绑定 + DID 公钥绑定 全部通过
    Verified,
    /// 签名/哈希/支付绑定通过, 但 DID 未能解析或支付是本地开发凭据
    SelfAttested,
    /// 只有内容哈希对得上 (没签名) — 只保证没被传输篡改
    ContentOnly,
    /// 内容哈希都对不上
    Unverified,
}

/// 内容哈希 = "sha256:<hex>"
pub fn compute_content_hash(content: &str) -> String {
    let d = Sha256::digest(content.as_bytes());
    format!("sha256:{}", hex::encode(d))
}

/// canonical JSON (键排序 + 无空格; 与 p2p::envelope 同语义)
pub fn canonical_json(v: &impl serde::Serialize) -> String {
    let val = serde_json::to_value(v).expect("serialize");
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
        other => out.push_str(&serde_json::to_string(other).unwrap()),
    }
}

/// 信封签名载荷 (canonical, 不含 signature 本身)
#[derive(serde::Serialize)]
struct EnvelopeUnsigned<'a> {
    protocol: &'a str,
    item_id: &'a str,
    content_hash: &'a str,
    receipt_hash: &'a str,
    provider_did: &'a str,
    issued_at_ms: u64,
}

/// 构造签名信封 (提供方本机签名)
pub fn build_envelope(
    kp: &KeyPair,
    item_id: &str,
    content: &str,
    receipt_hash: &str,
    now_ms: u64,
) -> PaidInfoEnvelope {
    let content_hash = compute_content_hash(content);
    let unsigned = EnvelopeUnsigned {
        protocol: INFO_PROTOCOL,
        item_id,
        content_hash: &content_hash,
        receipt_hash,
        provider_did: kp.did.as_str(),
        issued_at_ms: now_ms,
    };
    let sig = kp.sign(canonical_json(&unsigned).as_bytes());
    PaidInfoEnvelope {
        protocol: INFO_PROTOCOL.to_string(),
        item_id: item_id.to_string(),
        content: content.to_string(),
        content_hash,
        receipt_hash: receipt_hash.to_string(),
        signature: bs58_of(&sig),
        provider_did: kp.did.as_str().to_string(),
        issued_at_ms: now_ms,
    }
}

fn bs58_of(bytes: &[u8]) -> String {
    // 直接 hex 更短路径: 与 DIAP Ed25519 生态对齐用 b58
    bolloon_p2p::b58_encode(bytes)
}

/// 逐条验真判据
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyCheck {
    ContentHashMatch,
    ContentHashMismatch,
    SignatureValid,
    SignatureInvalid,
    DidMatchesPubkey,
    ReceiptHashPresent,
    ReceiptHashMissing,
}

/// 验真报告
#[derive(Debug, Clone)]
pub struct VerifyReport {
    pub verdict: VerifyVerdict,
    pub checks: Vec<VerifyCheck>,
}

/// 验证信封: 内容哈希 + 签名 + 支付绑定, 结论按四档如实给
///
/// `expected_receipt_hash`: Some = 有支付凭据可对 (买方视角), None = 未付或无从对
/// `resolved_pubkey`: DID 解析出的公钥 (None = 未能解析)
pub fn verify_envelope(
    env: &PaidInfoEnvelope,
    expected_receipt_hash: Option<&str>,
    resolved_pubkey: Option<&[u8; 32]>,
) -> VerifyReport {
    let mut checks = Vec::new();
    let content_ok = compute_content_hash(&env.content) == env.content_hash;
    checks.push(if content_ok {
        VerifyCheck::ContentHashMatch
    } else {
        VerifyCheck::ContentHashMismatch
    });

    if !content_ok {
        return VerifyReport {
            verdict: VerifyVerdict::Unverified,
            checks,
        };
    }

    // 签名验证: 区分「无法验 (无公钥/无签名)」与「验了但不过」
    let unsigned = EnvelopeUnsigned {
        protocol: &env.protocol,
        item_id: &env.item_id,
        content_hash: &env.content_hash,
        receipt_hash: &env.receipt_hash,
        provider_did: &env.provider_did,
        issued_at_ms: env.issued_at_ms,
    };
    enum SigState {
        Valid,
        /// 签名在但 DID 未解析 (无法验)
        CannotResolve,
        /// 签名缺失或损坏
        Missing,
        Bad,
    }
    let sig_state = match (resolved_pubkey, bs58_decode_sig(&env.signature)) {
        (Some(pk), Some(sig)) => {
            let ok = KeyPair::verify(pk, canonical_json(&unsigned).as_bytes(), &sig);
            checks.push(if ok {
                VerifyCheck::DidMatchesPubkey
            } else {
                VerifyCheck::SignatureInvalid
            });
            if ok { SigState::Valid } else { SigState::Bad }
        }
        // DID 未解析: 签名在但验不了 → self-attested 档
        (None, Some(_)) => {
            checks.push(VerifyCheck::SignatureInvalid);
            SigState::CannotResolve
        }
        // 签名根本没有 → content-only 档
        _ => {
            checks.push(VerifyCheck::SignatureInvalid);
            SigState::Missing
        }
    };

    let receipt_ok = match expected_receipt_hash {
        Some(h) => {
            let ok = h == env.receipt_hash && !env.receipt_hash.is_empty();
            checks.push(if ok {
                VerifyCheck::ReceiptHashPresent
            } else {
                VerifyCheck::ReceiptHashMissing
            });
            ok
        }
        None => {
            checks.push(VerifyCheck::ReceiptHashMissing);
            false
        }
    };

    let verdict = match sig_state {
        SigState::Valid if receipt_ok => VerifyVerdict::Verified,
        SigState::Valid => VerifyVerdict::SelfAttested,
        // 签名在但 DID 未解析: 结构完整, 如实降 self-attested, 不冒充 verified
        SigState::CannotResolve => VerifyVerdict::SelfAttested,
        // 签名缺失/损坏: 只剩内容哈希
        SigState::Missing | SigState::Bad => VerifyVerdict::ContentOnly,
    };
    VerifyReport { verdict, checks }
}

fn bs58_decode_sig(s: &str) -> Option<[u8; 64]> {
    let raw = bolloon_p2p::b58_decode(s)?;
    raw.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_p2p::identity::KeyPair;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    #[test]
    fn content_hash_stable() {
        assert_eq!(
            compute_content_hash("hello"),
            compute_content_hash("hello")
        );
        assert_ne!(compute_content_hash("hello"), compute_content_hash("hello "));
        assert!(compute_content_hash("x").starts_with("sha256:"));
    }

    #[test]
    fn envelope_sign_verify_roundtrip() {
        let seller = kp(1);
        let env = build_envelope(&seller, "item_1", "内容本体", "receipt_abc", 100);
        let report = verify_envelope(&env, Some("receipt_abc"), Some(&seller.public_bytes()));
        assert_eq!(report.verdict, VerifyVerdict::Verified, "{:?}", report.checks);
    }

    #[test]
    fn tampered_content_unverified() {
        let seller = kp(1);
        let mut env = build_envelope(&seller, "i", "内容", "r", 1);
        env.content = "被改过的内容".into();
        let report = verify_envelope(&env, Some("r"), Some(&seller.public_bytes()));
        assert_eq!(report.verdict, VerifyVerdict::Unverified);
        assert!(report.checks.contains(&VerifyCheck::ContentHashMismatch));
    }

    #[test]
    fn no_pubkey_resolved_is_self_attested_not_verified() {
        let seller = kp(1);
        let env = build_envelope(&seller, "i", "内容", "r", 1);
        let report = verify_envelope(&env, Some("r"), None);
        assert_eq!(
            report.verdict,
            VerifyVerdict::SelfAttested,
            "DID 未解析不许报 verified"
        );
    }

    #[test]
    fn wrong_receipt_breaks_binding() {
        let seller = kp(1);
        let env = build_envelope(&seller, "i", "内容", "receipt_A", 1);
        // 拿 B 内容的回执冒充 → 签名/绑定对不上
        let report = verify_envelope(&env, Some("receipt_B"), Some(&seller.public_bytes()));
        assert_ne!(report.verdict, VerifyVerdict::Verified);
        assert!(report.checks.contains(&VerifyCheck::ReceiptHashMissing));
    }

    #[test]
    fn no_signature_is_content_only() {
        let seller = kp(1);
        let mut env = build_envelope(&seller, "i", "内容", "r", 1);
        env.signature = String::new();
        let report = verify_envelope(&env, Some("r"), Some(&seller.public_bytes()));
        assert_eq!(
            report.verdict,
            VerifyVerdict::ContentOnly,
            "只有内容哈希对 = content-only, 不冒充可信"
        );
    }

    #[test]
    fn canonical_json_sorted_tight() {
        let v = serde_json::json!({"b": 1, "a": "文本"});
        assert_eq!(canonical_json(&v), r#"{"a":"文本","b":1}"#);
    }
}
