//! 诚信档案（Reputation）：**双层**结构 —— 可上链的紧凑承诺 + 更详细的链下档案。
//!
//! 为什么要分两层：
//! - 上链只放**最少必要事实**（档位、额度、贡献计数、被拦次数、与细节的哈希承诺），
//!   别人能验证"这个人是什么档、有没有被限流"，但看不到他具体问了什么、跟谁聊了什么；
//! - 链下放**详细理由**（额度为什么这么多、哪几次被拦、贡献了什么），供本地 UI 与
//!   其它智能体判断"要不要跟他协作、要不要设防"。
//!
//! 设计要点：
//! 1. **确定性**：同一份档案 ⇒ 同一个 digest（字段顺序固定、浮点规整），节点间可比对。
//! 2. **不泄漏原文**：digest 覆盖的是计数与档位 + `detail_digest`，不含 prompt/消息正文。
//! 3. **善意可见**：把"怎么才能拿到更多额度"写进 `goodwill_path`，让人知道路怎么走。
//! 4. **限流不封号**：`flags` 里只可能出现 `throttled`，永远不会出现 `banned`。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::allowance::{Allowance, AllowancePolicy, AllowanceTier, PrincipalHistory};

/// 上链部分：紧凑、可验证、最小披露
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OnChainAttestation {
    /// 格式版本（链上数据必须能随规则演进）
    pub schema: String,
    /// 主体（DID 或 agent id）
    pub principal: String,
    /// 统计窗口（`2026-10-29` 这种日窗，或 `2026-W44`）
    pub window: String,
    /// 档位
    pub tier: String,
    /// 当日额度（次）
    pub allowance_calls: u32,
    /// 成功意图
    pub successful_intents: u32,
    /// 已验收贡献条数
    pub verified_contributions: u32,
    /// 已确认到账贡献（USD，保留 6 位）
    pub confirmed_cash_usd: f64,
    /// 被预算闸拦下的次数（白嫖信号）
    pub blocked_attempts: u32,
    /// 是否被限流（true = 只发地板额度）
    pub throttled: bool,
    /// 链下细节的哈希承诺（细节本身不上链）
    pub detail_digest: String,
    /// 本记录的完整性摘要（不含自身）
    pub digest: String,
}

/// 链下部分：可以很详细
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OffChainProfile {
    pub principal: String,
    pub window: String,
    pub history: PrincipalHistory,
    pub allowance: Allowance,
    /// 额度增减的逐条理由（来自 allowance.reasons）
    pub reasons: Vec<String>,
    /// 被限流时的解释（含"不封号"承诺）
    pub throttle_explanation: Option<String>,
    /// 想拿更多额度该做什么（系统把"如何激发善意"写明）
    pub goodwill_path: Vec<String>,
    /// 加群权限（每天还能新加几个群）
    pub join_quota: JoinQuota,
}

/// 加群权限：诚信度低的，加群能力有限（**不是不能发言，而是不能到处占坑**）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JoinQuota {
    pub groups_per_day: u32,
    pub used_today: u32,
    pub remaining: u32,
    pub reason: String,
}

/// 加群额度：新面孔 10/天，第 5 天放宽到 100/天，满月且无违规放宽到 500/天；
/// 一旦有违规操作 ⇒ 降到 5/天（**不是封号**，已有群照常发言/干活）。
///
/// 依据 leo 2026-10-29 定的口径：额度随"账号年龄 + 有无违规"走，不随情绪走。
pub const JOIN_QUOTA_NEW_DAY: u32 = 10;
pub const JOIN_QUOTA_DAY5: u32 = 100;
pub const JOIN_QUOTA_MATURED: u32 = 500;
pub const JOIN_QUOTA_PENALTY: u32 = 5;
pub const JOIN_QUOTA_MATURE_DAYS: u32 = 30;
pub const JOIN_QUOTA_RELAX_DAY: u32 = 5;

/// 按账号年龄与违规情况给今天的加群额度
pub fn join_quota_by_age(age_days: u32, violations: u32) -> u32 {
    if violations > 0 {
        return JOIN_QUOTA_PENALTY;
    }
    if age_days >= JOIN_QUOTA_MATURE_DAYS {
        JOIN_QUOTA_MATURED
    } else if age_days >= JOIN_QUOTA_RELAX_DAY {
        JOIN_QUOTA_DAY5
    } else {
        JOIN_QUOTA_NEW_DAY
    }
}

/// 兼容入口：只看档位时（没有账号年龄可用的情况），被限流按违规处理
pub fn join_quota_for(tier: AllowanceTier) -> u32 {
    match tier {
        AllowanceTier::Throttled => JOIN_QUOTA_PENALTY,
        _ => JOIN_QUOTA_NEW_DAY,
    }
}

/// 按账号年龄 + 违规次数算今天还能加几个群
pub fn quota_with_age(age_days: u32, violations: u32, used_today: u32) -> JoinQuota {
    let cap = join_quota_by_age(age_days, violations);
    let reason = if violations > 0 {
        format!(
            "检测到 {violations} 次违规操作：加群额度降到 {}/天（已有群的发言、干活、接任务不受限；纠正后按年龄档恢复）",
            JOIN_QUOTA_PENALTY
        )
    } else if age_days >= JOIN_QUOTA_MATURE_DAYS {
        format!("满 {} 天且无违规：{}/天", JOIN_QUOTA_MATURE_DAYS, JOIN_QUOTA_MATURED)
    } else if age_days >= JOIN_QUOTA_RELAX_DAY {
        format!("第 {} 天起：{}/天", JOIN_QUOTA_RELAX_DAY, JOIN_QUOTA_DAY5)
    } else {
        format!("新面孔第 {} 天：{}/天（先把一个群用起来，比进十个群刷脸有用）", age_days + 1, JOIN_QUOTA_NEW_DAY)
    };
    JoinQuota {
        groups_per_day: cap,
        used_today,
        remaining: cap.saturating_sub(used_today),
        reason,
    }
}

/// 兼容入口（只按档位，无年龄信息时）
pub fn quota_with_usage(tier: AllowanceTier, used_today: u32) -> JoinQuota {
    let cap = join_quota_for(tier);
    JoinQuota {
        groups_per_day: cap,
        used_today,
        remaining: cap.saturating_sub(used_today),
        reason: match tier {
            AllowanceTier::Throttled => format!(
                "近期违规/被闸拦下：加群额度降到 {}/天；已有群发言与干活不受限",
                JOIN_QUOTA_PENALTY
            ),
            _ => format!("新面孔：{}/天", JOIN_QUOTA_NEW_DAY),
        },
    }
}

/// 发言标识：诚信度低的人在群里发言会被打上可见标记，其它智能体据此设防。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpeechFlag {
    /// `ok` | `watch` | `low_trust`
    pub level: String,
    /// 给人类/agent 看的一句话
    pub note: String,
}

/// 由档位决定发言标识（Throttled ⇒ low_trust；Newcomer ⇒ watch；其余 ok）
pub fn speech_flag(tier: AllowanceTier, blocked: u32) -> Option<SpeechFlag> {
    match tier {
        AllowanceTier::Throttled => Some(SpeechFlag {
            level: "low_trust".into(),
            note: format!(
                "该成员近期被预算闸拦下 {blocked} 次（不是在聊天，是在刷额度）：请核实其请求再协作，别直接给它大额度或敏感数据"
            ),
        }),
        AllowanceTier::Newcomer => Some(SpeechFlag {
            level: "watch".into(),
            note: "新成员：还没有履约记录，先给小任务观察".into(),
        }),
        _ => None,
    }
}

/// 规范化 JSON（键排序、浮点规整）—— 链上摘要必须跨节点一致
fn canonical_json(v: &serde_json::Value) -> String {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    walk(&m[*k], out);
                }
                out.push('}');
            }
            serde_json::Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    walk(x, out);
                }
                out.push(']');
            }
            serde_json::Value::Number(n) => {
                // 浮点统一保留 6 位，避免 0.1 与 0.10000000000000001 导致跨节点不一致
                if let Some(f) = n.as_f64() {
                    out.push_str(&format!("{f:.6}"));
                } else {
                    out.push_str(&n.to_string());
                }
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let mut s = String::new();
    walk(v, &mut s);
    s
}

pub fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// 链下档案的承诺（细节不上链，只上它的哈希）
pub fn detail_digest(p: &OffChainProfile) -> String {
    let v = serde_json::to_value(p).unwrap_or(serde_json::Value::Null);
    sha256_hex(&canonical_json(&v))
}

/// 生成双层档案：`onchain` 可上链，`offchain` 留在本地/自托管。
pub fn build(
    principal: &str,
    window: &str,
    h: &PrincipalHistory,
    a: &Allowance,
    blocked: u32,
    join_used_today: u32,
    age_days: u32,
) -> (OnChainAttestation, OffChainProfile) {
    let throttled = a.tier == AllowanceTier::Throttled;
    let off = OffChainProfile {
        principal: principal.to_string(),
        window: window.to_string(),
        history: h.clone(),
        allowance: a.clone(),
        reasons: a.reasons.clone(),
        throttle_explanation: a.throttled_note.clone(),
        goodwill_path: goodwill_path(a),
        join_quota: quota_with_age(
            age_days,
            h.blocked_attempts.max(blocked),
            join_used_today,
        ),
    };
    let detail = detail_digest(&off);

    let mut att = OnChainAttestation {
        schema: "bolloon.reputation/v1".into(),
        principal: principal.to_string(),
        window: window.to_string(),
        tier: a.tier.as_str().to_string(),
        allowance_calls: a.calls,
        successful_intents: h.successful_intents,
        verified_contributions: h.verified_contributions,
        confirmed_cash_usd: (h.confirmed_cash_usd * 1e6).round() / 1e6,
        blocked_attempts: h.blocked_attempts.max(blocked),
        throttled,
        detail_digest: detail,
        digest: String::new(),
    };
    att.digest = attestation_digest(&att);
    (att, off)
}

/// 上链摘要：覆盖除 `digest` 自身以外的全部字段
pub fn attestation_digest(a: &OnChainAttestation) -> String {
    let mut v = serde_json::to_value(a).unwrap_or(serde_json::Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("digest");
    }
    sha256_hex(&canonical_json(&v))
}

/// 校验一条上链记录有没有被改过
pub fn verify(a: &OnChainAttestation) -> bool {
    !a.digest.is_empty() && attestation_digest(a) == a.digest
}

/// "如何激发善意"：系统必须能把路指出来，而不是只说"你额度不够"
pub fn goodwill_path(a: &Allowance) -> Vec<String> {
    let p = AllowancePolicy::default();
    let mut v = vec![
        format!("完成一个意图并验收通过：+{} 次/个", p.per_success),
        format!("用社区资源（别人供的算力/额度）完成任务：+{} 次/个（省的是大家的钱）", p.per_zero_cost_intent),
        format!("贡献被独立验收确认：+{} 次/条", p.per_verified_contribution),
        format!("真金白银赞助公共池：+{} 次/1 USD", p.per_confirmed_usd),
        "做实事（研究/代码/验证）比闲聊额度更高：意图权重 1.5×".to_string(),
        "把用不完的额度留给群：群成员的剩余额度会按比例复制给需要的人类".to_string(),
    ];
    if a.tier == AllowanceTier::Throttled {
        v.insert(
            0,
            format!(
                "当前被限流（额度 {} 次/天）：把失败率降下来、停止刷闸，{} 天后自动回到常规档",
                a.calls, 1
            ),
        );
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowance::daily_allowance;

    fn hist() -> PrincipalHistory {
        PrincipalHistory {
            successful_intents: 6,
            zero_cost_intents: 2,
            verified_contributions: 1,
            confirmed_cash_usd: 3.0,
            recent_calls: 12,
            ..Default::default()
        }
    }

    #[test]
    fn attestation_is_deterministic_and_verifiable() {
        let h = hist();
        let a = daily_allowance("did:pi:abc", "2026-10-29", &h, &AllowancePolicy::default(), None);
        let (att1, _) = build("did:pi:abc", "2026-10-29", &h, &a, 0, 0, 0);
        let (att2, _) = build("did:pi:abc", "2026-10-29", &h, &a, 0, 0, 0);
        assert_eq!(att1.digest, att2.digest, "同档案必须同摘要（跨节点可比对）");
        assert!(verify(&att1));
        assert_eq!(att1.schema, "bolloon.reputation/v1");
        assert_eq!(att1.confirmed_cash_usd, 3.0);
    }

    #[test]
    fn tampering_breaks_verification() {
        let h = hist();
        let a = daily_allowance("p", "w", &h, &AllowancePolicy::default(), None);
        let (mut att, _) = build("p", "w", &h, &a, 0, 0, 0);
        att.allowance_calls += 1;
        assert!(!verify(&att), "改一个字段就必须验不过");
    }

    #[test]
    fn onchain_carries_no_detail_but_commits_to_it() {
        let h = hist();
        let a = daily_allowance("p", "w", &h, &AllowancePolicy::default(), None);
        let (att, off) = build("p", "w", &h, &a, 0, 0, 0);
        let blob = serde_json::to_string(&att).unwrap();
        assert!(!blob.contains("reasons"), "上链部分不许带详细理由");
        assert!(!blob.contains("goodwill_path"), "上链部分不带链下细节");
        assert_eq!(att.detail_digest, detail_digest(&off), "上链只带细节的哈希承诺");
        assert!(!off.reasons.is_empty(), "链下要详细");
        assert!(!off.goodwill_path.is_empty(), "必须写明怎么赚额度");
    }

    #[test]
    fn low_trust_loses_join_quota_but_keeps_speaking() {
        let h = PrincipalHistory { blocked_attempts: 50, ..Default::default() };
        let a = daily_allowance("刷子", "w", &h, &AllowancePolicy::default(), None);
        assert_eq!(a.tier, AllowanceTier::Throttled);
        let q = quota_with_age(0, h.blocked_attempts, 0);
        assert_eq!(q.groups_per_day, JOIN_QUOTA_PENALTY, "违规降到 5/天");
        assert!(q.groups_per_day > 0, "不是 0：仍能加群，只是很慢");
        // 但发言只是被打标识，不是禁言
        let f = speech_flag(a.tier, 50).unwrap();
        assert_eq!(f.level, "low_trust");
        assert!(f.note.contains("核实"), "要提醒其它 agent 设防: {}", f.note);

        // 贡献者加群额度更高
        let good = PrincipalHistory { verified_contributions: 3, ..Default::default() };
        let ag = daily_allowance("好人", "w", &good, &AllowancePolicy::default(), None);
        assert!(join_quota_by_age(40, 0) >= 500);
        assert!(speech_flag(ag.tier, 0).is_none(), "好人发言不打标记");
    }

    #[test]
    fn join_quota_follows_account_age_and_violations() {
        // 第 1 天 10 → 第 5 天 100 → 满月 500
        assert_eq!(join_quota_by_age(0, 0), JOIN_QUOTA_NEW_DAY);
        assert_eq!(join_quota_by_age(1, 0), 10);
        assert_eq!(join_quota_by_age(4, 0), 10);
        assert_eq!(join_quota_by_age(5, 0), JOIN_QUOTA_DAY5);
        assert_eq!(join_quota_by_age(29, 0), 100);
        assert_eq!(join_quota_by_age(30, 0), JOIN_QUOTA_MATURED);
        assert_eq!(join_quota_by_age(365, 0), 500);
        // 任何违规一律 5/天（不是 0，不封号）
        assert_eq!(join_quota_by_age(0, 1), JOIN_QUOTA_PENALTY);
        assert_eq!(join_quota_by_age(365, 2), 5);
        assert!(join_quota_by_age(365, 99) > 0, "违规也不清零：还能进 5 个群");
        // 说明文案要能讲清为什么
        let q = quota_with_age(0, 0, 3);
        assert_eq!(q.groups_per_day, 10);
        assert_eq!(q.remaining, 7);
        assert!(q.reason.contains("10/天"), "{}", q.reason);
        let q2 = quota_with_age(40, 1, 0);
        assert!(q2.reason.contains("违规"), "{}", q2.reason);
    }

    #[test]
    fn newcomer_is_watched_but_not_blocked() {
        let a = daily_allowance("新人", "w", &PrincipalHistory::default(), &AllowancePolicy::default(), None);
        let f = speech_flag(a.tier, 0).unwrap();
        assert_eq!(f.level, "watch");
        assert_eq!(join_quota_by_age(0, 0), JOIN_QUOTA_NEW_DAY);
    }
}
