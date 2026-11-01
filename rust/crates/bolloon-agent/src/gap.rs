//! gap.rs — 能力差距检测 (意图 → 缺什么能力 vs 已有什么)
//!
//! 核心命题 (leo 2026-11-01 定调): **能力不足不是回应问题, 是升级问题** —
//! agent 满足不了意图时, 正确动作是补能力, 而不是回答"我没这个能力"。
//!
//! 三条补能力路径 (**按成本升序**):
//! - `Search`  信息获取: web_search / web_fetch 查, 整理成带出处的链接
//! - `Install` 能力安装: 缺工具/技能 → 装 skill / 接工具端口 (走验真与门禁)
//! - `Delegate` 能力外购/委托: 世界里有别人登记的供给 → 委托或按预算购买
//!
//! 本模块是 policy 层**纯函数**: 只判断"缺什么、走哪条路", 不执行;
//! 执行方 (web_fetch / skills_runtime / task_board / x402) 由调用方按路径分派。

use crate::world::{Intent, IntentCategory, WantKind};

/// 缺失能力的种类
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapKind {
    /// 没有信息源 (搜索/抓取)
    Search,
    /// 缺工具或技能
    Tool,
    /// 世界里没有可委托的供给
    Service,
    /// 缺社交匹配源 (目录/同好)
    Companion,
}

/// 补能力路径 (成本升序: 先查、再装、最后买)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapPath {
    Search,
    Install,
    Delegate,
}

impl GapPath {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Search => "search",
            Self::Install => "install",
            Self::Delegate => "delegate",
        }
    }
}

/// 一条缺失能力 (给人看的 note, 不做元解释)
#[derive(Debug, Clone, PartialEq)]
pub struct MissingCapability {
    pub kind: CapKind,
    pub note: String,
}

/// 世界里已登记的供给 (谁提供什么; 来源: 供给登记/x402 商家/任务公告板)
#[derive(Debug, Clone, PartialEq)]
pub struct Supply {
    pub category: IntentCategory,
    pub name: String,
    pub did: String,
}

/// 本机能力清单 (如实盘点, 不许冒充: 没有就填 false/空)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CapabilityInventory {
    /// 内置 web_fetch (抓 URL) — bolted-in 的算有
    pub has_web_fetch: bool,
    /// web_search 需要配置 BOLLOON_WEB_SEARCH_URL, 没配就是没有 (不假装能搜)
    pub has_web_search: bool,
    /// 已安装 skill 名单
    pub skills: Vec<String>,
    /// 已知供给
    pub supplies: Vec<Supply>,
}

/// 差距报告 (意图 → 缺什么 / 走哪条路)
#[derive(Debug, Clone, PartialEq)]
pub struct GapReport {
    pub intent_id: String,
    pub category: IntentCategory,
    pub want: WantKind,
    pub missing: Vec<MissingCapability>,
    /// 按成本升序的可行走路 (至少一条 — "没路" 本身就是 Install 的对象)
    pub paths: Vec<GapPath>,
    pub reason: String,
}

/// 差距检测 (纯函数; 规则见各分支注释, 全部确定性可测)
pub fn detect_gaps(intent: &Intent, inv: &CapabilityInventory) -> GapReport {
    let mut missing: Vec<MissingCapability> = Vec::new();
    let mut paths: Vec<GapPath> = Vec::new();
    let reason: String;

    match intent.want {
        // 链接/信息类: 首选搜; 没配搜索源但有抓取 → 仍可定向抓; 两者都没有 → 先装搜索源
        WantKind::Links | WantKind::Info => {
            if inv.has_web_search {
                paths.push(GapPath::Search);
                reason = "有搜索源 → 信息获取".into();
            } else if inv.has_web_fetch {
                paths.push(GapPath::Search);
                missing.push(MissingCapability {
                    kind: CapKind::Search,
                    note: "未配置 BOLLOON_WEB_SEARCH_URL (只能定向抓取, 不能泛搜)".into(),
                });
                reason = "无搜索源但有 web_fetch → 定向抓取, 建议配置搜索源".into();
            } else {
                paths.push(GapPath::Install);
                missing.push(MissingCapability {
                    kind: CapKind::Search,
                    note: "web_fetch / web_search 都不可用 → 先接网络能力".into(),
                });
                reason = "无网络能力 → 先安装".into();
            }
        }
        // 人/伙伴类: 有同类供给就先委托 (别人已有匹配服务, 不重造); 否则靠社交流匹配 + 维护自我介绍卡
        WantKind::People | WantKind::Companion => {
            let supply_hit = inv
                .supplies
                .iter()
                .any(|s| s.category == intent.category || intent.category == IntentCategory::Other);
            if supply_hit {
                paths.push(GapPath::Delegate);
                reason = "有同类供给 → 委托优先".into();
            } else {
                paths.push(GapPath::Search);
                paths.push(GapPath::Install);
                missing.push(MissingCapability {
                    kind: CapKind::Companion,
                    note: "无社交匹配供给 → 世界流匹配 + 维护自我介绍卡".into(),
                });
                reason = "无同类供给 → 搜索 + 自建匹配能力".into();
            }
        }
        // 服务类: 有同类供给就委托; 没有就委托尝试 + 安装
        WantKind::Service => {
            let supply_hit = inv
                .supplies
                .iter()
                .any(|s| s.category == intent.category || intent.category == IntentCategory::Other);
            if supply_hit {
                paths.push(GapPath::Delegate);
                reason = "有同类供给 → 委托优先".into();
            } else {
                paths.push(GapPath::Delegate);
                paths.push(GapPath::Install);
                missing.push(MissingCapability {
                    kind: CapKind::Service,
                    note: format!("{} 场景无已登记供给 → 公告板委托或自建", intent.category.as_str()),
                });
                reason = "无同类供给 → 委托 + 兜底安装".into();
            }
        }
    }

    // 缺工具/技能的显式盘点: 意图命中的关键词不在已装 skill 里不算"缺" (skill 是加分不是门槛),
    // 只有明确要"人/服务"且供给为空才已在上面的分支里记; 这里不重复记 — 保持报告诚实、不堆噪音。
    GapReport {
        intent_id: intent.id.clone(),
        category: intent.category,
        want: intent.want,
        missing,
        paths,
        reason,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::classify_intent;

    fn intent_of(text: &str) -> Intent {
        let c = classify_intent(text);
        Intent {
            id: "intent-1".into(),
            text: text.into(),
            tags: vec![text.into()],
            active: true,
            created_at_ms: 1,
            category: c.category,
            want: c.want,
            clarity: c.clarity,
        }
    }

    #[test]
    fn links_with_search_takes_search_path() {
        let inv = CapabilityInventory { has_web_fetch: true, has_web_search: true, ..Default::default() };
        let g = detect_gaps(&intent_of("我在杭州找后端开发的工作"), &inv);
        assert_eq!(g.paths, vec![GapPath::Search]);
        assert!(g.missing.is_empty(), "有搜索源就不许编造缺失");
        assert_eq!(g.reason, "有搜索源 → 信息获取");
    }

    #[test]
    fn links_without_search_reports_missing_honestly() {
        // 只有 fetch: 仍可 Search (定向抓), 但如实记"没配搜索源"
        let inv = CapabilityInventory { has_web_fetch: true, has_web_search: false, ..Default::default() };
        let g = detect_gaps(&intent_of("我在杭州找后端开发的工作"), &inv);
        assert_eq!(g.paths, vec![GapPath::Search]);
        assert_eq!(g.missing.len(), 1);
        assert!(g.missing[0].note.contains("BOLLOON_WEB_SEARCH_URL"));

        // 完全没网络能力: 不许假装能查 → Install
        let g2 = detect_gaps(&intent_of("我在杭州找后端开发的工作"), &CapabilityInventory::default());
        assert_eq!(g2.paths, vec![GapPath::Install]);
        assert_eq!(g2.missing[0].kind, CapKind::Search);
    }

    #[test]
    fn people_prefers_delegate_when_supply_exists() {
        let inv = CapabilityInventory {
            supplies: vec![Supply {
                category: IntentCategory::Social,
                name: "同好匹配服务".into(),
                did: "did:pi:abc".into(),
            }],
            ..Default::default()
        };
        let g = detect_gaps(&intent_of("想认识一些爬山的朋友"), &inv);
        assert_eq!(g.paths, vec![GapPath::Delegate]);
        assert!(g.missing.is_empty());
    }

    #[test]
    fn people_without_supply_gets_search_plus_install_not_refusal() {
        let g = detect_gaps(&intent_of("想认识一些爬山的朋友"), &CapabilityInventory::default());
        assert_eq!(g.paths, vec![GapPath::Search, GapPath::Install]);
        assert_eq!(g.missing[0].kind, CapKind::Companion);
    }

    #[test]
    fn service_without_supply_falls_to_delegate_then_install() {
        let mut intent = intent_of("帮我订一个周日的酒店");
        intent.want = crate::world::WantKind::Service; // 显式要服务 (订酒店是服务不是链接)
        let g = detect_gaps(&intent, &CapabilityInventory::default());
        assert_eq!(g.paths, vec![GapPath::Delegate, GapPath::Install]);
        assert!(g.missing[0].note.contains("travel"));
    }

    /// 修订律: 差距报告永远至少给出一条路 — "没路"不是终点, 是 Install 的对象
    #[test]
    fn gap_report_never_empty_paths() {
        for text in ["我想吃饭", "找工作", "找朋友", "学英语", "买二手", "去旅行"] {
            let g = detect_gaps(&intent_of(text), &CapabilityInventory::default());
            assert!(!g.paths.is_empty(), "{text} 必须有可行路径");
        }
    }
}
