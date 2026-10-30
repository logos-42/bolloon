//! 初始化协议 — SetupStore 分层 readiness + 启动硬门禁
//!
//! 对齐 TS 版 `setup/setup-store.ts`:
//! - 就绪分层: identity (身份) / llm (模型) / connectivity (连通性)
//! - 硬门禁: 未就绪的层挡住依赖它的功能, **失败不许吞** (折成可操作提示)
//! - 连通性有效期: "测过 + 配置没变" 才算过 (不靠 24h 墙钟, 看 configHash)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 初始化层
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupLayer {
    /// 身份 (DID 密钥)
    Identity,
    /// 模型 (provider + key)
    Llm,
    /// 连通性 (真的打通过一次)
    Connectivity,
}

impl SetupLayer {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Identity => "identity",
            Self::Llm => "llm",
            Self::Connectivity => "connectivity",
        }
    }
}

/// 单层状态
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[derive(Default)]
pub struct LayerState {
    pub done: bool,
    /// 缺什么 (人话, 可操作)
    pub missing: Vec<String>,
    /// 连通性层专属: 测通时的配置指纹
    pub config_hash: Option<String>,
    pub checked_at_ms: Option<u64>,
}


/// 启动门禁结论
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GateReport {
    pub ready: bool,
    /// 挡路的层与原因 (失败不吞, 全列出来)
    pub blocked: Vec<(String, String)>,
}

/// SetupStore
#[derive(Debug, Default)]
pub struct SetupStore {
    layers: HashMap<SetupLayer, LayerState>,
}

impl SetupStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 标记某层就绪
    pub fn mark_ready(&mut self, layer: SetupLayer, now_ms: u64) {
        let st = self.layers.entry(layer).or_default();
        st.done = true;
        st.missing.clear();
        st.checked_at_ms = Some(now_ms);
    }

    /// 标记某层缺什么
    pub fn mark_missing(&mut self, layer: SetupLayer, missing: Vec<String>) {
        let st = self.layers.entry(layer).or_default();
        st.done = false;
        st.missing = missing;
    }

    /// 连通性: "测过 + 配置没变" 才有效 (configHash 比对, 不看墙钟)
    pub fn record_connectivity(&mut self, config_hash: &str, now_ms: u64) {
        let st = self.layers.entry(SetupLayer::Connectivity).or_default();
        st.done = true;
        st.config_hash = Some(config_hash.to_string());
        st.checked_at_ms = Some(now_ms);
        st.missing.clear();
    }

    /// 连通性是否对当前配置有效
    pub fn connectivity_valid_for(&self, current_config_hash: &str) -> bool {
        match self.layers.get(&SetupLayer::Connectivity) {
            Some(st) => st.done && st.config_hash.as_deref() == Some(current_config_hash),
            None => false,
        }
    }

    /// 配置变了 → 连通性失效 (要重测)
    pub fn invalidate_on_config_change(&mut self, current_config_hash: &str) -> bool {
        let was_valid = self.connectivity_valid_for(current_config_hash);
        if !was_valid {
            if let Some(st) = self.layers.get_mut(&SetupLayer::Connectivity) {
                if st.done {
                    st.done = false;
                    st.missing = vec!["配置已变更, 需重测连通性".into()];
                }
            }
        }
        was_valid
    }

    /// 启动硬门禁: 检查所有层
    pub fn gate(&self) -> GateReport {
        let mut blocked = Vec::new();
        for layer in [SetupLayer::Identity, SetupLayer::Llm, SetupLayer::Connectivity] {
            let st = self.layers.get(&layer).cloned().unwrap_or_default();
            if !st.done {
                let reason = if st.missing.is_empty() {
                    format!("{} 未初始化", layer.as_str())
                } else {
                    st.missing.join("; ")
                };
                blocked.push((layer.as_str().to_string(), reason));
            }
        }
        GateReport { ready: blocked.is_empty(), blocked }
    }

    /// 分层门禁: 只查某层 (CLI 按需挡功能)
    pub fn gate_layer(&self, layer: SetupLayer) -> bool {
        self.layers.get(&layer).map(|s| s.done).unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fresh_store_blocks_everything() {
        let s = SetupStore::new();
        let gate = s.gate();
        assert!(!gate.ready);
        assert_eq!(gate.blocked.len(), 3, "三层全挡");
        // 失败不吞: 每条都有人话原因
        for (layer, reason) in &gate.blocked {
            assert!(!reason.is_empty(), "{layer} 的缺因不许为空");
        }
    }

    #[test]
    fn identity_ready_unblocks_that_layer_only() {
        let mut s = SetupStore::new();
        s.mark_ready(SetupLayer::Identity, 1);
        assert!(s.gate_layer(SetupLayer::Identity));
        assert!(!s.gate_layer(SetupLayer::Llm));
        assert!(!s.gate().ready);
    }

    #[test]
    fn mark_missing_records_reasons() {
        let mut s = SetupStore::new();
        s.mark_missing(SetupLayer::Llm, vec!["缺 provider 配置".into(), "缺 API key".into()]);
        let gate = s.gate();
        let llm = gate.blocked.iter().find(|(l, _)| l == "llm").unwrap();
        assert!(llm.1.contains("API key"));
    }

    #[test]
    fn connectivity_valid_only_for_same_config() {
        let mut s = SetupStore::new();
        s.record_connectivity("hash-a", 100);
        assert!(s.connectivity_valid_for("hash-a"), "同配置有效");
        assert!(!s.connectivity_valid_for("hash-b"), "配置变了就无效");
        // 失效后要重测
        s.invalidate_on_config_change("hash-b");
        assert!(!s.gate_layer(SetupLayer::Connectivity));
        assert_eq!(s.gate().blocked.iter().find(|(l, _)| l == "connectivity").unwrap().1, "配置已变更, 需重测连通性");
    }

    #[test]
    fn all_ready_passes_gate() {
        let mut s = SetupStore::new();
        s.mark_ready(SetupLayer::Identity, 1);
        s.mark_ready(SetupLayer::Llm, 2);
        s.record_connectivity("h", 3);
        assert!(s.gate().ready);
    }
}
