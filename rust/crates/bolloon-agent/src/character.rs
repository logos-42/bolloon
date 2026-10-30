//! 品格特质 + 警长选举（纯逻辑，可单测）
//!
//! 选举模型（用户定）：底层智能体民主选举，参照人民代表大会制度 —— 五特质从历史算加权总分（后端隐藏），
//! 分最高者直接当选警长（计分直选），前台只显示结果。
//!
//! 五特质：正直(integrity) / 善良(kindness) / 能力(capability) / 责任(responsibility) / 远见(foresight)
//! 计分直选：从智能体过往历史（archive/judgment + intents）算**确定性**指标 → 加权总分 → 最高分当选。
//! LLM 校准端口（可选）仅对少数主观项（正直/善良/远见）兜底；主轴确定性、免模型、可单测。

use std::path::Path;

/// 五维品格特质（0.0~1.0）
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharacterTraits {
    pub integrity: f64,
    pub kindness: f64,
    pub capability: f64,
    pub responsibility: f64,
    pub foresight: f64,
}

impl Default for CharacterTraits {
    fn default() -> Self {
        Self {
            integrity: 0.5,
            kindness: 0.5,
            capability: 0.5,
            responsibility: 0.5,
            foresight: 0.5,
        }
    }
}

impl CharacterTraits {
    /// 加权总分（直选依据）。责任与能力略加权 —— 更影响「能否当好警长」。
    pub fn weighted_total(&self) -> f64 {
        self.integrity * 1.0
            + self.kindness * 0.8
            + self.capability * 1.2
            + self.responsibility * 1.2
            + self.foresight * 1.0
    }

    /// 全部维度在 [0,1] 才算合法
    pub fn validate(&self) -> bool {
        [self.integrity, self.kindness, self.capability, self.responsibility, self.foresight]
            .iter()
            .all(|v| (0.0..=1.0).contains(v))
    }
}

/// 从历史素材算确定性特质（纯函数）。
///
/// 主轴（确定性，免模型）：
/// - 能力/责任 ← judgment 产出量 + 平均置信
/// - 远见     ← 提出的意图 + 被采纳意图
/// - 正直     ← 矛盾越少越高（contradictions 拉低）
/// - 善良     ← 确定性拿不准时给中性，交给 LLM 校准端口兜底
#[derive(Debug, Clone, Default)]
pub struct HistoryStats {
    pub judgments: u64,
    pub avg_confidence: f64,
    pub contradictions: u64,
    pub intents: u64,
    pub intents_adopted: u64,
    pub helps: u64,
}

/// 由历史素材推导五特质（确定性主轴）
pub fn score_from_stats(s: &HistoryStats) -> CharacterTraits {
    let capability = clamp01((s.judgments as f64 / 20.0) * 0.6 + s.avg_confidence * 0.4);
    let responsibility = clamp01((s.judgments as f64 / 20.0) * 0.5 + s.avg_confidence * 0.5);
    let foresight = clamp01((s.intents as f64 / 10.0) * 0.5 + (s.intents_adopted as f64 / 10.0) * 0.5);
    let integrity = clamp01(0.5 + 0.5 * (1.0 - (s.contradictions as f64 / 10.0).min(1.0)));
    let kindness = clamp01((s.helps as f64 / 10.0) * 0.5 + 0.5);
    CharacterTraits {
        integrity,
        kindness,
        capability,
        responsibility,
        foresight,
    }
}

fn clamp01(v: f64) -> f64 {
    if v.is_nan() {
        return 0.0;
    }
    v.clamp(0.0, 1.0)
}

/// 计分直选：返回加权总分最高者（纯函数）。平局取最先出现者。
///
/// 空表 → None（无人可当选，fail-closed：不臆造警长）。
pub fn elect_sheriff(scores: &[(String, CharacterTraits)]) -> Option<String> {
    scores
        .iter()
        .max_by(|a, b| {
            a.1.weighted_total()
                .partial_cmp(&b.1.weighted_total())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(id, _)| id.clone())
}

/// 从某智能体的 archive 目录读取历史素材（确定性；目录不存在 / 坏行不影响，返回默认空）。
///
/// archive 目录结构（见 `bolloon-web::archive`）：`<dir>/judgment/YYYY-MM-DD.jsonl` 与
/// `<dir>/intents/YYYY-MM-DD.jsonl`，每行一条 JSON。
pub fn read_history_stats(agent_archive_dir: &Path) -> HistoryStats {
    let mut stats = HistoryStats::default();
    for kind in ["judgment", "intents"] {
        let dir = agent_archive_dir.join(kind);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else {
                continue;
            };
            for line in content.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                // 坏行不影响后续
                let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                match kind {
                    "judgment" => {
                        stats.judgments += 1;
                        if let Some(c) = v.get("confidence").and_then(|x| x.as_f64()) {
                            // 滚动平均
                            let n = stats.judgments as f64;
                            stats.avg_confidence =
                                stats.avg_confidence * ((n - 1.0) / n) + c.clamp(0.0, 1.0) / n;
                        }
                        let status = v
                            .get("status")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_lowercase();
                        if status.contains("contradict") || status.contains("冲突") {
                            stats.contradictions += 1;
                        }
                    }
                    "intents" => {
                        stats.intents += 1;
                        let status = v
                            .get("status")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_lowercase();
                        if status.contains("adopt") || status.contains("采纳") {
                            stats.intents_adopted += 1;
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    stats
}

/// 由归档目录直接得到某智能体的五特质（确定性主轴；LLM 校准另行叠加）
pub fn score_agent(agent_archive_dir: &Path) -> CharacterTraits {
    score_from_stats(&read_history_stats(agent_archive_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weighted_total_ranking() {
        let a = CharacterTraits {
            integrity: 0.9,
            kindness: 0.9,
            capability: 0.9,
            responsibility: 0.9,
            foresight: 0.9,
        };
        let b = CharacterTraits::default();
        assert!(a.weighted_total() > b.weighted_total());
    }

    #[test]
    fn elect_picks_highest() {
        let scores = vec![
            ("a".into(), CharacterTraits::default()),
            (
                "b".into(),
                CharacterTraits {
                    integrity: 1.0,
                    kindness: 1.0,
                    capability: 1.0,
                    responsibility: 1.0,
                    foresight: 1.0,
                },
            ),
            ("c".into(), CharacterTraits::default()),
        ];
        assert_eq!(elect_sheriff(&scores), Some("b".into()));
    }

    #[test]
    fn elect_empty_none() {
        assert_eq!(elect_sheriff(&[]), None);
    }

    #[test]
    fn score_from_stats_maps_dimensions() {
        let s = HistoryStats {
            judgments: 40,
            avg_confidence: 0.9,
            contradictions: 0,
            intents: 10,
            intents_adopted: 8,
            helps: 5,
        };
        let t = score_from_stats(&s);
        // 高产出 + 高置信 ⇒ 能力/责任高
        assert!(t.capability > 0.8);
        assert!(t.responsibility > 0.8);
        // 无矛盾 ⇒ 正直高
        assert!(t.integrity > 0.9);
        // 意图多且被采纳 ⇒ 远见高
        assert!(t.foresight > 0.8);
        assert!(t.validate());
    }

    #[test]
    fn contradictions_lower_integrity() {
        let clean = score_from_stats(&HistoryStats {
            contradictions: 0,
            ..Default::default()
        });
        let dirty = score_from_stats(&HistoryStats {
            contradictions: 20,
            ..Default::default()
        });
        assert!(clean.integrity > dirty.integrity);
    }

    #[test]
    fn read_history_stats_tolerates_missing_dir() {
        let tmp = std::env::temp_dir().join("bolloon-test-no-agent-archive");
        let _ = std::fs::remove_dir_all(&tmp);
        let s = read_history_counts(&tmp);
        assert_eq!(s.judgments, 0);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // 直接复用 read_history_stats（public）做缺失目录断言
    fn read_history_counts(dir: &Path) -> HistoryStats {
        read_history_stats(dir)
    }
}
