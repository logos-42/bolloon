//! 任务 ↔ 配置版本证据链。
//!
//! 需求: "把配置版本 ↔ 任务 ID 关联写入 Run/Goal 证据链"。`bolloon-kernel` 的
//! `RunRecord` 属于 Kernel 的 Run 证据链 (由调用方注入 store), 本模块负责**配置侧**的
//! 另一半: 追加式 JSONL (`config-evidence.jsonl`), 记录"哪个任务用哪一版配置跑的、
//! 用的什么模型、什么时候开始/结束、怎么停的"。
//!
//! 只追加、不改历史 (追查"这次为什么这样跑"时, 证据必须比结论稳定)。

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MEM_LIMIT: usize = 512;

/// 一条任务绑定: 任务开始时写入 (`ended_at` 为空), 结束时补一条完成记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskBinding {
    /// 任务 ID (CLI/Web/定时任务各自生成的稳定 id)
    pub task_id: String,
    /// 运行面: cli / web / cron / subagent
    pub surface: String,
    /// 这个任务实际使用的配置版本 (不是"当前版本", 是捕获那一刻的版本)
    pub config_version: u64,
    /// 实际使用的模型 (None = 沿用会话/底座解析)
    pub model: Option<String>,
    /// 事件: start / end / rollback
    pub event: String,
    pub at: String,
    /// 结束时才有: 停止原因 (finished / max_turns / failed / interrupted)
    pub stop: Option<String>,
    /// 结束时才有: 工具调用次数
    pub tool_calls: Option<u32>,
    /// 结束时才有: 这个任务看过的配置版本集合 (中途有更新时能看出变化)
    pub versions_observed: Vec<u64>,
}

impl TaskBinding {
    pub fn start(
        task_id: impl Into<String>,
        surface: &str,
        config_version: u64,
        model: Option<String>,
    ) -> Self {
        Self {
            task_id: task_id.into(),
            surface: surface.to_string(),
            config_version,
            model,
            event: "start".into(),
            at: chrono::Utc::now().to_rfc3339(),
            stop: None,
            tool_calls: None,
            versions_observed: vec![config_version],
        }
    }

    pub fn end(mut self, stop: &str, tool_calls: u32) -> Self {
        self.event = "end".into();
        self.at = chrono::Utc::now().to_rfc3339();
        self.stop = Some(stop.to_string());
        self.tool_calls = Some(tool_calls);
        self
    }
}

/// 配置侧证据链: 内存保留近期 + 追加式落盘。
pub struct ConfigEvidence {
    path: Option<PathBuf>,
    buf: Mutex<VecDeque<TaskBinding>>,
}

impl ConfigEvidence {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            buf: Mutex::new(VecDeque::new()),
        }
    }

    /// 默认落点: 与配置文件同目录的 `config-evidence.jsonl`
    pub fn beside(config_file: Option<&Path>) -> Self {
        Self::new(
            config_file
                .and_then(|f| f.parent())
                .map(|d| d.join("config-evidence.jsonl")),
        )
    }

    /// 追加一条绑定。落盘失败只告警 (证据链写不进去不该让任务失败), 但内存里仍保留。
    pub fn record(&self, b: TaskBinding) {
        if let Some(p) = &self.path {
            if let Some(dir) = p.parent() {
                let _ = create_dir_all(dir);
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
                if let Ok(line) = serde_json::to_string(&b) {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
        let mut buf = self.buf.lock().unwrap();
        buf.push_back(b);
        while buf.len() > MEM_LIMIT {
            buf.pop_front();
        }
    }

    pub fn all(&self) -> Vec<TaskBinding> {
        self.buf.lock().unwrap().iter().cloned().collect()
    }

    /// 某版本被哪些任务用过 (反向追查: 这一版配置影响了谁)
    pub fn tasks_for_version(&self, version: u64) -> Vec<TaskBinding> {
        self.buf
            .lock()
            .unwrap()
            .iter()
            .filter(|b| b.versions_observed.contains(&version))
            .cloned()
            .collect()
    }

    /// 某任务用过哪些版本 (正向追查: 这个任务跑的时候配置换过吗)
    pub fn versions_for_task(&self, task_id: &str) -> Vec<u64> {
        let mut out: Vec<u64> = vec![];
        for b in self.buf.lock().unwrap().iter().filter(|b| b.task_id == task_id) {
            for v in &b.versions_observed {
                if !out.contains(v) {
                    out.push(*v);
                }
            }
        }
        out
    }

    pub fn len(&self) -> usize {
        self.buf.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}
