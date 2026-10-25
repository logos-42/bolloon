//! 里程碑结算 — 分阶段服务按里程碑结算
//!
//! 对齐 TS 版 `milestone-settlement.ts`:
//! - 里程碑不变式: 金额必须是正整数原子单位 (不许浮点/负数/空); **总额必须等于交易金额** (账平)
//! - 聚合: 全部完成 → fully_settled; 有完成没全完成 → **partially_settled** (不算完成,
//!   也不进 Goal 成功证据); 任一交付/验真失败 → **进争议 (不许静默关闭)**
//! - apply 纯函数: 落盘由调用方做, 保证可测

use serde::{Deserialize, Serialize};

/// 里程碑
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransactionMilestone {
    pub milestone_id: String,
    pub title: String,
    /// 正整数原子单位字符串 (避免浮点)
    pub amount: String,
    pub payment_status: MilestonePaymentStatus,
    pub delivery_status: MilestoneDeliveryStatus,
    pub verification_status: MilestoneVerificationStatus,
    pub evidence: Vec<String>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MilestonePaymentStatus {
    Unpaid,
    Paid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneDeliveryStatus {
    Pending,
    Delivered,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MilestoneVerificationStatus {
    Pending,
    Verified,
    Failed,
}

/// 里程碑错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum MilestoneError {
    #[error("milestoneId 不能为空")]
    EmptyId,
    #[error("amount 必须是正整数原子单位字符串, 实际: {0}")]
    BadAmount(String),
    #[error("amount 必须大于 0")]
    ZeroAmount,
    #[error("里程碑金额合计 {sum} ≠ 交易金额 {expected}")]
    AmountMismatch { sum: String, expected: String },
    #[error("没有这个里程碑: {0}")]
    NotFound(String),
}

/// 校验里程碑规格 (不变式)
pub fn validate_milestone_spec(milestone_id: &str, amount: &str) -> Result<(), MilestoneError> {
    if milestone_id.is_empty() {
        return Err(MilestoneError::EmptyId);
    }
    if amount.is_empty() || !amount.chars().all(|c| c.is_ascii_digit()) {
        return Err(MilestoneError::BadAmount(amount.to_string()));
    }
    if amount.parse::<u128>().unwrap_or(0) == 0 {
        return Err(MilestoneError::ZeroAmount);
    }
    Ok(())
}

/// 建里程碑 (默认 unpaid/pending/pending)
pub fn make_milestone(milestone_id: &str, title: &str, amount: &str, now_ms: u64) -> Result<TransactionMilestone, MilestoneError> {
    validate_milestone_spec(milestone_id, amount)?;
    Ok(TransactionMilestone {
        milestone_id: milestone_id.into(),
        title: title.into(),
        amount: amount.into(),
        payment_status: MilestonePaymentStatus::Unpaid,
        delivery_status: MilestoneDeliveryStatus::Pending,
        verification_status: MilestoneVerificationStatus::Pending,
        evidence: vec![],
        updated_at_ms: now_ms,
    })
}

/// 里程碑总额必须等于交易金额 (否则就是账不平)
pub fn milestones_match_amount(ms: &[TransactionMilestone], tx_amount: Option<&str>) -> Result<String, MilestoneError> {
    let sum: u128 = ms.iter().map(|m| m.amount.parse::<u128>().unwrap_or(0)).sum();
    let sum_str = sum.to_string();
    if let Some(expected) = tx_amount {
        if expected != sum_str {
            return Err(MilestoneError::AmountMismatch {
                sum: sum_str,
                expected: expected.into(),
            });
        }
    }
    Ok(sum_str)
}

/// 聚合结论
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MilestoneAggregate {
    pub total: usize,
    pub paid: usize,
    pub delivered: usize,
    pub verified: usize,
    pub failed: usize,
    /// 全部里程碑都完成 (支付+交付+验真)
    pub all_complete: bool,
    /// 有完成但没全完成
    pub partially_complete: bool,
    pub next_milestone_id: Option<String>,
    pub settlement_fact: String,
    /// 任一里程碑交付失败 → 该进争议
    pub should_dispute: bool,
    pub reason: String,
}

/// 聚合 (纯函数, 对齐 TS aggregateMilestones)
pub fn aggregate_milestones(ms: &[TransactionMilestone]) -> MilestoneAggregate {
    let paid = ms.iter().filter(|m| m.payment_status == MilestonePaymentStatus::Paid).count();
    let delivered = ms.iter().filter(|m| m.delivery_status == MilestoneDeliveryStatus::Delivered).count();
    let verified = ms.iter().filter(|m| m.verification_status == MilestoneVerificationStatus::Verified).count();
    let failed = ms
        .iter()
        .filter(|m| {
            m.delivery_status == MilestoneDeliveryStatus::Failed
                || m.verification_status == MilestoneVerificationStatus::Failed
        })
        .count();
    let all_complete = !ms.is_empty() && verified == ms.len();
    let any_progress = paid > 0 || delivered > 0 || verified > 0;
    let partially_complete = any_progress && !all_complete && failed == 0;
    let next = ms
        .iter()
        .find(|m| m.verification_status != MilestoneVerificationStatus::Verified && m.delivery_status != MilestoneDeliveryStatus::Failed)
        .map(|m| m.milestone_id.clone());

    let settlement_fact = if all_complete {
        "fully_settled"
    } else if partially_complete {
        "partially_settled"
    } else if paid > 0 || delivered > 0 {
        "payment_submitted"
    } else {
        "unpaid"
    };

    let should_dispute = failed > 0;
    let reason = if should_dispute {
        format!("{failed} 个里程碑交付/验真失败 → 进争议 (不许静默关闭)")
    } else if all_complete {
        "全部里程碑支付+交付+验真完成".into()
    } else if partially_complete {
        format!("{verified}/{} 个里程碑完成 → partially_settled (不算完成, 也不进 Goal 成功证据)", ms.len())
    } else if ms.is_empty() {
        "没有里程碑 (单笔交易)".into()
    } else {
        "还没有里程碑完成".into()
    };

    MilestoneAggregate {
        total: ms.len(),
        paid,
        delivered,
        verified,
        failed,
        all_complete,
        partially_complete,
        next_milestone_id: next,
        settlement_fact: settlement_fact.into(),
        should_dispute,
        reason,
    }
}

/// 应用一个里程碑结果 (纯函数; 落盘由调用方做)
pub fn apply_milestone_result(
    ms: &[TransactionMilestone],
    milestone_id: &str,
    payment: Option<MilestonePaymentStatus>,
    delivery: Option<MilestoneDeliveryStatus>,
    verification: Option<MilestoneVerificationStatus>,
    evidence: &[String],
    now_ms: u64,
) -> Result<(Vec<TransactionMilestone>, MilestoneAggregate), MilestoneError> {
    let mut list = ms.to_vec();
    let Some(idx) = list.iter().position(|m| m.milestone_id == milestone_id) else {
        return Err(MilestoneError::NotFound(milestone_id.into()));
    };
    let target = &mut list[idx];
    if let Some(p) = payment {
        target.payment_status = p;
    }
    if let Some(d) = delivery {
        target.delivery_status = d;
    }
    if let Some(v) = verification {
        target.verification_status = v;
    }
    target.evidence.extend(evidence.iter().cloned());
    target.updated_at_ms = now_ms;
    let agg = aggregate_milestones(&list);
    Ok((list, agg))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms_pair() -> Vec<TransactionMilestone> {
        vec![
            make_milestone("m1", "阶段一: 调研", "5000", 1).unwrap(),
            make_milestone("m2", "阶段二: 交付", "5000", 1).unwrap(),
        ]
    }

    #[test]
    fn spec_validation() {
        assert!(validate_milestone_spec("m1", "5000").is_ok());
        assert_eq!(validate_milestone_spec("", "100").unwrap_err(), MilestoneError::EmptyId);
        assert!(matches!(validate_milestone_spec("m", "1.5"), Err(MilestoneError::BadAmount(_))), "浮点拒");
        assert!(matches!(validate_milestone_spec("m", "-5"), Err(MilestoneError::BadAmount(_))), "负数拒");
        assert_eq!(validate_milestone_spec("m", "0").unwrap_err(), MilestoneError::ZeroAmount);
    }

    #[test]
    fn amount_must_match_tx() {
        let ms = ms_pair();
        assert!(milestones_match_amount(&ms, Some("10000")).is_ok());
        assert_eq!(
            milestones_match_amount(&ms, Some("9999")).unwrap_err(),
            MilestoneError::AmountMismatch { sum: "10000".into(), expected: "9999".into() },
            "账不平必须拒"
        );
    }

    #[test]
    fn aggregate_all_complete_is_fully_settled() {
        let ms = ms_pair();
        let (ms, _) = apply_milestone_result(&ms, "m1", Some(MilestonePaymentStatus::Paid), Some(MilestoneDeliveryStatus::Delivered), Some(MilestoneVerificationStatus::Verified), &[], 2).unwrap();
        let (ms, agg) = apply_milestone_result(&ms, "m2", Some(MilestonePaymentStatus::Paid), Some(MilestoneDeliveryStatus::Delivered), Some(MilestoneVerificationStatus::Verified), &[], 3).unwrap();
        assert!(agg.all_complete);
        assert_eq!(agg.settlement_fact, "fully_settled");
        assert_eq!(ms.len(), 2);
    }

    #[test]
    fn partial_settlement_is_not_complete() {
        let ms = ms_pair();
        let (ms, _) = apply_milestone_result(&ms, "m1", Some(MilestonePaymentStatus::Paid), Some(MilestoneDeliveryStatus::Delivered), Some(MilestoneVerificationStatus::Verified), &[], 2).unwrap();
        let agg = aggregate_milestones(&ms);
        assert_eq!(agg.settlement_fact, "partially_settled");
        assert!(agg.partially_complete);
        assert!(!agg.all_complete, "partially_settled 不算完成");
        assert_eq!(agg.next_milestone_id.as_deref(), Some("m2"), "下一个待做里程碑");
    }

    #[test]
    fn failed_delivery_goes_to_dispute() {
        let ms = ms_pair();
        let (ms, _) = apply_milestone_result(&ms, "m1", Some(MilestonePaymentStatus::Paid), Some(MilestoneDeliveryStatus::Failed), None, &[], 2).unwrap();
        let agg = aggregate_milestones(&ms);
        assert!(agg.should_dispute, "交付失败 → 进争议 (不许静默关闭)");
        assert!(agg.reason.contains("争议"));
    }

    #[test]
    fn no_milestones_is_single_tx() {
        let agg = aggregate_milestones(&[]);
        assert_eq!(agg.settlement_fact, "unpaid");
        assert!(agg.reason.contains("单笔"));
    }

    #[test]
    fn apply_unknown_milestone_rejected() {
        let ms = ms_pair();
        assert_eq!(
            apply_milestone_result(&ms, "ghost", None, None, None, &[], 1).unwrap_err(),
            MilestoneError::NotFound("ghost".into())
        );
    }

    #[test]
    fn evidence_accumulates() {
        let ms = ms_pair();
        let (ms, _) = apply_milestone_result(&ms, "m1", None, None, None, &["ev-1".into()], 2).unwrap();
        let (ms, _) = apply_milestone_result(&ms, "m1", None, None, None, &["ev-2".into()], 3).unwrap();
        assert_eq!(ms[0].evidence, vec!["ev-1", "ev-2"], "证据累积, 不覆盖");
    }
}
