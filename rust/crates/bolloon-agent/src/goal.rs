//! Goal 长期执行飞轮 — continuation 决策 (纯函数核心)
//!
//! 对齐 TS 版 `goal-flywheel/types.ts` 冻结契约:
//! - Goal 是意图的可执行投影; 节奏由**进展**决定, 不由固定轮数决定
//! - 有进展 → 继续 · 等外部 → 事件或 wakeAt · 连续无新证据 → stalled → needs_human
//! - 三条硬底线: 单 Run 时间 / 单 Goal 预算 / 无进展熔断
//! - **Goal 不许悬空**: 只有 completed/failed/abandoned/needs_human 可结束

use serde::{Deserialize, Serialize};

/// Goal 生命周期状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalLifecycleState {
    Open,
    Running,
    WaitingExternal,
    Stalled,
    Completed,
    Failed,
    Abandoned,
    NeedsHuman,
}

/// 可结束状态 (不许悬空的冻结集)
pub fn is_terminal(state: GoalLifecycleState) -> bool {
    matches!(
        state,
        GoalLifecycleState::Completed
            | GoalLifecycleState::Failed
            | GoalLifecycleState::Abandoned
            | GoalLifecycleState::NeedsHuman
    )
}

/// 续跑决策 (P0 冻结契约)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContinuationDecision {
    pub decision: DecisionKind,
    /// 为什么 (必须说人话)
    pub reason: String,
    /// 下一步动作描述
    pub next_action: String,
    /// 等外部时的唤醒时刻 (epoch ms; None = 事件驱动)
    pub wake_at_ms: Option<u64>,
    /// 本轮是否有新证据/进展
    pub progress_delta: bool,
    pub confidence: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    Continue,
    WaitForEvent,
    SleepUntil,
    Stalled,
    NeedsHuman,
    Stop,
}

/// 硬底线配置 (P0 冻结)
#[derive(Debug, Clone)]
pub struct HardLimits {
    /// 单 Run 最长毫秒
    pub max_run_ms: u64,
    /// 单 Goal 预算 (原子单位)
    pub max_budget_atomic: u128,
    /// 连续无进展轮数熔断
    pub max_stalled_rounds: u32,
}

impl Default for HardLimits {
    fn default() -> Self {
        Self {
            max_run_ms: 30 * 60 * 1000,
            max_budget_atomic: 20_000_000, // 20 USDC
            max_stalled_rounds: 5,
        }
    }
}

/// 决策输入 (本轮观察)
#[derive(Debug, Clone)]
pub struct RoundObservation {
    pub round: u32,
    /// 本轮是否有新证据 (工具产出/文件变化/外部回信)
    pub progress_delta: bool,
    /// 已在等外部 (如等回信/等 CI)
    pub waiting_external: bool,
    /// 外部事件已到达
    pub external_event_arrived: bool,
    /// 预计外部到达时刻 (epoch ms)
    pub external_eta_ms: Option<u64>,
    /// 本轮出现阻塞 (缺能力/缺权限/缺资源)
    pub blocked: bool,
    /// 继续跑已无价值 (目标已被达成/前提已失效)
    pub no_value_left: bool,
}

/// 决策输入的运行侧事实
#[derive(Debug, Clone)]
pub struct RunFacts {
    pub run_elapsed_ms: u64,
    pub spent_budget_atomic: u128,
    pub consecutive_stalled_rounds: u32,
    pub now_ms: u64,
}

/// 核心 continuation 决策 (纯函数, 顺序即优先级):
///
/// 1. 无价值 → stop (交 stop_reason, 不悬空)
/// 2. 阻塞 → needs_human (不许自己硬扛)
/// 3. 硬底线任一触发 → needs_human (熔断)
/// 4. 等外部且事件已到 → continue
/// 5. 等外部且有 ETA → sleep_until(eta)
/// 6. 等外部无 ETA → wait_for_event
/// 7. 有进展 → continue
/// 8. 连续无进展达阈值 → stalled (下一轮升级 needs_human)
/// 9. 默认 → continue (无进展但未达阈值, 再给一轮)
pub fn decide_continuation(obs: &RoundObservation, facts: &RunFacts, limits: &HardLimits) -> ContinuationDecision {
    // 1. 无价值
    if obs.no_value_left {
        return ContinuationDecision {
            decision: DecisionKind::Stop,
            reason: "目标已达成或前提已失效, 继续跑无价值".into(),
            next_action: "收尾: 汇总产出, 写 Memory, 结束 Goal".into(),
            wake_at_ms: None,
            progress_delta: obs.progress_delta,
            confidence: 0.9,
        };
    }
    // 2. 阻塞
    if obs.blocked {
        return ContinuationDecision {
            decision: DecisionKind::NeedsHuman,
            reason: "本轮出现阻塞 (缺能力/权限/资源), 需要人介入".into(),
            next_action: "向用户报告阻塞点与建议动作".into(),
            wake_at_ms: None,
            progress_delta: obs.progress_delta,
            confidence: 0.85,
        };
    }
    // 3. 硬底线 (任一触发即熔断)
    if facts.run_elapsed_ms >= limits.max_run_ms {
        return hard_limit_hit("单 Run 时间超限", facts, obs);
    }
    if facts.spent_budget_atomic >= limits.max_budget_atomic {
        return hard_limit_hit("单 Goal 预算超限", facts, obs);
    }
    if facts.consecutive_stalled_rounds >= limits.max_stalled_rounds {
        return hard_limit_hit("连续无进展熔断", facts, obs);
    }
    // 4. 等外部且事件已到
    if obs.waiting_external && obs.external_event_arrived {
        return ContinuationDecision {
            decision: DecisionKind::Continue,
            reason: "等待的外部事件已到达".into(),
            next_action: "处理外部事件, 继续执行".into(),
            wake_at_ms: None,
            progress_delta: true,
            confidence: 0.9,
        };
    }
    // 5. 等外部且有 ETA
    if obs.waiting_external {
        if let Some(eta) = obs.external_eta_ms {
            return ContinuationDecision {
                decision: DecisionKind::SleepUntil,
                reason: "等外部, 到点唤醒".into(),
                next_action: "休眠到 eta 后复查".into(),
                wake_at_ms: Some(eta),
                progress_delta: obs.progress_delta,
                confidence: 0.7,
            };
        }
        // 6. 等外部无 ETA
        return ContinuationDecision {
            decision: DecisionKind::WaitForEvent,
            reason: "等外部, 无预计时刻, 事件驱动唤醒".into(),
            next_action: "挂起等事件; 别把有进展的目标挂成永久等外部".into(),
            wake_at_ms: None,
            progress_delta: obs.progress_delta,
            confidence: 0.6,
        };
    }
    // 7. 有进展
    if obs.progress_delta {
        return ContinuationDecision {
            decision: DecisionKind::Continue,
            reason: format!("本轮有新进展 (第 {} 轮)", obs.round),
            next_action: "继续执行下一步".into(),
            wake_at_ms: None,
            progress_delta: true,
            confidence: 0.85,
        };
    }
    // 8. 无进展但未达阈值
    let stalled = facts.consecutive_stalled_rounds;
    if stalled + 1 >= limits.max_stalled_rounds {
        return ContinuationDecision {
            decision: DecisionKind::Stalled,
            reason: format!("连续 {stalled} 轮无新证据, 下一轮将熔断"),
            next_action: "复盘: 换路子或升级给人".into(),
            wake_at_ms: None,
            progress_delta: false,
            confidence: 0.5,
        };
    }
    // 9. 默认继续
    ContinuationDecision {
        decision: DecisionKind::Continue,
        reason: format!("无新进展 (连续 {stalled} 轮), 未达熔断阈值, 再给一轮"),
        next_action: "继续执行".into(),
        wake_at_ms: None,
        progress_delta: false,
        confidence: 0.5,
    }
}

fn hard_limit_hit(what: &str, facts: &RunFacts, obs: &RoundObservation) -> ContinuationDecision {
    ContinuationDecision {
        decision: DecisionKind::NeedsHuman,
        reason: format!("硬底线触发: {what} (elapsed={}ms, budget={}, stalled={})",
            facts.run_elapsed_ms, facts.spent_budget_atomic, facts.consecutive_stalled_rounds),
        next_action: "熔断: 保留现场, 报告人".into(),
        wake_at_ms: None,
        progress_delta: obs.progress_delta,
        confidence: 0.95,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> RunFacts {
        RunFacts {
            run_elapsed_ms: 0,
            spent_budget_atomic: 0,
            consecutive_stalled_rounds: 0,
            now_ms: 1000,
        }
    }

    #[test]
    fn no_value_stops_not_hangs() {
        let obs = RoundObservation {
            round: 3,
            progress_delta: true,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: true,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::Stop);
    }

    #[test]
    fn blocked_escalates_to_human() {
        let obs = RoundObservation {
            round: 1,
            progress_delta: false,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: true,
            no_value_left: false,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::NeedsHuman);
    }

    #[test]
    fn budget_limit_circuits() {
        let obs = RoundObservation {
            round: 9,
            progress_delta: true,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let mut f = facts();
        f.spent_budget_atomic = 20_000_000;
        let d = decide_continuation(&obs, &f, &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::NeedsHuman);
        assert!(d.reason.contains("预算"));
    }

    #[test]
    fn run_time_limit_circuits() {
        let obs = RoundObservation {
            round: 1,
            progress_delta: true,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let mut f = facts();
        f.run_elapsed_ms = 30 * 60 * 1000;
        let d = decide_continuation(&obs, &f, &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::NeedsHuman);
    }

    #[test]
    fn stalled_rounds_circuit() {
        let obs = RoundObservation {
            round: 5,
            progress_delta: false,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let mut f = facts();
        f.consecutive_stalled_rounds = 5;
        let d = decide_continuation(&obs, &f, &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::NeedsHuman);
    }

    #[test]
    fn waiting_with_eta_sleeps_until() {
        let obs = RoundObservation {
            round: 2,
            progress_delta: false,
            waiting_external: true,
            external_event_arrived: false,
            external_eta_ms: Some(5000),
            blocked: false,
            no_value_left: false,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::SleepUntil);
        assert_eq!(d.wake_at_ms, Some(5000));
    }

    #[test]
    fn waiting_without_eta_is_event_driven() {
        let obs = RoundObservation {
            round: 2,
            progress_delta: false,
            waiting_external: true,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::WaitForEvent);
    }

    #[test]
    fn external_event_arrival_resumes() {
        let obs = RoundObservation {
            round: 2,
            progress_delta: false,
            waiting_external: true,
            external_event_arrived: true,
            external_eta_ms: Some(9999),
            blocked: false,
            no_value_left: false,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::Continue, "事件到了就继续, 不傻睡");
    }

    #[test]
    fn progress_continues() {
        let obs = RoundObservation {
            round: 1,
            progress_delta: true,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let d = decide_continuation(&obs, &facts(), &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::Continue);
    }

    #[test]
    fn stalled_not_yet_limit_gets_one_more_round() {
        let obs = RoundObservation {
            round: 3,
            progress_delta: false,
            waiting_external: false,
            external_event_arrived: false,
            external_eta_ms: None,
            blocked: false,
            no_value_left: false,
        };
        let mut f = facts();
        f.consecutive_stalled_rounds = 3; // < 5
        let d = decide_continuation(&obs, &f, &HardLimits::default());
        assert_eq!(d.decision, DecisionKind::Continue);
    }

    #[test]
    fn only_terminal_states_end_goal() {
        // Goal 不许悬空: running/open 不可当终态
        assert!(!is_terminal(GoalLifecycleState::Running));
        assert!(!is_terminal(GoalLifecycleState::Open));
        assert!(!is_terminal(GoalLifecycleState::WaitingExternal));
        assert!(!is_terminal(GoalLifecycleState::Stalled));
        assert!(is_terminal(GoalLifecycleState::Completed));
        assert!(is_terminal(GoalLifecycleState::Failed));
        assert!(is_terminal(GoalLifecycleState::Abandoned));
        assert!(is_terminal(GoalLifecycleState::NeedsHuman));
    }
}
