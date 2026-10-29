use crate::error::ConfigError;
use crate::schema::*;

fn check_u64(name: &str, v: u64, (lo, hi): (u64, u64)) -> Result<(), ConfigError> {
    if v < lo || v > hi {
        return Err(ConfigError::Validation(format!(
            "{name}={v} 超出范围 [{lo},{hi}]"
        )));
    }
    Ok(())
}
fn check_u32(name: &str, v: u32, (lo, hi): (u32, u32)) -> Result<(), ConfigError> {
    if v < lo || v > hi {
        return Err(ConfigError::Validation(format!(
            "{name}={v} 超出范围 [{lo},{hi}]"
        )));
    }
    Ok(())
}

/// 结构校验 + 业务不变量 + 安全策略 (静态部分)。不校验授权级别 (见 policy::check_category_auth)。
pub fn validate(cfg: &AppConfig) -> Result<(), ConfigError> {
    check_u64(
        "runtime.tool_timeout_ms",
        cfg.runtime.tool_timeout_ms,
        LIMIT_TOOL_TIMEOUT_MS,
    )?;
    check_u32("runtime.llm_retries", cfg.runtime.llm_retries, LIMIT_LLM_RETRIES)?;
    check_u32(
        "runtime.model_concurrency",
        cfg.runtime.model_concurrency,
        LIMIT_MODEL_CONCURRENCY,
    )?;
    check_u32(
        "runtime.max_no_progress",
        cfg.runtime.max_no_progress,
        LIMIT_MAX_NO_PROGRESS,
    )?;
    check_u32(
        "runtime.max_reflect",
        cfg.runtime.max_reflect,
        LIMIT_MAX_REFLECT,
    )?;
    check_u32("task.budget_calls", cfg.task.budget_calls, LIMIT_BUDGET_CALLS)?;
    check_u64("task.budget_ms", cfg.task.budget_ms, LIMIT_BUDGET_MS)?;
    check_u32("task.max_steps", cfg.task.max_steps, LIMIT_MAX_STEPS)?;

    // 非法组合
    if cfg.safety.full_access && !cfg.safety.revoked_tools.is_empty() {
        return Err(ConfigError::Validation(
            "full_access 与 revoked_tools 矛盾: 完全访问下不允许局部撤销".into(),
        ));
    }
    if let Some(p) = &cfg.task.system_prompt_override {
        if p.trim().is_empty() {
            return Err(ConfigError::Validation(
                "system_prompt_override 不能为空字符串".into(),
            ));
        }
    }
    // ── 经济层 (F 类) ──
    {
        let e = &cfg.economic;
        // 影子模式就意味着"不拦不换": 想强制必须显式 mode=enforce
        if e.budget_enforcement_enabled && e.mode != EconomicMode::Enforce {
            return Err(ConfigError::Validation(
                "economic.budget_enforcement_enabled 只能在 mode=enforce 下开启 (shadow 只计量)".into(),
            ));
        }
        if e.community_routing_enabled && e.mode != EconomicMode::Enforce {
            return Err(ConfigError::Validation(
                "economic.community_routing_enabled 只能在 mode=enforce 下开启".into(),
            ));
        }
        if e.pool_cash_available_usd < 0.0 || !e.pool_cash_available_usd.is_finite() {
            return Err(ConfigError::Validation(
                "economic.pool_cash_available_usd 必须是非负有限数 (未到账的钱不能当预算)".into(),
            ));
        }
        if let Some(b) = e.default_intent_budget_usd {
            if b < 0.0 || !b.is_finite() {
                return Err(ConfigError::Validation(
                    "economic.default_intent_budget_usd 必须是非负有限数".into(),
                ));
            }
        }
        if e.default_max_delegation_depth > 8 {
            return Err(ConfigError::Validation(
                "economic.default_max_delegation_depth 不得超过 8 (委托爆炸防护)".into(),
            ));
        }
    }

    for (k, w) in &cfg.runtime.routing_weights {
        if *w < 0.0 {
            return Err(ConfigError::Validation(format!(
                "routing_weights[{k}] 不能为负"
            )));
        }
    }
    Ok(())
}
