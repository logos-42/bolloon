use crate::schema::ConfigSnapshot;
use std::sync::Arc;

/// 配置变更事件。在配置**成功应用后**发布 (失败不发)。订阅者据此刷新运行行为, 但不应反向写配置。
#[derive(Debug, Clone)]
pub enum ConfigChangeEvent {
    /// 新配置已原子生效。
    Applied(Arc<ConfigSnapshot>),
    /// 已回滚到指定历史版本 (snapshot 为新生成的当前快照, restored_from 指明来源版本)。
    RolledBack { target: u64, snapshot: Arc<ConfigSnapshot> },
    /// 变更被拒绝 (含原因); 当前有效配置保持不变。
    Rejected { reason: String },
}
