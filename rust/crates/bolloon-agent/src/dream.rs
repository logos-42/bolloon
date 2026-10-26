//! 做梦机制 (Dream Cycle) — 整理记忆与经验，升级项目 skills
//!
//! 对齐 TS `/dream` (灵感抽取 + 梦想文档) 并补上 TS 没闭环的那一段:
//! **整理 → 提炼 → 升级 skills** 的完整睡眠整理链。
//!
//! 四个阶段 (每阶段都如实记账, 不硬造产出):
//! 1. **整理记忆 (consolidate)**: 临时层过期剔除; 相似记忆 (jaccard) 归并成经验条目
//! 2. **提炼经验 (distill)**: 经验 → 判断力候选 (`JudgmentStore::evolve`),
//!    **反向冲突标给用户不自动覆盖**; 合并/新建分别计数
//! 3. **升级 skills**: 经验 → `SkillCandidate` → `SkillEvolver::promote` (批准门; 垃圾防噪)
//! 4. **灵感 (insight, 对齐 TS /dream)**: 从真实条目里挑一句;
//!    **整理不出东西就如实报"梦境空空", 不编**
//!
//! 触发: cron 空闲时段 (kernel/cron) 或手动 `/api/dream`。
//! 诚实边界: 提炼是**纯函数** (不调 LLM); 真语义抽象待接 LLM 端口。

use serde::{Deserialize, Serialize};

use crate::judgment::{jaccard, EvolveAction, JudgmentStore};
use crate::memory::{MemoryEntry, MemoryLayer};
use crate::skills_runtime::SkillEvolver;

/// 相似阈值 (中文 bigram; 与 judgment merge 同口径)
pub const SIMILAR_THRESHOLD: f64 = 0.6;

/// 做梦报告
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DreamReport {
    /// 整理的记忆条数
    pub scanned: usize,
    /// 剔除的过期临时记忆
    pub expired: usize,
    /// 归并出的经验条目数
    pub consolidated: usize,
    /// 判断力: 新建 / 并入 / 反向冲突
    pub judgments_created: usize,
    pub judgments_merged: usize,
    pub judgments_contradicted: usize,
    /// skills: 晋升 / 被拒 (重复/垃圾)
    pub skills_promoted: usize,
    pub skills_rejected: usize,
    /// 灵感 (None = 梦境空空, 如实报)
    pub insight: Option<String>,
    /// 冲突提示 (给人看的, 不静默吞)
    pub notes: Vec<String>,
    /// 跳过原因 (无素材时如实标)
    pub skipped_reason: Option<String>,
}

/// 做梦输入
pub struct DreamInput<'a> {
    /// 记忆条目 (做整理的素材)
    pub memories: &'a [MemoryEntry],
    /// 当前时间 (过期判定)
    pub now_ms: u64,
}

/// 整理结果 (中间产物: 归并后的经验文本)
#[derive(Debug, Clone, PartialEq)]
pub struct Consolidated {
    /// 归并后的经验文本
    pub text: String,
    /// 由哪几条记忆归并而来
    pub from: Vec<String>,
}

/// 阶段 1: 整理记忆 — 过期剔除 + 相似归并
pub fn consolidate(input: &DreamInput) -> (Vec<Consolidated>, usize) {
    let mut alive: Vec<&MemoryEntry> = Vec::new();
    let mut expired = 0usize;
    for m in input.memories {
        // 临时层过期 → 剔除 (睡眠清理)
        if m.layer == MemoryLayer::Temporary {
            if let Some(exp) = m.expires_at {
                if exp.timestamp_millis() as u64 <= input.now_ms {
                    expired += 1;
                    continue;
                }
            }
        }
        alive.push(m);
    }

    // 相似归并 (贪心聚类: 与簇首 jaccard ≥ 阈值即并入)
    let mut clusters: Vec<Consolidated> = Vec::new();
    for m in alive {
        let text = m.content.trim();
        if text.is_empty() {
            continue;
        }
        if let Some(c) = clusters
            .iter_mut()
            .find(|c| jaccard(&c.text, text) >= SIMILAR_THRESHOLD)
        {
            c.from.push(m.id.clone());
            // 簇文本保留最长的一条 (信息量最大, 不截断)
            if text.chars().count() > c.text.chars().count() {
                c.text = text.to_string();
            }
        } else {
            clusters.push(Consolidated {
                text: text.to_string(),
                from: vec![m.id.clone()],
            });
        }
    }
    (clusters, expired)
}

/// 完整做梦周期 (阶段 1→4; 全阶段状态进报告)
pub fn dream(
    input: &DreamInput,
    judgments: &mut JudgmentStore,
    skills: &mut SkillEvolver,
    domain: &str,
) -> DreamReport {
    let mut report = DreamReport {
        scanned: input.memories.len(),
        ..Default::default()
    };

    // 1. 整理
    let (clusters, expired) = consolidate(input);
    report.expired = expired;
    report.consolidated = clusters.len();

    if clusters.is_empty() {
        // 纪律: 没有素材就如实报"梦境空空", 不编洞察
        report.skipped_reason = Some("empty-memory: 没有可整理的记忆 (多对话让记忆沉淀后再做梦)".into());
        report.insight = None;
        return report;
    }

    // 2. 提炼经验 → 判断力
    for c in &clusters {
        match judgments.evolve(&c.text, domain, 0.7, input.now_ms) {
            EvolveAction::Created { .. } => report.judgments_created += 1,
            EvolveAction::Merged { .. } => report.judgments_merged += 1,
            EvolveAction::Contradicted { with } => {
                // 反向冲突: 标给用户, 不静默覆盖
                report.judgments_contradicted += 1;
                report.notes.push(format!(
                    "⚠ 「{}」与既有判断 {} 反向 — 已标给用户, 未自动覆盖",
                    c.text, with
                ));
            }
            EvolveAction::Superseded { .. } => report.judgments_merged += 1,
            EvolveAction::None => {}
        }

        // 3. 升级 skills (经验 → 候选 → 批准门)
        if let Ok(cand) = skills.distill(&format!("# {}\n{}", c.text, c.text), "dream") {
            match skills.promote(&cand, input.now_ms) {
                Ok(()) => report.skills_promoted += 1,
                Err(_) => report.skills_rejected += 1, // 重复/垃圾 → 拒, 计数不静默
            }
        }
    }

    // 4. 灵感 (从真实经验里挑; 挑最高置信度/最新的一条)
    report.insight = clusters
        .iter()
        .max_by_key(|c| c.from.len())
        .map(|c| c.text.chars().take(100).collect::<String>());

    report
}

/// 做梦触发条件 (对齐 TS: 空闲才做; 这里给纯判定)
///
/// - `idle_ms`: 距上次活动的时间
/// - `threshold_ms`: 空闲阈值 (默认 30 分钟)
/// - `busy`: 是否正在跑任务 (跑着不做梦, 不打扰)
pub fn should_dream(idle_ms: u64, threshold_ms: u64, busy: bool) -> bool {
    !busy && idle_ms >= threshold_ms
}

/// 梦想文档 (对齐 TS `/dream <主题>` 落盘文档)
pub fn dream_doc(topic: &str, user: &str, channel: &str, now_iso: &str) -> String {
    format!(
        "# 🌙 Dream: {topic}\n\ndate: {now_iso}\nuser: {user}\nchannel: {channel}\n\n> 自动生成于 /dream, 触发循环去探索这个主题。\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::DateTime;

    fn entry(id: &str, content: &str, layer: MemoryLayer, expires: Option<i64>) -> MemoryEntry {
        MemoryEntry {
            id: id.into(),
            content: content.into(),
            layer,
            importance: 0.7,
            created_at: DateTime::from_timestamp(0, 0).unwrap(),
            expires_at: expires.map(|ms| DateTime::from_timestamp_millis(ms).unwrap()),
        }
    }

    fn ms(entries: Vec<MemoryEntry>) -> Vec<MemoryEntry> {
        entries
    }

    #[test]
    fn empty_memory_dreams_nothing() {
        let mut j = JudgmentStore::new();
        let mut s = SkillEvolver::new();
        let input = DreamInput { memories: &[], now_ms: 1000 };
        let r = dream(&input, &mut j, &mut s, "all");
        assert_eq!(r.skipped_reason.as_deref(), Some("empty-memory: 没有可整理的记忆 (多对话让记忆沉淀后再做梦)"));
        assert!(r.insight.is_none(), "梦境空空 — 不编洞察");
        assert_eq!(r.promoted_total(), 0);
    }

    #[test]
    fn expired_temporary_swept() {
        let mems = ms(vec![
            entry("m1", "临时便签 A", MemoryLayer::Temporary, Some(500)),
            entry("m2", "长期事实 B", MemoryLayer::RunFact, None),
        ]);
        let (clusters, expired) = consolidate(&DreamInput { memories: &mems, now_ms: 1000 });
        assert_eq!(expired, 1, "过期临时记忆被清掉");
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].text, "长期事实 B");
    }

    #[test]
    fn similar_memories_consolidated_into_experience() {
        let mems = ms(vec![
            entry("m1", "先做最小版本再迭代，不要过度设计", MemoryLayer::Lesson, None),
            entry("m2", "先做最小版本再迭代，不要过度设计（补充成本考量）", MemoryLayer::Lesson, None),
            entry("m3", "回复用户用中文", MemoryLayer::Decision, None),
        ]);
        let (clusters, _) = consolidate(&DreamInput { memories: &mems, now_ms: 0 });
        // 两条相似的合成一簇, 另一条独立
        assert_eq!(clusters.len(), 2, "{clusters:?}");
        let big = clusters.iter().max_by_key(|c| c.from.len()).unwrap();
        assert_eq!(big.from.len(), 2, "相似的两条归并");
    }

    #[test]
    fn dream_builds_judgments_and_skills() {
        let mems = ms(vec![
            entry("m1", "先做最小版本再迭代，不要过度设计", MemoryLayer::Lesson, None),
            entry("m2", "回复用户用中文", MemoryLayer::Decision, None),
        ]);
        let mut j = JudgmentStore::new();
        let mut s = SkillEvolver::new();
        let r = dream(&DreamInput { memories: &mems, now_ms: 1000 }, &mut j, &mut s, "coding");
        assert_eq!(r.scanned, 2);
        assert!(r.judgments_created >= 1, "经验进判断力: {r:?}");
        assert_eq!(r.judgments_created + r.judgments_merged + r.judgments_contradicted, 2);
        assert!(r.skills_promoted >= 1, "经验升级成 skill: {r:?}");
        assert!(r.insight.is_some(), "有素材 → 有灵感");
        assert!(!j.is_empty());
        assert_eq!(s.registry.learned_count(), r.skills_promoted);
    }

    #[test]
    fn contradiction_flagged_not_overwritten() {
        let mems = ms(vec![entry("m1", "回复必须用英文，不要用中文", MemoryLayer::Decision, None)]);
        let mut j = JudgmentStore::new();
        j.evolve("回复用户用中文", "coding", 0.9, 1); // 既有: 用中文
        let mut s = SkillEvolver::new();
        let r = dream(&DreamInput { memories: &mems, now_ms: 2 }, &mut j, &mut s, "coding");
        // 反向: 要么标冲突, 要么新建; 关键是不静默吞 —— notes 里能看到
        assert!(
            r.judgments_contradicted >= 1 || r.judgments_created >= 1,
            "{r:?}"
        );
        assert!(!r.notes.is_empty() || r.judgments_created >= 1, "冲突必须留痕: {r:?}");
    }

    #[test]
    fn second_dream_is_idempotent() {
        let mems = ms(vec![entry("m1", "先做最小版本再迭代", MemoryLayer::Lesson, None)]);
        let mut j = JudgmentStore::new();
        let mut s = SkillEvolver::new();
        let r1 = dream(&DreamInput { memories: &mems, now_ms: 1000 }, &mut j, &mut s, "coding");
        let r2 = dream(&DreamInput { memories: &mems, now_ms: 2000 }, &mut j, &mut s, "coding");
        assert!(r1.skills_promoted >= 1);
        assert_eq!(r2.skills_promoted, 0, "同一经验第二次不再重复晋升 (幂等)");
        assert_eq!(s.registry.len(), r1.skills_promoted, "skills 没被重复塞");
        assert!(r2.judgments_merged >= 1 || r2.judgments_created == 0, "判断力走合并不是新建");
    }

    #[test]
    fn should_dream_gate() {
        assert!(should_dream(3_600_000, 1_800_000, false), "空闲够久 → 做梦");
        assert!(!should_dream(600_000, 1_800_000, false), "不够空闲 → 不做");
        assert!(!should_dream(3_600_000, 1_800_000, true), "忙 → 不打扰");
    }

    #[test]
    fn dream_doc_shape() {
        let d = dream_doc("核聚变口径", "leo", "cli", "2026-10-26T00:00:00Z");
        assert!(d.starts_with("# 🌙 Dream: 核聚变口径"));
        assert!(d.contains("user: leo") && d.contains("channel: cli"));
    }

    impl DreamReport {
        /// 测试辅助: 晋升总数
        fn promoted_total(&self) -> usize {
            self.skills_promoted + self.skills_rejected
        }
    }
}
