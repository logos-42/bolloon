//! AI 自动优化闭环 —— **默认建议级, 且前置条件不满足就拒绝**。
//!
//! 硬规则 (对齐需求第六阶段 "限制 AI 的配置修改权限"):
//! 1. AI 只能改 `policy::AI_RUNTIME_WHITELIST` 里的 C 类参数; A/B/D 与校验规则、自身硬上限一律碰不到
//!    (白名单在 `ConfigManager::apply` 内强制, 这里不重复实现第二套)。
//! 2. 指标必须**可信**: `TrustLevel::Measured` 或 `Derived` 才算数;
//!    模型自述"我觉得好了"(`ModelClaimed`) 永远不算 —— 那正是反馈回路最容易自欺的地方。
//! 3. 必须有: 目标指标 + 预算(轮数/墙钟) + 单轮最大调整幅度 + 停止条件 + 回滚条件。
//!    缺任何一项 → 拒绝启动 (`OptimizeError`)。
//! 4. 指标恶化超过回滚阈值 → **自动回滚到基线版本**, 并停止。
//! 5. 默认 `AiMode::Advisory`: 只产出提案, 绝不写配置。写入必须显式 `RestrictedAuto`。
//! 6. 受限自动级只**保留能证明的赢**: 指标没改善到 `min_improvement_ratio` 也回滚 ——
//!    "没变差"不足以成为留下改动的理由。
//!
//! 这不是"AI 自己调自己": 参数方向由人声明 (`ParamResponse`), AI 只负责在预算内小步试、
//! 事后按指标判定、不行就退回去。

use crate::manager::{ConfigManager, ConfigProposal};
use crate::schema::{ConfigAuth, ConfigSnapshot, LIMIT_LLM_RETRIES};
use serde::{Deserialize, Serialize};
use std::time::Instant;

/// 指标信任级。数值来自哪里, 决定它能不能驱动配置变更。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum TrustLevel {
    /// 模型自己说的 (永远不能驱动变更)
    ModelClaimed = 0,
    /// 由可信数据推导 (如从 usage 统计算出的比率)
    Derived = 1,
    /// 直接测出来的 (计时器/计数器/测试结果)
    Measured = 2,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricSample {
    pub name: String,
    pub value: f64,
    pub trust: TrustLevel,
    pub at: String,
}

impl MetricSample {
    pub fn measured(name: &str, value: f64) -> Self {
        Self {
            name: name.to_string(),
            value,
            trust: TrustLevel::Measured,
            at: chrono::Utc::now().to_rfc3339(),
        }
    }
    pub fn trusted(&self) -> bool {
        self.trust >= TrustLevel::Derived
    }
}

/// 指标来源端口 (运行时/测试注入)。
pub trait MetricSource: Send + Sync {
    fn read(&self, name: &str) -> Option<MetricSample>;
}

/// 人工声明的"参数往哪个方向走会让指标变好"。
/// **AI 无权决定这个方向** —— 方向错了, 闭环也只会在预算内小步试并及时回滚。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamResponse {
    /// 调高参数有利于指标
    HigherHelps,
    /// 调低参数有利于指标
    LowerHelps,
}

/// 目标 + 预算 + 停止条件 + 回滚条件 (缺一不可)。
#[derive(Debug, Clone)]
pub struct OptimizationObjective {
    /// 目标指标名 (必须能在 `MetricSource` 里读到且可信)
    pub metric: String,
    /// 指标越大越好?
    pub higher_is_better: bool,
    /// 达到这个改善比例就算达标并停止 (0.05 = 5%)
    pub min_improvement_ratio: f64,
    /// 单轮最大调整幅度 (相对当前值; 0.25 = 最多 ±25%, 且至少 ±1 步)
    pub max_adjustment_ratio: f64,
    /// 相对基线**恶化**超过该比例就回滚 (0.10 = 回落 10%)
    pub degrade_rollback_ratio: f64,
    /// 轮数预算
    pub max_rounds: u32,
    /// 墙钟预算 (毫秒)
    pub max_wall_ms: u64,
}

impl Default for OptimizationObjective {
    fn default() -> Self {
        Self {
            metric: "llm_failure_rate".into(),
            higher_is_better: false,
            min_improvement_ratio: 0.05,
            max_adjustment_ratio: 0.25,
            degrade_rollback_ratio: 0.10,
            max_rounds: 3,
            max_wall_ms: 60_000,
        }
    }
}

/// AI 的权限级别。默认建议级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AiMode {
    /// 只出提案 + 证据, 不改配置 (默认)
    Advisory,
    /// 受限自动: 只能改白名单参数, 受预算/停止/回滚约束
    RestrictedAuto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proposal {
    pub param: String,
    pub from: f64,
    pub to: f64,
    pub why: String,
    pub evidence: Vec<String>,
    /// 该提案是否需要审批后才能应用
    pub needs_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoundRecord {
    pub round: u32,
    pub version_before: u64,
    pub version_after: u64,
    pub param_from: f64,
    pub param_to: f64,
    pub metric_before: f64,
    pub metric_after: Option<f64>,
    pub decision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptimizationReport {
    pub metric: String,
    pub baseline_version: u64,
    pub baseline_metric: f64,
    pub rounds: Vec<RoundRecord>,
    pub stop_reason: String,
    pub final_version: u64,
    pub rolled_back: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum OptimizeError {
    #[error("缺少可信指标 `{0}`: 只有 Measured/Derived 级能驱动变更 (模型自述不算)")]
    NoTrustedMetric(String),
    #[error("当前为建议级 (Advisory): 只产出提案, 不写配置 —— 要写入必须显式 RestrictedAuto")]
    AdvisoryOnly,
    #[error("参数 `{0}` 不在 AI 白名单内")]
    NotWhitelisted(String),
    #[error("参数 `{0}` 已到硬边界 [{1},{2}], 无法再调整")]
    AtBound(String, f64, f64),
    #[error("配置应用失败: {0}")]
    Config(String),
    #[error("回滚失败 (这是最坏情况, 必须人工介入): {0}")]
    RollbackFailed(String),
    #[error("预算配置非法: {0}")]
    BadBudget(String),
}

/// 只调 `runtime.llm_retries` (白名单里唯一的标量参数)。
pub const TUNED_PARAM: &str = "runtime.llm_retries";

pub struct AiOptimizer {
    mode: AiMode,
    objective: OptimizationObjective,
    response: ParamResponse,
}

impl AiOptimizer {
    pub fn new(mode: AiMode, objective: OptimizationObjective, response: ParamResponse) -> Self {
        Self {
            mode,
            objective,
            response,
        }
    }

    pub fn mode(&self) -> AiMode {
        self.mode
    }

    fn check_budget(&self) -> Result<(), OptimizeError> {
        let o = &self.objective;
        if o.max_rounds == 0 {
            return Err(OptimizeError::BadBudget("max_rounds 不能为 0".into()));
        }
        if o.max_wall_ms == 0 {
            return Err(OptimizeError::BadBudget("max_wall_ms 不能为 0".into()));
        }
        if !(o.max_adjustment_ratio > 0.0 && o.max_adjustment_ratio <= 1.0) {
            return Err(OptimizeError::BadBudget(
                "max_adjustment_ratio 必须在 (0,1]".into(),
            ));
        }
        if o.degrade_rollback_ratio <= 0.0 {
            return Err(OptimizeError::BadBudget(
                "degrade_rollback_ratio 必须 > 0 (否则永不回滚)".into(),
            ));
        }
        Ok(())
    }

    /// 取可信指标样本; 不可信/缺失一律当"没有指标"处理 (fail-closed)。
    fn trusted(&self, metrics: &dyn MetricSource) -> Result<MetricSample, OptimizeError> {
        match metrics.read(&self.objective.metric) {
            Some(s) if s.trusted() => Ok(s),
            _ => Err(OptimizeError::NoTrustedMetric(
                self.objective.metric.clone(),
            )),
        }
    }

    /// 下一步候选值 (受硬边界与最大调整幅度双重约束)。
    fn next_value(&self, current: f64) -> Result<f64, OptimizeError> {
        let (lo, hi) = (LIMIT_LLM_RETRIES.0 as f64, LIMIT_LLM_RETRIES.1 as f64);
        let step = (current * self.objective.max_adjustment_ratio).round().max(1.0);
        let next = match self.response {
            ParamResponse::HigherHelps => current + step,
            ParamResponse::LowerHelps => current - step,
        }
        .clamp(lo, hi);
        if (next - current).abs() < f64::EPSILON {
            return Err(OptimizeError::AtBound(TUNED_PARAM.into(), lo, hi));
        }
        Ok(next)
    }

    /// 建议级入口: 只产出提案 (含证据), **不写配置**。
    /// 即使 mode = RestrictedAuto 也可以用它先看 AI 想干什么。
    pub fn propose(
        &self,
        mgr: &ConfigManager,
        metrics: &dyn MetricSource,
    ) -> Result<Vec<Proposal>, OptimizeError> {
        self.check_budget()?;
        let sample = self.trusted(metrics)?;
        let cur = mgr.current();
        let from = cur.config.runtime.llm_retries as f64;
        let to = self.next_value(from)?;
        let why = format!(
            "指标 `{}` = {:.4} (trust={:?}, {}), 目标={}; {} 从 {from} 调到 {to} 预期改善",
            self.objective.metric,
            sample.value,
            sample.trust,
            if self.objective.higher_is_better { "越大越好" } else { "越小越好" },
            TUNED_PARAM,
            match self.response {
                ParamResponse::HigherHelps => "提高",
                ParamResponse::LowerHelps => "降低",
            }
        );
        Ok(vec![Proposal {
            param: TUNED_PARAM.into(),
            from,
            to,
            why,
            evidence: vec![format!(
                "metric={} value={} trust={:?} at={}",
                sample.name, sample.value, sample.trust, sample.at
            )],
            // 建议级永远需要审批; 受限自动级下白名单内参数不需要
            needs_approval: self.mode == AiMode::Advisory,
        }])
    }

    /// 受限自动闭环: 小步试 → 事后测量 → 达标停 / 恶化回滚 / 预算耗尽停。
    /// 前置条件不满足 (无可信指标 / 建议级 / 预算非法) 一律拒绝, 当前配置不变。
    pub async fn run(
        &self,
        mgr: &ConfigManager,
        metrics: &dyn MetricSource,
    ) -> Result<OptimizationReport, OptimizeError> {
        self.check_budget()?;
        if self.mode == AiMode::Advisory {
            return Err(OptimizeError::AdvisoryOnly);
        }
        let baseline = self.trusted(metrics)?;
        let obj = self.objective.clone();
        let started = Instant::now();
        let mut rounds: Vec<RoundRecord> = vec![];
        let mut rolled_back = false;
        let mut stop_reason = "budget.rounds".to_string();
        let baseline_version = mgr.current().version;

        // 单轮 fail-closed: 每一轮都以 apply → 事后测量 → (保留 | 回滚) 收尾, 没有"继续下一轮"的分支。
        // 想做多轮, 得先有逐轮可信指标 —— 所以这里显式记下 never_loop 是**设计**而不是漏写。
        #[allow(clippy::never_loop)]
        for round in 1..=obj.max_rounds {
            if started.elapsed().as_millis() as u64 > obj.max_wall_ms {
                stop_reason = "budget.wall_ms".into();
                break;
            }
            let cur = mgr.current();
            let from = cur.config.runtime.llm_retries as f64;
            let to = match self.next_value(from) {
                Ok(v) => v,
                Err(OptimizeError::AtBound(..)) => {
                    stop_reason = "bounds".into();
                    break;
                }
                Err(e) => return Err(e),
            };
            let mut cfg = cur.config.clone();
            cfg.runtime.llm_retries = to as u32;
            // AI 身份提交: 白名单在 manager 内强制, 越界字段不会进来
            let applied = match mgr
                .apply(ConfigProposal {
                    based_on: Some(cur.version),
                    config: cfg,
                    auth: ConfigAuth::Ai,
                    source: "ai-optimizer".into(),
                    operator: "ai".into(),
                    reason: format!("objective={} retries {}->{}", obj.metric, from, to),
                })
                .await
            {
                Ok(s) => s,
                Err(e) => {
                    stop_reason = format!("apply_rejected: {e}");
                    break;
                }
            };

            // 事后测量: 拿不到可信样本 ⇒ 立刻回滚 (不允许"没法验证但先留着")
            let after = metrics.read(&obj.metric).filter(|s| s.trusted());
            let after_value = after.as_ref().map(|s| s.value);
            if let Some(v) = after_value {
                let improved = if obj.higher_is_better {
                    v > baseline.value
                } else {
                    v < baseline.value
                };
                let degraded = if obj.higher_is_better {
                    v < baseline.value * (1.0 - obj.degrade_rollback_ratio)
                } else {
                    v > baseline.value * (1.0 + obj.degrade_rollback_ratio)
                };
                let gain = if baseline.value.abs() > f64::EPSILON {
                    ((v - baseline.value) / baseline.value).abs()
                } else {
                    0.0
                };
                rounds.push(RoundRecord {
                    round,
                    version_before: cur.version,
                    version_after: applied.version,
                    param_from: from,
                    param_to: to,
                    metric_before: baseline.value,
                    metric_after: Some(v),
                    decision: if degraded {
                        "rollback.degraded".into()
                    } else if improved && gain >= obj.min_improvement_ratio {
                        "accept.objective_reached".into()
                    } else {
                        "keep.no_significant_gain".into()
                    },
                });
                if degraded {
                    match mgr.rollback_to(cur.version).await {
                        Ok(_) => {
                            rolled_back = true;
                            stop_reason = "rollback.degraded".into();
                        }
                        Err(e) => return Err(OptimizeError::RollbackFailed(e.to_string())),
                    }
                    break;
                }
                if improved && gain >= obj.min_improvement_ratio {
                    stop_reason = "objective.reached".into();
                    break;
                }
                // 没有可信证据证明变好了 ⇒ 不保留改动 (只留能证明的赢)
                rounds.last_mut().unwrap().decision = "rollback.no_improvement".into();
                match mgr.rollback_to(cur.version).await {
                    Ok(_) => {
                        rolled_back = true;
                        stop_reason = "rollback.no_improvement".into();
                    }
                    Err(e) => return Err(OptimizeError::RollbackFailed(e.to_string())),
                }
                break;
            } else {
                // 没有可信事后指标: 回滚并停 (fail-closed)
                rounds.push(RoundRecord {
                    round,
                    version_before: cur.version,
                    version_after: applied.version,
                    param_from: from,
                    param_to: to,
                    metric_before: baseline.value,
                    metric_after: None,
                    decision: "rollback.metric_missing".into(),
                });
                match mgr.rollback_to(cur.version).await {
                    Ok(_) => {
                        rolled_back = true;
                        stop_reason = "rollback.metric_missing".into();
                    }
                    Err(e) => return Err(OptimizeError::RollbackFailed(e.to_string())),
                }
                break;
            }
        }

        Ok(OptimizationReport {
            metric: obj.metric,
            baseline_version,
            baseline_metric: baseline.value,
            rounds,
            stop_reason,
            final_version: mgr.current().version,
            rolled_back,
        })
    }
}

/// 便捷: 把一次报告压成一行审计摘要 (供日志/面板)。
pub fn report_line(r: &OptimizationReport) -> String {
    format!(
        "AI 优化: metric={} v{}→v{} baseline={:.4} rounds={} stop={}{}",
        r.metric,
        r.baseline_version,
        r.final_version,
        r.baseline_metric,
        r.rounds.len(),
        r.stop_reason,
        if r.rolled_back { " (已回滚)" } else { "" }
    )
}

/// 让快照可以便宜地拿出当前参数 (供面板展示)
pub fn current_param(snap: &ConfigSnapshot) -> f64 {
    snap.config.runtime.llm_retries as f64
}
