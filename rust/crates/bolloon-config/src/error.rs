use thiserror::Error;

/// 配置系统错误。所有错误都不静默吞掉 —— 调用方必须显式处理。
#[derive(Debug, Error)]
pub enum ConfigError {
    /// 结构 / 范围 / 非法组合校验失败。
    #[error("配置校验失败: {0}")]
    Validation(String),

    /// 业务不变量 / 安全策略拒绝。
    #[error("安全策略拒绝: {0}")]
    PolicyDenied(String),

    /// 提交基于过期版本 (当前已被更新的版本取代)。
    #[error("版本过期: 提交基于 v{based_on}, 当前为 v{current}")]
    StaleVersion { based_on: u64, current: u64 },

    /// 配置内容与上一份完全相同 (重复提交, 视为无操作成功, 不升版本)。
    #[error("配置无变更 (重复提交)")]
    NoChange,

    /// 回滚目标版本不在保留历史中。
    #[error("回滚目标版本 v{0} 不在保留历史中")]
    RollbackTargetNotFound(u64),

    /// 本地文件加载失败。
    #[error("配置加载失败: {0}")]
    Load(String),

    /// 序列化失败。
    #[error("配置序列化失败: {0}")]
    Serialize(String),

    /// 远程配置不可用 / 超时 / 返回恶意内容 —— 系统必须按 fail-closed 运行。
    #[error("远程配置不可用: {0}")]
    RemoteUnavailable(String),

    /// 权限不足: 该配置变更需要更高授权级别。
    #[error("权限不足: 需要 {required:?} 级授权, 当前为 {current:?}")]
    Unauthorized {
        required: crate::schema::ConfigAuth,
        current: crate::schema::ConfigAuth,
    },
}
