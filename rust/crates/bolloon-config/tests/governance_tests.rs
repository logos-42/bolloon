//! 治理闭环测试: 可观测指标 / 任务↔版本证据链 / 租约协调 / AI 优化闭环。
//!
//! 纪律: 不用"模拟成功"代替真实切换 —— 每条断言都读**当前有效配置**或**落盘文件**。

use bolloon_config::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!(
        "bolloon-config-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

// ─────────────────────────── 可观测指标 ───────────────────────────

#[tokio::test]
async fn metrics_track_reads_apply_and_rejects() {
    let mgr = ConfigManager::new(None);
    for _ in 0..10 {
        let _ = mgr.current();
    }
    let mut ok = AppConfig::default();
    ok.runtime.tool_timeout_ms = 30_000;
    mgr.apply(ConfigProposal::system(ok, "ok")).await.unwrap();

    let mut bad = AppConfig::default();
    bad.runtime.tool_timeout_ms = 9_999_999; // 越界
    assert!(mgr.apply(ConfigProposal::system(bad, "bad")).await.is_err());

    let m = mgr.metrics();
    assert!(m.reads >= 10, "reads={}", m.reads);
    assert!(
        m.avg_read_ns >= 0.0 && m.avg_read_ns < 10_000_000.0,
        "读开销应在纳秒级 (实测 {} ns)",
        m.avg_read_ns
    );
    assert_eq!(m.applies, 1);
    assert_eq!(m.apply_rejects, 1);
    assert!((m.apply_failure_rate - 0.5).abs() < 1e-9);
    assert!(m.avg_apply_ms >= 0.0);
    assert_eq!(m.last_version, 1);
}

#[tokio::test]
async fn metrics_track_rollback_success_and_failure() {
    let mgr = ConfigManager::new(None);
    let mut a = AppConfig::default();
    a.runtime.tool_timeout_ms = 30_000;
    let v1 = mgr.apply(ConfigProposal::system(a, "v1")).await.unwrap();
    let mut b = AppConfig::default();
    b.runtime.tool_timeout_ms = 45_000;
    mgr.apply(ConfigProposal::system(b, "v2")).await.unwrap();

    // 真回滚 (v1 在历史里, 且不是当前版本) → 成功计数
    let back = mgr.rollback_to(v1.version).await.unwrap();
    assert_eq!(back.config.runtime.tool_timeout_ms, 30_000);
    // 回滚到不存在的版本 → 失败计数
    assert!(mgr.rollback_to(999).await.is_err());

    let m = mgr.metrics();
    assert_eq!(m.rollbacks, 2);
    assert!((m.rollback_failure_rate - 0.5).abs() < 1e-9);
}

// ─────────────────────── 任务 ↔ 配置版本 证据链 ───────────────────────

#[tokio::test]
async fn evidence_binds_task_to_version_and_persists() {
    let dir = tmpdir("evidence");
    let file = dir.join("config.json");
    let mgr = ConfigManager::with_file(Some(file.clone())).await;

    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 45_000;
    let v1 = mgr.apply(ConfigProposal::system(cfg, "raise timeout")).await.unwrap();
    assert_eq!(v1.version, 1);

    let start = TaskBinding::start("task-abc", "cli", v1.version, Some("m1".into()));
    mgr.record_binding(start.clone());
    mgr.record_binding(start.end("Finished", 3));

    assert_eq!(mgr.evidence().len(), 2);
    assert_eq!(mgr.evidence().versions_for_task("task-abc"), vec![v1.version]);
    let by_version = mgr.evidence().tasks_for_version(v1.version);
    assert_eq!(by_version.len(), 2);
    assert_eq!(by_version[1].tool_calls, Some(3));
    assert_eq!(by_version[1].stop.as_deref(), Some("Finished"));

    // 真落盘 (append-only JSONL)
    let p = dir.join("config-evidence.jsonl");
    let text = std::fs::read_to_string(&p).expect("证据链应已落盘");
    assert_eq!(text.lines().count(), 2, "每绑定一行");
    assert!(text.contains("task-abc"));
}

// ────────────────────────── 多节点协调 ──────────────────────────

#[test]
fn lease_blocks_second_holder_and_fences_stale_steal() {
    let dir = tmpdir("lease");

    // ① 未过期时第二个持有者被拒
    let c = FileLeaseCoordinator::new(&dir, "config");
    let a = c.acquire("node-a", 5_000).unwrap();
    assert_eq!(a.fencing, 1);
    match c.acquire("node-b", 5_000) {
        Err(CoordError::LeaseHeld { holder, .. }) => assert_eq!(holder, "node-a"),
        other => panic!("应被租约挡住, 实际 {other:?}"),
    }

    // ② 租约过期后可以抢占, 栅栏令牌单调 +1
    let exp = FileLeaseCoordinator::new(&dir, "expiring");
    let stale = exp.acquire("node-a", 0).unwrap(); // ttl=0 ⇒ 立即过期
    let stolen = exp.acquire("node-b", 5_000).unwrap();
    assert_eq!(stolen.fencing, stale.fencing + 1);

    // ③ 老持有者不能释放别人的租约 (FencedOut), 且不会删掉新锁
    match exp.release(&stale) {
        Err(CoordError::FencedOut { mine, current }) => {
            assert_eq!(mine, stale.fencing);
            assert_eq!(current, stolen.fencing);
        }
        other => panic!("老持有者不应释放成功: {other:?}"),
    }
    assert!(exp.peek().is_some(), "新租约必须还在");
    exp.release(&stolen).unwrap();
    assert!(exp.peek().is_none());
}

#[tokio::test]
async fn coordinated_apply_requires_matching_version_and_is_atomic_per_node() {
    let dir = tmpdir("coord");
    let mgr = ConfigManager::new(None);
    let coord = FileLeaseCoordinator::new(&dir, "config");

    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 30_000;
    // 缺 based_on → 拒绝 (禁止无版本提交)
    let mut p = ConfigProposal::system(cfg.clone(), "coordinated");
    assert!(matches!(
        mgr.apply_coordinated(&coord, "node-a", 2_000, p).await,
        Err(CoordError::MissingBasedOn)
    ));
    assert_eq!(mgr.version(), 0, "被拒后版本不变");

    // 正确的 based_on → 成功
    p = ConfigProposal {
        based_on: Some(0),
        ..ConfigProposal::system(cfg.clone(), "coordinated")
    };
    let (snap, lease) = mgr
        .apply_coordinated(&coord, "node-a", 2_000, p)
        .await
        .unwrap();
    assert_eq!(snap.version, 1);
    assert_eq!(snap.config.runtime.tool_timeout_ms, 30_000);
    assert_eq!(lease.fencing, 1);

    // 用过期的 based_on 再来一次 → FencedOut, 配置不变
    let stale = ConfigProposal {
        based_on: Some(0),
        ..ConfigProposal::system(cfg, "stale writer")
    };
    assert!(matches!(
        mgr.apply_coordinated(&coord, "node-b", 2_000, stale).await,
        Err(CoordError::FencedOut { .. })
    ));
    assert_eq!(mgr.version(), 1);
    assert_eq!(mgr.current().config.runtime.tool_timeout_ms, 30_000);
}

// ───────────────────────── AI 优化闭环 ─────────────────────────

/// 脚本化指标源: 每次 read 依次给出下一个值 (模拟"改动之后重新测量")。
struct ScriptedMetrics {
    name: String,
    values: Mutex<Vec<f64>>,
    idx: AtomicU64,
    trust: TrustLevel,
}

impl ScriptedMetrics {
    fn new(name: &str, values: Vec<f64>) -> Self {
        Self {
            name: name.into(),
            values: Mutex::new(values),
            idx: AtomicU64::new(0),
            trust: TrustLevel::Measured,
        }
    }
    fn untrusted(name: &str, values: Vec<f64>) -> Self {
        Self {
            trust: TrustLevel::ModelClaimed,
            ..Self::new(name, values)
        }
    }
}

impl MetricSource for ScriptedMetrics {
    fn read(&self, name: &str) -> Option<MetricSample> {
        if name != self.name {
            return None;
        }
        let i = self.idx.fetch_add(1, Ordering::SeqCst) as usize;
        let v = *self.values.lock().unwrap().get(i)?;
        Some(MetricSample {
            name: self.name.clone(),
            value: v,
            trust: self.trust,
            at: chrono::Utc::now().to_rfc3339(),
        })
    }
}

fn objective(metric: &str, max_rounds: u32) -> OptimizationObjective {
    OptimizationObjective {
        metric: metric.into(),
        higher_is_better: false, // 失败率越小越好
        min_improvement_ratio: 0.05,
        max_adjustment_ratio: 0.5,
        degrade_rollback_ratio: 0.10,
        max_rounds,
        max_wall_ms: 10_000,
    }
}

#[tokio::test]
async fn optimizer_refuses_without_trusted_metrics() {
    let mgr = ConfigManager::new(None);
    let opt = AiOptimizer::new(
        AiMode::RestrictedAuto,
        objective("llm.failure_rate", 3),
        ParamResponse::HigherHelps,
    );
    // 完全没有该指标
    let empty = ScriptedMetrics::new("llm.failure_rate", vec![]);
    match opt.run(&mgr, &empty).await {
        Err(OptimizeError::NoTrustedMetric(m)) => assert_eq!(m, "llm.failure_rate"),
        other => panic!("应因缺少可信指标被拒: {other:?}"),
    }
    // 只有模型自述级 → 同样拒绝
    let claimed = ScriptedMetrics::untrusted("llm.failure_rate", vec![0.5, 0.1]);
    assert!(matches!(
        opt.run(&mgr, &claimed).await,
        Err(OptimizeError::NoTrustedMetric(_))
    ));
    assert_eq!(mgr.version(), 0, "拒绝后配置必须原封不动");
}

#[tokio::test]
async fn optimizer_default_mode_is_advisory_and_never_writes() {
    let mgr = ConfigManager::new(None);
    let metrics = ScriptedMetrics::new("llm.failure_rate", vec![0.40]);
    let opt = AiOptimizer::new(
        AiMode::Advisory,
        objective("llm.failure_rate", 3),
        ParamResponse::HigherHelps,
    );
    let proposals = opt.propose(&mgr, &metrics).unwrap();
    assert_eq!(proposals.len(), 1);
    assert!(proposals[0].needs_approval);
    assert_eq!(proposals[0].param, "runtime.llm_retries");
    assert_eq!(mgr.version(), 0, "建议级绝不写配置");

    // 建议级调用闭环 → 明确拒绝 (不是静默什么都没做)
    let metrics2 = ScriptedMetrics::new("llm.failure_rate", vec![0.40]);
    assert!(matches!(
        opt.run(&mgr, &metrics2).await,
        Err(OptimizeError::AdvisoryOnly)
    ));
    assert_eq!(mgr.version(), 0);
}

#[tokio::test]
async fn optimizer_rolls_back_when_metric_degrades() {
    let mgr = ConfigManager::new(None);
    let baseline_retries = mgr.current().config.runtime.llm_retries;
    // 第一次 read = 基线 0.10; 应用后第二次 read = 0.90 (恶化 9 倍) ⇒ 必须回滚
    let metrics = ScriptedMetrics::new("llm.failure_rate", vec![0.10, 0.90]);
    let opt = AiOptimizer::new(
        AiMode::RestrictedAuto,
        objective("llm.failure_rate", 3),
        ParamResponse::HigherHelps,
    );
    let rep = opt.run(&mgr, &metrics).await.unwrap();
    assert!(rep.rolled_back, "指标恶化必须回滚: {rep:?}");
    assert_eq!(rep.stop_reason, "rollback.degraded");
    assert_eq!(
        mgr.current().config.runtime.llm_retries, baseline_retries,
        "回滚后参数必须回到基线"
    );
    assert!(mgr.current().restored_from.is_some());
    // 回滚点始终存在: 基线版本在历史里
    assert!(mgr.can_restore(rep.baseline_version));
}

#[tokio::test]
async fn optimizer_stops_when_objective_reached() {
    let mgr = ConfigManager::new(None);
    let metrics = ScriptedMetrics::new("llm.failure_rate", vec![0.40, 0.20]);
    let opt = AiOptimizer::new(
        AiMode::RestrictedAuto,
        objective("llm.failure_rate", 3),
        ParamResponse::HigherHelps,
    );
    let rep = opt.run(&mgr, &metrics).await.unwrap();
    assert!(!rep.rolled_back);
    assert_eq!(rep.stop_reason, "objective.reached");
    assert!(rep.final_version > rep.baseline_version, "改善则保留新版本");
    assert!(mgr.current().config.runtime.llm_retries > 2);
}

#[tokio::test]
async fn optimizer_rolls_back_when_no_prov_improvement() {
    // 改动前后指标一样 (0.30 → 0.30): 没改善 ⇒ 不保留改动
    let mgr = ConfigManager::new(None);
    let baseline_retries = mgr.current().config.runtime.llm_retries;
    let metrics = ScriptedMetrics::new("llm.failure_rate", vec![0.30, 0.30]);
    let opt = AiOptimizer::new(
        AiMode::RestrictedAuto,
        objective("llm.failure_rate", 3),
        ParamResponse::HigherHelps,
    );
    let rep = opt.run(&mgr, &metrics).await.unwrap();
    assert!(rep.rolled_back, "无改善必须回滚: {rep:?}");
    assert_eq!(rep.stop_reason, "rollback.no_improvement");
    assert_eq!(mgr.current().config.runtime.llm_retries, baseline_retries);
}

#[tokio::test]
async fn optimizer_rejects_bad_budget() {
    let mgr = ConfigManager::new(None);
    let metrics = ScriptedMetrics::new("llm.failure_rate", vec![0.1]);
    let mut o = objective("llm.failure_rate", 0); // 轮数预算 0
    o.max_rounds = 0;
    let opt = AiOptimizer::new(AiMode::RestrictedAuto, o, ParamResponse::HigherHelps);
    assert!(matches!(
        opt.run(&mgr, &metrics).await,
        Err(OptimizeError::BadBudget(_))
    ));
}

#[tokio::test]
async fn ai_cannot_touch_task_level_or_safety_even_via_queue() {
    // AI 提交 B 类 (模型) 与 A 类 (安全) 变更 → 白名单收敛, 只有 C 类生效
    let mgr = ConfigManager::new(None);
    let mut cfg = AppConfig::default();
    cfg.runtime.llm_retries = 5; // C 类 (白名单内)
    cfg.task.default_model = Some("evil-model".into()); // B 类 (不许)
    cfg.safety.emergency_stop = true; // A 类 (不许)
    let snap = mgr
        .apply(ConfigProposal {
            based_on: None,
            config: cfg,
            auth: ConfigAuth::Ai,
            source: "ai".into(),
            operator: "ai".into(),
            reason: "self upgrade".into(),
        })
        .await
        .unwrap();
    assert_eq!(snap.config.runtime.llm_retries, 5);
    assert_eq!(snap.config.task.default_model, None);
    assert!(!snap.config.safety.emergency_stop);
}

// ─────────────────────── 回滚点语义 (自动优化前提) ───────────────────────

#[tokio::test]
async fn previous_version_is_always_restorable_after_apply() {
    let mgr = ConfigManager::new(None);
    let mut a = AppConfig::default();
    a.runtime.tool_timeout_ms = 30_000;
    mgr.apply(ConfigProposal::system(a, "v1")).await.unwrap();
    // 基线 v0 在第一次 apply 时就进了历史 ⇒ 随时可退回
    assert!(mgr.can_restore(0));
    let mut b = AppConfig::default();
    b.runtime.tool_timeout_ms = 45_000;
    mgr.apply(ConfigProposal::system(b, "v2")).await.unwrap();
    assert!(mgr.can_restore(1));
    let back = mgr.rollback_to(0).await.unwrap();
    assert_eq!(
        back.config.runtime.tool_timeout_ms,
        AppConfig::default().runtime.tool_timeout_ms
    );
    assert_eq!(back.restored_from, Some(0));
}

// ─────────────────────── 高频更新不死锁 (并发收敛) ───────────────────────

#[tokio::test]
async fn high_frequency_updates_converge_without_deadlock() {
    let mgr = Arc::new(ConfigManager::new(None));
    let mut tasks = vec![];
    for i in 0..8u64 {
        let m = mgr.clone();
        tasks.push(tokio::spawn(async move {
            for k in 0..25u64 {
                let mut cfg = AppConfig::default();
                cfg.runtime.llm_retries = ((i + k) % 10) as u32;
                let _ = m.apply(ConfigProposal::system(cfg, "hammer")).await;
                let _ = m.current();
            }
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    let m = mgr.metrics();
    assert!(m.applies + m.apply_rejects >= 8, "至少发生了多次更新尝试");
    assert_eq!(m.last_version, mgr.version());
}
