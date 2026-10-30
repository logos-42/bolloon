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
    /// 节点当日：已用调用数 / 已用现金；以及是否设了日上限
    pub daily_model_calls: u64,
    pub daily_cash_usd: f64,
    pub daily_max_model_calls: Option<u32>,
    pub daily_max_cash_usd: Option<f64>,
    /// **现金闸是否真的能生效**（没价格表 ⇒ 金额维度根本不存在, 不许假装有闸）
    pub cash_gate_enabled: bool,
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
    /// 节点级"当天"预算（跨意图的总闸；意图预算挡不住"换意图绕闸"）
    day: Mutex<String>,
    day_calls: AtomicU64,
    day_micro_usd: AtomicU64,
    day_lock: Mutex<()>,
    /// 每个 provider|model 最近一次的真实成本 —— 调用前拿它当"预扣金额"的代理。
    /// 没有历史（第一次调用 / 无价格表）就返回 None ⇒ 只占调用次数，不虚报金额。
    last_cost: Mutex<BTreeMap<String, f64>>,
    /// 每主体当日已用额度（`allowance_enabled` 才用于拦截；关了只观察）
    principal_used: Mutex<BTreeMap<String, u32>>,
    /// 免疫系统（quorum sensing：同轮定级，单点不定罪，停手自愈）
    immune: crate::immune::ImmuneSystem,
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
            day: Mutex::new(chrono::Local::now().format("%Y-%m-%d").to_string()),
            day_calls: AtomicU64::new(0),
            day_micro_usd: AtomicU64::new(0),
            day_lock: Mutex::new(()),
            last_cost: Mutex::new(BTreeMap::new()),
            principal_used: Mutex::new(BTreeMap::new()),
            immune: crate::immune::ImmuneSystem::default(),
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

    /// 免疫系统：谁都可以报警，但单点不能定罪（≥3 限制 / ≥5 隔离），停手自动衰减
    pub fn immune(&self) -> &crate::immune::ImmuneSystem {
        &self.immune
    }

    /// 从**可核验事实**汇总一个主体的历史（不接受自我申报）：
    /// 成功/失败意图、零现金意图、已验收贡献、已到账现金、被拦次数、近期调用。
    pub fn history_for(&self, principal: &str) -> crate::allowance::PrincipalHistory {
        use std::collections::BTreeMap as M;
        let mut intents: M<String, (bool, bool, f64)> = M::new(); // (has_ok, has_fail, cost)
        let mut calls = 0u32;
        for e in self.meter.events() {
            // 只认明确归属：无主调用（requester 为空）不计入任何人的历史（不白送额度）
            if e.requester.is_empty() || e.requester != principal {
                continue;
            }
            let key = e.intent_id.clone().unwrap_or_else(|| e.task_id.clone());
            let entry = intents.entry(key).or_insert((false, false, 0.0));
            match e.status {
                crate::meter::MeterStatus::Ok => entry.0 = true,
                crate::meter::MeterStatus::Failed => entry.1 = true,
                _ => {}
            }
            if let Some(c) = e.cost_usd_estimated {
                entry.2 += c;
            }
            calls += 1;
        }
        let mut h = crate::allowance::PrincipalHistory {
            recent_calls: calls,
            ..Default::default()
        };
        for (_, (ok, fail, cost)) in intents {
            if ok {
                h.successful_intents += 1;
                if cost <= 0.0 {
                    h.zero_cost_intents += 1;
                }
            } else if fail {
                h.failed_intents += 1;
            }
        }
        for c in self.contributions.list() {
            if c.contributor == principal
                && matches!(c.state, crate::contribution::ContributionState::Confirmed)
            {
                h.verified_contributions += 1;
                h.confirmed_cash_usd += c.cash_usd.unwrap_or(0.0);
            }
        }
        h.blocked_attempts = *self
            .principal_used
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&format!("blocked:{principal}"))
            .unwrap_or(&0);
        h
    }

    /// 今天这个主体有多少额度（含理由），以及已用/剩余。
    pub fn allowance_for(&self, principal: &str, intent_kind: Option<&str>) -> crate::allowance::Allowance {
        self.roll_day();
        let day = self.day.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let h = self.history_for(principal);
        let mut a = crate::allowance::daily_allowance(
            principal,
            &day,
            &h,
            &self.allowance_policy(),
            intent_kind,
        );
        // 意识成长档案只**加**不减：倍率来自可核验行为（兑现承诺/分享/零现金成事），
        // 上限仍是日上限；指数本身不给人类看（见 consciousness::human_view）。
        let sig = crate::consciousness::Signals {
            promises_kept: h.successful_intents,
            shares_verified: h.verified_contributions,
            zero_cost_successes: h.zero_cost_intents,
            ..Default::default()
        };
        let prof = crate::consciousness::assess(principal, &sig);
        if prof.permissions.allowance_multiplier > 1.0 {
            let before = a.calls;
            a.calls = ((a.calls as f64) * prof.permissions.allowance_multiplier).round() as u32;
            a.reasons.push(format!(
                "成长加成 ×{:.2}（{} → {}；来自兑现承诺 {} 次、分享 {} 次、零现金成事 {} 次）",
                prof.permissions.allowance_multiplier,
                before,
                a.calls,
                h.successful_intents,
                h.verified_contributions,
                h.zero_cost_intents
            ));
            a.remaining = a.calls.saturating_sub(a.used);
        }
        let used = *self
            .principal_used
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(principal)
            .unwrap_or(&0);
        a.used = used;
        a.remaining = a.calls.saturating_sub(used);
        a
    }

    /// 额度策略：配置里没写就用默认（公开、可替换）
    fn allowance_policy(&self) -> crate::allowance::AllowancePolicy {
        crate::allowance::AllowancePolicy::default()
    }

    /// 调用前可用的金额估算 = 该 provider|model 最近一次的真实成本（没有就是 None）。
    /// 这是"预扣"的代理值：宁可这次不预扣，也不用拍脑袋的常数把用户挡在外面。
    pub fn estimate_cost(&self, provider: &str, model: &str) -> Option<f64> {
        self.last_cost
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&format!("{provider}|{model}"))
            .copied()
    }

    /// 当天日期（跨天自动清零日计数）
    fn roll_day(&self) {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut d = self.day.lock().unwrap_or_else(|e| e.into_inner());
        if *d != today {
            *d = today;
            self.day_calls.store(0, Ordering::Relaxed);
            self.day_micro_usd.store(0, Ordering::Relaxed);
        }
    }

    /// **调用前**：全局日闸 + 意图闸，原子预留。返回判定（enforce 下拦，shadow 下只记）。
    ///
    /// 顺序：先日闸（跨意图），再意图闸（本意图）。任一触顶都**不预留**，直接返回该判定。
    pub fn begin_model_call(&self, ctx: &CallCtx, provider: &str, est_cost: Option<f64>) -> BudgetDecision {
        if !self.metering() {
            return BudgetDecision::Allow;
        }
        self.roll_day();
        {
            let _g = self.day_lock.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(max) = self.cfg.daily_model_calls {
                if self.day_calls.load(Ordering::Relaxed) >= max as u64 {
                    let d = BudgetDecision::WouldBlock {
                        rule: "daily_max_model_calls",
                        detail: format!("今日模型调用已达节点上限 {max}"),
                    };
                    self.note_block(ctx, &d);
                    return d;
                }
            }
            if let Some(max) = self.cfg.daily_cash_usd {
                let spent = self.day_micro_usd.load(Ordering::Relaxed) as f64 / 1_000_000.0;
                if spent >= max {
                    let d = BudgetDecision::WouldBlock {
                        rule: "daily_max_cash",
                        detail: format!("今日现金已用 {spent:.4} ≥ 节点上限 {max:.4}"),
                    };
                    self.note_block(ctx, &d);
                    return d;
                }
            }
            // 诚信额度闸（按主体；开启后生效）：白嫖只限流到地板，永不封号
            if self.cfg.allowance_enabled {
                let principal = if ctx.requester.is_empty() {
                    "local".to_string()
                } else {
                    ctx.requester.clone()
                };
                let a = self.allowance_for(&principal, None);
                let used = *self
                    .principal_used
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&principal)
                    .unwrap_or(&0);
                if used >= a.calls {
                    let d = BudgetDecision::WouldBlock {
                        rule: "daily_allowance",
                        detail: format!(
                            "{} 今日额度已用完（{} / {}，档位 {}）；地板额度不会归零，明天自动恢复",
                            principal,
                            used,
                            a.calls,
                            a.tier.as_str()
                        ),
                    };
                    {
                        let mut m = self.principal_used.lock().unwrap_or_else(|e| e.into_inner());
                        *m.entry(format!("blocked:{principal}")).or_insert(0) += 1;
                    }
                    self.note_block(ctx, &d);
                    return d;
                }
            }
            // 日闸通过 ⇒ 当场占一个名额
            let d = self.guard_for_ctx(ctx).try_reserve_model_call(provider, est_cost);
            if d.is_block() {
                self.note_block(ctx, &d);
                self.guard_for_ctx(ctx).note_would_block(d.rule().unwrap_or("unknown"), d.detail().unwrap_or(""));
                return d;
            }
            self.day_calls.fetch_add(1, Ordering::Relaxed);
            if self.cfg.allowance_enabled {
                let principal = if ctx.requester.is_empty() {
                    "local".to_string()
                } else {
                    ctx.requester.clone()
                };
                let mut m = self.principal_used.lock().unwrap_or_else(|e| e.into_inner());
                *m.entry(principal).or_insert(0) += 1;
            }
            if let Some(c) = est_cost {
                if c.is_finite() && c > 0.0 {
                    self.day_micro_usd
                        .fetch_add((c * 1_000_000.0).round() as u64, Ordering::Relaxed);
                }
            }
            d
        }
    }

    /// **调用后**：记事件 + 用实际成本对账（预扣的是估算，实际未知就保持预扣）。
    // 一次模型调用的全部事实 (ctx/供应商/模型/输入输出 token/状态/耗时/证据/估算) 都要落账, 少一个就说不清成本
    #[allow(clippy::too_many_arguments)]
    pub fn finish_model_call(
        &self,
        ctx: &CallCtx,
        provider: &str,
        model: &str,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        status: MeterStatus,
        elapsed_ms: u64,
        extra_evidence: Option<serde_json::Value>,
        reserved_cost: Option<f64>,
    ) -> BudgetDecision {
        if !self.metering() {
            return BudgetDecision::Allow;
        }
        let actual = self
            .prices
            .estimate(provider, model, tokens_in, tokens_out, None);
        // 日账对账：有预扣就补差额；没预扣过（首次/无历史）就按实际记全额
        let day_delta = match (reserved_cost, actual) {
            (Some(r), Some(a)) => Some(a - r),
            (None, Some(a)) => Some(a),
            _ => None,
        };
        if let Some(delta) = day_delta {
            if delta > 0.0 {
                self.day_micro_usd
                    .fetch_add((delta * 1_000_000.0).round() as u64, Ordering::Relaxed);
            } else if delta < 0.0 {
                let back = ((-delta) * 1_000_000.0).round() as u64;
                let mut cur = self.day_micro_usd.load(Ordering::Relaxed);
                loop {
                    let next = cur.saturating_sub(back);
                    match self.day_micro_usd.compare_exchange_weak(
                        cur, next, Ordering::Relaxed, Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(c) => cur = c,
                    }
                }
            }
        }
        if let Some(a) = actual {
            self.last_cost
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(format!("{provider}|{model}"), a);
        }
        self.guard_for_ctx(ctx)
            .reconcile_model_call(reserved_cost, actual);
        self.on_model_call_record(ctx, provider, model, tokens_in, tokens_out, actual, status, elapsed_ms, extra_evidence)
    }

    /// 内部：只记账不再做预算判定（判定已在 begin 阶段做完）
    #[allow(clippy::too_many_arguments)]
    fn on_model_call_record(
        &self,
        ctx: &CallCtx,
        provider: &str,
        model: &str,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        cost: Option<f64>,
        status: MeterStatus,
        elapsed_ms: u64,
        extra_evidence: Option<serde_json::Value>,
    ) -> BudgetDecision {
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
        e.elapsed_ms = elapsed_ms;
        e.status = status;
        if self.prices.has_prices() {
            e.price_version = Some(self.prices.version.clone());
            e.cost_usd_estimated = cost;
        }
        e.evidence = extra_evidence;
        let _ = self.meter.record(e);
        BudgetDecision::Allow
    }

    /// 当前节点日账（给 /api/econ/report 与 UI 显示"今天还能花多少"）
    pub fn daily(&self) -> (u64, f64) {
        self.roll_day();
        (
            self.day_calls.load(Ordering::Relaxed),
            self.day_micro_usd.load(Ordering::Relaxed) as f64 / 1_000_000.0,
        )
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
            daily_model_calls: self.daily().0,
            daily_cash_usd: self.daily().1,
            daily_max_model_calls: self.cfg.daily_model_calls,
            daily_max_cash_usd: self.cfg.daily_cash_usd,
            cash_gate_enabled: self.prices.has_prices(),
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
