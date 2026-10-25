//! Task / Plan / 待办清单工具 — agent 的计划底稿
//!
//! 对齐 Claude Code TodoWrite/TodoRead 语义:
//! - 一个任务一张清单, item 状态机: pending → in_progress → completed (可标 cancelled)
//! - **同一时刻只允许一个 in_progress** (专注纪律)
//! - 清单是 agent 的 plan: 每轮 system prompt 可带进度摘要 (todo_progress)
//! - 持久化: JSON (agent 目录下), 与 memory.db 分离

use serde::{Deserialize, Serialize};

/// 待办状态机
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

/// 待办项
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    pub status: TodoStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// 清单错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum TodoError {
    #[error("不存在: {0}")]
    NotFound(String),
    #[error("已有 in_progress 项 ({0}), 先完成或取消它 (同一时刻只许一个)")]
    MultipleInProgress(String),
    #[error("状态迁移非法: {from:?} → {to:?}")]
    IllegalTransition { from: TodoStatus, to: TodoStatus },
    #[error("内容不能为空")]
    EmptyContent,
}

/// 合法迁移表
fn can_transition(from: TodoStatus, to: TodoStatus) -> bool {
    use TodoStatus::*;
    matches!(
        (from, to),
        (Pending, InProgress)
            | (Pending, Cancelled)
            | (InProgress, Completed)
            | (InProgress, Pending)      // 打回重做
            | (InProgress, Cancelled)
            | (Completed, InProgress)    // 复工
            | (Cancelled, Pending)       // 恢复
    )
}

/// 任务清单 (一个 run/goal 一张)
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TodoList {
    pub items: Vec<TodoItem>,
    next_id: u64,
}

impl TodoList {
    pub fn new() -> Self {
        Self::default()
    }

    /// 添加待办 (计划)
    pub fn add(&mut self, content: &str, now_ms: u64) -> Result<String, TodoError> {
        if content.trim().is_empty() {
            return Err(TodoError::EmptyContent);
        }
        self.next_id += 1;
        let id = format!("todo-{0:03}", self.next_id);
        self.items.push(TodoItem {
            id: id.clone(),
            content: content.into(),
            status: TodoStatus::Pending,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        });
        Ok(id)
    }

    /// 状态迁移 (唯一 in_progress 约束)
    pub fn set_status(&mut self, id: &str, to: TodoStatus, now_ms: u64) -> Result<(), TodoError> {
        let (from, exists) = match self.items.iter().find(|i| i.id == id) {
            Some(i) => (i.status, true),
            None => return Err(TodoError::NotFound(id.into())),
        };
        let _ = exists;
        if from == to {
            return Ok(()); // 幂等
        }
        if !can_transition(from, to) {
            return Err(TodoError::IllegalTransition { from, to });
        }
        // 唯一 in_progress 约束
        if to == TodoStatus::InProgress {
            if let Some(busy) = self
                .items
                .iter()
                .find(|i| i.status == TodoStatus::InProgress && i.id != id)
            {
                return Err(TodoError::MultipleInProgress(busy.id.clone()));
            }
        }
        let item = self.items.iter_mut().find(|i| i.id == id).unwrap();
        item.status = to;
        item.updated_at_ms = now_ms;
        Ok(())
    }

    /// 进度摘要 (每轮 system prompt 注入用; 全空 = None 不注入)
    pub fn progress(&self) -> Option<String> {
        if self.items.is_empty() {
            return None;
        }
        let total = self.items.len();
        let done = self
            .items
            .iter()
            .filter(|i| i.status == TodoStatus::Completed)
            .count();
        let current = self
            .items
            .iter()
            .find(|i| i.status == TodoStatus::InProgress);
        let mut out = format!("[计划 {done}/{total}]");
        for i in &self.items {
            let mark = match i.status {
                TodoStatus::Completed => "✅",
                TodoStatus::InProgress => "▶",
                TodoStatus::Pending => "○",
                TodoStatus::Cancelled => "✗",
            };
            out.push_str(&format!("\n{mark} {}", i.content));
        }
        if let Some(c) = current {
            out.push_str(&format!("\n(当前: {})", c.content));
        }
        Some(out)
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_and_progress() {
        let mut t = TodoList::new();
        t.add("调研口径", 1).unwrap();
        t.add("写报告", 2).unwrap();
        assert_eq!(t.len(), 2);
        assert!(t.progress().unwrap().contains("[计划 0/2]"));
        assert!(t.progress().unwrap().contains("○ 调研口径"));
    }

    #[test]
    fn single_in_progress_constraint() {
        let mut t = TodoList::new();
        let a = t.add("A", 1).unwrap();
        let b = t.add("B", 2).unwrap();
        t.set_status(&a, TodoStatus::InProgress, 3).unwrap();
        assert_eq!(
            t.set_status(&b, TodoStatus::InProgress, 4).unwrap_err(),
            TodoError::MultipleInProgress(a.clone()),
            "同一时刻只许一个 in_progress"
        );
        t.set_status(&a, TodoStatus::Completed, 5).unwrap();
        assert!(
            t.set_status(&b, TodoStatus::InProgress, 6).is_ok(),
            "完成后可开下一个"
        );
    }

    #[test]
    fn illegal_transitions_rejected() {
        let mut t = TodoList::new();
        let a = t.add("A", 1).unwrap();
        // pending → completed 跳步拒
        assert!(matches!(
            t.set_status(&a, TodoStatus::Completed, 2),
            Err(TodoError::IllegalTransition { .. })
        ));
        // cancelled → in_progress 拒 (要先恢复 pending)
        t.set_status(&a, TodoStatus::Cancelled, 3).unwrap();
        assert!(matches!(
            t.set_status(&a, TodoStatus::InProgress, 4),
            Err(TodoError::IllegalTransition { .. })
        ));
        // cancelled → pending 恢复 → in_progress ✓
        t.set_status(&a, TodoStatus::Pending, 5).unwrap();
        assert!(t.set_status(&a, TodoStatus::InProgress, 6).is_ok());
    }

    #[test]
    fn idempotent_status_set() {
        let mut t = TodoList::new();
        let a = t.add("A", 1).unwrap();
        t.set_status(&a, TodoStatus::InProgress, 2).unwrap();
        assert!(t.set_status(&a, TodoStatus::InProgress, 3).is_ok(), "同状态幂等");
    }

    #[test]
    fn empty_content_rejected() {
        let mut t = TodoList::new();
        assert_eq!(t.add("  ", 1).unwrap_err(), TodoError::EmptyContent);
    }

    #[test]
    fn progress_marks_current() {
        let mut t = TodoList::new();
        let a = t.add("当前任务", 1).unwrap();
        t.set_status(&a, TodoStatus::InProgress, 2).unwrap();
        let p = t.progress().unwrap();
        assert!(p.contains("▶ 当前任务"));
        assert!(p.contains("(当前: 当前任务)"));
    }

    #[test]
    fn empty_list_no_progress_injection() {
        assert!(TodoList::new().progress().is_none(), "空清单不注入 (防上下文腐烂)");
    }

    #[test]
    fn reopen_completed_allowed() {
        let mut t = TodoList::new();
        let a = t.add("A", 1).unwrap();
        t.set_status(&a, TodoStatus::InProgress, 2).unwrap();
        t.set_status(&a, TodoStatus::Completed, 3).unwrap();
        assert!(t.set_status(&a, TodoStatus::InProgress, 4).is_ok(), "复工允许");
    }
}
