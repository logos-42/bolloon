//! 贡献账本 (Contribution Ledger)。
//!
//! 与消耗账本**分开**的原因: 一个人贡献了一个好工具, 不等于网络凭空多了一美元 API 预算。
//! 所以这里记录的是"谁提供了什么、到哪一步", 而不是"可以兑换多少 token"。
//!
//! 状态推进: `Pledged`(承诺) → `Executed`(已执行) → `Verified`(被他人验收) → `Confirmed`(确认入账)
//! - 只有 `Confirmed` 的现金贡献才算进公共池可用余额。
//! - 自我验收无效 (verifier 不能等于 contributor)。
//! - 首期**不发行可交易代币**, 信誉分也不直接兑换 API 额度。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::EconError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    /// 捐 API 额度 / 现金
    ApiCredit,
    /// 赞助某个意图或公共池
    CashSponsor,
    /// 提供本地推理算力
    LocalInference,
    /// 提供工具服务
    ToolService,
    /// 承接子任务
    TaskExecution,
    /// 经过验收的知识/验证结果
    VerifiedKnowledge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionState {
    /// 只是承诺, 还没有任何资源到位
    Pledged,
    /// 已经执行 (可能是贡献者自己说的)
    Executed,
    /// 被别人验收过
    Verified,
    /// 确认入账 (现金才进池子)
    Confirmed,
    /// 被拒 (证据不足/不合格)
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Contribution {
    pub id: String,
    pub contributor: String,
    pub kind: ContributionKind,
    /// 现金贡献金额 (USD; 仅 ApiCredit/CashSponsor 有)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cash_usd: Option<f64>,
    /// 非现金贡献的计量值 (ms / tokens / 次): 只记原维度, 不折算成钱
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub units: Option<f64>,
    #[serde(default)]
    pub unit_kind: String,
    pub state: ContributionState,
    #[serde(default)]
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_by: Option<String>,
    /// 证据引用 (账单号/合同 id/任务 id), 不放敏感原文
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub note: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContributionTotals {
    /// **只有 Confirmed 的现金**才算可用贡献
    pub cash_confirmed_usd: f64,
    /// 已确认的非现金资源 (各维度分开)
    pub local_inference_units: f64,
    pub tool_units: f64,
    pub execution_units: f64,
    /// 承诺但未兑现的现金 (不计入任何余额)
    pub cash_pledged_usd: f64,
    pub pledged: u64,
    pub executed: u64,
    pub verified: u64,
    pub confirmed: u64,
    pub rejected: u64,
}

pub struct ContributionLedger {
    path: Option<PathBuf>,
    records: Mutex<Vec<Contribution>>,
}

impl ContributionLedger {
    pub fn new(path: Option<PathBuf>) -> Self {
        let l = Self {
            path,
            records: Mutex::new(vec![]),
        };
        l.load();
        l
    }

    fn load(&self) {
        let Some(p) = &self.path else { return };
        let Ok(raw) = std::fs::read_to_string(p) else {
            return;
        };
        match serde_json::from_str::<Vec<Contribution>>(&raw) {
            Ok(list) => *self.records.lock().unwrap() = list,
            Err(e) => {
                tracing::warn!(path = %p.display(), error = %e, "贡献账本解析失败, 保留内存态")
            }
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

    /// 登记一条承诺。现金贡献必须有非负金额; 非现金贡献必须有计量维度。
    pub fn pledge(&self, mut c: Contribution) -> Result<Contribution, EconError> {
        if c.contributor.trim().is_empty() {
            return Err(EconError::InvalidContribution(
                "contributor 不能为空".into(),
            ));
        }
        match c.kind {
            ContributionKind::ApiCredit | ContributionKind::CashSponsor => {
                let cash = c.cash_usd.unwrap_or(0.0);
                if !(cash.is_finite() && cash >= 0.0) {
                    return Err(EconError::InvalidContribution("现金金额非法".into()));
                }
                if cash == 0.0 && c.units.is_none() {
                    return Err(EconError::InvalidContribution(
                        "现金贡献要有金额 (0 元不算贡献)".into(),
                    ));
                }
            }
            _ => {
                if c.units.is_none() {
                    return Err(EconError::InvalidContribution(
                        "非现金贡献要写明计量维度 (units + unit_kind)".into(),
                    ));
                }
                if c.unit_kind.trim().is_empty() {
                    return Err(EconError::InvalidContribution("unit_kind 不能为空".into()));
                }
                if c.cash_usd.is_some() {
                    return Err(EconError::InvalidContribution(
                        "非现金贡献不要填现金金额 (不同维度不折算)".into(),
                    ));
                }
            }
        }
        if c.id.trim().is_empty() {
            c.id = format!(
                "contrib-{}-{}",
                chrono::Utc::now().timestamp_millis(),
                self.records.lock().unwrap().len() + 1
            );
        }
        c.state = ContributionState::Pledged;
        c.at = chrono::Utc::now().to_rfc3339();
        {
            let mut w = self.records.lock().unwrap();
            if w.iter().any(|x| x.id == c.id) {
                return Err(EconError::InvalidContribution(format!(
                    "贡献 id `{}` 已存在",
                    c.id
                )));
            }
            w.push(c.clone());
        }
        self.save();
        Ok(c)
    }

    fn transition(
        &self,
        id: &str,
        from: &[ContributionState],
        to: ContributionState,
        who: Option<&str>,
    ) -> Result<Contribution, EconError> {
        let mut w = self.records.lock().unwrap();
        let c = w
            .iter_mut()
            .find(|x| x.id == id)
            .ok_or_else(|| EconError::InvalidContribution(format!("未知贡献 `{id}`")))?;
        if !from.contains(&c.state) {
            return Err(EconError::InvalidContribution(format!(
                "状态不允许: 当前 {:?}, 需要 {:?}",
                c.state, from
            )));
        }
        if let Some(who) = who {
            if who == c.contributor {
                return Err(EconError::InvalidContribution(
                    "不能自己验收/确认自己的贡献 (需要独立验证)".into(),
                ));
            }
        }
        c.state = to;
        if let Some(who) = who {
            c.verified_by = Some(who.to_string());
        }
        let out = c.clone();
        drop(w);
        self.save();
        Ok(out)
    }

    pub fn mark_executed(&self, id: &str) -> Result<Contribution, EconError> {
        self.transition(
            id,
            &[ContributionState::Pledged],
            ContributionState::Executed,
            None,
        )
    }

    /// 独立验收 (verifier ≠ contributor)
    pub fn verify(&self, id: &str, verifier: &str) -> Result<Contribution, EconError> {
        self.transition(
            id,
            &[ContributionState::Executed],
            ContributionState::Verified,
            Some(verifier),
        )
    }

    /// 确认入账 (只有这里之后, 现金才进公共池)
    pub fn confirm(&self, id: &str, by: &str) -> Result<Contribution, EconError> {
        self.transition(
            id,
            &[ContributionState::Verified],
            ContributionState::Confirmed,
            Some(by),
        )
    }

    pub fn reject(&self, id: &str, by: &str, _why: &str) -> Result<Contribution, EconError> {
        self.transition(
            id,
            &[
                ContributionState::Pledged,
                ContributionState::Executed,
                ContributionState::Verified,
            ],
            ContributionState::Rejected,
            Some(by),
        )
    }

    pub fn list(&self) -> Vec<Contribution> {
        self.records.lock().unwrap().clone()
    }

    pub fn by_contributor(&self) -> BTreeMap<String, ContributionTotals> {
        let mut out: BTreeMap<String, ContributionTotals> = BTreeMap::new();
        for c in self.records.lock().unwrap().iter() {
            let t = out.entry(c.contributor.clone()).or_default();
            accumulate(t, c);
        }
        out
    }

    pub fn totals(&self) -> ContributionTotals {
        let mut t = ContributionTotals::default();
        for c in self.records.lock().unwrap().iter() {
            accumulate(&mut t, c);
        }
        t
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

fn accumulate(t: &mut ContributionTotals, c: &Contribution) {
    match c.state {
        ContributionState::Pledged => {
            t.pledged += 1;
            t.cash_pledged_usd += c.cash_usd.unwrap_or(0.0);
        }
        ContributionState::Executed => {
            t.executed += 1;
            t.cash_pledged_usd += c.cash_usd.unwrap_or(0.0);
        }
        ContributionState::Verified => {
            t.verified += 1;
        }
        ContributionState::Confirmed => {
            t.confirmed += 1;
            match c.kind {
                ContributionKind::ApiCredit | ContributionKind::CashSponsor => {
                    t.cash_confirmed_usd += c.cash_usd.unwrap_or(0.0)
                }
                ContributionKind::LocalInference => {
                    t.local_inference_units += c.units.unwrap_or(0.0)
                }
                ContributionKind::ToolService => t.tool_units += c.units.unwrap_or(0.0),
                ContributionKind::TaskExecution | ContributionKind::VerifiedKnowledge => {
                    t.execution_units += c.units.unwrap_or(0.0)
                }
            }
        }
        ContributionState::Rejected => t.rejected += 1,
    }
}
