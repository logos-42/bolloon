//! 记忆库 — 分层记忆 (importance / decay / 过期)
//!
//! 对齐 TS 版 memory-store 与 decentralized-memory-design 的最小子集:
//! - value 分层: importance (0.0~1.0) + layer
//! - decay: 召回排序 = importance × 衰减 (越旧越弱, temporary 最快)
//! - temporary 层到期自动失效 (结束即过期)
//! - recall = 按 (decay 后权重) top-k, 纯函数可测

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// 记忆层 (对齐 TS MemoryLayer 语义的子集)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryLayer {
    /// Run 事实
    RunFact,
    /// 教训
    Lesson,
    /// 决策
    Decision,
    /// 临时 (会话结束过期)
    Temporary,
}

impl std::fmt::Display for MemoryLayer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            Self::RunFact => "run_fact",
            Self::Lesson => "lesson",
            Self::Decision => "decision",
            Self::Temporary => "temporary",
        };
        f.write_str(s)
    }
}

/// 记忆条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    pub layer: MemoryLayer,
    /// 0.0 ~ 1.0
    pub importance: f64,
    pub created_at: DateTime<Utc>,
    /// temporary 层的过期时刻
    pub expires_at: Option<DateTime<Utc>>,
}

/// 记忆库
#[derive(Debug, Default)]
pub struct MemoryStore {
    entries: Vec<MemoryEntry>,
    next_id: u64,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 记住一条。importance 越界收敛到 [0,1]。
    pub fn remember(
        &mut self,
        content: impl Into<String>,
        layer: MemoryLayer,
        importance: f64,
        ttl: Option<chrono::Duration>,
    ) -> &MemoryEntry {
        let now = Utc::now();
        let entry = MemoryEntry {
            id: format!("mem-{0:06}", self.next_id),
            content: content.into(),
            layer,
            importance: importance.clamp(0.0, 1.0),
            created_at: now,
            expires_at: ttl.map(|t| now + t),
        };
        self.next_id += 1;
        self.entries.push(entry);
        self.entries.last().unwrap()
    }

    /// 活着的条目数 (temporary 过期即不算)
    pub fn alive_count(&self, now: DateTime<Utc>) -> usize {
        self.entries.iter().filter(|e| e.alive_at(now)).count()
    }

    /// 召回: 过滤失效 + 打分 (importance × decay) top-k, 按分降序
    pub fn recall(&self, query_substring: Option<&str>, top_k: usize, now: DateTime<Utc>) -> Vec<&MemoryEntry> {
        let mut scored: Vec<(f64, &MemoryEntry)> = self
            .entries
            .iter()
            .filter(|e| e.alive_at(now))
            .filter(|e| query_substring.map(|q| e.content.contains(q)).unwrap_or(true))
            .map(|e| (score_of(e, now), e))
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().take(top_k).map(|(_, e)| e).collect()
    }

    /// 遗忘 (按 id)
    pub fn forget(&mut self, id: &str) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.id != id);
        before != self.entries.len()
    }

    /// 快照 (持久化用)
    pub fn snapshot(&self) -> &[MemoryEntry] {
        &self.entries
    }

    /// 从快照恢复 (next_id 续号, 防冲突)
    pub fn from_snapshot(entries: Vec<MemoryEntry>) -> Self {
        let next_id = entries
            .iter()
            .filter_map(|e| e.id.strip_prefix("mem-").and_then(|s| s.parse::<u64>().ok()))
            .max()
            .unwrap_or(0)
            + 1;
        Self { entries, next_id }
    }
}

impl MemoryEntry {
    fn alive_at(&self, now: DateTime<Utc>) -> bool {
        self.expires_at.map(|t| now < t).unwrap_or(true)
    }
}

/// 打分 = importance × decay(half-life)
///
/// half-life 按 layer 不同: temporary 1h · lesson/fact 24h · decision 72h
pub fn score_of(e: &MemoryEntry, now: DateTime<Utc>) -> f64 {
    let half_life_h = match e.layer {
        MemoryLayer::Temporary => 1.0,
        MemoryLayer::RunFact | MemoryLayer::Lesson => 24.0,
        MemoryLayer::Decision => 72.0,
    };
    let age_h = (now - e.created_at).num_minutes().max(0) as f64 / 60.0;
    let decay = 0.5f64.powf(age_h / half_life_h);
    e.importance * decay
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remember_and_recall_topk() {
        let mut m = MemoryStore::new();
        m.remember("用户偏好暗色主题", MemoryLayer::RunFact, 0.9, None);
        m.remember("随便一条低价值记录", MemoryLayer::Temporary, 0.2, None);
        m.remember("又一个偏好: 喜欢简洁回复", MemoryLayer::RunFact, 0.8, None);

        let top = m.recall(Some("偏好"), 1, Utc::now());
        assert_eq!(top.len(), 1);
        assert!(top[0].content.contains("暗色主题"));
    }

    #[test]
    fn higher_importance_wins() {
        let mut m = MemoryStore::new();
        m.remember("低", MemoryLayer::RunFact, 0.1, None);
        m.remember("高", MemoryLayer::RunFact, 0.95, None);
        let top = m.recall(None, 1, Utc::now());
        assert_eq!(top[0].content, "高");
    }

    #[test]
    fn temporary_expires() {
        let mut m = MemoryStore::new();
        m.remember("temp", MemoryLayer::Temporary, 0.9, Some(chrono::Duration::minutes(10)));
        assert_eq!(m.alive_count(Utc::now()), 1);
        let later = Utc::now() + chrono::Duration::minutes(11);
        assert_eq!(m.alive_count(later), 0, "temporary 过期必须失效");
        assert!(m.recall(None, 10, later).is_empty());
    }

    #[test]
    fn decay_prefers_recent() {
        let mut m = MemoryStore::new();
        m.remember("新的", MemoryLayer::RunFact, 0.5, None);
        // 手工造一条 3 天前的同权重记忆
        let old = MemoryEntry {
            id: "mem-old".into(),
            content: "旧的".into(),
            layer: MemoryLayer::RunFact,
            importance: 0.5,
            created_at: Utc::now() - chrono::Duration::hours(72),
            expires_at: None,
        };
        m.entries.push(old);
        let top = m.recall(None, 1, Utc::now());
        assert_eq!(top[0].content, "新的", "同 importance 下新的应排前 (decay)");
    }

    #[test]
    fn importance_clamped() {
        let mut m = MemoryStore::new();
        let e = m.remember("越界", MemoryLayer::RunFact, 5.0, None);
        assert!((e.importance - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn forget_removes() {
        let mut m = MemoryStore::new();
        let e = m.remember("要忘的", MemoryLayer::Lesson, 0.5, None).clone();
        assert!(m.forget(&e.id));
        assert!(!m.forget(&e.id), "重复 forget 返回 false");
        assert_eq!(m.snapshot().len(), 0);
    }

    #[test]
    fn score_layer_half_lives() {
        let now = Utc::now();
        let mk = |layer, age_h| MemoryEntry {
            id: "x".into(),
            content: "x".into(),
            layer,
            importance: 1.0,
            created_at: now - chrono::Duration::hours(age_h),
            expires_at: None,
        };
        // 1 小时后: temporary 衰到一半, decision 几乎不衰
        let t = score_of(&mk(MemoryLayer::Temporary, 1), now);
        let d = score_of(&mk(MemoryLayer::Decision, 1), now);
        assert!((t - 0.5).abs() < 0.01, "temporary 1h 半衰, 实际 {t}");
        assert!(d > 0.99, "decision 1h 几乎不衰, 实际 {d}");
    }
}
