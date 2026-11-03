//! skill_authoring.rs — 差距 → **自动编写 skill** (2026-11-04)
//!
//! 动机 (leo): 「世界模式下主动的行动, 自动创建 skills 来弥补能力差距主动满足用户需求」。
//! 此前的升级管线到 `Install` 就停在"记录待办"; 这里补上"自己写一个方法型 skill"
//! —— 不是装第三方资源, 而是把**这类意图该怎么满足**沉淀成可复用步骤。
//!
//! 纪律:
//! - **模板化、可审计**: 由意图(category/want/clarity) + 差距路径生成, 不编造 URL/数据;
//! - **走批准门**: 复用 `SkillEvolver::promote` (同名/重复/超长都被拒), 不绕过 skills_runtime;
//! - **有出处**: 正文里写明来源意图 id, 事后可回查是"哪次经历学会的";
//! - **不吹能力**: 正文只写"怎么做", 不写"我已经能做什么"; 真能力仍由工具门决定。

use crate::gap::{GapPath, GapReport};
use crate::skills_runtime::{SkillCandidate, SkillEvolver, CandidateError, SKILL_BODY_MAX};
use crate::world::{Clarity, Intent, WantKind};

/// 类别 → 中文标签 (用于技能命名; 未列出的用原字符串)
fn cat_cn(intent: &Intent) -> &'static str {
    match intent.category {
        crate::world::IntentCategory::Food => "餐饮",
        crate::world::IntentCategory::Work => "求职",
        crate::world::IntentCategory::Social => "社交",
        crate::world::IntentCategory::Learn => "学习",
        crate::world::IntentCategory::Trade => "交易",
        crate::world::IntentCategory::Travel => "出行",
        crate::world::IntentCategory::Other => "通用",
    }
}

fn want_cn(want: WantKind) -> &'static str {
    match want {
        WantKind::Links => "链接",
        WantKind::Info => "信息",
        WantKind::People => "人选",
        WantKind::Companion => "搭子",
        WantKind::Service => "服务",
    }
}

/// 由意图 + 差距写一条方法型 skill 的候选 (纯函数, 可测)
///
/// `name` 里带类别与交付形态, 便于同名去重; `body` 是**步骤**, 不是承诺。
pub fn draft_skill(intent: &Intent, gap: &GapReport) -> SkillCandidate {
    let cat = cat_cn(intent);
    let want = want_cn(intent.want);
    let vague = matches!(intent.clarity, Clarity::Vague);
    let paths: Vec<&str> = gap.paths.iter().map(|p| match p {
        GapPath::Search => "检索",
        GapPath::Install => "装/写能力",
        GapPath::Delegate => "委托",
    }).collect();

    let name = format!("{cat}·{want}补能力法");
    let mut body = String::new();
    body.push_str(&format!("# {name}\n\n"));
    body.push_str(&format!(
        "## 适用\n- 意图类别：{cat}（{}）· 期望交付：{want} · 清晰度：{}\n- 来源意图：{}\n\n",
        intent.category.as_str(),
        if vague { "模糊" } else { "明确" },
        intent.id
    ));
    body.push_str("## 步骤\n");
    body.push_str(&format!(
        "1. 先**检索**：用 web_search / web_fetch 拿真实链接（关键词取意图原文），每条都要能点开、带出处。\n"
    ));
    body.push_str(&format!(
        "2. 组装交付：命中就出**链接卡**（≤3 条）；{}需要的场景再补内容卡（如简历/自我介绍/清单）。\n",
        if matches!(intent.want, WantKind::People | WantKind::Companion) { "社交类" } else { "工作类" }
    ));
    body.push_str("3. 仍缺服务或人手：走**委托**（任务公告板 / x402 购买），不要裸拒。\n");
    body.push_str("4. 交付后写 memory lesson：记录这次哪条路径有效、哪条白费。\n\n");
    if vague {
        body.push_str("## 模糊意图专用\n- 先交已能交付的部分，再问**一个**澄清问题（几人/口味/时段等），不许只提问不干活。\n\n");
    }
    body.push_str(&format!(
        "## 边界\n- 不编 URL / 不编数据；查不到就如实说查不到。\n- 本次差距路径：{}。\n- 本地完全权限不外放；对好友只读。\n",
        if paths.is_empty() { "（无）".to_string() } else { paths.join(" → ") }
    ));

    if body.chars().count() > SKILL_BODY_MAX {
        body = body.chars().take(SKILL_BODY_MAX).collect();
    }
    SkillCandidate {
        name,
        description: format!("{cat}类意图（想要{want}）的补能力步骤：检索→组装→委托→沉淀"),
        body,
        source_run: format!("world-intent:{}", intent.id),
    }
}

/// 写入技能库 (走 promote 批准门); 已存在同名 → 换带序号的名字再试一次
pub fn promote_draft(
    evolver: &mut SkillEvolver,
    cand: SkillCandidate,
    now_ms: u64,
) -> Result<String, CandidateError> {
    match evolver.promote(&cand, now_ms) {
        Ok(()) => Ok(cand.name),
        Err(CandidateError::NameExists) => {
            // 同名但内容可能更新 (新意图) → 用时间戳后缀区分, 不覆盖历史
            let mut alt = cand.clone();
            alt.name = format!("{}·{}", cand.name, now_ms / 1000 % 100000);
            evolver.promote(&alt, now_ms)?;
            Ok(alt.name)
        }
        Err(CandidateError::Duplicate) => Ok(format!("{}（内容已存在，未重复写入）", cand.name)),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gap::{detect_gaps, CapabilityInventory};
    use crate::world::classify_intent;

    fn intent_of(text: &str) -> Intent {
        let c = classify_intent(text);
        Intent {
            id: "intent-42".into(),
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
    fn draft_has_steps_and_source() {
        let it = intent_of("我想吃饭");
        let gap = detect_gaps(&it, &CapabilityInventory::default());
        let cand = draft_skill(&it, &gap);
        assert!(cand.name.contains("餐饮"), "名字应带类别: {}", cand.name);
        assert!(cand.body.contains(intent_of("我想吃饭").id.as_str()) || cand.body.contains("intent-42"), "要有出处");
        assert!(cand.body.contains("检索") && cand.body.contains("委托"), "要有补能力步骤");
        assert!(cand.body.contains("不编 URL"), "要有边界");
        assert!(cand.body.chars().count() <= SKILL_BODY_MAX);
        assert!(cand.source_run.starts_with("world-intent:"));
    }

    #[test]
    fn vague_intent_draft_mentions_clarifying_question() {
        let it = intent_of("我想吃饭"); // ≤8 字 → Vague
        let gap = detect_gaps(&it, &CapabilityInventory::default());
        let cand = draft_skill(&it, &gap);
        assert!(cand.body.contains("澄清问题"), "模糊意图必须写澄清步骤");
    }

    #[test]
    fn promote_goes_through_approval_gate_and_dedupes() {
        let it = intent_of("我在杭州找后端开发的工作");
        let gap = detect_gaps(&it, &CapabilityInventory::default());
        let mut ev = SkillEvolver::new();
        let name = promote_draft(&mut ev, draft_skill(&it, &gap), 1).unwrap();
        assert!(ev.registry.index_for_prompt().contains(&name), "装完下一轮索引可见");
        // 同内容再写一次 → 不重复入库, 但如实告知
        let again = promote_draft(&mut ev, draft_skill(&it, &gap), 2).unwrap();
        assert!(again.contains("未重复写入"), "重复应如实: {again}");
        assert_eq!(ev.registry.len(), 1);
    }

    #[test]
    fn same_category_new_intent_keeps_history() {
        let mut ev = SkillEvolver::new();
        let a = intent_of("我想吃饭");
        let b = Intent { id: "intent-99".into(), ..intent_of("想找人一起吃火锅") };
        let ga = detect_gaps(&a, &CapabilityInventory::default());
        let gb = detect_gaps(&b, &CapabilityInventory::default());
        promote_draft(&mut ev, draft_skill(&a, &ga), 1000).unwrap();
        let n2 = promote_draft(&mut ev, draft_skill(&b, &gb), 2000).unwrap();
        assert!(n2.contains('·'), "同名但内容不同 → 带序号保留历史: {n2}");
        assert_eq!(ev.registry.len(), 2);
    }
}
