use bolloon_config::policy::RuntimePolicy;
use bolloon_config::*;
use std::sync::Arc;
use tokio::sync::Barrier;

fn sys_proposal(cfg: AppConfig, reason: &str) -> ConfigProposal {
    ConfigProposal::system(cfg, reason)
}

// 1. 合法配置成功应用
#[tokio::test]
async fn t1_valid_config_applies() {
    let mgr = ConfigManager::new(None);
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 30_000;
    cfg.task.max_steps = 50;
    let snap = mgr.apply(sys_proposal(cfg, "raise timeout")).await.unwrap();
    assert_eq!(snap.version, 1);
    assert_eq!(snap.config.runtime.tool_timeout_ms, 30_000);
    assert_eq!(snap.config.task.max_steps, 50);
}

// 2. 类型错误 / 越界 / 非法组合被拒绝
#[tokio::test]
async fn t2_invalid_rejected() {
    // 类型错误 (JSON 字段类型不匹配)
    let bad: Result<AppConfig, _> =
        serde_json::from_str(r#"{"runtime":{"tool_timeout_ms":"not_a_number"}}"#);
    assert!(bad.is_err());

    let mgr = ConfigManager::new(None);
    // 越界
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 9_999_999; // 超过上限 3_600_000
    let e = mgr.apply(sys_proposal(cfg, "oob")).await.unwrap_err();
    assert!(matches!(e, ConfigError::Validation(_)));

    // 非法组合: full_access + revoked_tools
    let mut cfg = AppConfig::default();
    cfg.safety.full_access = true;
    cfg.safety.revoked_tools.push("shell".into());
    let e = mgr.apply(sys_proposal(cfg, "bad combo")).await.unwrap_err();
    assert!(matches!(e, ConfigError::Validation(_)));
}

// 3. 更新失败时旧配置继续有效
#[tokio::test]
async fn t3_failed_update_keeps_old() {
    let mgr = ConfigManager::new(None);
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 42_000;
    let ok = mgr.apply(sys_proposal(cfg, "good")).await.unwrap();
    assert_eq!(ok.config.runtime.tool_timeout_ms, 42_000);

    // 失败更新
    let mut bad = AppConfig::default();
    bad.runtime.tool_timeout_ms = 9_999_999;
    assert!(mgr.apply(sys_proposal(bad, "bad")).await.is_err());

    // 旧配置完好
    let cur = mgr.current();
    assert_eq!(cur.config.runtime.tool_timeout_ms, 42_000);
    assert_eq!(cur.version, 1);
}

// 4. 并发读取过程中不会观察到部分配置
#[tokio::test]
async fn t4_concurrent_reads_no_partial() {
    let mgr = ConfigManager::new(None);
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 11_111;
    let old = mgr.current().config.clone();
    let arc = mgr.apply(sys_proposal(cfg, "set")).await.unwrap();
    let new = arc.config.clone();

    let v = mgr.view();
    let readers = (0..32).map(|_| {
        let vv = v.clone();
        tokio::spawn(async move {
            let s = vv.read().unwrap().clone();
            s.config.clone()
        })
    });
    for h in readers {
        let c = h.await.unwrap();
        // 要么旧, 要么新, 绝不混合 (无部分可见)
        assert!(c == old || c == new, "观察到部分/混合配置");
    }
}

// 5. 多个并发更新不会静默覆盖较新的版本
#[tokio::test]
async fn t5_concurrent_updates_no_silent_overwrite() {
    let mgr = Arc::new(ConfigManager::new(None)); // version 0
    let barrier = Arc::new(Barrier::new(2));
    let mut a = AppConfig::default();
    a.runtime.tool_timeout_ms = 20_000;
    let mut b = AppConfig::default();
    b.runtime.tool_timeout_ms = 30_000;

    let mk = |cfg: AppConfig, bar: Arc<Barrier>, m: Arc<ConfigManager>| {
        tokio::spawn(async move {
            bar.wait().await;
            m.apply(ConfigProposal {
                based_on: Some(0),
                config: cfg,
                auth: ConfigAuth::System,
                source: "test".into(),
                operator: "t".into(),
                reason: "race".into(),
            })
            .await
        })
    };
    let t1 = mk(a, barrier.clone(), mgr.clone());
    let t2 = mk(b, barrier.clone(), mgr.clone());
    let r1 = t1.await.unwrap();
    let r2 = t2.await.unwrap();
    let oks = [r1.is_ok(), r2.is_ok()];
    // 恰有一个成功 (另一个因基于过期版本 v0 被拒)
    assert_eq!(oks.iter().filter(|x| **x).count(), 1);
}

// 6. 正在运行的任务保留预期的配置版本
#[tokio::test]
async fn t6_running_task_keeps_version() {
    let mgr = ConfigManager::new(None);
    let task_snap = mgr.current(); // 任务开始时捕获 v0
    assert_eq!(task_snap.version, 0);

    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 77_000;
    mgr.apply(sys_proposal(cfg, "new")).await.unwrap();

    // 任务快照仍是 v0, 不被后续更新影响
    assert_eq!(task_snap.version, 0);
    assert_eq!(mgr.version(), 1);
}

// 7. 新任务能够使用最新的有效版本
#[tokio::test]
async fn t7_new_task_uses_latest() {
    let mgr = ConfigManager::new(None);
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 55_000;
    mgr.apply(sys_proposal(cfg, "new")).await.unwrap();
    let fresh = mgr.current();
    assert_eq!(fresh.version, 1);
    assert_eq!(fresh.config.runtime.tool_timeout_ms, 55_000);
}

// 8. 安全撤权和紧急停止不被旧快照绕过
#[tokio::test]
async fn t8_revoke_emergency_not_bypassed() {
    let mgr = ConfigManager::new(None);
    let base = vec!["shell".to_string(), "read_file".to_string()];

    let old_snap = mgr.current(); // 任务已捕获的旧快照 (无撤销)
    assert!(RuntimePolicy::tool_denied(&old_snap, "shell", &base).is_none());

    // 应用撤销 / 紧急停止 (当前配置, 独立安全路径)
    let mut cfg = AppConfig::default();
    cfg.safety.revoked_tools.push("shell".into());
    let new_snap = mgr.apply(sys_proposal(cfg, "revoke shell")).await.unwrap();
    // 旧快照仍允许 (任务级), 但当前配置拒绝 —— gate 必须读当前配置
    assert!(RuntimePolicy::tool_denied(&old_snap, "shell", &base).is_none());
    assert!(RuntimePolicy::tool_denied(&new_snap, "shell", &base).is_some());

    // 紧急停止
    let mut cfg2 = AppConfig::default();
    cfg2.safety.emergency_stop = true;
    let stop = mgr.apply(sys_proposal(cfg2, "stop")).await.unwrap();
    assert!(RuntimePolicy::tool_denied(&stop, "read_file", &base).is_some());
}

// 9. 配置回滚恢复到指定的有效版本
#[tokio::test]
async fn t9_rollback_restores_version() {
    let mgr = ConfigManager::new(None);
    let mut c1 = AppConfig::default();
    c1.runtime.tool_timeout_ms = 10_000;
    mgr.apply(sys_proposal(c1.clone(), "v1")).await.unwrap();
    let mut c2 = AppConfig::default();
    c2.runtime.tool_timeout_ms = 20_000;
    mgr.apply(sys_proposal(c2, "v2")).await.unwrap();
    assert_eq!(mgr.version(), 2);

    let rolled = mgr.rollback_to(1).await.unwrap();
    assert_eq!(rolled.config, c1);
    assert_eq!(rolled.restored_from, Some(1));
    assert_eq!(mgr.version(), 3);
}

// 10. 远程配置不可用 / 超时 / 恶意内容 → fail-closed
#[tokio::test]
async fn t10_remote_unavailable_fail_closed() {
    let mgr = ConfigManager::new(None);
    // 不可达地址 + 极短超时
    let r = mgr
        .apply_remote("http://127.0.0.1:1/never", 200, ConfigAuth::System, "t", "r")
        .await;
    assert!(matches!(r, Err(ConfigError::RemoteUnavailable(_))));
    // 当前配置不变
    assert_eq!(mgr.version(), 0);
}

// 11. 重启后配置恢复 (文件加载)
#[tokio::test]
async fn t11_restart_recovery() {
    let dir = std::env::temp_dir().join(format!("bolloon-cfg-test-{}", uuid::Uuid::new_v4()));
    let file = dir.join("config.json");
    let mgr = ConfigManager::new(Some(file.clone()));
    let mut cfg = AppConfig::default();
    cfg.runtime.tool_timeout_ms = 33_333;
    mgr.apply(sys_proposal(cfg, "persist")).await.unwrap();
    drop(mgr);

    // 模拟重启: 新 manager 从同一文件加载
    let mgr2 = ConfigManager::with_file(Some(file.clone())).await;
    let cur = mgr2.current();
    assert_eq!(cur.config.runtime.tool_timeout_ms, 33_333);
    let _ = std::fs::remove_dir_all(&dir);
}

// 12. 高频配置更新不会导致死锁 / 无限重试 / 明显退化
#[tokio::test]
async fn t12_high_frequency_no_deadlock() {
    let mgr = ConfigManager::new(None);
    let reader = {
        let v = mgr.view();
        tokio::spawn(async move {
            for _ in 0..200 {
                let _ = v.read().unwrap().clone();
            }
        })
    };
    for i in 0..500u64 {
        let mut cfg = AppConfig::default();
        cfg.runtime.tool_timeout_ms = 10_000 + i;
        mgr.apply(ConfigProposal {
            based_on: None,
            config: cfg,
            auth: ConfigAuth::System,
            source: "bench".into(),
            operator: "t".into(),
            reason: "hf".into(),
        })
        .await
        .unwrap();
    }
    reader.await.unwrap();
    assert_eq!(mgr.version(), 500);
    assert!(mgr.current().config.runtime.tool_timeout_ms >= 10_000);
}
