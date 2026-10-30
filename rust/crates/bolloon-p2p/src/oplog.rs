//! OrbitDB 原生核心 — append-only oplog DAG (去中心化交流的数据底座)
//!
//! 对齐 TS 版 `orbitdb/` 语义 (@orbitdb/core 4.x):
//! - oplog 是 **DAG**: entry 带 prev 指针 (可并发分叉), heads = 无后继的 entry
//! - 读取 = **从 heads 遍历整条 oplog**, 日志要遍历结束才成形
//! - 复制 = 交换 heads + 拉缺失 entry + join (合并去重)
//! - ACL = write 白名单 (DID 门控); **打开既有 log 时 ACL 来自 manifest, 不能放宽**
//! - 签名: 每个 entry 由写入者 DID Ed25519 签名, 验签不过的 entry 拒收
//! - 索引重建: 从 entries 重放 payload, 结果与原索引一致 (P2 逐字节重建语义)
//! - 分片轮转: 每 SHARD_SIZE 条开新片, manifest oplog 是 O(片数)

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::identity::KeyPair;

/// 分片大小 (对齐 TS SHARD_SIZE 语义: 每片多少条)
pub const SHARD_SIZE: usize = 500;

/// oplog entry (DAG 节点)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpEntry {
    /// 内容寻址 id = sha256(canonical entry) hex (CID 语义的简化实现)
    pub hash: String,
    /// lamport 时钟 (= max(prev clocks) + 1)
    pub clock: u64,
    /// 前驱 hashes (append 时 = 当前 heads; 并发时可能多个)
    pub prev: Vec<String>,
    /// 写入者 DID
    pub signer: String,
    /// Ed25519 签名 (对 canonical unsigned)
    pub signature: String,
    /// 载荷 (群消息/事件/文档变更)
    pub payload: serde_json::Value,
    pub timestamp_ms: u64,
}

#[derive(Serialize)]
struct OpEntryUnsigned<'a> {
    clock: u64,
    prev: &'a [String],
    signer: &'a str,
    payload: &'a serde_json::Value,
    timestamp_ms: u64,
}

/// canonical 字节 (键排序无空格; 与 envelope 同语义)
fn canonical(v: &impl Serialize) -> Vec<u8> {
    let val = serde_json::to_value(v).expect("serialize");
    let mut out = String::new();
    write_canonical(&val, &mut out);
    out.into_bytes()
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

/// entry 的内容 id (sha256 of canonical unsigned)
pub fn entry_hash(clock: u64, prev: &[String], signer: &str, payload: &serde_json::Value, ts: u64) -> String {
    let unsigned = OpEntryUnsigned { clock, prev, signer, payload, timestamp_ms: ts };
    let mut h = Sha256::new();
    h.update(canonical(&unsigned));
    hex::encode(h.finalize())
}

/// oplog 错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum OpLogError {
    #[error("entry 签名无效: {0}")]
    BadSignature(String),
    #[error("写入者 {0} 不在 ACL 白名单 (DID 门控)")]
    NotAllowed(String),
    #[error("entry hash 不一致 (内容被改): 声称 {claimed} 实算 {actual}")]
    HashMismatch { claimed: String, actual: String },
    #[error("entry 引用了不存在的 prev: {0} (拉块不完整)")]
    MissingPrev(String),
    #[error("群邀请链接非法: {0}")]
    BadInvite(String),
}

/// write 策略 (对齐 TS accessController)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WriteAcl {
    /// None = 创建者独占; Some(list) = 白名单 (创建者恒可写)
    pub write_list: Option<Vec<String>>,
    /// owner (创建者 DID)
    pub owner: String,
    /// 任何人可写 (对齐 TS `write: '*'`)
    pub open: bool,
}

impl WriteAcl {
    pub fn owner_only(owner: &str) -> Self {
        Self { write_list: None, owner: owner.into(), open: false }
    }

    pub fn whitelist(owner: &str, list: Vec<String>) -> Self {
        Self { write_list: Some(list), owner: owner.into(), open: false }
    }

    /// 开放写 (任何 DID 都能写; owner 仍记录在 manifest 里)
    pub fn open(owner: &str) -> Self {
        Self { write_list: None, owner: owner.into(), open: true }
    }

    pub fn allows(&self, did: &str) -> bool {
        if self.open {
            return true;
        }
        if did == self.owner {
            return true;
        }
        self.write_list.as_ref().map(|l| l.iter().any(|d| d == did)).unwrap_or(false)
    }
}

/// oplog (DAG)
#[derive(Debug, Clone, Default)]
pub struct OpLog {
    entries: HashMap<String, OpEntry>,
    /// 当前 heads (无后继的 entry hashes)
    heads: Vec<String>,
    /// 本节点 lamport 时钟
    clock: u64,
    acl: Option<WriteAcl>,
}

impl OpLog {
    /// 新建 (owner 独占 ACL)
    pub fn new(owner: &str) -> Self {
        Self { acl: Some(WriteAcl::owner_only(owner)), ..Default::default() }
    }

    /// 以显式 ACL 新建 (白名单)
    pub fn with_acl(acl: WriteAcl) -> Self {
        Self { acl: Some(acl), ..Default::default() }
    }

    /// 追加一条 (本地写入; prev = 当前 heads)
    pub fn append(
        &mut self,
        kp: &KeyPair,
        payload: serde_json::Value,
        ts_ms: u64,
    ) -> Result<OpEntry, OpLogError> {
        // ACL 门 (本地写也要过 —— TS P1: 群写入 DID 门控)
        if let Some(acl) = &self.acl {
            if !acl.allows(kp.did.as_str()) {
                return Err(OpLogError::NotAllowed(kp.did.as_str().into()));
            }
        }
        let prev = self.heads.clone();
        self.clock += 1;
        let clock = self.clock;
        let hash = entry_hash(clock, &prev, kp.did.as_str(), &payload, ts_ms);
        let unsigned = OpEntryUnsigned {
            clock,
            prev: &prev,
            signer: kp.did.as_str(),
            payload: &payload,
            timestamp_ms: ts_ms,
        };
        let sig = kp.sign(&canonical(&unsigned));
        let entry = OpEntry {
            hash,
            clock,
            prev,
            signer: kp.did.as_str().into(),
            signature: crate::b58_encode(&sig),
            payload,
            timestamp_ms: ts_ms,
        };
        self.insert_entry(entry.clone());
        Ok(entry)
    }

    fn insert_entry(&mut self, entry: OpEntry) {
        // 新 entry 的 prev 从 heads 中移除 (它们有后继了)
        for p in &entry.prev {
            self.heads.retain(|h| h != p);
        }
        // 自己没被任何 entry 引用 → 是 head
        self.heads.push(entry.hash.clone());
        self.clock = self.clock.max(entry.clock);
        self.entries.insert(entry.hash.clone(), entry);
    }

    /// 验证单条 entry (hash 一致 + 签名) — join 前必调
    pub fn verify_entry(entry: &OpEntry) -> Result<(), OpLogError> {
        let actual = entry_hash(entry.clock, &entry.prev, &entry.signer, &entry.payload, entry.timestamp_ms);
        if actual != entry.hash {
            return Err(OpLogError::HashMismatch { claimed: entry.hash.clone(), actual });
        }
        // DID 后缀 = 公钥
        let Some(pk_b58) = entry.signer.strip_prefix("did:pi:") else {
            return Err(OpLogError::BadSignature(entry.signer.clone()));
        };
        let Some(pk_raw) = crate::b58_decode(pk_b58) else {
            return Err(OpLogError::BadSignature(entry.signer.clone()));
        };
        let Ok(pk) = <[u8; 32]>::try_from(pk_raw) else {
            return Err(OpLogError::BadSignature(entry.signer.clone()));
        };
        let Some(sig) = crate::b58_decode(&entry.signature) else {
            return Err(OpLogError::BadSignature("sig 非 b58".into()));
        };
        let Ok(sig) = <[u8; 64]>::try_from(sig) else {
            return Err(OpLogError::BadSignature("sig 长度".into()));
        };
        let unsigned = OpEntryUnsigned {
            clock: entry.clock,
            prev: &entry.prev,
            signer: &entry.signer,
            payload: &entry.payload,
            timestamp_ms: entry.timestamp_ms,
        };
        if !KeyPair::verify(&pk, &canonical(&unsigned), &sig) {
            return Err(OpLogError::BadSignature(entry.hash.clone()));
        }
        Ok(())
    }

    /// join 远端 entries (复制核心): 验签 + ACL + prev 完整性, 逐条收
    ///
    /// 返回本次**真正新增**的条数 (已有的去重, 不算新增)
    pub fn join(&mut self, entries: &[OpEntry]) -> Result<usize, OpLogError> {
        let len_before = self.entries.len();
        // 先全部放进暂存 (支持乱序到达)
        let mut pending: Vec<OpEntry> = Vec::new();
        for e in entries {
            if self.entries.contains_key(&e.hash) {
                continue; // 已有, 去重
            }
            Self::verify_entry(e)?;
            if let Some(acl) = &self.acl {
                if !acl.allows(&e.signer) {
                    return Err(OpLogError::NotAllowed(e.signer.clone()));
                }
            }
            pending.push(e.clone());
        }
        // 反复尝试插入 (prev 可能后到: 每轮 entries 增长, 上一轮失败的下一轮可能成)
        loop {
            let before = self.entries.len();
            let mut still_pending = Vec::new();
            for e in std::mem::take(&mut pending) {
                let prev_ok = e.prev.iter().all(|p| self.entries.contains_key(p));
                if prev_ok || e.prev.is_empty() {
                    self.insert_entry(e);
                } else {
                    still_pending.push(e);
                }
            }
            pending = still_pending;
            if self.entries.len() == before || pending.is_empty() {
                if !pending.is_empty() {
                    // 有 entry 的 prev 永远到不了 → 拉块不完整
                    let missing: Vec<String> = pending
                        .iter()
                        .flat_map(|e| e.prev.clone())
                        .filter(|p| !self.entries.contains_key(p))
                        .collect();
                    return Err(OpLogError::MissingPrev(missing.first().cloned().unwrap_or_default()));
                }
                break;
            }
        }
        Ok(self.entries.len() - len_before)
    }

    /// 遍历整条 DAG → 确定性线性序 (clock 升序, 同 clock 按 hash 排)
    ///
    /// 对齐 TS: 日志要到遍历结束才成形
    pub fn traverse(&self) -> Vec<&OpEntry> {
        let mut list: Vec<&OpEntry> = self.entries.values().collect();
        list.sort_by(|a, b| a.clock.cmp(&b.clock).then(a.hash.cmp(&b.hash)));
        list
    }

    /// 当前 heads
    pub fn heads(&self) -> &[String] {
        &self.heads
    }

    /// 缺失块探测: 沿远端 heads 的 prev 链找出本节点没有的 hash (拉块请求用)
    ///
    /// `remote_entries`: 远端提供的 entry 视图 (至少含 heads 沿链条目)
    pub fn missing_for(&self, remote_heads: &[String], remote_entries: &[OpEntry]) -> Vec<String> {
        let by_hash: HashMap<&str, &OpEntry> =
            remote_entries.iter().map(|e| (e.hash.as_str(), e)).collect();
        let mut missing = Vec::new();
        let mut stack: Vec<String> = remote_heads
            .iter()
            .filter(|h| !self.entries.contains_key(*h))
            .cloned()
            .collect();
        let mut queued: HashSet<String> = stack.iter().cloned().collect();
        let mut visited: HashSet<String> = HashSet::new();
        while let Some(h) = stack.pop() {
            if visited.contains(&h) {
                continue;
            }
            visited.insert(h.clone());
            missing.push(h.clone());
            if let Some(e) = by_hash.get(h.as_str()) {
                for p in &e.prev {
                    if !self.entries.contains_key(p) && !queued.contains(p) {
                        queued.insert(p.clone());
                        stack.push(p.clone());
                    }
                }
            }
        }
        missing
    }

    /// 当前条数
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否已存在某条 entry (复制落盘时判断"这条是新收下的")
    pub fn contains(&self, hash: &str) -> bool {
        self.entries.contains_key(hash)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    #[test]
    fn append_grows_head_and_clock() {
        let kp = kp(1);
        let mut log = OpLog::new(kp.did.as_str());
        let e1 = log.append(&kp, serde_json::json!({"text": "m1"}), 100).unwrap();
        let e2 = log.append(&kp, serde_json::json!({"text": "m2"}), 200).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log.heads(), std::slice::from_ref(&e2.hash), "e1 有后继, 不再是 head");
        assert!(e2.clock > e1.clock);
        assert_eq!(e2.prev, std::slice::from_ref(&e1.hash), "prev 指向前驱");
    }

    #[test]
    fn acl_owner_only_blocks_stranger() {
        let owner = kp(1);
        let stranger = kp(2);
        let mut log = OpLog::new(owner.did.as_str());
        assert!(log.append(&owner, serde_json::json!({"x": 1}), 1).is_ok());
        assert!(matches!(
            log.append(&stranger, serde_json::json!({"x": 2}), 2),
            Err(OpLogError::NotAllowed(_))
        ));
        assert_eq!(log.len(), 1, "被拒的 entry 不入 log");
    }

    #[test]
    fn acl_whitelist_allows_member() {
        let owner = kp(1);
        let member = kp(2);
        let mut log = OpLog::with_acl(WriteAcl::whitelist(owner.did.as_str(), vec![member.did.as_str().into()]));
        assert!(log.append(&member, serde_json::json!({"x": 1}), 1).is_ok());
    }

    #[test]
    fn tampered_payload_fails_verify() {
        let kp = kp(1);
        let mut log = OpLog::new(kp.did.as_str());
        let mut e = log.append(&kp, serde_json::json!({"text": "真消息"}), 1).unwrap();
        e.payload = serde_json::json!({"text": "被改的消息"});
        assert!(matches!(OpLog::verify_entry(&e), Err(OpLogError::HashMismatch { .. })), "改载荷 → hash 对不上");
    }

    #[test]
    fn forged_signature_fails_verify() {
        let kp = kp(1);
        let mut log = OpLog::new(kp.did.as_str());
        let mut e = log.append(&kp, serde_json::json!({}), 1).unwrap();
        // 换签名者但不重签
        let impostor = KeyPair::from_seed(&[9u8; 32]);
        e.signer = impostor.did.as_str().into();
        // hash 也要跟着改才绕得过 hash 门 —— 模拟攻击者重算 hash
        e.hash = entry_hash(e.clock, &e.prev, &e.signer, &e.payload, e.timestamp_ms);
        assert!(matches!(OpLog::verify_entry(&e), Err(OpLogError::BadSignature(_))), "重算 hash 也过不了签名门");
    }

    #[test]
    fn traverse_deterministic_linear_order() {
        let kp = kp(1);
        let mut log = OpLog::new(kp.did.as_str());
        for i in 0..10 {
            log.append(&kp, serde_json::json!({"i": i}), 100 + i).unwrap();
        }
        let t1: Vec<String> = log.traverse().iter().map(|e| e.hash.clone()).collect();
        let t2: Vec<String> = log.traverse().iter().map(|e| e.hash.clone()).collect();
        assert_eq!(t1, t2, "遍历确定性");
        assert_eq!(t1.len(), 10);
        // clock 单调
        let clocks: Vec<u64> = log.traverse().iter().map(|e| e.clock).collect();
        let mut sorted = clocks.clone();
        sorted.sort();
        assert_eq!(clocks, sorted);
    }

    #[test]
    fn concurrent_writers_merge_via_join() {
        // A、B 各自独立写 (同一创世 prev), join 合并 → 分叉再合并, 不丢消息
        let a = kp(1);
        let b = kp(2);
        let mut log_a = OpLog::with_acl(WriteAcl::whitelist(a.did.as_str(), vec![b.did.as_str().into()]));
        let e0 = log_a.append(&a, serde_json::json!({"text": "创世"}), 100).unwrap();

        // B 拿到 e0 后独立写两条
        let mut log_b = OpLog::with_acl(WriteAcl::whitelist(a.did.as_str(), vec![b.did.as_str().into()]));
        log_b.join(std::slice::from_ref(&e0)).unwrap();
        let b1 = log_b.append(&b, serde_json::json!({"text": "B 的消息 1"}), 200).unwrap();
        let b2 = log_b.append(&b, serde_json::json!({"text": "B 的消息 2"}), 300).unwrap();

        // A 也独立写一条 (分叉)
        let a1 = log_a.append(&a, serde_json::json!({"text": "A 的消息"}), 250).unwrap();

        // 交换: A 收 B 的两条, B 收 A 的一条
        log_a.join(&[b1.clone(), b2.clone()]).unwrap();
        log_b.join(std::slice::from_ref(&a1)).unwrap();

        // 两边收敛: 相同的 entry 集合与 heads
        assert_eq!(log_a.len(), 4);
        assert_eq!(log_b.len(), 4);
        let mut heads_a = log_a.heads().to_vec();
        let mut heads_b = log_b.heads().to_vec();
        heads_a.sort();
        heads_b.sort();
        assert_eq!(heads_a, heads_b, "join 后 heads 收敛");
        // 线性序一致 (重放基础)
        let order_a: Vec<String> = log_a.traverse().iter().map(|e| e.hash.clone()).collect();
        let order_b: Vec<String> = log_b.traverse().iter().map(|e| e.hash.clone()).collect();
        assert_eq!(order_a, order_b, "两边遍历序一致 → 索引重建逐条一致");
    }

    #[test]
    fn join_rejects_stranger_entry() {
        let a = kp(1);
        let stranger = kp(9);
        let mut log = OpLog::new(a.did.as_str());
        let mut foreign = OpLog::new(stranger.did.as_str());
        let e = foreign.append(&stranger, serde_json::json!({"evil": true}), 1).unwrap();
        assert!(matches!(log.join(&[e]), Err(OpLogError::NotAllowed(_))));
    }

    #[test]
    fn join_duplicate_entries_deduped() {
        let a = kp(1);
        let mut log = OpLog::new(a.did.as_str());
        let e = log.append(&a, serde_json::json!({"x": 1}), 1).unwrap();
        let n = log.join(std::slice::from_ref(&e)).unwrap();
        assert_eq!(log.len(), 1, "重放同 entry 去重");
        assert_eq!(n, 0, "已有的 entry 不算新增 (join 返回真新增条数)");
    }

    #[test]
    fn index_rebuild_from_entries_matches_original() {
        // P2 语义: 从 entries 重放重建索引, 与原一致
        let kp = kp(1);
        let mut log = OpLog::new(kp.did.as_str());
        for i in 0..20 {
            log.append(&kp, serde_json::json!({"seq": i, "text": format!("消息 {i}")}), 1000 + i).unwrap();
        }
        // 模拟: 只拿到 entries (无 head 信息) → 重建
        let all: Vec<OpEntry> = log.traverse().iter().map(|e| (*e).clone()).collect();
        let mut rebuilt = OpLog::new(kp.did.as_str());
        rebuilt.join(&all).unwrap();
        let orig_view: Vec<String> = log.traverse().iter().map(|e| e.payload["text"].as_str().unwrap().to_string()).collect();
        let new_view: Vec<String> = rebuilt.traverse().iter().map(|e| e.payload["text"].as_str().unwrap().to_string()).collect();
        assert_eq!(orig_view, new_view, "重建视图与原逐条一致");
    }

    #[test]
    fn shard_rotation_documented() {
        // SHARD_SIZE 常量与 TS 对齐 (每 N 条轮转新片, manifest oplog O(片数))
        assert_eq!(SHARD_SIZE, 500);
    }
}
