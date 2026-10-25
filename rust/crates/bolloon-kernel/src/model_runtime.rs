//! K6 ModelRuntime — acquire(snapshot) 只读租约
//!
//! 连接复用 / 超时 / 取消 / 退避 / 熔断 / 能力检查 / provider 回退 / usage 记录。
//! Kernel 只给出租约机制；真正的 HTTP 调用在 llm crate 的 adapter 层。
//!
//! 核心：acquire 拿到的 lease 是**只读快照**，调用方不能借此改 provider 配置。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Provider 标识（"minimax" / "deepseek" / 自定义）
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ProviderId(pub String);

impl ProviderId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

impl std::fmt::Display for ProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 模型快照（acquire 时冻结，不可写回）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ModelSnapshot {
    pub provider: ProviderId,
    pub model: String,
    pub base_url: Option<String>,
    pub api_key_present: bool, // 只存"有没有"，不存 key 本体 —— 密钥零居留
    pub timeout: Duration,
    pub max_concurrency: usize,
}

impl ModelSnapshot {
    pub fn new(provider: ProviderId, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            base_url: None,
            api_key_present: false,
            timeout: Duration::from_secs(120),
            max_concurrency: 2,
        }
    }
}

/// 租约错误
#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("provider {0} 未注册")]
    UnknownProvider(String),
    #[error("provider {0} 熔断中 (until {1:?})")]
    CircuitOpen(String, Instant),
    #[error("并发闸超时 ({0}s 内未等到槽位)")]
    ConcurrencyTimeout(u64),
}

/// 单 provider 的运行时状态（熔断 / 并发计数 / usage 累计）
#[derive(Debug)]
struct ProviderRuntime {
    snapshot: ModelSnapshot,
    circuit_open_until: Option<Instant>,
    consecutive_failures: u32,
    in_flight: usize,
    total_calls: u64,
    total_failures: u64,
}

/// ModelRuntime：多 provider 的租约管理器
pub struct ModelRuntime {
    providers: Arc<Mutex<HashMap<ProviderId, ProviderRuntime>>>,
    /// 全局并发闸（所有 provider 共享在途上限，对应 TS 的 withLlmConcurrency）
    semaphore: Arc<tokio::sync::Semaphore>,
}

impl std::fmt::Debug for ModelRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelRuntime")
            .field("providers", &self.providers)
            .field("semaphore", &"<Semaphore>")
            .finish()
    }
}

impl Default for ModelRuntime {
    fn default() -> Self {
        Self::new(2)
    }
}

impl ModelRuntime {
    pub fn new(global_max_concurrency: usize) -> Self {
        Self {
            providers: Arc::new(Mutex::new(HashMap::new())),
            semaphore: Arc::new(tokio::sync::Semaphore::new(
                global_max_concurrency.max(1),
            )),
        }
    }

    /// 注册 provider（幂等：重复注册保留旧 runtime 以保护 usage 记录）
    pub async fn register(&self, snapshot: ModelSnapshot) {
        let mut map = self.providers.lock().await;
        map.entry(snapshot.provider.clone())
            .or_insert_with(|| ProviderRuntime {
                snapshot,
                circuit_open_until: None,
                consecutive_failures: 0,
                in_flight: 0,
                total_calls: 0,
                total_failures: 0,
            });
    }

    /// 只读租约：acquire 冻结快照 + 占一个并发槽
    pub async fn acquire(&self, provider: &ProviderId) -> Result<ModelLease, RuntimeError> {
        let sem = self.semaphore.clone();
        let wait = tokio::time::timeout(Duration::from_secs(30), sem.acquire_owned())
            .await
            .map_err(|_| RuntimeError::ConcurrencyTimeout(30))?;
        let permit = wait.map_err(|_| RuntimeError::ConcurrencyTimeout(30))?;

        let mut map = self.providers.lock().await;
        let rt = map
            .get_mut(provider)
            .ok_or_else(|| RuntimeError::UnknownProvider(provider.to_string()))?;

        // 熔断检查
        if let Some(until) = rt.circuit_open_until {
            if Instant::now() < until {
                drop(map);
                drop(permit);
                return Err(RuntimeError::CircuitOpen(provider.to_string(), until));
            }
        }

        rt.in_flight += 1;
        rt.total_calls += 1;
        let snapshot = rt.snapshot.clone();

        Ok(ModelLease {
            snapshot,
            provider: provider.clone(),
            _permit: permit,
            released: false,
        })
    }

    /// 记录一次成功调用（关闭熔断窗口 / 清零连续失败）
    pub async fn record_success(&self, provider: &ProviderId) {
        let mut map = self.providers.lock().await;
        if let Some(rt) = map.get_mut(provider) {
            rt.consecutive_failures = 0;
            rt.circuit_open_until = None;
            rt.in_flight = rt.in_flight.saturating_sub(1);
        }
    }

    /// 记录一次失败（连续失败 ≥ 阈值 → 打开熔断）
    pub async fn record_failure(&self, provider: &ProviderId) {
        const THRESHOLD: u32 = 5;
        const COOLDOWN_SECS: u64 = 30;

        let mut map = self.providers.lock().await;
        if let Some(rt) = map.get_mut(provider) {
            rt.consecutive_failures += 1;
            rt.total_failures += 1;
            rt.in_flight = rt.in_flight.saturating_sub(1);
            if rt.consecutive_failures >= THRESHOLD {
                rt.circuit_open_until = Some(Instant::now() + Duration::from_secs(COOLDOWN_SECS));
                tracing::warn!(
                    provider = %provider,
                    failures = rt.consecutive_failures,
                    "circuit opened for {COOLDOWN_SECS}s"
                );
            }
        }
    }

    /// usage 统计（汇报用）
    pub async fn stats(&self) -> Vec<ProviderStat> {
        let map = self.providers.lock().await;
        map.values()
            .map(|rt| ProviderStat {
                provider: rt.snapshot.provider.clone(),
                total_calls: rt.total_calls,
                total_failures: rt.total_failures,
                in_flight: rt.in_flight,
                circuit_open: rt
                    .circuit_open_until
                    .map(|t| Instant::now() < t)
                    .unwrap_or(false),
            })
            .collect()
    }
}

/// 租约（生命周期内持有并发槽位；drop 时自动释放）
#[derive(Debug)]
pub struct ModelLease {
    pub snapshot: ModelSnapshot,
    pub provider: ProviderId,
    _permit: tokio::sync::OwnedSemaphorePermit,
    released: bool,
}

impl ModelLease {
    /// 标记调用完成（成功→record_success 已在调用方做；这里只释放槽位）
    pub fn release(mut self) {
        self.released = true;
        drop(self); // permit 自动归还
    }
}

impl Drop for ModelLease {
    fn drop(&mut self) {
        // permit 是 owned，drop 即归还信号量槽位。
        // released 标志仅为文档语义保留（permit 的 Drop 是真实的释放点）。
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderStat {
    pub provider: ProviderId,
    pub total_calls: u64,
    pub total_failures: u64,
    pub in_flight: usize,
    pub circuit_open: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn acquire_returns_frozen_snapshot() {
        let rt = ModelRuntime::new(4);
        rt.register(ModelSnapshot::new(ProviderId::new("deepseek"), "deepseek-chat"))
            .await;

        let lease = rt.acquire(&ProviderId::new("deepseek")).await.unwrap();
        assert_eq!(lease.snapshot.model, "deepseek-chat");
        assert!(!lease.snapshot.api_key_present);
        lease.release();
    }

    #[tokio::test]
    async fn unknown_provider_rejected() {
        let rt = ModelRuntime::new(1);
        let err = rt.acquire(&ProviderId::new("nope")).await.unwrap_err();
        assert!(matches!(err, RuntimeError::UnknownProvider(_)));
    }

    #[tokio::test]
    async fn circuit_breaker_after_failures() {
        let rt = ModelRuntime::new(4);
        rt.register(ModelSnapshot::new(ProviderId::new("flaky"), "m"))
            .await;
        let pid = ProviderId::new("flaky");

        // 5 次失败 → 熔断
        for _ in 0..5 {
            rt.record_failure(&pid).await;
        }
        let err = rt.acquire(&pid).await.unwrap_err();
        assert!(matches!(err, RuntimeError::CircuitOpen(_, _)), "应熔断");

        // 熔断期间 acquire 全拒
        for _ in 0..3 {
            assert!(rt.acquire(&pid).await.is_err());
        }

        // 直接失败计数复位不可行（熔断窗口内），但 success 可在窗口外复位——这里只验证记录函数不 panic
        rt.record_success(&pid).await;
    }

    #[tokio::test]
    async fn concurrency_capped() {
        let rt = ModelRuntime::new(2);
        rt.register(ModelSnapshot::new(ProviderId::new("busy"), "m"))
            .await;
        let pid = ProviderId::new("busy");

        let l1 = rt.acquire(&pid).await.unwrap();
        let l2 = rt.acquire(&pid).await.unwrap();
        // 第 3 个 acquire 会等——用 timeout 验证它没有立刻拿到
        let wait = tokio::time::timeout(
            Duration::from_millis(100),
            rt.acquire(&pid),
        )
        .await;
        assert!(wait.is_err(), "并发上限 2，第三个应等待");
        drop(l1);
        drop(l2);
        // 释放后能拿到
        let l3 = tokio::time::timeout(Duration::from_secs(1), rt.acquire(&pid))
            .await
            .unwrap()
            .unwrap();
        l3.release();
    }

    #[tokio::test]
    async fn stats_reported() {
        let rt = ModelRuntime::new(2);
        rt.register(ModelSnapshot::new(ProviderId::new("s1"), "m"))
            .await;
        let pid = ProviderId::new("s1");
        for _ in 0..3 {
            rt.record_failure(&pid).await;
        }
        let stats = rt.stats().await;
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].total_calls, 0);
        assert_eq!(stats[0].total_failures, 3);
    }
}