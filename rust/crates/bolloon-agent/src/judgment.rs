//! 判断力系统 — 注入门 / 检测蒸馏 / 入库即演化
//!
//! 对齐 TS 版 `pi-ecosystem-judgment/` 的最小闭环:
//! - 条目: 判断 (何时做/不做一件事的依据), 带 scope/channel 绑定
//! - 注入门: 按意图域挑 Top-N 注入 system (buildJudgmentHint 纯函数)
//! - 演化: 新判断入库即与全库比 jaccard 相似度 → 相似=merge / 反向=contradict / 高覆盖=supersede / 无关=新条目
//! - 留痕: 每次演化动作返回 EvolveAction (调用方落 jsonl, 无动作不写防噪音)

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 判断条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Judgment {
    pub id: String,
    /// 一句话判断 (如 "先做最小版本再迭代")
    pub statement: String,
    /// 意图域 (research/coding/communication/…; "all" = 全域)
    pub domain: String,
    /// 0.0~1.0 置信度
    pub confidence: f64,
    /// 状态
    pub status: JudgmentStatus,
    pub source: JudgmentSource,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgmentStatus {
    Active,
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JudgmentSource {
    /// 用户显式给出
    Explicit,
    /// 从轨迹蒸馏
    Trajectory,
}

/// 演化动作 (留痕用; 无动作不写)
#[derive(Debug, Clone, PartialEq)]
pub enum EvolveAction {
    /// 无动作 (不落盘, 防噪音)
    None,
    /// 与既有判断 merge (相似度 ≥ 0.8)
    Merged { with: String, new_text: String },
    /// 新判断与某条反向 (contradict) — 都保留, 标记给用户
    Contradicted { with: String },
    /// 新判断是旧判断的超集 → 旧条 superseded
    Superseded { old: String },
    /// 全库无关 → 新增
    Created { id: String },
}

/// 判断库
#[derive(Debug, Default)]
pub struct JudgmentStore {
    entries: Vec<Judgment>,
    next_id: u64,
}

/// jaccard 相似度 (词级 bigram, 对齐 TS evolve-judgment 的字面相似口径)
pub fn jaccard(a: &str, b: &str) -> f64 {
    let grams = |s: &str| -> HashSet<Vec<char>> {
        let chars: Vec<char> = s.chars().filter(|c| !c.is_whitespace()).collect();
        if chars.len() < 2 {
            return if chars.is_empty() {
                HashSet::new()
            } else {
                HashSet::from([chars])
            };
        }
        chars.windows(2).map(|w| w.to_vec()).collect()
    };
    let (ga, gb) = (grams(a), grams(b));
    if ga.is_empty() && gb.is_empty() {
        return 0.0;
    }
    let inter = ga.intersection(&gb).count() as f64;
    let union = ga.union(&gb).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

/// merge 阈值 (中文 bigram 对补充性修订约 0.6+, 无关句通常 < 0.2)
const MERGE_THRESHOLD: f64 = 0.6;
const CONTRADICT_HINTS: [&str; 4] = ["不要", "不许", "禁止", "别"];

impl JudgmentStore {
    /// JSON 落盘 (做梦/启动恢复用)
    pub fn save_json(&self, path: &std::path::Path) -> std::io::Result<()> {
        let raw = serde_json::to_string_pretty(self.snapshot())?;
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::write(path, raw)
    }

    /// JSON 载入 (坏文件 → 空库, 不冒充有判断)
    pub fn load_json(path: &std::path::Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<Judgment>>(&raw).ok())
            .map(Self::from_entries)
            .unwrap_or_default()
    }

    pub fn new() -> Self {
        Self::default()
    }

    /// 从快照恢复
    pub fn from_entries(entries: Vec<Judgment>) -> Self {
        let next_id = entries.len() as u64 + 1;
        Self { entries, next_id }
    }

    pub fn snapshot(&self) -> &[Judgment] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 入库即演化 (对齐 TS evolveNewJudgment):
    /// 相似 ≥ 0.8 → merge (文本并集) · 反向标记 → contradict · 其余 → 新增
    ///
    /// contradict 判定: 两条 statement 一方含否定词而另一方不含, 且字面相似度 ≥ 0.5
    pub fn evolve(&mut self, statement: &str, domain: &str, confidence: f64, now_ms: u64) -> EvolveAction {
        let mut best: Option<(f64, usize)> = None;
        for (i, e) in self.entries.iter().enumerate() {
            if e.status != JudgmentStatus::Active {
                continue;
            }
            let sim = jaccard(statement, &e.statement);
            if sim >= 0.35 && best.map(|(s, _)| sim > s).unwrap_or(true) {
                best = Some((sim, i));
            }
        }

        if let Some((sim, idx)) = best {
            let existing = &self.entries[idx];
            let neg_new = CONTRADICT_HINTS.iter().any(|w| statement.contains(w));
            let neg_old = CONTRADICT_HINTS.iter().any(|w| existing.statement.contains(w));
            if sim >= 0.5 && neg_new != neg_old {
                return EvolveAction::Contradicted { with: existing.id.clone() };
            }
            if sim >= MERGE_THRESHOLD {
                let merged = merge_text(&existing.statement, statement);
                let id = existing.id.clone();
                self.entries[idx].statement = merged.clone();
                return EvolveAction::Merged { with: id, new_text: merged };
            }
        }

        // 新增
        let id = format!("judg-{0:04}", self.next_id);
        self.next_id += 1;
        self.entries.push(Judgment {
            id: id.clone(),
            statement: statement.to_string(),
            domain: domain.to_string(),
            confidence: confidence.clamp(0.0, 1.0),
            status: JudgmentStatus::Active,
            source: JudgmentSource::Trajectory,
            created_at_ms: now_ms,
        });
        EvolveAction::Created { id }
    }

    /// 注入门: 按意图域挑 Top-N (domain 精确匹配优先, "all" 兜底; 置信度降序)
    ///
    /// 对齐 TS computeJudgmentGate: 无命中返回空 (不硬造 hint)
    pub fn top_for_domain(&self, domain: &str, top_n: usize) -> Vec<&Judgment> {
        let mut hits: Vec<&Judgment> = self
            .entries
            .iter()
            .filter(|e| e.status == JudgmentStatus::Active)
            .filter(|e| e.domain == domain || e.domain == "all")
            .collect();
        hits.sort_by(|a, b| {
            let dom_a = a.domain == domain;
            let dom_b = b.domain == domain;
            dom_b.cmp(&dom_a).then(b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal))
        });
        hits.into_iter().take(top_n).collect()
    }

    /// 注入 hint 文本 (纯函数, 空 = 不注入)
    pub fn build_hint(domain: &str, picks: &[&Judgment]) -> Option<String> {
        if picks.is_empty() {
            return None;
        }
        let lines: Vec<String> = picks
            .iter()
            .map(|j| format!("- [{} {:.2}] {}", j.id, j.confidence, j.statement))
            .collect();
        Some(format!("【绑定判断力 · {domain}】\n{}", lines.join("\n")))
    }

    /// 检测蒸馏节流 key 归一化 (对齐 TS channelKeyOf: 修节流 key bug 的教训)
    pub fn channel_key_of(channel_id: Option<&str>, domain: Option<&str>) -> String {
        if let Some(c) = channel_id {
            return c.to_string();
        }
        if let Some(d) = domain {
            return d.strip_prefix("channel:").unwrap_or(d).to_string();
        }
        "default".into()
    }
}

/// merge 文本: 短句并入长句去重 (纯函数)
fn merge_text(old: &str, new: &str) -> String {
    if new.chars().count() > old.chars().count() {
        format!("{old}（补充：{new}）")
    } else {
        format!("{new}（补充：{old}）")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(entries: Vec<(&str, &str, f64)>) -> JudgmentStore {
        let mut s = JudgmentStore::new();
        for (i, (st, dom, conf)) in entries.iter().enumerate() {
            s.entries.push(Judgment {
                id: format!("judg-{i:04}"),
                statement: st.to_string(),
                domain: dom.to_string(),
                confidence: *conf,
                status: JudgmentStatus::Active,
                source: JudgmentSource::Explicit,
                created_at_ms: 0,
            });
        }
        s.next_id = entries.len() as u64;
        s
    }

    #[test]
    fn jaccard_identical_and_disjoint() {
        assert!((jaccard("先做最小版本再迭代", "先做最小版本再迭代") - 1.0).abs() < 1e-9);
        assert_eq!(jaccard("先做最小版本", "完全不一样的话题"), 0.0);
    }

    #[test]
    fn evolve_merges_similar() {
        let mut s = store_with(vec![("先做最小版本再迭代，不要过度设计", "coding", 0.9)]);
        let action = s.evolve("先做最小版本再迭代，不要过度设计（补充了成本考量）", "coding", 0.8, 1);
        assert!(matches!(action, EvolveAction::Merged { .. }), "{action:?}");
    }

    #[test]
    fn evolve_creates_unrelated() {
        let mut s = store_with(vec![("先做最小版本再迭代", "coding", 0.9)]);
        let action = s.evolve("回复用户用中文", "communication", 0.9, 1);
        assert!(matches!(action, EvolveAction::Created { .. }));
        assert_eq!(s.len(), 2);
    }

    #[test]
    fn evolve_detects_contradiction() {
        let mut s = store_with(vec![("主动给用户发总结", "communication", 0.9)]);
        let action = s.evolve("不要主动给用户发总结", "communication", 0.9, 1);
        assert!(matches!(action, EvolveAction::Contradicted { .. }), "反向必须标给用户, 不许静默 merge");
    }

    #[test]
    fn gate_top_for_domain_prefers_exact() {
        let s = store_with(vec![
            ("通用判断", "all", 0.99),
            ("编码判断", "coding", 0.5),
        ]);
        let picks = s.top_for_domain("coding", 2);
        assert_eq!(picks[0].statement, "编码判断", "精确域优先于 all 兜底");
    }

    #[test]
    fn gate_empty_domain_returns_none_hint() {
        let s = store_with(vec![("编码判断", "coding", 0.9)]);
        let picks = s.top_for_domain("research", 3);
        assert!(JudgmentStore::build_hint("research", &picks).is_none(), "无命中不硬造 hint");
    }

    #[test]
    fn gate_hint_contains_statements() {
        let s = store_with(vec![("先做最小版本再迭代", "coding", 0.9)]);
        let picks = s.top_for_domain("coding", 3);
        let hint = JudgmentStore::build_hint("coding", &picks).unwrap();
        assert!(hint.contains("先做最小版本再迭代"));
        assert!(hint.contains("0.90"));
    }

    #[test]
    fn channel_key_normalizes_domain_prefix() {
        // 教训: detect-hook 存 domain='channel:x' 而 evolve 读 channelId ⇒ 节流永不生效
        assert_eq!(JudgmentStore::channel_key_of(Some("c1"), None), "c1");
        assert_eq!(JudgmentStore::channel_key_of(None, Some("channel:x")), "x");
        assert_eq!(JudgmentStore::channel_key_of(None, Some("plain")), "plain");
        assert_eq!(JudgmentStore::channel_key_of(None, None), "default");
    }

    #[test]
    fn evolve_no_action_on_low_similarity() {
        let mut s = store_with(vec![("判断 A 内容很不一样", "coding", 0.9)]);
        let action = s.evolve("完全不同的另一句话", "coding", 0.9, 1);
        assert!(matches!(action, EvolveAction::Created { .. }));
    }
}
