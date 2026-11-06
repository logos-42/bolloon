//! 确定性集成测试: 自建临时 SQLite 信念库, 钉住整条链
//! `写库 → 读回 → 渲染(含预算截断) → 挑下一步 → 心跳落 todo → 待办层可读`。
//!
//! 2026-11-06 修正: 以前读**本机真实** `~/.bolloon/agent/beliefs.db`, 数据一漂移就假红
//! (16 信念/13 目标把 prompt 预算吃光, 「现在该做的」被截断)。现在完全自带数据,
//! 不碰用户目录, 也不依赖本机当时有没有活着的目标。
//!
//! 注意: `BOLLOON_AGENT_DIR` 是**进程级**环境变量, 所以这里合并成单个测试顺序执行,
//! 避免两个测试并行时互相改对方目录; 退出前恢复原值并清理临时目录。

use bolloon_agent::belief::{BeliefKind, BeliefOrigin, BeliefStore, Horizon};

fn unique_dir() -> std::path::PathBuf {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "bolloon_live_beliefs_{}_{}",
        std::process::id(),
        now
    ))
}

#[test]
fn beliefs_db_roundtrip_render_and_initiative_todo() {
    let dir = unique_dir();
    std::fs::create_dir_all(&dir).expect("建临时目录");
    let db = dir.join("beliefs.db");

    // ── 隔离 agent 目录 (恢复原值, 不污染同进程其它测试) ──
    let prev = std::env::var("BOLLOON_AGENT_DIR").ok();
    unsafe { std::env::set_var("BOLLOON_AGENT_DIR", &dir) };

    // ① 造数据: 1 条信念 + 1 个 open 目标 + 一批"占预算"的长信念
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
    let (gid, _) = store
        .upsert_commitment(
            "验证闭环",
            Horizon::Short,
            Some(&bid),
            "把下一步落成待办",
            None,
            None,
            1,
        )
        .unwrap();
    for i in 0..20 {
        store
            .upsert_belief(
                &format!("第{i}条很长的信念陈述用来占满提示词预算xxxxxxxxxxxxxxxxxxxxxxxx"),
                BeliefKind::SelfModel,
                BeliefOrigin::SelfReasoned,
                Some(0.5),
                None,
                (i + 10) as u64,
            )
            .unwrap();
    }
    store.save(&db).expect("写 SQLite 信念库");
    assert!(db.exists(), "库文件必须真的落盘");

    // ② 真 SQLite 往返: load 不许静默回落成空库 (表结构/枚举对不上就在这里钉住)
    let loaded = BeliefStore::load(&db);
    assert!(
        !loaded.beliefs.is_empty() && !loaded.commitments.is_empty(),
        "库存在却读成空: 表结构与 BeliefStore 不匹配 ({})",
        db.display()
    );

    // ③ 渲染: 预算很紧时「现在该做的」也不能被截掉 (2026-11-06 修过的真 bug)
    let text = loaded.render(400);
    assert!(text.contains("## 信念"), "渲染缺少信念段:\n{text}");
    assert!(
        text.contains("## 现在该做的"),
        "渲染缺少『现在该做』:\n{text}"
    );
    assert!(text.contains("把下一步落成待办"), "下一步丢了:\n{text}");

    // ④ 按信念排队能挑出非空下一步
    let pick = loaded
        .pick_next(1_793_756_100_000)
        .expect("有活着目标就该挑出一个");
    assert!(!pick.next_action.is_empty(), "挑出的下一步不能为空");

    // ⑤ 心跳: 挑出的目标落成 todo, 且幂等 (同一动作不重复入清单)
    let tick = bolloon_agent::belief_tools::tick_into_todo(2)
        .expect("有活着目标时心跳应挑出下一步");
    assert_eq!(tick.0, gid);
    assert_eq!(tick.1, "把下一步落成待办");
    bolloon_agent::belief_tools::tick_into_todo(3);
    let progress = bolloon_agent::belief_tools::todo_progress_text()
        .expect("todo.json 应可读并进 prompt");
    assert_eq!(
        progress.matches("把下一步落成待办").count(),
        1,
        "幂等: {progress}"
    );

    // ── 收尾 ──
    match prev {
        Some(v) => unsafe { std::env::set_var("BOLLOON_AGENT_DIR", v) },
        None => unsafe { std::env::remove_var("BOLLOON_AGENT_DIR") },
    }
    let _ = std::fs::remove_dir_all(&dir);
}
