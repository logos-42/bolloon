//! 上下文压缩 — 渐进式管道
//!
//! 对齐「构建AI智能体」决策 3 与 TS 版 context-compaction:
//! 预算削减 → 裁剪旧消息 → 工具结果压首行 → 摘要占位 (锚保留)
//!
//! 原则: 上下文是最根本的约束; [stable system] + [只追加 history] + [尾部 CURRENT TURN]
//! —— 压缩只动 history 中段, 首条 (根意图锚) 与末轮 (当前轮) 永不动。

use serde::{Deserialize, Serialize};

/// 消息 (对齐 ChatMessage 形状)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompactionMessage {
    pub role: String,
    pub content: String,
    /// 是否工具结果 (压首行用)
    #[serde(default)]
    pub is_tool_result: bool,
}

/// 压缩配置
#[derive(Debug, Clone)]
pub struct CompactionConfig {
    /// 字符预算 (history 总量上限)
    pub budget_chars: usize,
    /// 首条锚保留上限
    pub anchor_max_chars: usize,
    /// 每条常规消息保留上限
    pub per_message_max: usize,
    /// 工具结果只留首行上限
    pub tool_result_first_line_max: usize,
}

impl Default for CompactionConfig {
    fn default() -> Self {
        Self {
            budget_chars: 12_000,
            anchor_max_chars: 600,
            per_message_max: 2000,
            tool_result_first_line_max: 200,
        }
    }
}

/// 压缩报告 (透明: 压了什么留痕)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompactionReport {
    pub before_chars: usize,
    pub after_chars: usize,
    pub dropped: usize,
    pub truncated: usize,
    pub summarized: usize,
}

/// 渐进式压缩 (纯函数)
///
/// 步骤: ① 首条截到 anchor 上限 ② 工具结果压首行 ③ 逐条截到 per-message 上限
/// ④ 仍超预算 → 中段丢弃 (保首条+尾 40%), 丢弃处放摘要占位
pub fn compact(messages: &[CompactionMessage], cfg: &CompactionConfig) -> (Vec<CompactionMessage>, CompactionReport) {
    let before: usize = messages.iter().map(|m| m.content.chars().count()).sum();
    let mut out: Vec<CompactionMessage> = Vec::new();
    let mut dropped = 0usize;
    let mut truncated = 0usize;

    for (i, m) in messages.iter().enumerate() {
        let is_first = i == 0;
        let is_tail = i + 1 >= messages.len().min(messages.len()); // 末条 = 当前轮
        let limit = if is_first {
            cfg.anchor_max_chars
        } else if m.is_tool_result {
            cfg.tool_result_first_line_max
        } else {
            cfg.per_message_max
        };
        let mut content = m.content.clone();
        if m.is_tool_result && !is_first {
            // 工具结果只留首行 (对齐 TS: 工具结果压首行)
            content = first_line(&content, limit);
            if content.chars().count() < m.content.chars().count() {
                truncated += 1;
            }
        } else if content.chars().count() > limit {
            content = truncate_chars(&content, limit);
            truncated += 1;
        }
        out.push(CompactionMessage {
            role: m.role.clone(),
            content,
            is_tool_result: m.is_tool_result,
        });
        let _ = is_tail;
    }

    // ④ 预算削减: 丢中段 (保留首条锚 + 逐渐收缩的尾部), 丢处放摘要占位
    //    仍超预算 → 继续收尾 (尾最少保 1 条 = 当前轮永不动)
    let mut total: usize = out.iter().map(|m| m.content.chars().count()).sum();
    if total > cfg.budget_chars && out.len() > 2 {
        let mut tail_keep = ((out.len() * 2) / 5).max(1); // 先试末 40%
        let mut cut_end;
        loop {
            cut_end = out.len() - tail_keep;
            if cut_end <= 1 {
                break; // 已到最小保留 (首条 + 占位 + 尾), 不再收
            }
            let kept: usize = out[0].content.chars().count()
                + out[cut_end..].iter().map(|m| m.content.chars().count()).sum::<usize>()
                + 60; // 占位条预估
            if kept <= cfg.budget_chars {
                break;
            }
            if tail_keep > 1 {
                tail_keep -= 1;
            } else {
                break;
            }
        }
        if cut_end > 1 {
            let mut summarized = Vec::new();
            summarized.push(out[0].clone());
            let dropped_n = cut_end - 1;
            let dropped_chars: usize =
                out[1..cut_end].iter().map(|m| m.content.chars().count()).sum();
            summarized.push(CompactionMessage {
                role: "system".into(),
                content: format!(
                    "[上下文已压缩: 丢弃中间 {dropped_n} 条消息 (约 {dropped_chars} 字符); 根意图见首条, 最近对话见下]"
                ),
                is_tool_result: false,
            });
            summarized.extend(out[cut_end..].to_vec());
            out = summarized;
            dropped = dropped_n;
        }
        total = out.iter().map(|m| m.content.chars().count()).sum();
    }

    let after: usize = out.iter().map(|m| m.content.chars().count()).sum();
    (
        out,
        CompactionReport {
            before_chars: before,
            after_chars: after,
            dropped,
            truncated,
            summarized: if dropped > 0 { 1 } else { 0 },
        },
    )
}

/// 按字符截断 (不切半个字符)
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head = max.saturating_sub(1);
    let mut out: String = s.chars().take(head).collect();
    out.push('…');
    out
}

/// 工具结果首行提取
pub fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("");
    truncate_chars(line, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(role: &str, content: &str) -> CompactionMessage {
        CompactionMessage { role: role.into(), content: content.into(), is_tool_result: false }
    }

    fn tool_result(content: &str) -> CompactionMessage {
        CompactionMessage { role: "tool".into(), content: content.into(), is_tool_result: true }
    }

    #[test]
    fn anchor_preserved_but_capped() {
        let cfg = CompactionConfig { anchor_max_chars: 100, ..Default::default() };
        let msgs = vec![msg("user", &"根".repeat(500))];
        let (out, report) = compact(&msgs, &cfg);
        assert!(out[0].content.chars().count() <= 100);
        assert_eq!(report.truncated, 1);
    }

    #[test]
    fn tool_result_compressed_to_first_line() {
        let cfg = CompactionConfig { tool_result_first_line_max: 20, ..Default::default() };
        let msgs = vec![
            msg("user", "查一下"),
            tool_result("第一行结果\n第二行很长很长很长\n第三行更长更长更长"),
        ];
        let (out, _) = compact(&msgs, &cfg);
        assert_eq!(out[1].content, "第一行结果");
    }

    #[test]
    fn over_budget_drops_middle_keeps_anchor_and_tail() {
        let cfg = CompactionConfig {
            budget_chars: 500,
            per_message_max: 2000,
            ..Default::default()
        };
        let mut msgs = vec![msg("user", "根意图: 做核聚变研究")];
        for i in 0..20 {
            msgs.push(msg("assistant", &format!("中间消息 {i}: {}", "x".repeat(100))));
        }
        msgs.push(msg("user", "最后一轮问题"));
        let (out, report) = compact(&msgs, &cfg);
        assert!(report.after_chars <= cfg.budget_chars, "预算硬门");
        assert!(out[0].content.contains("根意图"), "首条锚永不动");
        assert!(
            out.last().unwrap().content.contains("最后一轮"),
            "末轮 (当前轮) 永不动"
        );
        assert!(report.dropped > 0, "确实丢了中段");
        assert!(
            out.iter().any(|m| m.content.contains("上下文已压缩")),
            "丢弃处必须有摘要占位 (不静默消失)"
        );
    }

    #[test]
    fn small_history_untouched() {
        let cfg = CompactionConfig::default();
        let msgs = vec![msg("user", "你好"), msg("assistant", "你好!")];
        let (out, report) = compact(&msgs, &cfg);
        assert_eq!(out, msgs);
        assert_eq!(report.before_chars, report.after_chars);
        assert_eq!(report.dropped, 0);
    }

    #[test]
    fn first_line_truncates() {
        assert_eq!(first_line("a\nb\nc", 10), "a");
        assert_eq!(first_line(&"x".repeat(50), 5), "xxxx…");
    }

    #[test]
    fn report_transparent() {
        let cfg = CompactionConfig { budget_chars: 100, ..Default::default() };
        let mut msgs = vec![msg("user", "根")];
        for i in 0..10 {
            msgs.push(msg("assistant", &format!("m{i}: {}", "y".repeat(80))));
        }
        let (_, report) = compact(&msgs, &cfg);
        assert!(report.before_chars > report.after_chars, "压缩必然变短");
    }
}
