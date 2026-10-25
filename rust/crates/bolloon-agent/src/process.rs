//! Process 执行 — 长驻进程管理 (spawn/流式输出/终止/回收)
//!
//! 对齐 TS 版 process 执行语义:
//! - 进程登记: pid + 命令 + workspace + 启动时刻 + 状态
//! - stdout/stderr 缓冲 (有界, 防内存膨胀)
//! - 终止: 优雅 (SIGTERM 语义) → 超时强杀
//! - 回收: 崩溃/退出的进程从活跃表清到退出表 (留证据)
//! - 真 spawn 由 ProcessExecutor 注入 (测试用 fake)

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 进程状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessStatus {
    Starting,
    Running,
    Exited,
    Killed,
    Failed,
}

/// 进程登记
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessRecord {
    pub id: String,
    pub command: String,
    pub workspace: String,
    pub pid: Option<u32>,
    pub status: ProcessStatus,
    pub started_at_ms: u64,
    pub exited_at_ms: Option<u64>,
    pub exit_code: Option<i32>,
    /// stdout 缓冲 (有界)
    pub stdout_tail: String,
    /// stderr 缓冲 (有界)
    pub stderr_tail: String,
}

/// 缓冲上限 (字符)
pub const STREAM_TAIL_MAX: usize = 4000;

/// 追加有界缓冲 (保留尾部)
pub fn append_tail(buf: &mut String, chunk: &str, max: usize) {
    buf.push_str(chunk);
    if buf.chars().count() > max {
        let keep = max;
        let chars: Vec<char> = buf.chars().collect();
        *buf = chars[chars.len() - keep..].iter().collect();
    }
}

/// 进程错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ProcessError {
    #[error("进程不存在: {0}")]
    NotFound(String),
    #[error("进程已在运行: {0}")]
    AlreadyRunning(String),
    #[error("进程非运行态: {0}")]
    NotRunning(String),
}

/// 进程管理器
#[derive(Debug, Default)]
pub struct ProcessManager {
    procs: HashMap<String, ProcessRecord>,
    next_id: u64,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记 + spawn (workspace 约束由调用方在 command 里保证)
    pub fn spawn(
        &mut self,
        command: &str,
        workspace: &str,
        pid: Option<u32>,
        now_ms: u64,
    ) -> ProcessRecord {
        self.next_id += 1;
        let id = format!("proc-{0:05}", self.next_id);
        let rec = ProcessRecord {
            id,
            command: command.into(),
            workspace: workspace.into(),
            pid,
            status: ProcessStatus::Running,
            started_at_ms: now_ms,
            exited_at_ms: None,
            exit_code: None,
            stdout_tail: String::new(),
            stderr_tail: String::new(),
        };
        self.procs.insert(rec.id.clone(), rec.clone());
        rec
    }

    /// 追加 stdout/stderr (有界缓冲)
    pub fn stream(&mut self, id: &str, is_stderr: bool, chunk: &str) -> Result<(), ProcessError> {
        let rec = self.procs.get_mut(id).ok_or(ProcessError::NotFound(id.into()))?;
        if is_stderr {
            append_tail(&mut rec.stderr_tail, chunk, STREAM_TAIL_MAX);
        } else {
            append_tail(&mut rec.stdout_tail, chunk, STREAM_TAIL_MAX);
        }
        Ok(())
    }

    /// 优雅终止请求 (标 Killed; 真信号由 executor 发)
    pub fn terminate(&mut self, id: &str, now_ms: u64, exit_code: i32) -> Result<(), ProcessError> {
        let rec = self.procs.get_mut(id).ok_or(ProcessError::NotFound(id.into()))?;
        if rec.status != ProcessStatus::Running {
            return Err(ProcessError::NotRunning(id.into()));
        }
        rec.status = ProcessStatus::Killed;
        rec.exited_at_ms = Some(now_ms);
        rec.exit_code = Some(exit_code);
        Ok(())
    }

    /// 自然退出 (标 Exited)
    pub fn exited(&mut self, id: &str, now_ms: u64, exit_code: i32) -> Result<(), ProcessError> {
        let rec = self.procs.get_mut(id).ok_or(ProcessError::NotFound(id.into()))?;
        if rec.status != ProcessStatus::Running {
            return Err(ProcessError::NotRunning(id.into()));
        }
        rec.status = ProcessStatus::Exited;
        rec.exited_at_ms = Some(now_ms);
        rec.exit_code = Some(exit_code);
        Ok(())
    }

    /// spawn 失败 (标 Failed)
    pub fn fail(&mut self, id: &str, now_ms: u64) -> Result<(), ProcessError> {
        let rec = self.procs.get_mut(id).ok_or(ProcessError::NotFound(id.into()))?;
        if rec.status != ProcessStatus::Running {
            return Err(ProcessError::NotRunning(id.into()));
        }
        rec.status = ProcessStatus::Failed;
        rec.exited_at_ms = Some(now_ms);
        Ok(())
    }

    /// 活跃进程
    pub fn running(&self) -> Vec<&ProcessRecord> {
        self.procs
            .values()
            .filter(|p| p.status == ProcessStatus::Running)
            .collect()
    }

    /// 超时回收: 运行超过 max_ms 的强杀 (返回被杀 id)
    pub fn reap_timeout(&mut self, now_ms: u64, max_ms: u64) -> Vec<String> {
        let ids: Vec<String> = self
            .procs
            .values()
            .filter(|p| {
                p.status == ProcessStatus::Running && now_ms.saturating_sub(p.started_at_ms) > max_ms
            })
            .map(|p| p.id.clone())
            .collect();
        for id in &ids {
            let _ = self.terminate(id, now_ms, 137); // 128+9 = SIGKILL 语义
        }
        ids
    }

    pub fn get(&self, id: &str) -> Option<&ProcessRecord> {
        self.procs.get(id)
    }

    pub fn total(&self) -> usize {
        self.procs.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_stream_terminate_lifecycle() {
        let mut pm = ProcessManager::new();
        let rec = pm.spawn("cargo watch -x test", "/ws/proj", Some(4242), 1000);
        let id = rec.id.clone();
        assert_eq!(rec.status, ProcessStatus::Running);

        pm.stream(&id, false, "running 30 tests...\n").unwrap();
        pm.stream(&id, true, "warning: unused\n").unwrap();
        pm.stream(&id, false, "test result: ok\n").unwrap();
        let rec = pm.get(&id).unwrap();
        assert!(rec.stdout_tail.contains("30 tests"));
        assert!(rec.stderr_tail.contains("unused"));

        pm.exited(&id, 5000, 0).unwrap();
        assert_eq!(pm.get(&id).unwrap().status, ProcessStatus::Exited);
        assert_eq!(pm.get(&id).unwrap().exit_code, Some(0));
        assert!(pm.running().is_empty());
    }

    #[test]
    fn stream_tail_bounded() {
        let mut buf = String::new();
        for i in 0..1000 {
            append_tail(&mut buf, &format!("line {i}\n"), 100);
        }
        assert!(buf.chars().count() <= 100, "有界缓冲不膨胀: {}", buf.chars().count());
        assert!(buf.contains("line 999"), "保留尾部 (最新输出)");
        assert!(!buf.contains("line 0\n"), "最老的被裁掉");
    }

    #[test]
    fn double_exit_rejected() {
        let mut pm = ProcessManager::new();
        let rec = pm.spawn("x", "/ws", None, 1);
        let id = rec.id.clone();
        pm.exited(&id, 2, 0).unwrap();
        assert!(matches!(pm.exited(&id, 3, 0), Err(ProcessError::NotRunning(_))));
    }

    #[test]
    fn timeout_reaped_with_sigkill_semantics() {
        let mut pm = ProcessManager::new();
        let a = pm.spawn("long job", "/ws", None, 0).id.clone();
        pm.spawn("short job", "/ws", None, 9000).id.clone();
        let killed = pm.reap_timeout(10_000, 5_000);
        assert_eq!(killed, vec![a.clone()], "只回收超时的");
        assert_eq!(pm.get(&a).unwrap().status, ProcessStatus::Killed);
        assert_eq!(pm.get(&a).unwrap().exit_code, Some(137), "128+9 = SIGKILL");
        // 短的那个还在跑
        assert_eq!(pm.running().len(), 1);
    }

    #[test]
    fn spawn_failure_recorded() {
        let mut pm = ProcessManager::new();
        let id = pm.spawn("bad binary", "/ws", None, 1).id.clone();
        pm.fail(&id, 2).unwrap();
        assert_eq!(pm.get(&id).unwrap().status, ProcessStatus::Failed);
    }

    #[test]
    fn ids_sequential_unique() {
        let mut pm = ProcessManager::new();
        let a = pm.spawn("a", "/ws", None, 1).id.clone();
        let b = pm.spawn("b", "/ws", None, 2).id.clone();
        assert_ne!(a, b);
        assert_eq!(pm.total(), 2);
    }
}
