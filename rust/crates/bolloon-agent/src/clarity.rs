//! Clarity — 一键"说清楚现在在干什么"
//!
//! 产品语义 (clarity 按钮):
//! - 用户点按钮 → 后端从 session/goal/rounds 提取**结构化现状摘要**:
//!   当前目标 / 已完成步骤 / 未决项 / 下一步 / 阻塞 —— 不让 agent 用一团文字含糊
//! - 纯函数 (输入 = 会话状态), 可测
//! - web: 侧栏 Clarity 按钮 → GET /api/clarity?session=xxx

use serde::{Deserialize, Serialize};

/// Clarity 摘要
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClaritySummary {
    pub session_id: String,
    /// 当前目标 (最近一次用户意图; 无 = 自由会话)
    pub goal: Option<String>,
    /// 已完成步骤 (assistant 轮次里带完成标记的)
    pub done: Vec<String>,
    /// 未决项 (reply 里的 unresolved/待办标记)
    pub pending: Vec<String>,
    /// 下一步 (最近一轮的 continue hint / next_action)
    pub next_step: Option<String>,
    /// 阻塞 (错误恢复事件)
    pub blockers: Vec<String>,
    /// 健康度: 0-100 (轮次消耗/错误率/review 状态的粗粒度)
    pub health: u8,
    pub reason: String,
}

/// 从会话事件提取 clarity (纯函数)
///
/// 事件形状与 SessionEvent 兼容: user/assistant 交替 + 可选工具错误行
pub fn clarity_of(
    session_id: &str,
    events: &[(&str, &str)], // (role, text)
    goal_criteria: &[String],
    recoveries: &[String],
) -> ClaritySummary {
    let goal = events
        .iter()
        .find(|(r, _)| *r == "user")
        .map(|(_, t)| t.chars().take(120).collect::<String>());

    let assistant_turns: Vec<&str> = events
        .iter()
        .filter(|(r, _)| *r == "assistant")
        .map(|(_, t)| *t)
        .collect();

    // 已完成: assistant 轮次里含完成标记
    let done: Vec<String> = assistant_turns
        .iter()
        .filter(|t| t.contains("✅") || t.contains("完成") || t.contains("done"))
        .map(|t| t.chars().take(80).collect())
        .collect();

    // 未决项: assistant 轮次里的待办标记
    let pending: Vec<String> = assistant_turns
        .iter()
        .flat_map(|t| t.lines())
        .filter(|l| l.contains("待办") || l.contains("TODO") || l.contains("未决") || l.starts_with("- [ ]"))
        .map(|l| l.chars().take(80).collect())
        .collect();

    // 下一步: 最近一条 assistant 轮次的"下一步/接下来"行
    let next_step = assistant_turns
        .last()
        .and_then(|t| {
            t.lines()
                .find(|l| l.contains("下一步") || l.contains("接下来") || l.contains("next"))
                .map(|l| l.chars().take(120).collect::<String>())
        });

    let blockers: Vec<String> = recoveries.iter().take(5).cloned().collect();

    // 健康度: 有回复 +70; 无阻塞 +30; 每阻塞 -10 (下限 0)
    let mut health: i32 = 0;
    if !assistant_turns.is_empty() {
        health += 70;
    }
    health += (30 - blockers.len() as i32 * 10).max(0);
    // goal 模式: 判据命中比例加成
    if !goal_criteria.is_empty() && !assistant_turns.is_empty() {
        let last = assistant_turns.last().unwrap();
        let hit = goal_criteria.iter().filter(|c| last.contains(c.as_str())).count();
        let ratio = hit as f64 / goal_criteria.len() as f64;
        health = (health as f64 * (0.5 + 0.5 * ratio)) as i32;
    }
    let health = health.clamp(0, 100) as u8;

    let reason = if blockers.is_empty() {
        format!("会话正常, {} 轮回复", assistant_turns.len())
    } else {
        format!("有 {} 个阻塞事件, 建议查看", blockers.len())
    };

    ClaritySummary {
        session_id: session_id.into(),
        goal,
        done,
        pending,
        next_step,
        blockers,
        health,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events() -> Vec<(&'static str, &'static str)> {
        vec![
            ("user", "调研核聚变口径并写报告"),
            ("assistant", "✅ 完成了来源检索 (6 条)\n下一步: 交叉核对口径"),
            ("user", "继续"),
            (
                "assistant",
                "✅ 完成口径核对。\n- [ ] 待办: 补充第二个数据源\n结论先行: 一致\n下一步: 写报告正文",
            ),
        ]
    }

    #[test]
    fn extracts_goal_done_pending_next() {
        let c = clarity_of("s1", &events(), &[], &[]);
        assert_eq!(c.goal.as_deref(), Some("调研核聚变口径并写报告"));
        assert_eq!(c.done.len(), 2, "两条完成标记");
        assert_eq!(c.pending.len(), 1, "一条待办");
        assert!(c.pending[0].contains("补充第二个数据源"));
        assert!(c.next_step.as_deref().unwrap().contains("写报告正文"), "取最近一轮的下一步");
        assert!(c.health >= 90, "无阻塞健康度高: {}", c.health);
    }

    #[test]
    fn blockers_reduce_health() {
        let rec = vec!["工具 bad 失败 → 错误进上下文".into()];
        let c = clarity_of("s1", &events(), &[], &rec);
        assert_eq!(c.blockers.len(), 1);
        assert!(c.health < 100);
        assert!(c.reason.contains("阻塞"));
    }

    #[test]
    fn goal_criteria_scale_health() {
        let c_hit = clarity_of("s1", &events(), &["口径".into()], &[]);
        let c_miss = clarity_of("s1", &events(), &["完全没出现".into()], &[]);
        assert!(c_hit.health > c_miss.health, "判据命中多 → 健康度高: {} vs {}", c_hit.health, c_miss.health);
    }

    #[test]
    fn empty_session_is_fresh() {
        let c = clarity_of("s0", &[], &[], &[]);
        assert!(c.goal.is_none());
        assert!(c.done.is_empty());
        assert_eq!(c.health, 30, "无回复: 只有底分 30 (无阻塞)");
        assert!(c.reason.contains("0 轮"));
    }

    #[test]
    fn summary_serializable_for_button() {
        let c = clarity_of("s1", &events(), &[], &[]);
        let j = serde_json::to_string(&c).unwrap();
        assert!(j.contains("goal") && j.contains("health"), "按钮 payload 可序列化");
    }
}
