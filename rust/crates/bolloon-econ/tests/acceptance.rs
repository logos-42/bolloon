//! 经济层验收 (对应设计文档 A–F 六组判据)。
//!
//! 这些测试只碰 `bolloon-econ` 的公开 API, 每条都对应设计里一个**可证伪**的要求:
//! 关闭即零行为 / 成本可追溯 / 预算与委托不能失控 / 多方供给可替换 / 结算守恒 /
//! 密钥与正文不进账本。门红 = 设计没落地, 不是"环境问题"。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use bolloon_config::{EconomicConfig, EconomicMode};
use bolloon_econ::budget::{
    BudgetGuard, BudgetLimits, ExhaustionPolicy, IntentBudget, Payer, PrivacyPolicy,
};
use bolloon_econ::contribution::{
    Contribution, ContributionKind, ContributionLedger, ContributionState,
};
use bolloon_econ::meter::{MeterEvent, MeterStatus, RecordOutcome, ResourceKind, UsageMeter};
use bolloon_econ::price::PriceTable;
use bolloon_econ::provider::{
    ModelCapability, ProviderKind, ProviderRegistry, ProviderSpec, ProviderStatus, RouteRequest,
    RoutingPolicy, RoutingStrategy, StandardRouter,
};
use bolloon_econ::settlement::{CostShare, PublicPool, SettlementLedger, SettlementState};
use bolloon_econ::{BudgetDecision, CallCtx, ShadowEconomy};

// ───────────────────────── 夹具 ─────────────────────────

static SEQ: AtomicU64 = AtomicU64::new(0);

/// 每次一份独立临时目录, Drop 时删干净 (不留坟)。
struct Tmp(PathBuf);

impl Tmp {
    fn new(tag: &str) -> Self {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("bolloon-econ-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn metering_cfg() -> EconomicConfig {
    EconomicConfig {
        enabled: true,
        metering_enabled: true,
        ..Default::default()
    }
}

fn ctx(intent: &str, task: &str) -> CallCtx {
    CallCtx::new(task, "leo")
        .with_intent(intent)
        .with_surface("test")
}

fn model(model: &str, quality: Option<f64>) -> ModelCapability {
    ModelCapability {
        model: model.to_string(),
        quality,
        max_context: None,
        tools: true,
    }
}

// ───────────────── A. 关闭即零行为 (向后兼容) ─────────────────

#[test]
fn default_config_is_off_and_shadow() {
    let c = EconomicConfig::default();
    assert!(!c.enabled, "经济层默认必须关闭");
    assert_eq!(c.mode, EconomicMode::Shadow, "打开后也默认影子模式");
    assert!(!c.budget_enforcement_enabled);
    assert!(!c.community_routing_enabled);
    assert!(!c.contribution_settlement_enabled);
    assert_eq!(c.pool_cash_available_usd, 0.0);
}

#[test]
fn disabled_economy_records_nothing_and_allows_everything() {
    let econ = ShadowEconomy::new(EconomicConfig::default(), None);
    assert!(!econ.enabled());

    let c = ctx("intent-off", "t1");
    for _ in 0..3 {
        let d = econ.on_model_call(
            &c,
            "api",
            "m",
            Some(10),
            Some(10),
            None,
            MeterStatus::Ok,
            5,
            None,
        );
        assert!(matches!(d, BudgetDecision::Allow), "关闭态不许产生任何判定");
        let d = econ.on_tool_call(&c, "shell", true, 3, None);
        assert!(matches!(d, BudgetDecision::Allow));
        let d = econ.on_delegation(&c, "child", 3);
        assert!(matches!(d, BudgetDecision::Allow));
    }
    econ.end_task("t1", true);

    let r = econ.report();
    assert!(!r.enabled);
    assert_eq!(r.meter.events, 0, "关闭态零记账");
    assert_eq!(r.meter.model_calls, 0);
    assert!(r.would_block.is_empty());
    assert_eq!(r.tasks_total, 0, "关闭态连任务计数都不动");
    assert!(r.settlements_total_usd == 0.0);
}

#[test]
fn disabled_variant_matches_default() {
    let econ = ShadowEconomy::disabled();
    assert!(!econ.enabled());
    let c = ctx("i", "t");
    assert!(matches!(
        econ.on_model_call(
            &c,
            "api",
            "m",
            Some(1),
            Some(1),
            None,
            MeterStatus::Ok,
            1,
            None
        ),
        BudgetDecision::Allow
    ));
    assert_eq!(econ.report().meter.events, 0);
}

// ───────────────── B. 成本计量 (可追溯 / 不编价格) ─────────────────

#[test]
fn price_table_computes_real_cost_and_stamps_version() {
    let tmp = Tmp::new("price");
    std::fs::write(
        tmp.path().join("prices.json"),
        r#"{"version":"2026-10-29","effective_from":"2026-10-29T00:00:00Z","entries":[
            {"provider":"api","model":"m1","usd_per_mtok_in":0.5,"usd_per_mtok_out":1.5,"source_note":"官方价目页"}
        ]}"#,
    )
    .unwrap();

    let mut cfg = metering_cfg();
    cfg.price_table_file = Some("prices.json".into());
    let econ = ShadowEconomy::new(cfg, Some(tmp.path()));

    let c = ctx("intent-1", "t1");
    let d = econ.on_model_call(
        &c,
        "api",
        "m1",
        Some(1_000_000),
        Some(1_000_000),
        None,
        MeterStatus::Ok,
        120,
        None,
    );
    assert!(matches!(d, BudgetDecision::Allow));

    let ev = &econ.meter().events()[0];
    // (1e6 * 0.5 + 1e6 * 1.5) / 1e6 = 2.0 USD
    assert!((ev.cost_usd_estimated.unwrap() - 2.0).abs() < 1e-9);
    assert_eq!(ev.price_version.as_deref(), Some("2026-10-29"));
    assert_eq!(ev.intent_id.as_deref(), Some("intent-1"));
    assert_eq!(ev.task_id, "t1");
    assert_eq!(ev.provider, "api");
    assert_eq!(ev.model.as_deref(), Some("m1"));
    assert_eq!(ev.requester, "leo");
    assert_eq!(ev.elapsed_ms, 120);
    assert!((econ.report().meter.cost_usd_estimated - 2.0).abs() < 1e-9);
}

#[test]
fn no_price_table_means_no_invented_amount() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    let c = ctx("intent-2", "t2");
    econ.on_model_call(
        &c,
        "api",
        "m",
        Some(10),
        Some(10),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    let r = econ.report();
    let ev = &econ.meter().events()[0];
    assert!(
        ev.cost_usd_estimated.is_none(),
        "没有价格表就必须留空, 不能补 0 冒充免费"
    );
    assert!(ev.price_version.is_none());
    assert_eq!(r.meter.events, 1);
    assert_eq!(r.meter.unpriced_events, 1, "缺价格的事件要单独计数");
    assert_eq!(r.price_version, None);
}

#[test]
fn cache_tokens_only_counted_when_priced() {
    let t = PriceTable {
        version: "v1".into(),
        effective_from: String::new(),
        entries: vec![bolloon_econ::price::PriceEntry {
            provider: "api".into(),
            model: "m".into(),
            usd_per_mtok_in: 1.0,
            usd_per_mtok_out: 1.0,
            usd_per_mtok_cache: Some(0.1),
            source_note: String::new(),
        }],
    };
    // 10e5 in + 10e5 out + 10e5 cache: 0.1+0.1+0.01
    let c = t
        .estimate("api", "m", Some(100_000), Some(100_000), Some(100_000))
        .unwrap();
    assert!((c - 0.21).abs() < 1e-9, "缓存价必须参与计价, 实得 {c}");

    // 供应商不区分缓存 ⇒ 不计缓存部分 (也不报错)
    let t2 = PriceTable {
        entries: vec![bolloon_econ::price::PriceEntry {
            usd_per_mtok_cache: None,
            ..t.entries[0].clone()
        }],
        ..t.clone()
    };
    let c2 = t2
        .estimate("api", "m", Some(100_000), Some(100_000), Some(100_000))
        .unwrap();
    assert!((c2 - 0.2).abs() < 1e-9);

    // 缺 token 用量 ⇒ None (不猜)
    assert!(t.estimate("api", "m", None, Some(1), None).is_none());
    // 没有匹配条目 ⇒ None
    assert!(t.estimate("other", "m", Some(1), Some(1), None).is_none());
}

#[test]
fn duplicate_event_id_is_counted_once() {
    let m = UsageMeter::new(None);
    let mut e = MeterEvent::new("evt-1", ResourceKind::ModelCall, "t", "api");
    e.tokens_in = Some(100);
    assert_eq!(m.record(e.clone()), RecordOutcome::New);
    assert_eq!(m.record(e.clone()), RecordOutcome::Duplicate);
    assert_eq!(m.record(e), RecordOutcome::Duplicate);

    let t = m.totals();
    assert_eq!(t.events, 1, "重投不许重复记账");
    assert_eq!(t.duplicates, 2, "重复要单独计数, 但不算成本");
    assert_eq!(t.tokens_in, 100);
}

#[test]
fn failures_and_retries_are_separated() {
    let m = UsageMeter::new(None);
    let mut a = MeterEvent::new("a", ResourceKind::ModelCall, "t", "api");
    a.status = MeterStatus::Failed;
    let mut b = MeterEvent::new("b", ResourceKind::ModelCall, "t", "api");
    b.status = MeterStatus::Retried;
    let mut c = MeterEvent::new("c", ResourceKind::ToolCall, "t", "local");
    c.status = MeterStatus::Cancelled;
    m.record(a);
    m.record(b);
    m.record(c);
    let t = m.totals();
    assert_eq!(t.failures, 2, "失败 + 取消都算失败");
    assert_eq!(t.retries, 1, "重试单独计");
    assert_eq!(t.model_calls, 2);
    assert_eq!(t.tool_calls, 1);
}

#[test]
fn events_are_attributable_to_intent_and_task() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    let a = ctx("intent-A", "task-A1");
    let b = CallCtx::new("task-B1", "leo").with_intent("intent-B");
    econ.on_model_call(
        &a,
        "api",
        "m",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    econ.on_tool_call(&a, "shell", true, 2, None);
    econ.on_model_call(
        &b,
        "local",
        "qwen",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );

    assert_eq!(econ.meter().events_for_intent("intent-A").len(), 2);
    assert_eq!(econ.meter().events_for_intent("intent-B").len(), 1);
    let by = econ.report().by_intent;
    assert_eq!(by["intent-A"].events, 2);
    assert_eq!(by["intent-A"].tool_calls, 1);
    assert_eq!(by["intent-B"].events, 1);
}

#[test]
fn meter_persists_append_only_jsonl() {
    let tmp = Tmp::new("meter");
    let econ = ShadowEconomy::new(metering_cfg(), Some(tmp.path()));
    let c = ctx("i", "t");
    econ.on_model_call(
        &c,
        "api",
        "m",
        Some(1),
        Some(2),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    econ.on_tool_call(&c, "read_file", true, 1, None);

    let raw = std::fs::read_to_string(tmp.path().join("econ-meter.jsonl")).unwrap();
    let lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines.len(), 2, "两条事件两行, 追加式");
    for l in &lines {
        let v: serde_json::Value = serde_json::from_str(l).expect("每行必须是合法 JSON");
        assert_eq!(v["schema_version"], 1);
        assert!(v["task_id"].is_string());
    }
    // 关掉再开: 文件仍在 (跨进程可追查)
    drop(econ);
    assert!(tmp.path().join("econ-meter.jsonl").exists());
}

// ───────────────── C. 预算与委托 (不能集体失控) ─────────────────

fn guard(limits: BudgetLimits) -> BudgetGuard {
    BudgetGuard::new(IntentBudget {
        intent_id: "i".into(),
        limits,
    })
}

#[test]
fn cash_budget_blocks_future_and_oversized_calls() {
    let g = guard(BudgetLimits {
        max_cash_usd: Some(1.0),
        ..Default::default()
    });
    assert!(matches!(
        g.check_model_call("api", Some(0.6)),
        BudgetDecision::Allow
    ));
    g.record_model_call(Some(0.6));

    let d = g.check_model_call("api", Some(0.6));
    assert_eq!(
        d.rule(),
        Some("max_cash_would_exceed"),
        "本次会超顶要提前拦住"
    );

    g.record_model_call(Some(0.6));
    let d = g.check_model_call("api", Some(0.1));
    assert_eq!(d.rule(), Some("max_cash"), "已触顶的调用也该拦");
    assert!((g.spent_usd() - 1.2).abs() < 1e-9);
    assert!(g.state().exhausted_by.contains(&"max_cash".to_string()));
}

#[test]
fn model_call_and_tool_call_caps() {
    let g = guard(BudgetLimits {
        max_model_calls: Some(1),
        max_tool_calls: Some(2),
        ..Default::default()
    });
    assert!(matches!(
        g.check_model_call("api", None),
        BudgetDecision::Allow
    ));
    g.record_model_call(None);
    assert_eq!(
        g.check_model_call("api", None).rule(),
        Some("max_model_calls")
    );
    assert_eq!(g.unpriced_calls(), 1, "没金额的调用单独计数, 不冒充 0 成本");

    for _ in 0..2 {
        assert!(matches!(g.check_tool_call("shell"), BudgetDecision::Allow));
        g.record_tool_call();
    }
    assert_eq!(g.check_tool_call("shell").rule(), Some("max_tool_calls"));
}

#[test]
fn delegation_depth_and_count_are_bounded() {
    let g = guard(BudgetLimits {
        max_depth: 1,
        max_delegations: 1,
        ..Default::default()
    });
    assert!(matches!(g.check_delegation(1), BudgetDecision::Allow));
    assert_eq!(g.check_delegation(2).rule(), Some("max_depth"));
    g.record_delegation();
    assert_eq!(g.check_delegation(1).rule(), Some("max_delegations"));
}

#[test]
fn provider_allowlist_and_privacy_gate() {
    let g = guard(BudgetLimits {
        allowed_providers: Some(vec!["local".into()]),
        ..Default::default()
    });
    assert!(matches!(
        g.check_model_call("local", None),
        BudgetDecision::Allow
    ));
    assert_eq!(
        g.check_model_call("api", None).rule(),
        Some("provider_not_allowed")
    );

    let p = guard(BudgetLimits {
        privacy: PrivacyPolicy {
            allow_external: false,
            allow_sensitive: false,
        },
        ..Default::default()
    });
    assert_eq!(
        p.check_model_call("api", None).rule(),
        Some("privacy_no_external")
    );
    assert!(matches!(
        p.check_model_call("local", None),
        BudgetDecision::Allow
    ));
}

#[test]
fn shadow_mode_never_blocks_but_records_why() {
    let mut cfg = metering_cfg();
    cfg.default_intent_budget_usd = Some(0.0); // 一进来就触顶
    let econ = ShadowEconomy::new(cfg, None);
    let c = ctx("intent-shadow", "t");
    for _ in 0..2 {
        let d = econ.on_model_call(
            &c,
            "api",
            "m",
            Some(5),
            Some(5),
            None,
            MeterStatus::Ok,
            1,
            None,
        );
        assert!(d.is_block(), "影子模式也要算出'本该被拦'");
    }
    let r = econ.report();
    assert_eq!(r.meter.events, 2, "影子模式仍然照常调用、照常记账");
    assert!(!r.would_block.is_empty());
    assert!(
        r.would_block.iter().all(|n| n.allowed_in_shadow),
        "影子模式恒放行"
    );
    assert_eq!(r.would_block[0].rule, "max_cash");
    assert_eq!(r.would_block[0].intent_id, "intent-shadow");
    assert!(!r.enforcement_enabled, "没显式开 enforce 就不许强制执行");
}

#[test]
fn enforce_requires_both_mode_and_switch() {
    let mut cfg = EconomicConfig {
        enabled: true,
        mode: EconomicMode::Enforce,
        default_intent_budget_usd: Some(0.0), // 一进来就触顶, 保证有"本该被拦"的事实
        ..Default::default()
    };
    let econ = ShadowEconomy::new(cfg.clone(), None);
    assert!(!econ.enforcement(), "只切 mode 还不够");

    cfg.budget_enforcement_enabled = true;
    let econ = ShadowEconomy::new(cfg, None);
    assert!(econ.enforcement());
    let c = ctx("i", "t");
    econ.on_model_call(
        &c,
        "api",
        "m",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    assert!(!econ.report().would_block.is_empty());
    assert!(
        econ.report()
            .would_block
            .iter()
            .all(|n| !n.allowed_in_shadow),
        "enforce 下'本该被拦'的调用不许标成已放行"
    );
}

#[test]
fn child_tasks_share_the_root_intent_budget() {
    let cfg = metering_cfg();
    let econ = ShadowEconomy::new(cfg, None);
    let limits = BudgetLimits {
        max_model_calls: Some(1),
        ..Default::default()
    };
    // 同一根意图: 父任务与子任务拿到的是**同一个**守卫
    let parent = econ.guard_for("root-intent", limits.clone());
    let child = econ.guard_for("root-intent", limits);
    assert!(
        std::sync::Arc::ptr_eq(&parent, &child),
        "子任务必须继承同一预算"
    );

    let p = CallCtx::new("parent-task", "leo").with_intent("root-intent");
    let c = CallCtx::new("child-task", "leo")
        .with_intent("root-intent")
        .with_parent("parent-task");
    econ.on_model_call(
        &p,
        "api",
        "m",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    let d = econ.on_model_call(
        &c,
        "api",
        "m",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    assert_eq!(
        d.rule(),
        Some("max_model_calls"),
        "子任务不能绕过根意图预算"
    );
    assert_eq!(
        econ.report().meter.model_calls,
        2,
        "被拦也要记账 (影子模式)"
    );
}

// ───────────────── D. 多方供给 (可登记 / 可撤 / 可替换) ─────────────────

fn providers() -> Vec<ProviderSpec> {
    vec![
        ProviderSpec {
            note: "贵但强".into(),
            models: vec![model("m", Some(0.95))],
            latency_ms: Some(900),
            ..ProviderSpec::new("api-strong", ProviderKind::ExternalApi)
        },
        ProviderSpec {
            note: "便宜".into(),
            models: vec![model("m", Some(0.6))],
            latency_ms: Some(300),
            ..ProviderSpec::new("api-cheap", ProviderKind::ExternalApi)
        },
        ProviderSpec {
            note: "本机".into(),
            models: vec![model("m", Some(0.7))],
            latency_ms: Some(50),
            ..ProviderSpec::new("self-gpu", ProviderKind::LocalModel)
        },
        ProviderSpec {
            note: "社区机房".into(),
            models: vec![model("m", Some(0.8))],
            latency_ms: Some(120),
            ..ProviderSpec::new("community-gpu", ProviderKind::CommunityModel)
        },
    ]
}

fn all_authorized() -> Vec<ProviderSpec> {
    providers()
        .into_iter()
        .map(|p| p.authorized(true))
        .collect()
}

#[test]
fn registration_is_not_authorization() {
    let reg = ProviderRegistry::new(None);
    for p in providers().into_iter().map(|p| p.authorized(true)) {
        reg.register(p).unwrap();
    }
    // 未授权的一条: 能被看见, 但不能被自动选用
    reg.register(ProviderSpec::new("someone-else", ProviderKind::ExternalApi).with_model("m"))
        .unwrap();
    // 赞助者不是算力供给方
    reg.register(
        ProviderSpec::new("donor", ProviderKind::Sponsor)
            .authorized(true)
            .with_model("m"),
    )
    .unwrap();

    let ids: Vec<String> = reg.selectable().into_iter().map(|p| p.id).collect();
    assert!(ids.contains(&"api-cheap".to_string()));
    assert!(
        !ids.contains(&"someone-else".to_string()),
        "登记 ≠ 授权调用"
    );
    assert!(!ids.contains(&"donor".to_string()));
    assert_eq!(
        reg.list().len(),
        6,
        "退出/未授权的不从列表里消失 (审计要用)"
    );
}

#[test]
fn revoke_and_retire_take_effect_immediately() {
    let reg = ProviderRegistry::new(None);
    reg.register(
        ProviderSpec::new("gpu", ProviderKind::CommunityModel)
            .authorized(true)
            .with_model("m"),
    )
    .unwrap();
    assert_eq!(reg.selectable().len(), 1);
    reg.revoke_authorization("gpu").unwrap();
    assert!(reg.selectable().is_empty(), "撤权后不许再被自动选用");
    assert_eq!(
        reg.get("gpu").unwrap().status,
        ProviderStatus::Active,
        "撤权 ≠ 退役"
    );

    reg.register(ProviderSpec::new("gpu2", ProviderKind::CommunityModel).authorized(true))
        .unwrap();
    reg.retire("gpu2").unwrap();
    assert!(reg.selectable().is_empty());
    assert_eq!(reg.get("gpu2").unwrap().status, ProviderStatus::Retired);
    assert!(reg.retire("nope").is_err(), "退出未知 provider 要如实报错");
}

#[test]
fn registry_survives_restart() {
    let tmp = Tmp::new("registry");
    let p = tmp.path().join("econ-providers.json");
    {
        let reg = ProviderRegistry::new(Some(p.clone()));
        reg.register(ProviderSpec::new("gpu", ProviderKind::CommunityModel).authorized(true))
            .unwrap();
    }
    let reg = ProviderRegistry::new(Some(p));
    assert_eq!(reg.list().len(), 1);
    assert!(reg.get("gpu").unwrap().owner_authorized);
}

#[test]
fn routing_strategies_pick_different_providers() {
    let cands = all_authorized();
    let req = RouteRequest {
        model: Some("m".into()),
        max_cost_usd: None,
        need_sensitive: false,
        min_quality: Some(0.5),
    };

    let cheapest = StandardRouter::new(RoutingStrategy::LowestCost)
        .with_unit_cost("api-strong", 5e-6)
        .with_unit_cost("api-cheap", 1e-6)
        .choose(&cands, &req)
        .unwrap();
    assert_eq!(
        cheapest.provider, "self-gpu",
        "本地模型现金成本 0 ⇒ 最低成本"
    );

    let quality = StandardRouter::new(RoutingStrategy::QualityFirst)
        .choose(&cands, &req)
        .unwrap();
    assert_eq!(quality.provider, "api-strong");

    let local = StandardRouter::new(RoutingStrategy::LocalFirst)
        .choose(&cands, &req)
        .unwrap();
    assert_eq!(local.provider, "self-gpu");

    let community = StandardRouter::new(RoutingStrategy::CommunityFirst)
        .choose(&cands, &req)
        .unwrap();
    assert_eq!(community.provider, "community-gpu");

    for d in [cheapest, quality, local, community] {
        assert!(
            d.shadow_only,
            "本期路由只能是影子: 记录本会选谁, 不换真实调用"
        );
        assert!(d.considered >= 1);
        assert!(!d.reason.is_empty(), "路由必须给出理由, 不许黑箱");
    }
}

#[test]
fn routing_respects_privacy_quality_and_cost_limits() {
    let cands = all_authorized();
    let router = StandardRouter::new(RoutingStrategy::LowestCost)
        .with_unit_cost("api-strong", 5e-6)
        .with_unit_cost("api-cheap", 1e-6);

    // 敏感内容: 只有声明允许的 provider 能进候选
    let sensitive: Vec<ProviderSpec> = all_authorized()
        .into_iter()
        .map(|p| ProviderSpec {
            allows_sensitive: p.id == "api-strong",
            ..p
        })
        .collect();
    let d = router
        .choose(
            &sensitive,
            &RouteRequest {
                model: Some("m".into()),
                need_sensitive: true,
                min_quality: None,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(d.provider, "api-strong", "隐私约束优先于价格");

    // 质量下限把不达标的全排掉 ⇒ 如实返回 None (不硬选一个)
    assert!(
        router
            .choose(
                &cands,
                &RouteRequest {
                    model: Some("m".into()),
                    min_quality: Some(0.99),
                    ..Default::default()
                }
            )
            .is_none(),
        "没有合格资源时必须如实说没有"
    );

    // 现金上限: 超过上限的外部 API 不许选 (本地 0 成本仍然合格)
    let d = router
        .choose(
            &cands,
            &RouteRequest {
                model: Some("m".into()),
                max_cost_usd: Some(0.0),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(d.provider, "self-gpu");

    // 指定的模型没人提供 ⇒ None
    assert!(
        router
            .choose(
                &cands,
                &RouteRequest {
                    model: Some("不存在".into()),
                    ..Default::default()
                }
            )
            .is_none()
    );
}

#[test]
fn shadow_routing_is_off_unless_requested() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    let d = StandardRouter::new(RoutingStrategy::LowestCost)
        .choose(&all_authorized(), &RouteRequest::default())
        .unwrap();
    econ.note_shadow_routing(d.clone());
    assert!(
        econ.report().shadow_routing.is_empty(),
        "默认不开启社区路由 ⇒ 不记录"
    );

    let mut cfg = metering_cfg();
    cfg.community_routing_enabled = true;
    let econ = ShadowEconomy::new(cfg, None);
    econ.note_shadow_routing(d);
    assert_eq!(econ.report().shadow_routing.len(), 1);
}

// ───────────────── E. 结算正确性 (守恒 / 授权 / 幂等 / 回滚) ─────────────────

fn ledger(cash: f64) -> SettlementLedger {
    SettlementLedger::new(
        None,
        PublicPool {
            cash_available_usd: cash,
            ..Default::default()
        },
    )
}

fn share(id: &str, kind: bolloon_econ::PayerKind, usd: f64) -> CostShare {
    CostShare {
        payer_id: id.into(),
        kind,
        amount_usd: usd,
        authorized: true,
    }
}

#[test]
fn shares_may_not_exceed_cost() {
    let l = ledger(100.0);
    let e = l.settle(
        vec!["evt-1".into()],
        0.10,
        vec![
            share("req", bolloon_econ::PayerKind::Requester, 0.10),
            share("pool", bolloon_econ::PayerKind::PublicPool, 0.05),
        ],
        "test",
        SettlementState::Draft,
    );
    assert!(e.is_err(), "分摊合计超过成本必须拒");
    assert!(l.records().is_empty(), "拒绝的结算不许留下半条记录");
}

#[test]
fn unauthorized_payer_is_refused() {
    let l = ledger(100.0);
    let mut s = share("someone", bolloon_econ::PayerKind::Contributor, 0.05);
    s.authorized = false;
    let e = l.settle(
        vec!["evt-1".into()],
        0.10,
        vec![s],
        "test",
        SettlementState::Draft,
    );
    assert!(e.is_err(), "不能替未授权的成员扣费");
}

#[test]
fn same_cost_cannot_be_settled_twice() {
    let l = ledger(100.0);
    let ok = l.settle(
        vec!["evt-1".into()],
        0.05,
        vec![share("req", bolloon_econ::PayerKind::Requester, 0.05)],
        "test",
        SettlementState::Draft,
    );
    assert!(ok.is_ok());
    let again = l.settle(
        vec!["evt-1".into()],
        0.05,
        vec![share("req", bolloon_econ::PayerKind::Requester, 0.05)],
        "test",
        SettlementState::Draft,
    );
    assert!(again.is_err(), "重复同步不许重复扣费");
    assert_eq!(l.records().len(), 1);
    assert!((l.total_settled_usd() - 0.05).abs() < 1e-9);
}

#[test]
fn public_pool_cannot_pay_with_unreceived_money() {
    // 池子里只有 0.01 可用, 却要垫 0.05
    let l = ledger(0.01);
    let e = l.settle(
        vec!["evt-1".into()],
        0.05,
        vec![share("pool", bolloon_econ::PayerKind::PublicPool, 0.05)],
        "test",
        SettlementState::Draft,
    );
    assert!(e.is_err(), "未到账的钱不能当预算");
    assert_eq!(l.pool().committed_usd, 0.0, "失败的预留不许留在池子里");
}

#[test]
fn multi_party_split_lands_on_multiple_payers() {
    // 两方共同承担: 请求者最多 0.02, 公共池兜剩下的
    let mut cfg = metering_cfg();
    cfg.contribution_settlement_enabled = true;
    cfg.pool_cash_available_usd = 10.0;
    let tmp = Tmp::new("split");
    std::fs::write(
        tmp.path().join("prices.json"),
        r#"{"version":"v-split","entries":[
            {"provider":"api","model":"m","usd_per_mtok_in":1.0,"usd_per_mtok_out":1.0}
        ]}"#,
    )
    .unwrap();
    cfg.price_table_file = Some("prices.json".into());
    let econ = ShadowEconomy::new(cfg, Some(tmp.path()));

    let limits = BudgetLimits {
        payers: vec![
            Payer {
                kind: bolloon_econ::PayerKind::Requester,
                id: "requester".into(),
                authorized: true,
                max_usd: Some(0.02),
            },
            Payer {
                kind: bolloon_econ::PayerKind::PublicPool,
                id: "pool".into(),
                authorized: true,
                max_usd: None,
            },
            // 未授权的一方即使列在名单里也不许被扣
            Payer {
                kind: bolloon_econ::PayerKind::Sponsor,
                id: "sponsor-x".into(),
                authorized: false,
                max_usd: None,
            },
        ],
        ..Default::default()
    };
    econ.guard_for("intent-split", limits);

    let c = ctx("intent-split", "t-split");
    // 0.05 USD 的一次调用
    econ.on_model_call(
        &c,
        "api",
        "m",
        Some(25_000),
        Some(25_000),
        None,
        MeterStatus::Ok,
        1,
        None,
    );

    let recs = econ.settlements().records();
    assert_eq!(recs.len(), 1, "开结算才产生草稿");
    let r = &recs[0];
    assert_eq!(r.state, SettlementState::Draft, "影子期只出草稿, 不动钱");
    assert!(r.conservation_ok);
    let total: f64 = r.shares.iter().map(|s| s.amount_usd).sum();
    assert!(
        (total - 0.05).abs() < 1e-9,
        "分摊合计必须等于成本, 实得 {total}"
    );
    let by: std::collections::BTreeMap<&str, f64> = r
        .shares
        .iter()
        .map(|s| (s.payer_id.as_str(), s.amount_usd))
        .collect();
    assert!(
        (by["requester"] - 0.02).abs() < 1e-9,
        "请求者优先, 只吃自己的额度"
    );
    assert!((by["pool"] - 0.03).abs() < 1e-9, "剩下的顺延到公共池");
    assert!(!by.contains_key("sponsor-x"), "未授权的 payer 一分不出");
    assert!((econ.settlements().pool().committed_usd - 0.03).abs() < 1e-9);
}

#[test]
fn settlement_is_off_by_default() {
    let tmp = Tmp::new("nosettle");
    std::fs::write(
        tmp.path().join("prices.json"),
        r#"{"version":"v","entries":[{"provider":"api","model":"m","usd_per_mtok_in":1.0,"usd_per_mtok_out":1.0}]}"#,
    )
    .unwrap();
    let mut cfg = metering_cfg();
    cfg.price_table_file = Some("prices.json".into());
    let econ = ShadowEconomy::new(cfg, Some(tmp.path()));
    econ.on_model_call(
        &ctx("i", "t"),
        "api",
        "m",
        Some(1_000_000),
        Some(0),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    assert!(
        econ.settlements().records().is_empty(),
        "默认不产生任何可兑现承诺"
    );
    assert_eq!(econ.report().settlements_total_usd, 0.0);
    assert!(
        (econ.report().meter.cost_usd_estimated - 1.0).abs() < 1e-9,
        "但成本照样记着"
    );
}

#[test]
fn rollback_removes_cost_from_totals() {
    let l = ledger(10.0);
    let rec = l
        .settle(
            vec!["evt-1".into()],
            0.05,
            vec![share("pool", bolloon_econ::PayerKind::PublicPool, 0.05)],
            "test",
            SettlementState::Confirmed,
        )
        .unwrap();
    assert!((l.pool().spent_usd - 0.05).abs() < 1e-9);
    l.rollback(&rec.id, "任务验收不过").unwrap();
    assert!(
        (l.total_settled_usd() - 0.0).abs() < 1e-9,
        "回滚后不许再计入总支出"
    );
    assert!(l.by_payer().is_empty());
    l.rollback(&rec.id, "重复回滚").unwrap();
    assert!(l.rollback("nonexistent", "x").is_err());
}

#[test]
fn confirmed_contribution_cash_is_the_only_thing_that_enters_the_pool() {
    let tmp = Tmp::new("contrib");
    let econ = ShadowEconomy::new(metering_cfg(), Some(tmp.path()));
    let l = econ.contributions();

    let c = l
        .pledge(Contribution {
            id: String::new(),
            contributor: "alice".into(),
            kind: ContributionKind::CashSponsor,
            cash_usd: Some(5.0),
            units: None,
            unit_kind: String::new(),
            state: ContributionState::Pledged,
            at: String::new(),
            verified_by: None,
            evidence_refs: vec!["invoice-1".into()],
            note: String::new(),
        })
        .unwrap();

    econ.sync_pool_from_contributions();
    assert!(
        (econ.settlements().pool().contribution_cash_usd - 0.0).abs() < 1e-9,
        "只是承诺 ⇒ 一分钱都不进池子"
    );

    l.mark_executed(&c.id).unwrap();
    assert!(l.verify(&c.id, "alice").is_err(), "自己验收自己无效");
    l.verify(&c.id, "bob").unwrap();
    l.confirm(&c.id, "bob").unwrap();

    let t = econ.contributions().totals();
    assert!((t.cash_confirmed_usd - 5.0).abs() < 1e-9);
    assert_eq!(t.confirmed, 1);
    econ.sync_pool_from_contributions();
    assert!((econ.settlements().pool().contribution_cash_usd - 5.0).abs() < 1e-9);
    assert!((econ.settlements().pool().available() - 5.0).abs() < 1e-9);
}

#[test]
fn non_cash_contributions_are_not_converted_to_money() {
    let l = ContributionLedger::new(None);
    // 本地算力: 只按自己的维度记
    let c = l
        .pledge(Contribution {
            id: "gpu-1".into(),
            contributor: "carol".into(),
            kind: ContributionKind::LocalInference,
            cash_usd: None,
            units: Some(1200.0),
            unit_kind: "ms".into(),
            state: ContributionState::Pledged,
            at: String::new(),
            verified_by: None,
            evidence_refs: vec![],
            note: String::new(),
        })
        .unwrap();
    l.mark_executed(&c.id).unwrap();
    l.verify(&c.id, "bob").unwrap();
    l.confirm(&c.id, "bob").unwrap();
    let t = l.totals();
    assert!((t.local_inference_units - 1200.0).abs() < 1e-9);
    assert_eq!(t.cash_confirmed_usd, 0.0, "算力不等于现金");

    // 非现金贡献填了现金金额 ⇒ 拒 (维度不许混)
    assert!(
        l.pledge(Contribution {
            id: "bad".into(),
            contributor: "carol".into(),
            kind: ContributionKind::LocalInference,
            cash_usd: Some(1.0),
            units: Some(1.0),
            unit_kind: "ms".into(),
            state: ContributionState::Pledged,
            at: String::new(),
            verified_by: None,
            evidence_refs: vec![],
            note: String::new(),
        })
        .is_err()
    );
    // 现金贡献是 0 元 ⇒ 拒
    assert!(
        l.pledge(Contribution {
            id: "zero".into(),
            contributor: "carol".into(),
            kind: ContributionKind::ApiCredit,
            cash_usd: Some(0.0),
            units: None,
            unit_kind: String::new(),
            state: ContributionState::Pledged,
            at: String::new(),
            verified_by: None,
            evidence_refs: vec![],
            note: String::new(),
        })
        .is_err(),
        "0 元不算贡献"
    );
}

// ───────────────── F. 隐私与密钥 ─────────────────

#[test]
fn meter_events_never_carry_secrets_or_prompts() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    let c = ctx("i", "t");
    econ.on_model_call(
        &c,
        "api",
        "m",
        Some(10),
        Some(10),
        None,
        MeterStatus::Ok,
        1,
        Some(serde_json::json!({ "tool": "read_file", "path": "/tmp/x" })),
    );

    let raw = serde_json::to_string(&econ.meter().events()).unwrap();
    for forbidden in [
        "api_key",
        "apiKey",
        "authorization",
        "bearer",
        "sk-",
        "prompt",
        "secret",
    ] {
        assert!(
            !raw.to_lowercase().contains(&forbidden.to_lowercase()),
            "账本里出现了 `{forbidden}` ⇒ 密钥/正文泄漏"
        );
    }
}

#[test]
fn provider_records_have_no_credential_fields() {
    let p = ProviderSpec::new("api", ProviderKind::ExternalApi)
        .with_model("m")
        .authorized(true);
    let raw = serde_json::to_string(&p).unwrap().to_lowercase();
    for forbidden in ["api_key", "apikey", "secret", "sk-", "password", "token"] {
        assert!(
            !raw.contains(forbidden),
            "provider 登记表不许有凭证字段 `{forbidden}`"
        );
    }
}

#[test]
fn report_is_serializable_and_states_whether_it_is_on() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    econ.on_model_call(
        &ctx("i", "t"),
        "api",
        "m",
        Some(1),
        Some(1),
        None,
        MeterStatus::Ok,
        1,
        None,
    );
    econ.end_task("t", true);
    let r = econ.report();
    assert!(r.enabled);
    assert_eq!(r.mode, "shadow");
    assert_eq!(r.tasks_total, 1);
    assert_eq!(r.tasks_succeeded, 1);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["enabled"], true);
    assert!(
        v["free_task_completion_rate"].as_f64().is_some(),
        "免费完成率要有真值"
    );
    assert!(v["meter"]["events"].as_u64().unwrap() >= 1);
}

#[test]
fn exhaustion_policy_defaults_to_stop() {
    // 预算耗尽默认"停下", 而不是偷偷换到用户自付费 API
    assert_eq!(ExhaustionPolicy::default(), ExhaustionPolicy::Stop);
    assert_eq!(BudgetLimits::default().on_exhausted, ExhaustionPolicy::Stop);
    assert!(
        !BudgetLimits::default().privacy.allow_sensitive,
        "敏感内容默认不许外发"
    );
}

// ──────────────── G. 闸口真拦得住 (并发 / 日预算 / 现金闸前提) ────────────────

#[test]
fn reservation_is_atomic_under_fanout() {
    // 1000 个并发调用抢 20 个名额：判定+计数同锁 ⇒ 恰好 20 个通过（不是 1000 个都看到 0）
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    let g = Arc::new(guard(BudgetLimits {
        max_model_calls: Some(20),
        ..Default::default()
    }));
    let allowed = Arc::new(AtomicU32::new(0));
    let mut hs = vec![];
    for _ in 0..1000 {
        let g = g.clone();
        let allowed = allowed.clone();
        hs.push(std::thread::spawn(move || {
            if matches!(g.try_reserve_model_call("api", None), BudgetDecision::Allow) {
                allowed.fetch_add(1, Ordering::Relaxed);
            }
        }));
    }
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(allowed.load(Ordering::Relaxed), 20, "上限必须精确生效");
    assert_eq!(g.state().model_calls, 20, "预扣也恰好 20 次");
}

#[test]
fn reservation_refunds_on_reconcile() {
    let g = guard(BudgetLimits {
        max_cash_usd: Some(1.0),
        ..Default::default()
    });
    // 预扣 0.5，实际只花 0.2 ⇒ 退 0.3
    assert!(matches!(g.try_reserve_model_call("api", Some(0.5)), BudgetDecision::Allow));
    assert!((g.spent_usd() - 0.5).abs() < 1e-9);
    let d = g.reconcile_model_call(Some(0.5), Some(0.2)).unwrap();
    assert!((d + 0.3).abs() < 1e-9, "差额应为 -0.3, 实得 {d}");
    assert!((g.spent_usd() - 0.2).abs() < 1e-9, "对账后按实际算");
    // 拿不到实际值 ⇒ 保持预扣, 不猜
    assert!(g.reconcile_model_call(Some(0.2), None).is_none());
}

#[test]
fn daily_gate_blocks_across_intents() {
    let mut cfg = metering_cfg();
    cfg.daily_model_calls = Some(3);
    let econ = ShadowEconomy::new(cfg, None);
    // 三个不同意图各调一次 ⇒ 第 4 次（哪怕又是新意图）被节点日闸拦下
    for i in 0..3 {
        let c = ctx(&format!("intent-{i}"), &format!("t{i}"));
        assert!(matches!(econ.begin_model_call(&c, "api", None), BudgetDecision::Allow));
    }
    let c = ctx("intent-new", "t-new");
    let d = econ.begin_model_call(&c, "api", None);
    assert_eq!(d.rule(), Some("daily_max_model_calls"), "换意图也绕不过日闸");
    assert_eq!(econ.daily().0, 3, "日计数 = 3");
}

#[test]
fn cash_gate_is_reported_as_disabled_without_prices() {
    let econ = ShadowEconomy::new(metering_cfg(), None);
    let r = econ.report();
    assert!(!r.cash_gate_enabled, "没有价格表 ⇒ 现金闸不可能生效, 必须如实报");
    assert_eq!(r.daily_model_calls, 0);
}

#[test]
fn begin_and_finish_record_actual_cost() {
    let tmp = Tmp::new("beginfinish");
    std::fs::write(
        tmp.path().join("prices.json"),
        r#"{"version":"v-bf","entries":[{"provider":"api","model":"m","usd_per_mtok_in":1.0,"usd_per_mtok_out":1.0}]}"#,
    )
    .unwrap();
    let mut cfg = metering_cfg();
    cfg.price_table_file = Some("prices.json".into());
    let econ = ShadowEconomy::new(cfg, Some(tmp.path()));
    let c = ctx("i-bf", "t-bf");
    assert!(econ.estimate_cost("api", "m").is_none(), "第一次调用没有历史金额可预扣");
    assert!(matches!(econ.begin_model_call(&c, "api", None), BudgetDecision::Allow));
    econ.finish_model_call(&c, "api", "m", Some(1_000_000), Some(0), MeterStatus::Ok, 5, None, None);
    let ev = &econ.meter().events()[0];
    assert!((ev.cost_usd_estimated.unwrap() - 1.0).abs() < 1e-9);
    assert!((econ.report().daily_cash_usd - 1.0).abs() < 1e-9, "日账跟着实际成本走");
    // 下一次调用就能拿上次的真实成本当预扣
    assert!((econ.estimate_cost("api", "m").unwrap() - 1.0).abs() < 1e-9);
}
