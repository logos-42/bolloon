//! 意图级预算 (Intent Budget) —— 防"集体分摊变成集体失控"。
//!
//! 关键语义:
//! - 预算挂在**根意图**上, 子任务继承; 委托先申请授权再执行。
//! - `check_*` 只回答"**本该允许还是本该拦住**"(`BudgetDecision`), 由上层根据
//!   shadow/enforce 决定是否真的阻断 —— 影子模式下永远不阻断, 只把 `would_block` 记下来。
//! - 现金 (USD) 与调用次数/委托深度是**不同维度**, 分别记账, 不折算。

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// 谁承担成本 (结算账本的输入)。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PayerKind {
    /// 意图发起者自己
    Requester,
    /// 公共资源池
    PublicPool,
    /// 这个意图的赞助者
    Sponsor,
    /// 已登记并同意被使用的成员贡献
    Contributor,
    /// 资源提供方自己吃下成本 (免费供给)
    Provider,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Payer {
    pub kind: PayerKind,
    pub id: String,
    /// 是否**明确授权**被扣费。未授权的 payer 一律不能记分摊。
    pub authorized: bool,
    /// 这一方最多愿意吃多少 (USD; None = 不设上限)。
    /// 有上限才能表达"多方共同承担": 第一个 payer 吃满自己的额度, 剩下的才轮到下一个;
    /// 没有上限时它就吃满整笔成本 (默认语义 = 单方承担)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_usd: Option<f64>,
}

/// 预算耗尽后的行为。默认 `Stop`: 不偷偷换到用户自付费 API。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum ExhaustionPolicy {
    /// 停下并如实报"预算耗尽"
    #[default]
    Stop,
    /// 降级到更便宜的合格资源 (仍需满足隐私/质量)
    Degrade,
    /// 排队等资源
    Queue,
    /// 请求发起者/赞助者追加授权 (不自动超额)
    AskAuthorization,
}


/// 隐私策略: 哪些数据可以离开本机。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrivacyPolicy {
    /// 允许调用外部 API (false ⇒ 只许本地模型)
    pub allow_external: bool,
    /// 允许把敏感内容送出去 (默认 false)
    pub allow_sensitive: bool,
}

impl Default for PrivacyPolicy {
    fn default() -> Self {
        Self {
            allow_external: true,
            allow_sensitive: false,
        }
    }
}

/// 一个意图的资源授权 (根意图携带; 子任务继承)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetLimits {
    /// 现金上限 (USD; None = 不限)
    #[serde(default)]
    pub max_cash_usd: Option<f64>,
    /// 最多多少次模型调用
    #[serde(default)]
    pub max_model_calls: Option<u32>,
    /// 最多多少次工具调用
    #[serde(default)]
    pub max_tool_calls: Option<u32>,
    /// 最多多少个子任务
    #[serde(default = "default_delegations")]
    pub max_delegations: u32,
    /// 最大委托深度 (防止 A→B→C→… 无限套)
    #[serde(default = "default_depth")]
    pub max_depth: u32,
    /// 允许的 provider (None = 不限制)
    #[serde(default)]
    pub allowed_providers: Option<Vec<String>>,
    /// 质量下限 (低于它的资源不许用)
    #[serde(default)]
    pub min_quality: Option<f64>,
    #[serde(default)]
    pub privacy: PrivacyPolicy,
    #[serde(default)]
    pub on_exhausted: ExhaustionPolicy,
    /// 成本承担顺序 (前一个不够才用下一个)
    #[serde(default)]
    pub payers: Vec<Payer>,
}

fn default_delegations() -> u32 {
    8
}
fn default_depth() -> u32 {
    3
}

impl Default for BudgetLimits {
    fn default() -> Self {
        Self {
            max_cash_usd: None,
            max_model_calls: None,
            max_tool_calls: None,
            max_delegations: default_delegations(),
            max_depth: default_depth(),
            allowed_providers: None,
            min_quality: None,
            privacy: PrivacyPolicy::default(),
            on_exhausted: ExhaustionPolicy::default(),
            payers: vec![Payer {
                kind: PayerKind::Requester,
                id: "requester".into(),
                authorized: true,
                max_usd: None,
            }],
        }
    }
}

/// 一个根意图的预算 (含实时状态)。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntentBudget {
    pub intent_id: String,
    pub limits: BudgetLimits,
}

/// 判定结果: **只说"本该怎样"**, 是否真的拦由上层 (shadow/enforce) 决定。
#[derive(Debug, Clone, PartialEq)]
pub enum BudgetDecision {
    Allow,
    /// 本该被拦: (规则名, 说明)。影子模式下只记录, 不阻断。
    WouldBlock {
        rule: &'static str,
        detail: String,
    },
}

impl BudgetDecision {
    pub fn is_block(&self) -> bool {
        matches!(self, BudgetDecision::WouldBlock { .. })
    }
    pub fn rule(&self) -> Option<&'static str> {
        match self {
            BudgetDecision::Allow => None,
            BudgetDecision::WouldBlock { rule, .. } => Some(rule),
        }
    }
    pub fn detail(&self) -> Option<&str> {
        match self {
            BudgetDecision::Allow => None,
            BudgetDecision::WouldBlock { detail, .. } => Some(detail.as_str()),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BudgetStateView {
    pub intent_id: String,
    pub spent_usd: f64,
    pub model_calls: u32,
    pub tool_calls: u32,
    pub delegations: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_cash_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_model_calls: Option<u32>,
    /// 触顶的维度 (空 = 还没触顶)
    #[serde(default)]
    pub exhausted_by: Vec<String>,
}

/// 运行时预算守卫: 计数 + 判定, 不带任何"执行"能力。
pub struct BudgetGuard {
    budget: IntentBudget,
    spent_micro_usd: AtomicU64,
    model_calls: AtomicU32,
    tool_calls: AtomicU32,
    delegations: AtomicU32,
    /// 未定价事件数 (没有金额的调用不算进现金, 但会计数)
    unpriced_calls: AtomicU32,
    noted: Mutex<Vec<String>>,
    /// 预留锁: 「判定 + 计数」必须在同一把锁里 —— 否则 N 个并发调用会同时
    /// 读到 calls=0 全部判"允许", 一条 @N 的群消息就能把上限击穿 N 倍。
    reserve_lock: Mutex<()>,
}

impl BudgetGuard {
    pub fn new(budget: IntentBudget) -> Self {
        Self {
            budget,
            spent_micro_usd: AtomicU64::new(0),
            model_calls: AtomicU32::new(0),
            tool_calls: AtomicU32::new(0),
            delegations: AtomicU32::new(0),
            unpriced_calls: AtomicU32::new(0),
            noted: Mutex::new(vec![]),
            reserve_lock: Mutex::new(()),
        }
    }

    pub fn intent_id(&self) -> &str {
        &self.budget.intent_id
    }

    pub fn limits(&self) -> &BudgetLimits {
        &self.budget.limits
    }

    /// provider 是否在授权名单内
    fn provider_allowed(&self, provider: &str) -> bool {
        match &self.budget.limits.allowed_providers {
            None => true,
            Some(list) => list.iter().any(|p| p == provider),
        }
    }

    /// 调用前的判定 (模型调用)。
    pub fn check_model_call(&self, provider: &str, est_cost: Option<f64>) -> BudgetDecision {
        if !self.provider_allowed(provider) {
            return BudgetDecision::WouldBlock {
                rule: "provider_not_allowed",
                detail: format!("provider `{provider}` 不在该意图的授权名单内"),
            };
        }
        if !self.budget.limits.privacy.allow_external && provider != "local" {
            return BudgetDecision::WouldBlock {
                rule: "privacy_no_external",
                detail: format!("该意图禁止外部调用, `{provider}` 属于外部"),
            };
        }
        let calls = self.model_calls.load(Ordering::Relaxed);
        if let Some(max) = self.budget.limits.max_model_calls {
            if calls >= max {
                return BudgetDecision::WouldBlock {
                    rule: "max_model_calls",
                    detail: format!("模型调用已达上限 {max}"),
                };
            }
        }
        let spent = self.spent_usd();
        if let Some(max) = self.budget.limits.max_cash_usd {
            if spent >= max {
                return BudgetDecision::WouldBlock {
                    rule: "max_cash",
                    detail: format!("现金已用 {spent:.6} ≥ 上限 {max:.6}"),
                };
            }
            if let Some(c) = est_cost {
                if spent + c > max + 1e-12 {
                    return BudgetDecision::WouldBlock {
                        rule: "max_cash_would_exceed",
                        detail: format!("本次预计 {c:.6} 会超过上限 {max:.6}"),
                    };
                }
            }
        }
        BudgetDecision::Allow
    }

    pub fn check_tool_call(&self, _tool: &str) -> BudgetDecision {
        if let Some(max) = self.budget.limits.max_tool_calls {
            if self.tool_calls.load(Ordering::Relaxed) >= max {
                return BudgetDecision::WouldBlock {
                    rule: "max_tool_calls",
                    detail: format!("工具调用已达上限 {max}"),
                };
            }
        }
        BudgetDecision::Allow
    }

    /// 委托判定: 深度 + 子任务数 (委托爆炸防护)。
    pub fn check_delegation(&self, depth: u32) -> BudgetDecision {
        if depth > self.budget.limits.max_depth {
            return BudgetDecision::WouldBlock {
                rule: "max_depth",
                detail: format!("委托深度 {depth} 超过上限 {}", self.budget.limits.max_depth),
            };
        }
        if self.delegations.load(Ordering::Relaxed) >= self.budget.limits.max_delegations {
            return BudgetDecision::WouldBlock {
                rule: "max_delegations",
                detail: format!("子任务数已达上限 {}", self.budget.limits.max_delegations),
            };
        }
        BudgetDecision::Allow
    }

    /// **原子预留**：判定通过就当场计数（不是等响应回来再补）。
    ///
    /// 并发扇出下这是唯一能让 `max_model_calls` 真正生效的写法：
    /// 先占额度再发请求；请求失败/被取消时用 `reconcile_model_call` 退还。
    pub fn try_reserve_model_call(&self, provider: &str, est_cost: Option<f64>) -> BudgetDecision {
        let _g = self.reserve_lock.lock().unwrap_or_else(|e| e.into_inner());
        let d = self.check_model_call(provider, est_cost);
        if !d.is_block() {
            self.record_model_call(est_cost);
        }
        d
    }

    /// 用实际用量对账：返回需要补记/退还的现金差额（正=补记, 负=退）。
    ///
    /// 承接 `try_reserve_model_call` 预扣的估算值；`actual=None` 表示这次拿不到金额
    /// （失败或无价格表），预扣原样留下，不猜。
    pub fn reconcile_model_call(&self, reserved: Option<f64>, actual: Option<f64>) -> Option<f64> {
        let (Some(r), Some(a)) = (reserved, actual) else {
            return None;
        };
        if !(r.is_finite() && a.is_finite()) {
            return None;
        }
        let delta = a - r;
        if delta >= 0.0 {
            self.spent_micro_usd
                .fetch_add((delta * 1_000_000.0).round() as u64, Ordering::Relaxed);
        } else {
            let back = ((-delta) * 1_000_000.0).round() as u64;
            // 用 CAS 退，避免把别人预扣的额度退成负数
            let mut cur = self.spent_micro_usd.load(Ordering::Relaxed);
            loop {
                let next = cur.saturating_sub(back);
                match self.spent_micro_usd.compare_exchange_weak(
                    cur, next, Ordering::Relaxed, Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(c) => cur = c,
                }
            }
        }
        Some(delta)
    }

    pub fn record_model_call(&self, cost_usd: Option<f64>) {
        self.model_calls.fetch_add(1, Ordering::Relaxed);
        match cost_usd {
            Some(c) if c.is_finite() && c >= 0.0 => {
                self.spent_micro_usd
                    .fetch_add((c * 1_000_000.0).round() as u64, Ordering::Relaxed);
            }
            _ => {
                self.unpriced_calls.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    pub fn record_tool_call(&self) {
        self.tool_calls.fetch_add(1, Ordering::Relaxed);
    }

    pub fn record_delegation(&self) {
        self.delegations.fetch_add(1, Ordering::Relaxed);
    }

    /// 记下"本该被拦"的事实 (影子模式的核心产物)
    pub fn note_would_block(&self, rule: &str, detail: &str) {
        let mut n = self.noted.lock().unwrap();
        n.push(format!("{rule}: {detail}"));
    }

    pub fn would_block_notes(&self) -> Vec<String> {
        self.noted.lock().unwrap().clone()
    }

    pub fn spent_usd(&self) -> f64 {
        self.spent_micro_usd.load(Ordering::Relaxed) as f64 / 1_000_000.0
    }

    pub fn state(&self) -> BudgetStateView {
        let mut exhausted_by = vec![];
        let spent = self.spent_usd();
        if let Some(max) = self.budget.limits.max_cash_usd {
            if spent >= max {
                exhausted_by.push("max_cash".to_string());
            }
        }
        let calls = self.model_calls.load(Ordering::Relaxed);
        if let Some(max) = self.budget.limits.max_model_calls {
            if calls >= max {
                exhausted_by.push("max_model_calls".to_string());
            }
        }
        let deleg = self.delegations.load(Ordering::Relaxed);
        if deleg >= self.budget.limits.max_delegations {
            exhausted_by.push("max_delegations".to_string());
        }
        BudgetStateView {
            intent_id: self.budget.intent_id.clone(),
            spent_usd: spent,
            model_calls: calls,
            tool_calls: self.tool_calls.load(Ordering::Relaxed),
            delegations: deleg,
            max_cash_usd: self.budget.limits.max_cash_usd,
            max_model_calls: self.budget.limits.max_model_calls,
            exhausted_by,
        }
    }

    pub fn unpriced_calls(&self) -> u32 {
        self.unpriced_calls.load(Ordering::Relaxed)
    }
}
