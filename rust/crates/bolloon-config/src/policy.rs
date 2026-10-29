use crate::error::ConfigError;
use crate::schema::*;
use std::collections::HashSet;

/// AI (建议级/受限自动级) 仅允许修改的运行参数白名单。
/// 即便 AI 提交了其它字段, 也会用当前值覆盖, 且不超过硬边界 (clamp)。
pub const AI_RUNTIME_WHITELIST: &[&str] = &["runtime.llm_retries", "runtime.routing_weights"];

/// 把 AI 提案收敛到白名单内: 只采纳 `AI_RUNTIME_WHITELIST` 中的 C 类字段, 其余沿用当前配置。
/// 绝不触碰 A(安全)/B(任务级)/D(启动期)。AI 无法修改自身硬上限、审批要求或校验规则。
pub fn apply_ai_whitelist(current: &AppConfig, proposed: &AppConfig) -> AppConfig {
    let mut out = current.clone();
    out.runtime.llm_retries = proposed.runtime.llm_retries.min(LIMIT_LLM_RETRIES.1);
    out.runtime.routing_weights = proposed.runtime.routing_weights.clone();
    out
}

/// 类别级授权检查: 哪些类别相对当前发生变更, 是否需要对应授权级别。
/// - A 安全紧急 → 需 System
/// - B 任务级   → 需 Operator 及以上
/// - D 启动期   → 需 System
/// - C 热更新   → 任意级别 (含 Ai, 但 Ai 仅能改白名单子集)
pub fn check_category_auth(
    proposed: &AppConfig,
    current: &AppConfig,
    auth: ConfigAuth,
) -> Result<(), ConfigError> {
    if proposed.safety != current.safety && auth < ConfigAuth::System {
        return Err(ConfigError::Unauthorized {
            required: ConfigAuth::System,
            current: auth,
        });
    }
    if proposed.task != current.task && auth < ConfigAuth::Operator {
        return Err(ConfigError::Unauthorized {
            required: ConfigAuth::Operator,
            current: auth,
        });
    }
    if proposed.startup != current.startup && auth < ConfigAuth::System {
        return Err(ConfigError::Unauthorized {
            required: ConfigAuth::System,
            current: auth,
        });
    }
    // ── 经济层 (F 类) ──
    // 只改计量/影子参数: Operator 就够;
    // 打开**强制预算 / 社区路由 / 贡献结算** = 改变真实资源分配 ⇒ 必须 System
    // (AI 永远改不到: 它连 Operator 都没有; 白名单里也没有 economic 字段)
    if proposed.economic != current.economic {
        let stronger = |a: &EconomicConfig, b: &EconomicConfig| {
            (a.budget_enforcement_enabled && !b.budget_enforcement_enabled)
                || (a.community_routing_enabled && !b.community_routing_enabled)
                || (a.contribution_settlement_enabled && !b.contribution_settlement_enabled)
                || (a.mode == EconomicMode::Enforce && b.mode != EconomicMode::Enforce)
        };
        let need = if stronger(&proposed.economic, &current.economic) {
            ConfigAuth::System
        } else {
            ConfigAuth::Operator
        };
        if auth < need {
            return Err(ConfigError::Unauthorized {
                required: need,
                current: auth,
            });
        }
    }
    Ok(())
}

/// 运行策略: 把配置值映射为具体运行行为。**只读取, 绝不绕过既有 Harness 权限检查。**
pub struct RuntimePolicy;

impl RuntimePolicy {
    pub fn tool_timeout_ms(snap: &ConfigSnapshot) -> u64 {
        snap.config.runtime.tool_timeout_ms
    }
    pub fn llm_retries(snap: &ConfigSnapshot) -> u32 {
        snap.config.runtime.llm_retries
    }
    pub fn model_concurrency(snap: &ConfigSnapshot) -> u32 {
        snap.config.runtime.model_concurrency
    }
    pub fn max_no_progress(snap: &ConfigSnapshot) -> u32 {
        snap.config.runtime.max_no_progress
    }
    pub fn max_reflect(snap: &ConfigSnapshot) -> u32 {
        snap.config.runtime.max_reflect
    }
    pub fn max_steps(snap: &ConfigSnapshot) -> u32 {
        snap.config.task.max_steps
    }
    pub fn budget(snap: &ConfigSnapshot) -> (u32, u64) {
        (snap.config.task.budget_calls, snap.config.task.budget_ms)
    }
    pub fn model_override(snap: &ConfigSnapshot) -> (Option<String>, Option<String>) {
        (
            snap.config.task.default_model.clone(),
            snap.config.task.default_base_url.clone(),
        )
    }
    pub fn prompt_override(snap: &ConfigSnapshot) -> Option<String> {
        snap.config.task.system_prompt_override.clone()
    }
    pub fn emergency_stop(snap: &ConfigSnapshot) -> bool {
        snap.config.safety.emergency_stop
    }

    /// 计算有效授予集合: 以 `base_granted` (底座默认授予) 或 `safety.granted_tools` 为基准,
    /// 再实时移除 `revoked_tools` (即使任务已捕获快照, 此处仍按当前配置生效 —— 独立安全路径)。
    pub fn effective_granted(snap: &ConfigSnapshot, base_granted: &[String]) -> HashSet<String> {
        let mut set: HashSet<String> = if snap.config.safety.granted_tools.is_empty() {
            base_granted.iter().cloned().collect()
        } else {
            snap.config.safety.granted_tools.iter().cloned().collect()
        };
        for r in &snap.config.safety.revoked_tools {
            set.remove(r);
        }
        set
    }

    /// 工具是否被允许 (组合: 紧急停止 / 撤销 / 显式授予)。供 Harness gate 在权限判定阶段调用。
    /// 返回 None 表示放行; 返回 Some(reason) 表示拒绝。
    pub fn tool_denied(
        snap: &ConfigSnapshot,
        tool: &str,
        base_granted: &[String],
    ) -> Option<String> {
        if snap.config.safety.emergency_stop {
            return Some("emergency_stop 已生效".into());
        }
        if snap.config.safety.revoked_tools.iter().any(|t| t == tool) {
            return Some(format!("工具 {tool} 已被撤销"));
        }
        let granted = Self::effective_granted(snap, base_granted);
        if !granted.contains(tool) {
            return Some(format!("工具 {tool} 不在有效授予集合"));
        }
        None
    }
}
