//! 会话持久化 — 仅追加 JSONL (append-only)
//!
//! 对齐「构建AI智能体」决策 6 与 TS 版 session-store:
//! - 仅追加 JSONL: 可审计 (每行一条事件), 查询弱但恢复强
//! - **恢复会话绝不自动恢复权限** (load 只回消息, 不回授权)
//! - 损坏行跳过并计数, 不让整个会话挂掉 (fail-open 到可用子集)

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 会话事件 (一行一条)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionEvent {
    /// 用户输入
    User { text: String },
    /// 助手回复
    Assistant { text: String },
    /// 会话元数据 (标题等)
    Meta { title: String },
}

/// 存储结果统计
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoadReport {
    pub events: usize,
    pub corrupted_lines: usize,
}

/// JSONL 会话存储
pub struct SessionStore {
    path: PathBuf,
}

impl SessionStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 追加一条事件 (fsync 交给 OS; 单行 JSON)
    pub fn append(&self, event: &SessionEvent) -> std::io::Result<()> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let line = serde_json::to_string(event).expect("session event serialize");
        writeln!(f, "{line}")
    }

    /// 恢复: 读回全部事件。损坏行跳过 (计入 report), 不中断。
    pub fn load(&self) -> std::io::Result<(Vec<SessionEvent>, LoadReport)> {
        let f = match std::fs::File::open(&self.path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok((vec![], LoadReport { events: 0, corrupted_lines: 0 }))
            }
            Err(e) => return Err(e),
        };
        let reader = std::io::BufReader::new(f);
        let mut events = Vec::new();
        let mut corrupted = 0;
        for line in reader.lines() {
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<SessionEvent>(trimmed) {
                Ok(ev) => events.push(ev),
                Err(_) => corrupted += 1,
            }
        }
        let report = LoadReport {
            events: events.len(),
            corrupted_lines: corrupted,
        };
        Ok((events, report))
    }

    /// 纯函数: 从事件流重建对话消息 (user/assistant 交替视图)
    pub fn messages_of(events: &[SessionEvent]) -> Vec<(String, String)> {
        events
            .iter()
            .filter_map(|e| match e {
                SessionEvent::User { text } => Some(("user".into(), text.clone())),
                SessionEvent::Assistant { text } => Some(("assistant".into(), text.clone())),
                SessionEvent::Meta { .. } => None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bolloon-session-test-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("session.jsonl")
    }

    #[test]
    fn append_load_roundtrip() {
        let path = tmp_path("roundtrip");
        let store = SessionStore::new(&path);
        store
            .append(&SessionEvent::User { text: "你好".into() })
            .unwrap();
        store
            .append(&SessionEvent::Assistant { text: "你好，我是 Bolloon".into() })
            .unwrap();
        store
            .append(&SessionEvent::Meta { title: "测试会话".into() })
            .unwrap();

        let (events, report) = store.load().unwrap();
        assert_eq!(report, LoadReport { events: 3, corrupted_lines: 0 });
        assert_eq!(events[0], SessionEvent::User { text: "你好".into() });
        assert_eq!(
            SessionStore::messages_of(&events),
            vec![
                ("user".into(), "你好".into()),
                ("assistant".into(), "你好，我是 Bolloon".into())
            ]
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn append_only_file_has_one_json_per_line() {
        let path = tmp_path("format");
        let store = SessionStore::new(&path);
        store.append(&SessionEvent::User { text: "a\nb".into() }).unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.lines().count(), 1, "换行必须被转义, 一行一事件");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn corrupted_lines_skipped_not_fatal() {
        let path = tmp_path("corrupt");
        let store = SessionStore::new(&path);
        store.append(&SessionEvent::User { text: "ok".into() }).unwrap();
        // 手工追加垃圾行 (模拟磁盘损坏/截断)
        {
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(f, "{{{{not json").unwrap();
            writeln!(f).unwrap();
        }
        store
            .append(&SessionEvent::Assistant { text: "fine".into() })
            .unwrap();
        let (events, report) = store.load().unwrap();
        assert_eq!(events.len(), 2, "好事件全保留");
        assert_eq!(report.corrupted_lines, 1, "坏行跳过并计数");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn load_missing_file_returns_empty() {
        let store = SessionStore::new(tmp_path("missing"));
        let (events, report) = store.load().unwrap();
        assert!(events.is_empty());
        assert_eq!(report.corrupted_lines, 0);
    }

    #[test]
    fn restore_does_not_restore_permissions() {
        // 决策 6: 恢复会话绝不自动恢复权限 —— load 面没有权限出口
        let path = tmp_path("noperm");
        let store = SessionStore::new(&path);
        store.append(&SessionEvent::Meta { title: "x".into() }).unwrap();
        let (events, _) = store.load().unwrap();
        // SessionEvent 枚举里不存在任何权限/授权变体 —— 编译期即冻结
        for ev in events {
            assert!(matches!(
                ev,
                SessionEvent::User { .. } | SessionEvent::Assistant { .. } | SessionEvent::Meta { .. }
            ));
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
