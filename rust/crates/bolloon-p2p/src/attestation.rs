//! 归属声明 attestation (`bolloon-ownership/1`)
//!
//! 一件事一套代码: 三类"归属"签名全部走这一个模块 ——
//!
//! | subject_kind | 含义 | 谁签 |
//! |---|---|---|
//! | `agent` | owner DID 声明「该智能体归我, 我对它的行为负责」(**这就是担责**) | owner Ed25519 |
//! | `wallet` | owner/agent 声明「该钱包地址归该智能体」 | owner Ed25519 (+ 钱包侧见下) |
//! | `phone`/`email` | DID 声明「该联系方式(盲化哈希)归我」(= human-directory 的 owner_sig) | owner Ed25519 |
//!
//! 签名一律 Ed25519, DID 一律 **DIAP 本命 `did:pi:` 体系** (`KeyPair`)。
//!
//! ## 诚实边界 (读代码前先看这段)
//!
//! 钱包地址要**自证**归属, 必须有该地址私钥的签名 (EIP-191 personal_sign)。
//! 本 crate **没有 secp256k1 / keccak256 依赖**, 所以 Rust 侧 **现在无法验证**钱包私钥签名 ——
//! `wallet_sig` 只是保留字段 + 判据如实写「未接线」, **绝不把单侧的 DID 声明当成"证明了钱包所有权"**。
//! 想把钱包侧做实, 需要给 workspace 加 `k256`(secp256k1) + `sha3`(keccak256)。
//!
//! 所以: `ok=true` 只代表 **DID 侧的声明与签名是真的**; 钱包自证要看 `wallet_self_proving`
//! (当前必然 `Some(false)`), 或调用 [`verify_ownership`] 时开 `require_wallet_proof` 让它直接判红。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::{KeyPair, pubkey_of_did};

pub const OWNERSHIP_PROTOCOL: &str = "bolloon-ownership/1";

// ─────────────────────────────── subject ───────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubjectKind {
    Agent,
    Wallet,
    Phone,
    Email,
}

impl SubjectKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Wallet => "wallet",
            Self::Phone => "phone",
            Self::Email => "email",
        }
    }
}

// ─────────────────────────── 声明正文 / 记录 ───────────────────────────

/// 声明正文 (只有 canonical 后的字节串是被签名的对象)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnershipStatement {
    pub protocol: String,
    pub subject_kind: SubjectKind,
    /// agent DID / 钱包地址(全小写) / 联系方式盲化哈希
    pub subject_id: String,
    /// 签名者 DID (**必须**是签名密钥自己的 DID — 不许替别人签)
    pub owner_did: String,
    pub issued_at_ms: u64,
    /// null = 不过期
    pub expires_at_ms: Option<u64>,
    /// 32 位 hex (16 字节), 一次性
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnershipAttestation {
    /// `own-` + sha256(canonical)[..16]
    pub id: String,
    pub statement: OwnershipStatement,
    /// **被签的那一份**字节串 (与其重算逐字节比对; 非 canonical 一律拒)
    pub statement_json: String,
    /// Ed25519 签名 hex (128 字符)
    pub owner_sig: String,
    /// 钱包私钥签名 (EIP-191) —— 见模块头: Rust 侧无能力验证, 先留字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wallet_sig: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OwnershipError {
    #[error("owner_did 必须是签名者本人 ({statement_did} ≠ {signer_did}) — 不能替别人签名")]
    DidNotSigner { statement_did: String, signer_did: String },
    #[error("owner_did 解不出公钥 (不是 did:pi:/did:key:z… 形态)")]
    UnresolvableDid,
    #[error("自验不通过 (拒返回/拒落盘): {reasons}")]
    SelfCheckFailed { reasons: String },
}

// ─────────────────────────── canonical / 构造 ───────────────────────────

/// canonical 字节串 (serde_json::Value 默认 BTreeMap ⇒ **键字母序**, 两侧重算一致)
pub fn canonical_statement(s: &OwnershipStatement) -> String {
    serde_json::json!({
        "protocol": s.protocol,
        "subject_kind": s.subject_kind.as_str(),
        "subject_id": s.subject_id,
        "owner_did": s.owner_did,
        "issued_at_ms": s.issued_at_ms,
        "expires_at_ms": s.expires_at_ms,
        "nonce": s.nonce,
    })
    .to_string()
}

pub fn ownership_id(canonical_json: &str) -> String {
    let d = Sha256::digest(canonical_json.as_bytes());
    format!("own-{}", &hex::encode(d)[..16])
}

/// 一次性 nonce (32 位小写 hex = 16 字节)
pub fn new_nonce() -> String {
    hex::encode(rand::random::<[u8; 16]>())
}

/// 「该智能体归我, 我对它负责」
pub fn agent_statement(
    agent_did: &str,
    owner_did: &str,
    issued_at_ms: u64,
    expires_at_ms: Option<u64>,
    nonce: String,
) -> OwnershipStatement {
    OwnershipStatement {
        protocol: OWNERSHIP_PROTOCOL.into(),
        subject_kind: SubjectKind::Agent,
        subject_id: agent_did.into(),
        owner_did: owner_did.into(),
        issued_at_ms,
        expires_at_ms,
        nonce,
    }
}

/// 「该钱包地址归该 owner/agent」(钱包自证见模块头边界)
pub fn wallet_statement(
    address_lower: &str,
    owner_did: &str,
    issued_at_ms: u64,
    expires_at_ms: Option<u64>,
    nonce: String,
) -> OwnershipStatement {
    OwnershipStatement {
        protocol: OWNERSHIP_PROTOCOL.into(),
        subject_kind: SubjectKind::Wallet,
        subject_id: address_lower.to_lowercase(),
        owner_did: owner_did.into(),
        issued_at_ms,
        expires_at_ms,
        nonce,
    }
}

/// 「该联系方式(盲化哈希)归我」—— 手机号/邮箱绑定
pub fn contact_statement(
    blind_hash: &str,
    kind: SubjectKind,
    owner_did: &str,
    issued_at_ms: u64,
    expires_at_ms: Option<u64>,
    nonce: String,
) -> OwnershipStatement {
    OwnershipStatement {
        protocol: OWNERSHIP_PROTOCOL.into(),
        subject_kind: kind,
        subject_id: blind_hash.into(),
        owner_did: owner_did.into(),
        issued_at_ms,
        expires_at_ms,
        nonce,
    }
}

// ─────────────────────────────────── 签名 ───────────────────────────────────

/// 签名 (**自验不通过就直接报错**, 绝不返回一份自己都验不过的 attestation)
pub fn sign_ownership(
    statement: &OwnershipStatement,
    kp: &KeyPair,
) -> Result<OwnershipAttestation, OwnershipError> {
    if statement.protocol != OWNERSHIP_PROTOCOL {
        return Err(OwnershipError::SelfCheckFailed {
            reasons: format!("protocol 必须是 {OWNERSHIP_PROTOCOL}"),
        });
    }
    // 不许替别人签: 声明的 owner_did 必须就是这把钥匙
    if statement.owner_did != kp.did.as_str() {
        return Err(OwnershipError::DidNotSigner {
            statement_did: statement.owner_did.clone(),
            signer_did: kp.did.as_str().into(),
        });
    }
    if pubkey_of_did(&statement.owner_did).is_none() {
        return Err(OwnershipError::UnresolvableDid);
    }

    let canonical = canonical_statement(statement);
    let owner_sig = hex::encode(kp.sign(canonical.as_bytes()));
    let att = OwnershipAttestation {
        id: ownership_id(&canonical),
        statement: statement.clone(),
        statement_json: canonical,
        owner_sig,
        wallet_sig: None,
    };

    let v = verify_ownership(
        &att,
        &VerifyOpts {
            now_ms: statement.issued_at_ms,
            ..VerifyOpts::default()
        },
    );
    if !v.ok {
        return Err(OwnershipError::SelfCheckFailed {
            reasons: v.reasons.join(" | "),
        });
    }
    Ok(att)
}

// ─────────────────────────────────── 验签 ───────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct VerifyOpts {
    /// 判过期的时刻 (缺省 = 0, 建议调用方给真时钟)
    pub now_ms: u64,
    /// nonce → id 索引 (**一次性判据的唯一来源**); 不给 = 不判重放
    pub nonces: Option<std::collections::HashMap<String, String>>,
    /// 钱包归属是否**必须**自证 (钱包私钥签名) —— 开了以后在当前 Rust 侧恒定判红 (无 secp256k1)
    pub require_wallet_proof: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct OwnershipCheck {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct OwnershipVerdict {
    pub ok: bool,
    pub reasons: Vec<String>,
    pub checks: Vec<OwnershipCheck>,
    pub owner_sig_ok: bool,
    /// Wallet subject 时才 Some: true = 钱包私钥也自证了 (当前 Rust 侧恒 false)
    pub wallet_self_proving: Option<bool>,
    /// 关于钱包自证的人话说明 (调用方要显示/打日志就用它)
    pub wallet_note: Option<String>,
}

/// 验签 (**唯一实现**, 只收紧不放松)。
///
/// 判据全部跑完不短路 —— 「没签名」和「签名错」在输出里分得开。
pub fn verify_ownership(att: &OwnershipAttestation, opts: &VerifyOpts) -> OwnershipVerdict {
    let mut checks: Vec<OwnershipCheck> = vec![];
    let mut reasons: Vec<String> = vec![];
    let mut push = |name: &str, ok: bool, detail: String, fatal: bool| {
        checks.push(OwnershipCheck { name: name.into(), ok, detail });
        if !ok && fatal {
            reasons.push(name.into());
        }
    };

    let s = &att.statement;

    push(
        "protocol",
        s.protocol == OWNERSHIP_PROTOCOL,
        format!("protocol={} (要 {})", s.protocol, OWNERSHIP_PROTOCOL),
        true,
    );

    // canonical: 落盘字节串必须与重算逐字节相同 (改名改名: 这不是"格式偏好", 是签名的对象)
    let recomputed = canonical_statement(s);
    let canonical_ok = att.statement_json == recomputed;
    push(
        "statement_canonical",
        canonical_ok,
        if canonical_ok {
            "statement_json == canonicalize(statement)".into()
        } else {
            format!(
                "statement_json 与 canonical 重算不一致 (落盘 {} 字符 / 重算 {} 字符)",
                att.statement_json.len(),
                recomputed.len()
            )
        },
        true,
    );
    let expect_id = ownership_id(&recomputed);
    push(
        "id_matches_statement",
        att.id == expect_id,
        format!("id={} vs 派生 {}", att.id, expect_id),
        true,
    );

    // DID 必须能反解出公钥 (否则这句话落在一把不存在的钥匙上)
    let pubkey = pubkey_of_did(&s.owner_did);
    push(
        "owner_did_resolvable",
        pubkey.is_some(),
        format!(
            "owner_did={} {}",
            s.owner_did,
            if pubkey.is_some() { "可解公钥" } else { "解不出公钥" }
        ),
        true,
    );

    let sig_shape_ok = att.owner_sig.len() == 128 && hex::decode(&att.owner_sig).is_ok();
    push(
        "owner_sig_shape",
        sig_shape_ok,
        format!("owner_sig {} 字符 (要 128 hex)", att.owner_sig.len()),
        true,
    );

    // 真验签: 对 canonical 字节串验 (不是对落盘那份验)
    let mut owner_sig_ok = false;
    if let (Some(pk), true) = (pubkey, sig_shape_ok) {
        if let Ok(sig) = hex::decode(&att.owner_sig) {
            if let Ok(sig64) = <[u8; 64]>::try_from(sig.as_slice()) {
                owner_sig_ok = KeyPair::verify(&pk, recomputed.as_bytes(), &sig64);
            }
        }
    }
    push(
        "owner_sig",
        owner_sig_ok,
        if owner_sig_ok {
            "ed25519Verify(owner_did 公钥, canonical, owner_sig) = true".into()
        } else {
            "owner_sig 验不过 (声明/DID/签名三者不自洽)".into()
        },
        true,
    );

    let nonce_ok = s.nonce.len() == 32 && s.nonce.chars().all(|c| c.is_ascii_hexdigit());
    push(
        "nonce_shape",
        nonce_ok,
        format!("nonce={} (要 32 位 hex)", s.nonce),
        true,
    );

    let expired = matches!(s.expires_at_ms, Some(exp) if opts.now_ms > exp);
    push(
        "not_expired",
        !expired,
        match s.expires_at_ms {
            Some(exp) => format!("expires_at_ms={exp}, now_ms={} ⇒ {}", opts.now_ms, if expired { "已过期" } else { "未过期" }),
            None => "无过期时间".into(),
        },
        true,
    );

    // nonce 一次性: 只有调用方给了索引才判 (没给 → 如实说这条没跑)
    match (&opts.nonces, nonce_ok) {
        (Some(index), true) => match index.get(&s.nonce) {
            Some(other) if *other != att.id => push(
                "nonce_unused",
                false,
                format!("nonce 已被另一条占用 ({other}) — 同一枚 nonce 两条都拒"),
                true,
            ),
            _ => push("nonce_unused", true, "索引里没撞".into(), true),
        },
        _ => push(
            "nonce_unused",
            true,
            "未给 nonce 索引 ⇒ 这一条没跑 (调用方要知道)".into(),
            true,
        ),
    }

    // ── 钱包自证: Rust 侧没有 secp256k1/keccak ⇒ 现在就是没法验, 如实写 ──
    let mut wallet_self_proving = None;
    let mut wallet_note = None;
    if s.subject_kind == SubjectKind::Wallet {
        let has_sig = att.wallet_sig.is_some();
        wallet_self_proving = Some(false);
        wallet_note = Some(
            "钱包地址的自证需要该地址私钥的 EIP-191 签名; 本 crate 无 secp256k1/keccak ⇒ Rust 侧验不了 \
             (owner_sig 只证明『这个 DID 声称拥有该地址』, 不证明地址归它)"
                .into(),
        );
        // fatal = require_wallet_proof: 严格模式要"证明钱包所有权"就必须自证 ⇒ 现在恒定判红 (这是诚实的)
        push(
            "wallet_self_proving",
            false,
            if has_sig {
                "wallet_sig 在, 但本机无能力验证 (缺 k256/sha3) — 不当真".into()
            } else {
                "wallet_sig 缺失 ⇒ 只有 DID 单侧声明".into()
            },
            opts.require_wallet_proof,
        );
    }

    OwnershipVerdict {
        ok: reasons.is_empty() && owner_sig_ok && canonical_ok,
        reasons,
        checks,
        owner_sig_ok,
        wallet_self_proving,
        wallet_note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp() -> KeyPair {
        KeyPair::from_seed(&[7u8; 32])
    }

    fn agent_att(now: u64) -> OwnershipAttestation {
        let k = kp();
        let s = agent_statement("did:pi:agent-abc", k.did.as_str(), now, None, new_nonce());
        sign_ownership(&s, &k).unwrap()
    }

    #[test]
    fn agent_ownership_roundtrip() {
        let k = kp();
        let s = agent_statement("did:pi:agent-abc", k.did.as_str(), 1000, None, new_nonce());
        let att = sign_ownership(&s, &k).unwrap();
        let v = verify_ownership(&att, &VerifyOpts { now_ms: 1000, ..Default::default() });
        assert!(v.ok, "{:?}", v.reasons);
        assert!(v.owner_sig_ok);
        assert_eq!(v.wallet_self_proving, None, "agent 不是钱包, 不该有自证标记");
    }

    #[test]
    fn cannot_sign_for_someone_else() {
        let k = kp();
        let s = agent_statement("did:pi:agent-abc", "did:pi:someoneElse", 1, None, new_nonce());
        let err = sign_ownership(&s, &k).unwrap_err();
        assert!(matches!(err, OwnershipError::DidNotSigner { .. }), "{err}");
    }

    #[test]
    fn tampered_statement_rejected() {
        let mut att = agent_att(1000);
        att.statement.subject_id = "did:pi:evil-agent".into(); // 改正文不重签
        let v = verify_ownership(&att, &VerifyOpts { now_ms: 1000, ..Default::default() });
        assert!(!v.ok);
        assert!(v.reasons.contains(&"statement_canonical".to_string()), "{:?}", v.reasons);
        assert!(!v.owner_sig_ok, "canonical 重算后签名对不上 ⇒ 验不过");
    }

    #[test]
    fn tampered_signature_rejected() {
        let mut att = agent_att(1000);
        let mut sig = hex::decode(&att.owner_sig).unwrap();
        sig[0] ^= 0xff;
        att.owner_sig = hex::encode(sig);
        let v = verify_ownership(&att, &VerifyOpts { now_ms: 1000, ..Default::default() });
        assert!(!v.ok && !v.owner_sig_ok);
    }

    #[test]
    fn expired_owner_ship_rejected() {
        let k = kp();
        let s = agent_statement("did:pi:a", k.did.as_str(), 1000, Some(2000), new_nonce());
        let att = sign_ownership(&s, &k).unwrap();
        assert!(verify_ownership(&att, &VerifyOpts { now_ms: 1500, ..Default::default() }).ok);
        let v = verify_ownership(&att, &VerifyOpts { now_ms: 2001, ..Default::default() });
        assert!(!v.ok && v.reasons.contains(&"not_expired".to_string()));
    }

    #[test]
    fn nonce_reuse_is_rejected() {
        let k = kp();
        let nonce = new_nonce();
        let a1 = sign_ownership(&agent_statement("did:pi:a", k.did.as_str(), 1, None, nonce.clone()), &k).unwrap();
        let a2 = sign_ownership(&agent_statement("did:pi:b", k.did.as_str(), 1, None, nonce.clone()), &k).unwrap();
        let mut index = std::collections::HashMap::new();
        index.insert(nonce, a1.id.clone());
        let v = verify_ownership(&a2, &VerifyOpts { now_ms: 1, nonces: Some(index), ..Default::default() });
        assert!(!v.ok && v.reasons.contains(&"nonce_unused".to_string()), "{:?}", v.reasons);
    }

    #[test]
    fn wallet_ownership_is_honest_about_not_self_proving() {
        let k = kp();
        let addr = "0x6a3f797592bed028f6afd6da82339c8e815480eb";
        let s = wallet_statement(addr, k.did.as_str(), 1000, None, new_nonce());
        let att = sign_ownership(&s, &k).unwrap();
        let v = verify_ownership(&att, &VerifyOpts { now_ms: 1000, ..Default::default() });
        // DID 侧是真的…
        assert!(v.ok, "{:?}", v.reasons);
        assert!(v.owner_sig_ok);
        // …但钱包所有权**没有**被自证, 这一点必须写得见人
        assert_eq!(v.wallet_self_proving, Some(false));
        assert!(v.wallet_note.is_some());
        // 严格模式要自证 ⇒ 直接判红 (不能糊过去)
        let strict = verify_ownership(&att, &VerifyOpts { now_ms: 1000, require_wallet_proof: true, ..Default::default() });
        assert!(!strict.ok, "要求钱包自证时必须红");
        assert!(strict.reasons.contains(&"wallet_self_proving".to_string()));
    }

    #[test]
    fn contact_ownership_covers_phone_and_email() {
        let k = kp();
        for kind in [SubjectKind::Phone, SubjectKind::Email] {
            let s = contact_statement("blind-hash-abc", kind, k.did.as_str(), 1000, None, new_nonce());
            let att = sign_ownership(&s, &k).unwrap();
            let v = verify_ownership(&att, &VerifyOpts { now_ms: 1000, ..Default::default() });
            assert!(v.ok, "{kind:?}: {:?}", v.reasons);
        }
    }

    #[test]
    fn id_is_stable_and_content_derived() {
        let a = agent_att(1000);
        let b = agent_att(1000);
        assert_ne!(a.id, b.id, "nonce 不同 ⇒ id 不同");
        assert!(a.id.starts_with("own-"));
        assert_eq!(a.id.len(), "own-".len() + 16);
    }
}
