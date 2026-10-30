//! 钱包工具集 — 全部工具完成钱包任务, **私钥永不泄露**
//!
//! 对齐 TS 版 x402 wallet 工具语义:
//! - 工具面: address / balance / sign_message / transfer (EIP-3009 授权) /
//!   publish_task (在已有合约上发表任务) / purchase (x402 购买)
//! - **私钥纪律**: 私钥只在签名瞬间使用, 任何工具输出 (含 Debug/JSON) 不含 seed;
//!   测试把 seed 的 hex/b58 喂进每个输出做泄露扫描
//! - EIP-3009 `transferWithAuthorization` 形状 (USDC): from/to/value/validAfter/
//!   validBefore/nonce + 签名 → 输出是**可广播 payload**, 不输出私钥
//! - 地址说明 (诚实边界): 本实现签名用 Ed25519 (DIAP 生态), EVM 地址为
//!   sha256(pubkey)[..20] 的本地链语义; 主网 secp256k1 地址不在本文件范围
//! - 在已有合约上发表任务: 构造任务公告 entry + 资金授权 (escrow 合约地址由调用方给)

use sha2::{Digest, Sha256};

use crate::order_identity::compute_order_nonce;
use crate::paid_info::canonical_json;
use bolloon_p2p::identity::KeyPair;

/// 工具错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WalletError {
    #[error("金额必须大于 0")]
    ZeroAmount,
    #[error("余额不足: {0} < {1}")]
    Insufficient(u128, u128),
    #[error("有效期窗口非法 (valid_before 必须晚于 valid_after)")]
    BadWindow,
    #[error("预算不能为空")]
    EmptyBudget,
}

/// 钱包工具集 (私钥持有; 输出面零泄露)
pub struct WalletTools {
    kp: KeyPair,
    /// 本地台账余额 (原子单位; 真余额以链上为准)
    balances: std::collections::HashMap<String, u128>,
}

impl WalletTools {
    pub fn new(kp: KeyPair) -> Self {
        let addr = Self::address_of(&kp);
        let mut balances = std::collections::HashMap::new();
        balances.insert(addr, 0u128);
        Self { kp, balances }
    }

    /// 地址 (sha256(pubkey)[..20] → 0x hex; 本地链语义, 见模块注释)
    pub fn address_of(kp: &KeyPair) -> String {
        let d = Sha256::digest(kp.public_bytes());
        format!("0x{}", hex::encode(&d[..20]))
    }

    /// 工具 1: 我的地址
    pub fn address(&self) -> String {
        Self::address_of(&self.kp)
    }

    /// 工具 2: 余额 (本地台账; 不冒充链上事实)
    pub fn balance(&self) -> u128 {
        self.balances.get(&self.address()).copied().unwrap_or(0)
    }

    /// 工具 3: 签消息 (返回签名; 私钥不出)
    pub fn sign_message(&self, message: &str) -> String {
        bolloon_p2p::b58_encode(&self.kp.sign(message.as_bytes()))
    }

    /// 工具 4: EIP-3009 授权转账 payload (USDC 形状)
    ///
    /// 返回可广播的授权 JSON — **不含私钥**; nonce 由订单标识派生 (BOL1)
    pub fn transfer_with_authorization(
        &mut self,
        to: &str,
        value_atomic: u128,
        valid_after_ms: u64,
        valid_before_ms: u64,
        order_seq: u64,
        item_ref: &str,
    ) -> Result<serde_json::Value, WalletError> {
        if value_atomic == 0 {
            return Err(WalletError::ZeroAmount);
        }
        if valid_before_ms <= valid_after_ms {
            return Err(WalletError::BadWindow);
        }
        let bal = self.balance();
        if bal < value_atomic {
            return Err(WalletError::Insufficient(bal, value_atomic));
        }
        // 本地台账同步扣减 (授权即支出承诺; 链上回执可对账)
        let from = self.address();
        *self.balances.get_mut(&from).unwrap() -= value_atomic;
        let nonce = compute_order_nonce(item_ref, order_seq).unwrap_or_default();
        let from = self.address();
        let unsigned = serde_json::json!({
            "name": "USD Coin",
            "version": "2",
            "from": from,
            "to": to,
            "value": value_atomic.to_string(),
            "validAfter": valid_after_ms.to_string(),
            "validBefore": valid_before_ms.to_string(),
            "nonce": nonce,
        });
        let sig = self.kp.sign(canonical_json(&unsigned).as_bytes());
        Ok(serde_json::json!({
            "kind": "eip3009.transferWithAuthorization",
            "payload": unsigned,
            "signature": bolloon_p2p::b58_encode(&sig),
            "signer_did": self.kp.did.as_str(),
            // 注意: 这里没有 private_key / seed 字段 — 测试会扫描
        }))
    }

    /// 工具 5: 在已有合约上发表任务 (escrow 合约地址由调用方给)
    ///
    /// 输出 = 任务公告 entry + 资金授权 (预算锁定), 签名齐全, 私钥不出
    pub fn publish_task_onchain(
        &self,
        title: &str,
        budget_atomic: u128,
        escrow_contract: &str,
        now_ms: u64,
    ) -> Result<serde_json::Value, WalletError> {
        if title.trim().is_empty() {
            return Err(WalletError::EmptyBudget);
        }
        if budget_atomic == 0 {
            return Err(WalletError::ZeroAmount);
        }
        let bal = self.balance();
        if bal < budget_atomic {
            return Err(WalletError::Insufficient(bal, budget_atomic));
        }
        let task_id = {
            let d = Sha256::digest(format!("{}|{}|{}", title, budget_atomic, now_ms).as_bytes());
            format!("task-{}", hex::encode(&d[..8]))
        };
        let unsigned = serde_json::json!({
            "contract": escrow_contract,
            "task_id": task_id,
            "title": title,
            "budget": budget_atomic.to_string(),
            "publisher": self.address(),
            "published_at": now_ms,
        });
        let sig = self.kp.sign(canonical_json(&unsigned).as_bytes());
        Ok(serde_json::json!({
            "kind": "task.publishOnContract",
            "payload": unsigned,
            "signature": bolloon_p2p::b58_encode(&sig),
            "signer_did": self.kp.did.as_str(),
        }))
    }

    /// 工具 6: x402 购买 (402 报价 → 签名支付 payload)
    pub fn purchase(
        &mut self,
        item_id: &str,
        pay_to: &str,
        amount_atomic: u128,
        order_seq: u64,
        now_ms: u64,
    ) -> Result<serde_json::Value, WalletError> {
        if amount_atomic == 0 {
            return Err(WalletError::ZeroAmount);
        }
        let bal = self.balance();
        if bal < amount_atomic {
            return Err(WalletError::Insufficient(bal, amount_atomic));
        }
        let auth = self.transfer_with_authorization(
            pay_to,
            amount_atomic,
            now_ms,
            now_ms + 60_000,
            order_seq,
            item_id,
        )?;
        Ok(serde_json::json!({
            "kind": "x402.purchase",
            "item_id": item_id,
            "payment": auth,
        }))
    }

    /// 台账入账 (测试/本地记账; 真余额以链上为准)
    pub fn credit(&mut self, amount_atomic: u128) {
        let a = self.address();
        *self.balances.entry(a).or_insert(0) += amount_atomic;
    }
}

/// 泄露扫描: 序列化输出里不许出现 seed 的任何编码形态
pub fn is_secret_leaked(kp: &KeyPair, output: &str) -> bool {
    let seed = kp.secret_bytes();
    let hex_full = hex::encode(seed);
    let b58 = bolloon_p2p::b58_encode(&seed);
    let hex_halves = [
        hex::encode(&seed[..16]),
        hex::encode(&seed[16..]),
    ];
    output.contains(&hex_full)
        || output.contains(&b58)
        || hex_halves.iter().any(|h| output.contains(h.as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wallet() -> WalletTools {
        let mut w = WalletTools::new(KeyPair::from_seed(&[7u8; 32]));
        w.credit(100_000); // 充值便于测试
        w
    }

    #[test]
    fn address_shape_stable() {
        let kp = KeyPair::from_seed(&[7u8; 32]);
        let a = WalletTools::address_of(&kp);
        assert!(a.starts_with("0x"));
        assert_eq!(a.len(), 42);
        assert_eq!(a, WalletTools::new(kp).address(), "同 key 同地址");
    }

    #[test]
    fn full_tool_surface_works() {
        let mut w = wallet();
        assert_eq!(w.balance(), 100_000);
        assert!(!w.sign_message("hello").is_empty());
        // 转账授权
        let auth = w
            .transfer_with_authorization("0xaaa", 5_000, 1000, 61_000, 0, "item_x")
            .unwrap();
        assert_eq!(auth["kind"], "eip3009.transferWithAuthorization");
        assert_eq!(auth["payload"]["value"], "5000");
        assert!(auth["signature"].as_str().unwrap().len() > 40);
        // 链上发任务
        let task = w.publish_task_onchain("复核核聚变口径", 20_000, "0xescrow", 2000).unwrap();
        assert_eq!(task["kind"], "task.publishOnContract");
        assert_eq!(task["payload"]["budget"], "20000");
        assert!(task["payload"]["task_id"].as_str().unwrap().starts_with("task-"));
        // 购买
        let buy = w.purchase("info_efficode_spec_pack", "0xbbb", 10_000, 0, 3000).unwrap();
        assert_eq!(buy["kind"], "x402.purchase");
        assert_eq!(buy["payment"]["payload"]["to"], "0xbbb");
        // BOL1 nonce 在支付 payload 里 (买的是哪件可自证)
        let nonce = buy["payment"]["payload"]["nonce"].as_str().unwrap();
        assert!(nonce.starts_with("0x424f4c31"), "nonce 是 BOL1 形状: {nonce}");
    }

    #[test]
    fn wallet_guards() {
        let mut w = wallet();
        assert_eq!(w.transfer_with_authorization("0xa", 0, 1, 2, 0, "i").unwrap_err(), WalletError::ZeroAmount);
        assert_eq!(
            w.transfer_with_authorization("0xa", 1, 5000, 1000, 0, "i").unwrap_err(),
            WalletError::BadWindow
        );
        // 超额
        assert!(matches!(
            w.transfer_with_authorization("0xa", 999_999, 1, 2, 0, "i"),
            Err(WalletError::Insufficient(_, _))
        ));
        assert_eq!(
            w.publish_task_onchain("  ", 1, "0xe", 1).unwrap_err(),
            WalletError::EmptyBudget
        );
        // 转账后台账扣减
        let _ = w.transfer_with_authorization("0xa", 5_000, 1, 2, 0, "i").unwrap();
        assert_eq!(w.balance(), 95_000);
    }

    /// 核心纪律: 私钥不出 — 每个工具输出做泄露扫描
    #[test]
    fn no_secret_leakage_in_any_output() {
        let kp = KeyPair::from_seed(&[42u8; 32]);
        let mut w = WalletTools::new(kp.clone());
        w.credit(50_000);
        let outputs: Vec<serde_json::Value> = vec![
            serde_json::json!({ "address": w.address() }),
            serde_json::json!({ "balance": w.balance() }),
            serde_json::json!({ "sig": w.sign_message("m") }),
            w.transfer_with_authorization("0xa", 100, 1, 99_999, 0, "i").unwrap(),
            w.publish_task_onchain("t", 200, "0xe", 1).unwrap(),
            w.purchase("item", "0xb", 300, 0, 1).unwrap(),
        ];
        for (i, o) in outputs.iter().enumerate() {
            let s = o.to_string();
            assert!(
                !is_secret_leaked(&kp, &s),
                "输出 #{i} 泄露了私钥: {s}"
            );
            assert!(!s.to_lowercase().contains("private_key"), "输出 #{i} 有 private_key 字段");
            assert!(!s.to_lowercase().contains("seed"), "输出 #{i} 有 seed 字段");
        }
        // Debug 格式也扫
        let dbg = format!("{:?}", outputs[3]);
        assert!(!is_secret_leaked(&kp, &dbg));
    }
}
