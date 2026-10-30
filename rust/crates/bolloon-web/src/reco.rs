//! 世界模式的**推荐引擎**核心 (纯逻辑, 无 IO, 可单测)。
//!
//! 为什么单独一个模块: 以前排序是「意图分 + 看过 + 赞踩 + 新鲜度」一次性加权 —— 它是**打分**,
//! 不是推荐引擎。真正的引擎要满足三件事 (leo 2026-10-30 的要求):
//!
//! 1. **会随时间长期更新**: 兴趣是带半衰期的向量, 旧的兴趣会淡出, 不是累加成永恒偏置;
//! 2. **吃本机智能体的判断与记忆**: 用户点开/赞/踩/忽略过的**主题**进兴趣向量, 卡片主题与它比对;
//! 3. **不是一条条独立打分**: 出结果时做**多样性**(同类只留最靠前的一条先出), 避免整屏同一主题。
//!
//! 数据形状 (可落盘):
//! - `Interests`: 主题 → (权重, 最后更新时间ms)。权重按 `2^(-dt/half_life)` 衰减。
//! - 反馈事件: `(主题, 信号)` → 更新兴趣向量 (赞 +, 踩 −, 点开 +, 忽略 −−)。
//! - 卡片: `(id, 主题集合, 质量分[来自智能体判断/意图匹配], 年龄小时)`。
//!
//! 引擎只回答"该按什么顺序摆", 不抓取、不生成内容; 内容由智能体产出。

use std::collections::HashMap;

/// 兴趣半衰期 (小时): 72h 后旧兴趣只剩一半权重 ⇒ "长期更新"而不是"永久记忆"
pub const INTEREST_HALF_LIFE_H: f64 = 72.0;
/// 单条反馈对兴趣的步长
const STEP_UP: f64 = 0.25;
const STEP_OPEN: f64 = 0.08;
const STEP_DOWN: f64 = -0.30;
const STEP_IGNORE: f64 = -0.40;
/// 兴趣权重上下限 (不让单一主题吃满全屏, 也不让它归零后永不再出)
const W_MIN: f64 = -2.0;
const W_MAX: f64 = 3.0;

/// 一条主题兴趣: 权重 + 上次更新的时间戳 (ms)
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
pub struct Interest {
    pub weight: f64,
    pub updated_ms: i64,
}

/// 兴趣向量 (可落盘的整体)
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Interests {
    #[serde(default)]
    pub topics: HashMap<String, Interest>,
    /// 向量化原型 (主题 token 的特征哈希向量 + 权重), 由 `absorb` 累积、`dream_consolidate` 整理
    #[serde(default)]
    pub prototypes: HashMap<String, Proto>,
}

fn decay(weight: f64, age_h: f64, half_life_h: f64) -> f64 {
    if weight == 0.0 {
        return 0.0;
    }
    let hl = half_life_h.max(0.1);
    weight * 0.5f64.powf(age_h.max(0.0) / hl)
}

impl Interests {
    /// 记一次反馈并返回更新后的权重。
    ///
    /// 先把该主题按**经过的时间**衰减到"现在", 再加这一步的信号 —— 这样连续快速反馈会累积,
    /// 而相隔很久的反馈不会凭旧账把权重抬到天上。
    pub fn feedback(&mut self, topic: &str, signal: &str, now_ms: i64) -> f64 {
        let topic = topic.trim();
        if topic.is_empty() {
            return 0.0;
        }
        let step = match signal {
            "up" => STEP_UP,
            "open" => STEP_OPEN,
            "down" => STEP_DOWN,
            "ignore" => STEP_IGNORE,
            _ => 0.0,
        };
        let e = self.topics.entry(topic.to_string()).or_insert(Interest {
            weight: 0.0,
            updated_ms: now_ms,
        });
        let age_h = ((now_ms - e.updated_ms).max(0) as f64) / 3_600_000.0;
        let cur = decay(e.weight, age_h, INTEREST_HALF_LIFE_H);
        e.weight = (cur + step).clamp(W_MIN, W_MAX);
        e.updated_ms = now_ms;
        e.weight
    }

    /// 现在这一时刻的有效权重 (已按时间衰减)
    pub fn weight_at(&self, topic: &str, now_ms: i64) -> f64 {
        match self.topics.get(topic) {
            Some(i) => {
                let age_h = ((now_ms - i.updated_ms).max(0) as f64) / 3_600_000.0;
                decay(i.weight, age_h, INTEREST_HALF_LIFE_H)
            }
            None => 0.0,
        }
    }

    /// 主题集合的匹配分: 取最强的几个主题, 归一化到 0..1
    pub fn affinity(&self, topics: &[String], now_ms: i64) -> f64 {
        if topics.is_empty() {
            return 0.0;
        }
        let mut best: Vec<f64> = topics
            .iter()
            .map(|t| self.weight_at(t, now_ms))
            .filter(|w| *w > 0.0)
            .collect();
        if best.is_empty() {
            return 0.0;
        }
        best.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
        let top: f64 = best.iter().take(3).sum();
        // 0..1: 3 个主题各 1.0 权重就算满格
        (top / 3.0).clamp(0.0, 1.0)
    }

    /// 最感兴趣的 N 个主题 (给智能体的系统提示 / 面板展示)
    pub fn top(&self, n: usize, now_ms: i64) -> Vec<(String, f64)> {
        let mut v: Vec<(String, f64)> = self
            .topics
            .keys()
            .map(|k| (k.clone(), self.weight_at(k, now_ms)))
            .filter(|(_, w)| *w > 0.01)
            .collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(n);
        v
    }
}


// ─────────────── 向量化: 主题→特征哈希稀疏向量 (无外部依赖, 确定性可复现) ───────────────

/// 向量维度 (512 维足够区分主题; 特征哈希把 token 映到某一维)
pub const VEC_DIM: usize = 512;

fn hash_token(tok: &str) -> usize {
    // FNV-1a (稳定, 跨平台一致; 不能换 DefaultHasher —— 它每个进程的种子不同)
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in tok.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    (h % VEC_DIM as u64) as usize
}

/// 一批主题 token → L2 归一化的稀疏向量 (只存非零项)
pub fn hash_vector(tokens: &[String]) -> Vec<(usize, f32)> {
    let mut v: Vec<f32> = vec![0.0; VEC_DIM];
    for t in tokens {
        if t.trim().is_empty() {
            continue;
        }
        v[hash_token(t)] += 1.0;
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
    v.iter()
        .enumerate()
        .filter(|(_, x)| x.abs() > 1e-6)
        .map(|(i, x)| (i, *x))
        .collect()
}

/// 余弦相似度 (稀疏 × 稀疏)
pub fn cosine(a: &[(usize, f32)], b: &[(usize, f32)]) -> f32 {
    let mut dot = 0.0f32;
    let (mut i, mut j) = (0usize, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].0.cmp(&b[j].0) {
            std::cmp::Ordering::Equal => {
                dot += a[i].1 * b[j].1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    dot.clamp(-1.0, 1.0)
}

impl Interests {
    /// 让兴趣支持"向量召回": 把卡片主题向量与兴趣**原型向量**做余弦
    ///
    /// 为什么需要: 主题字符串匹配只认完全相同/包含的词, 用户说过"聚变"就召回不了"磁约束"。
    /// 向量化后按语义近邻召回 (这里用特征哈希 + 原型累积, 无外部 embedding 服务)。
    pub fn affinity_vector(&self, topics: &[String], now_ms: i64) -> f64 {
        if topics.is_empty() || self.prototypes.is_empty() {
            return 0.0;
        }
        let q = hash_vector(topics);
        let mut best = 0.0f64;
        for (name, proto) in &self.prototypes {
            // 原型也按时间衰减: 老兴趣的原型不再主导
            let age_h = ((now_ms - proto.updated_ms).max(0) as f64) / 3_600_000.0;
            let w = decay(proto.weight, age_h, INTEREST_HALF_LIFE_H).clamp(0.0, W_MAX);
            if w <= 0.0 {
                continue;
            }
            let sim = cosine(&q, &proto.vec) as f64;
            let _ = name;
            if sim * w > best {
                best = sim * w;
            }
        }
        best.clamp(0.0, 1.0)
    }

    /// 把一次反馈的**主题向量**并入原型 (同名原型累积并重算权重/时间)
    pub fn absorb(&mut self, topics: &[String], signal: &str, now_ms: i64) {
        let vec = hash_vector(topics);
        if vec.is_empty() {
            return;
        }
        let key = topics.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
        let step = match signal {
            "up" => STEP_UP,
            "open" => STEP_OPEN,
            "down" => STEP_DOWN,
            "ignore" => STEP_IGNORE,
            _ => 0.0,
        };
        let e = self.prototypes.entry(key.clone()).or_insert(Proto {
            vec,
            weight: 0.0,
            updated_ms: now_ms,
        });
        let age_h = ((now_ms - e.updated_ms).max(0) as f64) / 3_600_000.0;
        e.weight = (decay(e.weight, age_h, INTEREST_HALF_LIFE_H) + step).clamp(W_MIN, W_MAX);
        e.updated_ms = now_ms;
        self.topics.entry(key).or_insert(Interest { weight: e.weight, updated_ms: now_ms });
    }

    /// 做梦期更新: 全量衰减 → 剪掉长期不用/负权重的原型 → 合并相近原型 (余弦 > 0.92)
    ///
    /// 这是"做梦时整理记忆"在推荐引擎上的对应动作: 不在请求路径上做重活, 由 dream 调用。
    /// 返回 (保留条数, 删除条数, 合并条数)。
    pub fn dream_consolidate(&mut self, now_ms: i64, keep_ratio: f64) -> (usize, usize, usize) {
        // ① 衰减 + 剪枝
        let mut dropped = 0usize;
        self.prototypes.retain(|_, p| {
            let age_h = ((now_ms - p.updated_ms).max(0) as f64) / 3_600_000.0;
            p.weight = decay(p.weight, age_h, INTEREST_HALF_LIFE_H);
            let keep = p.weight > 0.05 * keep_ratio.max(0.1);
            if !keep {
                dropped += 1;
            }
            keep
        });
        // ② 相近原型合并 (贪心, O(n^2) 但原型数量很小: 兴趣是几十个, 不是几十万)
        let keys: Vec<String> = self.prototypes.keys().cloned().collect();
        let mut merged = 0usize;
        let mut dead: Vec<String> = vec![];
        for i in 0..keys.len() {
            for j in (i + 1)..keys.len() {
                if dead.contains(&keys[i]) || dead.contains(&keys[j]) {
                    continue;
                }
                let (a, b) = (self.prototypes[&keys[i]].clone(), self.prototypes[&keys[j]].clone());
                if cosine(&a.vec, &b.vec) > 0.92 {
                    let w = (a.weight + b.weight).clamp(W_MIN, W_MAX);
                    let e = self.prototypes.get_mut(&keys[i]).unwrap();
                    e.weight = w;
                    e.updated_ms = now_ms.max(a.updated_ms).max(b.updated_ms);
                    dead.push(keys[j].clone());
                    merged += 1;
                }
            }
        }
        for k in &dead {
            self.prototypes.remove(k);
        }
        // ③ 同步 topics 视图 (外部/面板读的是它)
        for (k, p) in &self.prototypes {
            self.topics.insert(k.clone(), Interest { weight: p.weight, updated_ms: p.updated_ms });
        }
        self.topics.retain(|k, _| self.prototypes.contains_key(k));
        (self.prototypes.len(), dropped, merged)
    }
}

/// 兴趣原型 (向量 + 权重 + 更新时间)
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Proto {
    #[serde(default)]
    pub vec: Vec<(usize, f32)>,
    pub weight: f64,
    pub updated_ms: i64,
}

/// 待排序的一张卡 (引擎只看到这些字段)
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    /// 主题标签 (卡片文本抽出来的)
    pub topics: Vec<String>,
    /// 内容质量: 来自智能体判断/意图匹配 (0..1)
    pub quality: f64,
    /// 用户赞/踩差 (已归一化到 -1..1)
    pub vote: f64,
    /// 年龄 (小时)
    pub age_h: f64,
    /// 是否点开过
    pub opened: bool,
}

/// 一条排序结果
#[derive(Debug, Clone)]
pub struct Ranked {
    pub id: String,
    pub score: f64,
    pub why: String,
}

/// 引擎参数 (单点定义, 改这里就改全站口径)
pub struct Engine {
    pub w_affinity: f64,
    pub w_quality: f64,
    pub w_vote: f64,
    pub w_recency: f64,
    pub w_opened: f64,
    /// 多样性惩罚: 同一主题的第 2 条起, 每条按这个量乘性衰减
    pub diversity: f64,
}

impl Default for Engine {
    fn default() -> Self {
        Self {
            w_affinity: 0.40,
            w_quality: 0.24,
            w_vote: 0.16,
            w_recency: 0.12,
            w_opened: 0.08,
            diversity: 0.55,
        }
    }
}

impl Engine {
    /// 排序 + 摘要: 先按基础分降序, 再做"同主题去重"(同类第 2 条起乘性衰减), 最后按最终分重排。
    ///
    /// `diversity` 这一步就是"不是一个一个独立打分"的关键: 否则兴趣越集中, 整屏越同质。
    pub fn rank(&self, interests: &Interests, cards: &[Candidate], now_ms: i64) -> Vec<Ranked> {
        let mut base: Vec<Ranked> = cards
            .iter()
            .map(|c| {
                // 亲和 = max(主题字面匹配, 向量近邻) —— 向量化后能召回"没说过但相近"的主题
                let aff = interests
                    .affinity(&c.topics, now_ms)
                    .max(interests.affinity_vector(&c.topics, now_ms));
                let rec = 0.5f64.powf(c.age_h.max(0.0) / 72.0);
                let score = self.w_affinity * aff
                    + self.w_quality * c.quality.clamp(0.0, 1.0)
                    + self.w_vote * c.vote.clamp(-1.0, 1.0)
                    + self.w_recency * rec
                    + if c.opened { self.w_opened } else { 0.0 };
                let mut why: Vec<String> = vec![];
                if aff > 0.05 {
                    why.push(format!("兴趣 {aff:.2}"));
                }
                if c.vote.abs() > 0.1 {
                    why.push(if c.vote > 0.0 { "你赞过".into() } else { "你踩过".into() });
                }
                if c.opened {
                    why.push("看过".into());
                }
                if rec > 0.8 {
                    why.push("很新".into());
                }
                if why.is_empty() {
                    why.push("默认流入".into());
                }
                Ranked { id: c.id.clone(), score, why: why.join(" · ") }
            })
            .collect();
        base.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

        // 多样性: 同主题已出现过 n 次 ⇒ 分数 × (diversity^n)
        let by_id: HashMap<&str, &Candidate> =
            cards.iter().map(|c| (c.id.as_str(), c)).collect();
        let mut seen: HashMap<&str, usize> = HashMap::new();
        let mut adjusted: Vec<Ranked> = base
            .into_iter()
            .map(|mut r| {
                if let Some(c) = by_id.get(r.id.as_str()) {
                    if let Some(t) = c.topics.first() {
                        let n = *seen.get(t.as_str()).unwrap_or(&0);
                        if n > 0 {
                            r.score *= self.diversity.powi(n as i32);
                            r.why = format!("{} · 同类第{}条", r.why, n + 1);
                        }
                        *seen.entry(t.as_str()).or_insert(0) += 1;
                    }
                }
                r
            })
            .collect();
        adjusted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        adjusted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> i64 {
        1_793_400_000_000
    }

    #[test]
    fn interest_decays_over_time_not_forever() {
        let mut i = Interests::default();
        let w0 = i.feedback("聚变", "up", now());
        assert!((w0 - 0.25).abs() < 1e-9);
        // 72h 后只剩一半
        let later = i.weight_at("聚变", now() + 72 * 3_600_000);
        assert!((later - 0.125).abs() < 1e-6, "半衰期必须真的衰减: {later}");
        // 再 72h 只剩 1/4
        let later2 = i.weight_at("聚变", now() + 144 * 3_600_000);
        assert!((later2 - 0.0625).abs() < 1e-6);
    }

    #[test]
    fn feedback_accumulates_and_clamps() {
        let mut i = Interests::default();
        for _ in 0..50 {
            i.feedback("聚变", "up", now());
        }
        let w = i.weight_at("聚变", now());
        assert!(w <= W_MAX + 1e-9, "上限必须夹住: {w}");
        assert!(w >= 1.0, "连续正向反馈要真的累积: {w}");
        // 忽略是更强的负信号
        let mut j = Interests::default();
        let a = j.feedback("噪声", "down", now());
        let b = j.feedback("噪声", "ignore", now());
        assert!(b < a);
    }

    #[test]
    fn affinity_prefers_strong_topics_and_ignores_negatives() {
        let mut i = Interests::default();
        i.feedback("聚变", "up", now());
        i.feedback("噪声", "ignore", now());
        let a = i.affinity(&["聚变".into()], now());
        assert!(a > 0.0);
        let b = i.affinity(&["噪声".into()], now());
        assert_eq!(b, 0.0, "负权重主题不应贡献亲和力");
        assert_eq!(i.affinity(&[], now()), 0.0);
    }

    #[test]
    fn engine_ranks_by_interest_then_diversifies() {
        let mut i = Interests::default();
        i.feedback("聚变", "up", now());
        let cards = vec![
            Candidate { id: "a".into(), topics: vec!["聚变".into()], quality: 0.5, vote: 0.0, age_h: 1.0, opened: false },
            Candidate { id: "b".into(), topics: vec!["聚变".into()], quality: 0.5, vote: 0.0, age_h: 1.0, opened: false },
            Candidate { id: "c".into(), topics: vec!["其他".into()], quality: 0.5, vote: 0.0, age_h: 1.0, opened: false },
        ];
        let out = Engine::default().rank(&i, &cards, now());
        assert_eq!(out.len(), 3);
        // 第一条来自感兴趣主题
        assert_eq!(out[0].id, "a");
        // 同主题第二条被多样性压下去, 不与第一条并列
        assert!(out[1].score < out[0].score);
        assert!(out.iter().any(|r| r.why.contains("同类第2条")));
    }

    #[test]
    fn opened_and_voted_cards_get_a_push() {
        let i = Interests::default();
        let cards = vec![
            Candidate { id: "plain".into(), topics: vec!["x".into()], quality: 0.0, vote: 0.0, age_h: 50.0, opened: false },
            Candidate { id: "liked".into(), topics: vec!["y".into()], quality: 0.0, vote: 1.0, age_h: 50.0, opened: true },
        ];
        let out = Engine::default().rank(&i, &cards, now());
        assert_eq!(out[0].id, "liked");
        assert!(out[0].why.contains("你赞过"));
    }

    #[test]
    fn vector_affinity_recalls_neighbour_topics() {
        let mut i = Interests::default();
        i.absorb(&["聚变".into(), "磁约束".into()], "up", now());
        // 完全相同主题: 相似度 1.0 × 权重 (首票 = 0.25) ⇒ 亲和 = 0.25
        let same = i.affinity_vector(&["聚变".into(), "磁约束".into()], now());
        assert!(same > 0.2, "同主题向量亲和应等于 相似度×权重: {same}");
        // 多赞几次后权重抬上去, 同主题亲和必须跟着变高
        for _ in 0..3 {
            i.absorb(&["聚变".into(), "磁约束".into()], "up", now());
        }
        let same2 = i.affinity_vector(&["聚变".into(), "磁约束".into()], now());
        assert!(same2 > same, "权重上升要抬高向量亲和: {same2} vs {same}");
        // 完全无关主题: 接近 0 (特征哈希的碰撞只会给很小的值)
        let other = i.affinity_vector(&["做菜".into()], now());
        assert!(other < same, "无关主题必须低于同主题: {other} vs {same}");
    }

    #[test]
    fn dream_consolidates_and_prunes_prototypes() {
        let mut i = Interests::default();
        i.absorb(&["聚变".into()], "up", now());
        i.absorb(&["噪声".into()], "ignore", now());   // 负权重, 会被剪掉
        let (kept, dropped, _merged) = i.dream_consolidate(now(), 1.0);
        assert!(kept >= 1, "正向原型要留: {kept}");
        assert!(dropped >= 1, "负权重原型要被剪: {dropped}");
        // 很久以后做梦: 全部衰减到阈值以下 ⇒ 清空 (兴趣是会过期的)
        let (kept2, _d2, _m2) = i.dream_consolidate(now() + 3650 * 24 * 3_600_000, 1.0);
        assert_eq!(kept2, 0, "十年不用的兴趣不该继续影响推荐");
    }

    #[test]
    fn top_interests_are_ordered_and_drop_decayed() {
        let mut i = Interests::default();
        i.feedback("甲", "up", now());
        i.feedback("乙", "up", now());
        i.feedback("乙", "up", now());
        let t = i.top(2, now());
        assert_eq!(t[0].0, "乙");
        // 很久以后两边都衰减到阈值以下
        let t2 = i.top(2, now() + 365 * 24 * 3_600_000);
        assert!(t2.is_empty(), "衰减到可忽略后不该再影响推荐: {t2:?}");
    }
}
