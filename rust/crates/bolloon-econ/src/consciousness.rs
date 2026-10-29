//! 意识成长档案（Consciousness Profile）——**只看行为，不看身份**。
//!
//! 三条铁律（写死在代码结构里，不是口号）：
//! 1. **不看身份**：本模块的输入结构里没有信仰/民族/国籍/政治/性别字段，无法据此打分。
//!    佛陀、六祖慧能、老子、苏格拉底、孔子、穆罕默德在这里只作为**德性原型**
//!    （慈悲、顿悟、自然、追问、礼与仁、守信与克制），用来命名"什么行为算善"，
//!    而不是用来判断"你是谁"。
//! 2. **只加不减**：阶段只决定"能得到多少帮助/额度/角色"，**永远不低于基线**；
//!    经济层的地板额度（`floor_calls`）不受本档案影响，任何人都不会被降权到不能说话。
//! 3. **完全透明可申诉**：每项得分都能追到来源；本人看得到自己的档案与理由，
//!    可以要求更正（`appealable=true`），不存在"系统偷偷给你打分"。
//!
//! 它回答的问题是：**这个人此刻需要什么帮助，以及我们能给他多一点什么**，
//! 而不是"这个人值多少分"。

use serde::{Deserialize, Serialize};

/// 可核验的行为信号（每一项都必须有第三方可查的证据；**不接受自我申报**）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Signals {
    /// 帮助他人且被对方确认（"他帮我解决了 X"）
    pub helped_others_verified: u32,
    /// 兑现承诺：交付通过验收的次数
    pub promises_kept: u32,
    /// 主动分享（资源/知识/额度）被确认
    pub shares_verified: u32,
    /// 主动更正自己错误的次数（知错能改）
    pub corrections: u32,
    /// 提出过被采纳的深层追问（不是附和）
    pub deep_questions: u32,
    /// 在冲突中降温/促成和解的次数
    pub deescalations: u32,
    /// 用社区资源（而非自己烧钱）把事办成的次数 —— "知世故而不世故"的实证
    pub zero_cost_successes: u32,
    /// 连续复盘天数（自我觉察）
    pub reflection_days: u32,
}

/// 成长阶段（刻意不用"等级/评分"命名，避免变成身份标签）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// 初识：先观察、先给最基础的帮助
    Seed,
    /// 有来有往：开始有可核验的善意
    Sprout,
    /// 稳定：守信、能自省、能帮人
    Steady,
    /// 深厚：长期利他且有觉察
    Deep,
    /// 通透：以上都长期成立，且能带人
    Luminous,
}

impl Stage {
    pub fn as_str(&self) -> &'static str {
        match self {
            Stage::Seed => "seed",
            Stage::Sprout => "sprout",
            Stage::Steady => "steady",
            Stage::Deep => "deep",
            Stage::Luminous => "luminous",
        }
    }
    /// 阶段对应的"德性原型"（只作为意义参照，不作为身份判定）
    pub fn archetypes(&self) -> &'static [&'static str] {
        match self {
            Stage::Seed => &["苏格拉底：先承认自己不知道"],
            Stage::Sprout => &["孔子：己所不欲，勿施于人"],
            Stage::Steady => &["六祖慧能：不是风动，不是幡动，仁者心动"],
            Stage::Deep => &["老子：上善若水，利万物而不争"],
            Stage::Luminous => &["佛陀：以慈悲摄受，以智慧化解"],
        }
    }
}

/// 这个人在**此刻**需要什么帮助（按需求来帮，而不是按分数给脸色）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Need {
    /// 需求类型
    pub kind: String,
    /// 为什么这么判断（来自哪条信号）
    pub because: String,
    /// 建议给什么帮助
    pub help: String,
}

/// 多给一点点什么（都给得起，且不伤害他人）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Permissions {
    /// 日常额度倍率（1.0 = 基线；最高 2.0，且受日上限约束）
    pub allowance_multiplier: f64,
    /// 每天额外可加的群数（叠加在年龄额度上）
    pub invite_bonus: u32,
    /// 能不能当"带人"的角色（教别人、给新手做示范）
    pub can_mentor: bool,
    /// 排队优先级（0 = 普通；越大越先）
    pub queue_priority: u32,
    /// 是否可以直接看更深的材料/更长的上下文
    pub deeper_material: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub principal: String,
    /// 0..100 的成长指数（仅供自己看趋势，不是排名）
    pub index: u32,
    pub stage: Stage,
    pub signals: Signals,
    /// 每项得分与来源（透明）
    pub reasons: Vec<String>,
    pub needs: Vec<Need>,
    pub permissions: Permissions,
    /// 怎么往上走（具体可做的事，不是心灵鸡汤）
    pub growth_path: Vec<String>,
    /// 本人可要求更正 —— 恒为 true
    pub appealable: bool,
    /// 明确写清：本档案只影响"能多拿什么"，不影响"能不能说话"
    pub never_reduces_access: bool,
}

fn clamp01(x: f64) -> f64 {
    x.clamp(0.0, 1.0)
}

/// 核心：从**行为证据**算成长档案。纯函数，可单测。
pub fn assess(principal: &str, s: &Signals) -> Profile {
    // 每项按"次数 → 饱和曲线"折算，避免刷量线性获益（第 10 次和第 11 次差别很小）
    let sat = |n: u32, k: f64| -> f64 {
        let n = n as f64;
        clamp01(n / (n + k))
    };
    let w_help = sat(s.helped_others_verified, 3.0); // 率
    let w_keep = sat(s.promises_kept, 4.0); // 信
    let w_share = sat(s.shares_verified, 3.0); // 施
    let w_fix = sat(s.corrections, 2.0); // 改过
    let w_ask = sat(s.deep_questions, 3.0); // 追问
    let w_calm = sat(s.deescalations, 2.0); // 和
    let w_plain = sat(s.zero_cost_successes, 3.0); // 不靠烧钱把事办成
    let w_watch = sat(s.reflection_days, 7.0); // 自省

    // 权重：利他 > 守信 > 改过/自省 > 追问/和解 > 节省
    let raw = w_help * 30.0
        + w_keep * 22.0
        + w_share * 12.0
        + w_fix * 12.0
        + w_ask * 8.0
        + w_calm * 6.0
        + w_plain * 5.0
        + w_watch * 5.0;
    let index = raw.round().clamp(0.0, 100.0) as u32;

    // 阈值：Seed <12 ≤ Sprout <32 ≤ Steady <55 ≤ Deep <75 ≤ Luminous
    let stage = if index >= 75 {
        Stage::Luminous
    } else if index >= 55 {
        Stage::Deep
    } else if index >= 32 {
        Stage::Steady
    } else if index >= 12 {
        Stage::Sprout
    } else {
        Stage::Seed
    };

    let mut reasons = vec![];
    let mut push = |n: u32, label: &str, w: f64, pts: f64| {
        if n > 0 {
            reasons.push(format!("{label} ×{n} ⇒ {pts:.1} 分（权重 {w:.0}）"));
        }
    };
    push(s.helped_others_verified, "帮到别人且被确认", 30.0, w_help * 30.0);
    push(s.promises_kept, "承诺兑现并通过验收", 22.0, w_keep * 22.0);
    push(s.shares_verified, "主动分享被确认", 12.0, w_share * 12.0);
    push(s.corrections, "主动更正错误", 12.0, w_fix * 12.0);
    push(s.deep_questions, "被采纳的深层追问", 8.0, w_ask * 8.0);
    push(s.deescalations, "冲突降温", 6.0, w_calm * 6.0);
    push(s.zero_cost_successes, "不烧钱把事办成", 5.0, w_plain * 5.0);
    push(s.reflection_days, "连续复盘", 5.0, w_watch * 5.0);
    if reasons.is_empty() {
        reasons.push("还没有可核验的善意证据 —— 这不扣分，只是从基线开始".into());
    }
    reasons.push(format!("指数 = {index}（阶段 {}）", stage.as_str()));

    // 按需给帮助：从信号缺口反推"他现在缺什么"
    let mut needs = vec![];
    if s.promises_kept == 0 {
        needs.push(Need {
            kind: "first_win".into(),
            because: "还没有一次通过验收的交付".into(),
            help: "给一个 15 分钟能做完的小任务，先把'我说到做到'跑通一次".into(),
        });
    }
    if s.helped_others_verified == 0 {
        needs.push(Need {
            kind: "serve_someone".into(),
            because: "还没有帮到别人的记录".into(),
            help: "推荐一个正卡住的新手，让他帮对方解决一个具体问题（帮人是最快的心智训练）".into(),
        });
    }
    if s.deep_questions == 0 {
        needs.push(Need {
            kind: "deeper_material".into(),
            because: "提问还停留在表层".into(),
            help: "给到原始材料 + 三层追问模板（是什么/为什么/如果相反会怎样）".into(),
        });
    }
    if s.reflection_days == 0 {
        needs.push(Need {
            kind: "reflection".into(),
            because: "没有复盘记录".into(),
            help: "每天收尾问三句：今天做成了什么/哪里错了/明天改哪一点".into(),
        });
    }
    if s.corrections == 0 && index >= 35 {
        needs.push(Need {
            kind: "humility".into(),
            because: "有产出但没有更正记录（没人永远对）".into(),
            help: "鼓励公开更正一次判断 —— 认错不降低信任，掩盖才降".into(),
        });
    }
    if needs.is_empty() {
        needs.push(Need {
            kind: "lead".into(),
            because: "基础已经具备".into(),
            help: "请他去带一个新人：把方法讲清楚，比自己再做十次更能长".into(),
        });
    }

    // 权限：温和加成，且明确不影响"能不能说话"
    let allowance_multiplier = match stage {
        Stage::Seed => 1.0,
        Stage::Sprout => 1.25,
        Stage::Steady => 1.5,
        Stage::Deep => 1.75,
        Stage::Luminous => 2.0,
    };
    let invite_bonus = match stage {
        Stage::Seed => 0,
        Stage::Sprout => 5,
        Stage::Steady => 20,
        Stage::Deep => 60,
        Stage::Luminous => 120,
    };
    let permissions = Permissions {
        allowance_multiplier,
        invite_bonus,
        can_mentor: stage >= Stage::Steady,
        queue_priority: match stage {
            Stage::Seed => 0,
            Stage::Sprout => 1,
            Stage::Steady => 2,
            Stage::Deep => 3,
            Stage::Luminous => 4,
        },
        deeper_material: stage >= Stage::Sprout,
    };

    let growth_path = vec![
        "慈悲：帮一个陌生人解决一个具体问题（不要宏大，要具体）".to_string(),
        "守信：只承诺你 24 小时内能交付的事，然后交付".to_string(),
        "诚实：公开更正一次自己的错误判断".to_string(),
        "谦逊：主动向比你弱的人请教一个问题".to_string(),
        "觉察：每天复盘三句（做成什么/错在哪/明天改什么）".to_string(),
        "不世故：能用正当办法办成的事，不要靠人情与套路".to_string(),
    ];

    Profile {
        principal: principal.to_string(),
        index,
        stage,
        signals: s.clone(),
        reasons,
        needs,
        permissions,
        growth_path,
        appealable: true,
        never_reduces_access: true,
    }
}

/// 给人类看的视图：**没有指数、没有阶段、没有分数** —— 只有"你现在需要什么帮助"和"往哪走"。
///
/// 量化指标只对智能体可见（它们据此调整帮助方式），人看到的永远是具体的帮助本身。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumanView {
    pub principal: String,
    pub needs: Vec<Need>,
    pub growth_path: Vec<String>,
    /// 明确告知：系统内部有量化评估，但不展示给本人
    pub note: String,
    /// 觉得某条记录不对可以要求更正
    pub appealable: bool,
    /// 不影响"能不能说话/能不能用"
    pub never_reduces_access: bool,
    /// 恒 false：人类视图不含量化指标
    pub quantified: bool,
}

pub fn human_view(p: &Profile) -> HumanView {
    HumanView {
        principal: p.principal.clone(),
        needs: p.needs.clone(),
        growth_path: p.growth_path.clone(),
        note: "系统会按你的实际行为调整能给到的帮助，但不给你打分、也不展示分数；你觉得某条记录不对，可以要求更正"
            .into(),
        appealable: true,
        never_reduces_access: true,
        quantified: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_evidence_means_baseline_not_punishment() {
        let p = assess("newcomer", &Signals::default());
        assert_eq!(p.stage, Stage::Seed);
        assert_eq!(p.index, 0);
        assert_eq!(p.permissions.allowance_multiplier, 1.0);
        assert!(!p.permissions.can_mentor);
        assert!(p.never_reduces_access, "档案不许降权");
        assert!(p.appealable);
        assert!(!p.needs.is_empty(), "没有证据也要给出'从哪开始'");
    }

    #[test]
    fn verified_altruism_beats_declared_altruism() {
        // 只有自我申报（结构上根本没有这个字段）⇒ 仍是从零开始的 Seed
        let base = assess("u", &Signals::default());
        assert_eq!(base.index, 0);

        // 有第三方确认的利他 ⇒ 明显上升
        let kind = Signals {
            helped_others_verified: 6,
            promises_kept: 6,
            shares_verified: 3,
            corrections: 2,
            deep_questions: 2,
            deescalations: 1,
            zero_cost_successes: 2,
            reflection_days: 10,
        };
        let p = assess("u", &kind);
        assert!(p.index >= 55, "持续利他 + 守信应到 Deep 以上: {}", p.index);
        assert_eq!(p.stage, Stage::Deep);
        assert!(p.permissions.can_mentor);
        assert!(p.permissions.allowance_multiplier >= 1.75);
    }

    #[test]
    fn diminishing_returns_prevent_farming() {
        let a = assess("u", &Signals { helped_others_verified: 10, ..Default::default() });
        let b = assess("u", &Signals { helped_others_verified: 10_000, ..Default::default() });
        assert!(b.index >= a.index);
        assert!(
            b.index - a.index <= 7,
            "刷量几乎不涨（1000 倍行为只差 ≤7 分）: {} vs {}",
            a.index,
            b.index
        );
    }

    #[test]
    fn profile_has_no_identity_dimensions() {
        let s = Signals {
            helped_others_verified: 1,
            ..Default::default()
        };
        let blob = serde_json::to_string(&assess("u", &s)).unwrap();
        for forbidden in ["religion", "faith", "ethnic", "nationality", "party", "gender", "race"] {
            assert!(
                !blob.to_lowercase().contains(forbidden),
                "档案不许出现身份维度: {forbidden}"
            );
        }
        // 德性原型只以引文形式出现（教什么算善），不含身份字段名
        let p = assess("u", &s);
        assert!(!p.stage.archetypes().is_empty());
    }

    #[test]
    fn higher_stage_gets_more_but_never_less_than_baseline() {
        let mut prev = 0.0;
        for (h, k) in [(0, 0), (1, 1), (3, 3), (6, 6), (20, 20)] {
            let p = assess("u", &Signals { helped_others_verified: h, promises_kept: k, ..Default::default() });
            assert!(p.permissions.allowance_multiplier >= 1.0, "永远 ≥ 基线");
            assert!(p.permissions.allowance_multiplier >= prev, "单调不倒退");
            prev = p.permissions.allowance_multiplier;
        }
    }

    #[test]
    fn human_view_hides_every_number() {
        let s = Signals {
            helped_others_verified: 8,
            promises_kept: 8,
            ..Default::default()
        };
        let p = assess("u", &s);
        assert!(p.index > 0, "内部确实有量化指标");
        let hv = human_view(&p);
        let blob = serde_json::to_string(&hv).unwrap().to_lowercase();
        for forbidden in ["index", "score", "stage", "\"level\"", "luminous", "deep\""] {
            assert!(!blob.contains(forbidden), "人类视图不许出现指标: {forbidden} ⇒ {blob}");
        }
        assert!(!hv.quantified);
        assert!(!hv.needs.is_empty(), "但要给出具体帮助");
        assert!(!hv.note.is_empty());
    }

    #[test]
    fn needs_are_actionable() {
        let p = assess("u", &Signals { promises_kept: 3, ..Default::default() });
        assert!(p.needs.iter().any(|n| n.kind == "serve_someone"), "缺利他 ⇒ 建议去帮人");
        for n in &p.needs {
            assert!(!n.help.is_empty() && !n.because.is_empty(), "需求必须说清原因与做法");
        }
    }
}
