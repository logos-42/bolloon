//! Bolloon 旁路经济层 (`bolloon-econ`)。
//!
//! 设计前提 (不可违反):
//! 1. **旁路** —— 经济层挂在既有运行时**边界**(模型调用/工具执行/委托)上, 不改意图识别、
//!    消息、Agent 生命周期、模型选择与路由。关掉它 = 零行为差异。
//! 2. **影子优先** —— 默认 `enabled=false`; 打开后默认 `mode=shadow`: 只记账,
//!    记录"本该被拦/本该换谁", 但**不阻断、不换供应商**。
//! 3. **账本分开** —— 消耗(用量) / 贡献(承诺→执行→验收→确认) / 结算(谁付了多少)互不混淆。
//!    贡献承诺不等于已到账现金; 未到账的钱不能当预算。
//! 4. **价格不写死** —— 金额来自调用当时生效的价格表 + 版本号; 没有价格表就只记 token,
//!    不编金额。
//! 5. **密钥不进账本** —— 账本只记 provider id / model 名, 绝不记 key、prompt 原文。

pub mod budget;
pub mod contribution;
pub mod economy;
pub mod error;
pub mod meter;
pub mod price;
pub mod provider;
pub mod settlement;

pub use budget::{
    BudgetDecision, BudgetGuard, BudgetLimits, ExhaustionPolicy, IntentBudget, Payer, PayerKind,
    PrivacyPolicy,
};
pub use contribution::{
    Contribution, ContributionKind, ContributionLedger, ContributionState, ContributionTotals,
};
pub use economy::{CallCtx, EconomyReport, ShadowEconomy};
pub use error::EconError;
pub use meter::{
    MeterEvent, MeterStatus, MeterTotals, RecordOutcome, ResourceKind, SCHEMA_VERSION, UsageMeter,
};
pub use price::{PriceEntry, PriceTable, PriceVersion};
pub use provider::{
    ModelCapability, ProviderKind, ProviderRegistry, ProviderSpec, ProviderStatus, RoutingDecision,
    RoutingPolicy, RoutingStrategy,
};
pub use settlement::{
    CostShare, PublicPool, SettleError, SettlementLedger, SettlementRecord, SettlementState,
};

/// 经济层一切金额都以美元计价, 内部用 f64 (展示/记账够用);
/// 任何"交换/兑换"都不在本期范围内, 因此不需要定点数。
pub type Usd = f64;
