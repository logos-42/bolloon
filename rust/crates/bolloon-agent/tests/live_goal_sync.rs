//! 确定性集成测试: 自建临时 SQLite 信念库 + 临时 goals 目录, 钉住
//! 「agent 自己立的目标 → 同步进项目 goal 体系」这条链。
//!
//! 2026-11-08 清理挂起记录: 以前默认 `#[ignore]`, 因为要读**真实**
//! `~/.bolloon/agent/beliefs.db`、写真实 `~/.bolloon/goals/`, 数据一漂移就假红或污染。
//! 现在完全自带数据、不碰用户目录, 直接进默认测试套件 (与 live_beliefs 同一口径)。

use bolloon_agent::belief::{BeliefKind, BeliefOrigin, BeliefStore, Horizon};

fn unique_dir() -> std::path::PathBuf {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("bolloon_live_goal_sync_{}_{}", std::process::id(), now))
}

#[test]
fn live_store_syncs_into_project_goals() {
    let dir = unique_dir();
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let db = dir.join("beliefs.db");
    let goals_dir = dir.join("goals");

    let mut store = BeliefStore::default();
    let (bid, _) = store
        .upsert_belief(
            "主动性必须有内容",
            BeliefKind::SelfModel,
            BeliefOrigin::SelfReasoned,
            Some(0.8),
            None,
            1,
        )
        .unwrap();
    store
        .upsert_commitment(
            "验证目标同步闭环",
            Horizon::Short,
            Some(&bid),
            "把目标落成 goal 文件",
            None,
            None,
            1,
        )
        .unwrap();
    store.save(&db).expect("写临时 SQLite 信念库");

    let loaded = BeliefStore::load(&db);
    assert!(
        !loaded.commitments.is_empty(),
        "库存在却读成空: 表结构与 BeliefStore 不匹配"
    );
    let n = loaded
        .sync_goal_files(&goals_dir, 1_793_758_200_000)
        .expect("同步失败");
    assert!(n > 0, "有目标却一个都没同步");
    for c in loaded.active_commitments() {
        assert!(
            goals_dir.join(format!("{}.json", c.id)).exists(),
            "目标 {} 没落到 goal 目录",
            c.id
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}
