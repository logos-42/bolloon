//! 钱包台账 — 地址簿 + 交易流水
//!
//! 对齐 TS 版 `cli/commands/wallet.ts` 语义:
//! - 一钱包一条目 (地址 + 标签 + 链); 私钥**永不入台账, 不回显**
//! - 流水 (balance 变化记录) 只记事实: 时间/方向/金额/备注
//! - 地址形态校验 (EVM 0x+40 / 通用) — 形状不对不入簿

use serde::{Deserialize, Serialize};

/// 钱包条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WalletEntry {
    pub name: String,
    /// EVM 地址 (0x + 40 hex, 存小写)
    pub address: String,
    /// base | base-sepolia | mainnet
    pub network: String,
    pub created_at_ms: u64,
}

/// 流水方向
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FlowDirection {
    In,
    Out,
}

/// 流水记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WalletFlow {
    pub wallet: String,
    pub direction: FlowDirection,
    /// 原子单位
    pub amount_atomic: u128,
    pub note: String,
    pub at_ms: u64,
}

/// 钱包错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum WalletError {
    #[error("地址形状不对 (要 0x + 40 hex): {0}")]
    BadAddress(String),
    #[error("钱包不存在: {0}")]
    NotFound(String),
    #[error("余额不足: {0} < {1}")]
    InsufficientBalance(u128, u128),
    #[error("钱包已存在: {0}")]
    Duplicate(String),
}

/// EVM 地址校验 (0x + 40 hex)
pub fn validate_evm_address(addr: &str) -> Result<String, WalletError> {
    let lowered = addr.trim().to_lowercase();
    if lowered.len() == 42
        && lowered.starts_with("0x")
        && lowered[2..].chars().all(|c| c.is_ascii_hexdigit())
    {
        Ok(lowered)
    } else {
        Err(WalletError::BadAddress(addr.to_string()))
    }
}

/// 钱包簿
#[derive(Debug, Default)]
pub struct WalletBook {
    wallets: Vec<WalletEntry>,
    flows: Vec<WalletFlow>,
    /// 内存余额 (原子) — 真余额以链上为准, 这是本地台账
    balances: std::collections::HashMap<String, u128>,
}

impl WalletBook {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建钱包 (地址形状不对不入簿)
    pub fn create(
        &mut self,
        name: &str,
        address: &str,
        network: &str,
        now_ms: u64,
    ) -> Result<&WalletEntry, WalletError> {
        let addr = validate_evm_address(address)?;
        if self.wallets.iter().any(|w| w.name == name) {
            return Err(WalletError::Duplicate(name.into()));
        }
        self.wallets.push(WalletEntry {
            name: name.into(),
            address: addr,
            network: network.into(),
            created_at_ms: now_ms,
        });
        Ok(self.wallets.last().unwrap())
    }

    pub fn get(&self, name: &str) -> Option<&WalletEntry> {
        self.wallets.iter().find(|w| w.name == name)
    }

    pub fn list(&self) -> &[WalletEntry] {
        &self.wallets
    }

    /// 记流水 (余额联动; In 加 Out 减)
    pub fn record_flow(
        &mut self,
        wallet: &str,
        direction: FlowDirection,
        amount_atomic: u128,
        note: &str,
        now_ms: u64,
    ) -> Result<(), WalletError> {
        if !self.wallets.iter().any(|w| w.name == wallet) {
            return Err(WalletError::NotFound(wallet.into()));
        }
        let balance = self.balances.entry(wallet.to_string()).or_insert(0);
        match direction {
            FlowDirection::In => *balance = balance.saturating_add(amount_atomic),
            FlowDirection::Out => {
                if *balance < amount_atomic {
                    return Err(WalletError::InsufficientBalance(*balance, amount_atomic));
                }
                *balance -= amount_atomic;
            }
        }
        self.flows.push(WalletFlow {
            wallet: wallet.into(),
            direction,
            amount_atomic,
            note: note.into(),
            at_ms: now_ms,
        });
        Ok(())
    }

    /// 余额 (本地台账; 不冒充链上事实)
    pub fn local_balance(&self, wallet: &str) -> Result<u128, WalletError> {
        if !self.wallets.iter().any(|w| w.name == wallet) {
            return Err(WalletError::NotFound(wallet.into()));
        }
        Ok(self.balances.get(wallet).copied().unwrap_or(0))
    }

    pub fn flow_count(&self) -> usize {
        self.flows.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ADDR: &str = "0x6A3f797592Bed028F6AfD6DA82339C8e815480eb";

    #[test]
    fn address_validated_and_lowercased() {
        assert_eq!(validate_evm_address(ADDR).unwrap(), ADDR.to_lowercase());
        assert_eq!(
            validate_evm_address("0x123").unwrap_err(),
            WalletError::BadAddress("0x123".into())
        );
        assert_eq!(
            validate_evm_address("6a3f797592bed028f6afd6da82339c8e815480eb").unwrap_err(),
            WalletError::BadAddress("6a3f797592bed028f6afd6da82339c8e815480eb".into()),
            "缺 0x 前缀拒"
        );
    }

    #[test]
    fn create_and_list() {
        let mut b = WalletBook::new();
        b.create("main", ADDR, "base", 1).unwrap();
        assert_eq!(b.list().len(), 1);
        assert_eq!(b.get("main").unwrap().address, ADDR.to_lowercase());
        // 重复名拒
        assert_eq!(b.create("main", ADDR, "base", 2).unwrap_err(), WalletError::Duplicate("main".into()));
    }

    #[test]
    fn flow_in_out_and_insufficient() {
        let mut b = WalletBook::new();
        b.create("main", ADDR, "base", 1).unwrap();
        b.record_flow("main", FlowDirection::In, 10000, "充值", 2).unwrap();
        assert_eq!(b.local_balance("main").unwrap(), 10000);
        b.record_flow("main", FlowDirection::Out, 3000, "付款", 3).unwrap();
        assert_eq!(b.local_balance("main").unwrap(), 7000);
        assert_eq!(
            b.record_flow("main", FlowDirection::Out, 99999, "超额", 4).unwrap_err(),
            WalletError::InsufficientBalance(7000, 99999)
        );
        assert_eq!(b.local_balance("main").unwrap(), 7000, "失败流水不改余额");
    }

    #[test]
    fn unknown_wallet_rejected() {
        let mut b = WalletBook::new();
        assert_eq!(
            b.record_flow("ghost", FlowDirection::In, 1, "", 1).unwrap_err(),
            WalletError::NotFound("ghost".into())
        );
    }

    #[test]
    fn no_private_key_field_anywhere() {
        // 冻结: 台账结构里没有私钥字段 (编译期即无出口)
        let mut b = WalletBook::new();
        b.create("main", ADDR, "base", 1).unwrap();
        let json = serde_json::to_string(&b.list()[0]).unwrap();
        assert!(!json.contains("private"), "私钥不进台账");
        assert!(!json.contains("secret"), "secret 不进台账");
        assert!(!json.contains("seed"), "seed 不进台账");
    }

    #[test]
    fn local_balance_not_chain_fact() {
        // 诚实: 本地台账余额是台账事实, 不冒充链上
        let mut b = WalletBook::new();
        b.create("main", ADDR, "base", 1).unwrap();
        assert_eq!(b.local_balance("main").unwrap(), 0, "没流水 = 台账 0 (不是链上 0)");
    }
}
