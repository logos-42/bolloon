//! 群聊 store — 去中心化群聊的消息存储抽象
//!
//! 对应 TS 版 OrbitDB 群聊语义（store 复制 + 创建者独占 ACL + 成员事件）:
//! - 建群默认创建者独占（acl write 白名单）
//! - 群消息带序号（append-only）
//! - 成员事件（加入/签名）单独流

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::identity::Did;

/// 群角色/ACL
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum GroupAcl {
    /// 创建者独占（默认）
    OwnerOnly,
    /// 白名单成员
    Whitelist(Vec<String>),
    /// 开放（任何可写）
    Open,
}

/// 群元信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupInfo {
    pub id: String,
    pub name: String,
    pub owner: Did,
    pub acl: GroupAcl,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub member_count: usize,
}

/// 群消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupEntry {
    pub seq: u64,
    pub sender: Did,
    pub kind: EntryKind,
    pub content: String,
    /// 签名（发送者 did 私钥对 (seq, kind, content) 签名）
    pub signature: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum EntryKind {
    Message,
    Membership, // 成员加入/离开事件（含双侧签名）
    Guide,      // 群主强引导
}

/// 群聊 store（内存实现；跨进程复制由 transport 层接）
#[derive(Debug, Default)]
pub struct GroupStore {
    groups: Arc<Mutex<HashMap<String, GroupInfo>>>,
    entries: Arc<Mutex<HashMap<String, Vec<GroupEntry>>>>,
}

impl GroupStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建群（默认创建者独占）
    pub async fn create_group(&self, id: String, name: String, owner: Did, acl: GroupAcl) -> GroupInfo {
        let info = GroupInfo {
            id: id.clone(),
            name,
            owner: owner.clone(),
            acl,
            created_at: chrono::Utc::now(),
            member_count: 1,
        };
        self.groups.lock().await.insert(id.clone(), info.clone());
        self.entries.lock().await.entry(id).or_default();
        info
    }

    pub async fn get_group(&self, id: &str) -> Option<GroupInfo> {
        self.groups.lock().await.get(id).cloned()
    }

    pub async fn list_groups(&self) -> Vec<GroupInfo> {
        let mut v: Vec<GroupInfo> = self.groups.lock().await.values().cloned().collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    /// 追加消息。ACL 检查：非白名单/非 owner 拒绝（对应 TS: 独占群下非创建者写不进去是正确行为）
    pub async fn append(
        &self,
        group_id: &str,
        sender: &Did,
        kind: EntryKind,
        content: String,
        signature: String,
    ) -> Result<GroupEntry, GroupError> {
        let groups = self.groups.lock().await;
        let info = groups
            .get(group_id)
            .ok_or(GroupError::GroupNotFound)?;
        let allowed = match &info.acl {
            GroupAcl::OwnerOnly => info.owner == *sender,
            GroupAcl::Whitelist(wl) => info.owner == *sender || wl.iter().any(|d| Did::new(d) == *sender),
            GroupAcl::Open => true,
        };
        if !allowed {
            return Err(GroupError::NotAllowed);
        }
        drop(groups);

        let mut entries = self.entries.lock().await;
        let list = entries.entry(group_id.to_string()).or_default();
        let seq = list.len() as u64 + 1;
        let entry = GroupEntry {
            seq,
            sender: sender.clone(),
            kind,
            content,
            signature,
            timestamp: chrono::Utc::now(),
        };
        list.push(entry.clone());
        Ok(entry)
    }

    /// 读消息（分页）
    pub async fn read(&self, group_id: &str, after_seq: u64, limit: usize) -> Vec<GroupEntry> {
        let entries = self.entries.lock().await;
        match entries.get(group_id) {
            Some(list) => list
                .iter()
                .filter(|e| e.seq > after_seq)
                .take(limit)
                .cloned()
                .collect(),
            None => vec![],
        }
    }

    pub async fn len(&self, group_id: &str) -> usize {
        self.entries.lock().await.get(group_id).map(|l| l.len()).unwrap_or(0)
    }

    /// 跨进程复制入口（transport 层收到远端条目后调用）
    pub async fn replicate(&self, group_id: &str, entry: GroupEntry) {
        let mut entries = self.entries.lock().await;
        let list = entries.entry(group_id.to_string()).or_default();
        if let Some(last) = list.last() {
            if entry.seq <= last.seq {
                return; // 陈旧或重复
            }
        }
        list.push(entry);
    }
}

/// 群错误
#[derive(Debug, thiserror::Error)]
pub enum GroupError {
    #[error("群不存在")]
    GroupNotFound,
    #[error("无写入权限（ACL 拒绝）")]
    NotAllowed,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn owner_only_acl_enforced() {
        let store = GroupStore::new();
        let owner = Did::new("did:pi:owner");
        let stranger = Did::new("did:pi:stranger");
        store
            .create_group("g1".into(), "测试群".into(), owner.clone(), GroupAcl::OwnerOnly)
            .await;

        // 陌生人写 → 拒
        let err = store
            .append("g1", &stranger, EntryKind::Message, "hi".into(), "sig".into())
            .await
            .unwrap_err();
        assert!(matches!(err, GroupError::NotAllowed), "独占群陌生人写入必须被拒");

        // owner 写 → 允许
        store
            .append("g1", &owner, EntryKind::Message, "你好".into(), "sig".into())
            .await
            .unwrap();
        assert_eq!(store.len("g1").await, 1);
    }

    #[tokio::test]
    async fn open_acl_allows_anyone() {
        let store = GroupStore::new();
        store
            .create_group("g2".into(), "开放群".into(), Did::new("did:pi:o").into(), GroupAcl::Open)
            .await;
        let anyone = Did::new("did:pi:anyone");
        store
            .append("g2", &anyone, EntryKind::Message, "hello".into(), "s".into())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn read_pagination() {
        let store = GroupStore::new();
        let owner = Did::new("did:pi:owner");
        store
            .create_group("g3".into(), "pag".into(), owner.clone(), GroupAcl::Open)
            .await;
        for i in 0..5 {
            store
                .append("g3", &owner, EntryKind::Message, format!("msg {i}"), "s".into())
                .await
                .unwrap();
        }
        let page = store.read("g3", 2, 2).await;
        assert_eq!(page.len(), 2);
        assert_eq!(page[0].seq, 3);
        assert_eq!(page[0].content, "msg 2");
    }

    #[tokio::test]
    async fn replicate_ignores_stale() {
        let store = GroupStore::new();
        let owner = Did::new("did:pi:owner");
        store
            .create_group("g4".into(), "repl".into(), owner.clone(), GroupAcl::Open)
            .await;
        store.append("g4", &owner, EntryKind::Message, "a".into(), "s".into()).await.unwrap();
        store.append("g4", &owner, EntryKind::Message, "b".into(), "s".into()).await.unwrap();

        // 陈旧条目（seq 1 已存在）→ 忽略
        store
            .replicate(
                "g4",
                GroupEntry {
                    seq: 1,
                    sender: owner.clone(),
                    kind: EntryKind::Message,
                    content: "stale".into(),
                    signature: "s".into(),
                    timestamp: chrono::Utc::now(),
                },
            )
            .await;
        assert_eq!(store.len("g4").await, 2, "陈旧条目不得追加");

        // 新条目（seq 3）→ 追加
        store
            .replicate(
                "g4",
                GroupEntry {
                    seq: 3,
                    sender: owner.clone(),
                    kind: EntryKind::Message,
                    content: "c".into(),
                    signature: "s".into(),
                    timestamp: chrono::Utc::now(),
                },
            )
            .await;
        assert_eq!(store.len("g4").await, 3);
    }
}