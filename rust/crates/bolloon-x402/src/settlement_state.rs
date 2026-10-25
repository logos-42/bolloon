//! 交易两层状态协议 — 生命周期 ⊗ 结算事实
//!
//! 对齐 TS 版 `settlement-state.ts` (状态机逐态一致):
//! - 结算事实 8 态, 写路径拒绝非法迁移 (迁移表冻结)
//! - derive: 从记录推导事实 (local-dev 联调最高只认"提交过(模拟)")
//! - 链上背书事实: payment_verified / partially_settled / fully_settled
//! - 责任候选: 机器只给候选, 不做最终赔偿判决

use serde::{Deserialize, Serialize};

/// 结算事实 (8 态, 顺序即迁移表键)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettlementFact {
    Unpaid,
    PaymentSubmitted,
    PaymentVerified,
    PartiallySettled,
    FullySettled,
    RefundPending,
    Refunded,
    Unknown,
}

impl SettlementFact {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unpaid => "unpaid",
            Self::PaymentSubmitted => "payment_submitted",
            Self::PaymentVerified => "payment_verified",
            Self::PartiallySettled => "partially_settled",
            Self::FullySettled => "fully_settled",
            Self::RefundPending => "refund_pending",
            Self::Refunded => "refunded",
            Self::Unknown => "unknown",
        }
    }

    /// as_str 的逆: 从持久化/跨进程串还原事实 (未知串 → None, 不猜最接近的)
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "unpaid" => Self::Unpaid,
            "payment_submitted" => Self::PaymentSubmitted,
            "payment_verified" => Self::PaymentVerified,
            "partially_settled" => Self::PartiallySettled,
            "fully_settled" => Self::FullySettled,
            "refund_pending" => Self::RefundPending,
            "refunded" => Self::Refunded,
            "unknown" => Self::Unknown,
            _ => return None,
        })
    }

    /// 只有真链上/facilitator 确认过的结算事实
    pub fn is_chain_backed(&self) -> bool {
        matches!(
            self,
            Self::PaymentVerified | Self::PartiallySettled | Self::FullySettled
        )
    }
}

/// 迁移表 (冻结, 对齐 TS SETTLEMENT_TRANSITIONS)
pub fn allowed_transitions(from: SettlementFact) -> &'static [SettlementFact] {
    match from {
        SettlementFact::Unpaid => &[SettlementFact::PaymentSubmitted, SettlementFact::Unknown],
        SettlementFact::PaymentSubmitted => &[
            SettlementFact::PaymentVerified,
            SettlementFact::PartiallySettled,
            SettlementFact::Unpaid,
            SettlementFact::Unknown,
        ],
        SettlementFact::PaymentVerified => &[
            SettlementFact::FullySettled,
            SettlementFact::PartiallySettled,
            SettlementFact::RefundPending,
            SettlementFact::Unknown,
        ],
        SettlementFact::PartiallySettled => &[
            SettlementFact::FullySettled,
            SettlementFact::RefundPending,
            SettlementFact::Unknown,
        ],
        SettlementFact::FullySettled => &[SettlementFact::RefundPending],
        SettlementFact::RefundPending => &[SettlementFact::Refunded, SettlementFact::FullySettled],
        SettlementFact::Refunded => &[],
        SettlementFact::Unknown => &[
            SettlementFact::Unpaid,
            SettlementFact::PaymentSubmitted,
            SettlementFact::PaymentVerified,
            SettlementFact::PartiallySettled,
            SettlementFact::FullySettled,
            SettlementFact::RefundPending,
        ],
    }
}

/// 迁移错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SettlementError {
    #[error("非法迁移: {from:?} → {to:?} (写路径拒绝, 不静默改写)")]
    IllegalTransition {
        from: SettlementFact,
        to: SettlementFact,
    },
}

/// 写路径: 校验迁移合法, 不合法即拒 (不静默改写)
pub fn transition(from: SettlementFact, to: SettlementFact) -> Result<SettlementFact, SettlementError> {
    if allowed_transitions(from).contains(&to) {
        Ok(to)
    } else {
        Err(SettlementError::IllegalTransition { from, to })
    }
}

/// 推导输入 (交易记录的结算相关字段)
#[derive(Debug, Clone, Default)]
pub struct TxRecordInput {
    pub status: String,
    pub payment_mode: Option<String>,
    pub chain_settled: Option<bool>,
    pub tx_hash: Option<String>,
    pub payment_receipt: Option<String>,
}

/// 推导结算事实 (对齐 TS deriveSettlementFact)
pub fn derive_settlement_fact(rec: &TxRecordInput) -> SettlementFact {
    let paid = matches!(
        rec.status.as_str(),
        "paying" | "settled" | "delivered" | "verified" | "delivery_failed" | "verification_failed"
    );
    if rec.payment_mode.as_deref() == Some("local-dev") {
        // 联调: 有付款动作 → 最高只认"提交过(模拟)"; 没有 → 未付
        return if paid && (rec.payment_receipt.is_some() || rec.tx_hash.is_some()) {
            SettlementFact::PaymentSubmitted // LOCAL_DEV_MAX_FACT
        } else if paid {
            SettlementFact::Unknown
        } else {
            SettlementFact::Unpaid
        };
    }
    if rec.chain_settled == Some(true) {
        return if rec.status == "verified" {
            SettlementFact::FullySettled
        } else {
            SettlementFact::PaymentVerified
        };
    }
    if rec.tx_hash.is_some() || rec.payment_receipt.is_some() {
        return SettlementFact::PaymentSubmitted;
    }
    if rec.status == "paying" {
        return SettlementFact::Unknown; // 付没付不知道 → 先对账
    }
    SettlementFact::Unpaid
}

/// 责任候选 (机器只给候选, 不做最终赔偿判决)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponsibilityType {
    ProviderFault,
    BuyerFault,
    AgentFault,
    PlatformFault,
    PaymentInfrastructureFault,
    Undetermined,
}

pub const RESPONSIBILITY_TYPES: &[ResponsibilityType] = &[
    ResponsibilityType::ProviderFault,
    ResponsibilityType::BuyerFault,
    ResponsibilityType::AgentFault,
    ResponsibilityType::PlatformFault,
    ResponsibilityType::PaymentInfrastructureFault,
    ResponsibilityType::Undetermined,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fact_str_roundtrip() {
        // 8 态全量: as_str → parse 必须还原 (持久化/跨进程靠这条)
        for f in [
            SettlementFact::Unpaid,
            SettlementFact::PaymentSubmitted,
            SettlementFact::PaymentVerified,
            SettlementFact::PartiallySettled,
            SettlementFact::FullySettled,
            SettlementFact::RefundPending,
            SettlementFact::Refunded,
            SettlementFact::Unknown,
        ] {
            assert_eq!(SettlementFact::parse(f.as_str()), Some(f), "{f:?} 串化后可还原");
        }
        assert_eq!(SettlementFact::parse("paid"), None, "未知串 → None, 不猜最接近的");
    }

    #[test]
    fn legal_transitions_pass() {
        assert_eq!(transition(SettlementFact::Unpaid, SettlementFact::PaymentSubmitted), Ok(SettlementFact::PaymentSubmitted));
        assert_eq!(
            transition(SettlementFact::PaymentSubmitted, SettlementFact::PaymentVerified),
            Ok(SettlementFact::PaymentVerified)
        );
        assert_eq!(
            transition(SettlementFact::Unknown, SettlementFact::PaymentVerified),
            Ok(SettlementFact::PaymentVerified),
            "unknown 可到多数态 (先对账后定)"
        );
    }

    #[test]
    fn illegal_transitions_rejected() {
        // 付都没付 → 直接 fully_settled: 拒
        assert_eq!(
            transition(SettlementFact::Unpaid, SettlementFact::FullySettled),
            Err(SettlementError::IllegalTransition {
                from: SettlementFact::Unpaid,
                to: SettlementFact::FullySettled,
            })
        );
        // refunded 是终态, 不可再迁移
        assert!(transition(SettlementFact::Refunded, SettlementFact::Unpaid).is_err());
        // unpaid 不可直接跳 payment_verified
        assert!(transition(SettlementFact::Unpaid, SettlementFact::PaymentVerified).is_err());
    }

    #[test]
    fn derive_chain_settled() {
        let rec = TxRecordInput {
            status: "verified".into(),
            chain_settled: Some(true),
            ..Default::default()
        };
        assert_eq!(derive_settlement_fact(&rec), SettlementFact::FullySettled);
        let rec2 = TxRecordInput {
            status: "settled".into(),
            chain_settled: Some(true),
            ..Default::default()
        };
        assert_eq!(derive_settlement_fact(&rec2), SettlementFact::PaymentVerified);
    }

    #[test]
    fn derive_local_dev_caps_at_submitted() {
        let rec = TxRecordInput {
            status: "settled".into(),
            payment_mode: Some("local-dev".into()),
            payment_receipt: Some("r".into()),
            ..Default::default()
        };
        assert_eq!(
            derive_settlement_fact(&rec),
            SettlementFact::PaymentSubmitted,
            "联调最高只认提交过(模拟), 不冒充链上"
        );
        let rec2 = TxRecordInput {
            status: "settled".into(),
            payment_mode: Some("local-dev".into()),
            ..Default::default()
        };
        assert_eq!(derive_settlement_fact(&rec2), SettlementFact::Unknown);
    }

    #[test]
    fn derive_paying_no_evidence_is_unknown() {
        let rec = TxRecordInput { status: "paying".into(), ..Default::default() };
        assert_eq!(derive_settlement_fact(&rec), SettlementFact::Unknown, "付没付不知道 → 先对账");
    }

    #[test]
    fn derive_txhash_is_submitted() {
        let rec = TxRecordInput { status: "quoted".into(), tx_hash: Some("0xabc".into()), ..Default::default() };
        assert_eq!(derive_settlement_fact(&rec), SettlementFact::PaymentSubmitted);
    }

    #[test]
    fn chain_backed_facts_only() {
        assert!(SettlementFact::PaymentVerified.is_chain_backed());
        assert!(SettlementFact::FullySettled.is_chain_backed());
        assert!(!SettlementFact::PaymentSubmitted.is_chain_backed(), "提交过 ≠ 链上确认");
        assert!(!SettlementFact::Unpaid.is_chain_backed());
    }

    #[test]
    fn responsibility_types_frozen() {
        assert_eq!(RESPONSIBILITY_TYPES.len(), 6);
        assert!(RESPONSIBILITY_TYPES.contains(&ResponsibilityType::Undetermined));
    }
}
