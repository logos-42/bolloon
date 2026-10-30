//! 人类目录 — 手机号 / 邮箱盲化目录 + **跨机查询与加好友**
//!
//! 完全对齐 TS `agents/contacts/human-directory.ts` + `agents/contacts/directory-rpc.ts`:
//!
//! - **盲化**: `HMAC-SHA256(pepper, "{salt}||{normalized}")` → hex
//!   (per-user salt 使哈希不可离线枚举; pepper 换 → 哈希全变)
//! - **归一化**: phone 只留数字与 `+`; email trim + 小写; `sniff_kind` 按 `@` 判
//! - **形状校验**: phone 8-15 位; email 标准形态 — 不 plausible 直接 found:false (不猜)
//! - **目录**: publish(生成 salt+盲化) / lookup(按条目 kind 重算比对, 撤销返回 revoked) /
//!   retract(软删) / summarize
//! - **跨机查询 (v3 帧)**: op `agent.directory.lookup` → 对端 reply `…lookup.reply`,
//!   **rpcId 匹配**才收 (防串台), 超时 4000ms, 多 reply `pick_first_hit` (全 miss → found:false)
//! - **接收侧**: `foreign_lookup` 用**本机 pepper** 查本机目录 (对端拿不到我的 pepper)
//! - **跨机加好友**: lookup 命中拿到 did + publicKeyHex → 走 contacts 的 consent 状态机
//!
//! 诚实边界: 传输走 `DirectoryTransport` 端口注入 (真跨机接 gossip/iroh; 测试用内存双节点)。

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use bolloon_p2p::attestation::{
    OwnershipAttestation, SubjectKind, VerifyOpts, canonical_statement, contact_statement,
    new_nonce, ownership_id, sign_ownership, verify_ownership,
};
use bolloon_p2p::identity::KeyPair;

use crate::contacts::{FriendBook, FriendRequestStatus};

/// 目录 kind → attestation subject (手机号/邮箱 = 「这个联系方式归我」的声明)
fn kind_to_subject(k: ContactKind) -> SubjectKind {
    match k {
        ContactKind::Phone => SubjectKind::Phone,
        ContactKind::Email => SubjectKind::Email,
    }
}

// ────────────────────────── kind / 归一化 / 校验 ──────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContactKind {
    Phone,
    Email,
}

impl ContactKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Phone => "phone",
            Self::Email => "email",
        }
    }
}

/// 从值嗅探 kind: 标准邮箱形态 → email, 否则 phone
pub fn sniff_kind(value: &str) -> ContactKind {
    let v = value.trim();
    let at = v.find('@');
    match at {
        Some(i) if i > 0 && {
            let domain = &v[i + 1..];
            domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
        } => ContactKind::Email,
        _ => ContactKind::Phone,
    }
}

/// 手机号归一化 (只留数字与 +)
pub fn normalize_phone(value: &str) -> String {
    value.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect()
}

/// 邮箱归一化 (trim + 小写)
pub fn normalize_email(value: &str) -> String {
    value.trim().to_lowercase()
}

pub fn normalize_contact(value: &str, kind: ContactKind) -> String {
    match kind {
        ContactKind::Phone => normalize_phone(value),
        ContactKind::Email => normalize_email(value),
    }
}

/// 手机号形状 (宽松: 8-15 位, 可带 +)
pub fn is_plausible_phone(value: &str) -> bool {
    let n = normalize_phone(value);
    let digits = n.trim_start_matches('+');
    !digits.is_empty() && digits.len() >= 8 && digits.len() <= 15 && digits.chars().all(|c| c.is_ascii_digit())
}

/// 邮箱形状
pub fn is_plausible_email(value: &str) -> bool {
    sniff_kind(value) == ContactKind::Email && !normalize_email(value).starts_with('@')
}

pub fn is_plausible_contact(value: &str, kind: ContactKind) -> bool {
    match kind {
        ContactKind::Phone => is_plausible_phone(value),
        ContactKind::Email => is_plausible_email(value),
    }
}

/// 盲化哈希: HMAC-SHA256(pepper, "{salt}||{normalized}") → hex
pub fn blind_hash(value: &str, kind: ContactKind, salt: &str, pepper: &str) -> String {
    let normalized = normalize_contact(value, kind);
    blind_hash_normalized(&normalized, salt, pepper)
}

pub fn blind_hash_normalized(normalized: &str, salt: &str, pepper: &str) -> String {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(pepper.as_bytes())
        .expect("HMAC 接受任意长度 key");
    mac.update(format!("{salt}||{normalized}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

// ────────────────────────── 目录条目与存储 ──────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DirectoryEntry {
    /// 盲化哈希 (HMAC，不是明文)
    pub blind: String,
    /// per-user salt (发布时生成)
    pub salt: String,
    pub kind: ContactKind,
    pub did: String,
    /// P2P 好友用的公钥 hex (lookup 直达加好友, 免 DID 解码)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    pub published_at_ms: u64,
    /// 撤销指针 (软删)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revoked_at_ms: Option<u64>,
    /// 所有者签名 hex (防目录伪造条目); **空 = 没签 ⇒ 查询结果 verified=false**
    #[serde(default)]
    pub owner_sig: String,
    /// 签发时的一次性 nonce (验签要重建 statement, 所以必须留着)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_nonce: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookupResult {
    pub found: bool,
    pub revoked: bool,
    pub did: Option<&'static str>,
}

/// 查询结果 (owned, 便于跨函数返回)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LookupHit {
    pub found: bool,
    #[serde(default)]
    pub did: Option<String>,
    #[serde(default)]
    pub public_key_hex: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub revoked: bool,
    /// 2026-10-26: owner_sig 验签结果 — **加好友只认 true**
    /// (没签名的条目 = 谁都可以往里写 did ⇒ 不可信, 同 TS human-directory 口径)
    #[serde(default)]
    pub verified: bool,
}

/// 人类目录 (本机)
#[derive(Debug, Default)]
pub struct HumanDirectory {
    pub entries: Vec<DirectoryEntry>,
    next_id: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum DirectoryError {
    #[error("联系方式形状不对 ({kind:?}) — 不猜, 直接不入库")]
    Implausible { kind: ContactKind },
    #[error("该联系方式已在目录里 (幂等)")]
    AlreadyPublished,
    #[error("条目不存在")]
    NotFound,
    /// 归属签名失败 (多半是「声明的 did 不是这把钥匙」— 不许替别人签)
    #[error("归属签名失败 (不许替别人签): {0}")]
    Sign(String),
}

impl HumanDirectory {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发布 (生成 salt + 盲化; 明文绝不入库)
    pub fn publish(
        &mut self,
        value: &str,
        did: &str,
        pepper: &str,
        display_name: Option<&str>,
        public_key_hex: Option<&str>,
        now_ms: u64,
    ) -> Result<&DirectoryEntry, DirectoryError> {
        let kind = sniff_kind(value);
        if !is_plausible_contact(value, kind) {
            return Err(DirectoryError::Implausible { kind });
        }
        let normalized = normalize_contact(value, kind);
        // 幂等: 同 normalized + 同 did 已在 → 返回既有
        if let Some(_e) = self
            .entries
            .iter()
            .find(|e| e.kind == kind && e.did == did && blind_hash_normalized(&normalized, &e.salt, pepper) == e.blind)
        {
            return Err(DirectoryError::AlreadyPublished);
        }
        let salt = format!("salt-{:016x}", self.next_id + now_ms.wrapping_mul(2654435761) % 0xffff_ffff);
        self.next_id += 1;
        let blind = blind_hash_normalized(&normalized, &salt, pepper);
        let entry = DirectoryEntry {
            blind,
            salt,
            kind,
            did: did.into(),
            public_key_hex: public_key_hex.map(|s| s.into()),
            display_name: display_name.map(|s| s.into()),
            published_at_ms: now_ms,
            revoked_at_ms: None,
            owner_sig: String::new(),
            owner_nonce: None,
        };
        self.entries.push(entry);
        Ok(self.entries.last().unwrap())
    }

    /// **带 DID 签名**的发布 (推荐入口) —— 「这个联系方式归我」这件事由
    /// 本 keypair 的 Ed25519 签名背书; 别人拿不到这把私钥就造不出这条绑定。
    ///
    /// - `did` 必须就是 `kp.did` (不许替别人签, attestation 层会拦)
    /// - 自验不过 ⇒ **拒入库** (与 TS address-binding 同范式)
    // 入参是这条绑定声明的全部事实 (值/归属 did/pepper/显示名/公钥/有效期…), 拆结构体只会多一层
    #[allow(clippy::too_many_arguments)]
    pub fn publish_signed(
        &mut self,
        value: &str,
        did: &str,
        pepper: &str,
        display_name: Option<&str>,
        public_key_hex: Option<&str>,
        kp: &KeyPair,
        now_ms: u64,
    ) -> Result<DirectoryEntry, DirectoryError> {
        self.publish(value, did, pepper, display_name, public_key_hex, now_ms)?;
        let e = self.entries.last_mut().ok_or(DirectoryError::NotFound)?;
        let nonce = new_nonce();
        let stmt = contact_statement(
            &e.blind,
            kind_to_subject(e.kind),
            &e.did,
            e.published_at_ms,
            None,
            nonce.clone(),
        );
        let att = sign_ownership(&stmt, kp).map_err(|err| DirectoryError::Sign(err.to_string()))?;
        e.owner_sig = att.owner_sig;
        e.owner_nonce = Some(nonce);
        Ok(e.clone())
    }

    /// 验某条目的 owner_sig (重建 statement → attestation 验签)
    pub fn verify_entry(e: &DirectoryEntry) -> bool {
        verify_entry(e)
    }

    /// 查询 (按条目 kind + salt 重算比对; 撤销条目返回 found+revoked)
    pub fn lookup(&self, value: &str, pepper: &str) -> LookupHit {
        let kind = sniff_kind(value);
        if !is_plausible_contact(value, kind) {
            return LookupHit::miss(); // 形状不对 → 不猜
        }
        let normalized = normalize_contact(value, kind);
        for e in &self.entries {
            if e.kind != kind {
                continue;
            }
            if blind_hash_normalized(&normalized, &e.salt, pepper) == e.blind {
                return LookupHit {
                    found: true,
                    did: Some(e.did.clone()),
                    public_key_hex: e.public_key_hex.clone(),
                    display_name: e.display_name.clone(),
                    revoked: e.revoked_at_ms.is_some(),
                    verified: verify_entry(e),
                };
            }
        }
        LookupHit::miss()
    }

    /// 撤销 (软删, 保留指针)
    pub fn retract(&mut self, blind: &str, now_ms: u64) -> Result<(), DirectoryError> {
        let e = self
            .entries
            .iter_mut()
            .find(|e| e.blind == blind)
            .ok_or(DirectoryError::NotFound)?;
        e.revoked_at_ms = Some(now_ms);
        Ok(())
    }

    /// 摘要 (不含明文/pepper)
    pub fn summarize(&self) -> Vec<serde_json::Value> {
        self.entries
            .iter()
            .map(|e| {
                serde_json::json!({
                    "hash": e.blind, "did": e.did, "kind": e.kind.as_str(),
                    "publishedAt": e.published_at_ms, "revoked": e.revoked_at_ms.is_some(),
                })
            })
            .collect()
    }
}

/// 验某条目的 owner_sig: 用落盘字段**重建** statement, 再走 attestation 验签。
///
/// 为什么必须能重建: 签名对象是 statement 的 canonical 字节串, nonce/did/blind/published_at
/// 缺一个都复现不出来 —— 这正是 [`DirectoryEntry::owner_nonce`] 存在的理由。
pub fn verify_entry(e: &DirectoryEntry) -> bool {
    if e.owner_sig.is_empty() {
        return false; // 没签 = 不可信 (不猜, 不降级)
    }
    let Some(nonce) = e.owner_nonce.clone() else {
        return false;
    };
    let stmt = contact_statement(
        &e.blind,
        kind_to_subject(e.kind),
        &e.did,
        e.published_at_ms,
        None,
        nonce,
    );
    let canonical = canonical_statement(&stmt);
    let att = OwnershipAttestation {
        id: ownership_id(&canonical),
        statement: stmt,
        statement_json: canonical,
        owner_sig: e.owner_sig.clone(),
        wallet_sig: None,
    };
    verify_ownership(
        &att,
        &VerifyOpts {
            now_ms: e.published_at_ms,
            ..VerifyOpts::default()
        },
    )
    .ok
}

impl LookupHit {
    pub fn miss() -> Self {
        Self {
            found: false,
            did: None,
            public_key_hex: None,
            display_name: None,
            revoked: false,
            verified: false,
        }
    }
}

// ────────────────────────── 跨机查询协议 (directory-rpc v3) ──────────────────────────

pub const DIRECTORY_LOOKUP_OP: &str = "agent.directory.lookup";
pub const DIRECTORY_LOOKUP_REPLY_OP: &str = "agent.directory.lookup.reply";
pub const DIRECTORY_LOOKUP_TIMEOUT_MS: u64 = 4000;

/// 查询帧 (v3, 对齐 TS DirectoryLookupRpc)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LookupRpc {
    pub v: u32,
    pub op: String,
    pub payload: LookupRpcPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LookupRpcPayload {
    pub rpc_id: String,
    /// 兼容旧字段名 (承载 contact 值)
    pub phone: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contact: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<ContactKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_public_key: Option<String>,
}

/// 回复帧 (v3)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LookupReply {
    pub v: u32,
    pub op: String,
    pub payload: LookupReplyPayload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LookupReplyPayload {
    pub rpc_id: String,
    pub found: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub did: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key_hex: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// 对端目录条目的验签结果 (**跟着 reply 一起过线**, 否则接收方分不清"命中"和"可信")
    #[serde(default)]
    pub verified: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub fn build_lookup_rpc(
    rpc_id: &str,
    contact: &str,
    kind: Option<ContactKind>,
    from_public_key: Option<&str>,
) -> LookupRpc {
    LookupRpc {
        v: 3,
        op: DIRECTORY_LOOKUP_OP.into(),
        payload: LookupRpcPayload {
            rpc_id: rpc_id.into(),
            phone: contact.into(), // 兼容旧字段
            contact: Some(contact.into()),
            kind,
            from_public_key: from_public_key.map(|s| s.into()),
        },
    }
}

pub fn build_lookup_reply(rpc_id: &str, hit: LookupHit) -> LookupReply {
    LookupReply {
        v: 3,
        op: DIRECTORY_LOOKUP_REPLY_OP.into(),
        payload: LookupReplyPayload {
            rpc_id: rpc_id.into(),
            found: hit.found,
            did: hit.did,
            public_key_hex: hit.public_key_hex,
            display_name: hit.display_name,
            verified: hit.verified,
            error: None,
        },
    }
}

/// 发送侧过滤: reply 的 rpcId 必须匹配我发的查询 (防串台/重放)
pub fn is_lookup_reply_for(reply: &LookupReply, rpc_id: &str) -> bool {
    reply.op == DIRECTORY_LOOKUP_REPLY_OP && reply.payload.rpc_id == rpc_id
}

/// 多对端 reply 取首个命中 (全 miss → found:false)
pub fn pick_first_hit(replies: &[LookupHit]) -> LookupHit {
    replies.iter().find(|r| r.found).cloned().unwrap_or_else(LookupHit::miss)
}

/// 接收侧: 用**本机 pepper** 在本机目录查别人给我的联系方式
/// (形状不对 → found:false, 不猜; 对端拿不到我的 pepper)
pub fn foreign_lookup(dir: &HumanDirectory, contact: &str, kind: Option<ContactKind>, pepper: &str) -> LookupHit {
    let k = kind.unwrap_or_else(|| sniff_kind(contact));
    if !is_plausible_contact(contact, k) {
        return LookupHit::miss();
    }
    dir.lookup(contact, pepper)
}

// ────────────────────────── 跨机传输端口 ──────────────────────────

/// 跨机查询传输端口 (真实现接 gossip/iroh; 测试用内存)
pub trait DirectoryTransport {
    /// 广播查询帧, 收集各对端 reply (命中/未命中都收, 超时由实现保证)
    fn lookup(&self, rpc: &LookupRpc) -> Vec<LookupReply>;
}

/// 跨机查询主入口: 广播 → 收 reply → **rpcId 匹配过滤** → 取首个命中
pub fn lookup_remote(
    transport: &dyn DirectoryTransport,
    rpc_id: &str,
    contact: &str,
    kind: Option<ContactKind>,
) -> LookupHit {
    let rpc = build_lookup_rpc(rpc_id, contact, kind, None);
    let replies: Vec<LookupHit> = transport
        .lookup(&rpc)
        .into_iter()
        .filter(|r| is_lookup_reply_for(r, rpc_id)) // 串台 reply 不入
        .map(|r| LookupHit {
            found: r.payload.found,
            did: r.payload.did,
            public_key_hex: r.payload.public_key_hex,
            display_name: r.payload.display_name,
            revoked: false,
            verified: r.payload.verified,
        })
        .collect();
    pick_first_hit(&replies)
}

/// **跨机加好友**: 查到 did/publicKeyHex → 走 contacts consent 状态机 (不自动通过)
pub fn remote_add_friend(
    hit: &LookupHit,
    contacts: &mut FriendBook,
    from_did: &str,
    now_ms: u64,
) -> Result<String, String> {
    if !hit.found {
        return Err("未查到该联系方式 (对端没发布或已撤销)".into());
    }
    let did = hit.did.clone().ok_or("命中但缺少 did")?;
    if hit.revoked {
        return Err("该条目已撤销".into());
    }
    // fail-closed: 没有有效 DID 归属签名的条目 = 谁都能往里写 did ⇒ 拒绝用它加好友
    if !hit.verified {
        return Err(
            "该条目没有有效的 DID 归属签名 (verified=false) — 不可信, 拒绝加好友".into(),
        );
    }
    let r = contacts.inbound(&did, &hit.display_name.clone().unwrap_or_else(|| did.clone()), now_ms);
    if r.status != FriendRequestStatus::Pending {
        return Ok(format!("已有请求 ({:?}) — 幂等, 不重复", r.status));
    }
    Ok(format!("已向 {from_did} 的联系人目录发起好友请求 → {did} (待对方同意)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &str = "pepper-abc-32-bytes-0000000000000000";

    fn dir_with_phone() -> HumanDirectory {
        let mut d = HumanDirectory::new();
        d.publish("+86 131-1571-8038", "did:key:alice", PEPPER, Some("Alice"), Some("aabb"), 1000)
            .unwrap();
        d
    }

    /// **带 DID 签名**的目录 (常识路径; 加好友只认这种条目的 verified)
    fn signed_dir_with_phone(kp: &KeyPair) -> HumanDirectory {
        let mut d = HumanDirectory::new();
        d.publish_signed(
            "+86 131-1571-8038",
            kp.did.as_str(),
            PEPPER,
            Some("Alice"),
            Some("aabb"),
            kp,
            1000,
        )
        .unwrap();
        d
    }

    // ── 归一化 / 校验 ──

    #[test]
    fn normalize_and_sniff() {
        assert_eq!(normalize_phone("+86 131-1571-8038"), "+8613115718038");
        assert_eq!(normalize_email("  Leo@Example.COM "), "leo@example.com");
        assert_eq!(sniff_kind("leo@example.com"), ContactKind::Email);
        assert_eq!(sniff_kind("13115718038"), ContactKind::Phone);
    }

    #[test]
    fn plausible_gates() {
        assert!(is_plausible_phone("+8613115718038"));
        assert!(!is_plausible_phone("123")); // 太短
        assert!(!is_plausible_phone("12345678901234567890")); // 太长
        assert!(is_plausible_email("a@b.com"));
        assert!(!is_plausible_email("not-an-email"));
        // 不 plausible → 查询直接 miss (不猜)
        let d = dir_with_phone();
        assert!(!d.lookup("123", PEPPER).found);
    }

    #[test]
    fn email_size_case_insensitive() {
        // 邮箱大小写不敏感 → 归一化后同一哈希
        assert_eq!(
            blind_hash("Leo@Example.com", ContactKind::Email, "s", PEPPER),
            blind_hash("leo@example.com", ContactKind::Email, "s", PEPPER)
        );
    }

    // ── 盲化 ──

    #[test]
    fn blind_hash_stable_and_pepper_sensitive() {
        let h1 = blind_hash("+8613115718038", ContactKind::Phone, "salt1", PEPPER);
        let h2 = blind_hash("+86 131-1571-8038", ContactKind::Phone, "salt1", PEPPER);
        assert_eq!(h1, h2, "归一化后同一输入 → 同一哈希");
        let h3 = blind_hash("+8613115718038", ContactKind::Phone, "salt2", PEPPER);
        assert_ne!(h1, h3, "salt 不同 → 哈希不同 (不可离线枚举)");
        let h4 = blind_hash("+8613115718038", ContactKind::Phone, "salt1", "other-pepper");
        assert_ne!(h1, h4, "pepper 换 → 哈希全变");
    }

    #[test]
    fn no_plaintext_in_entry() {
        let d = dir_with_phone();
        let raw = serde_json::to_string(&d.entries).unwrap();
        assert!(!raw.contains("13115718038"), "目录里绝不能出现明文手机号");
        assert!(!raw.contains(PEPPER), "目录里绝不能出现 pepper");
    }

    // ── 发布 / 查询 / 撤销 ──

    #[test]
    fn publish_lookup_phone_and_email() {
        let mut d = HumanDirectory::new();
        d.publish("+8613115718038", "did:key:alice", PEPPER, Some("Alice"), Some("aa"), 1)
            .unwrap();
        d.publish("leo@example.com", "did:key:leo", PEPPER, Some("Leo"), Some("bb"), 2)
            .unwrap();
        let p = d.lookup("+86 131-1571-8038", PEPPER);
        assert!(p.found && p.did.as_deref() == Some("did:key:alice"));
        assert_eq!(p.public_key_hex.as_deref(), Some("aa"));
        let e = d.lookup("LEO@EXAMPLE.COM", PEPPER);
        assert!(e.found && e.did.as_deref() == Some("did:key:leo"), "邮箱跨大小写命中");
        // 未发布的
        assert!(!d.lookup("+8613900000000", PEPPER).found);
    }

    #[test]
    fn publish_rejects_implausible_and_duplicates() {
        let mut d = HumanDirectory::new();
        assert_eq!(
            d.publish("123", "did:x", PEPPER, None, None, 1).unwrap_err(),
            DirectoryError::Implausible { kind: ContactKind::Phone }
        );
        d.publish("+8613115718038", "did:key:a", PEPPER, None, None, 1).unwrap();
        assert_eq!(
            d.publish("+86 131-1571-8038", "did:key:a", PEPPER, None, None, 2).unwrap_err(),
            DirectoryError::AlreadyPublished,
            "幂等: 同人同号重复发布不覆盖"
        );
    }

    #[test]
    fn retract_is_soft_delete_with_revoked_flag() {
        let mut d = dir_with_phone();
        let blind = d.entries[0].blind.clone();
        d.retract(&blind, 2000).unwrap();
        let hit = d.lookup("+8613115718038", PEPPER);
        assert!(hit.found && hit.revoked, "撤销后: 找得到但标 revoked");
        assert_eq!(d.retract("nope", 1).unwrap_err(), DirectoryError::NotFound);
    }

    #[test]
    fn summarize_has_no_plaintext() {
        let d = dir_with_phone();
        let s = serde_json::to_string(&d.summarize()).unwrap();
        assert!(s.contains("did:key:alice") && s.contains("revoked"));
        assert!(!s.contains("13115718038"));
    }

    // ── 跨机查询协议 ──

    struct TwoNode<'a> {
        a: &'a HumanDirectory,
        b: &'a HumanDirectory,
        pepper_a: &'a str,
        pepper_b: &'a str,
    }

    impl DirectoryTransport for TwoNode<'_> {
        fn lookup(&self, rpc: &LookupRpc) -> Vec<LookupReply> {
            let contact = rpc.payload.contact.clone().unwrap_or_else(|| rpc.payload.phone.clone());
            let kind = rpc.payload.kind;
            vec![
                build_lookup_reply(&rpc.payload.rpc_id, foreign_lookup(self.a, &contact, kind, self.pepper_a)),
                build_lookup_reply(&rpc.payload.rpc_id, foreign_lookup(self.b, &contact, kind, self.pepper_b)),
            ]
        }
    }

    #[test]
    fn rpc_frame_shape_v3() {
        let rpc = build_lookup_rpc("rpc-1", "+8613115718038", Some(ContactKind::Phone), Some("pk"));
        assert_eq!(rpc.v, 3);
        assert_eq!(rpc.op, DIRECTORY_LOOKUP_OP);
        assert_eq!(rpc.payload.contact.as_deref(), Some("+8613115718038"));
        assert_eq!(rpc.payload.phone, "+8613115718038", "兼容旧字段同值");
        let reply = build_lookup_reply("rpc-1", LookupHit { found: true, did: Some("did:key:a".into()), ..LookupHit::miss() });
        assert_eq!(reply.op, DIRECTORY_LOOKUP_REPLY_OP);
        assert!(is_lookup_reply_for(&reply, "rpc-1"));
        assert!(!is_lookup_reply_for(&reply, "rpc-2"), "rpcId 不匹配 → 串台 reply 不收");
    }

    #[test]
    fn cross_machine_lookup_phone_hit() {
        let d_alice = dir_with_phone(); // Alice 的目录里有手机号
        let d_bob = HumanDirectory::new(); // Bob 空目录
        let t = TwoNode { a: &d_alice, b: &d_bob, pepper_a: PEPPER, pepper_b: PEPPER };
        let hit = lookup_remote(&t, "rpc-1", "+86 131-1571-8038", Some(ContactKind::Phone));
        assert!(hit.found, "跨机查到 (对端命中)");
        assert_eq!(hit.did.as_deref(), Some("did:key:alice"));
    }

    #[test]
    fn cross_machine_lookup_email_hit() {
        let mut d_alice = HumanDirectory::new();
        d_alice
            .publish("leo@example.com", "did:key:leo", PEPPER, Some("Leo"), Some("ccdd"), 1)
            .unwrap();
        let d_bob = HumanDirectory::new();
        let t = TwoNode { a: &d_alice, b: &d_bob, pepper_a: PEPPER, pepper_b: PEPPER };
        let hit = lookup_remote(&t, "rpc-2", "Leo@Example.com", Some(ContactKind::Email));
        assert!(hit.found && hit.did.as_deref() == Some("did:key:leo"), "邮箱跨机查询命中");
        assert_eq!(hit.public_key_hex.as_deref(), Some("ccdd"));
    }

    #[test]
    fn cross_machine_miss_and_pick_first_hit() {
        let d_a = HumanDirectory::new();
        let d_b = HumanDirectory::new();
        let t = TwoNode { a: &d_a, b: &d_b, pepper_a: PEPPER, pepper_b: PEPPER };
        assert!(!lookup_remote(&t, "rpc-3", "+8613115718038", None).found, "全 miss → found:false");
        // pick_first_hit 语义
        let replies = vec![LookupHit::miss(), LookupHit { found: true, did: Some("did:x".into()), ..LookupHit::miss() }];
        assert_eq!(pick_first_hit(&replies).did.as_deref(), Some("did:x"));
        assert!(!pick_first_hit(&[LookupHit::miss()]).found);
    }

    #[test]
    fn foreign_lookup_uses_local_pepper_only() {
        // 对端用自己的 pepper 查我的目录 → 查不到 (pepper 不同则哈希不匹配)
        let d = dir_with_phone();
        let hit = foreign_lookup(&d, "+8613115718038", Some(ContactKind::Phone), "wrong-pepper");
        assert!(!hit.found, "pepper 不对 → 查不到 (明文与 pepper 都不外泄)");
    }

    #[test]
    fn revoked_entry_not_usable_for_friend() {
        let mut d = dir_with_phone();
        let blind = d.entries[0].blind.clone();
        d.retract(&blind, 5).unwrap();
        let hit = d.lookup("+8613115718038", PEPPER);
        let mut contacts = FriendBook::new();
        let err = remote_add_friend(&hit, &mut contacts, "did:key:me", 6).unwrap_err();
        assert!(err.contains("撤销"), "{err}");
    }

    // ── 跨机加好友 ──

    #[test]
    fn cross_machine_add_friend_flow() {
        let alice = KeyPair::from_seed(&[42u8; 32]);
        let d_alice = signed_dir_with_phone(&alice);
        let alice_did = alice.did.as_str().to_string();
        let d_bob = HumanDirectory::new();
        let t = TwoNode { a: &d_alice, b: &d_bob, pepper_a: PEPPER, pepper_b: PEPPER };
        // Bob 用手机号跨机查 Alice
        let hit = lookup_remote(&t, "rpc-9", "+8613115718038", Some(ContactKind::Phone));
        assert!(hit.found);
        assert!(hit.verified, "跨机 reply 必须把对端的验签结果带过来");
        // 拿命中结果加好友 (走 consent 状态机, 不是自动通过)
        let mut contacts = FriendBook::new();
        let msg = remote_add_friend(&hit, &mut contacts, "did:key:bob", 10).unwrap();
        assert!(msg.contains("待对方同意"), "{msg}");
        // 请求在 pending; 对方同意后进好友列表
        let req = contacts.requests()[0].clone();
        assert_eq!(req.status, FriendRequestStatus::Pending);
        contacts.accept(&req.request_id, 11).unwrap();
        assert!(contacts.is_friend(&alice_did));
        // 幂等: 重复加
        let again = remote_add_friend(&hit, &mut contacts, "did:key:bob", 12).unwrap();
        assert!(again.contains("幂等"), "{again}");
    }

    #[test]
    fn unsigned_entry_cannot_be_friended() {
        // 这正是要堵的口子: 没签名的条目谁都能往里写 did ⇒ 不许用它加好友
        let d = dir_with_phone();
        let hit = d.lookup("+8613115718038", PEPPER);
        assert!(hit.found && !hit.verified, "没签名 ⇒ verified=false");
        let mut contacts = FriendBook::new();
        let err = remote_add_friend(&hit, &mut contacts, "did:key:me", 1).unwrap_err();
        assert!(err.contains("verified"), "{err}");
    }

    #[test]
    fn publish_signed_roundtrip_and_forged_did_rejected() {
        let kp = KeyPair::from_seed(&[77u8; 32]);
        let mut d = HumanDirectory::new();
        let e = d
            .publish_signed("+86 131-1571-8038", kp.did.as_str(), PEPPER, Some("Alice"), None, &kp, 1000)
            .unwrap();
        assert!(!e.owner_sig.is_empty());
        assert!(verify_entry(&e), "自验必须过");
        assert!(d.lookup("+8613115718038", PEPPER).verified);

        // 篡改签名 ⇒ 验不过
        let mut bad = e.clone();
        let mut sig = hex::decode(&bad.owner_sig).unwrap();
        sig[0] ^= 0xff;
        bad.owner_sig = hex::encode(sig);
        assert!(!verify_entry(&bad), "签名被改 ⇒ 验不过");

        // 声明别人的 DID ⇒ 拒入库 (拿不到别人的私钥, 签不出来)
        let other = KeyPair::from_seed(&[78u8; 32]);
        let err = d
            .publish_signed("+86 139-0000-0000", other.did.as_str(), PEPPER, None, None, &kp, 2)
            .unwrap_err();
        assert!(matches!(err, DirectoryError::Sign(_)), "{err:?}");
    }

    #[test]
    fn add_friend_requires_hit() {
        let mut contacts = FriendBook::new();
        let err = remote_add_friend(&LookupHit::miss(), &mut contacts, "did:key:me", 1).unwrap_err();
        assert!(err.contains("未查到"), "{err}");
    }
}
