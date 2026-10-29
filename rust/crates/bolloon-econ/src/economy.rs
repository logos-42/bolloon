//! 影子经济层门面: 把计量 / 预算 / 供给 / 贡献 / 结算缝在一起, 但**只观察不干预**。
//!
//! 调用方 (CLI/Web 的 KernelLoop 观察者) 只需要在边界处调:
//! `on_model_call` / `on_tool_call` / `on_delegation` / `end_task`,
//! 然后可以用 `report()` 把一整轮的真实成本、本该被拦的规则、影子路由结论一次拿出来。
//!
//! 默认 `EconomicConfig.enabled=false` ⇒ `ShadowEconomy::disabled()` 直接空转 (零记录、零行为)。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bolloon_config::EconomicConfig;

use crate::budget::{BudgetDecision, BudgetGuard, BudgetStateView, IntentBudget, PayerKind};
use crate::contribution::{ContributionLedger, ContributionTotals};
use crate::meter::{MeterEvent, MeterStatus, MeterTotals, RecordOutcome, ResourceKind, UsageMeter};
use crate::price::PriceTable;
use crate::provider::{ProviderRegistry, ProviderSpec, RoutingDecision};
use crate::settlement::{CostShare, PublicPool, SettlementLedger, SettlementState};

/// 一次调用的归属上下文 (谁发起、属于哪个意图/任务)。
#[derive(Debug, Clone, Default)]
pub struct CallCtx {
    pub intent_id: Option<String>,
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub requester: String,
    pub executor: String,
    /// 运行面: cli / web / cron / subagent
    pub surface: String,
}

impl CallCtx {
    pub fn new(task_id: impl Into<String>, requester: impl Into<String>) -> Self {
        let requester = requester.into();
        Self {
            intent_id: None,
            task_id: task_id.into(),
            parent_task_id: None,
            executor: requester.clone(),
            requester,
            surface: "unknown".into(),
        }
    }
    pub fn with_intent(mut self, intent: impl Into<String>) -> Self {
        self.intent_id = Some(intent.into());
        self
    }
    pub fn with_parent(mut self, parent: impl Into<String>) -> Self {
        self.parent_task_id = Some(parent.into());
        self
    }
    pub fn with_surface(mut self, s: &str) -> Self {
        self.surface = s.to_string();
        self
    }
}

/// "本该被拦"的记录 (影子模式的主要产物)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WouldBlockNote {
    pub at: String,
    pub intent_id: String,
    pub task_id: String,
    pub rule: String,
    pub detail: String,
    /// 影子模式下是否真的放行了 (本期恒 true)
    pub allowed_in_shadow: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EconomyReport {
    pub enabled: bool,
    pub mode: String,
    pub metering_enabled: bool,
    pub enforcement_enabled: bool,
    pub settlement_enabled: bool,
    pub price_version: Option<String>,
    pub meter: MeterTotals,
    pub by_intent: BTreeMap<String, MeterTotals>,
    pub budgets: Vec<BudgetStateView>,
    pub would_block: Vec<WouldBlockNote>,
    pub shadow_routing: Vec<RoutingDecision>,
    pub pool: PublicPool,
    pub settlements_total_usd: f64,
    pub settlements_by_payer: BTreeMap<String, f64>,
    pub contributions: ContributionTotals,
    pub providers: Vec<ProviderSpec>,
    pub tasks_total: u64,
    pub tasks_succeeded: u64,
    /// 成功且零现金成本的意图占比 (免费任务完成率; None = 还没有样本)
    pub free_task_completion_rate: Option<f64>,
    pub meter_failures: u64,
}

/// 影子经济层 (可开关; 关闭时是零成本空对象)。
pub struct ShadowEconomy {
    cfg: EconomicConfig,
    meter: UsageMeter,
    prices: PriceTable,
    registry: ProviderRegistry,
    contributions: ContributionLedger,
    settlements: SettlementLedger,
    guards: Mutex<BTreeMap<String, Arc<BudgetGuard>>>,
    would_block: Mutex<Vec<WouldBlockNote>>,
    shadow_routing: Mutex<Vec<RoutingDecision>>,
    tasks_total: AtomicU64,
    tasks_ok: AtomicU64,
    meter_failures: AtomicU64,
    dir: Option<PathBuf>,
}

impl ShadowEconomy {
    /// 关闭态: 什么都不记
    pub fn disabled() -> Self {
        Self::new(EconomicConfig::default(), None)
    }

    /// 按配置构造。`dir` 为落地目录 (None = 纯内存, 单测/临时)。
    pub fn new(cfg: EconomicConfig, dir: Option<&Path>) -> Self {
        let prices = match (&cfg.price_table_file, dir) {
            (Some(f), Some(d)) => {
                let p = if Path::new(f).is_absolute() {
                    PathBuf::from(f)
                } else {
                    d.join(f)
                };
                match PriceTable::from_file(&p) {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::warn!(path = %p.display(), error = %e, "价格表不可用, 金额将留空 (不编价格)");
                        PriceTable::empty()
                    }
                }
            }
            _ => PriceTable::empty(),
        };
        let meter = UsageMeter::new(dir.map(|d| d.join("econ-meter.jsonl")));
        let registry = ProviderRegistry::new(dir.map(|d| d.join("econ-providers.json")));
        let contributions = ContributionLedger::new(dir.map(|d| d.join("econ-contributions.json")));
        let pool = PublicPool {
            cash_available_usd: cfg.pool_cash_available_usd,
            ..Default::default()
        };
        let settlements = SettlementLedger::new(dir.map(|d| d.join("econ-settlements.json")), pool);
        Self {
            cfg,
            meter,
            prices,
            registry,
            contributions,
            settlements,
            guards: Mutex::new(BTreeMap::new()),
            would_block: Mutex::new(vec![]),
            shadow_routing: Mutex::new(vec![]),
            tasks_total: AtomicU64::new(0),
            tasks_ok: AtomicU64::new(0),
            meter_failures: AtomicU64::new(0),
            dir: dir.map(|d| d.to_path_buf()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.cfg.enabled
    }
    pub fn metering(&self) -> bool {
        self.cfg.enabled && self.cfg.metering_enabled
    }
    /// 是否真的强制 (enforce 模式 + 显式开强制预算)
    pub fn enforcement(&self) -> bool {
        self.cfg.enabled
            && self.cfg.mode == bolloon_config::EconomicMode::Enforce
            && self.cfg.budget_enforcement_enabled
    }
    pub fn settlement_enabled(&self) -> bool {
        self.cfg.enabled && self.cfg.contribution_settlement_enabled
    }
    pub fn config(&self) -> &EconomicConfig {
        &self.cfg
    }
    pub fn meter(&self) -> &UsageMeter {
        &self.meter
    }
    pub fn registry(&self) -> &ProviderRegistry {
        &self.registry
    }
    pub fn contributions(&self) -> &ContributionLedger {
        &self.contributions
    }
    pub fn settlements(&self) -> &SettlementLedger {
        &self.settlements
    }
    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// 取/建一个意图的预算守卫 (同一意图共享计数)
    pub fn guard_for(
        &self,
        intent_id: &str,
        limits: crate::budget::BudgetLimits,
    ) -> Arc<BudgetGuard> {
        let mut w = self.guards.lock().unwrap();
        w.entry(intent_id.to_string())
            .or_insert_with(|| {
                Arc::new(BudgetGuard::new(IntentBudget {
                    intent_id: intent_id.to_string(),
                    limits,
                }))
            })
            .clone()
    }

    fn guard_for_ctx(&self, ctx: &CallCtx) -> Arc<BudgetGuard> {
        let intent = ctx
            .intent_id
            .clone()
            .unwrap_or_else(|| format!("task:{}", ctx.task_id));
        let limits = crate::budget::BudgetLimits {
            max_cash_usd: self.cfg.default_intent_budget_usd,
            max_model_calls: self.cfg.default_max_model_calls,
            max_depth: self.cfg.default_max_delegation_depth,
            ..Default::default()
        };
        self.guard_for(&intent, limits)
    }

    fn note_block(&self, ctx: &CallCtx, d: &BudgetDecision) {
        if let BudgetDecision::WouldBlock { rule, detail } = d {
            let mut w = self.would_block.lock().unwrap();
            w.push(WouldBlockNote {
                at: chrono::Utc::now().to_rfc3339(),
                intent_id: ctx
                    .intent_id
                    .clone()
                    .unwrap_or_else(|| format!("task:{}", ctx.task_id)),
                task_id: ctx.task_id.clone(),
                rule: rule.to_string(),
                detail: detail.clone(),
                allowed_in_shadow: !self.enforcement(),
            });
            if w.len() > 500 {
                w.remove(0);
            }
        }
    }

    /// 记一次模型调用。返回预算判定 (enforce 模式下调用方据此决定是否真的拦)。
    #[allow(clippy::too_many_arguments)]
    pub fn on_model_call(
        &self,
        ctx: &CallCtx,
        provider: &str,
        model: &str,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        tokens_cache: Option<u32>,
        status: MeterStatus,
        elapsed_ms: u64,
        extra_evidence: Option<serde_json::Value>,
    ) -> BudgetDecision {
        if !self.metering() {
            return BudgetDecision::Allow;
        }
        let guard = self.guard_for_ctx(ctx);
        let est = self
            .prices
            .estimate(provider, model, tokens_in, tokens_out, tokens_cache);
        let decision = guard.check_model_call(provider, est);
        if decision.is_block() {
            self.note_block(ctx, &decision);
            guard.note_would_block(
                decision.rule().unwrap_or("unknown"),
                decision.detail().unwrap_or(""),
            );
        }

        let mut e = MeterEvent::new(
            format!(
                "m-{}-{}",
                ctx.task_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            ResourceKind::ModelCall,
            ctx.task_id.clone(),
            provider,
        );
        e.intent_id = ctx.intent_id.clone();
        e.parent_task_id = ctx.parent_task_id.clone();
        e.requester = ctx.requester.clone();
        e.executor = ctx.executor.clone();
        e.model = Some(model.to_string());
        e.tokens_in = tokens_in;
        e.tokens_out = tokens_out;
        e.tokens_cache = tokens_cache;
        e.elapsed_ms = elapsed_ms;
        e.status = status;
        if self.prices.has_prices() {
            e.price_version = Some(self.prices.version.clone());
            e.cost_usd_estimated = est;
        }
        e.evidence = extra_evidence;
        match self.meter.record(e.clone()) {
            RecordOutcome::New => {}
            RecordOutcome::Duplicate => {}
        }
        guard.record_model_call(est);

        // 结算: 只有显式开启时才生成草稿 (默认关: 不产生任何可兑现承诺)
        if self.settlement_enabled() {
            if let Some(cost) = est {
                if cost > 0.0 {
                    let shares = self.shares_for(&guard, cost);
                    if !shares.is_empty() {
                        let basis = format!(
                            "price_version={} model={model} provider={provider}",
                            self.prices.version
                        );
                        match self.settlements.settle(
                            vec![e.event_id.clone()],
                            cost,
                            shares,
                            &basis,
                            SettlementState::Draft,
                        ) {
                            Ok(_) => {}
                            Err(err) => {
                                self.meter_failures.fetch_add(1, Ordering::Relaxed);
                                tracing::warn!(error = %err, "影子结算失败 (不影响调用)");
                            }
                        }
                    }
                }
            }
        }
        decision
    }

    /// 记一次工具调用
    pub fn on_tool_call(
        &self,
        ctx: &CallCtx,
        tool: &str,
        ok: bool,
        elapsed_ms: u64,
        evidence: Option<serde_json::Value>,
    ) -> BudgetDecision {
        if !self.metering() {
            return BudgetDecision::Allow;
        }
        let guard = self.guard_for_ctx(ctx);
        let decision = guard.check_tool_call(tool);
        if decision.is_block() {
            self.note_block(ctx, &decision);
        }
        let mut e = MeterEvent::new(
            format!(
                "t-{}-{}",
                ctx.task_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            ResourceKind::ToolCall,
            ctx.task_id.clone(),
            "local".to_string(),
        );
        e.intent_id = ctx.intent_id.clone();
        e.parent_task_id = ctx.parent_task_id.clone();
        e.requester = ctx.requester.clone();
        e.executor = ctx.executor.clone();
        e.tool = Some(tool.to_string());
        e.elapsed_ms = elapsed_ms;
        e.status = if ok {
            MeterStatus::Ok
        } else {
            MeterStatus::Failed
        };
        e.evidence = evidence;
        self.meter.record(e);
        guard.record_tool_call();
        decision
    }

    /// 记一次委托 (子任务)
    pub fn on_delegation(&self, ctx: &CallCtx, child_task_id: &str, depth: u32) -> BudgetDecision {
        if !self.metering() {
            return BudgetDecision::Allow;
        }
        let guard = self.guard_for_ctx(ctx);
        let decision = guard.check_delegation(depth);
        if decision.is_block() {
            self.note_block(ctx, &decision);
        }
        let mut e = MeterEvent::new(
            format!(
                "d-{}-{}",
                child_task_id,
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            ),
            ResourceKind::Delegation,
            ctx.task_id.clone(),
            ctx.executor.clone(),
        );
        e.intent_id = ctx.intent_id.clone();
        e.parent_task_id = Some(ctx.task_id.clone());
        e.requester = ctx.requester.clone();
        e.executor = ctx.executor.clone();
        e.tool = Some(child_task_id.to_string());
        e.status = MeterStatus::Ok;
        self.meter.record(e);
        guard.record_delegation();
        decision
    }

    /// 影子路由: 记录"本会选谁", **不改变真实调用**。
    pub fn note_shadow_routing(&self, d: RoutingDecision) {
        if !self.cfg.enabled || !self.cfg.community_routing_enabled {
            return;
        }
        let mut w = self.shadow_routing.lock().unwrap();
        w.push(d);
        if w.len() > 200 {
            w.remove(0);
        }
    }

    pub fn end_task(&self, _task_id: &str, ok: bool) {
        if !self.cfg.enabled {
            return;
        }
        self.tasks_total.fetch_add(1, Ordering::Relaxed);
        if ok {
            self.tasks_ok.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// 把已确认贡献现金同步进公共池 (只有 Confirmed 才进)
    pub fn sync_pool_from_contributions(&self) {
        let t = self.contributions.totals();
        self.settlements
            .set_pool_cash(self.cfg.pool_cash_available_usd);
        self.settlements.set_contribution_cash(t.cash_confirmed_usd);
    }

    /// 按**授权 payer 顺序**分摊: 每一方最多吃自己声明的额度 (`max_usd`),
    /// 剩下的顺延到下一个 —— 这才是"多方共同承担"; 未声明额度的一方吃满剩余 (默认单方承担)。
    /// 恒有 `Σ shares ≤ cost` 且每方 `authorized=true`。
    fn shares_for(&self, guard: &BudgetGuard, cost: f64) -> Vec<CostShare> {
        let mut out = vec![];
        let mut left = cost;
        for p in &guard.limits().payers {
            if left <= 0.0 {
                break;
            }
            if !p.authorized {
                continue;
            }
            let amount = match p.max_usd {
                Some(cap) if cap.is_finite() && cap >= 0.0 => left.min(cap),
                Some(_) => 0.0, // 非法额度 = 一分不出 (不猜)
                None => left,
            };
            if amount <= 0.0 {
                continue;
            }
            out.push(CostShare {
                payer_id: p.id.clone(),
                kind: p.kind,
                amount_usd: amount,
                authorized: true,
            });
            left -= amount;
        }
        // 没有人授权 ⇒ 不结算 (没人该付, 也不许偷偷记在别人头上)
        out
    }

    pub fn report(&self) -> EconomyReport {
        let meter = self.meter.totals();
        let tasks_total = self.tasks_total.load(Ordering::Relaxed);
        let tasks_succeeded = self.tasks_ok.load(Ordering::Relaxed);
        let by_intent = self.meter.totals_by_intent();
        // 免费任务完成率 = 成功且零现金成本的意图 / 全部有记账的意图
        let priced_intents: Vec<&MeterTotals> = by_intent.values().collect();
        let free = priced_intents
            .iter()
            .filter(|t| t.cost_usd_estimated == 0.0 && t.cost_usd_confirmed == 0.0)
            .count();
        let free_rate = if priced_intents.is_empty() {
            None
        } else {
            Some(free as f64 / priced_intents.len() as f64)
        };
        EconomyReport {
            enabled: self.cfg.enabled,
            mode: format!("{:?}", self.cfg.mode).to_lowercase(),
            metering_enabled: self.cfg.metering_enabled,
            enforcement_enabled: self.enforcement(),
            settlement_enabled: self.settlement_enabled(),
            price_version: if self.prices.has_prices() {
                Some(self.prices.version.clone())
            } else {
                None
            },
            meter,
            by_intent,
            budgets: self
                .guards
                .lock()
                .unwrap()
                .values()
                .map(|g| g.state())
                .collect(),
            would_block: self.would_block.lock().unwrap().clone(),
            shadow_routing: self.shadow_routing.lock().unwrap().clone(),
            pool: self.settlements.pool(),
            settlements_total_usd: self.settlements.total_settled_usd(),
            settlements_by_payer: self.settlements.by_payer(),
            contributions: self.contributions.totals(),
            providers: self.registry.list(),
            tasks_total,
            tasks_succeeded,
            free_task_completion_rate: free_rate,
            meter_failures: self.meter_failures.load(Ordering::Relaxed),
        }
    }
}

/// 默认 payer 顺序: 请求者自己 (什么都不配置时也不替别人扣钱)。
pub fn default_payers() -> Vec<crate::budget::Payer> {
    vec![crate::budget::Payer {
        kind: PayerKind::Requester,
        id: "requester".into(),
        authorized: true,
        max_usd: None,
    }]
}
