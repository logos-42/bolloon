//! OrbitDB store — 内容寻址的持久化 events store (manifest + blocks)
//!
//! 对齐 @orbitdb/core 4.x 的 **store 层**语义:
//! - **manifest**: store 的不可变定义 (name/type/owner/write ACL); **address = manifest 的内容哈希**
//!   ⇒ store 是**可寻址**的: 拿到 address 就能打开同一个 store (不需要知道它在哪个目录)
//! - **blocks**: 每个 entry 一个内容寻址文件 `blocks/<hash>.json`; **blocks 是唯一真源**
//! - **heads**: 当前 DAG 头 (复制时先换 heads); 落盘但**可由 blocks 重放重建** ——
//!   真源永远是 blocks, heads 只是协商缓存
//! - 打开 store = 读 manifest + 重放全部 blocks → 重建 oplog
//!   (hash 门 + 签名门 + ACL 门 + prev 完整性, 全在 `OpLog::join` 内强制)
//!
//! 诚实边界:
//! - 本文件是**本地磁盘**上的 OrbitDB 语义实现 (内容寻址 + 可寻址 + 可复制)。
//! - **跨机传输不在这里**: 块从哪来到哪去走 `BlockExchange` 端口 (见 `replication.rs`),
//!   本文件只负责"块落在哪、怎么重建"。
//! - **分片轮转未做**: 与 TS 侧一致 —— 产品路径是单库 events store, 分片只在验收脚本里。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::envelope::canonical_json;
use crate::group_orbit::GroupAcl;
use crate::identity::KeyPair;
use crate::oplog::{OpEntry, OpLog, OpLogError, WriteAcl};
use crate::replication::{replicate, BlockExchange, ReplicationReport};

/// manifest 版本 (冻结: 变了就是另一种 store, 不能混开)
pub const MANIFEST_VERSION: u8 = 1;

/// store 类型: 只追加事件流 (群聊 = events store)
pub const STORE_TYPE_EVENTS: &str = "events";

// ────────────────────────── manifest (不可变 = 地址来源) ──────────────────────────

/// store manifest — 不可变部分
///
/// **address = 本结构的 canonical 哈希** ⇒ 相同 manifest ⇒ 相同 address ⇒ 同一个 store。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StoreManifest {
    pub version: u8,
    /// store 名 (群名)
    pub name: String,
    /// store 类型 ("events")
    pub store_type: String,
    /// 拥有者 DID (创建者)
    pub owner: String,
    /// 写白名单 (None = 仅 owner 可写)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write_list: Option<Vec<String>>,
    /// 开放写 (对齐 TS `write: '*'`)
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
    /// 创建时间 (ms)
    pub created_at_ms: u64,
}

impl StoreManifest {
    /// 群 manifest (events store)
    pub fn group(name: &str, owner: &str, acl: &GroupAcl, created_at_ms: u64) -> Self {
        let (write_list, open) = match acl {
            GroupAcl::OwnerOnly => (None, false),
            GroupAcl::Whitelist(l) => (Some(l.clone()), false),
            GroupAcl::Open => (None, true),
        };
        Self {
            version: MANIFEST_VERSION,
            name: name.into(),
            store_type: STORE_TYPE_EVENTS.into(),
            owner: owner.into(),
            write_list,
            open,
            created_at_ms,
        }
    }

    /// 内容寻址地址 = sha256(canonical(manifest))
    pub fn address(&self) -> String {
        let v = serde_json::to_value(self).expect("manifest 序列化");
        let mut h = Sha256::new();
        h.update(canonical_json(&v).as_bytes());
        hex::encode(h.finalize())
    }

    /// ACL → oplog 写策略 (manifest 是 ACL 的**唯一来源**: 打开既有 store 不能放宽)
    pub fn write_acl(&self) -> WriteAcl {
        if self.open {
            return WriteAcl::open(&self.owner);
        }
        match &self.write_list {
            Some(l) => WriteAcl::whitelist(&self.owner, l.clone()),
            None => WriteAcl::owner_only(&self.owner),
        }
    }
}

// ────────────────────────── 错误 ──────────────────────────

/// store 错误
#[derive(Debug, thiserror::Error)]
pub enum OrbitStoreError {
    #[error("oplog 错误: {0}")]
    Op(#[from] OpLogError),
    #[error("磁盘错误: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),
    #[error("store 不存在: {0}")]
    NotFound(String),
    #[error("manifest 地址不匹配 (声称 {claimed} 实算 {actual})")]
    AddressMismatch { claimed: String, actual: String },
    #[error("manifest 版本不支持: {0}")]
    BadVersion(u8),
    #[error("store 类型不支持: {0}")]
    BadType(String),
}

// ────────────────────────── 路径规则 (复制端也要用) ──────────────────────────

/// store 目录 = root/{address}
pub fn store_dir_of(root: &Path, address: &str) -> PathBuf {
    root.join(address)
}

/// blocks 目录 = root/{address}/blocks
pub fn blocks_dir_of(root: &Path, address: &str) -> PathBuf {
    store_dir_of(root, address).join("blocks")
}

/// manifest 路径 = root/{address}/manifest.json
pub fn manifest_path_of(root: &Path, address: &str) -> PathBuf {
    store_dir_of(root, address).join("manifest.json")
}

/// heads 路径 = root/{address}/heads.json
pub fn heads_path_of(root: &Path, address: &str) -> PathBuf {
    store_dir_of(root, address).join("heads.json")
}

// ────────────────────────── store ──────────────────────────

/// OrbitDB store (内容寻址 + 落盘 + 可复制)
#[derive(Debug)]
pub struct OrbitStore {
    root: PathBuf,
    manifest: StoreManifest,
    log: OpLog,
    /// 打开时发现的坏块数 (hash 对不上 / 签名不过 ⇒ 不进 oplog, 如实计数)
    corrupt_blocks: usize,
}

impl OrbitStore {
    /// 按 manifest 建 store (目录已存在 = 已建过 ⇒ 直接打开, 不覆盖)
    ///
    /// address 由 manifest 决定 ⇒ **邀请方把 manifest 给对端, 两边就是同一个 store**。
    pub fn open_or_create(root: &Path, manifest: StoreManifest) -> Result<Self, OrbitStoreError> {
        let address = manifest.address();
        let dir = store_dir_of(root, &address);
        let mpath = manifest_path_of(root, &address);
        if mpath.exists() {
            let on_disk: StoreManifest = serde_json::from_str(&std::fs::read_to_string(&mpath)?)?;
            if on_disk.version != MANIFEST_VERSION {
                return Err(OrbitStoreError::BadVersion(on_disk.version));
            }
            if on_disk.store_type != manifest.store_type {
                return Err(OrbitStoreError::BadType(on_disk.store_type));
            }
            return Self::open_by_address(root, &address);
        }
        std::fs::create_dir_all(dir.join("blocks"))?;
        write_atomic(&mpath, &serde_json::to_vec_pretty(&manifest)?)?;
        write_atomic(&heads_path_of(root, &address), &serde_json::to_vec(&serde_json::json!({ "heads": [] }))?)?;
        let acl = manifest.write_acl();
        Ok(Self {
            root: root.to_path_buf(),
            manifest,
            log: OpLog::with_acl(acl),
            corrupt_blocks: 0,
        })
    }

    /// 按地址打开 (内容寻址: address = manifest 哈希 ⇒ 认地址就认 store)
    ///
    /// 重建流程: 读 manifest (校验地址自洽) → 逐块验签 → join 重放 → heads 由重放得出。
    pub fn open_by_address(root: &Path, address: &str) -> Result<Self, OrbitStoreError> {
        let mpath = manifest_path_of(root, address);
        if !mpath.exists() {
            return Err(OrbitStoreError::NotFound(address.into()));
        }
        let manifest: StoreManifest = serde_json::from_str(&std::fs::read_to_string(&mpath)?)?;
        if manifest.version != MANIFEST_VERSION {
            return Err(OrbitStoreError::BadVersion(manifest.version));
        }
        if manifest.store_type != STORE_TYPE_EVENTS {
            return Err(OrbitStoreError::BadType(manifest.store_type));
        }
        let actual = manifest.address();
        if &actual != address {
            return Err(OrbitStoreError::AddressMismatch { claimed: address.into(), actual });
        }

        // 重放全部块 → 重建 oplog
        let mut log = OpLog::with_acl(manifest.write_acl());
        let mut corrupt = 0usize;
        let mut good: Vec<OpEntry> = Vec::new();
        for f in block_files(root, address)? {
            let raw = std::fs::read_to_string(&f)?;
            let Ok(entry) = serde_json::from_str::<OpEntry>(&raw) else {
                corrupt += 1; // 坏块: 不进 oplog (如实计数, 不静默吞)
                continue;
            };
            if OpLog::verify_entry(&entry).is_err() {
                corrupt += 1; // hash 门 / 签名门 不过 ⇒ 拒收
                continue;
            }
            good.push(entry);
        }
        // join: ACL 门 + prev 完整性 (缺块 = 真缺, 如实报错)
        log.join(&good)?;

        let store = Self { root: root.to_path_buf(), manifest, log, corrupt_blocks: corrupt };
        store.write_heads()?;
        Ok(store)
    }

    /// 追加一条 (本地写: ACL 门 → hash → 签名 → 落块 → 更新 heads)
    pub fn append(
        &mut self,
        kp: &KeyPair,
        payload: serde_json::Value,
        ts_ms: u64,
    ) -> Result<OpEntry, OrbitStoreError> {
        let entry = self.log.append(kp, payload, ts_ms)?;
        self.persist_entry(&entry)?;
        self.write_heads()?;
        Ok(entry)
    }

    /// 收远端 entry (复制落点): 验签 + ACL + prev 完整性在 join 内强制, 只把**真收下的**块落盘
    pub fn join_remote(&mut self, entries: &[OpEntry]) -> Result<usize, OrbitStoreError> {
        let n = self.log.join(entries)?;
        for e in entries {
            if self.log.contains(&e.hash) {
                self.persist_entry(e)?;
            }
        }
        self.write_heads()?;
        Ok(n)
    }

    /// 复制 (内聚): 换 heads → 拉缺块 → join → 落盘真收下的新块
    ///
    /// 走 `BlockExchange` 端口 —— 与跨机传输同一协议形态 (只认 hash, 不认人)。
    /// 即使未完全收敛, 已收下的块也会落盘 (不丢已收到的证据)。
    pub fn replicate_from<E: BlockExchange>(
        &mut self,
        exchange: &E,
        remote_heads: &[String],
    ) -> Result<ReplicationReport, OrbitStoreError> {
        let before: std::collections::HashSet<String> =
            self.entries().iter().map(|e| e.hash.clone()).collect();
        let report = replicate(&mut self.log, exchange, remote_heads);
        // 落盘新收下的块 (幂等: 同 hash 不重复写)
        let new: Vec<OpEntry> = self
            .entries()
            .into_iter()
            .filter(|e| !before.contains(&e.hash))
            .collect();
        for e in &new {
            self.persist_entry(e)?;
        }
        self.write_heads()?;
        Ok(report)
    }

    /// 落一个块 (幂等: 同 hash 不重复写)
    fn persist_entry(&self, entry: &OpEntry) -> Result<(), OrbitStoreError> {
        let dir = blocks_dir_of(&self.root, &self.address());
        std::fs::create_dir_all(&dir)?;
        let path = dir.join(format!("{}.json", entry.hash));
        if path.exists() {
            return Ok(());
        }
        write_atomic(&path, &serde_json::to_vec_pretty(entry)?)?;
        Ok(())
    }

    /// 写 heads (协商缓存; 真源是 blocks)
    fn write_heads(&self) -> Result<(), OrbitStoreError> {
        let path = heads_path_of(&self.root, &self.address());
        let body = serde_json::json!({ "heads": self.log.heads() });
        write_atomic(&path, &serde_json::to_vec(&body)?)?;
        Ok(())
    }

    // ── 读面 ──

    /// 内容寻址地址
    pub fn address(&self) -> String {
        self.manifest.address()
    }

    pub fn manifest(&self) -> &StoreManifest {
        &self.manifest
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 当前 heads (复制协商用)
    pub fn heads(&self) -> Vec<String> {
        self.log.heads().to_vec()
    }

    /// 全部 entry (线性序)
    pub fn entries(&self) -> Vec<OpEntry> {
        self.log.traverse().into_iter().cloned().collect()
    }

    /// entry 条数
    pub fn len(&self) -> usize {
        self.log.len()
    }

    pub fn is_empty(&self) -> bool {
        self.log.is_empty()
    }

    /// 打开时发现的坏块数 (hash/签名 不过的块)
    pub fn corrupt_blocks(&self) -> usize {
        self.corrupt_blocks
    }

    /// 块目录 (复制端按目录读块)
    pub fn blocks_dir(&self) -> PathBuf {
        blocks_dir_of(&self.root, &self.address())
    }
}

/// 列出一个 store 的块文件 (确定性排序)
fn block_files(root: &Path, address: &str) -> Result<Vec<PathBuf>, OrbitStoreError> {
    let dir = blocks_dir_of(root, address);
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
        .collect();
    files.sort();
    Ok(files)
}

/// 原子写 (先写临时文件再 rename ⇒ 不会写出半个块)
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::oplog::WriteAcl;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    fn tmp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon-orbit-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn address_is_content_addressed_and_stable() {
        let m = StoreManifest::group("群", "did:pi:o", &GroupAcl::OwnerOnly, 1000);
        let a1 = m.address();
        let m2 = m.clone();
        assert_eq!(a1, m2.address(), "同 manifest ⇒ 同 address (可寻址)");
        // 不同 name ⇒ 不同 address
        let m3 = StoreManifest::group("群2", "did:pi:o", &GroupAcl::OwnerOnly, 1000);
        assert_ne!(a1, m3.address());
        // 时间不同 ⇒ address 不同 (manifest 参与寻址)
        let m4 = StoreManifest::group("群", "did:pi:o", &GroupAcl::OwnerOnly, 2000);
        assert_ne!(a1, m4.address());
    }

    #[test]
    fn create_append_reopen_recovers_entries() {
        let root = tmp_root("reopen");
        let k = kp(1);
        let manifest = StoreManifest::group("群", k.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        let mut store = OrbitStore::open_or_create(&root, manifest.clone()).unwrap();
        let e1 = store.append(&k, serde_json::json!({"text": "m1"}), 1000).unwrap();
        let e2 = store.append(&k, serde_json::json!({"text": "m2"}), 2000).unwrap();
        assert_eq!(store.len(), 2);
        let addr = store.address();

        // 重开 (模拟重启)
        let store2 = OrbitStore::open_by_address(&root, &addr).unwrap();
        assert_eq!(store2.len(), 2, "重启后条目必须恢复");
        let texts: Vec<String> = store2
            .entries()
            .iter()
            .map(|e| e.payload["text"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(texts, vec!["m1".to_string(), "m2".to_string()]);
        // heads 与原一致
        let mut h1 = store.heads();
        let mut h2 = store2.heads();
        h1.sort();
        h2.sort();
        assert_eq!(h1, h2);
        assert_eq!(h1, vec![e2.hash.clone()]);
        assert_eq!(e1.hash.len(), 64);
    }

    #[test]
    fn open_by_unknown_address_reports_not_found() {
        let root = tmp_root("notfound");
        let err = OrbitStore::open_by_address(&root, "deadbeef").unwrap_err();
        assert!(matches!(err, OrbitStoreError::NotFound(_)), "{err:?}");
    }

    #[test]
    fn tampered_block_is_rejected_on_reopen() {
        let root = tmp_root("tamper");
        let k = kp(1);
        let manifest = StoreManifest::group("群", k.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        let mut store = OrbitStore::open_or_create(&root, manifest).unwrap();
        let e = store.append(&k, serde_json::json!({"text": "真消息"}), 1000).unwrap();
        let addr = store.address();

        // 篡改块文件里的载荷 (hash 对不上)
        let block = blocks_dir_of(&root, &addr).join(format!("{}.json", e.hash));
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&block).unwrap()).unwrap();
        v["payload"]["text"] = serde_json::json!("被改的消息");
        std::fs::write(&block, serde_json::to_vec(&v).unwrap()).unwrap();

        let store2 = OrbitStore::open_by_address(&root, &addr).unwrap();
        assert_eq!(store2.len(), 0, "坏块不得进 oplog");
        assert_eq!(store2.corrupt_blocks(), 1, "坏块如实计数");
    }

    #[test]
    fn acl_owner_only_blocks_stranger_on_disk_store() {
        let root = tmp_root("acl");
        let owner = kp(1);
        let stranger = kp(9);
        let manifest = StoreManifest::group("群", owner.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        let mut store = OrbitStore::open_or_create(&root, manifest).unwrap();
        assert!(matches!(
            store.append(&stranger, serde_json::json!({"text": "hi"}), 1),
            Err(OrbitStoreError::Op(OpLogError::NotAllowed(_)))
        ));
        assert_eq!(store.len(), 0);
        // 白名单成员可写
        let member = kp(2);
        let m2 = StoreManifest::group(
            "群2",
            owner.did.as_str(),
            &GroupAcl::Whitelist(vec![member.did.as_str().into()]),
            1000,
        );
        let mut s2 = OrbitStore::open_or_create(&root, m2).unwrap();
        assert!(s2.append(&member, serde_json::json!({"text": "hi"}), 1).is_ok());
    }

    #[test]
    fn open_acl_allows_anyone() {
        let root = tmp_root("open");
        let owner = kp(1);
        let stranger = kp(9);
        let manifest = StoreManifest::group("开放群", owner.did.as_str(), &GroupAcl::Open, 1000);
        let mut store = OrbitStore::open_or_create(&root, manifest).unwrap();
        assert!(store.append(&stranger, serde_json::json!({"text": "hi"}), 1).is_ok());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn manifest_address_mismatch_rejected() {
        let root = tmp_root("mismatch");
        let k = kp(1);
        let manifest = StoreManifest::group("群", k.did.as_str(), &GroupAcl::OwnerOnly, 1000);
        let addr = manifest.address();
        // 正常建 store (创建 root/<addr>/manifest.json + blocks)
        let _store = OrbitStore::open_or_create(&root, manifest).unwrap();
        // 篡改 manifest (改 name ⇒ 重算 address != 目录名) ⇒ 地址不自洽 ⇒ 拒
        let mpath = manifest_path_of(&root, &addr);
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&mpath).unwrap()).unwrap();
        v["name"] = serde_json::json!("被改的群名");
        std::fs::write(&mpath, serde_json::to_vec(&v).unwrap()).unwrap();
        let err = OrbitStore::open_by_address(&root, &addr).unwrap_err();
        assert!(matches!(err, OrbitStoreError::AddressMismatch { .. }), "{err:?}");
    }

    #[test]
    fn write_acl_manifest_is_the_only_source() {
        // 打开既有 store 的 ACL 来自 manifest —— 不能靠调用方放宽
        let m = StoreManifest::group("群", "did:pi:o", &GroupAcl::OwnerOnly, 1);
        let acl = m.write_acl();
        assert!(acl.allows("did:pi:o"));
        assert!(!acl.allows("did:pi:x"));
        let open = StoreManifest::group("群", "did:pi:o", &GroupAcl::Open, 1);
        assert!(open.write_acl().allows("did:pi:anyone"));
        let wl = StoreManifest::group("群", "did:pi:o", &GroupAcl::Whitelist(vec!["did:pi:m".into()]), 1);
        assert!(wl.write_acl().allows("did:pi:m"));
        assert!(!wl.write_acl().allows("did:pi:z"));
        let _ = WriteAcl::owner_only("x");
    }
}
