//! Skills 运行时 — 轻量索引注入 + run 结束经验提炼自动进化
//!
//! 纪律 (本批冻结):
//! - **工具/技能加载流程避免上下文腐烂**: system prompt 只注入**索引** (名字+一句描述,
//!   每条一行); 全文按需加载 (read_skill), 不把 schema/正文全量塞 prompt
//! - **每轮开始前 skills 加载**: 索引随每轮 system 注入 (稳定层)
//! - **结束后自动进化迭代**: run 收尾 → 提炼工作经验 (lesson) → 生成 SkillCandidate →
//!   批准后晋升为 skill (写入 skills 目录) → **下一轮索引自动包含** (复用)
//! - 垃圾防噪: 空内容/重复/超长 → 拒绝晋升 (对齐 TS SkillJunkReason)

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// 索引行格式 (轻量: 一条一行)
pub const SKILL_INDEX_FORMAT: &str = "- {name}: {description}";

/// 技能条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// 全文 (read_skill 按需加载, 不进索引)
    pub body: String,
    /// 来源: builtin | learned (经验提炼晋升)
    pub origin: SkillOrigin,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkillOrigin {
    Builtin,
    Learned,
}

/// 经验候选 (run 收尾提炼)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkillCandidate {
    pub name: String,
    pub description: String,
    pub body: String,
    /// 来源 run id (证据回查)
    pub source_run: String,
}

/// 候选拒绝原因 (垃圾防噪)
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CandidateError {
    #[error("空内容")]
    Empty,
    #[error("正文超长 (>{0} 字符) — skill 是方法不是论文")]
    TooLong(usize),
    #[error("与既有 skill 重复 (内容哈希相同)")]
    Duplicate,
    #[error("skill 已存在同名")]
    NameExists,
}

/// Skills 注册表
#[derive(Debug, Default)]
pub struct SkillsRegistry {
    skills: BTreeMap<String, Skill>,
    /// 内容哈希 (去重)
    hashes: std::collections::HashSet<String>,
}

impl SkillsRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册内置 skill (启动时装载)
    pub fn register(&mut self, name: &str, description: &str, body: &str, now_ms: u64) -> Result<(), CandidateError> {
        let h = content_hash(body);
        if self.hashes.contains(&h) {
            return Err(CandidateError::Duplicate);
        }
        self.hashes.insert(h);
        self.skills.insert(
            name.into(),
            Skill {
                name: name.into(),
                description: description.into(),
                body: body.into(),
                origin: SkillOrigin::Builtin,
                created_at_ms: now_ms,
            },
        );
        Ok(())
    }

    /// **轻量索引注入** (每轮 system prompt 用; 一条一行, 防上下文腐烂)
    pub fn index_for_prompt(&self) -> String {
        let mut out = String::from("【可用技能】(read_skill 按需加载全文)\n");
        for s in self.skills.values() {
            out.push_str(&format!(
                "- {}: {}\n",
                s.name,
                s.description.chars().take(60).collect::<String>()
            ));
        }
        out
    }

    /// read_skill 按需全文
    pub fn read_skill(&self, name: &str) -> Option<&str> {
        self.skills.get(name).map(|s| s.body.as_str())
    }

    pub fn len(&self) -> usize {
        self.skills.len()
    }

    pub fn is_empty(&self) -> bool {
        self.skills.is_empty()
    }

    pub fn learned_count(&self) -> usize {
        self.skills.values().filter(|s| s.origin == SkillOrigin::Learned).count()
    }
}

/// 经验提炼器 (run 收尾 → 候选 → 晋升 → 下一轮复用)
#[derive(Debug, Default)]
pub struct SkillEvolver {
    pub registry: SkillsRegistry,
    /// 提炼留痕 (audit)
    pub log: Vec<String>,
}

/// 正文上限
pub const SKILL_BODY_MAX: usize = 4000;

impl SkillEvolver {
    pub fn new() -> Self {
        Self::default()
    }

    /// run 收尾: 提炼工作经验 → 候选
    ///
    /// 输入: run 的 (教训, 来源 run id)。空教训/超长 → 如实拒 (不硬造候选)。
    pub fn distill(&self, lesson: &str, run_id: &str) -> Result<SkillCandidate, CandidateError> {
        let lesson = lesson.trim();
        if lesson.is_empty() {
            return Err(CandidateError::Empty);
        }
        if lesson.chars().count() > SKILL_BODY_MAX {
            return Err(CandidateError::TooLong(lesson.chars().count()));
        }
        // 候选: 第一行 = 名字, 其余 = 正文
        let (name, body) = match lesson.split_once('\n') {
            Some((n, b)) => (n.trim(), b.trim()),
            None => (lesson, lesson),
        };
        let name = name.trim_start_matches("# ").to_string();
        Ok(SkillCandidate {
            name,
            description: body.chars().take(60).collect(),
            body: lesson.to_string(),
            source_run: run_id.into(),
        })
    }

    /// 晋升候选为 skill (**批准门** — 未批准不入库, 防自动污染)
    pub fn promote(&mut self, cand: &SkillCandidate, now_ms: u64) -> Result<(), CandidateError> {
        if cand.body.trim().is_empty() {
            return Err(CandidateError::Empty);
        }
        if cand.body.chars().count() > SKILL_BODY_MAX {
            return Err(CandidateError::TooLong(cand.body.chars().count()));
        }
        let h = content_hash(&cand.body);
        if self.registry.hashes.contains(&h) {
            return Err(CandidateError::Duplicate);
        }
        if self.registry.skills.contains_key(&cand.name) {
            return Err(CandidateError::NameExists);
        }
        self.registry.hashes.insert(h);
        self.registry.skills.insert(
            cand.name.clone(),
            Skill {
                name: cand.name.clone(),
                description: cand.description.clone(),
                body: cand.body.clone(),
                origin: SkillOrigin::Learned,
                created_at_ms: now_ms,
            },
        );
        self.log.push(format!("promoted: {} (from {})", cand.name, cand.source_run));
        Ok(())
    }
}

fn content_hash(s: &str) -> String {
    let d = Sha256::digest(s.trim().as_bytes());
    hex::encode(d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_lightweight_lines() {
        let mut r = SkillsRegistry::new();
        let long_body = "全文".repeat(500);
        r.register("review", "收尾前逐条核对判据", &long_body, 1).unwrap();
        r.register("compress", "历史压缩管道", "正文", 2).unwrap();
        let idx = r.index_for_prompt();
        assert!(idx.contains("- review: 收尾前逐条核对判据"));
        assert!(idx.contains("- compress: 历史压缩管道"));
        assert!(
            !idx.contains(&long_body),
            "索引不含全文 (防上下文腐烂)"
        );
        // 索引行数 = 头 + 条数
        assert_eq!(idx.lines().count(), 3);
    }

    #[test]
    fn read_skill_loads_full_body_on_demand() {
        let mut r = SkillsRegistry::new();
        r.register("x", "d", "全文正文 ABC", 1).unwrap();
        assert_eq!(r.read_skill("x"), Some("全文正文 ABC"));
        assert!(r.read_skill("ghost").is_none());
    }

    #[test]
    fn distill_lesson_to_candidate() {
        let e = SkillEvolver::new();
        let c = e
            .distill("# 先做最小版本\n大而全首版从未按时交付。", "run-1")
            .unwrap();
        assert_eq!(c.name, "先做最小版本");
        assert_eq!(c.source_run, "run-1");
    }

    #[test]
    fn distill_rejects_empty_and_overlong() {
        let e = SkillEvolver::new();
        assert_eq!(e.distill("  ", "r").unwrap_err(), CandidateError::Empty);
        let long = "x".repeat(5000);
        assert!(matches!(
            e.distill(&long, "r"),
            Err(CandidateError::TooLong(_))
        ));
    }

    #[test]
    fn promote_then_next_round_index_includes_it() {
        let mut e = SkillEvolver::new();
        e.registry.register("builtin", "内置", "b", 1).unwrap();
        let c = e.distill("# 复盘法\n先对账再重试", "run-9").unwrap();
        e.promote(&c, 2).unwrap();
        // 下一轮索引自动包含 learned skill
        let idx = e.registry.index_for_prompt();
        assert!(idx.contains("复盘法"), "晋升后下一轮可复用");
        assert_eq!(e.registry.learned_count(), 1);
        assert_eq!(e.log, vec!["promoted: 复盘法 (from run-9)"]);
    }

    #[test]
    fn promote_guards() {
        let mut e = SkillEvolver::new();
        let c = e.distill("# 方法 A\n正文", "r").unwrap();
        e.promote(&c, 1).unwrap();
        // 重复内容拒
        let c2 = e.distill("# 别的名字\n正文", "r2").unwrap();
        // 注意: body 是整段 (含名字行), 改名字行 = body 变 → 不算重复 (如实固化这条语义)
        assert!(e.promote(&c2, 2).is_ok(), "只改名字 ⇒ body 不同 ⇒ 不是同一件, 不误杀");
        // 模拟真重复:
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "方法 A".into(),
                description: "d".into(),
                body: "# 方法 A\n正文".into(),
                source_run: "r".into(),
            }, 2),
            Err(CandidateError::Duplicate)
        ));
        // 同名拒
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "方法 A".into(),
                description: "d".into(),
                body: "不同正文".into(),
                source_run: "r".into(),
            }, 3),
            Err(CandidateError::NameExists)
        ));
        // 空拒
        assert!(matches!(
            e.promote(&SkillCandidate {
                name: "空".into(),
                description: String::new(),
                body: "   ".into(),
                source_run: "r".into(),
            }, 4),
            Err(CandidateError::Empty)
        ));
    }

    #[test]
    fn candidate_requires_approval_semantics() {
        // 纪律: distill 只产候选 (不入库); promote 是唯一入库口 (批准门)
        let e = SkillEvolver::new();
        let c = e.distill("# 新经验\n内容", "r").unwrap();
        assert_eq!(e.registry.len(), 0, "distill 不入库");
        let mut e2 = SkillEvolver::new();
        e2.promote(&c, 1).unwrap();
        assert_eq!(e2.registry.len(), 1);
    }
}
