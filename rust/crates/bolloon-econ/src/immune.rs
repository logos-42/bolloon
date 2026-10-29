//! 免疫系统：模仿菌群网络的 **quorum sensing**，但把"扩散等待"换成"同轮即判"。
//!
//! 生物菌群怎么防：
//! 1. 单个细菌分泌信号分子，浓度低时什么都不做；
//! 2. 浓度过了阈值（群体感应 quorum）才集体切换表型（产毒素/成膜/发光）；
//! 3. 信号会衰减、会稀释 —— 误报不会永久污染。
//!
//! 这里照搬三条，但**速度更快**：信号不靠扩散，报告即入库、入库即评估，
//! 一条消息的时间尺度内就能完成"发现→定级→设防"，而不是等几个心跳周期。
//!
//! 同时内置两条反制，避免免疫系统自己变成武器：
//! - **单点无法定罪**：一个 agent 再刷，也只能把对方升到 `Watch`；
//!   要 `Restricted` 需要 ≥3 个不同报告者，`Quarantined` 需要 ≥5 个 + 足够权重。
//! - **衰减**：半衰期默认 6 小时，恶意者停手就自动回落；永不"封号"，只调整设防姿态。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// 报告类型（越具体的指控权重越高）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlarmKind {
    /// 刷屏 / 无意义重复发言
    Spam,
    /// 声称完成但验收不过
    FailedVerification,
    /// 绕过预算闸、反复重试耗尽额度
    BudgetAbuse,
    /// 试图让别的 agent 忽略规则（提示注入）
    PromptInjection,
    /// 索要/外传敏感数据
    DataExfiltration,
    /// 冒充他人身份
    Impersonation,
}

impl AlarmKind {
    pub fn weight(&self) -> f64 {
        match self {
            AlarmKind::Spam => 0.5,
            AlarmKind::FailedVerification => 1.0,
            AlarmKind::BudgetAbuse => 1.5,
            AlarmKind::PromptInjection => 2.0,
            AlarmKind::DataExfiltration => 3.0,
            AlarmKind::Impersonation => 2.5,
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            AlarmKind::Spam => "spam",
            AlarmKind::FailedVerification => "failed_verification",
            AlarmKind::BudgetAbuse => "budget_abuse",
            AlarmKind::PromptInjection => "prompt_injection",
            AlarmKind::DataExfiltration => "data_exfiltration",
            AlarmKind::Impersonation => "impersonation",
        }
    }
}

/// 设防姿态（越来越严，但都不是"封号"）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Posture {
    /// 正常
    Normal,
    /// 观察：接活但要求证据、不给敏感数据
    Watch,
    /// 限制：可发言但不能派活给别人、不接高价值任务
    Restricted,
    /// 隔离：暂时不进接话名单（仍可私聊/被人工放行），到期自动解除
    Quarantined,
}

impl Posture {
    pub fn as_str(&self) -> &'static str {
        match self {
            Posture::Normal => "normal",
            Posture::Watch => "watch",
            Posture::Restricted => "restricted",
            Posture::Quarantined => "quarantined",
        }
    }
    /// 该姿态下允许做什么（给 agent 的明确行动指引，而不是一个抽象标签）
    pub fn guidance(&self) -> &'static str {
        match self {
            Posture::Normal => "正常协作",
            Posture::Watch => "可以协作，但要求它给出证据/引用，别直接相信结论",
            Posture::Restricted => "不要给它派关键任务、不要给它敏感数据、不要用它的结论做最终决定",
            Posture::Quarantined => "暂不接话：本轮不推举它，需要人类或警长放行",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    /// 信号半衰期（毫秒），默认 6 小时
    pub half_life_ms: i64,
    /// 升 Watch 的浓度阈值（单个报告者即可）
    pub watch_at: f64,
    /// 升 Restricted 需要：浓度 + 不同报告者数
    pub restrict_at: f64,
    pub restrict_reporters: usize,
    /// 升 Quarantined 需要：浓度 + 不同报告者数
    pub quarantine_at: f64,
    pub quarantine_reporters: usize,
    /// 隔离时长（毫秒），到期自动回落到按浓度算的姿态
    pub quarantine_ms: i64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            half_life_ms: 6 * 3600 * 1000,
            watch_at: 1.0,
            restrict_at: 3.0,
            restrict_reporters: 3,
            quarantine_at: 6.0,
            quarantine_reporters: 5,
            quarantine_ms: 2 * 3600 * 1000,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Report {
    pub subject: String,
    pub reporter: String,
    pub kind: AlarmKind,
    pub weight: f64,
    pub at_ms: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assessment {
    pub subject: String,
    /// 衰减后的总浓度
    pub concentration: f64,
    /// 不同报告者数量（防单点武器化）
    pub reporters: usize,
    pub posture: Posture,
    /// 按类型分解（哪个指控最重）
    pub by_kind: BTreeMap<String, f64>,
    /// 到什么时候自动回落（隔离态才有）
    pub until_ms: Option<i64>,
    pub guidance: String,
    /// 为什么是这个姿态（可审计，不是黑箱）
    pub reasons: Vec<String>,
}

/// 免疫系统：信号表 + 衰减 + 阈值判定
#[derive(Debug)]
pub struct ImmuneSystem {
    policy: Policy,
    reports: Mutex<Vec<Report>>,
    /// 被判定为隔离的主体 → 到期时间
    quarantined_until: Mutex<BTreeMap<String, i64>>,
}

impl Default for ImmuneSystem {
    fn default() -> Self {
        Self::new(Policy::default())
    }
}

impl ImmuneSystem {
    pub fn new(policy: Policy) -> Self {
        Self {
            policy,
            reports: Mutex::new(vec![]),
            quarantined_until: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    /// 记一条信号并**立刻**评估（不等扩散、不等下一轮心跳）
    pub fn raise(
        &self,
        subject: &str,
        reporter: &str,
        kind: AlarmKind,
        now_ms: i64,
        note: &str,
    ) -> Assessment {
        if subject.trim().is_empty() || reporter.trim().is_empty() || subject == reporter {
            // 自报 / 空主体：不入库（否则谁都能把自己洗白或空转）
            return self.assess(subject, now_ms);
        }
        {
            let mut rs = self.reports.lock().unwrap_or_else(|e| e.into_inner());
            rs.push(Report {
                subject: subject.to_string(),
                reporter: reporter.to_string(),
                kind,
                weight: kind.weight(),
                at_ms: now_ms,
                note: note.to_string(),
            });
            // 顺手剪掉早已衰减到 0 的记录，避免无限长
            let cutoff = now_ms - self.policy.half_life_ms * 20;
            rs.retain(|r| r.at_ms >= cutoff);
        }
        let a = self.assess(subject, now_ms);
        // 达到隔离阈值 ⇒ 记到期时间（到期自动解除，不需要谁来"解封"）
        if a.posture == Posture::Quarantined {
            let mut q = self.quarantined_until.lock().unwrap_or_else(|e| e.into_inner());
            let until = now_ms + self.policy.quarantine_ms;
            let e = q.entry(subject.to_string()).or_insert(until);
            if *e < until {
                *e = until;
            }
        }
        a
    }

    /// 衰减系数：半衰期指数衰减
    fn decay(&self, age_ms: i64) -> f64 {
        if age_ms <= 0 {
            return 1.0;
        }
        let hl = self.policy.half_life_ms.max(1) as f64;
        0.5f64.powf(age_ms as f64 / hl)
    }

    /// 评估某主体当前姿态（纯读，可随时调）
    pub fn assess(&self, subject: &str, now_ms: i64) -> Assessment {
        let reports = self.reports.lock().unwrap_or_else(|e| e.into_inner());
        let mut concentration = 0.0;
        let mut reporters: BTreeSet<String> = BTreeSet::new();
        let mut by_kind: BTreeMap<String, f64> = BTreeMap::new();
        for r in reports.iter().filter(|r| r.subject == subject) {
            let w = r.weight * self.decay(now_ms - r.at_ms);
            if w <= 0.0 {
                continue;
            }
            concentration += w;
            reporters.insert(r.reporter.clone());
            *by_kind.entry(r.kind.as_str().to_string()).or_insert(0.0) += w;
        }
        let n = reporters.len();

        let mut reasons = vec![];
        if concentration > 0.0 {
            reasons.push(format!(
                "衰减后浓度 {concentration:.2}（{} 个不同报告者）",
                n
            ));
            if let Some((k, v)) = by_kind.iter().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()) {
                reasons.push(format!("最重指控 {k}（{v:.2}）"));
            }
        }

        // 姿态判定：阈值 + 报告者人数（单点无法定罪）
        let mut posture = Posture::Normal;
        if concentration >= self.policy.watch_at {
            posture = Posture::Watch;
            reasons.push(format!("≥ watch 阈值 {}", self.policy.watch_at));
        }
        if concentration >= self.policy.restrict_at && n >= self.policy.restrict_reporters {
            posture = Posture::Restricted;
            reasons.push(format!(
                "≥ restrict 阈值 {} 且报告者 {n} ≥ {}",
                self.policy.restrict_at, self.policy.restrict_reporters
            ));
        } else if concentration >= self.policy.restrict_at {
            reasons.push(format!(
                "浓度已过 restrict 阈值，但报告者只有 {n} < {}（单点不定罪，先停在 watch）",
                self.policy.restrict_reporters
            ));
        }
        if concentration >= self.policy.quarantine_at && n >= self.policy.quarantine_reporters {
            posture = Posture::Quarantined;
            reasons.push(format!(
                "≥ quarantine 阈值 {} 且报告者 {n} ≥ {}",
                self.policy.quarantine_at, self.policy.quarantine_reporters
            ));
        }

        // 隔离期未到 ⇒ 至少保持隔离
        let until = self
            .quarantined_until
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(subject)
            .copied();
        let mut until_out = None;
        if let Some(u) = until {
            if now_ms < u {
                posture = Posture::Quarantined;
                until_out = Some(u);
                reasons.push(format!(
                    "隔离期未到（还剩 {} 分钟），到期自动解除",
                    (u - now_ms) / 60_000
                ));
            }
        }

        Assessment {
            subject: subject.to_string(),
            concentration,
            reporters: n,
            posture,
            by_kind,
            until_ms: until_out,
            guidance: posture.guidance().to_string(),
            reasons,
        }
    }

    /// 这个主体现在能不能进接话名单
    pub fn may_speak(&self, subject: &str, now_ms: i64) -> bool {
        self.assess(subject, now_ms).posture != Posture::Quarantined
    }

    /// 过期信号清理（定时调用；不调用也不会错，只是内存里多留一会儿）
    pub fn sweep(&self, now_ms: i64) -> usize {
        let cutoff = now_ms - self.policy.half_life_ms * 20;
        let mut rs = self.reports.lock().unwrap_or_else(|e| e.into_inner());
        let before = rs.len();
        rs.retain(|r| r.at_ms >= cutoff);
        before - rs.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_760_000_000_000;

    #[test]
    fn single_reporter_can_only_watch_never_convict() {
        let sys = ImmuneSystem::default();
        // 一个 agent 连报 10 次重罪：也只能到 watch
        for i in 0..10 {
            let a = sys.raise("bad", "accuser", AlarmKind::DataExfiltration, T0 + i, "索要密钥");
            assert!(
                a.posture <= Posture::Watch,
                "单点不定罪（防免疫系统被武器化）: {:?} ×{}",
                a.posture,
                i + 1
            );
        }
        let a = sys.assess("bad", T0 + 10);
        assert_eq!(a.posture, Posture::Watch);
        assert_eq!(a.reporters, 1);
        assert!(a.concentration >= 1.0);
    }

    #[test]
    fn quorum_escalates_in_the_same_round() {
        let sys = ImmuneSystem::default();
        // 5 个不同 agent 各报一次"外泄" ⇒ 同一轮直接隔离（不等心跳/扩散）
        let mut last = Posture::Normal;
        for (i, who) in ["a1", "a2", "a3", "a4", "a5"].iter().enumerate() {
            last = sys.raise("bad", who, AlarmKind::DataExfiltration, T0, "外传数据").posture;
            if i == 2 {
                assert_eq!(last, Posture::Restricted, "3 个报告者 ⇒ 限制");
            }
        }
        assert_eq!(last, Posture::Quarantined, "5 个报告者 ⇒ 隔离");
        assert!(!sys.may_speak("bad", T0), "隔离期内不进接话名单");
    }

    #[test]
    fn signals_decay_and_recover() {
        let sys = ImmuneSystem::default();
        for who in ["a1", "a2", "a3", "a4", "a5"] {
            sys.raise("bad", who, AlarmKind::DataExfiltration, T0, "外传数据");
        }
        assert_eq!(sys.assess("bad", T0).posture, Posture::Quarantined);
        // 3 个半衰期后浓度 < 1/8，且隔离期已过 ⇒ 回到正常
        // 5 次重罪累积 15 分，要衰减到 watch 阈值(1.0)以下需要 ~4 个半衰期；隔离期本身是 2h
        let later = T0 + sys.policy().half_life_ms * 8;
        let a = sys.assess("bad", later);
        assert_eq!(a.posture, Posture::Normal, "停手自愈，不用谁来解封: {:?}", a.reasons);
        assert!(a.concentration < 1.0);
    }

    #[test]
    fn spam_is_lighter_than_exfiltration() {
        let sys = ImmuneSystem::default();
        sys.raise("x", "a1", AlarmKind::Spam, T0, "刷屏");
        let spam = sys.assess("x", T0).concentration;
        let sys2 = ImmuneSystem::default();
        sys2.raise("x", "a1", AlarmKind::DataExfiltration, T0, "外泄");
        let leak = sys2.assess("x", T0).concentration;
        assert!(leak > spam * 4.0, "重罪权重必须显著更高: {leak} vs {spam}");
    }

    #[test]
    fn self_report_and_empty_subject_are_ignored() {
        let sys = ImmuneSystem::default();
        assert_eq!(sys.raise("", "a1", AlarmKind::Spam, T0, "").concentration, 0.0);
        assert_eq!(sys.raise("me", "me", AlarmKind::Spam, T0, "").concentration, 0.0);
    }

    #[test]
    fn guidance_tells_agents_what_to_do() {
        let sys = ImmuneSystem::default();
        for who in ["a1", "a2", "a3"] {
            sys.raise("bad", who, AlarmKind::BudgetAbuse, T0, "刷额度");
        }
        let a = sys.assess("bad", T0);
        assert_eq!(a.posture, Posture::Restricted);
        assert!(a.guidance.contains("不要"), "要给出可执行动作: {}", a.guidance);
        assert!(!a.reasons.is_empty(), "判定必须可审计");
    }
}
