//! Workspace — 工作区隔离 (文件操作约束在授权 root 内)
//!
//! 对齐 TS 版 workspace 语义 (agent 的文件操作不许越出工作区):
//! - 每 agent/session 一个 workspace root (home.rs 之下)
//! - **路径校验是唯一闸门**: resolve 后必须落在 root 内 (拒绝 ../ 穿越、绝对路径外逃、
//!   symlink 逃逸语义由真 fs 层校验, 这里做 canonical 词法校验)
//! - 读写白名单: workspace 内自由; workspace 外一律拒 (除非显式授权路径)

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 工作区错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WorkspaceError {
    #[error("路径越出工作区: {0}")]
    Outside(String),
    #[error("路径非法 (含 .. 穿越): {0}")]
    Traversal(String),
    #[error("workspace 未初始化")]
    NotInitialized,
}

/// 工作区
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub root: PathBuf,
}

impl Workspace {
    /// 建 workspace (root 为绝对路径)
    pub fn new(id: &str, root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self { id: id.into(), root }
    }

    /// 解析相对路径 → 绝对路径 (词法 canonical + 越界校验)
    ///
    /// 语义:
    /// - `a/b.txt` → `<root>/a/b.txt`
    /// - `../x` → 拒 (穿越)
    /// - `/etc/passwd` → 拒 (绝对路径外逃)
    /// - `a/./b/../c.txt` → canonical `<root>/a/c.txt`
    pub fn resolve(&self, rel: &str) -> Result<PathBuf, WorkspaceError> {
        // Windows 风格路径输入 → 拒 (防混淆穿越; unix 下反斜杠是合法文件名但 agent 输入面禁掉)
        if rel.contains('\\') {
            return Err(WorkspaceError::Outside(rel.into()));
        }
        let p = Path::new(rel);
        if p.is_absolute() {
            return Err(WorkspaceError::Outside(rel.into()));
        }
        // canonical 语义: .. 回退 pop 上一段; 顶层以上再回退 = 穿越
        let mut parts: Vec<String> = Vec::new();
        for comp in p.components() {
            match comp {
                Component::Normal(c) => parts.push(c.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::ParentDir => {
                    if parts.pop().is_none() {
                        return Err(WorkspaceError::Traversal(rel.into()));
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(WorkspaceError::Outside(rel.into()));
                }
            }
        }
        let mut full = self.root.clone();
        for part in parts {
            full.push(part);
        }
        Ok(full)
    }

    /// 读 (校验后返回绝对路径, 真 IO 由调用方)
    pub fn read_path(&self, rel: &str) -> Result<PathBuf, WorkspaceError> {
        self.resolve(rel)
    }

    /// 写 (同校验)
    pub fn write_path(&self, rel: &str) -> Result<PathBuf, WorkspaceError> {
        self.resolve(rel)
    }

    /// 列 workspace 内文件 (真 fs 由调用方; 这里给 root)
    pub fn root_path(&self) -> &Path {
        &self.root
    }

    /// 建 workspace 目录 (幂等)
    pub fn ensure(&self) -> Result<(), WorkspaceError> {
        std::fs::create_dir_all(&self.root).map_err(|_| WorkspaceError::NotInitialized)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> Workspace {
        Workspace::new("ws1", "/tmp/bolloon-ws-test/proj")
    }

    #[test]
    fn resolve_normal_paths() {
        let w = ws();
        assert_eq!(
            w.resolve("a/b.txt").unwrap(),
            PathBuf::from("/tmp/bolloon-ws-test/proj/a/b.txt")
        );
        assert_eq!(w.resolve("./a.txt").unwrap(), PathBuf::from("/tmp/bolloon-ws-test/proj/a.txt"));
        // canonical: a/./b/../c → a/c
        assert_eq!(
            w.resolve("a/./b/../c.txt").unwrap(),
            PathBuf::from("/tmp/bolloon-ws-test/proj/a/c.txt")
        );
    }

    #[test]
    fn traversal_rejected() {
        let w = ws();
        assert_eq!(w.resolve("../x").unwrap_err(), WorkspaceError::Traversal("../x".into()));
        assert_eq!(w.resolve("a/../../x").unwrap_err(), WorkspaceError::Traversal("a/../../x".into()));
    }

    #[test]
    fn absolute_escape_rejected() {
        let w = ws();
        assert_eq!(
            w.resolve("/etc/passwd").unwrap_err(),
            WorkspaceError::Outside("/etc/passwd".into())
        );
        assert!(w.resolve("C:\\x").is_err(), "Windows 盘符也拒");
    }

    #[test]
    fn inside_dotdot_resolved_not_rejected() {
        // a/../b = b, 没越界 → 放行 (canonical 后)
        let w = ws();
        assert_eq!(
            w.resolve("a/../b.txt").unwrap(),
            PathBuf::from("/tmp/bolloon-ws-test/proj/b.txt")
        );
    }

    #[test]
    fn ensure_creates_dir() {
        let dir = std::env::temp_dir().join(format!("bolloon-ws-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let w = Workspace::new("w", &dir);
        w.ensure().unwrap();
        assert!(dir.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deep_normalization_stays_inside() {
        let w = ws();
        // 深层来回穿越但最终在 root 内
        let r = w.resolve("a/b/c/../../../d.txt").unwrap();
        assert_eq!(r, PathBuf::from("/tmp/bolloon-ws-test/proj/d.txt"));
    }
}
