//! 去中心化直付 (`mode=direct`) 判定 — 买方自己发 USDC 到 payTo, 卖方只读链核验
//!
//! 对齐 TS 版 `direct-payment.ts` 的 **8 条核验判据** (缺一不算):
//! 1. chainId == 8453
//! 2. receipt.status == 1
//! 3. 日志有 USDC `Transfer` → to == payTo
//! 4. value(原子) >= accepts.amount
//! 5. confirmations >= 2
//! 6. ≥2 条不同 RPC 结论一致 (单条不算事实; 矛盾 ⇒ 不确定 ⇒ 不交付)
//! 7. txHash 未被别的 item 用过 (台账去重)
//! 8. 买方 ≠ payTo (不许自付自收)
//!
//! 本文件是**判定纯函数** (真 RPC 拉取由调用方注入), 任何路径都不动钱。

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::order_identity::{self, DecodedOrderNonce, OrderNonceShape};

/// 直付模式配置
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DirectPaymentConfig {
    pub chain_id: u64,
    /// USDC 合约 (Base 主网实测)
    pub usdc_contract: String,
    pub min_confirmations: u64,
    /// 至少几条 RPC 一致才算事实
    pub min_rpc_agreement: usize,
}

impl Default for DirectPaymentConfig {
    fn default() -> Self {
        Self {
            chain_id: 8453,
            usdc_contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".into(),
            min_confirmations: 2,
            min_rpc_agreement: 2,
        }
    }
}

/// 单条 RPC 的读链结论
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcObservation {
    /// RPC 端点标识 (如 "mainnet.base.org")
    pub rpc: String,
    /// receipt.status (1 = 成功)
    pub status: u64,
    /// Transfer 事件的 to 地址 (小写); 无 USDC Transfer = None
    pub transfer_to: Option<String>,
    /// Transfer value (原子单位)
    pub transfer_value_atomic: Option<u128>,
    /// AuthorizationUsed 事件的 nonce (0x…); 无 = None
    pub authorization_nonce: Option<String>,
    /// 确认数
    pub confirmations: u64,
}

/// 一条待核验的付款声明
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentClaim {
    /// 买方声明的 txHash (0x…)
    pub tx_hash: String,
    /// 卖方自己的收款地址 (payTo, 小写)
    pub pay_to: String,
    /// 卖方本店 item id
    pub item_id: String,
    /// 报价金额 (原子)
    pub expected_amount_atomic: u128,
    /// 买方地址 (0x…, 用于"不自付自收"检查)
    pub payer: Option<String>,
    /// 本次订单 seq (供 nonce 复算; 未知填 0)
    pub order_seq: u64,
}

/// 判定结论
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentVerdict {
    /// 8 条全过 (或含合法自证)
    Verified,
    /// nonce 复算命中本店 item = 自证 (仍然全过 8 条)
    SelfAttested,
    /// 有硬判据不过 (缺一不算)
    Rejected,
    /// RPC 矛盾 → 不确定 → **不交付** (fail-closed)
    RpcDisagreement,
}

/// 判定报告 (逐条列明)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentReport {
    pub verdict: PaymentVerdict,
    /// 通过的判据名
    pub passed: Vec<String>,
    /// 不过的判据 (原因)
    pub failed: Vec<String>,
    /// BOL1 nonce 解码 (有才有)
    pub order_identity: Option<Bol1Identity>,
}

/// 自证的订单身份 (回显给买方)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bol1Identity {
    pub mode: String,
    pub self_attested: bool,
    pub order_seq: u32,
    pub item_id_hash: String,
}

/// 核验主入口: 多 RPC 观察 + 声明 + 配置 → 判定
pub fn verify_direct_payment(
    cfg: &DirectPaymentConfig,
    claim: &PaymentClaim,
    observations: &[RpcObservation],
    used_tx_hashes: &HashSet<String>,
) -> PaymentReport {
    let mut passed = Vec::new();
    let mut failed = Vec::new();

    // 判据 6: ≥2 条 RPC 且结论一致 (矛盾即不确定)
    let (consistent, disagree) = rpc_consistency(cfg, observations);
    if disagree {
        return PaymentReport {
            verdict: PaymentVerdict::RpcDisagreement,
            passed,
            failed: vec!["rpc_disagreement: 多条 RPC 结论矛盾, 不确定 ⇒ 不交付".into()],
            order_identity: None,
        };
    }
    if !consistent {
        failed.push(format!(
            "rpc_agreement: 只有 {} 条一致 (需 ≥{})",
            observations.len(),
            cfg.min_rpc_agreement
        ));
    } else {
        passed.push("rpc_agreement".into());
    }

    let Some(obs) = observations.first() else {
        return PaymentReport {
            verdict: PaymentVerdict::Rejected,
            passed,
            failed: vec!["no_observation: 没有任何 RPC 观察".into()],
            order_identity: None,
        };
    };

    // 判据 1: chainId ( observations 由调用方按 chainId 拉, 这里核 status)
    if obs.status == 1 {
        passed.push("receipt_status".into());
    } else {
        failed.push(format!("receipt_status: status={} ≠ 1", obs.status));
    }

    // 判据 3: Transfer → to == payTo
    match &obs.transfer_to {
        Some(to) if *to == claim.pay_to.to_lowercase() => passed.push("transfer_to_payto".into()),
        Some(to) => failed.push(format!("transfer_to_payto: to={to} ≠ payTo={}", claim.pay_to)),
        None => failed.push("transfer_to_payto: 日志无 USDC Transfer".into()),
    }

    // 判据 4: value >= accepts.amount
    match obs.transfer_value_atomic {
        Some(v) if v >= claim.expected_amount_atomic => passed.push("value_sufficient".into()),
        Some(v) => failed.push(format!(
            "value_sufficient: {v} < {} (报价)",
            claim.expected_amount_atomic
        )),
        None => failed.push("value_sufficient: 无 value".into()),
    }

    // 判据 5: confirmations >= 2 (够用, 不到 L1 终局)
    if obs.confirmations >= cfg.min_confirmations {
        passed.push("confirmations".into());
    } else {
        failed.push(format!(
            "confirmations: {} < {}",
            obs.confirmations, cfg.min_confirmations
        ));
    }

    // 判据 7: txHash 未被别的 item 用过
    if used_tx_hashes.contains(&claim.tx_hash) {
        failed.push("tx_reuse: 该 txHash 已被记账 (换资源 = 409)".into());
    } else {
        passed.push("tx_reuse".into());
    }

    // 判据 8: 买方 ≠ payTo (不许自付自收)
    match &claim.payer {
        Some(p) if p.to_lowercase() == claim.pay_to.to_lowercase() => {
            failed.push("self_payment: 买方 == payTo, 拒 (不许自付自收)".into());
        }
        _ => passed.push("self_payment".into()),
    }

    // 自证: AuthorizationUsed nonce 复算本店 item
    let order_identity = obs
        .authorization_nonce
        .as_ref()
        .and_then(|n| decode_identity(n, claim));

    let verdict = if !failed.is_empty() {
        PaymentVerdict::Rejected
    } else if order_identity
        .as_ref()
        .map(|i| i.self_attested)
        .unwrap_or(false)
    {
        PaymentVerdict::SelfAttested
    } else {
        PaymentVerdict::Verified
    };

    PaymentReport {
        verdict,
        passed,
        failed,
        order_identity,
    }
}

fn decode_identity(nonce: &str, claim: &PaymentClaim) -> Option<Bol1Identity> {
    let DecodedOrderNonce {
        shape,
        order_seq,
        item_id_hash,
        ..
    } = order_identity::decode_order_nonce(nonce);
    if shape != OrderNonceShape::Ok {
        return None;
    }
    let seq = order_seq?;
    let self_attested = order_identity::match_order_nonce(nonce, &claim.item_id, seq as u64);
    // seq 必须与订单一致才认自证
    let self_attested = self_attested && seq as u64 == claim.order_seq;
    Some(Bol1Identity {
        mode: if self_attested { "self-attested" } else { "not-bol1" }.into(),
        self_attested,
        order_seq: seq,
        item_id_hash: item_id_hash?,
    })
}

/// RPC 一致性: 全部观察在 (status, transfer_to, value, nonce) 四元组上一致
fn rpc_consistency(cfg: &DirectPaymentConfig, observations: &[RpcObservation]) -> (bool, bool) {
    if observations.len() < cfg.min_rpc_agreement {
        return (false, false);
    }
    let key = |o: &RpcObservation| {
        (
            o.status,
            o.transfer_to.clone(),
            o.transfer_value_atomic,
            o.authorization_nonce.clone(),
        )
    };
    let first = key(&observations[0]);
    let all_same = observations.iter().all(|o| key(o) == first);
    if all_same {
        (true, false)
    } else {
        (false, true) // 矛盾
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> DirectPaymentConfig {
        DirectPaymentConfig::default()
    }

    fn claim() -> PaymentClaim {
        PaymentClaim {
            tx_hash: "0xabc123".into(),
            pay_to: "0xb4e9dcf79055a8232670ebb1c8c664dff4e70066".into(),
            item_id: "info_efficode_spec_pack".into(),
            expected_amount_atomic: 10000,
            payer: Some("0x6a3f797592bed028f6afd6da82339c8e815480eb".into()),
            order_seq: 0,
        }
    }

    fn good_obs(rpc: &str) -> RpcObservation {
        RpcObservation {
            rpc: rpc.into(),
            status: 1,
            transfer_to: Some("0xb4e9dcf79055a8232670ebb1c8c664dff4e70066".into()),
            transfer_value_atomic: Some(10000),
            authorization_nonce: Some(order_identity::compute_order_nonce("info_efficode_spec_pack", 0).unwrap()),
            confirmations: 13,
        }
    }

    #[test]
    fn happy_path_self_attested() {
        let mut used = HashSet::new();
        let obs = vec![good_obs("mainnet.base.org"), good_obs("base.drpc.org")];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(r.verdict, PaymentVerdict::SelfAttested, "{:?}", r.failed);
        assert!(r.order_identity.as_ref().unwrap().self_attested);
        assert_eq!(r.failed.len(), 0);
        used.insert(claim().tx_hash);
    }

    #[test]
    fn single_rpc_not_enough() {
        let used = HashSet::new();
        let obs = vec![good_obs("only.one")];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(r.verdict, PaymentVerdict::Rejected);
        assert!(r.failed.iter().any(|f| f.contains("rpc_agreement")));
    }

    #[test]
    fn rpc_disagreement_is_not_uncertain_delivery() {
        let used = HashSet::new();
        let mut o2 = good_obs("base.drpc.org");
        o2.transfer_value_atomic = Some(999); // 与第一条矛盾
        let obs = vec![good_obs("mainnet.base.org"), o2];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(
            r.verdict,
            PaymentVerdict::RpcDisagreement,
            "矛盾 ⇒ 不确定 ⇒ 不交付 (fail-closed)"
        );
    }

    #[test]
    fn tx_reuse_rejected() {
        let mut used = HashSet::new();
        used.insert("0xabc123".into());
        let obs = vec![good_obs("a"), good_obs("b")];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(r.verdict, PaymentVerdict::Rejected);
        assert!(r.failed.iter().any(|f| f.contains("tx_reuse")));
    }

    #[test]
    fn self_payment_rejected() {
        let mut c = claim();
        c.payer = Some(c.pay_to.clone()); // 买方 == payTo
        let obs = vec![good_obs("a"), good_obs("b")];
        let r = verify_direct_payment(&cfg(), &c, &obs, &HashSet::new());
        assert_eq!(r.verdict, PaymentVerdict::Rejected);
        assert!(r.failed.iter().any(|f| f.contains("self_payment")));
    }

    #[test]
    fn insufficient_value_rejected() {
        let used = HashSet::new();
        let mut o1 = good_obs("a");
        o1.transfer_value_atomic = Some(9999);
        let mut o2 = good_obs("b");
        o2.transfer_value_atomic = Some(9999);
        let obs = vec![o1, o2];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(r.verdict, PaymentVerdict::Rejected);
        assert!(r.failed.iter().any(|f| f.contains("value_sufficient")));
    }

    #[test]
    fn wrong_payto_rejected() {
        let used = HashSet::new();
        let mut o1 = good_obs("a");
        o1.transfer_to = Some("0xevil".into());
        let mut o2 = good_obs("b");
        o2.transfer_to = Some("0xevil".into());
        let obs = vec![o1, o2];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(r.verdict, PaymentVerdict::Rejected);
        assert!(r.failed.iter().any(|f| f.contains("transfer_to_payto")));
    }

    #[test]
    fn foreign_nonce_still_verified_not_self_attested() {
        let used = HashSet::new();
        let mut o1 = good_obs("a");
        o1.authorization_nonce = Some(order_identity::compute_order_nonce("别的店的东西", 0).unwrap());
        let mut o2 = good_obs("b");
        o2.authorization_nonce = o1.authorization_nonce.clone();
        let obs = vec![o1, o2];
        let r = verify_direct_payment(&cfg(), &claim(), &obs, &used);
        assert_eq!(
            r.verdict,
            PaymentVerdict::Verified,
            "nonce 不是本店 item 的 = 直转(无自证), 交付照旧但不许写自证"
        );
        assert!(!r.order_identity.as_ref().unwrap().self_attested);
    }
}
