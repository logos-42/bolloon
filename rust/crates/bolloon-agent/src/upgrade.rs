//! upgrade.rs — 能力升级执行计划 (意图 → 差距 → 具体怎么补)
//!
//! 本模块把 `gap.rs` 的路径判断落成**可执行步骤**:
//! - `Search`   真跑 web_search (执行方注入), 结果解析成链接卡或原文内容卡
//! - `Delegate` 往任务公告板发公告 (bolloon-task/1), 等其他 agent 认领
//! - `Install`  如实记录"待安装" (本仓还没有 skill 安装源登记面, 不假装修好)
//!
//! 纪律:
//! - 计划是**纯函数** (policy 层), 执行由调用方注入
//! - 搜索结果解析**宽容但诚实**: 解不出结构化结果就出原文卡, 绝不编 URL
//! - 每次升级写一条 memory lesson (沉淀飞轮: 下次同类意图有经验可循)

use crate::gap::{GapPath, GapReport};
use crate::world::Intent;

/// 一条补能力步骤 (计划产物, 执行方按 kind 分派)
#[derive(Debug, Clone, PartialEq)]
pub enum UpgradeStep {
    /// 真跑搜索 (query 取意图文本)
    Search { query: String },
    /// 公告板委托 (budget="0" = 悬赏待议, 意图里没有预算就不编)
    Delegate { capability: String, digest: String, budget: String },
    /// 待安装 (如实: 本仓无安装源登记面, 只记录不假装装好)
    Install { note: String },
}

impl UpgradeStep {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Search { .. } => "search",
            Self::Delegate { .. } => "delegate",
            Self::Install { .. } => "install",
        }
    }
}

/// 升级计划 (纯函数): 差距报告 → 按成本升序的具体步骤
pub fn plan_upgrade(intent: &Intent, gap: &GapReport) -> Vec<UpgradeStep> {
    let mut steps = Vec::new();
    for path in &gap.paths {
        match path {
            GapPath::Search => steps.push(UpgradeStep::Search { query: intent.text.clone() }),
            GapPath::Delegate => steps.push(UpgradeStep::Delegate {
                capability: intent.category.as_str().into(),
                digest: intent.text.chars().take(60).collect(),
                budget: "0".into(),
            }),
            GapPath::Install => steps.push(UpgradeStep::Install {
                note: format!(
                    "意图「{}」需要 {} 能力, 当前无安装源登记面 — 已记录待安装, 不假装修好",
                    intent.text,
                    intent.category.as_str()
                ),
            }),
        }
    }
    steps
}

/// 解析搜索服务返回的原始文本 (宽容多形状; 解不出 = 空, 调用方回落原文卡)
///
/// 认的形状 (都是真实搜索服务常见返回):
/// - `{results:[{title,url,content}]}` (SearXNG JSON)
/// - `[{title,url,snippet}]` (通用数组)
/// - `[{Text,FirstURL}]` (DuckDuckGo Instant Answer)
/// 每条必须有 url 才算命中; 去重; 上限 5 条 (刷屏不如给最相关的)
pub fn parse_search_hits(raw: &str) -> Vec<crate::fulfill::LinkHit> {
    use crate::fulfill::LinkHit;
    // 剥掉 web_search 输出的 "[搜索] query\n\n" 前缀, 取正文
    let body = raw
        .strip_prefix("[搜索]")
        .and_then(|r| r.split_once('\n'))
        .map(|(_, rest)| rest)
        .unwrap_or(raw);
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body.trim()) else {
        return vec![];
    };
    let items: Vec<serde_json::Value> = match &v {
        serde_json::Value::Array(a) => a.clone(),
        serde_json::Value::Object(o) => o
            .get("results")
            .and_then(|r| r.as_array())
            .cloned()
            .unwrap_or_default(),
        _ => vec![],
    };
    let mut out: Vec<LinkHit> = Vec::new();
    for item in items {
        let url = item
            .get("url")
            .or_else(|| item.get("FirstURL"))
            .or_else(|| item.get("link"))
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_string();
        if !url.starts_with("http") {
            continue; // 无真实 URL 的条目不要 (不编链接)
        }
        let title = item
            .get("title")
            .or_else(|| item.get("Text"))
            .or_else(|| item.get("headline"))
            .and_then(|t| t.as_str())
            .unwrap_or("（无标题）")
            .to_string();
        let note = item
            .get("content")
            .or_else(|| item.get("snippet"))
            .or_else(|| item.get("description"))
            .and_then(|s| s.as_str())
            .map(|s| s.chars().take(120).collect::<String>());
        if out.iter().any(|h| h.url == url) {
            continue; // 去重
        }
        out.push(LinkHit { title, url, note });
        if out.len() >= 5 {
            break;
        }
    }
    out
}

/// 沉淀飞轮: 升级过程写一条 memory lesson 的文案 (纯函数; 写入由调用方执行)
pub fn lesson_content(intent: &Intent, steps: &[UpgradeStep], outcome: &str) -> String {
    let kinds: Vec<&str> = steps.iter().map(|s| s.kind()).collect();
    format!(
        "意图升级: 「{}」({}) → 路径 [{}] → {}",
        intent.text,
        intent.category.as_str(),
        kinds.join(","),
        outcome
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gap::{detect_gaps, CapabilityInventory};
    use crate::world::classify_intent;

    fn intent_of(text: &str) -> Intent {
        let c = classify_intent(text);
        Intent {
            id: "intent-1".into(),
            text: text.into(),
            tags: vec![],
            active: true,
            created_at_ms: 1,
            category: c.category,
            want: c.want,
            clarity: c.clarity,
        }
    }

    #[test]
    fn plan_follows_gap_paths_in_order() {
        let intent = intent_of("我在杭州找后端开发的工作"); // work / links
        // 有搜索源 → 只有 Search
        let gap = detect_gaps(&intent, &CapabilityInventory { has_web_search: true, ..Default::default() });
        let plan = plan_upgrade(&intent, &gap);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0], UpgradeStep::Search { query: "我在杭州找后端开发的工作".into() });

        // 零能力 → Info/Links 缺失走 Install
        let gap2 = detect_gaps(&intent, &CapabilityInventory::default());
        let plan2 = plan_upgrade(&intent, &gap2);
        assert_eq!(plan2[0].kind(), "install");
        assert!(plan2[0].kind() != "delegate", "信息类不委托");
    }

    #[test]
    fn service_intent_plans_delegate_with_honest_budget() {
        let mut intent = intent_of("帮我订一个周日的酒店");
        intent.want = crate::world::WantKind::Service;
        let gap = detect_gaps(&intent, &CapabilityInventory::default());
        let plan = plan_upgrade(&intent, &gap);
        assert_eq!(plan[0].kind(), "delegate");
        match &plan[0] {
            UpgradeStep::Delegate { capability, digest, budget } => {
                assert_eq!(capability, "travel");
                assert!(digest.contains("酒店"));
                assert_eq!(budget, "0", "意图无预算 ⇒ 0 (待议), 不编金额");
            }
            _ => panic!("应为 Delegate"),
        }
    }

    #[test]
    fn parse_searxng_results() {
        let raw = "[搜索] 找工作\n\n{\"results\":[{\"title\":\"职位A\",\"url\":\"https://j.example/a\",\"content\":\"杭州后端\"},{\"title\":\"职位B\",\"url\":\"https://j.example/b\"}]}";
        let hits = parse_search_hits(raw);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].url, "https://j.example/a");
        assert_eq!(hits[0].note.as_deref(), Some("杭州后端"));
    }

    #[test]
    fn parse_duckduckgo_shape_and_dedupe() {
        let raw = r#"[{"Text":"职位A","FirstURL":"https://j.example/a"},{"Text":"职位A2","FirstURL":"https://j.example/a"},{"Text":"无链接"},{"Text":"职位C","FirstURL":"https://j.example/c"}]"#;
        let hits = parse_search_hits(raw);
        assert_eq!(hits.len(), 2, "无 URL 条目丢弃 + URL 去重");
        assert_eq!(hits[1].url, "https://j.example/c");
    }

    #[test]
    fn unparseable_returns_empty_not_fabricated() {
        assert!(parse_search_hits("这不是 JSON, 是一段话").is_empty());
        assert!(parse_search_hits("").is_empty());
    }

    #[test]
    fn lesson_content_is_compact_and_honest() {
        let intent = intent_of("我想吃饭");
        let gap = detect_gaps(&intent, &CapabilityInventory::default());
        let steps = plan_upgrade(&intent, &gap);
        let s = lesson_content(&intent, &steps, "检索 3 条命中");
        assert!(s.contains("我想吃饭"));
        assert!(s.contains("food"));
        assert!(s.contains("检索 3 条命中"));
    }
}
