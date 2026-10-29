//! Bolloon 受治理的动态配置系统。
//!
//! 设计原则 (对齐 AGENTS.md 架构约束):
//! - 配置决策权 / 执行权 / 安全约束分离 (`ConfigAuth` 三级)。
//! - `ConfigSnapshot` 不可变、带单调版本号; 运行期通过 `ConfigView` 原子读取 (无部分可见)。
//! - `ConfigManager` 负责加载/校验/应用/查询/回滚; 验证失败旧配置保持不变; 事件在成功后发布; 审计落盘。
//! - `RuntimePolicy` 只把配置映射为运行行为, **绝不绕过** 既有 Harness 权限检查。
//! - A(安全紧急) / B(任务级) / C(热更新) / D(启动期) / E(编译期不变量) 分流, E 永不动。

pub mod audit;
pub mod coordinator;
pub mod error;
pub mod event;
pub mod evidence;
pub mod manager;
pub mod metrics;
pub mod optimizer;
pub mod policy;
pub mod schema;
pub mod validator;

pub use audit::{AuditRecord, ConfigAuditLog};
pub use coordinator::{CoordError, FileLeaseCoordinator, Lease, LeaseCoordinator};
pub use error::ConfigError;
pub use event::ConfigChangeEvent;
pub use evidence::{ConfigEvidence, TaskBinding};
pub use manager::{ConfigManager, ConfigProposal};
pub use metrics::{ConfigMetrics, MetricsSnapshot};
pub use optimizer::{
    AiMode, AiOptimizer, MetricSample, MetricSource, OptimizationObjective, OptimizationReport,
    OptimizeError, ParamResponse, Proposal, RoundRecord, TrustLevel,
};
pub use schema::{
    AppConfig, ConfigAuth, ConfigSnapshot, ConfigSource, EconomicConfig, EconomicMode, RuntimeConfig,
    SafetyConfig, StartupConfig, TaskPolicyConfig,
};
pub use validator::validate;

/// 运行期配置视图: 原子持有当前不可变快照。读者 `read().clone()` 拿到完整 `Arc`, 不存在部分可见。
/// 约定: 不要在持有读/写 guard 时 `await`, 以免与 `apply` 的写锁形成死锁。
pub type ConfigView = std::sync::Arc<std::sync::RwLock<std::sync::Arc<ConfigSnapshot>>>;

/// 单测/集成可用的默认配置。
pub fn default_config() -> AppConfig {
    AppConfig::default()
}
