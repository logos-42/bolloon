//! 结算账本 (Settlement Ledger) —— 每笔成本"最终由谁承担"。
//!
//! 三条守恒律 (违反即拒, 不做"差不多"):
//! 1. `Σ 分摊 ≤ 实际成本` (不允许凭空多扣)
//! 2. 每个 payer 必须**显式授权** (不允许替别人扣费)
//! 3. 同一笔成本只能结算一次 (幂等; 重复同步不会重复扣费)
//!
//! 公共池的钱只有**已到账**的才能用: 可用 = 配置的可用现金 + 已确认贡献现金 − 已承诺 − 已支出。
//! 未来才到账的赞助、未兑现的贡献、预期降价的 API —— 一律不计入。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::budget::PayerKind;
use crate::error::EconError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettlementState {
    /// 草稿: 已记账但未经确认 (影子模式下都是这个)
    Draft,
    Confirmed,
    Rejected,
    /// 事后回滚 (任务失败/验收不过)
    RolledBack,
}

impl Default for SettlementState {
    fn default() -> Self {
        Self::Draft
    }
}

/// 公共资源池现金视图 (现金与贡献**分开**记)。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PublicPool {
    /// 配置里声明的可用现金 (已到账)
    pub cash_available_usd: f64,
    /// 已确认的贡献现金 (已到账的捐赠/赞助)
    pub contribution_cash_usd: f64,
    /// 已承诺但还没花
    pub committed_usd: f64,
    /// 已实际支出
    pub spent_usd: f64,
}

impl PublicPool {
    pub fn available(&self) -> f64 {
        (self.cash_available_usd + self.contribution_cash_usd - self.committed_usd - self.spent_usd)
            .max(0.0)
    }

    pub fn try_reserve(&mut self, amount: f64) -> Result<(), EconError> {
        if amount < 0.0 || !amount.is_finite() {
            return Err(EconError::PoolInsufficient {
                available: self.available(),
                needed: amount,
            });
        }
        if amount > self.available() + 1e-9 {
            return Err(EconError::PoolInsufficient {
                available: self.available(),
                needed: amount,
            });
        }
        self.committed_usd += amount;
        Ok(())
    }

    /// 承诺转为实际支出
    pub fn settle_reserved(&mut self, amount: f64) {
        self.committed_usd = (self.committed_usd - amount).max(0.0);
        self.spent_usd += amount;
    }

    pub fn release(&mut self, amount: f64) {
        self.committed_usd = (self.committed_usd - amount).max(0.0);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostShare {
    pub payer_id: String,
    pub kind: PayerKind,
    pub amount_usd: f64,
    /// 该 payer 是否明确授权被扣费
    pub authorized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettlementRecord {
    pub id: String,
    pub meter_event_ids: Vec<String>,
    pub total_cost_usd: f64,
    pub shares: Vec<CostShare>,
    pub state: SettlementState,
    /// 结算依据 (价格表版本 / 账单号 / 人工指令)
    pub basis: String,
    pub conservation_ok: bool,
    pub at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SettleError {
    #[error(transparent)]
    Econ(#[from] EconError),
}

pub struct SettlementLedger {
    path: Option<PathBuf>,
    records: Mutex<Vec<SettlementRecord>>,
    settled_events: Mutex<HashSet<String>>,
    pool: Mutex<PublicPool>,
}

impl SettlementLedger {
    pub fn new(path: Option<PathBuf>, pool: PublicPool) -> Self {
        let l = Self {
            path,
            records: Mutex::new(vec![]),
            settled_events: Mutex::new(HashSet::new()),
            pool: Mutex::new(pool),
        };
        l.load();
        l
    }

    fn load(&self) {
        let Some(p) = &self.path else { return };
        let Ok(raw) = std::fs::read_to_string(p) else {
            return;
        };
        if let Ok(list) = serde_json::from_str::<Vec<SettlementRecord>>(&raw) {
            let mut settled = self.settled_events.lock().unwrap();
            for r in &list {
                for e in &r.meter_event_ids {
                    settled.insert(e.clone());
                }
            }
            *self.records.lock().unwrap() = list;
        }
    }

    fn save(&self) {
        let Some(p) = &self.path else { return };
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let list = self.records.lock().unwrap().clone();
        if let Ok(s) = serde_json::to_string_pretty(&list) {
            let tmp = p.with_extension("tmp");
            if std::fs::write(&tmp, s).is_ok() {
                let _ = std::fs::rename(&tmp, p);
            }
        }
    }

    pub fn pool(&self) -> PublicPool {
        self.pool.lock().unwrap().clone()
    }

    /// 同步已确认贡献现金 (幂等: 直接设为当前确认总额, 重复调用不会重复计)
    pub fn set_contribution_cash(&self, usd: f64) {
        self.pool.lock().unwrap().contribution_cash_usd = usd.max(0.0);
    }

    pub fn set_pool_cash(&self, usd: f64) {
        self.pool.lock().unwrap().cash_available_usd = usd.max(0.0);
    }

    /// 记一笔结算 (影子模式下 `state=Draft`; `confirm` 才真正动池子)。
    pub fn settle(
        &self,
        event_ids: Vec<String>,
        total_cost_usd: f64,
        shares: Vec<CostShare>,
        basis: &str,
        state: SettlementState,
    ) -> Result<SettlementRecord, SettleError> {
        if event_ids.is_empty() {
            return Err(EconError::InvalidSettlement("没有关联计量事件".into()).into());
        }
        if !(total_cost_usd.is_finite() && total_cost_usd >= 0.0) {
            return Err(EconError::InvalidSettlement("成本金额非法".into()).into());
        }
        // 幂等: 同一笔成本只能结算一次
        {
            let settled = self.settled_events.lock().unwrap();
            if let Some(dup) = event_ids.iter().find(|e| settled.contains(*e)) {
                return Err(EconError::AlreadySettled(dup.clone()).into());
            }
        }
        // 授权: 任何未授权的 payer 直接拒
        if let Some(bad) = shares.iter().find(|s| !s.authorized) {
            return Err(EconError::UnauthorizedPayer(bad.payer_id.clone()).into());
        }
        // 守恒: 分摊合计不得超过成本
        let sum: f64 = shares.iter().map(|s| s.amount_usd).sum();
        if sum > total_cost_usd + 1e-9 {
            return Err(EconError::ConservationViolated {
                sum,
                cost: total_cost_usd,
            }
            .into());
        }
        // 公共池够不够 (只有真扣款/确认时才检查现金; Draft 也要检查"够不够"以便提前暴露)
        let pool_share: f64 = shares
            .iter()
            .filter(|s| s.kind == PayerKind::PublicPool)
            .map(|s| s.amount_usd)
            .sum();
        if pool_share > 0.0 {
            let mut pool = self.pool.lock().unwrap();
            pool.try_reserve(pool_share)?;
            if state == SettlementState::Confirmed {
                pool.settle_reserved(pool_share);
            }
        }

        let rec = SettlementRecord {
            id: format!(
                "settle-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                self.records.lock().unwrap().len() + 1
            ),
            meter_event_ids: event_ids.clone(),
            total_cost_usd,
            shares,
            state,
            basis: basis.to_string(),
            conservation_ok: true,
            at: chrono::Utc::now().to_rfc3339(),
        };
        {
            let mut settled = self.settled_events.lock().unwrap();
            for e in &event_ids {
                settled.insert(e.clone());
            }
        }
        self.records.lock().unwrap().push(rec.clone());
        self.save();
        Ok(rec)
    }

    /// 回滚一笔结算 (任务失败/验收不过): 记录 RolledBack, 释放公共池承诺。
    pub fn rollback(&self, settlement_id: &str, why: &str) -> Result<(), EconError> {
        let mut w = self.records.lock().unwrap();
        let rec = w
            .iter_mut()
            .find(|r| r.id == settlement_id)
            .ok_or_else(|| EconError::InvalidSettlement(format!("未知结算 `{settlement_id}`")))?;
        if rec.state == SettlementState::RolledBack {
            return Ok(());
        }
        let pool_share: f64 = rec
            .shares
            .iter()
            .filter(|s| s.kind == PayerKind::PublicPool)
            .map(|s| s.amount_usd)
            .sum();
        rec.state = SettlementState::RolledBack;
        rec.basis = format!("{} | rollback: {why}", rec.basis);
        drop(w);
        if pool_share > 0.0 {
            self.pool.lock().unwrap().release(pool_share);
        }
        self.save();
        Ok(())
    }

    pub fn records(&self) -> Vec<SettlementRecord> {
        self.records.lock().unwrap().clone()
    }

    pub fn total_settled_usd(&self) -> f64 {
        self.records
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.state != SettlementState::RolledBack)
            .map(|r| r.shares.iter().map(|s| s.amount_usd).sum::<f64>())
            .sum()
    }

    pub fn by_payer(&self) -> std::collections::BTreeMap<String, f64> {
        let mut out: std::collections::BTreeMap<String, f64> = std::collections::BTreeMap::new();
        for r in self.records.lock().unwrap().iter() {
            if r.state == SettlementState::RolledBack {
                continue;
            }
            for s in &r.shares {
                *out.entry(s.payer_id.clone()).or_insert(0.0) += s.amount_usd;
            }
        }
        out
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}
