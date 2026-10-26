//! OrbitDB 复制协议 — heads 交换 → 缺块拉取 → join → 索引重建
//!
//! 对齐 TS 版 P0/P0b 真两节点复制语义:
//! - 复制三步: ① 交换 heads ② 按缺失链拉块 ③ join 收敛
//! - 拉块经由 `BlockExchange` 端口 (真传输接 gossip/iroh; 测试用内存交换)
//! - 收敛判据: 两节点 entries 集合一致 + heads 一致 + 遍历线性序一致
//!
//! 诚实边界: 本文件用内存交换端口真验协议闭环; 跨机真传输接同一端口。

use crate::oplog::{OpEntry, OpLog};

/// 拉块端口 (真传输实现此 trait; 测试用内存实现)
pub trait BlockExchange {
    /// 拉取指定 hashes 的 entries (拿不到的如实缺失, 不编)
    fn fetch(&self, hashes: &[String]) -> Vec<OpEntry>;
    /// 本节点当前的 entries 快照 (供对方拉)
    fn provide_all(&self) -> Vec<OpEntry>;
}

/// 内存交换 (测试/单机多节点)
pub struct MemoryExchange<'a> {
    pub from: &'a OpLog,
}

impl<'a> BlockExchange for MemoryExchange<'a> {
    fn fetch(&self, hashes: &[String]) -> Vec<OpEntry> {
        let all = self.from.traverse();
        all.into_iter()
            .filter(|e| hashes.contains(&e.hash))
            .cloned()
            .collect()
    }

    fn provide_all(&self) -> Vec<OpEntry> {
        self.from.traverse().into_iter().cloned().collect()
    }
}

/// 磁盘块交换 —— 块真在磁盘上 (`root/{address}/blocks/<hash>.json`)
///
/// 这是**真块交换**而非内存替身: 拉块走文件读, 写块走文件写。
/// 与跨机传输是**同一个端口形态** (只认 hash, 不认人) —— 跨机时把这一层换成网络传输即可,
/// 上层复制协议 (heads → 缺块链 → join) 一行不改。
pub struct FileExchange {
    pub root: std::path::PathBuf,
    pub address: String,
}

impl FileExchange {
    pub fn new(root: &std::path::Path, address: &str) -> Self {
        Self { root: root.to_path_buf(), address: address.to_string() }
    }

    fn blocks_dir(&self) -> std::path::PathBuf {
        crate::orbit_store::blocks_dir_of(&self.root, &self.address)
    }

    fn read_block(&self, hash: &str) -> Option<OpEntry> {
        let path = self.blocks_dir().join(format!("{hash}.json"));
        let raw = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&raw).ok()
    }
}

impl BlockExchange for FileExchange {
    fn fetch(&self, hashes: &[String]) -> Vec<OpEntry> {
        let mut out = Vec::new();
        for h in hashes {
            if let Some(e) = self.read_block(h) {
                out.push(e);
            }
        }
        out
    }

    fn provide_all(&self) -> Vec<OpEntry> {
        let dir = self.blocks_dir();
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut files: Vec<std::path::PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        files.sort();
        let mut out = Vec::new();
        for f in files {
            if let Ok(raw) = std::fs::read_to_string(&f) {
                if let Ok(e) = serde_json::from_str::<OpEntry>(&raw) {
                    out.push(e);
                }
            }
        }
        out
    }
}

/// 复制结果
#[derive(Debug, Clone, PartialEq)]
pub struct ReplicationReport {
    pub entries_before: usize,
    pub entries_after: usize,
    pub fetched: usize,
    pub converged: bool,
    /// 收敛失败原因 (如实)
    pub failure: Option<String>,
}

/// 执行复制: 本节点 (self_log) 从远端 (exchange) 拉齐到远端 heads
///
/// 步骤:
/// 1. 拿远端全部 entries 视图 → 算缺失链 (missing_for)
/// 2. fetch 拉缺失块
/// 3. join (验签+ACL 在 oplog 内强制)
/// 4. 收敛判定: 本地 heads ⊆ 远端 heads 线性化后遍历序与远端一致
pub fn replicate<E: BlockExchange>(
    self_log: &mut OpLog,
    exchange: &E,
    remote_heads: &[String],
) -> ReplicationReport {
    let before = self_log.len();
    let remote_entries = exchange.provide_all();

    // ① 算缺失链
    let missing = self_log.missing_for(remote_heads, &remote_entries);
    if missing.is_empty() {
        // 无缺失 → 已收敛 (验证 heads)
        let converged = heads_converged(self_log, remote_heads);
        return ReplicationReport {
            entries_before: before,
            entries_after: self_log.len(),
            fetched: 0,
            converged,
            failure: if converged { None } else { Some("无缺失但 heads 不一致 (分叉?)".into()) },
        };
    }

    // ② 拉缺失块
    let fetched_entries = exchange.fetch(&missing);

    // ③ join (oplog 内部验签/ACL/prev 完整性)
    match self_log.join(&fetched_entries) {
        Ok(_) => {}
        Err(e) => {
            return ReplicationReport {
                entries_before: before,
                entries_after: self_log.len(),
                fetched: fetched_entries.len(),
                converged: false,
                failure: Some(format!("join 失败: {e}")),
            }
        }
    }

    // ④ 收敛判定: 遍历序一致 (逐条 payload 相同)
    let remote_view: Vec<String> = {
        let mut es: Vec<&OpEntry> = remote_entries.iter().collect();
        es.sort_by(|a, b| a.clock.cmp(&b.clock).then(a.hash.cmp(&b.hash)));
        es.iter().map(|e| e.hash.clone()).collect()
    };
    let local_view: Vec<String> = self_log.traverse().iter().map(|e| e.hash.clone()).collect();
    let converged = local_view == remote_view;

    ReplicationReport {
        entries_before: before,
        entries_after: self_log.len(),
        fetched: fetched_entries.len(),
        converged,
        failure: if converged {
            None
        } else {
            Some("遍历序与远端不一致 (缺块或分叉)".into())
        },
    }
}

fn heads_converged(log: &OpLog, remote_heads: &[String]) -> bool {
    let mut a = log.heads().to_vec();
    let mut b = remote_heads.to_vec();
    a.sort();
    b.sort();
    a == b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::KeyPair;

    fn kp(seed: u8) -> KeyPair {
        let mut s = [0u8; 32];
        s[0] = seed;
        KeyPair::from_seed(&s)
    }

    /// P0 真两节点: A 写 51 条 → B 从零复制 → 收敛 (B 能读出全部 51 条)
    #[test]
    fn two_node_replication_51_entries() {
        let a = kp(1);
        let mut log_a = OpLog::new(a.did.as_str());
        for i in 0..51 {
            log_a
                .append(&a, serde_json::json!({"seq": i, "text": format!("消息 {i}")}), 1000 + i as u64)
                .unwrap();
        }
        assert_eq!(log_a.len(), 51);

        // B 从零开始
        let mut log_b = OpLog::new(a.did.as_str()); // ACL 同一 owner (B 只读复制)
        let heads = log_a.heads().to_vec();
        let ex = MemoryExchange { from: &log_a };
        let report = replicate(&mut log_b, &ex, &heads);

        assert!(report.converged, "必须收敛: {:?}", report.failure);
        assert_eq!(report.entries_after, 51);
        assert_eq!(log_b.len(), 51);
        // B 遍历视图与 A 一致
        let view_a: Vec<String> = log_a.traverse().iter().map(|e| e.payload["text"].as_str().unwrap().into()).collect();
        let view_b: Vec<String> = log_b.traverse().iter().map(|e| e.payload["text"].as_str().unwrap().into()).collect();
        assert_eq!(view_a, view_b, "B 读到的与 A 逐条一致");
    }

    /// 增量复制: B 已有前 30 条, 只拉后 21 条
    #[test]
    fn incremental_replication_fetches_only_missing() {
        let a = kp(1);
        let mut log_a = OpLog::new(a.did.as_str());
        for i in 0..51 {
            log_a.append(&a, serde_json::json!({"i": i}), 1000 + i as u64).unwrap();
        }
        // B 先复制前 30 条 (截断视图)
        let first30: Vec<OpEntry> = log_a.traverse().into_iter().take(30).cloned().collect();
        let mut log_b = OpLog::new(a.did.as_str());
        log_b.join(&first30).unwrap();
        assert_eq!(log_b.len(), 30);

        // 增量复制
        let heads = log_a.heads().to_vec();
        let ex = MemoryExchange { from: &log_a };
        let report = replicate(&mut log_b, &ex, &heads);
        assert!(report.converged, "{:?}", report.failure);
        assert_eq!(report.entries_before, 30);
        assert_eq!(report.entries_after, 51, "只补了缺的 21 条");
        assert_eq!(report.fetched, 21);
    }

    /// 复制后 B 可以继续写 (heads 接续, 不分叉丢消息)
    #[test]
    fn replicated_node_can_continue_writing() {
        let a = kp(1);
        let b = kp(2);
        let mut log_a = OpLog::with_acl(crate::oplog::WriteAcl::whitelist(
            a.did.as_str(),
            vec![b.did.as_str().into()],
        ));
        for i in 0..5 {
            log_a.append(&a, serde_json::json!({"i": i}), 1000 + i).unwrap();
        }
        // B 复制
        let mut log_b = OpLog::with_acl(crate::oplog::WriteAcl::whitelist(
            a.did.as_str(),
            vec![b.did.as_str().into()],
        ));
        let heads = log_a.heads().to_vec();
        let ex = MemoryExchange { from: &log_a };
        let report = replicate(&mut log_b, &ex, &heads);
        assert!(report.converged);

        // B 继续写 (接在复制的 heads 上)
        let b1 = log_b.append(&b, serde_json::json!({"i": 5, "by": "B"}), 2000).unwrap();
        assert_eq!(b1.prev, heads.to_vec(), "B 的新 entry 接在复制来的 heads 上");
        assert_eq!(log_b.len(), 6);

        // A 拉 B 的新条目 → 双方再收敛 (4 条 A + 1 条 B = 6)
        let heads_b = log_b.heads().to_vec();
        let ex_b = MemoryExchange { from: &log_b };
        let report2 = replicate(&mut log_a, &ex_b, &heads_b);
        assert!(report2.converged, "A 拉 B 后收敛: {:?}", report2.failure);
        assert_eq!(log_a.len(), 6);
        let view_a: Vec<String> = log_a.traverse().iter().map(|e| e.hash.clone()).collect();
        let view_b: Vec<String> = log_b.traverse().iter().map(|e| e.hash.clone()).collect();
        assert_eq!(view_a, view_b, "双向复制后线性序一致");
    }

    fn bs58_sig(sig: &[u8; 64]) -> String {
        crate::b58_encode(sig)
    }

    /// 伪造 entry 无法通过复制 (join 内验签 + ACL)
    #[test]
    fn forged_entry_blocked_during_replication() {
        let a = kp(1);
        let mut log_a = OpLog::new(a.did.as_str());
        log_a.append(&a, serde_json::json!({"i": 1}), 1000).unwrap();

        // 攻击者把自己的 entry 接在真 head 上 (真实攻击面: 伪造下一跳)
        let attacker = kp(9);
        let heads = log_a.heads().to_vec();
        let evil_hash = crate::oplog::entry_hash(
            999,
            &heads.clone(),
            attacker.did.as_str(),
            &serde_json::json!({"evil": true}),
            1001,
        );
        // 攻击者签名的伪造 entry (prev 指向真 head)
        let unsigned = serde_json::json!({
            "clock": 999, "prev": heads, "signer": attacker.did.as_str(),
            "payload": {"evil": true}, "timestamp_ms": 1001,
        });
        let _ = unsigned;
        let evil = OpEntry {
            hash: evil_hash.clone(),
            clock: 999,
            prev: heads.clone(),
            signer: attacker.did.as_str().into(),
            signature: {
                // 攻击者自己签的 (canonical 结构与 oplog 相同)
                let body = serde_json::json!({
                    "clock": 999, "prev": heads, "signer": attacker.did.as_str(),
                    "payload": {"evil": true}, "timestamp_ms": 1001,
                });
                let canonical = crate::envelope::canonical_json(&body);
                bs58_sig(&attacker.sign(canonical.as_bytes()))
            },
            payload: serde_json::json!({"evil": true}),
            timestamp_ms: 1001,
        };

        let mut log_b = OpLog::new(a.did.as_str());
        // 交换被污染: 拉缺失链时附带伪造 entry (claim 它也是 head)
        struct Poisoned<'x> {
            inner: MemoryExchange<'x>,
            poison: OpEntry,
        }
        impl BlockExchange for Poisoned<'_> {
            fn fetch(&self, hashes: &[String]) -> Vec<OpEntry> {
                let mut v = self.inner.fetch(hashes);
                v.push(self.poison.clone());
                v
            }
            fn provide_all(&self) -> Vec<OpEntry> {
                let mut v = self.inner.provide_all();
                v.push(self.poison.clone());
                v
            }
        }
        let ex = Poisoned { inner: MemoryExchange { from: &log_a }, poison: evil };
        let report = replicate(&mut log_b, &ex, &heads);
        assert!(!report.converged, "伪造 entry 必须阻断复制");
        assert!(
            report.failure.as_deref().unwrap().contains("ACL 白名单"),
            "失败原因 = ACL 拒: {:?}",
            report.failure
        );
        assert_eq!(log_b.len(), 0, "被拒的不入 log");
    }

    /// 幂等: 已收敛的节点再复制 = no-op
    #[test]
    fn re_replication_is_noop() {
        let a = kp(1);
        let mut log_a = OpLog::new(a.did.as_str());
        for i in 0..5 {
            log_a.append(&a, serde_json::json!({"i": i}), 1000 + i).unwrap();
        }
        let mut log_b = OpLog::new(a.did.as_str());
        let heads = log_a.heads().to_vec();
        let ex = MemoryExchange { from: &log_a };
        assert!(replicate(&mut log_b, &ex, &heads).converged);
        let report2 = replicate(&mut log_b, &ex, &heads);
        assert!(report2.converged);
        assert_eq!(report2.fetched, 0, "无缺失不拉块");
        assert_eq!(report2.entries_after, 5);
    }
}
