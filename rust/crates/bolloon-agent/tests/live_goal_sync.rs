//! 真机检查: 把本机 `~/.bolloon/agent/beliefs.db` 里的目标同步进**项目既有 goal 目录**
//! `~/.bolloon/goals/` —— 这是"agent 自己立的目标出现在项目 goal 体系里"的唯一证据。
//!
//! 默认 `#[ignore]`: 它会写真实 home。要跑:
//! `cargo test -p bolloon-agent --test live_goal_sync -- --ignored --test-threads=1`

use bolloon_agent::belief::BeliefStore;

#[test]
#[ignore]
fn live_store_syncs_into_project_goals() {
    let home = std::env::var("HOME").unwrap_or_default();
    let beliefs = std::path::PathBuf::from(&home).join(".bolloon/agent/beliefs.db");
    if !beliefs.exists() {
        return;
    }
    let store = BeliefStore::load(&beliefs);
    if store.commitments.is_empty() {
        return;
    }
    let goals_dir = std::path::PathBuf::from(&home).join(".bolloon/goals");
    let n = store.sync_goal_files(&goals_dir, 1_793_758_200_000).expect("同步失败");
    assert!(n > 0, "有目标却一个都没同步");
    for c in store.active_commitments() {
        let p = goals_dir.join(format!("{}.json", c.id));
        assert!(p.exists(), "目标 {} 没落到 goal 目录", c.id);
    }
}