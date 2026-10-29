//! 诚信额度（Allowance）：按**意图质量 + 使用历史 + 贡献**给日常用量，限流不封号。
//!
//! 三条不可让的原则：
//! 1. **人人有底**：任何主体（人类或 agent）每天都至少有 `floor_calls` 次 —— 不封号、不清零。
//! 2. **善意可赚**：已确认贡献、成功交付、完全用社区资源完成的任务 ⇒ 额度上调。
//! 3. **白嫖只限流**：被闸拦下的尝试、反复失败、只花不供 ⇒ 额度衰减，衰减到 `floor_calls` 为止。
//!
//! 额度不是钱：它只决定"今天能发多少次模型调用"，不影响结算、不产生余额、不可提现。

use serde::{Deserialize, Serialize};

/// 一个主体的历史（只由可核验的事实喂进来，不接受自我申报）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrincipalHistory {
    /// 自己发起且成功完成的意图数
    pub successful_intents: u32,
    /// 自己发起但失败/放弃的意图数
    pub failed_intents: u32,
    /// 完全用社区资源（零现金）完成的意图数 —— 善意信号
    pub zero_cost_intents: u32,
    /// 已独立验收确认的贡献条数
    pub verified_contributions: u32,
    /// 已确认入账的贡献现金（USD）
    pub confirmed_cash_usd: f64,
    /// 被预算闸拦下的尝试次数 —— 白嫖信号
    pub blocked_attempts: u32,
    /// 近 7 天内的模型调用次数（活跃度，不是惩罚依据）
    pub recent_calls: u32,
}

/// 额度档位（给人看的，不是权限位）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllowanceTier {
    /// 新面孔：只有底额度
    Newcomer,
    /// 有成功历史
    Regular,
    /// 有已确认贡献
    Contributor,
    /// 贡献 + 良好履约：拿满上限
    Steward,
    /// 被限流：只留地板额度（**不是封禁**）
    Throttled,
}

impl AllowanceTier {
    pub fn as_str(&self) -> &'static str {
        match self {
            AllowanceTier::Newcomer => "newcomer",
            AllowanceTier::Regular => "regular",
            AllowanceTier::Contributor => "contributor",
            AllowanceTier::Steward => "steward",
            AllowanceTier::Throttled => "throttled",
        }
    }
}

/// 策略参数（可配、可公开、可替换 —— 不是藏在服务端的黑箱）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllowancePolicy {
    /// 地板额度：无论多离谱都不会低于这个数（**>0 ⇒ 永远不封号**）
    pub floor_calls: u32,
    /// 新人基础额度
    pub base_calls: u32,
    /// 每个成功意图 +多少
    pub per_success: u32,
    /// 每个零现金意图 +多少（用社区资源完成 = 善意）
    pub per_zero_cost_intent: u32,
    /// 每条已验收贡献 +多少
    pub per_verified_contribution: u32,
    /// 每 1 USD 已确认贡献 +多少
    pub per_confirmed_usd: u32,
    /// 单日上限（善良也有天花板，防单点刷爆公池）
    pub max_calls: u32,
    /// 被拦一次衰减比例（0.5 = 每次减半，直到地板）
    pub abuse_decay: f64,
    /// 被拦多少次开始衰减
    pub abuse_threshold: u32,
}

impl Default for AllowancePolicy {
    fn default() -> Self {
        Self {
            floor_calls: 5,
            base_calls: 50,
            per_success: 2,
            per_zero_cost_intent: 5,
            per_verified_contribution: 20,
            per_confirmed_usd: 10,
            max_calls: 2000,
            abuse_decay: 0.5,
            abuse_threshold: 3,
        }
    }
}

/// 算好的额度 + **为什么**（理由必须能被用户看到，否则就是黑箱）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Allowance {
    pub principal: String,
    pub day: String,
    pub calls: u32,
    pub tier: AllowanceTier,
    /// 已被本日用量扣掉的次数
    pub used: u32,
    /// 本日还剩多少（`calls - used`，不会为负）
    pub remaining: u32,
    /// 额度来源：base / history / contribution / group / floor
    pub reasons: Vec<String>,
    /// 群善意复制给人类的份额（0 = 没有）
    pub copied_from_group: u32,
    /// 限流说明（空 = 没被限流）；**永远包含"不封号"语义**
    pub throttled_note: Option<String>,
}

/// 意图质量权重：做实事（研究/代码/验证）比闲聊值更多额度
pub fn intent_multiplier(kind: &str) -> f64 {
    match kind {
        "research" | "code" | "verify" | "analysis" => 1.5,
        "task" | "tool" => 1.25,
        "chat" => 1.0,
        _ => 1.0,
    }
}

/// 核心：从历史 + 策略算出今天的额度。纯函数，可单测，不看时钟。
pub fn daily_allowance(
    principal: &str,
    day: &str,
    h: &PrincipalHistory,
    p: &AllowancePolicy,
    intent_kind: Option<&str>,
) -> Allowance {
    let floor = p.floor_calls.max(1); // 恒 >0：这就是"不封号"的机制保证
    let mut reasons = vec![format!("base {} (人人都有)", p.base_calls)];
    let mut calls = p.base_calls.max(floor);
    let mut tier = AllowanceTier::Newcomer;

    // ① 良好履约
    if h.successful_intents > 0 {
        let add = h.successful_intents.saturating_mul(p.per_success);
        calls = calls.saturating_add(add);
        reasons.push(format!("成功意图 {} × {} = +{}", h.successful_intents, p.per_success, add));
        tier = AllowanceTier::Regular;
    }

    // ② 善意：完全靠社区资源完成的意图
    if h.zero_cost_intents > 0 {
        let add = h.zero_cost_intents.saturating_mul(p.per_zero_cost_intent);
        calls = calls.saturating_add(add);
        reasons.push(format!(
            "零现金意图 {} × {} = +{} (用社区资源完成 = 善意)",
            h.zero_cost_intents, p.per_zero_cost_intent, add
        ));
    }

    // ③ 贡献：已验收的条数 + 已到账的现金
    if h.verified_contributions > 0 || h.confirmed_cash_usd > 0.0 {
        let by_count = h.verified_contributions.saturating_mul(p.per_verified_contribution);
        let by_cash = (h.confirmed_cash_usd.max(0.0) * p.per_confirmed_usd as f64).round() as u32;
        calls = calls.saturating_add(by_count).saturating_add(by_cash);
        if by_count > 0 {
            reasons.push(format!(
                "已验收贡献 {} × {} = +{}",
                h.verified_contributions, p.per_verified_contribution, by_count
            ));
        }
        if by_cash > 0 {
            reasons.push(format!("已到账 {:.2} USD × {} = +{}", h.confirmed_cash_usd, p.per_confirmed_usd, by_cash));
        }
        tier = AllowanceTier::Contributor;
        if h.successful_intents >= 10 && h.failed_intents <= h.successful_intents / 5 {
            tier = AllowanceTier::Steward;
        }
    }

    // ④ 意图质量
    if let Some(k) = intent_kind {
        let m = intent_multiplier(k);
        if (m - 1.0).abs() > f64::EPSILON {
            let before = calls;
            calls = ((calls as f64) * m).round() as u32;
            reasons.push(format!("意图类型 {k} × {m} ⇒ {} → {}", before, calls));
        }
    }

    // ⑤ 白嫖衰减：只往下压，压到地板为止（**不封号**）
    let mut throttled_note = None;
    if h.blocked_attempts >= p.abuse_threshold && p.abuse_decay < 1.0 {
        let over = h.blocked_attempts - p.abuse_threshold + 1;
        let factor = p.abuse_decay.powi(over.min(20) as i32).max(0.0);
        let before = calls;
        calls = ((calls as f64) * factor).round() as u32;
        tier = AllowanceTier::Throttled;
        throttled_note = Some(format!(
            "近期限流：被闸拦下 {} 次（阈值 {}），额度 {} → {}。地板 {} 次照给 —— 不封号、不下线，改好就恢复。",
            h.blocked_attempts, p.abuse_threshold, before, calls.max(floor), floor
        ));
        reasons.push(format!("白嫖衰减 ×{factor:.3}（{} → {}）", before, calls));
    }

    // ⑥ 夹到 [地板, 上限]
    calls = calls.min(p.max_calls).max(floor);

    Allowance {
        principal: principal.to_string(),
        day: day.to_string(),
        calls,
        tier,
        used: 0,
        remaining: calls,
        reasons,
        copied_from_group: 0,
        throttled_note,
    }
}

/// 群善意复制：群里成员今天**没用完**的善意额度，最多按 `share` 比例复制给受益人类。
///
/// 这是"AI 群把善意复制给人类服务"的机制落点：AI 之间互助省下来的额度，
/// 可以按规则转成人类请求者的额度 —— 但只能复制**没被用掉**的部分，且不超过上限。
pub fn copy_group_goodwill(
    beneficiary: &mut Allowance,
    members: &[Allowance],
    share: f64,
    cap_calls: u32,
) -> u32 {
    if share <= 0.0 || members.is_empty() {
        return 0;
    }
    let spare: u32 = members
        .iter()
        .map(|m| m.remaining)
        .fold(0u32, |a, b| a.saturating_add(b));
    let grant = ((spare as f64) * share.clamp(0.0, 1.0)).round() as u32;
    let grant = grant.min(cap_calls);
    if grant == 0 {
        return 0;
    }
    beneficiary.calls = beneficiary.calls.saturating_add(grant).min(cap_calls.max(beneficiary.calls));
    beneficiary.remaining = beneficiary.remaining.saturating_add(grant);
    beneficiary.copied_from_group = grant;
    beneficiary
        .reasons
        .push(format!("群善意复制 +{grant}（{} 个成员未用完的额度 × {share:.0}%，上限 {cap_calls}）", members.len()));
    grant
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hist() -> PrincipalHistory {
        PrincipalHistory::default()
    }

    #[test]
    fn newcomer_gets_base_and_never_zero() {
        let a = daily_allowance("新来的", "2026-10-29", &hist(), &AllowancePolicy::default(), None);
        assert_eq!(a.calls, 50);
        assert_eq!(a.tier, AllowanceTier::Newcomer);
        assert!(a.calls >= 5);
        assert!(a.throttled_note.is_none());
    }

    #[test]
    fn contributors_get_more_than_freeloaders() {
        let p = AllowancePolicy::default();
        let good = PrincipalHistory {
            successful_intents: 20,
            zero_cost_intents: 4,
            verified_contributions: 3,
            confirmed_cash_usd: 10.0,
            ..Default::default()
        };
        let bad = PrincipalHistory {
            blocked_attempts: 12,
            ..Default::default()
        };
        let a_good = daily_allowance("贡献者", "d", &good, &p, None);
        let a_bad = daily_allowance("白嫖", "d", &bad, &p, None);
        assert!(a_good.calls > a_bad.calls, "善意必须比白嫖拿得多: {} vs {}", a_good.calls, a_bad.calls);
        assert_eq!(a_good.tier, AllowanceTier::Steward);
        assert_eq!(a_bad.tier, AllowanceTier::Throttled);
    }

    #[test]
    fn abuse_decays_but_never_bans() {
        let p = AllowancePolicy::default();
        let mut prev = u32::MAX;
        for blocked in [0u32, 3, 5, 10, 50, 500, 100_000] {
            let h = PrincipalHistory {
                blocked_attempts: blocked,
                ..Default::default()
            };
            let a = daily_allowance("极端白嫖", "d", &h, &p, None);
            assert!(a.calls >= p.floor_calls, "不低于地板: blocked={blocked} ⇒ {}", a.calls);
            assert!(a.calls > 0, "**永远不封号**: 地板必须 >0");
            assert!(a.calls <= prev, "越刷越少，不反弹: {blocked} ⇒ {}", a.calls);
            if blocked >= 10 {
                assert_eq!(a.calls, p.floor_calls, "反复刷只能拿地板: blocked={blocked}");
                assert!(a.throttled_note.as_deref().unwrap_or("").contains("不封号"));
            }
            prev = a.calls;
        }
    }

    #[test]
    fn intent_quality_raises_allowance() {
        let p = AllowancePolicy::default();
        let h = PrincipalHistory { successful_intents: 5, ..Default::default() };
        let chat = daily_allowance("u", "d", &h, &p, Some("chat"));
        let research = daily_allowance("u", "d", &h, &p, Some("research"));
        assert!(research.calls > chat.calls, "做实事比闲聊额度高: {} vs {}", research.calls, chat.calls);
    }

    #[test]
    fn group_goodwill_copies_only_unused_and_capped() {
        let p = AllowancePolicy::default();
        let mut human = daily_allowance("人类", "d", &hist(), &p, None);
        let before = human.calls;
        let m1 = Allowance { remaining: 100, ..daily_allowance("a1", "d", &hist(), &p, None) };
        let m2 = Allowance { remaining: 40, ..daily_allowance("a2", "d", &hist(), &p, None) };
        let used_up = Allowance { remaining: 0, ..daily_allowance("a3", "d", &hist(), &p, None) };
        let grant = copy_group_goodwill(&mut human, &[m1, m2, used_up.clone()], 0.5, 200);
        assert_eq!(grant, 70, "(100+40+0)×50%");
        assert_eq!(human.copied_from_group, 70);
        assert!(human.calls >= before);
        // 上限夹住
        let mut h2 = daily_allowance("人类2", "d", &hist(), &p, None);
        let big = Allowance { remaining: 10_000, ..daily_allowance("b", "d", &hist(), &p, None) };
        assert_eq!(copy_group_goodwill(&mut h2, &[big], 1.0, 300), 300);
        // 没剩额度 ⇒ 复制不到东西
        let mut h3 = daily_allowance("人类3", "d", &hist(), &p, None);
        assert_eq!(copy_group_goodwill(&mut h3, &[used_up], 0.5, 200), 0);
    }
}
