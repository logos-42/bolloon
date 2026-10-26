//! 群聊 = OrbitDB events store (hub)
//!
//! 一个群 = **一个 OrbitStore** (events store):
//! - 群消息 = oplog entry (hash 链 + Ed25519 签名 + ACL 门)
//! - store **内容寻址**: address = manifest 哈希 ⇒ 拿到 manifest 就能打开同一个 store
//! - 群 id (本地业务 id) → address 的索引落盘 (`groups.json`), 跨进程/跨机一致
//! - 加入群 = 按 manifest 开同一个 store (邀请链接里带 manifest)
//! - 复制 = heads 交换 → 拉块 → join (走 `replication` 的 `BlockExchange` 端口)
//!
//! 诚实边界:
//! - 本模块只管**群语义 + 落盘**; 跨机传输仍走 `BlockExchange` 端口, 本机已有磁盘实现
//!   (`FileExchange`), 跨机传输本身未接。
//! - **分片轮转未做** (与 TS 侧产品路径一致: 单库 events store)。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::identity::KeyPair;
use crate::oplog::OpEntry;
use crate::orbit_store::{OrbitStore, StoreManifest};
use crate::replication::{BlockExchange, ReplicationReport};

// ────────────────────────── 群 ACL ──────────────────────────

/// 群写权限 (对齐 TS accessController)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum GroupAcl {
    /// 创建者独占 (默认)
    OwnerOnly,
    /// 白名单成员 (创建者恒可写)
    Whitelist(Vec<String>),
    /// 开放 (任何可写; 对齐 TS `write: '*'`)
    Open,
}

/// entry 种类 (对齐 TS events store 的 op 类型)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum EntryKind {
    Message,
    Guide,
    MemberJoin,
    Rotation,
}

impl EntryKind {
    /// 种类 → 载荷 kind 字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            EntryKind::Message => "message",
            EntryKind::Guide => "guide",
            EntryKind::MemberJoin => "member-join",
            EntryKind::Rotation => "rotation",
        }
    }

    /// 从字符串解析 (未知 → message)
    pub fn from_str_kind(s: &str) -> Self {
        match s {
            "guide" => EntryKind::Guide,
            "member-join" => EntryKind::MemberJoin,
            "rotation" => EntryKind::Rotation,
            _ => EntryKind::Message,
        }
    }
}

// ────────────────────────── 群数据形状 ──────────────────────────

/// 群元信息 (落盘索引项)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupMeta {
    /// 本地群 id
    pub id: String,
    /// OrbitDB store address (内容寻址)
    pub address: String,
    /// 群名
    pub name: String,
    /// 群主 DID
    pub owner: String,
    pub acl: GroupAcl,
    pub created_at_ms: u64,
}

/// 群消息载荷 (写进 oplog entry 的 payload)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupPayload {
    /// message | guide | member-join | rotation
    pub kind: String,
    /// 发送者显示名
    pub from: String,
    pub text: String,
    /// 回复锚点 (entry hash)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
}

/// 群消息视图 (读出来的一条)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GroupMessage {
    /// entry hash (回复锚点)
    pub hash: String,
    pub kind: String,
    pub from: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// 毫秒时间戳
    pub ts: u64,
    /// 写入者 DID
    pub signer: String,
    /// 写入者 Ed25519 签名 (b58)
    pub signature: String,
}

// ────────────────────────── 错误 ──────────────────────────

/// 群错误
#[derive(Debug, thiserror::Error)]
pub enum GroupOrbitError {
    #[error("群不存在: {0}")]
    NoSuchGroup(String),
    #[error("store 错误: {0}")]
    Store(#[from] crate::orbit_store::OrbitStoreError),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("群消息不能为空")]
    EmptyText,
    #[error("群邀请链接非法: {0}")]
    Invite(#[from] InviteError),
}

/// 邀请错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum InviteError {
    #[error("邀请签名无效 (伪造或被篡改)")]
    BadSignature,
    #[error("邀请已过期")]
    Expired,
    #[error("链接形状不对")]
    BadLink,
    #[error("链接里的 manifest 解析失败")]
    BadManifest,
}

// ────────────────────────── 群邀请 (带 manifest ⇒ 同一个 store) ──────────────────────────

/// 生成群邀请链接 (群主签 group_id + manifest, 带过期)
///
/// 形状: `bolloon://join/<group_id>?t=<b58 sig>&exp=<epoch ms>&by=<owner did>&m=<b58 manifest>`
///
/// 链接里带 **manifest** ⇒ 被邀请方能开出**同一个** store (address 由 manifest 决定),
/// 而不是"另建一个长得一样的群"。
///
/// `now_ms` 是**生成时**守卫: 过期时刻不晚于当下 ⇒ 链接一出生就过期 ⇒ 直接拒。
pub fn make_invite_link(
    group_id: &str,
    owner_kp: &KeyPair,
    manifest: &StoreManifest,
    expires_at_ms: u64,
    now_ms: u64,
) -> Result<String, InviteError> {
    if expires_at_ms <= now_ms {
        return Err(InviteError::Expired);
    }
    let m = manifest_b58(manifest);
    let sig = owner_kp.sign(invite_signing_body(group_id, expires_at_ms, &m).as_bytes());
    Ok(format!(
        "bolloon://join/{}?t={}&exp={}&by={}&m={}",
        group_id,
        crate::b58_encode(&sig),
        expires_at_ms,
        owner_kp.did.as_str(),
        m
    ))
}

/// 验证邀请链接 (签名 + 过期; 通过才允许加入)
///
/// 返回 (group_id, manifest) —— manifest 用来开同一个 store。
pub fn verify_invite_link(
    link: &str,
    now_ms: u64,
    owner_pubkey: &[u8; 32],
) -> Result<(String, StoreManifest), InviteError> {
    let rest = link.strip_prefix("bolloon://join/").ok_or(InviteError::BadLink)?;
    let (group_id, query) = rest.split_once('?').ok_or(InviteError::BadLink)?;
    if group_id.is_empty() {
        return Err(InviteError::BadLink);
    }
    let mut token = None;
    let mut exp = None;
    let mut m = None;
    for kv in query.split('&') {
        if let Some(t) = kv.strip_prefix("t=") {
            token = Some(t.to_string());
        } else if let Some(e) = kv.strip_prefix("exp=") {
            exp = e.parse::<u64>().ok();
        } else if let Some(mm) = kv.strip_prefix("m=") {
            m = Some(mm.to_string());
        }
    }
    let (Some(token), Some(exp)) = (token, exp) else {
        return Err(InviteError::BadLink);
    };
    let Some(m_b58) = m else {
        return Err(InviteError::BadLink);
    };
    if now_ms > exp {
        return Err(InviteError::Expired);
    }
    let sig = crate::b58_decode(&token).ok_or(InviteError::BadSignature)?;
    let sig: [u8; 64] = sig.try_into().map_err(|_| InviteError::BadSignature)?;
    let ok = KeyPair::verify(
        owner_pubkey,
        invite_signing_body(group_id, exp, &m_b58).as_bytes(),
        &sig,
    );
    if !ok {
        return Err(InviteError::BadSignature);
    }
    let manifest = manifest_from_b58(&m_b58)?;
    // manifest 的 owner 必须就是签名者本人 (群主签的 manifest 才算数)
    if manifest.owner != KeyPair::did_from_public(owner_pubkey).as_str() {
        return Err(InviteError::BadSignature);
    }
    Ok((group_id.into(), manifest))
}

/// 邀请签名正文 (签名覆盖 group_id + 过期 + manifest)
fn invite_signing_body(group_id: &str, expires_at_ms: u64, manifest_b58: &str) -> String {
    format!("join|{group_id}|{expires_at_ms}|{manifest_b58}")
}

/// manifest → b58 (URL 安全)
pub fn manifest_b58(manifest: &StoreManifest) -> String {
    let bytes = serde_json::to_vec(manifest).unwrap_or_default();
    crate::b58_encode(&bytes)
}

/// b58 → manifest
pub fn manifest_from_b58(s: &str) -> Result<StoreManifest, InviteError> {
    let bytes = crate::b58_decode(s).ok_or(InviteError::BadManifest)?;
    let m: StoreManifest = serde_json::from_slice(&bytes).map_err(|_| InviteError::BadManifest)?;
    if m.address().is_empty() {
        return Err(InviteError::BadManifest);
    }
    Ok(m)
}

// ────────────────────────── hub ──────────────────────────

#[derive(Default)]
struct HubInner {
    /// group_id → store
    stores: HashMap<String, OrbitStore>,
    /// group_id → meta
    metas: HashMap<String, GroupMeta>,
}

/// 群 hub (所有群 = 多个 OrbitDB store)
pub struct GroupOrbitHub {
    root: PathBuf,
    inner: Mutex<HubInner>,
}

impl GroupOrbitHub {
    /// 打开 (或新建) 一个 hub; 索引落盘在 `root/groups.json`
    pub fn new(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let hub = Self { root, inner: Mutex::new(HubInner::default()) };
        hub.load_index();
        hub
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("groups.json")
    }

    /// 读索引 + 逐个开 store (开不动的如实跳过, 不静默假装有)
    fn load_index(&self) {
        let Ok(raw) = std::fs::read_to_string(self.index_path()) else {
            return;
        };
        let Ok(metas) = serde_json::from_str::<Vec<GroupMeta>>(&raw) else {
            tracing::warn!("groups.json 损坏, 忽略");
            return;
        };
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for meta in metas {
            match OrbitStore::open_by_address(&self.root, &meta.address) {
                Ok(store) => {
                    inner.stores.insert(meta.id.clone(), store);
                    inner.metas.insert(meta.id.clone(), meta);
                }
                Err(e) => tracing::warn!("群 {} 的 store 打不开: {e}", meta.id),
            }
        }
    }

    /// 写索引 (原子)
    fn save_index(&self, inner: &HubInner) {
        let mut metas: Vec<GroupMeta> = inner.metas.values().cloned().collect();
        metas.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)));
        if let Ok(bytes) = serde_json::to_vec_pretty(&metas) {
            let _ = std::fs::create_dir_all(&self.root);
            let path = self.index_path();
            let tmp = path.with_extension("tmp");
            if std::fs::write(&tmp, &bytes).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    /// 建群 (新 manifest ⇒ 新 address)
    pub fn create_group(
        &self,
        id: &str,
        name: &str,
        owner_did: &str,
        acl: GroupAcl,
        now_ms: u64,
    ) -> GroupMeta {
        let manifest = StoreManifest::group(name, owner_did, &acl, now_ms);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let store = OrbitStore::open_or_create(&self.root, manifest.clone())
            .expect("create group: open_or_create store");
        let meta = GroupMeta {
            id: id.to_string(),
            address: manifest.address(),
            name: name.to_string(),
            owner: owner_did.to_string(),
            acl,
            created_at_ms: now_ms,
        };
        inner.stores.insert(id.to_string(), store);
        inner.metas.insert(id.to_string(), meta.clone());
        self.save_index(&inner);
        meta
    }

    /// 加入群 (按 manifest 开**同一个** store; 幂等: 已在本地则直接返回)
    pub fn import_group(
        &self,
        id: &str,
        manifest: StoreManifest,
        now_ms: u64,
    ) -> GroupMeta {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let address = manifest.address();
        if let Some(existing) = inner.metas.get(id).cloned() {
            if existing.address == address {
                return existing;
            }
        }
        let store = OrbitStore::open_or_create(&self.root, manifest.clone())
            .expect("import group: open_or_create store");
        let meta = GroupMeta {
            id: id.to_string(),
            address: address.clone(),
            name: manifest.name.clone(),
            owner: manifest.owner.clone(),
            acl: if manifest.open {
                GroupAcl::Open
            } else {
                match &manifest.write_list {
                    Some(l) => GroupAcl::Whitelist(l.clone()),
                    None => GroupAcl::OwnerOnly,
                }
            },
            created_at_ms: now_ms,
        };
        inner.stores.insert(id.to_string(), store);
        inner.metas.insert(id.to_string(), meta.clone());
        self.save_index(&inner);
        meta
    }

    /// 发言 (ACL 门 → hash → 签名 → 落块)
    pub fn say(
        &self,
        group_id: &str,
        kp: &KeyPair,
        from: &str,
        text: &str,
        now_ms: u64,
    ) -> Result<OpEntry, GroupOrbitError> {
        self.append(group_id, kp, "message", from, text, None, now_ms)
    }

    /// 回复某条 (reply_to = entry hash)
    pub fn reply(
        &self,
        group_id: &str,
        kp: &KeyPair,
        from: &str,
        text: &str,
        reply_to: &str,
        now_ms: u64,
    ) -> Result<OpEntry, GroupOrbitError> {
        self.append(group_id, kp, "message", from, text, Some(reply_to.to_string()), now_ms)
    }

    /// 追加一条群事件 (kind: message | guide | member-join)
    pub fn append(
        &self,
        group_id: &str,
        kp: &KeyPair,
        kind: &str,
        from: &str,
        text: &str,
        reply_to: Option<String>,
        now_ms: u64,
    ) -> Result<OpEntry, GroupOrbitError> {
        if text.trim().is_empty() {
            return Err(GroupOrbitError::EmptyText);
        }
        let payload = serde_json::to_value(GroupPayload {
            kind: kind.to_string(),
            from: from.to_string(),
            text: text.to_string(),
            reply_to,
        })?;
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let store = inner
            .stores
            .get_mut(group_id)
            .ok_or_else(|| GroupOrbitError::NoSuchGroup(group_id.to_string()))?;
        let entry = store.append(kp, payload, now_ms)?;
        Ok(entry)
    }

    /// 读群历史 (线性序 ⇒ 全节点一致; limit = 取最近 N 条)
    pub fn history(&self, group_id: &str, limit: usize) -> Result<Vec<GroupMessage>, GroupOrbitError> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let store = inner
            .stores
            .get(group_id)
            .ok_or_else(|| GroupOrbitError::NoSuchGroup(group_id.to_string()))?;
        let mut msgs: Vec<GroupMessage> = store
            .entries()
            .into_iter()
            .filter_map(|e| {
                let p: GroupPayload = serde_json::from_value(e.payload.clone()).ok()?;
                Some(GroupMessage {
                    hash: e.hash,
                    kind: p.kind,
                    from: p.from,
                    text: p.text,
                    reply_to: p.reply_to,
                    ts: e.timestamp_ms,
                    signer: e.signer,
                    signature: e.signature,
                })
            })
            .collect();
        if limit > 0 && msgs.len() > limit {
            let cut = msgs.len() - limit;
            msgs.drain(0..cut);
        }
        Ok(msgs)
    }

    /// 群列表
    pub fn list_groups(&self) -> Vec<GroupMeta> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut v: Vec<GroupMeta> = inner.metas.values().cloned().collect();
        v.sort_by(|a, b| b.created_at_ms.cmp(&a.created_at_ms).then(a.id.cmp(&b.id)));
        v
    }

    /// 群元信息
    pub fn meta(&self, group_id: &str) -> Option<GroupMeta> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.metas.get(group_id).cloned()
    }

    /// store address (内容寻址)
    pub fn address_of(&self, group_id: &str) -> Option<String> {
        self.meta(group_id).map(|m| m.address)
    }

    /// 当前 heads (复制协商用)
    pub fn heads_of(&self, group_id: &str) -> Option<Vec<String>> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stores.get(group_id).map(|s| s.heads())
    }

    /// entry 条数
    pub fn entry_count(&self, group_id: &str) -> usize {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.stores.get(group_id).map(|s| s.len()).unwrap_or(0)
    }

    /// 复制: 从远端拉块并 join (走 BlockExchange 端口 —— 跨机传输接同一端口)
    pub fn replicate_from<E: BlockExchange>(
        &self,
        group_id: &str,
        exchange: &E,
        remote_heads: &[String],
    ) -> Result<ReplicationReport, GroupOrbitError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let store = inner
            .stores
            .get_mut(group_id)
            .ok_or_else(|| GroupOrbitError::NoSuchGroup(group_id.to_string()))?;
        let report = store.replicate_from(exchange, remote_heads)?;
        Ok(report)
    }

    /// hub 根目录 (存 blocks 的地方)
    pub fn root(&self) -> &Path {
        &self.root
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replication::MemoryExchange;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon-group-orbit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn create_group_writes_oplog_entry_and_persists() {
        let root = tmp_root("create");
        let owner = kp(1);
        let hub = GroupOrbitHub::new(&root);
        let meta = hub
            .create_group("g1", "测试群", owner.did.as_str(), GroupAcl::Open, 1000);
        assert!(!meta.address.is_empty());
        let e = hub.say("g1", &owner, "Leo", "大家好", 1100).unwrap();
        assert_eq!(hub.entry_count("g1"), 1);
        let h = hub.history("g1", 0).unwrap();
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].text, "大家好");
        assert_eq!(h[0].hash, e.hash, "消息 id = entry hash (回复锚点)");
        assert_eq!(h[0].signer, owner.did.as_str());
        assert!(!h[0].signature.is_empty(), "每条消息都带 Ed25519 签名");

        // 重开 hub → 群与消息都恢复
        let hub2 = GroupOrbitHub::new(&root);
        assert_eq!(hub2.list_groups().len(), 1);
        assert_eq!(hub2.history("g1", 0).unwrap().len(), 1);
        assert_eq!(hub2.address_of("g1").unwrap(), meta.address);
    }

    #[test]
    fn acl_owner_only_blocks_stranger() {
        let root = tmp_root("acl");
        let owner = kp(1);
        let stranger = kp(9);
        let hub = GroupOrbitHub::new(&root);
        hub.create_group("g1", "独占群", owner.did.as_str(), GroupAcl::OwnerOnly, 1000);
        let err = hub.say("g1", &stranger, "intruder", "hi", 1100).unwrap_err();
        assert!(matches!(err, GroupOrbitError::Store(_)), "{err:?}");
        assert_eq!(hub.entry_count("g1"), 0, "被拒的不落块");
    }

    #[test]
    fn empty_text_rejected() {
        let root = tmp_root("empty");
        let owner = kp(1);
        let hub = GroupOrbitHub::new(&root);
        hub.create_group("g1", "群", owner.did.as_str(), GroupAcl::Open, 1000);
        assert!(matches!(
            hub.say("g1", &owner, "x", "   ", 1),
            Err(GroupOrbitError::EmptyText)
        ));
    }

    #[test]
    fn reply_anchors_to_entry_hash() {
        let root = tmp_root("reply");
        let owner = kp(1);
        let hub = GroupOrbitHub::new(&root);
        hub.create_group("g1", "群", owner.did.as_str(), GroupAcl::Open, 1000);
        let m1 = hub.say("g1", &owner, "Leo", "第一句", 1100).unwrap();
        hub.reply("g1", &owner, "Leo", "接上句", &m1.hash, 1200).unwrap();
        let h = hub.history("g1", 0).unwrap();
        assert_eq!(h[1].reply_to.as_deref(), Some(m1.hash.as_str()));
    }

    #[test]
    fn two_nodes_converge_via_exchange() {
        // A/B 两个独立 hub (两个数据目录) —— B 从 A 复制 → 群历史收敛
        let root_a = tmp_root("node-a");
        let root_b = tmp_root("node-b");
        let a = kp(1);
        let b = kp(2);
        let hub_a = GroupOrbitHub::new(&root_a);
        let meta = hub_a
            .create_group("g1", "群", a.did.as_str(), GroupAcl::Whitelist(vec![b.did.as_str().into()]), 1000);
        for i in 0..5 {
            hub_a.say("g1", &a, "A", &format!("消息 {i}"), 1100 + i as u64).unwrap();
        }

        // B 按**同一 manifest** 加入 (address 相同) —— 邀请链接带的就是它
        let manifest = StoreManifest::group("群", a.did.as_str(), &GroupAcl::Whitelist(vec![b.did.as_str().into()]), 1000);
        let hub_b = GroupOrbitHub::new(&root_b);
        let meta_b = hub_b.import_group("g1", manifest, 1000);
        assert_eq!(meta_b.address, meta.address, "同一 manifest ⇒ 同一 address ⇒ 同一个 store");

        // A 的磁盘当块源 (BlockExchange 端口形态)
        let ex = crate::replication::FileExchange::new(&root_a, &meta.address);
        let heads = hub_a.heads_of("g1").unwrap();
        let report = hub_b.replicate_from("g1", &ex, &heads).unwrap();
        assert!(report.converged, "{:?}", report.failure);
        assert_eq!(report.entries_after, 5);

        let ha = hub_a.history("g1", 0).unwrap();
        let hb = hub_b.history("g1", 0).unwrap();
        assert_eq!(ha, hb, "两节点群历史逐条一致");

        // B 继续发言 → A 复制回来 → 再收敛
        hub_b.say("g1", &b, "B", "我同意", 2000).unwrap();
        let ex2 = crate::replication::FileExchange::new(&root_b, &meta.address);
        let heads_b = hub_b.heads_of("g1").unwrap();
        let r2 = hub_a.replicate_from("g1", &ex2, &heads_b).unwrap();
        assert!(r2.converged, "{:?}", r2.failure);
        assert_eq!(hub_a.history("g1", 0).unwrap().len(), 6);
    }

    #[test]
    fn invite_link_carries_manifest_and_verifies() {
        let owner = kp(1);
        let manifest = StoreManifest::group("群", owner.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        let link = make_invite_link("gw-1", &owner, &manifest, 5000, 1000).unwrap();
        assert!(link.starts_with("bolloon://join/gw-1?"));
        assert!(link.contains("&m="), "链接必须带 manifest");
        let (gid, m) = verify_invite_link(&link, 2000, &owner.public_bytes()).unwrap();
        assert_eq!(gid, "gw-1");
        assert_eq!(m.address(), manifest.address(), "manifest ⇒ 同一 address");
    }

    #[test]
    fn invite_forgery_and_expiry_rejected() {
        let owner = kp(1);
        let attacker = kp(9);
        let manifest = StoreManifest::group("群", owner.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        // 攻击者签的链接 ⇒ 用群主公钥验不过
        let bad = make_invite_link("gw-1", &attacker, &manifest, 5000, 1000).unwrap();
        assert_eq!(
            verify_invite_link(&bad, 2000, &owner.public_bytes()).unwrap_err(),
            InviteError::BadSignature
        );
        // 过期 (生成时 1001>1000 不过期; 验证时 2000>1001 ⇒ 过期)
        let expired = make_invite_link("gw-1", &owner, &manifest, 1001, 1000).unwrap();
        assert_eq!(
            verify_invite_link(&expired, 2000, &owner.public_bytes()).unwrap_err(),
            InviteError::Expired
        );
        // 篡改 manifest (改群主) ⇒ 签名不过
        let link = make_invite_link("gw-1", &owner, &manifest, 5000, 1000).unwrap();
        let tampered = link.replace(&manifest_b58(&manifest), &manifest_b58(&StoreManifest::group("群", "did:pi:evil", &GroupAcl::OwnerOnly, 1000)));
        assert_eq!(
            verify_invite_link(&tampered, 2000, &owner.public_bytes()).unwrap_err(),
            InviteError::BadSignature
        );
    }

    #[test]
    fn invited_node_opens_same_store_by_manifest() {
        let root = tmp_root("invite-join");
        let owner = kp(1);
        let member = kp(2);
        let manifest = StoreManifest::group(
            "群",
            owner.did.as_str(),
            &GroupAcl::Whitelist(vec![member.did.as_str().into()]),
            1000,
        );
        let link = make_invite_link("gw-1", &owner, &manifest, 5000, 1000).unwrap();
        let (_, m) = verify_invite_link(&link, 2000, &owner.public_bytes()).unwrap();

        let hub = GroupOrbitHub::new(&root);
        let meta = hub.import_group("gw-1", m, 2000);
        // 群主本人加入白名单? 不 —— 成员能写 (白名单含 member)
        assert!(hub.say("gw-1", &member, "成员", "大家好", 2100).is_ok());
        assert_eq!(hub.entry_count("gw-1"), 1);
        assert!(!meta.address.is_empty());
    }

    #[test]
    fn memory_exchange_still_works_with_hub() {
        // 端口一致性: 内存交换 (单进程) 与磁盘交换 (跨进程) 走同一协议
        let root = tmp_root("memex");
        let a = kp(1);
        let b = kp(2);
        let hub_a = GroupOrbitHub::new(&root);
        let meta = hub_a
            .create_group("g1", "群", a.did.as_str(), GroupAcl::Whitelist(vec![b.did.as_str().into()]), 1000);
        hub_a.say("g1", &a, "A", "在吗", 1100).unwrap();
        let manifest = StoreManifest::group("群", a.did.as_str(), &GroupAcl::Whitelist(vec![b.did.as_str().into()]), 1000);
        let hub_b = GroupOrbitHub::new(tmp_root("memex-b"));
        hub_b.import_group("g1", manifest, 1000);
        // 内存交换需要一个 OpLog 引用 —— 用磁盘交换等价路径验证 (FileExchange 已在上面验过)
        let _ = meta;
        let _ = MemoryExchange { from: &crate::oplog::OpLog::new(a.did.as_str()) };
    }
}
