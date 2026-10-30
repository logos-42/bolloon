//! 上下文文档指纹 — 自动失效链
//!
//! 对齐 TS 版 `bootstrap/context-collector.ts` (contextFingerprint):
//! 文档 (Bolloon.md / AGENTS.md / persona 等) 的 mtime+size 指纹 →
//! **文档改了下一轮生效**, 不再等 24h 缓存过期。
//!
//! 链路: fingerprint(before) → 编辑文档 → fingerprint(after) 不同 → 缓存失效重建。

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// 单文档指纹 (mtime_ms + size)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocStat {
    pub mtime_ms: u64,
    pub size: u64,
}

/// 文档指纹表 (BTreeMap 保稳定排序 → 指纹确定性)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContextFingerprint {
    docs: BTreeMap<String, DocStat>,
}

impl ContextFingerprint {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从磁盘扫描指定文档集 (不存在的文档记 size=0/mtime=0, 也参与指纹 →
    /// 文档新建/删除同样触发失效)
    pub fn scan(paths: &[std::path::PathBuf]) -> Self {
        let mut docs = BTreeMap::new();
        for p in paths {
            let key = p.display().to_string();
            let stat = std::fs::metadata(p)
                .map(|m| {
                    let mtime_ms = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    DocStat { mtime_ms, size: m.len() }
                })
                .unwrap_or(DocStat { mtime_ms: 0, size: 0 });
            docs.insert(key, stat);
        }
        Self { docs }
    }

    /// 指纹哈希 (确定性: 键排序已由 BTreeMap 保证)
    pub fn hash(&self) -> String {
        let mut h = Sha256::new();
        for (k, v) in &self.docs {
            h.update(k.as_bytes());
            h.update(v.mtime_ms.to_le_bytes());
            h.update(v.size.to_le_bytes());
        }
        hex::encode(h.finalize())
    }

    /// 是否失效 (对另一份指纹)
    pub fn changed_since(&self, other: &ContextFingerprint) -> bool {
        self.hash() != other.hash()
    }

    pub fn doc_count(&self) -> usize {
        self.docs.len()
    }
}

/// 内存态文档表 (测试/无盘环境; 语义同 scan)
#[derive(Debug, Default)]
pub struct InMemoryDocs {
    docs: BTreeMap<String, DocStat>,
}

impl InMemoryDocs {
    pub fn new() -> Self {
        Self::default()
    }
}

impl InMemoryDocs {
    pub fn set(&mut self, path: &str, mtime_ms: u64, size: u64) {
        self.docs.insert(path.into(), DocStat { mtime_ms, size });
    }

    pub fn fingerprint(&self) -> ContextFingerprint {
        ContextFingerprint { docs: self.docs.clone() }
    }
}

/// 身份/上下文文档集: 按 channel 区分**全局(跨项目共享)** 与 **项目内(当前仓库)** 文件的优先级。
///
/// - `local`: 项目内优先 (贴当前工程), 全局兜底
/// - `web`/`app`/`p2p`/`group`/其它: 全局优先 (跨端一致的 bolloon 身份), 项目内补充
///
/// 文档改了下一轮生效 (见 `ContextFingerprint`); 这里只决定"按 channel 该优先读哪份"。
pub fn identity_doc_paths(channel: &str, project_root: &Path, home: &Path) -> Vec<std::path::PathBuf> {
    let global = vec![
        home.join(".bolloon").join("persona").join("persona.json"),
        home.join(".bolloon").join("Bolloon.md"),
        home.join(".bolloon").join("rust").join("Bolloon.md"),
    ];
    let project = vec![
        project_root.join("Bolloon.md"),
        project_root.join("AGENTS.md"),
        project_root.join("CLAUDE.md"),
    ];
    let (first, second) = if channel == "local" {
        (project, global) // 项目内优先, 全局兜底
    } else {
        (global, project) // web/app/p2p/group: 全局优先, 项目内补充
    };
    let mut out = first;
    out.extend(second);
    out
}

/// 旧签名兼容 (默认按 `local`: 项目内优先)
pub fn context_doc_paths(project_root: &Path, home: &Path) -> Vec<std::path::PathBuf> {
    identity_doc_paths("local", project_root, home)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_state_same_hash() {
        let mut d = InMemoryDocs::new();
        d.set("Bolloon.md", 100, 500);
        d.set("AGENTS.md", 200, 300);
        assert_eq!(d.fingerprint().hash(), d.fingerprint().hash());
    }

    #[test]
    fn mtime_change_invalidates() {
        let mut d = InMemoryDocs::new();
        d.set("Bolloon.md", 100, 500);
        let before = d.fingerprint();
        d.set("Bolloon.md", 200, 500); // 只改 mtime (touch)
        let after = d.fingerprint();
        assert!(after.changed_since(&before), "touch 也要触发失效");
    }

    #[test]
    fn size_change_invalidates() {
        let mut d = InMemoryDocs::new();
        d.set("Bolloon.md", 100, 500);
        let before = d.fingerprint();
        d.set("Bolloon.md", 100, 600);
        assert!(d.fingerprint().changed_since(&before));
    }

    #[test]
    fn doc_added_or_removed_invalidates() {
        let mut d = InMemoryDocs::new();
        d.set("a.md", 1, 1);
        let before = d.fingerprint();
        d.set("b.md", 1, 1); // 新建
        assert!(d.fingerprint().changed_since(&before));
        d.docs.remove("b.md");
        d.set("b.md", 0, 0); // 删除 = 记 0 (scan 语义)
        assert!(d.fingerprint().changed_since(&before), "删除也触发失效");
    }

    #[test]
    fn hash_deterministic_across_insertion_order() {
        let mut d1 = InMemoryDocs::new();
        d1.set("a.md", 1, 1);
        d1.set("b.md", 2, 2);
        let mut d2 = InMemoryDocs::new();
        d2.set("b.md", 2, 2);
        d2.set("a.md", 1, 1);
        assert_eq!(
            d1.fingerprint().hash(),
            d2.fingerprint().hash(),
            "插入顺序不影响指纹 (BTreeMap)"
        );
    }

    #[test]
    fn local_prefers_project_docs() {
        let h = crate::home::BolloonHome::at(
            std::env::temp_dir().join(format!("bolloon-id-local-{}", std::process::id())),
        );
        let p = std::path::Path::new("/proj");
        let v = identity_doc_paths("local", p, h.root());
        assert!(v[0].starts_with("/proj"), "local 项目内优先: {:?}", v[0]);
        assert_eq!(v[0].file_name().unwrap(), "Bolloon.md");
    }

    #[test]
    fn web_prefers_global_persona() {
        let h = crate::home::BolloonHome::at(
            std::env::temp_dir().join(format!("bolloon-id-web-{}", std::process::id())),
        );
        let p = std::path::Path::new("/proj");
        let v = identity_doc_paths("web", p, h.root());
        assert!(v[0].starts_with(h.root()), "web 全局优先: {:?}", v[0]);
        assert!(
            v.iter().any(|x| x.ends_with("persona.json")),
            "全局 persona 应在集合内: {:?}",
            v
        );
        // 项目内文档仍作为补充出现在后面
        assert!(v.iter().any(|x| x.starts_with("/proj")), "项目内补充在内");
    }

    #[test]
    fn missing_file_scans_as_zero() {
        let fps = ContextFingerprint::scan(&[std::path::PathBuf::from("/nonexistent/xx.md")]);
        assert_eq!(fps.doc_count(), 1);
        // 与空表不同 (缺失也是状态)
        assert_ne!(fps.hash(), ContextFingerprint::new().hash());
    }

    #[test]
    fn doc_edited_next_round_takes_effect_chain() {
        // 完整链路: build(指纹A) → 缓存 → 文档改 → build(指纹B≠A) → 缓存失效重建
        let mut d = InMemoryDocs::new();
        d.set("Bolloon.md", 1, 100);
        let cache_key = d.fingerprint().hash();
        // (缓存用 cache_key 存)
        d.set("Bolloon.md", 2, 120);
        let new_key = d.fingerprint().hash();
        assert_ne!(cache_key, new_key, "文档改了 → key 变 → miss 重建");
    }
}
