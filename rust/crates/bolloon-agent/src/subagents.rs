//! 子智能体 — 工作合同 + 派遣/汇报 (隔离上下文, 只回摘要)
//!
//! 对齐 TS 版 goal-flywheel P2 `AgentWorkContract` + subagent-manager:
//! - 合同 16 字段语义的 Rust 子集: 任务/验收判据/预算/超时/禁项
//! - **隔离上下文 + 仅返回摘要** (子智能体 token 开销 ~7x, 只回 summary+evidence)
//! - 5 条子禁项: 子不许改判据/扩预算/自行结束父目标/伪造证据/越权工具
//! - 汇报校验: 无证据的漂亮回报 → 父不完成 (强负例)

use serde::{Deserialize, Serialize};

/// 工作合同
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentWorkContract {
    pub contract_id: String,
    /// 父 goal/run
    pub parent_run_id: String,
    /// 子任务描述
    pub task: String,
    /// 验收判据 (可多条, 子汇报必须逐条对应)
    pub acceptance_criteria: Vec<String>,
    /// 预算 (原子单位)
    pub budget_atomic: u128,
    /// 超时 ms
    pub timeout_ms: u64,
    /// 禁项 (子不许做的事)
    pub forbidden: Vec<String>,
    pub created_at_ms: u64,
}

/// 子汇报
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentWorkReport {
    pub contract_id: String,
    /// done | partial | failed | blocked
    pub status: ReportStatus,
    /// 摘要 (隔离上下文: 父只看这个)
    pub summary: String,
    /// 证据 (证据 id/引用; 空证据 = 漂亮回报, 父不完成)
    pub evidence_refs: Vec<String>,
    /// 产物引用
    pub artifacts: Vec<String>,
    /// 未决项
    pub unresolved: Vec<String>,
    /// 耗时 ms
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Done,
    Partial,
    Failed,
    Blocked,
}

/// 汇报校验错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ReportError {
    #[error("无证据的漂亮回报 → 父不完成 (强负例)")]
    NoEvidence,
    #[error("合同不存在")]
    ContractNotFound,
    #[error("验收判据 {0} 无对应证据")]
    CriterionUnmet(String),
}

/// 父侧校验子汇报 (纯函数): status=done 必须有证据 + 判据可对
pub fn validate_report(
    contract: &AgentWorkContract,
    report: &AgentWorkReport,
) -> Result<(), ReportError> {
    if contract.contract_id != report.contract_id {
        return Err(ReportError::ContractNotFound);
    }
    if report.status == ReportStatus::Done {
        if report.evidence_refs.is_empty() {
            return Err(ReportError::NoEvidence);
        }
        // 判据覆盖: 每条判据至少要有一份证据引用含其关键词 (或证据数 ≥ 判据数)
        if report.evidence_refs.len() < contract.acceptance_criteria.len() {
            return Err(ReportError::CriterionUnmet(
                contract.acceptance_criteria[report.evidence_refs.len()].clone(),
            ));
        }
    }
    Ok(())
}

/// 子禁项 (5 条, 冻结)
pub const CHILD_FORBIDDEN: &[&str] = &[
    "改判据 (acceptance_criteria 只能父改)",
    "扩预算 (budget 只能父调)",
    "自行结束父 goal",
    "伪造证据 (evidence 引用必须可回查)",
    "越权工具 (合同未授权的工具不许用)",
];

/// 子智能体调度台 (父视角)
#[derive(Debug, Default)]
pub struct SubagentBoard {
    contracts: Vec<AgentWorkContract>,
    reports: Vec<AgentWorkReport>,
    next_id: u64,
}

impl SubagentBoard {
    pub fn new() -> Self {
        Self::default()
    }

    /// 派遣 (生成合同; 子拿到的是隔离上下文, 只含合同)
    pub fn dispatch(
        &mut self,
        parent_run_id: &str,
        task: &str,
        acceptance_criteria: Vec<String>,
        budget_atomic: u128,
        timeout_ms: u64,
        now_ms: u64,
    ) -> &AgentWorkContract {
        self.next_id += 1;
        let contract = AgentWorkContract {
            contract_id: format!("c-{0:04}", self.next_id),
            parent_run_id: parent_run_id.into(),
            task: task.into(),
            acceptance_criteria,
            budget_atomic,
            timeout_ms,
            forbidden: CHILD_FORBIDDEN.iter().map(|s| s.to_string()).collect(),
            created_at_ms: now_ms,
        };
        self.contracts.push(contract);
        self.contracts.last().unwrap()
    }

    /// 收汇报 (校验不过拒收)
    pub fn receive(&mut self, report: AgentWorkReport) -> Result<(), ReportError> {
        let contract = self
            .contracts
            .iter()
            .find(|c| c.contract_id == report.contract_id)
            .ok_or(ReportError::ContractNotFound)?
            .clone();
        validate_report(&contract, &report)?;
        self.reports.push(report);
        Ok(())
    }

    /// 父能否基于子汇报完成 (强负例: 无证据不完成)
    pub fn can_complete_from(&self, contract_id: &str) -> bool {
        self.reports
            .iter()
            .any(|r| r.contract_id == contract_id && r.status == ReportStatus::Done)
    }

    pub fn contract_count(&self) -> usize {
        self.contracts.len()
    }

    pub fn report_count(&self) -> usize {
        self.reports.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> AgentWorkContract {
        AgentWorkContract {
            contract_id: "c-0001".into(),
            parent_run_id: "run-1".into(),
            task: "调研核聚变口径".into(),
            acceptance_criteria: vec!["给出来源列表".into(), "给出结论".into()],
            budget_atomic: 1000,
            timeout_ms: 60_000,
            forbidden: CHILD_FORBIDDEN.iter().map(|s| s.to_string()).collect(),
            created_at_ms: 0,
        }
    }

    fn report(status: ReportStatus, evidence: Vec<String>) -> AgentWorkReport {
        AgentWorkReport {
            contract_id: "c-0001".into(),
            status,
            summary: "做完了".into(),
            evidence_refs: evidence,
            artifacts: vec![],
            unresolved: vec![],
            duration_ms: 100,
        }
    }

    #[test]
    fn done_without_evidence_rejected() {
        let c = contract();
        let r = report(ReportStatus::Done, vec![]);
        assert_eq!(validate_report(&c, &r).unwrap_err(), ReportError::NoEvidence, "强负例: 漂亮回报不完成");
    }

    #[test]
    fn done_with_enough_evidence_passes() {
        let c = contract();
        let r = report(ReportStatus::Done, vec!["ev-1".into(), "ev-2".into()]);
        assert!(validate_report(&c, &r).is_ok());
    }

    #[test]
    fn done_with_fewer_evidence_than_criteria_rejected() {
        let c = contract();
        let r = report(ReportStatus::Done, vec!["ev-1".into()]);
        assert!(matches!(validate_report(&c, &r), Err(ReportError::CriterionUnmet(_))));
    }

    #[test]
    fn partial_needs_no_evidence() {
        let c = contract();
        let r = report(ReportStatus::Partial, vec![]);
        assert!(validate_report(&c, &r).is_ok(), "partial 如实报, 不冒充 done");
    }

    #[test]
    fn board_rejects_and_accepts() {
        let mut board = SubagentBoard::new();
        board.dispatch("run-1", "调研", vec!["来源".into(), "结论".into()], 1000, 60_000, 1);
        assert!(!board.can_complete_from("c-0001"));
        // 无证据 → 拒收
        assert!(board.receive(report(ReportStatus::Done, vec![])).is_err());
        assert!(!board.can_complete_from("c-0001"), "拒收后父不可完成");
        // 有证据 → 收
        assert!(board.receive(report(ReportStatus::Done, vec!["e1".into(), "e2".into()])).is_ok());
        assert!(board.can_complete_from("c-0001"));
    }

    #[test]
    fn child_forbidden_frozen() {
        assert_eq!(CHILD_FORBIDDEN.len(), 5, "5 条子禁项");
        assert!(CHILD_FORBIDDEN.iter().any(|s| s.contains("改判据")));
        assert!(CHILD_FORBIDDEN.iter().any(|s| s.contains("扩预算")));
        assert!(CHILD_FORBIDDEN.iter().any(|s| s.contains("伪造证据")));
    }

    #[test]
    fn contract_carries_forbidden_list() {
        let mut board = SubagentBoard::new();
        let c = board.dispatch("r", "t", vec![], 1, 1, 0).clone();
        assert_eq!(c.forbidden.len(), 5, "合同带禁项, 子看得见边界");
    }

    #[test]
    fn isolated_context_semantics() {
        // 隔离上下文: 子只拿合同, 父只拿摘要+证据 (不强引用内部消息)
        let mut board = SubagentBoard::new();
        let c = board.dispatch("r", "t", vec!["x".into()], 1, 1, 0).clone();
        // 合同里没有任何父会话内容字段
        let json = serde_json::to_string(&c).unwrap();
        assert!(!json.contains("messageHistory"), "合同不带父会话历史");
        assert!(!json.contains("system_prompt"), "合同不带父 system");
    }
}
