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
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct FriendBook {
    requests: Vec<FriendRequest>,
    /// 已接受的好友 DID 集
    friends: Vec<String>,
}

impl FriendBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// 待处理请求 (只读)
    pub fn requests(&self) -> &[FriendRequest] {
        &self.requests
    }

    /// 好友列表 (只读)
    pub fn friends(&self) -> &[String] {
        &self.friends
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

    // ────────────────────────── 通讯录名片本 (2026-10-28) ──────────────────────────
    //
    // 需求: 「通讯录 —— 顶部搜索框, 搜手机号或名称找出特定的人」。
    //
    // 手机号/邮箱那条路本身就是**跨机**的 (真 HTTP 打到已登记对端的 /api/directory/rpc,
    // 对端用自己的 pepper 查自己的目录), 不需要本结构体参与。
    //
    // 但「**按名称搜**」此前没有任何数据可搜: `FriendBook.friends` 只存裸 DID 字符串。
    // 名称不像联系方式那样能做盲化索引 —— 所以这里新增一张**本机名片本**:
    // DID → 名字的映射, 它就是「这个名字叫什么」的唯一真源 (不是再开的全局 Map /
    // 不是 session singleton)。名字**只在本地**, 不随任何对外协议同步出去。

    /// 通讯录里的一张名片
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ContactCard {
        /// 好友 DID (身份唯一锚; 名字可变, DID 不变)
        pub did: String,
        /// 备注名 / 昵称 (用户可控)
        pub name: String,
        /// 名字来源: `user` 手填 · `directory` 目录命中带来的自报名
        #[serde(default = "default_card_source")]
        pub source: String,
        #[serde(default)]
        pub added_at_ms: u64,
    }

    fn default_card_source() -> String {
        "user".into()
    }

    #[derive(Debug, thiserror::Error, PartialEq)]
    pub enum ContactError {
        #[error("DID 与名字都不能为空 (空名字不算搜索结果)")]
        Empty,
    }

    /// 本机名片本 (持久化; 名字的唯一出处)
    #[derive(Debug, Clone, Default, Serialize, Deserialize)]
    pub struct ContactBook {
        #[serde(default)]
        entries: Vec<ContactCard>,
    }

    /// 名称命中判定 (纯函数): 名字或 DID 的子串, 大小写不敏感; 空查询命中全部。
    pub fn card_matches(card: &ContactCard, query: &str) -> bool {
        let q = query.trim().to_lowercase();
        if q.is_empty() {
            return true;
        }
        card.name.to_lowercase().contains(&q) || card.did.to_lowercase().contains(&q)
    }

    impl ContactBook {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn all(&self) -> &[ContactCard] {
            &self.entries
        }

        pub fn len(&self) -> usize {
            self.entries.len()
        }

        pub fn is_empty(&self) -> bool {
            self.entries.is_empty()
        }

        /// 这个 DID 叫啥 (没备注 = None, UI 回退显示短 DID)
        pub fn name_of(&self, did: &str) -> Option<&str> {
            self.entries.iter().find(|c| c.did == did).map(|c| c.name.as_str())
        }

        /// 新增或改名 —— 同一 DID 只留一条 (改名不产生重影)
        pub fn upsert(
            &mut self,
            did: &str,
            name: &str,
            source: &str,
            now_ms: u64,
        ) -> Result<ContactCard, ContactError> {
            let name = name.trim();
            if did.trim().is_empty() || name.is_empty() {
                return Err(ContactError::Empty);
            }
            if let Some(c) = self.entries.iter_mut().find(|c| c.did == did) {
                c.name = name.to_string();
                c.source = source.to_string();
                return Ok(c.clone());
            }
            let card = ContactCard {
                did: did.to_string(),
                name: name.to_string(),
                source: source.to_string(),
                added_at_ms: now_ms,
            };
            self.entries.push(card.clone());
            Ok(card)
        }

        pub fn remove(&mut self, did: &str) -> bool {
            let before = self.entries.len();
            self.entries.retain(|c| c.did != did);
            before != self.entries.len()
        }

        /// 名称/DID 子串搜索 (大小写不敏感; 空串 = 全量)
        pub fn search(&self, query: &str) -> Vec<ContactCard> {
            self.entries
                .iter()
                .filter(|c| card_matches(c, query))
                .cloned()
                .collect()
        }
    }

    /// 合并视图: 好友 (裸 DID) ∪ 名片本 ⇒ 每个 DID 一条, 名字以名片本为准。
    ///
    /// 好友不一定有备注; 没备注的名片 `name` 为空串, 由展示层回退显示短 DID
    /// (**不在这里伪造一个名字**)。
    pub fn merge_directory_view(book: &ContactBook, friends: &[String]) -> Vec<ContactCard> {
        let mut out: Vec<ContactCard> = vec![];
        for did in friends {
            if out.iter().any(|c| c.did == *did) {
                continue;
            }
            let known = book.name_of(did);
            out.push(ContactCard {
                did: did.clone(),
                name: known.unwrap_or("").to_string(),
                source: if known.is_some() { "friend".into() } else { "".into() },
                added_at_ms: 0,
            });
        }
        // 名片本里有、但还不是好友的 (搜之前先"存个名字"或目录命中过)
        for c in book.all() {
            if out.iter().any(|x| x.did == c.did) {
                continue;
            }
            out.push(c.clone());
        }
        out
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

    // ── 通讯录名片本 (2026-10-28) ──

    #[test]
    fn contact_upsert_is_one_card_per_did() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:a", "Leo", "user", 1).unwrap();
        b.upsert("did:pi:a", "老李", "user", 2).unwrap();
        assert_eq!(b.len(), 1, "改名不产生重影");
        assert_eq!(b.name_of("did:pi:a"), Some("老李"), "后写的名字生效");
    }

    #[test]
    fn contact_search_by_name_is_case_insensitive() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:a", "Leo", "user", 1).unwrap();
        b.upsert("did:pi:b", "张三", "user", 2).unwrap();
        assert_eq!(b.search("leo").len(), 1, "大小写不敏感");
        assert_eq!(b.search("张").len(), 1);
        assert!(b.search("不存在的人").is_empty());
    }

    #[test]
    fn contact_search_by_did_substring() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:FRFhRUCx", "Leo", "user", 1).unwrap();
        assert_eq!(b.search("FRFh").len(), 1, "拿 DID 片段也能搜到");
    }

    #[test]
    fn empty_query_matches_everything_and_bad_input_refused() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:a", "Leo", "user", 1).unwrap();
        b.upsert("did:pi:b", "张三", "user", 2).unwrap();
        assert_eq!(b.search("").len(), 2, "空查询 = 全量");
        assert!(card_matches(&ContactCard { did: "d".into(), name: "n".into(), source: "u".into(), added_at_ms: 0 }, ""));

        assert_eq!(b.upsert("", "Leo", "user", 3).unwrap_err(), ContactError::Empty);
        assert_eq!(b.upsert("did:pi:c", "  ", "user", 4).unwrap_err(), ContactError::Empty, "空名字不算结果");
        assert_eq!(b.len(), 2, "拒绝时不落库");
    }

    #[test]
    fn contact_remove_and_name_of_unknown() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:a", "Leo", "user", 1).unwrap();
        assert!(b.remove("did:pi:a"));
        assert!(!b.remove("did:pi:a"), "第二次不存在的删除如实 false");
        assert!(b.is_empty());
        assert_eq!(b.name_of("did:pi:zzz"), None);
    }

    #[test]
    fn merge_view_does_not_invent_names() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:named", "Leo", "user", 1).unwrap();
        let friends = vec!["did:pi:named".to_string(), "did:pi:bare".to_string()];
        let view = merge_directory_view(&b, &friends);
        assert_eq!(view.len(), 2, "好友去重后 2 条");
        let named = view.iter().find(|c| c.did == "did:pi:named").unwrap();
        assert_eq!(named.name, "Leo");
        let bare = view.iter().find(|c| c.did == "did:pi:bare").unwrap();
        assert_eq!(bare.name, "", "没备注的好友名字为空串, 由展示层回退短 DID — 不在这里编名字");
        // 名片本里不是好友的人也要在通讯录里可见
        b.upsert("did:pi:stranger", "阿强", "directory", 5).unwrap();
        let view2 = merge_directory_view(&b, &friends);
        assert_eq!(view2.len(), 3);
        assert_eq!(view2.iter().find(|c| c.did == "did:pi:stranger").unwrap().name, "阿强");
    }

    #[test]
    fn contact_book_survives_json_roundtrip() {
        let mut b = ContactBook::new();
        b.upsert("did:pi:a", "Leo", "user", 7).unwrap();
        let raw = serde_json::to_string(&b).unwrap();
        let back: ContactBook = serde_json::from_str(&raw).unwrap();
        assert_eq!(back.name_of("did:pi:a"), Some("Leo"));
        // 旧状态文件没有 contacts 字段也能读进来 (NativeState 用 #[serde(default)])
        let back2: ContactBook = serde_json::from_str("{}").unwrap();
        assert!(back2.is_empty());
    }
}
