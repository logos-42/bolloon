use thiserror::Error;

/// 经济层错误。经济层的失败**不许**悄悄变成"成功记账"。
#[derive(Debug, Error)]
pub enum EconError {
    #[error("结算非法: {0}")]
    InvalidSettlement(String),

    #[error("守恒被破坏: 分摊合计 {sum:.6} 超过成本 {cost:.6}")]
    ConservationViolated { sum: f64, cost: f64 },

    #[error("公共池现金不足: 可用 {available:.6}, 需要 {needed:.6} (未到账的钱不能当预算)")]
    PoolInsufficient { available: f64, needed: f64 },

    #[error("同一笔成本被重复结算: {0}")]
    AlreadySettled(String),

    #[error("付款方 `{0}` 未获授权, 不能替它扣费")]
    UnauthorizedPayer(String),

    #[error("贡献记录非法: {0}")]
    InvalidContribution(String),

    #[error("提供者非法: {0}")]
    InvalidProvider(String),

    #[error("记账失败: {0}")]
    Record(String),
}
