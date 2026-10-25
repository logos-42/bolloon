//! 子智能体派送检查 — 派遣后的监督闭环
//!
//! 对齐 TS 版 goal-flywheel P3 (WorkMonitor / 阻塞) + subagent-manager:
//! - 派遣 ≠ 放手: 每个在途合同有**检查点** (进度轮询/心跳/超时)
//! - 超时未回 → 回收 (标 timeout, 重派或升级给人)
//! - 阻塞上报 (blocked) → 透传给父 (不许子自己硬扛)
//! - 检查结论四类: on_track / needs_nudge / timed_out / blocked

use serde::{Deserialize, Serialize};

use crate::subagents::{AgentWorkContract, ReportStatus};

/// 检查结论
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckVerdict {
    /// 正常在途
    OnTrack,
    /// 快到超时, 提醒/催促
    NeedsNudge,
    /// 超时 → 回收
    TimedOut,
    /// 子上报阻塞 → 透传
    Blocked,
}

/// 在途派遣
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dispatch {
    pub contract: AgentWorkContract,
    /// 最近一次子端心跳 (epoch ms; None = 从未心跳)
    pub last_heartbeat_ms: Option<u64>,
    /// 子上报的进度摘要 (最近一次)
    pub last_progress: Option<String>,
    /// 是否已上报阻塞
    pub blocked: bool,
    /// 是否已 nudge 过 (防重复催)
    pub nudged: bool,
    pub dispatched_at_ms: u64,
}

/// 检查输入
#[derive(Debug, Clone)]
pub struct CheckInput {
    pub now_ms: u64,
    /// 超时阈值 (超过 contract.timeout_ms 用合同值; 这里给全局兜底)
    pub global_timeout_ms: u64,
    /// nudge 阈值 (剩余时间比)
    pub nudge_ratio: f64,
}

/// 检查结论
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DispatchCheck {
    pub verdict: CheckVerdict,
    pub contract_id: String,
    pub reason: String,
}

/// 检查一个在途派遣 (纯函数)
pub fn check_dispatch(d: &Dispatch, input: &CheckInput) -> DispatchCheck {
    let contract_id = d.contract.contract_id.clone();
    // 阻塞最优先 (子明说卡住了)
    if d.blocked {
        return DispatchCheck {
            verdict: CheckVerdict::Blocked,
            contract_id,
            reason: "子智能体上报阻塞 → 透传给父 (升级处理, 不许子硬扛)".into(),
        };
    }
    let timeout = d.contract.timeout_ms.max(input.global_timeout_ms);
    let elapsed = input.now_ms.saturating_sub(d.dispatched_at_ms);
    // 超时 → 回收
    if elapsed > timeout {
        return DispatchCheck {
            verdict: CheckVerdict::TimedOut,
            contract_id,
            reason: format!("在途 {elapsed}ms 超过合同超时 {timeout}ms → 回收 (重派或升级给人)"),
        };
    }
    // 心跳停了 = 可能挂了
    if let Some(hb) = d.last_heartbeat_ms {
        if input.now_ms.saturating_sub(hb) > timeout / 2 {
            return DispatchCheck {
                verdict: CheckVerdict::NeedsNudge,
                contract_id,
                reason: "心跳停止超过半程 → 催促 (nudge)".into(),
            };
        }
    }
    // 剩余时间不足 20% 且未交 → 提醒
    if (elapsed as f64) / (timeout as f64) >= input.nudge_ratio && !d.nudged {
        return DispatchCheck {
            verdict: CheckVerdict::NeedsNudge,
            contract_id,
            reason: format!("已用 {:.0}% 时限未回 → 提醒", (elapsed as f64 / timeout as f64) * 100.0),
        };
    }
    DispatchCheck {
        verdict: CheckVerdict::OnTrack,
        contract_id,
        reason: "在途正常".into(),
    }
}

/// 派送检查台 (父视角)
#[derive(Debug, Default)]
pub struct DispatchBoard {
    pub inflight: Vec<Dispatch>,
    /// 回收记录 (timed_out 的去向: redispawn | escalated)
    pub recovered: Vec<(String, &'static str)>,
}

impl DispatchBoard {
    pub fn dispatch(&mut self, contract: AgentWorkContract, now_ms: u64) {
        self.inflight.push(Dispatch {
            contract,
            last_heartbeat_ms: None,
            last_progress: None,
            blocked: false,
            nudged: false,
            dispatched_at_ms: now_ms,
        });
    }

    /// 子端心跳 (更新)
    pub fn heartbeat(&mut self, contract_id: &str, now_ms: u64, progress: Option<String>) -> bool {
        let Some(d) = self.inflight.iter_mut().find(|d| d.contract.contract_id == contract_id) else {
            return false;
        };
        d.last_heartbeat_ms = Some(now_ms);
        if let Some(p) = progress {
            d.last_progress = Some(p);
        }
        true
    }

    /// 子上报阻塞
    pub fn report_blocked(&mut self, contract_id: &str) -> bool {
        let Some(d) = self.inflight.iter_mut().find(|d| d.contract.contract_id == contract_id) else {
            return false;
        };
        d.blocked = true;
        true
    }

    /// 巡检全部在途 (返回检查结论; TimedOut 的同时回收)
    pub fn check_all(&mut self, input: &CheckInput) -> Vec<DispatchCheck> {
        let mut out = Vec::new();
        let mut recovered_ids = Vec::new();
        let mut nudged_ids = Vec::new();
        for d in &self.inflight {
            let c = check_dispatch(d, input);
            if c.verdict == CheckVerdict::TimedOut {
                recovered_ids.push(d.contract.contract_id.clone());
            }
            if c.verdict == CheckVerdict::NeedsNudge {
                nudged_ids.push(c.contract_id.clone());
            }
            out.push(c);
        }
        for id in &nudged_ids {
            if let Some(dd) = self.inflight.iter_mut().find(|x| &x.contract.contract_id == id) {
                dd.nudged = true;
            }
        }
        for id in recovered_ids {
            self.inflight.retain(|d| &d.contract.contract_id != &id);
            self.recovered.push((id, "escalated"));
        }
        out
    }

    /// 收到终报 (从在途移除; done 与否由 validate_report 定)
    pub fn settle(&mut self, contract_id: &str, status: ReportStatus) -> bool {
        let before = self.inflight.len();
        self.inflight.retain(|d| d.contract.contract_id != contract_id);
        if self.inflight.len() < before {
            let dest = match status {
                ReportStatus::Done => "completed",
                ReportStatus::Partial => "partial",
                ReportStatus::Failed => "failed",
                ReportStatus::Blocked => "blocked_escalated",
            };
            self.recovered.push((contract_id.into(), dest));
            return true;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract(timeout_ms: u64) -> AgentWorkContract {
        AgentWorkContract {
            contract_id: "c-1".into(),
            parent_run_id: "r".into(),
            task: "调研".into(),
            acceptance_criteria: vec![],
            budget_atomic: 100,
            timeout_ms,
            forbidden: vec![],
            created_at_ms: 0,
        }
    }

    fn input(now: u64, timeout: u64) -> CheckInput {
        CheckInput { now_ms: now, global_timeout_ms: timeout, nudge_ratio: 0.8 }
    }

    #[test]
    fn on_track_early() {
        let d = Dispatch {
            contract: contract(60_000),
            last_heartbeat_ms: Some(1000),
            last_progress: Some("进行中".into()),
            blocked: false,
            nudged: false,
            dispatched_at_ms: 0,
        };
        let c = check_dispatch(&d, &input(5000, 60_000));
        assert_eq!(c.verdict, CheckVerdict::OnTrack);
    }

    #[test]
    fn blocked_escalates_first() {
        let mut d = Dispatch {
            contract: contract(60_000),
            last_heartbeat_ms: None,
            last_progress: None,
            blocked: true,
            nudged: false,
            dispatched_at_ms: 0,
        };
        d.blocked = true;
        let c = check_dispatch(&d, &input(1000, 60_000));
        assert_eq!(c.verdict, CheckVerdict::Blocked, "阻塞优先于一切");
    }

    #[test]
    fn timeout_recovers() {
        let mut board = DispatchBoard::default();
        board.dispatch(contract(1000), 0);
        let checks = board.check_all(&input(2000, 1000));
        assert!(checks.iter().any(|c| c.verdict == CheckVerdict::TimedOut));
        assert_eq!(board.inflight.len(), 0, "超时的从在途移除");
        assert_eq!(board.recovered[0].1, "escalated");
    }

    #[test]
    fn nudge_at_ratio_then_once() {
        let mut board = DispatchBoard::default();
        board.dispatch(contract(10_000), 0);
        // 85% 时限 → nudge
        let checks = board.check_all(&input(8500, 10_000));
        assert!(checks.iter().any(|c| c.verdict == CheckVerdict::NeedsNudge));
        // 已标 nudged → 再巡检不重复 (nudged=true 时该分支跳过)
        let checks2 = board.check_all(&input(8600, 10_000));
        assert!(checks2.iter().all(|c| c.verdict != CheckVerdict::NeedsNudge), "nudge 一次后不重复催");
    }

    #[test]
    fn heartbeat_stall_nudges() {
        let mut board = DispatchBoard::default();
        board.dispatch(contract(10_000), 0);
        board.heartbeat("c-1", 1000, Some("一半了".into()));
        // 心跳停在 1000, 现在 6500 → 差 5500 > 半程 5000 → nudge
        let checks = board.check_all(&input(6500, 10_000));
        assert!(checks.iter().any(|c| c.verdict == CheckVerdict::NeedsNudge && c.reason.contains("心跳")));
    }

    #[test]
    fn settle_on_report() {
        let mut board = DispatchBoard::default();
        board.dispatch(contract(10_000), 0);
        assert!(board.settle("c-1", ReportStatus::Done));
        assert_eq!(board.inflight.len(), 0);
        assert_eq!(board.recovered[0].1, "completed");
        assert!(!board.settle("c-1", ReportStatus::Done), "重复 settle false");
    }
}
