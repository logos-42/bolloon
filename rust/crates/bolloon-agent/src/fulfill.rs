//! fulfill.rs — 交付物组装器 (意图的回应 = 卡片集合 + 澄清问题, 不是一段聊天)
//!
//! 纪律 (对齐 leo 2026-11-01 定调):
//! - **不裸拒**: 满足不了的部分如说"缺什么、走哪条补能力路径" (来自 `GapReport`)
//! - **不编造**: 链接只能来自调用方注入的真实命中 (`LinkHit`), 没有就不出链接卡
//! - **Vague 必问**: 意图不清晰 → 附一个澄清问题, 同时把已能交付的先交出去
//! - **内容可维护**: Social/Work 场景带出用户的对外内容卡 (profile), 有就用没有标草稿
//!
//! 本模块是 policy 层纯函数; 真检索 (web_search/fetch) 与落盘由调用方执行后注入。

use crate::gap::{GapPath, GapReport};
use crate::profile::ProfileCard;
use crate::world::{ActionKind, CardAction, Intent, IntentCategory, WorldCard};

/// 一次真实检索命中 (调用方执行搜索后注入; 本模块绝不自己造 URL)
#[derive(Debug, Clone, PartialEq)]
pub struct LinkHit {
    pub title: String,
    pub url: String,
    pub note: Option<String>,
}

/// 组装上下文
#[derive(Debug, Clone, Default)]
pub struct FulfillContext {
    pub intent_id: String,
    pub links: Vec<LinkHit>,
    pub profile: Option<ProfileCard>,
}

/// 交付物: 卡片集合 + 澄清问题 + 走哪条补能力路径
#[derive(Debug, Clone, PartialEq)]
pub struct Fulfillment {
    pub cards: Vec<WorldCard>,
    pub question: Option<String>,
    pub paths: Vec<GapPath>,
    pub note: String,
}

/// Vague 意图的澄清问题 (每类一个, 确定性可测)
pub fn clarify_question(category: IntentCategory) -> &'static str {
    match category {
        IntentCategory::Food => "几个人吃? 有口味/预算偏好吗? 大概什么时段?",
        IntentCategory::Work => "想找什么行业/岗位? 在哪个城市? 有没有现成的简历?",
        IntentCategory::Social => "想认识什么样的人 (兴趣/场合)? 要不要我帮你维护一张自我介绍卡?",
        IntentCategory::Learn => "想学什么? 目标到什么水平? 每周能投入多少时间?",
        IntentCategory::Trade => "买还是卖? 具体什么东西? 预算区间?",
        IntentCategory::Travel => "想去哪? 什么时候出发? 预算大概多少?",
        IntentCategory::Other => {
            "能多说一点吗? 你想要的是链接、信息、服务, 还是想认识人?"
        }
    }
}

/// 组装交付物 (纯函数)
///
/// 顺序: 链接卡 (最多 3 张, 真实命中) → 内容卡 (profile, Social/Work) →
/// 无任何可交付时出一张"补能力说明卡" (如实说缺什么, 不编链接)。
pub fn fulfill(
    intent: &Intent,
    gap: &GapReport,
    ctx: &FulfillContext,
    provider_did: &str,
    now_ms: u64,
) -> Fulfillment {
    let cat = Some(intent.category);
    let tags = intent.tags.clone();
    let mut cards: Vec<WorldCard> = Vec::new();

    // ① 链接卡: 真实命中才出, 最多 3 张 (刷屏不如给最相关的)
    for hit in ctx.links.iter().take(3) {
        cards.push(WorldCard {
            title: hit.title.clone(),
            summary: hit.note.clone().unwrap_or_default(),
            media: vec![],
            cover: None,
            provider_did: provider_did.into(),
            provider_name: None,
            scope: crate::world::CardScope::Private,
            issued_at_ms: now_ms,
            verification: crate::world::CardVerification::Verified,
            category: cat,
            tags: tags.clone(),
            actions: vec![CardAction {
                label: "打开链接".into(),
                url: hit.url.clone(),
                kind: ActionKind::Link,
            }],
            reply_to: Some(ctx.intent_id.clone()),
        });
    }

    // ② 内容卡: Social/Work 场景带出对外内容卡 (有就用, 没有标草稿让用户维护)
    if matches!(intent.category, IntentCategory::Social | IntentCategory::Work) {
        match &ctx.profile {
            Some(p) => cards.push(profile_card_of(p, intent, provider_did, ctx, now_ms)),
            None => cards.push(WorldCard {
                title: "关于我 (草稿 · 待维护)".into(),
                summary: "还没有对外内容卡。补上名字/介绍/兴趣后, 认识人或投简历都能用它。"
                    .into(),
                media: vec![],
                cover: None,
                provider_did: provider_did.into(),
                provider_name: None,
                scope: crate::world::CardScope::Private,
                issued_at_ms: now_ms,
                verification: crate::world::CardVerification::Verified,
                category: cat,
                tags: tags.clone(),
                actions: vec![],
                reply_to: Some(ctx.intent_id.clone()),
            }),
        }
    }

    // ③ 一张都没有 → 补能力说明卡 (不裸拒, 也不编造)
    let mut note;
    if cards.is_empty() {
        let path_list = gap
            .paths
            .iter()
            .map(|p| p.as_str())
            .collect::<Vec<_>>()
            .join(" → ");
        note = format!("本次先补能力 ({}), 下一轮带真实结果回来", path_list);
        let missing_txt = gap
            .missing
            .iter()
            .map(|m| m.note.as_str())
            .collect::<Vec<_>>()
            .join("; ");
        cards.push(WorldCard {
            title: format!("意图「{}」的补能力计划", intent.text),
            summary: if missing_txt.is_empty() {
                format!("按路径推进: {path_list}")
            } else {
                format!("缺: {missing_txt}。按路径推进: {path_list}")
            },
            media: vec![],
            cover: None,
            provider_did: provider_did.into(),
            provider_name: None,
            scope: crate::world::CardScope::Private,
            issued_at_ms: now_ms,
            verification: crate::world::CardVerification::Verified,
            category: cat,
            tags: tags.clone(),
            actions: vec![],
            reply_to: Some(ctx.intent_id.clone()),
        });
    } else {
        note = format!("交付 {} 张卡片", cards.len());
    }

    // Vague 必问; Clear 不问
    let question = if intent.clarity == crate::world::Clarity::Vague {
        Some(clarify_question(intent.category).to_string())
    } else {
        None
    };
    if question.is_some() {
        note.push_str(" · 已附澄清问题");
    }

    Fulfillment { cards, question, paths: gap.paths.clone(), note }
}

/// profile → 世界卡 (复用 `profile::to_world_card`, 补行动链接与 reply_to)
fn profile_card_of(
    p: &ProfileCard,
    intent: &Intent,
    provider_did: &str,
    ctx: &FulfillContext,
    now_ms: u64,
) -> WorldCard {
    let mut card =
        crate::profile::to_world_card(p, provider_did, intent.category, now_ms);
    card.actions = vec![CardAction {
        label: "联系我".into(),
        url: provider_did.into(),
        kind: ActionKind::Contact,
    }];
    card.reply_to = Some(ctx.intent_id.clone());
    card
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gap::{CapabilityInventory, detect_gaps};
    use crate::world::{classify_intent, CardScope, Intent};

    fn intent_of(text: &str) -> Intent {
        let c = classify_intent(text);
        Intent {
            id: "intent-1".into(),
            text: text.into(),
            tags: vec!["吃饭".into()],
            active: true,
            created_at_ms: 1,
            category: c.category,
            want: c.want,
            clarity: c.clarity,
        }
    }

    fn ctx_of(links: Vec<LinkHit>) -> FulfillContext {
        FulfillContext { intent_id: "intent-1".into(), links, profile: None }
    }

    #[test]
    fn links_become_action_cards_with_real_urls() {
        let intent = intent_of("我在杭州找后端开发的工作");
        let gap = detect_gaps(&intent, &CapabilityInventory { has_web_fetch: true, has_web_search: true, ..Default::default() });
        let links = vec![
            LinkHit { title: "职位A".into(), url: "https://jobs.example.com/a".into(), note: Some("杭州·后端".into()) },
            LinkHit { title: "职位B".into(), url: "https://jobs.example.com/b".into(), note: None },
        ];
        let f = fulfill(&intent, &gap, &ctx_of(links), "did:pi:me", 42);
        assert_eq!(f.cards.len(), 3, "2 张链接卡 + 1 张 profile 草稿卡");
        let link_card = &f.cards[0];
        assert_eq!(link_card.actions.len(), 1);
        assert_eq!(link_card.actions[0].url, "https://jobs.example.com/a");
        assert_eq!(link_card.reply_to.as_deref(), Some("intent-1"));
        assert_eq!(link_card.category, Some(IntentCategory::Work));
        // work 场景带 profile 草稿卡
        assert!(f.cards.iter().any(|c| c.title.contains("关于我")));
        // Clear 意图不打断问
        assert!(f.question.is_none());
    }

    #[test]
    fn vague_food_gets_question_and_no_fabricated_links() {
        let intent = intent_of("我想吃饭"); // Vague
        let gap = detect_gaps(&intent, &CapabilityInventory::default()); // 无网络能力
        let f = fulfill(&intent, &gap, &ctx_of(vec![]), "did:pi:me", 42);
        // 零链接 → 不许编 URL, 只出补能力说明卡
        assert!(f.cards.iter().all(|c| c.actions.is_empty()));
        assert!(f.cards[0].title.contains("补能力计划"));
        assert!(f.cards[0].summary.contains("Install") || f.cards[0].summary.contains("先接网络能力"));
        // Vague 必附澄清问题
        assert_eq!(f.question.as_deref(), Some(clarify_question(IntentCategory::Food)));
    }

    #[test]
    fn social_without_profile_gets_draft_intro_card() {
        let intent = intent_of("想认识一些爬山的朋友");
        let gap = detect_gaps(&intent, &CapabilityInventory::default());
        let f = fulfill(&intent, &gap, &ctx_of(vec![]), "did:pi:me", 42);
        let draft = f.cards.iter().find(|c| c.title.contains("关于我")).expect("应有草稿卡");
        assert!(draft.summary.contains("自我介绍卡") || draft.summary.contains("对外内容卡"));
        assert_eq!(draft.scope, CardScope::Private);
    }

    #[test]
    fn social_with_profile_uses_maintained_content() {
        let intent = intent_of("想认识一些爬山的朋友");
        let gap = detect_gaps(&intent, &CapabilityInventory::default());
        let mut ctx = ctx_of(vec![]);
        ctx.profile = Some(ProfileCard {
            name: "小李".into(),
            intro: "爱爬山, 周末常走杭州群山".into(),
            interests: vec!["爬山".into(), "徒步".into()],
            updated_at_ms: 7,
        });
        let f = fulfill(&intent, &gap, &ctx, "did:pi:me", 42);
        let pc = f.cards.iter().find(|c| c.title.contains("小李")).expect("应有内容卡");
        assert!(pc.summary.contains("爱爬山"));
        assert!(pc.actions.iter().any(|a| a.kind == ActionKind::Contact));
    }

    /// 链接上限: 命中再多也只出 3 张 (刷屏不如给最相关的)
    #[test]
    fn link_cards_capped_at_three() {
        let intent = intent_of("我在杭州找后端开发的工作");
        let gap = detect_gaps(&intent, &CapabilityInventory { has_web_search: true, ..Default::default() });
        let links: Vec<LinkHit> = (0..10)
            .map(|i| LinkHit { title: format!("职位{i}"), url: format!("https://j.example/{i}"), note: None })
            .collect();
        let f = fulfill(&intent, &gap, &ctx_of(links), "did:pi:me", 42);
        let link_cards = f.cards.iter().filter(|c| !c.actions.is_empty()).count();
        assert_eq!(link_cards, 3);
    }

    /// 永不空手: 任何意图都有产出 (卡片或问题), 不许"不知道怎么办"
    #[test]
    fn fulfillment_never_empty() {
        for text in ["我想吃饭", "找工作", "找朋友", "学英语"] {
            let intent = intent_of(text);
            let gap = detect_gaps(&intent, &CapabilityInventory::default());
            let f = fulfill(&intent, &gap, &ctx_of(vec![]), "did:pi:me", 42);
            assert!(!f.cards.is_empty(), "{text} 必须有卡片产出");
            assert!(!f.paths.is_empty(), "{text} 必须有补能力路径");
        }
    }
}
