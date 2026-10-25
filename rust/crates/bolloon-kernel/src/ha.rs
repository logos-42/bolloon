//! Kernel 双活 — 心跳仲裁 (纯机制) + 守护循环 (端口注入)
//!
//! 对应 TS 版 src/kernel/ha/ha-arbiter.ts + ha-guard.ts（leo 2026-10-16 双内核冗余）。
//! 双活语义：两个内核实例互发心跳，仲裁出 active/passive；守护循环在心跳丢失时
//! 执行注入的恢复动作（重启/降级/通知），恢复动作由调用方给，kernel 只做判定。

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// 心跳仲裁状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum HeartbeatState {
    Active,
    Passive,
    Lost,
    Recovering,
}

/// 守护状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum GuardStatus {
    Healthy,
    Watchdog,
    Recovered,
    Escalated,
}

/// 一次心跳观测
#[derive(Debug, Clone)]
pub struct HeartbeatTick {
    pub instance_id: String,
    pub seq: u64,
    pub received_at: Instant,
}

/// 心跳仲裁器：纯判定机制，无 I/O
///
/// 输入：每次收到对端心跳 tick。
/// 判定：窗口期内 ≥ 1 个 tick → Active；超时 → Lost；仲裁给恢复动作。
#[derive(Debug)]
pub struct HeartbeatArbiter {
    instance_id: String,
    /// 心跳超时窗口
    window: Duration,
    last_tick: Arc<Mutex<Option<HeartbeatTick>>>,
    state: Arc<Mutex<HeartbeatState>>,
}

impl HeartbeatArbiter {
    pub fn new(instance_id: impl Into<String>, window: Duration) -> Self {
        Self {
            instance_id: instance_id.into(),
            window,
            last_tick: Arc::new(Mutex::new(None)),
            state: Arc::new(Mutex::new(HeartbeatState::Passive)),
        }
    }

    pub fn instance(&self) -> &str {
        &self.instance_id
    }

    /// 对端心跳到达
    pub async fn observe(&self, tick: HeartbeatTick) {
        let mut slot = self.last_tick.lock().await;
        *slot = Some(tick);
        let mut state = self.state.lock().await;
        if *state == HeartbeatState::Lost || *state == HeartbeatState::Recovering {
            *state = HeartbeatState::Active;
            tracing::info!(instance = %self.instance_id, "心跳恢复 → Active");
        }
    }

    /// 判定当前状态（供守护循环轮询）
    pub async fn evaluate(&self) -> HeartbeatState {
        let slot = self.last_tick.lock().await;
        match slot.as_ref() {
            Some(t) if t.received_at.elapsed() <= self.window => HeartbeatState::Active,
            Some(_) => HeartbeatState::Lost,
            None => HeartbeatState::Passive, // 还没收到过心跳
        }
    }

    pub async fn state(&self) -> HeartbeatState {
        *self.state.lock().await
    }
}

/// 恢复动作端口（守护循环用；由调用方注入）
#[async_trait::async_trait]
pub trait RecoveryAction: Send + Sync {
    /// 心跳丢失时执行；返回是否成功恢复
    async fn recover(&self) -> bool;
    /// 升级动作（多次失败后触发——通知人工/完全降级）
    async fn escalate(&self);
}

/// 无动作（默认）
pub struct NoopRecovery;

#[async_trait::async_trait]
impl RecoveryAction for NoopRecovery {
    async fn recover(&self) -> bool {
        false
    }
    async fn escalate(&self) {}
}

/// 守护循环：周期轮询仲裁状态，Lost → 执行恢复；恢复失败达阈值 → 升级
pub struct HeartbeatGuard {
    arbiter: Arc<HeartbeatArbiter>,
    recovery: Arc<dyn RecoveryAction>,
    poll_interval: Duration,
    /// 连续失败多少次后升级
    escalate_after: u32,
}

impl HeartbeatGuard {
    pub fn new(
        arbiter: Arc<HeartbeatArbiter>,
        recovery: Arc<dyn RecoveryAction>,
        poll_interval: Duration,
        escalate_after: u32,
    ) -> Self {
        Self {
            arbiter,
            recovery,
            poll_interval,
            escalate_after,
        }
    }

    pub fn with_noop(arbiter: Arc<HeartbeatArbiter>) -> Self {
        Self::new(arbiter, Arc::new(NoopRecovery), Duration::from_secs(1), 3)
    }

    /// 启动守护循环（一直跑，直到被 abort）
    pub async fn run(self) {
        let mut consecutive_failures: u32 = 0;
        loop {
            tokio::time::sleep(self.poll_interval).await;
            let state = self.arbiter.evaluate().await;
            match state {
                HeartbeatState::Active => {
                    consecutive_failures = 0;
                }
                HeartbeatState::Lost | HeartbeatState::Passive => {
                    consecutive_failures += 1;
                    tracing::warn!(
                        instance = %self.arbiter.instance(),
                        failures = consecutive_failures,
                        "心跳丢失, 执行恢复"
                    );
                    let ok = self.recovery.recover().await;
                    if !ok && consecutive_failures >= self.escalate_after {
                        tracing::error!(
                            instance = %self.arbiter.instance(),
                            "恢复连续失败, 升级"
                        );
                        self.recovery.escalate().await;
                        consecutive_failures = 0;
                    }
                }
                HeartbeatState::Recovering => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn arbiter_transitions() {
        let arb = Arc::new(HeartbeatArbiter::new(
            "inst-1",
            Duration::from_millis(100),
        ));
        assert_eq!(arb.evaluate().await, HeartbeatState::Passive);

        arb.observe(HeartbeatTick {
            instance_id: "inst-2".into(),
            seq: 1,
            received_at: Instant::now(),
        })
        .await;
        assert_eq!(arb.evaluate().await, HeartbeatState::Active);

        // 窗口过期 → Lost
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(arb.evaluate().await, HeartbeatState::Lost);

        // 新心跳 → 恢复 Active
        arb.observe(HeartbeatTick {
            instance_id: "inst-2".into(),
            seq: 2,
            received_at: Instant::now(),
        })
        .await;
        assert_eq!(arb.evaluate().await, HeartbeatState::Active);
    }

    #[tokio::test]
    async fn guard_executes_recovery_on_loss() {
        use std::sync::atomic::{AtomicU32, Ordering};

        struct CountingRecovery {
            calls: AtomicU32,
        }
        #[async_trait::async_trait]
        impl RecoveryAction for CountingRecovery {
            async fn recover(&self) -> bool {
                self.calls.fetch_add(1, Ordering::SeqCst);
                false // 一直失败 → 触发升级
            }
            async fn escalate(&self) {}
        }

        let recovery = Arc::new(CountingRecovery {
            calls: AtomicU32::new(0),
        });
        let arb = Arc::new(HeartbeatArbiter::new(
            "inst-1",
            Duration::from_millis(50),
        ));
        let guard = HeartbeatGuard::new(
            arb.clone(),
            recovery.clone(),
            Duration::from_millis(20),
            2,
        );

        // 不喂心跳 → 一段时间后应执行过恢复
        let handle = tokio::spawn(guard.run());
        tokio::time::sleep(Duration::from_millis(150)).await;
        handle.abort();

        let calls = recovery.calls.load(Ordering::SeqCst);
        assert!(calls >= 1, "心跳丢失后应执行恢复动作 (实际 {calls} 次)");
    }
}