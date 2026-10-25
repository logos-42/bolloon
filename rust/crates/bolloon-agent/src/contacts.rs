//! 联系人 — 手机号盲化目录 + 好友请求
//!
//! 对齐 TS 版 `agents/contacts/human-directory.ts`:
//! - 目录只存盲化哈希 (HMAC-SHA256(pepper, normalize(phone))), **明文不进目录**
//! - pepper 在本机 (目录服务端), 跨机查询走 P2P RPC (directory-rpc)
//! - 好友请求状态机: pending → accepted/rejected (consent 门: 首次联系需批)

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

/// 归一化手机号 (去空白 + 保留数字与 +)
pub fn normalize_phone(phone: &str) -> String {
    let cleaned: String = phone.chars().filter(|c| c.is_ascii_digit() || *c == '+').collect();
    if cleaned.starts_with('+') {
        cleaned
    } else if cleaned.len() == 11 && cleaned.starts_with('1') {
        format!("+86{cleaned}")
    } else {
        cleaned
    }
}

/// 目录错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum DirectoryError {
    #[error("手机号非法 (需 11 位或 +86 前缀)")]
    InvalidPhone,
    #[error("条目不存在")]
    NotFound,
}

/// 盲化哈希 = HMAC-SHA256(pepper, normalize(phone)) hex
pub fn blind_hash(pepper: &str, phone: &str) -> Result<String, DirectoryError> {
    let norm = normalize_phone(phone);
    if norm.len() < 11 {
        return Err(DirectoryError::InvalidPhone);
    }
    let mut mac = HmacSha256::new_from_slice(pepper.as_bytes())
        .map_err(|_| DirectoryError::InvalidPhone)?;
    mac.update(norm.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// 目录条目 (只存盲化哈希 + 自报名字)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DirectoryEntry {
    /// 盲化哈希 (hex)
    pub blind: String,
    /// 自报名字 (发布者可控)
    pub label: String,
    /// 发布者 DID
    pub did: String,
    pub published_at_ms: u64,
}

/// 本机目录
#[derive(Debug, Default)]
pub struct HumanDirectory {
    entries: Vec<DirectoryEntry>,
}

impl HumanDirectory {
    pub fn new() -> Self {
        Self::default()
    }

    /// 发布自己到目录 (手机号明文不落盘)
    pub fn publish(
        &mut self,
        pepper: &str,
        phone: &str,
        label: &str,
        did: &str,
        now_ms: u64,
    ) -> Result<&DirectoryEntry, DirectoryError> {
        let blind = blind_hash(pepper, phone)?;
        // 同盲化哈希 = 同一人, 更新不重复
        self.entries.retain(|e| e.blind != blind);
        self.entries.push(DirectoryEntry {
            blind,
            label: label.to_string(),
            did: did.to_string(),
            published_at_ms: now_ms,
        });
        Ok(self.entries.last().unwrap())
    }

    /// 本机查询 (用本机 pepper 重算; 跨机条目要靠 P2P RPC 到对方查)
    pub fn lookup(&self, pepper: &str, phone: &str) -> Result<Option<&DirectoryEntry>, DirectoryError> {
        let blind = blind_hash(pepper, phone)?;
        Ok(self.entries.iter().find(|e| e.blind == blind))
    }

    /// 撤回 (按盲化哈希)
    pub fn retract(&mut self, pepper: &str, phone: &str) -> Result<bool, DirectoryError> {
        let blind = blind_hash(pepper, phone)?;
        let before = self.entries.len();
        self.entries.retain(|e| e.blind != blind);
        Ok(before != self.entries.len())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// 好友请求状态机 (consent: 首次联系需批, 幂等)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FriendRequest {
    pub request_id: String,
    /// 请求方 DID
    pub from_did: String,
    /// 请求方自报盲化手机号
    pub from_blind: String,
    pub status: FriendRequestStatus,
    pub created_at_ms: u64,
    pub decided_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendRequestStatus {
    Pending,
    Accepted,
    Rejected,
}

/// 好友请求决策错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum FriendRequestError {
    #[error("请求不存在")]
    NotFound,
    #[error("请求已处理 ({0:?}) — 幂等, 不重复决定")]
    AlreadyDecided(FriendRequestStatus),
}

/// 好友请求簿
#[derive(Debug, Default)]
pub struct FriendBook {
    requests: Vec<FriendRequest>,
    /// 已接受的好友 DID 集
    friends: Vec<String>,
}

impl FriendBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收到入站请求 (同人重复请求幂等, 返回克隆)
    pub fn inbound(&mut self, from_did: &str, from_blind: &str, now_ms: u64) -> FriendRequest {
        if let Some(existing) = self.requests.iter().find(|r| r.from_did == from_did) {
            return existing.clone();
        }
        let id = format!("fr-{:06}", self.requests.len() + 1);
        self.requests.push(FriendRequest {
            request_id: id,
            from_did: from_did.into(),
            from_blind: from_blind.into(),
            status: FriendRequestStatus::Pending,
            created_at_ms: now_ms,
            decided_at_ms: None,
        });
        self.requests.last().unwrap().clone()
    }

    /// 批准 (幂等拒绝重复决定)
    pub fn accept(&mut self, request_id: &str, now_ms: u64) -> Result<(), FriendRequestError> {
        let status = self
            .requests
            .iter()
            .find(|r| r.request_id == request_id)
            .ok_or(FriendRequestError::NotFound)?
            .status;
        if status != FriendRequestStatus::Pending {
            return Err(FriendRequestError::AlreadyDecided(status));
        }
        let did = self
            .requests
            .iter()
            .find(|r| r.request_id == request_id)
            .unwrap()
            .from_did
            .clone();
        if let Some(r) = self.requests.iter_mut().find(|r| r.request_id == request_id) {
            r.status = FriendRequestStatus::Accepted;
            r.decided_at_ms = Some(now_ms);
        }
        if !self.friends.contains(&did) {
            self.friends.push(did);
        }
        Ok(())
    }

    /// 拒绝
    pub fn reject(&mut self, request_id: &str, now_ms: u64) -> Result<(), FriendRequestError> {
        let status = self
            .requests
            .iter()
            .find(|r| r.request_id == request_id)
            .ok_or(FriendRequestError::NotFound)?
            .status;
        if status != FriendRequestStatus::Pending {
            return Err(FriendRequestError::AlreadyDecided(status));
        }
        if let Some(r) = self.requests.iter_mut().find(|r| r.request_id == request_id) {
            r.status = FriendRequestStatus::Rejected;
            r.decided_at_ms = Some(now_ms);
        }
        Ok(())
    }

    pub fn is_friend(&self, did: &str) -> bool {
        self.friends.iter().any(|f| f == did)
    }

    pub fn pending(&self) -> Vec<&FriendRequest> {
        self.requests.iter().filter(|r| r.status == FriendRequestStatus::Pending).collect()
    }

    pub fn friend_count(&self) -> usize {
        self.friends.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEPPER: &str = "本机随机pepper";

    #[test]
    fn normalize_phone_cn() {
        assert_eq!(normalize_phone("13115718038"), "+8613115718038");
        assert_eq!(normalize_phone("+86 131-1571-8038"), "+8613115718038");
        assert_eq!(normalize_phone("+13115718038"), "+13115718038");
    }

    #[test]
    fn blind_hash_is_deterministic_and_pepper_bound() {
        let a = blind_hash(PEPPER, "13115718038").unwrap();
        let b = blind_hash(PEPPER, "131 1571 8038").unwrap();
        assert_eq!(a, b, "同号同 pepper 同哈希 (归一化后)");
        let c = blind_hash("另一个pepper", "13115718038").unwrap();
        assert_ne!(a, c, "换 pepper 哈希必变 (pepper 在目录服务端)");
        assert_eq!(a.len(), 64);
        // 明文不进哈希
        assert!(!a.contains("131"));
    }

    #[test]
    fn blind_hash_rejects_invalid_phone() {
        assert_eq!(blind_hash(PEPPER, "123").unwrap_err(), DirectoryError::InvalidPhone);
    }

    #[test]
    fn directory_publish_lookup_retract() {
        let mut dir = HumanDirectory::new();
        dir.publish(PEPPER, "13115718038", "Leo", "did:pi:leo", 1).unwrap();
        assert_eq!(dir.len(), 1);
        let hit = dir.lookup(PEPPER, "13115718038").unwrap().unwrap();
        assert_eq!(hit.label, "Leo");
        // 重复发布 = 更新
        dir.publish(PEPPER, "13115718038", "Leo2", "did:pi:leo", 2).unwrap();
        assert_eq!(dir.len(), 1, "同人不重复");
        assert_eq!(dir.lookup(PEPPER, "13115718038").unwrap().unwrap().label, "Leo2");
        // 撤回
        assert!(dir.retract(PEPPER, "13115718038").unwrap());
        assert!(dir.lookup(PEPPER, "13115718038").unwrap().is_none());
    }

    #[tokio::test]
    async fn friend_request_consent_flow() {
        let mut book = FriendBook::new();
        let r = book.inbound("did:pi:stranger", "abc", 1).clone();
        assert_eq!(r.status, FriendRequestStatus::Pending);
        // 同人重复请求幂等
        assert_eq!(book.inbound("did:pi:stranger", "abc", 2).request_id, r.request_id);
        assert_eq!(book.pending().len(), 1);

        book.accept(&r.request_id, 3).unwrap();
        assert!(book.is_friend("did:pi:stranger"));
        // 已处理再决定 → 拒 (幂等)
        assert_eq!(
            book.accept(&r.request_id, 4).unwrap_err(),
            FriendRequestError::AlreadyDecided(FriendRequestStatus::Accepted)
        );
    }

    #[tokio::test]
    async fn friend_request_reject_flow() {
        let mut book = FriendBook::new();
        let r = book.inbound("did:pi:x", "b", 1).clone();
        book.reject(&r.request_id, 2).unwrap();
        assert!(!book.is_friend("did:pi:x"), "拒绝不加好友");
        assert_eq!(book.friend_count(), 0);
    }

    #[tokio::test]
    async fn unknown_request_id_rejected() {
        let mut book = FriendBook::new();
        assert_eq!(book.accept("nope", 1).unwrap_err(), FriendRequestError::NotFound);
    }
}
