//! 支付中断恢复 — 决策纯函数 (唯一决策点)
//!
//! 对齐 TS 版 `payment-recovery.ts`:
//! 五个 SIGKILL 时点 (恢复后必须各自走对路), 决策输出 7 动作;
//! **有支付证据或结算事实非 unpaid ⇒ mustNotRepay** (0 重复付款是硬验收);
//! Supervisor / CLI / 恢复脚本都走它, 不许各自 if-else。

use serde::{Deserialize, Serialize};

use crate::settlement_state::{derive_settlement_fact, SettlementFact, TxRecordInput};

/// 恢复动作 (7 类)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryAction {
    /// 明确没付过 → 可以安全重试
    RetryPayment,
    /// 付没付不知道 → 先对账 (绝不重付)
    Reconcile,
    /// 已付款 → 继续交付
    Deliver,
    /// 已交付 → 继续验真
    Verify,
    /// 已 verified → 无事可做
    Complete,
    /// 终态 (失败/拒绝/纠纷) → 不重付, 交人/追责
    Closed,
    /// 有别的 worker 正持有付款权 → 等, 不动手
    Wait,
}

/// 恢复计划 (决策输出)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RecoveryPlan {
    pub transaction_id: String,
    pub action: RecoveryAction,
    /// **绝对不能重新付款** (有支付证据或结算事实非 unpaid)
    pub must_not_repay: bool,
    /// 结算事实 (决策依据, 审计要用)
    pub settlement_fact: SettlementFact,
    /// 是不是"付过钱但没交付"这类要追责的情形
    pub needs_responsibility: bool,
    pub reason: String,
}

/// 只有这些状态才允许自动重试付款
const RETRYABLE_STATUSES: &[&str] = &["quoted", "payment_required"];

/// 决策输入 (交易记录)
#[derive(Debug, Clone, Default)]
pub struct TransactionRecord {
    pub transaction_id: String,
    pub status: String,
    pub payment_mode: Option<String>,
    pub chain_settled: Option<bool>,
    pub tx_hash: Option<String>,
    pub payment_receipt: Option<String>,
}

impl TransactionRecord {
    fn as_input(&self) -> TxRecordInput {
        TxRecordInput {
            status: self.status.clone(),
            payment_mode: self.payment_mode.clone(),
            chain_settled: self.chain_settled,
            tx_hash: self.tx_hash.clone(),
            payment_receipt: self.payment_receipt.clone(),
        }
    }

    fn has_payment_evidence(&self, fact: SettlementFact) -> bool {
        self.tx_hash.is_some() || self.payment_receipt.is_some() || fact.is_chain_backed()
    }
}

/// 恢复决策 (纯函数, 对齐 TS planTransactionRecovery 的优先级顺序)
pub fn plan_transaction_recovery(rec: &TransactionRecord, claim_held_by_other: bool) -> RecoveryPlan {
    let fact = derive_settlement_fact(&rec.as_input());
    let evidence = rec.has_payment_evidence(fact);
    let base = (rec.transaction_id.clone(), fact);
    let plan = |action: RecoveryAction, must_not_repay: bool, needs_responsibility: bool, reason: String| RecoveryPlan {
        transaction_id: base.0.clone(),
        action,
        must_not_repay,
        settlement_fact: base.1,
        needs_responsibility,
        reason,
    };

    // 终态: 不再动手 (钱的事已经定了)
    if matches!(rec.status.as_str(), "verified" | "policy_denied" | "failed") {
        return plan(
            if rec.status == "verified" { RecoveryAction::Complete } else { RecoveryAction::Closed },
            evidence,
            false,
            format!("终态 {}, 不再变化", rec.status),
        );
    }
    if matches!(rec.status.as_str(), "delivery_failed" | "verification_failed") {
        return plan(
            RecoveryAction::Closed,
            true,
            true,
            format!(
                "{}: 钱 {} 但交付/验真失败 → 不自动重付, 进追责/人工处理",
                rec.status,
                if fact == SettlementFact::Unpaid { "可能没付" } else { "已付/待确认" }
            ),
        );
    }

    // 有别的 worker 拿着付款权 → 等
    if claim_held_by_other {
        return plan(
            RecoveryAction::Wait,
            true,
            false,
            "付款权被另一个进程持有 → 复用同一交易, 等它走完".into(),
        );
    }

    // 支付状态未知 → 先对账
    if fact == SettlementFact::Unknown || (rec.status == "paying" && !evidence) {
        if !evidence && rec.status == "paying" {
            return plan(
                RecoveryAction::Reconcile,
                false,
                false,
                "付款中但没有任何支付凭据 → 先对账确认(可安全重试)".into(),
            );
        }
        return plan(
            RecoveryAction::Reconcile,
            true,
            false,
            format!("结算事实 {} → 先对账, 绝不自动重付", fact.as_str()),
        );
    }

    // 明确没付过 + 还没走完 → 可以安全付款
    if !evidence && RETRYABLE_STATUSES.contains(&rec.status.as_str()) {
        return plan(
            RecoveryAction::RetryPayment,
            false,
            false,
            format!("状态 {} 且结算事实 unpaid (确认没付过) → 可安全付款", rec.status),
        );
    }

    // 有支付证据 → 继续推进交付/验真, 绝不重付
    if evidence {
        if rec.status == "delivered" {
            return plan(RecoveryAction::Verify, true, false, "已交付 → 继续验真".into());
        }
        if matches!(rec.status.as_str(), "paying" | "settled" | "payment_required") {
            return plan(
                RecoveryAction::Deliver,
                true,
                false,
                format!("结算事实 {} → 付款事实在手, 继续交付 (不重付)", fact.as_str()),
            );
        }
    }

    plan(
        RecoveryAction::Closed,
        evidence,
        false,
        format!("状态 {} + 结算事实 {}: 没有可自动推进的动作 → 交人", rec.status, fact.as_str()),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(status: &str) -> TransactionRecord {
        TransactionRecord {
            transaction_id: "tx-1".into(),
            status: status.into(),
            ..Default::default()
        }
    }

    /// 核心验收: 0 重复付款 — 任何有支付证据的路径 mustNotRepay
    #[test]
    fn with_evidence_never_repay() {
        for status in ["paying", "settled", "delivered", "payment_required"] {
            let mut r = rec(status);
            r.tx_hash = Some("0xabc".into());
            let p = plan_transaction_recovery(&r, false);
            assert!(
                p.action != RecoveryAction::RetryPayment && p.must_not_repay,
                "status={status} 有证据还让重付?! plan={p:?}"
            );
        }
    }

    /// SIGKILL 时点 1: 报价后未付款 → retry_payment
    #[test]
    fn kill_after_quote_retries_safely() {
        let p = plan_transaction_recovery(&rec("quoted"), false);
        assert_eq!(p.action, RecoveryAction::RetryPayment);
        assert!(!p.must_not_repay, "确认没付过才允许重试");
    }

    /// SIGKILL 时点 2: 付款中无凭据 → reconcile (可安全重试)
    #[test]
    fn kill_while_paying_no_evidence_reconciles() {
        let p = plan_transaction_recovery(&rec("paying"), false);
        assert_eq!(p.action, RecoveryAction::Reconcile);
        assert!(!p.must_not_repay, "无凭据 = 没真发出去, 对账后可重试");
    }

    /// SIGKILL 时点 3: 付款中有 txHash → deliver 不重付
    #[test]
    fn kill_while_paying_with_tx_delivers() {
        let mut r = rec("paying");
        r.tx_hash = Some("0xabc".into());
        let p = plan_transaction_recovery(&r, false);
        assert_eq!(p.action, RecoveryAction::Deliver);
        assert!(p.must_not_repay);
    }

    /// SIGKILL 时点 4: 交付后 → verify
    #[test]
    fn kill_after_delivery_verifies() {
        let mut r = rec("delivered");
        r.payment_receipt = Some("r1".into());
        let p = plan_transaction_recovery(&r, false);
        assert_eq!(p.action, RecoveryAction::Verify);
        assert!(p.must_not_repay);
    }

    /// SIGKILL 时点 5: verified → complete
    #[test]
    fn kill_after_verified_completes() {
        let p = plan_transaction_recovery(&rec("verified"), false);
        assert_eq!(p.action, RecoveryAction::Complete);
    }

    #[test]
    fn claim_held_by_other_waits() {
        let mut r = rec("payment_required");
        r.tx_hash = Some("0xabc".into());
        let p = plan_transaction_recovery(&r, true);
        assert_eq!(p.action, RecoveryAction::Wait);
        assert!(p.must_not_repay, "等待时绝不另起付款");
    }

    #[test]
    fn delivery_failed_goes_to_responsibility() {
        let mut r = rec("delivery_failed");
        r.tx_hash = Some("0xabc".into());
        let p = plan_transaction_recovery(&r, false);
        assert_eq!(p.action, RecoveryAction::Closed);
        assert!(p.must_not_repay);
        assert!(p.needs_responsibility, "付了钱没交付 = 追责候选");
    }

    #[test]
    fn terminal_states_frozen() {
        assert_eq!(plan_transaction_recovery(&rec("policy_denied"), false).action, RecoveryAction::Closed);
        assert_eq!(plan_transaction_recovery(&rec("failed"), false).action, RecoveryAction::Closed);
    }

    #[test]
    fn unknown_fact_reconciles_not_retries() {
        let p = plan_transaction_recovery(&rec("paying"), false);
        assert_eq!(p.action, RecoveryAction::Reconcile);
        assert_eq!(p.settlement_fact, SettlementFact::Unknown);
    }
}
