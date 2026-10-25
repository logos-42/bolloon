//! Bolloon Home — 路径与 env 的单一真源
//!
//! 纪律 (本批冻结):
//! - **CLI / Web / Tauri App / SDK 全部走同一路径加载**: `BOLLOON_HOME` (缺省 `~/.bolloon`)
//!   下的 `rust/` 子目录 —— env 一处解析, 四端共享 (改 BOLLOON_HOME 即整体隔离)
//! - **智能体之间有专属目录**: `agents/<agent_id>/` 下 memory / soul.md / agent.md / sessions
//! - **memory / soul / agent 文档快照冻结**: AgentDocs::freeze 在装载时拍快照 (内容+指纹);
//!   运行期间文档改动**不影响本轮** (快照即真源), 指纹变了 ⇒ 下一会话/下一轮重建时生效
//! - 每轮 system prompt 由快照装配 (runtime.rs), 不直接读盘

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::documents::DocStat;

/// Home 错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum HomeError {
    #[error("agent_id 非法 (只许字母数字-_): {0}")]
    BadAgentId(String),
    #[error("IO: {0}")]
    Io(String),
}

/// agent_id 合法性 (目录名安全)
pub fn validate_agent_id(id: &str) -> Result<(), HomeError> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(HomeError::BadAgentId(id.into()))
    }
}

/// Bolloon Home 路径族 (CLI/Web/App/SDK 唯一入口)
#[derive(Debug, Clone)]
pub struct BolloonHome {
    root: PathBuf,
}

impl BolloonHome {
    /// 解析: BOLLOON_HOME env 优先, 缺省 ~/.bolloon; rust 版全部走其下 `rust/` 子目录
    pub fn resolve() -> Self {
        let base = std::env::var("BOLLOON_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs_home().join(".bolloon")
            });
        Self { root: base.join("rust") }
    }

    /// 显式指定 (测试/App 注入)
    pub fn at(base: impl Into<PathBuf>) -> Self {
        Self { root: base.into().join("rust") }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 配置 (llm-config 等, 四端共享同一份)
    pub fn config_dir(&self) -> PathBuf {
        self.root.join("config")
    }

    /// 会话 (全部 session 共享池, 按 session_id 分文件)
    pub fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }

    /// 日志 (启动/演化/判断力留痕)
    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    /// **智能体专属目录** (agent 之间互不串)
    pub fn agent_dir(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        validate_agent_id(agent_id)?;
        Ok(self.root.join("agents").join(agent_id))
    }

    pub fn agent_memory_path(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        Ok(self.agent_dir(agent_id)?.join("memory.json"))
    }

    pub fn agent_soul_path(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        Ok(self.agent_dir(agent_id)?.join("soul.md"))
    }

    pub fn agent_doc_path(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        Ok(self.agent_dir(agent_id)?.join("agent.md"))
    }

    pub fn agent_sessions_dir(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        Ok(self.agent_dir(agent_id)?.join("sessions"))
    }

    /// 建 agent 目录族 (幂等)
    pub fn ensure_agent(&self, agent_id: &str) -> Result<PathBuf, HomeError> {
        let dir = self.agent_dir(agent_id)?;
        std::fs::create_dir_all(dir.join("sessions"))
            .map_err(|e| HomeError::Io(format!("{e}")))?;
        Ok(dir)
    }

    pub fn list_agents(&self) -> Result<Vec<String>, HomeError> {
        let dir = self.root.join("agents");
        if !dir.exists() {
            return Ok(vec![]);
        }
        let mut out = Vec::new();
        let rd = std::fs::read_dir(&dir).map_err(|e| HomeError::Io(e.to_string()))?;
        for e in rd.flatten() {
            if e.path().is_dir() {
                if let Some(name) = e.file_name().to_str() {
                    out.push(name.to_string());
                }
            }
        }
        out.sort();
        Ok(out)
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h))
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// 冻结的文档快照 (装载时拍; 运行期间即真源)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DocSnapshot {
    /// 文档种类: soul | agent | memory
    pub kind: String,
    /// 装载时的内容
    pub content: String,
    /// 内容哈希 (sha256 hex)
    pub content_hash: String,
    /// 盘上状态指纹 (mtime+size; 文档缺失时全 0)
    pub stat: DocStat,
}

impl DocSnapshot {
    /// 从路径冻结 (读盘 + 拍快照; 文档不存在 = 空快照, 也参与指纹)
    pub fn freeze(kind: &str, path: &Path) -> Self {
        let (content, stat) = match std::fs::read_to_string(path) {
            Ok(text) => {
                let mtime_ms = std::fs::metadata(path)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                (text, DocStat { mtime_ms, size })
            }
            Err(_) => (String::new(), DocStat { mtime_ms: 0, size: 0 }),
        };
        let content_hash = {
            let d = Sha256::digest(content.as_bytes());
            hex::encode(d)
        };
        Self { kind: kind.into(), content, content_hash, stat }
    }

    /// 快照指纹 (内容哈希; 不看盘 —— 冻结语义: 运行期间不重读)
    pub fn fingerprint(&self) -> &str {
        &self.content_hash
    }

    /// 盘上文档是否已偏离快照 (下一会话生效的判定; **不在运行中触发重载**)
    pub fn disk_drifted(&self, path: &Path) -> bool {
        let now = DocSnapshot::freeze(&self.kind, path);
        now.content_hash != self.content_hash
    }
}

/// agent 文档三件套快照 (soul / agent / memory)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDocs {
    pub agent_id: String,
    pub soul: DocSnapshot,
    pub agent: DocSnapshot,
    /// memory 快照 (冻结时点; 运行中新记忆写入 store 本体, 快照只供 system prompt 稳定层)
    pub memory: DocSnapshot,
}

impl AgentDocs {
    /// 冻结装载 (home 注入; 缺失文档 = 空快照 + 内置缺省)
    pub fn freeze(home: &BolloonHome, agent_id: &str) -> Result<Self, HomeError> {
        home.ensure_agent(agent_id)?;
        let mut soul = DocSnapshot::freeze("soul", &home.agent_soul_path(agent_id)?);
        if soul.content.is_empty() {
            soul.content = default_soul(agent_id);
        }
        let mut agent = DocSnapshot::freeze("agent", &home.agent_doc_path(agent_id)?);
        if agent.content.is_empty() {
            agent.content = default_agent_doc(agent_id);
        }
        let memory = DocSnapshot::freeze("memory", &home.agent_memory_path(agent_id)?);
        Ok(Self { agent_id: agent_id.into(), soul, agent, memory })
    }

    /// 三件套指纹是否与盘一致 (任何一份 drift = 本 agent 需要 re-freeze)
    pub fn any_disk_drift(&self, home: &BolloonHome) -> Result<bool, HomeError> {
        Ok(self.soul.disk_drifted(&home.agent_soul_path(&self.agent_id)?)
            || self.agent.disk_drifted(&home.agent_doc_path(&self.agent_id)?)
            || self.memory.disk_drifted(&home.agent_memory_path(&self.agent_id)?))
    }
}

fn default_soul(agent_id: &str) -> String {
    format!("# Soul · {agent_id}\n\n合作 · 分享 · 探索。矛盾中找平衡，混沌中找秩序。内心持有，不必随时显示。\n")
}

fn default_agent_doc(agent_id: &str) -> String {
    format!("# Agent · {agent_id}\n\n角色: Bolloon 智能体 (rust native 0.6.10)。\n能力: 工具循环 / 群聊 / 长目标执行。\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> BolloonHome {
        let dir = std::env::temp_dir().join(format!(
            "bolloon-home-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        BolloonHome::at(&dir)
    }

    #[test]
    fn path_family_single_source() {
        let h = tmp_home("paths");
        let agents = h.agent_dir("leo").unwrap();
        assert!(agents.ends_with("agents/leo"));
        assert!(h.agent_memory_path("leo").unwrap().ends_with("agents/leo/memory.json"));
        assert!(h.agent_soul_path("leo").unwrap().ends_with("agents/leo/soul.md"));
        assert!(h.agent_sessions_dir("leo").unwrap().ends_with("agents/leo/sessions"));
        // 四端共享: config/sessions/logs 在 root 下, 不在 agent 下
        assert!(h.config_dir().ends_with("rust/config"));
        assert!(h.sessions_dir().ends_with("rust/sessions"));
    }

    #[test]
    fn agent_id_validated() {
        assert!(validate_agent_id("leo").is_ok());
        assert!(validate_agent_id("agent-01_x").is_ok());
        assert_eq!(
            validate_agent_id("../evil").unwrap_err(),
            HomeError::BadAgentId("../evil".into()),
            "路径穿越拒"
        );
        assert_eq!(validate_agent_id("").unwrap_err(), HomeError::BadAgentId("".into()));
        assert_eq!(
            validate_agent_id("空格 id").unwrap_err(),
            HomeError::BadAgentId("空格 id".into())
        );
    }

    #[test]
    fn ensure_agent_creates_dir_family() {
        let h = tmp_home("ensure");
        let dir = h.ensure_agent("a1").unwrap();
        assert!(dir.join("sessions").is_dir());
        assert!(h.list_agents().unwrap().contains(&"a1".into()));
    }

    #[test]
    fn freeze_snapshots_content_and_hash() {
        let h = tmp_home("freeze");
        h.ensure_agent("a1").unwrap();
        std::fs::write(h.agent_soul_path("a1").unwrap(), "# Soul\n专注极简。").unwrap();
        let docs = AgentDocs::freeze(&h, "a1").unwrap();
        assert!(docs.soul.content.contains("专注极简"));
        assert_eq!(docs.soul.content_hash.len(), 64);
        // 再 freeze 同内容 → 同指纹
        let docs2 = AgentDocs::freeze(&h, "a1").unwrap();
        assert_eq!(docs.soul.fingerprint(), docs2.soul.fingerprint());
    }

    #[test]
    fn missing_docs_get_defaults() {
        let h = tmp_home("defaults");
        let docs = AgentDocs::freeze(&h, "fresh").unwrap();
        assert!(docs.soul.content.contains("Soul · fresh"), "缺省 soul 有内置文案");
        assert!(docs.agent.content.contains("rust native 0.6.10"));
    }

    #[test]
    fn snapshot_frozen_disk_edit_not_visible_in_snapshot() {
        // 冻结语义: 快照在手, 盘上改了**不影响已冻结内容**
        let h = tmp_home("frozen");
        h.ensure_agent("a1").unwrap();
        std::fs::write(h.agent_soul_path("a1").unwrap(), "v1").unwrap();
        let docs = AgentDocs::freeze(&h, "a1").unwrap();
        assert_eq!(docs.soul.content, "v1");
        // 盘上改
        std::fs::write(h.agent_soul_path("a1").unwrap(), "v2 已改").unwrap();
        // 快照不变 (运行期间即真源)
        assert_eq!(docs.soul.content, "v1");
        // 但 drift 检测能看见 (下一会话生效)
        assert!(docs.any_disk_drift(&h).unwrap(), "盘已偏离快照 → 下一会话要 re-freeze");
    }

    #[test]
    fn no_drift_when_untouched() {
        let h = tmp_home("nodrift");
        h.ensure_agent("a1").unwrap();
        std::fs::write(h.agent_soul_path("a1").unwrap(), "稳定").unwrap();
        let docs = AgentDocs::freeze(&h, "a1").unwrap();
        assert!(!docs.any_disk_drift(&h).unwrap());
    }

    #[test]
    fn env_shared_means_same_home_for_all_ends() {
        // 四端同口径: BolloonHome::resolve() 读同一个 BOLLOON_HOME
        // (这里验证 at() 与 resolve() 的 root 拼接口径一致: base + "rust")
        // SAFETY: 测试进程内串行改 env, 无并发读者
        unsafe {
            std::env::set_var("BOLLOON_HOME", "/tmp/bolloon-env-shared-test");
        }
        let resolved = BolloonHome::resolve();
        assert!(resolved.root().ends_with("bolloon-env-shared-test/rust"));
        let explicit = BolloonHome::at("/tmp/bolloon-env-shared-test");
        assert_eq!(resolved.root(), explicit.root());
        // SAFETY: 同上
        unsafe {
            std::env::remove_var("BOLLOON_HOME");
        }
    }

    #[test]
    fn agents_isolated_dirs() {
        let h = tmp_home("isolate");
        h.ensure_agent("a1").unwrap();
        h.ensure_agent("a2").unwrap();
        let m1 = h.agent_memory_path("a1").unwrap();
        let m2 = h.agent_memory_path("a2").unwrap();
        assert_ne!(m1, m2, "agent 之间 memory 互不串");
        assert!(m1.parent().unwrap() != m2.parent().unwrap());
    }
}
