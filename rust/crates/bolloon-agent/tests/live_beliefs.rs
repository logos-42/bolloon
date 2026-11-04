//! 临时集成测试: 验证本机真实 `~/.bolloon/agent/beliefs.db` 能被读出并渲染。
//!
//! 为什么要有它: `BeliefStore::load` 读失败时**静默回落 default**(不崩, 但也就不生效)。
//! 表结构/枚举值一旦对不上, 表现就是"信念凭空消失", 很难查。这里钉一次真实路径。

use bolloon_agent::belief::{BeliefStore, Horizon};

#[test]
fn live_beliefs_db_reads_and_renders() {
    let home = std::env::var("HOME").unwrap_or_default();
    let dir = std::path::PathBuf::from(home).join(".bolloon").join("agent");
    let path = dir.join("beliefs.db");
    if !path.exists() {
        return; // 本机还没立过信念 —— 不算失败
    }
    let store = BeliefStore::load(&path);
    assert!(
        !store.beliefs.is_empty() || !store.commitments.is_empty(),
        "库存在却读成空: 表结构与 BeliefStore 不匹配 ({})",
        path.display()
    );
    let text = store.render(1200);
    assert!(text.contains("## 信念"), "渲染缺少信念段:\n{text}");
    assert!(text.contains("## 现在该做的"), "渲染缺少『现在该做』:\n{text}");
    let pick = store.pick_next(1_793_756_100_000).expect("有活着目标就该挑出一个");
    assert!(!pick.next_action.is_empty(), "挑出的下一步不能为空");
}

/// 整条链: 信念 → 目标 → 心跳挑下一步 → 落 todo → 待办层可读 (进 prompt)
#[test]
fn heartbeat_tick_lands_in_todo_and_is_visible_to_prompt() {
    let dir = std::env::temp_dir().join(format!("bolloon_live_tick_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    unsafe { std::env::set_var("BOLLOON_AGENT_DIR", &dir) };

    let mut store = BeliefStore::default();
    store
        .upsert_belief("主动性必须有内容", bolloon_agent::belief::BeliefKind::SelfModel, bolloon_agent::belief::BeliefOrigin::SelfReasoned, Some(0.8), None, 1)
        .unwrap();
    let (gid, _) = store
        .upsert_commitment(
            "验证闭环",
            Horizon::Short,
            Some("主动性必须有内容"),
            "把下一步落成待办",
            None,
            None,
            1,
        )
        .unwrap();
    store.save(&dir.join("beliefs.db")).unwrap();

    let tick = bolloon_agent::belief_tools::tick_into_todo(2).expect("有活着目标时心跳应挑出下一步");
    assert_eq!(tick.0, gid);
    assert_eq!(tick.1, "把下一步落成待办");

    // 幂等: 同一动作不重复入清单 (心跳不该把清单刷成重复项)
    bolloon_agent::belief_tools::tick_into_todo(3);
    let text = bolloon_agent::belief_tools::todo_progress_text().expect("todo.json 应可读");
    assert_eq!(text.matches("把下一步落成待办").count(), 1, "幂等: {text}");
}