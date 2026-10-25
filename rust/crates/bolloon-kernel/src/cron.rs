//! Cron 定时任务 — 注册 + tick 判定 + 锁 (防重叠)
//!
//! 对齐 TS 版 `cron/` 语义 (cron-tick-lock / cron-dnd-quiet):
//! - tick 判定纯函数 (时间注入, 可测)
//! - 锁: 同一任务不重叠执行 (上次还在跑就跳过本轮)
//! - 免打扰: dnd 窗口内不触发

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 定时任务
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CronTask {
    pub id: String,
    pub name: String,
    /// 间隔毫秒
    pub interval_ms: u64,
    pub enabled: bool,
    /// 免打扰窗口 (一天内的起始分钟, UTC)
    pub dnd_window: Option<(u16, u16)>,
}

/// 任务运行状态 (锁)
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskRuntime {
    /// None = 从未跑过 (视为到期)
    last_run_ms: Option<u64>,
    /// 上次运行是否仍在跑 (防重叠)
    running: bool,
}

/// 调度器
#[derive(Debug, Default)]
pub struct CronScheduler {
    tasks: HashMap<String, CronTask>,
    runtime: HashMap<String, TaskRuntime>,
}

impl CronScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, task: CronTask) {
        self.runtime.entry(task.id.clone()).or_insert(TaskRuntime {
            last_run_ms: None,
            running: false,
        });
        self.tasks.insert(task.id.clone(), task);
    }

    pub fn unregister(&mut self, id: &str) -> bool {
        self.runtime.remove(id);
        self.tasks.remove(id).is_some()
    }

    pub fn len(&self) -> usize {
        self.tasks.len()
    }

    /// tick 判定 (纯函数): 到期 + enabled + 不在跑 + 不在 DND
    pub fn due_tasks(&self, now_ms: u64, now_minute_of_day: u16) -> Vec<String> {
        let mut due = Vec::new();
        for (id, task) in &self.tasks {
            if !task.enabled {
                continue;
            }
            if let Some(rt) = self.runtime.get(id) {
                if rt.running {
                    continue; // 锁: 上次还在跑
                }
                if let Some(last) = rt.last_run_ms {
                    if now_ms.saturating_sub(last) < task.interval_ms {
                        continue; // 未到期
                    }
                }
                // last_run_ms None = 从未跑过 → 到期
            }
            if in_dnd(task.dnd_window, now_minute_of_day) {
                continue; // 免打扰
            }
            due.push(id.clone());
        }
        due
    }

    /// 标记开始 (拿锁)
    pub fn begin(&mut self, id: &str, now_ms: u64) -> bool {
        match self.runtime.get_mut(id) {
            Some(rt) if !rt.running => {
                rt.running = true;
                rt.last_run_ms = Some(now_ms);
                true
            }
            _ => false,
        }
    }

    /// 标记结束 (放锁)
    pub fn finish(&mut self, id: &str) -> bool {
        match self.runtime.get_mut(id) {
            Some(rt) if rt.running => {
                rt.running = false;
                true
            }
            _ => false,
        }
    }

    /// 崩溃恢复: 陈旧锁回收 (进程重启后 running 残留清零)
    pub fn recover_stale_locks(&mut self) -> usize {
        let ids: Vec<String> = self.runtime.iter().filter(|(_, rt)| rt.running).map(|(id, _)| id.clone()).collect();
        let n = ids.len();
        for id in ids {
            if let Some(rt) = self.runtime.get_mut(&id) {
                rt.running = false;
            }
        }
        n
    }
}

/// DND 窗口判定 (支持跨零点, 如 22:00-07:00)
pub fn in_dnd(window: Option<(u16, u16)>, minute_of_day: u16) -> bool {
    let Some((start, end)) = window else { return false };
    if start == end {
        return false;
    }
    if start < end {
        minute_of_day >= start && minute_of_day < end
    } else {
        minute_of_day >= start || minute_of_day < end // 跨零点
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, interval: u64) -> CronTask {
        CronTask {
            id: id.into(),
            name: id.into(),
            interval_ms: interval,
            enabled: true,
            dnd_window: None,
        }
    }

    #[test]
    fn due_after_interval_elapsed() {
        let mut s = CronScheduler::new();
        s.register(task("t1", 60_000));
        assert!(s.due_tasks(0, 0).contains(&"t1".into()), "从未跑过 = 到期");
        assert!(s.begin("t1", 0));
        assert!(s.due_tasks(30_000, 0).is_empty(), "在跑 + 未到期");
        s.finish("t1");
        assert!(s.due_tasks(59_999, 0).is_empty());
        assert!(s.due_tasks(60_000, 0).contains(&"t1".into()), "到期");
    }

    #[test]
    fn lock_prevents_overlap() {
        let mut s = CronScheduler::new();
        s.register(task("t1", 0)); // 每次都到期
        assert!(s.begin("t1", 0));
        assert!(!s.begin("t1", 1), "重复拿锁必须失败 (防重叠)");
        assert!(s.due_tasks(1, 0).is_empty(), "running 时不出现在 due");
        assert!(s.finish("t1"));
        assert!(s.due_tasks(1, 0).contains(&"t1".into()));
    }

    #[test]
    fn disabled_task_never_due() {
        let mut s = CronScheduler::new();
        let mut t = task("t2", 0);
        t.enabled = false;
        s.register(t);
        assert!(s.due_tasks(1_000_000, 0).is_empty());
    }

    #[test]
    fn dnd_window_quiets() {
        let mut s = CronScheduler::new();
        let mut t = task("t3", 0);
        t.dnd_window = Some((22 * 60, 7 * 60)); // 22:00 - 07:00
        s.register(t);
        assert!(s.due_tasks(0, 23 * 60).is_empty(), "23:00 在 DND");
        assert!(s.due_tasks(0, 3 * 60).is_empty(), "03:00 在 DND (跨零点)");
        assert!(s.due_tasks(0, 12 * 60).contains(&"t3".into()), "12:00 正常");
    }

    #[test]
    fn stale_lock_recovered_on_restart() {
        let mut s = CronScheduler::new();
        s.register(task("t4", 60_000));
        assert!(s.begin("t4", 0));
        // 模拟崩溃重启: runtime 还带 running 残留
        assert_eq!(s.recover_stale_locks(), 1);
        assert!(s.due_tasks(61_000, 0).contains(&"t4".into()), "回收后可再跑");
    }

    #[test]
    fn unregister_removes() {
        let mut s = CronScheduler::new();
        s.register(task("t5", 0));
        assert!(s.unregister("t5"));
        assert!(!s.unregister("t5"));
        assert_eq!(s.len(), 0);
    }
}
