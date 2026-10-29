//! 配置读取/更新路径的轻量可观测指标。
//!
//! 目标: 能回答"配置读取路径额外开销多少 / 更新耗时多少 / 失败率与回滚成功率多少",
//! 同时**不给**热路径加锁: 全部是 relaxed 原子计数, 单次读取只多两次 `AtomicU64`
//! 与一次 `Instant::now()` (实测见 `metrics_bench` 测试)。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};

/// 累加计数器 (只增)。`*_ns_total` 用纳秒累加, 避免浮点累加误差。
#[derive(Debug, Default)]
pub struct ConfigMetrics {
    reads: AtomicU64,
    read_ns_total: AtomicU64,
    applies: AtomicU64,
    apply_rejects: AtomicU64,
    apply_ns_total: AtomicU64,
    rollbacks: AtomicU64,
    rollback_failures: AtomicU64,
    pubs: AtomicU64,
}

/// 对外快照 (JSON 友好, 供监控面板 / 运维脚本读取)。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricsSnapshot {
    /// 快照读取次数 (热路径: 每次 Harness gate / 循环启动都会读一次)
    pub reads: u64,
    /// 单次读取平均开销 (纳秒; 含 `Instant::now()` 计时本身, 属于上界)
    pub avg_read_ns: f64,
    /// 成功应用的更新次数
    pub applies: u64,
    /// 被拒绝的更新次数 (校验/授权/版本冲突)
    pub apply_rejects: u64,
    /// 更新失败率 = rejects / (applies + rejects)
    pub apply_failure_rate: f64,
    /// 单次应用平均耗时 (毫秒, 含落盘与审计)
    pub avg_apply_ms: f64,
    /// 回滚尝试次数
    pub rollbacks: u64,
    /// 回滚失败率
    pub rollback_failure_rate: f64,
    /// 变更事件发布次数
    pub events_published: u64,
    /// 采样时看到的当前版本 (版本 ↔ 任务 ID 关联的另一半见 `evidence`)
    pub last_version: u64,
}

impl ConfigMetrics {
    pub fn record_read(&self, ns: u64) {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.read_ns_total.fetch_add(ns, Ordering::Relaxed);
    }

    pub fn record_apply(&self, ok: bool, ns: u64) {
        if ok {
            self.applies.fetch_add(1, Ordering::Relaxed);
            self.apply_ns_total.fetch_add(ns, Ordering::Relaxed);
        } else {
            self.apply_rejects.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record_rollback(&self, ok: bool) {
        self.rollbacks.fetch_add(1, Ordering::Relaxed);
        if !ok {
            self.rollback_failures.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub fn record_event(&self) {
        self.pubs.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self, last_version: u64) -> MetricsSnapshot {
        let reads = self.reads.load(Ordering::Relaxed);
        let read_ns = self.read_ns_total.load(Ordering::Relaxed);
        let applies = self.applies.load(Ordering::Relaxed);
        let rejects = self.apply_rejects.load(Ordering::Relaxed);
        let apply_ns = self.apply_ns_total.load(Ordering::Relaxed);
        let rollbacks = self.rollbacks.load(Ordering::Relaxed);
        let rollback_failures = self.rollback_failures.load(Ordering::Relaxed);
        let outcomes = applies + rejects;
        MetricsSnapshot {
            reads,
            avg_read_ns: if reads == 0 {
                0.0
            } else {
                read_ns as f64 / reads as f64
            },
            applies,
            apply_rejects: rejects,
            apply_failure_rate: if outcomes == 0 {
                0.0
            } else {
                rejects as f64 / outcomes as f64
            },
            avg_apply_ms: if applies == 0 {
                0.0
            } else {
                apply_ns as f64 / applies as f64 / 1_000_000.0
            },
            rollbacks,
            rollback_failure_rate: if rollbacks == 0 {
                0.0
            } else {
                rollback_failures as f64 / rollbacks as f64
            },
            events_published: self.pubs.load(Ordering::Relaxed),
            last_version,
        }
    }
}
