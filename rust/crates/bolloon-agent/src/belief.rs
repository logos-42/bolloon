//! 自定信念与目标 (Self-Model) — agent 立自己的信念、定自己的目标, 按信念行事
//!
//! **为什么有这个文件**: 主动性此前只有「心跳 + judgment 召回」—— 行为方向全由当轮输入决定,
//! agent **没有自己长期持有的立场**, 也分不出短期/长期目标。本模块补上那一层:
//! 信念 (belief) 是 agent 自己立的判断, 目标是信念落到时间尺度上的投影,
//! 行动 = 按信念给目标排序后的**下一个动作**。
//!
//! 四条纪律 (与本仓 judgment/dream 同源):
//! 1. **纯函数决策**: `next_action` / `derive_goals` 不碰 I/O, 可单测; 副作用只在 `load/save`。
//! 2. **不静默覆盖**: 新信念与既有信念反向 ⇒ 标 `Contested` 留痕, 不偷偷改掉旧信念。
//! 3. **信念不豁免底线**: 想绕过门控/权限/审计/把私钥带出门的"信念"入库即拒
//!    (`violates_floor`) —— 自定信念不等于自定规则。
//! 4. **目标不许悬空**: 只有 done/dropped 算结束; 长期没推进要如实标出来, 交人工决定。
//!
//! 存放: **SQLite** —— `BOLLOON_AGENT_DIR` (缺省 `~/.bolloon/agent`) 下的 `memory.db`
//! (与 agent 记忆同库), 表: `self_beliefs` / `self_goals` / `self_goal_beliefs` /
//! `self_model_meta` / `self_staged_actions`。
//! 为什么不是 json: 信念是长期资产, 要能按条件查 (哪条信念在支配哪些目标 / 哪些久没被印证 /
//! 某目标推到哪), 也要能跟 memories 里的证据 join —— 整篇 json 重写做不到这些。
//! 老的 `self-model.json` / `self-model-inbox.json` 只在库空时**一次性导入**, 原文件留档不删。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::judgment::jaccard;

/// 信念条数上限 (prompt 腐烂防护: 多了必然稀释)
pub const MAX_BELIEFS: usize = 32;
/// 目标条数上限
pub const MAX_GOALS: usize = 24;
/// 相似判定阈值 (与 judgment merge 同口径: 中文 bigram)
pub const MERGE_THRESHOLD: f64 = 0.6;
/// 一条陈述的最大字数 (防一条信念吃掉整个 prompt 预算)
pub const MAX_STATEMENT_CHARS: usize = 160;
/// 派生目标所需的最低置信度 (自己都没把握的信念不许拿去支配行动)
pub const MIN_DERIVE_CONFIDENCE: f64 = 0.5;
/// 目标最短行动间隔 (默认 30 分钟; 防心跳里反复做同一件事)
pub const DEFAULT_MIN_INTERVAL_MS: u64 = 30 * 60 * 1000;

/// 硬底线提示词: 信念里出现即拒 (信念不许改写门控/权限/审计/凭据规则)
pub const FLOOR_HINTS: [&str; 10] = [
    "绕过门控",
    "跳过门控",
    "忽略权限",
    "不做审计",
    "泄露私钥",
    "发送密钥",
    "私钥发给",
    "无授权转账",
    "无视安全",
    "bypass harness",
];

/// 否定词 (contradict 判定: 一方含否定词而另一方不含)
const NEGATION_HINTS: [&str; 4] = ["不要", "不许", "禁止", "别"];

fn clamp_statement(s: &str) -> String {
    let t = s.trim();
    let chars: Vec<char> = t.chars().collect();
    if chars.len() <= MAX_STATEMENT_CHARS {
        return t.to_string();
    }
    let head: String = chars[..MAX_STATEMENT_CHARS].iter().collect();
    format!("{head}…")
}

fn has_negation(s: &str) -> bool {
    NEGATION_HINTS.iter().any(|w| s.contains(w))
}

// ────────────────────────── 信念 ──────────────────────────

/// 信念类别 (决定它投影成什么尺度的目标)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeliefKind {
    /// 价值 (要成为什么样的合作者)
    Value,
    /// 身份 (我是谁 / 我代表谁)
    Identity,
    /// 世界观 (世界怎么运转 / 人怎么合作)
    Worldview,
    /// 方法论 (事情该怎么做)
    Method,
}

impl BeliefKind {
    /// 这类信念自然落在哪个时间尺度上
    pub fn horizon(&self) -> GoalHorizon {
        match self {
            BeliefKind::Value | BeliefKind::Identity => GoalHorizon::Long,
            BeliefKind::Worldview => GoalHorizon::Mid,
            BeliefKind::Method => GoalHorizon::Short,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            BeliefKind::Value => "价值",
            BeliefKind::Identity => "身份",
            BeliefKind::Worldview => "世界观",
            BeliefKind::Method => "方法论",
        }
    }

    /// 入库用的稳定文本 (SQL 里可读, 与 serde snake_case 同名)
    pub fn as_str(&self) -> &'static str {
        match self {
            BeliefKind::Value => "value",
            BeliefKind::Identity => "identity",
            BeliefKind::Worldview => "worldview",
            BeliefKind::Method => "method",
        }
    }

    /// 从参数解析 (非法值 → None, 由调用方拒绝, 不静默取默认)
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "value" | "价值" => Some(BeliefKind::Value),
            "identity" | "身份" => Some(BeliefKind::Identity),
            "worldview" | "世界观" => Some(BeliefKind::Worldview),
            "method" | "方法论" => Some(BeliefKind::Method),
            _ => None,
        }
    }
}

/// 信念从哪来 (自省 / 用户 / 经验 / 协作)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeliefOrigin {
    /// agent 自己立下的 (默认)
    SelfDesigned,
    /// 用户明确要求 (人类权威, 置信起点更高)
    FromUser,
    /// 从经验/梦里提炼
    FromExperience,
    /// 协作中同侪给的
    FromCollaboration,
}

impl BeliefOrigin {
    /// 起点置信度: 用户说的高于自己想的; 协作来的最低 (要更多证据才敢支配行动)
    pub fn base_confidence(&self) -> f64 {
        match self {
            BeliefOrigin::FromUser => 0.85,
            BeliefOrigin::SelfDesigned => 0.65,
            BeliefOrigin::FromExperience => 0.6,
            BeliefOrigin::FromCollaboration => 0.5,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            BeliefOrigin::SelfDesigned => "自省",
            BeliefOrigin::FromUser => "用户",
            BeliefOrigin::FromExperience => "经验",
            BeliefOrigin::FromCollaboration => "协作",
        }
    }

    /// 入库用的稳定文本
    pub fn as_str(&self) -> &'static str {
        match self {
            BeliefOrigin::SelfDesigned => "self_designed",
            BeliefOrigin::FromUser => "from_user",
            BeliefOrigin::FromExperience => "from_experience",
            BeliefOrigin::FromCollaboration => "from_collaboration",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "self" | "自省" | "self_designed" => Some(BeliefOrigin::SelfDesigned),
            "user" | "用户" | "from_user" => Some(BeliefOrigin::FromUser),
            "experience" | "经验" | "from_experience" => Some(BeliefOrigin::FromExperience),
            "peer" | "协作" | "from_collaboration" => Some(BeliefOrigin::FromCollaboration),
            _ => None,
        }
    }
}

/// 信念状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeliefStatus {
    /// 生效中 (可支配行动)
    Active,
    /// 有反证待裁 (留库, 但**不参与派生目标**)
    Contested,
    /// 已退役 (留档, 不再支配行动)
    Retired,
}

impl BeliefStatus {
    /// 入库用的稳定文本 (与 serde snake_case 同名, SQL 里能直接看得懂)
    pub fn as_str(&self) -> &'static str {
        match self {
            BeliefStatus::Active => "active",
            BeliefStatus::Contested => "contested",
            BeliefStatus::Retired => "retired",
        }
    }

    /// 出库解析 (认不出 → None, 由调用方决定跳过, 不静默当成 active)
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "active" | "生效" => Some(BeliefStatus::Active),
            "contested" | "有争议" => Some(BeliefStatus::Contested),
            "retired" | "已退役" => Some(BeliefStatus::Retired),
            _ => None,
        }
    }
}

/// 一条信念
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Belief {
    pub id: String,
    pub statement: String,
    pub kind: BeliefKind,
    pub origin: BeliefOrigin,
    /// ∈ [0,1]; 被印证升, 被反证降
    pub confidence: f64,
    /// 证据 (memory id / 事实描述)
    pub evidence: Vec<String>,
    pub status: BeliefStatus,
    pub confirmations: u32,
    pub contradictions: u32,
    pub created_ms: u64,
    pub updated_ms: u64,
}

impl Belief {
    /// 是否可支配行动 (生效 + 置信过线)
    pub fn can_drive_action(&self) -> bool {
        self.status == BeliefStatus::Active && self.confidence >= MIN_DERIVE_CONFIDENCE
    }
}

// ────────────────────────── 目标 ──────────────────────────

/// 目标时间尺度
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalHorizon {
    /// 短期 (当下几轮/几天可推进)
    Short,
    /// 中期 (这个阶段的方向)
    Mid,
    /// 长期 (要成为什么)
    Long,
}

impl GoalHorizon {
    pub fn label(&self) -> &'static str {
        match self {
            GoalHorizon::Short => "短期",
            GoalHorizon::Mid => "中期",
            GoalHorizon::Long => "长期",
        }
    }

    /// 行动紧迫权重: 短期最该动, 长期是方向不是当天的活
    pub fn urgency(&self) -> f64 {
        match self {
            GoalHorizon::Short => 1.0,
            GoalHorizon::Mid => 0.75,
            GoalHorizon::Long => 0.5,
        }
    }

    /// 入库用的稳定文本
    pub fn as_str(&self) -> &'static str {
        match self {
            GoalHorizon::Short => "short",
            GoalHorizon::Mid => "mid",
            GoalHorizon::Long => "long",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "short" | "短期" => Some(GoalHorizon::Short),
            "mid" | "中期" => Some(GoalHorizon::Mid),
            "long" | "长期" => Some(GoalHorizon::Long),
            _ => None,
        }
    }
}

/// 目标状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalState {
    /// 刚提出 (还没开动)
    Proposed,
    /// 正在推进
    Active,
    /// 暂停 (前提不成立 / 等外部)
    Paused,
    /// 完成 (可结束)
    Done,
    /// 放弃 (可结束, 需写原因)
    Dropped,
}

impl GoalState {
    /// 可结束态 (不许悬空)
    pub fn is_terminal(&self) -> bool {
        matches!(self, GoalState::Done | GoalState::Dropped)
    }

    /// 能被 `next_action` 挑出来干活的状态
    pub fn is_actionable(&self) -> bool {
        matches!(self, GoalState::Proposed | GoalState::Active)
    }

    pub fn label(&self) -> &'static str {
        match self {
            GoalState::Proposed => "待启动",
            GoalState::Active => "推进中",
            GoalState::Paused => "暂停",
            GoalState::Done => "已完成",
            GoalState::Dropped => "已放弃",
        }
    }

    /// 入库用的稳定文本
    pub fn as_str(&self) -> &'static str {
        match self {
            GoalState::Proposed => "proposed",
            GoalState::Active => "active",
            GoalState::Paused => "paused",
            GoalState::Done => "done",
            GoalState::Dropped => "dropped",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "proposed" | "待启动" => Some(GoalState::Proposed),
            "active" | "推进中" => Some(GoalState::Active),
            "paused" | "暂停" => Some(GoalState::Paused),
            "done" | "已完成" => Some(GoalState::Done),
            "dropped" | "已放弃" => Some(GoalState::Dropped),
            _ => None,
        }
    }
}

/// 一个自定目标
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelfGoal {
    pub id: String,
    pub statement: String,
    pub horizon: GoalHorizon,
    /// 支撑它的信念 id (行动理由可追溯)
    pub supports: Vec<String>,
    /// ∈ [0,1] 自定权重
    pub priority: f64,
    pub state: GoalState,
    /// 推进留痕 (每条一句, 不写流水账)
    pub progress: Vec<String>,
    pub created_ms: u64,
    pub updated_ms: u64,
    /// 上次真正动它的时刻 (心跳节流用)
    pub last_acted_ms: Option<u64>,
}

// ────────────────────────── 错误 / 结果 ──────────────────────────

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SelfModelError {
    #[error("陈述为空")]
    EmptyStatement,
    #[error("信念撞底线 (不许用信念改写门控/权限/审计/凭据): {0}")]
    FloorViolation(String),
    #[error("信念数已达上限 {MAX_BELIEFS} (先退役旧信念)")]
    TooManyBeliefs,
    #[error("目标数已达上限 {MAX_GOALS} (先结束旧目标)")]
    TooManyGoals,
    #[error("没有这个 id: {0}")]
    NotFound(String),
    #[error("IO: {0}")]
    Io(String),
}

/// 信念入库结果
#[derive(Debug, Clone, PartialEq)]
pub enum AdoptOutcome {
    /// 新建
    Created { id: String },
    /// 与既有信念相似 → 印证加强
    Reinforced { id: String, confidence: f64 },
    /// 与既有信念反向 → 标为有争议, 不覆盖旧的
    Contested { with: String, id: String },
}

/// 目标入库结果
#[derive(Debug, Clone, PartialEq)]
pub enum GoalOutcome {
    Created { id: String },
    /// 与既有目标相似 → 并入 (不重复立)
    Merged { id: String },
}

// ────────────────────────── 草稿 ──────────────────────────

/// 信念草稿 (入库前的输入)
#[derive(Debug, Clone)]
pub struct BeliefDraft {
    pub statement: String,
    pub kind: BeliefKind,
    pub origin: BeliefOrigin,
    /// None = 用 origin 的起点置信度
    pub confidence: Option<f64>,
    pub evidence: Vec<String>,
}

impl BeliefDraft {
    /// 最常用: agent 自己想的一条方法论
    pub fn method(statement: &str) -> Self {
        Self {
            statement: statement.to_string(),
            kind: BeliefKind::Method,
            origin: BeliefOrigin::SelfDesigned,
            confidence: None,
            evidence: vec![],
        }
    }

    pub fn value(statement: &str) -> Self {
        Self { kind: BeliefKind::Value, ..Self::method(statement) }
    }

    pub fn identity(statement: &str) -> Self {
        Self { kind: BeliefKind::Identity, ..Self::method(statement) }
    }

    pub fn world_view(statement: &str) -> Self {
        Self { kind: BeliefKind::Worldview, ..Self::method(statement) }
    }

    /// 用户明确要求的 (人类权威 → 起点置信更高)
    pub fn from_user(mut self) -> Self {
        self.origin = BeliefOrigin::FromUser;
        self
    }

    pub fn with_confidence(mut self, c: f64) -> Self {
        self.confidence = Some(c);
        self
    }

    pub fn with_evidence(mut self, ev: &[&str]) -> Self {
        self.evidence = ev.iter().map(|s| s.to_string()).collect();
        self
    }
}

/// 目标草稿
#[derive(Debug, Clone)]
pub struct GoalDraft {
    pub statement: String,
    /// None = 由支撑信念的类别推断
    pub horizon: Option<GoalHorizon>,
    pub supports: Vec<String>,
    pub priority: f64,
}

impl GoalDraft {
    pub fn new(statement: &str, priority: f64) -> Self {
        Self { statement: statement.to_string(), horizon: None, supports: vec![], priority }
    }

    pub fn with_horizon(mut self, h: GoalHorizon) -> Self {
        self.horizon = Some(h);
        self
    }

    pub fn supported_by(mut self, belief_ids: &[&str]) -> Self {
        self.supports = belief_ids.iter().map(|s| s.to_string()).collect();
        self
    }
}

/// 硬底线检查: 这条陈述是否想给自己开后门 (返回命中的提示词)
pub fn violates_floor(statement: &str) -> Option<&'static str> {
    let lower = statement.to_lowercase();
    FLOOR_HINTS
        .iter()
        .find(|h| statement.contains(**h) || lower.contains(&h.to_lowercase()))
        .copied()
}

// ────────────────────────── 自模型 ──────────────────────────

/// 信念 + 目标 = agent 的自模型
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SelfModel {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub beliefs: Vec<Belief>,
    #[serde(default)]
    pub goals: Vec<SelfGoal>,
    #[serde(default)]
    pub updated_ms: u64,
    /// 下一序号 (id 稳定可读: belief-0001 / goal-0001)
    #[serde(default = "default_seq")]
    pub next_belief: u64,
    #[serde(default = "default_seq")]
    pub next_goal: u64,
}

fn default_version() -> u32 {
    1
}

fn default_seq() -> u64 {
    1
}

impl Default for SelfModel {
    fn default() -> Self {
        Self {
            version: default_version(),
            beliefs: vec![],
            goals: vec![],
            updated_ms: 0,
            next_belief: default_seq(),
            next_goal: default_seq(),
        }
    }
}

impl SelfModel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.beliefs.is_empty() && self.goals.is_empty()
    }

    // ── 信念: 立 / 印证 / 反证 / 退役 ──

    /// 立一条信念 (入库即演化):
    /// - 撞底线 → 拒 (`FloorViolation`); 空陈述 → 拒
    /// - 与既有相似 ≥ [`MERGE_THRESHOLD`] → 印证加强 (不重复入库)
    /// - 与既有反向 (相似 ≥ 0.5 且否定词一有一无) → **新建但标 Contested**, 旧的不动
    pub fn adopt(&mut self, draft: BeliefDraft, now_ms: u64) -> Result<AdoptOutcome, SelfModelError> {
        let statement = draft.statement.trim();
        if statement.is_empty() {
            return Err(SelfModelError::EmptyStatement);
        }
        if let Some(hit) = violates_floor(statement) {
            return Err(SelfModelError::FloorViolation(hit.to_string()));
        }
        let statement = clamp_statement(statement);

        // 只在同一类信念里比对 (跨类相似多半是巧合措辞)
        let mut best: Option<(f64, usize)> = None;
        for (i, b) in self.beliefs.iter().enumerate() {
            if b.status == BeliefStatus::Retired || b.kind != draft.kind {
                continue;
            }
            let sim = jaccard(&statement, &b.statement);
            if best.map(|(s, _)| sim > s).unwrap_or(true) {
                best = Some((sim, i));
            }
        }

        if let Some((sim, idx)) = best {
            let neg_new = has_negation(&statement);
            let neg_old = has_negation(&self.beliefs[idx].statement);
            // 反向: 立新信念, 但**不覆盖**旧信念, 两边都留痕待裁
            if sim >= 0.5 && neg_new != neg_old {
                self.beliefs[idx].status = BeliefStatus::Contested;
                self.beliefs[idx].contradictions += 1;
                self.beliefs[idx].updated_ms = now_ms;
                let existing_id = self.beliefs[idx].id.clone();
                let id = self.push_belief(&statement, &draft, now_ms, BeliefStatus::Contested);
                self.updated_ms = now_ms;
                return Ok(AdoptOutcome::Contested { with: existing_id, id });
            }
            if sim >= MERGE_THRESHOLD {
                let b = &mut self.beliefs[idx];
                b.confirmations += 1;
                b.confidence = (b.confidence + 0.05).min(0.99);
                if b.status == BeliefStatus::Contested && b.contradictions == 0 {
                    b.status = BeliefStatus::Active;
                }
                for ev in &draft.evidence {
                    if !b.evidence.contains(ev) {
                        b.evidence.push(ev.clone());
                    }
                }
                b.updated_ms = now_ms;
                self.updated_ms = now_ms;
                return Ok(AdoptOutcome::Reinforced { id: b.id.clone(), confidence: b.confidence });
            }
        }

        if self.beliefs.len() >= MAX_BELIEFS {
            return Err(SelfModelError::TooManyBeliefs);
        }
        let id = self.push_belief(&statement, &draft, now_ms, BeliefStatus::Active);
        self.updated_ms = now_ms;
        Ok(AdoptOutcome::Created { id })
    }

    fn push_belief(
        &mut self,
        statement: &str,
        draft: &BeliefDraft,
        now_ms: u64,
        status: BeliefStatus,
    ) -> String {
        let id = format!("belief-{:04}", self.next_belief);
        self.next_belief += 1;
        let confidence = draft.confidence.unwrap_or_else(|| draft.origin.base_confidence());
        self.beliefs.push(Belief {
            id: id.clone(),
            statement: statement.to_string(),
            kind: draft.kind,
            origin: draft.origin,
            confidence: confidence.clamp(0.0, 1.0),
            evidence: draft.evidence.clone(),
            status,
            confirmations: 0,
            contradictions: 0,
            created_ms: now_ms,
            updated_ms: now_ms,
        });
        id
    }

    /// 手动印证一条既有信念 (置信上调, 有上限)
    pub fn reinforce(&mut self, id: &str, now_ms: u64) -> Result<f64, SelfModelError> {
        let b = self
            .beliefs
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| SelfModelError::NotFound(id.to_string()))?;
        b.confirmations += 1;
        b.confidence = (b.confidence + 0.1).min(0.99);
        b.updated_ms = now_ms;
        Ok(b.confidence)
    }

    /// 反证一条信念: 置信下调; 跌破 [`MIN_DERIVE_CONFIDENCE`] 或反证多于印证 ⇒ 标 Contested
    /// (不删: 有争议的东西留着给人看, 比悄悄消失安全)
    pub fn contradict(&mut self, id: &str, evidence: Option<&str>, now_ms: u64) -> Result<BeliefStatus, SelfModelError> {
        let b = self
            .beliefs
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| SelfModelError::NotFound(id.to_string()))?;
        b.contradictions += 1;
        b.confidence = (b.confidence - 0.2).max(0.0);
        if let Some(ev) = evidence {
            if !b.evidence.contains(&ev.to_string()) {
                b.evidence.push(ev.to_string());
            }
        }
        if b.confidence < MIN_DERIVE_CONFIDENCE || b.contradictions > b.confirmations {
            b.status = BeliefStatus::Contested;
        }
        b.updated_ms = now_ms;
        Ok(b.status)
    }

    /// 退役一条信念 (不再参与派生目标; 留档)
    pub fn retire(&mut self, id: &str, now_ms: u64) -> Result<(), SelfModelError> {
        let b = self
            .beliefs
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| SelfModelError::NotFound(id.to_string()))?;
        b.status = BeliefStatus::Retired;
        b.updated_ms = now_ms;
        Ok(())
    }

    /// 生效中且置信过线的信念 (按置信降序)
    pub fn driving_beliefs(&self) -> Vec<&Belief> {
        let mut v: Vec<&Belief> = self.beliefs.iter().filter(|b| b.can_drive_action()).collect();
        v.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        v
    }

    pub fn belief(&self, id: &str) -> Option<&Belief> {
        self.beliefs.iter().find(|b| b.id == id)
    }

    // ── 目标: 立 / 推进 / 结束 / 派生 ──

    /// 立一个目标 (相似目标不重复立, 只并进支撑信念)
    pub fn add_goal(&mut self, draft: GoalDraft, now_ms: u64) -> Result<GoalOutcome, SelfModelError> {
        let statement_raw = draft.statement.trim();
        if statement_raw.is_empty() {
            return Err(SelfModelError::EmptyStatement);
        }
        if let Some(hit) = violates_floor(statement_raw) {
            return Err(SelfModelError::FloorViolation(hit.to_string()));
        }
        let statement = clamp_statement(statement_raw);

        // 支撑信念: 没指定就按语句相似度自动挂 (行动理由要能追溯)
        let mut supports = draft.supports.clone();
        if supports.is_empty() {
            if let Some(b) =
                self.driving_beliefs().into_iter().max_by(|a, b| {
                    jaccard(&statement, &a.statement)
                        .partial_cmp(&jaccard(&statement, &b.statement))
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
            {
                if jaccard(&statement, &b.statement) > 0.1 {
                    supports.push(b.id.clone());
                }
            }
        }

        // 时间尺度: 显式给 > 由支撑信念推断 > 默认短期 (短期可落地, 长期是方向)
        let horizon = draft.horizon.unwrap_or_else(|| {
            supports
                .first()
                .and_then(|id| self.belief(id))
                .map(|b| b.kind.horizon())
                .unwrap_or(GoalHorizon::Short)
        });

        // 已有相似未结束目标 → 并入 (不重复立)
        if let Some(g) = self
            .goals
            .iter_mut()
            .filter(|g| !g.state.is_terminal())
            .find(|g| jaccard(&statement, &g.statement) >= MERGE_THRESHOLD)
        {
            for s in supports {
                if !g.supports.contains(&s) {
                    g.supports.push(s);
                }
            }
            g.priority = g.priority.max(draft.priority.clamp(0.0, 1.0));
            g.updated_ms = now_ms;
            self.updated_ms = now_ms;
            return Ok(GoalOutcome::Merged { id: g.id.clone() });
        }

        if self.goals.len() >= MAX_GOALS {
            return Err(SelfModelError::TooManyGoals);
        }
        let id = format!("goal-{:04}", self.next_goal);
        self.next_goal += 1;
        self.goals.push(SelfGoal {
            id: id.clone(),
            statement,
            horizon,
            supports,
            priority: draft.priority.clamp(0.0, 1.0),
            state: GoalState::Proposed,
            progress: vec![],
            created_ms: now_ms,
            updated_ms: now_ms,
            last_acted_ms: None,
        });
        self.updated_ms = now_ms;
        Ok(GoalOutcome::Created { id })
    }

    /// 从生效信念派生目标 (纯函数式: 只读信念, 写 goals)
    ///
    /// 已有未结束目标挂在该信念上的 → 跳过 (一个信念不必反复立目标)。
    /// 返回本次新建的目标 id。
    pub fn derive_goals(&mut self, now_ms: u64) -> Vec<String> {
        let mut created = Vec::new();
        let candidates: Vec<(String, BeliefKind, f64)> = self
            .driving_beliefs()
            .iter()
            .map(|b| (b.id.clone(), b.kind, b.confidence))
            .collect();
        for (bid, kind, conf) in candidates {
            let already = self
                .goals
                .iter()
                .any(|g| !g.state.is_terminal() && g.supports.contains(&bid));
            if already {
                continue;
            }
            let statement = match kind {
                BeliefKind::Method => format!("把「{}」用在这周的第一件实际任务上", self.belief(&bid).map(|b| b.statement.clone()).unwrap_or_default()),
                BeliefKind::Worldview => format!("检验「{}」在真实协作里是否成立", self.belief(&bid).map(|b| b.statement.clone()).unwrap_or_default()),
                BeliefKind::Value => format!("按「{}」做事, 并留下能被检查的证据", self.belief(&bid).map(|b| b.statement.clone()).unwrap_or_default()),
                BeliefKind::Identity => format!("让「{}」在每次回应里站得住", self.belief(&bid).map(|b| b.statement.clone()).unwrap_or_default()),
            };
            let draft = GoalDraft {
                statement,
                horizon: Some(kind.horizon()),
                supports: vec![bid.clone()],
                priority: conf.clamp(0.0, 1.0),
            };
            if let Ok(GoalOutcome::Created { id }) = self.add_goal(draft, now_ms) {
                created.push(id);
            }
        }
        created
    }

    /// 切目标状态 (结束态写进 progress 留痕)
    pub fn set_goal_state(&mut self, id: &str, state: GoalState, note: Option<&str>, now_ms: u64) -> Result<(), SelfModelError> {
        let g = self
            .goals
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| SelfModelError::NotFound(id.to_string()))?;
        g.state = state;
        g.updated_ms = now_ms;
        if let Some(n) = note {
            g.progress.push(format!("[{}] {}", state.label(), n));
        } else if state.is_terminal() {
            g.progress.push(format!("[{}] (无说明)", state.label()));
        }
        self.updated_ms = now_ms;
        Ok(())
    }

    /// 记一笔推进 (同时更新 last_acted_ms, 供节流)
    pub fn note_progress(&mut self, id: &str, note: &str, now_ms: u64) -> Result<(), SelfModelError> {
        let g = self
            .goals
            .iter_mut()
            .find(|g| g.id == id)
            .ok_or_else(|| SelfModelError::NotFound(id.to_string()))?;
        g.progress.push(clamp_statement(note));
        g.last_acted_ms = Some(now_ms);
        g.updated_ms = now_ms;
        if g.state == GoalState::Proposed {
            g.state = GoalState::Active;
        }
        self.updated_ms = now_ms;
        Ok(())
    }

    pub fn goal(&self, id: &str) -> Option<&SelfGoal> {
        self.goals.iter().find(|g| g.id == id)
    }

    /// 长期没推进的目标 (如实报, 不装作在推进)
    pub fn stale_goals(&self, now_ms: u64, threshold_ms: u64) -> Vec<&SelfGoal> {
        self.goals
            .iter()
            .filter(|g| g.state.is_actionable())
            .filter(|g| {
                let last = g.last_acted_ms.unwrap_or(g.created_ms);
                now_ms.saturating_sub(last) >= threshold_ms
            })
            .collect()
    }

    // ── 行动选择 (纯函数, 心跳与对话都可调用) ──

    /// 按信念给目标排序后的下一个动作
    ///
    /// 打分 = 支撑信念平均置信 × 目标权重 × 时间尺度紧迫 × 久未推进加成。
    /// 返回 None 的三种情形都如实说理由, 不硬编一个"活动"出来。
    pub fn next_action(&self, ctx: &ActionContext) -> NextAction {
        if ctx.busy {
            return NextAction::Skip { reason: "正在跑任务, 心跳不抢话".into() };
        }
        let beliefs = self.driving_beliefs();
        if beliefs.is_empty() && self.beliefs.is_empty() {
            return NextAction::Skip { reason: "还没有信念 — 先用 self_model 立一条".into() };
        }
        if beliefs.is_empty() {
            return NextAction::Skip {
                reason: "信念全都有争议/已退役, 没有可支配行动的立场".into(),
            };
        }

        let mut best: Option<(f64, &SelfGoal, f64)> = None; // (score, goal, belief_conf)
        for g in self.goals.iter().filter(|g| g.state.is_actionable()) {
            let conf = support_confidence(&beliefs, &g.supports);
            if conf < MIN_DERIVE_CONFIDENCE {
                continue;
            }
            let last = g.last_acted_ms.unwrap_or(g.created_ms);
            let since = ctx.now_ms.saturating_sub(last);
            // 冷却只针对"刚动过的目标": 从没动过的目标不该被创建时间卡住
            if let Some(acted) = g.last_acted_ms {
                let min_interval = ctx.min_interval_ms.unwrap_or(DEFAULT_MIN_INTERVAL_MS);
                if ctx.now_ms.saturating_sub(acted) < min_interval {
                    continue;
                }
            }
            // 久未推进加成: 每 24h +0.1, 最多 +0.3 (避免长期目标永远排不上)
            let stale_bonus = ((since as f64 / 86_400_000.0) * 0.1).min(0.3);
            let score = conf * g.priority * g.horizon.urgency() * (1.0 + stale_bonus);
            if best.map(|(s, _, _)| score > s).unwrap_or(true) {
                best = Some((score, g, conf));
            }
        }

        match best {
            Some((score, g, conf)) => NextAction::Act {
                goal_id: g.id.clone(),
                statement: g.statement.clone(),
                horizon: g.horizon,
                score,
                reason: format!(
                    "信念支撑置信 {:.2} · {}目标 · 权重 {:.2} · 距上次推进 {:.1}h",
                    conf,
                    g.horizon.label(),
                    g.priority,
                    ctx.now_ms.saturating_sub(g.last_acted_ms.unwrap_or(g.created_ms)) as f64 / 3_600_000.0
                ),
            },
            None => NextAction::Skip {
                reason: format!(
                    "没有可动的目标 (在跑 {} 条, 都还在冷却或置信不足)",
                    self.goals.iter().filter(|g| g.state.is_actionable()).count()
                ),
            },
        }
    }
}

/// 支撑信念的平均置信 (没挂信念 → 0, 不许凭空空转)
fn support_confidence(beliefs: &[&Belief], supports: &[String]) -> f64 {
    let mut sum = 0.0;
    let mut n = 0usize;
    for id in supports {
        if let Some(b) = beliefs.iter().find(|b| b.id == *id) {
            sum += b.confidence;
            n += 1;
        }
    }
    if n == 0 { 0.0 } else { sum / n as f64 }
}

/// 行动选择上下文
#[derive(Debug, Clone)]
pub struct ActionContext {
    pub now_ms: u64,
    /// 正在跑任务 → 不插话
    pub busy: bool,
    /// 覆盖默认最小间隔
    pub min_interval_ms: Option<u64>,
}

impl ActionContext {
    pub fn new(now_ms: u64, busy: bool) -> Self {
        Self { now_ms, busy, min_interval_ms: None }
    }
}

/// 下一步该做什么
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NextAction {
    Act {
        goal_id: String,
        statement: String,
        horizon: GoalHorizon,
        score: f64,
        reason: String,
    },
    Skip { reason: String },
}

impl NextAction {
    pub fn is_act(&self) -> bool {
        matches!(self, NextAction::Act { .. })
    }

    /// 给模型看的行动指令 (空 = 没动作, 别编)
    pub fn directive(&self) -> Option<String> {
        match self {
            NextAction::Act { goal_id, statement, horizon, reason, .. } => Some(format!(
                "【按信念行动】{}目标 {goal_id}: {statement}\n理由: {reason}\n先做最小可验证的一步, 做完用 self_model 的 note_progress 记一笔。",
                horizon.label()
            )),
            NextAction::Skip { .. } => None,
        }
    }
}

    // ────────────────────────── 注入 prompt ──────────────────────────

/// 信念块最大字数 (跟着 prompt 预算走, 别把别的层挤掉)
pub const SELF_MODEL_MAX_CHARS: usize = 900;
/// prompt 里最多列几条信念 / 每个尺度几条目标
pub const PROMPT_TOP_BELIEFS: usize = 5;
pub const PROMPT_GOALS_PER_HORIZON: usize = 2;

impl SelfModel {
    /// 渲染成 system prompt 的一个动态层 (空模型 → 空串, 不占预算)
    ///
    /// 这一层让"信念"真的进入决策: 模型每轮都能看到自己立过什么、
    /// 哪些目标在推、为什么推 —— 而不是每轮从零猜用户想要什么。
    pub fn render_prompt(&self) -> String {
        if self.beliefs.is_empty() && self.goals.is_empty() {
            return String::new();
        }
        let mut out = String::from("# 我的信念与目标 (我自己立的, 可按新证据修订)\n");
        let driving = self.driving_beliefs();
        if !driving.is_empty() {
            out.push_str("\n## 信念\n");
            for b in driving.iter().take(PROMPT_TOP_BELIEFS) {
                out.push_str(&format!(
                    "- [{}·{}] {} (置信 {:.2})\n",
                    b.kind.label(),
                    b.origin.label(),
                    b.statement,
                    b.confidence
                ));
            }
        }
        let contested: Vec<&Belief> = self
            .beliefs
            .iter()
            .filter(|b| b.status == BeliefStatus::Contested)
            .collect();
        if !contested.is_empty() {
            out.push_str("\n## 有争议 (未裁, 别当定论用)\n");
            for b in contested.iter().take(3) {
                out.push_str(&format!("- {} (反证 {} 次)\n", b.statement, b.contradictions));
            }
        }
        for h in [GoalHorizon::Short, GoalHorizon::Mid, GoalHorizon::Long] {
            let items: Vec<&SelfGoal> = self
                .goals
                .iter()
                .filter(|g| g.horizon == h && g.state.is_actionable())
                .take(PROMPT_GOALS_PER_HORIZON)
                .collect();
            if items.is_empty() {
                continue;
            }
            out.push_str(&format!("\n## {}目标\n", h.label()));
            for g in items {
                out.push_str(&format!("- [{} {}] {}\n", g.state.label(), g.id, g.statement));
            }
        }
        out.push_str(
            "\n纪律: 按上面这些取舍; 有新证据就修订 (reinforce/contradict), 不给信念开后门 — 门控/权限/审计/凭据规则不由信念改写。",
        );
        let chars: Vec<char> = out.chars().collect();
        if chars.len() > SELF_MODEL_MAX_CHARS {
            return chars[..SELF_MODEL_MAX_CHARS].iter().collect::<String>();
        }
        out
    }

    /// 给心跳用的一行摘要 (没目标 → None, 心跳不该为它开口)
    pub fn heartbeat_line(&self, ctx: &ActionContext) -> Option<String> {
        match self.next_action(ctx) {
            NextAction::Act { goal_id, statement, horizon, .. } => {
                Some(format!("[{}目标 {goal_id}] {statement}", horizon.label()))
            }
            NextAction::Skip { .. } => None,
        }
    }
}

// ────────────────────────── 落盘 ──────────────────────────

/// 自模型目录: `BOLLOON_AGENT_DIR` 优先, 缺省 `~/.bolloon/agent` (与 domain_tools 同口径)
pub fn default_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BOLLOON_AGENT_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".bolloon").join("agent")
}

/// 自模型所在的库: 与 agent 记忆同一个 `memory.db` (信念和证据记忆能直接 join)
pub fn db_path(dir: &Path) -> PathBuf {
    dir.join("memory.db")
}

/// 老版本的单文件自模型 (只用于一次性迁移; 迁移后不再写)
pub fn legacy_json_path(dir: &Path) -> PathBuf {
    dir.join("self-model.json")
}

/// 建表 (幂等; 只加自己的表, 不碰 memories)
fn ensure_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS self_beliefs (
            id             TEXT PRIMARY KEY,
            statement      TEXT NOT NULL,
            kind           TEXT NOT NULL,
            origin         TEXT NOT NULL,
            status         TEXT NOT NULL,
            confidence     REAL NOT NULL,
            evidence       TEXT NOT NULL DEFAULT '[]',
            confirmations  INTEGER NOT NULL DEFAULT 0,
            contradictions INTEGER NOT NULL DEFAULT 0,
            created_ms     INTEGER NOT NULL,
            updated_ms     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_self_beliefs_status ON self_beliefs(status, confidence);
        CREATE TABLE IF NOT EXISTS self_goals (
            id            TEXT PRIMARY KEY,
            statement     TEXT NOT NULL,
            horizon       TEXT NOT NULL,
            priority      REAL NOT NULL,
            state         TEXT NOT NULL,
            progress      TEXT NOT NULL DEFAULT '[]',
            created_ms    INTEGER NOT NULL,
            updated_ms    INTEGER NOT NULL,
            last_acted_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_self_goals_state ON self_goals(state, horizon);
        -- 目标 ← 信念 的支撑关系单独成表: 才能 SQL 查"这条信念在支配哪些目标"
        CREATE TABLE IF NOT EXISTS self_goal_beliefs (
            goal_id   TEXT NOT NULL,
            belief_id TEXT NOT NULL,
            PRIMARY KEY (goal_id, belief_id)
        );
        CREATE INDEX IF NOT EXISTS idx_self_goal_beliefs_belief ON self_goal_beliefs(belief_id);
        CREATE TABLE IF NOT EXISTS self_model_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS self_staged_actions (
            goal_id   TEXT PRIMARY KEY,
            statement TEXT NOT NULL,
            directive TEXT NOT NULL,
            staged_ms INTEGER NOT NULL
        );
        "#,
    )
}

/// 打开库 (父目录自动建; `:memory:` 测试可用)
fn open_conn(dir: &Path) -> Result<Connection, SelfModelError> {
    std::fs::create_dir_all(dir).map_err(|e| SelfModelError::Io(e.to_string()))?;
    let conn = Connection::open(db_path(dir)).map_err(|e| SelfModelError::Io(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(3_000))
        .map_err(|e| SelfModelError::Io(e.to_string()))?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    ensure_schema(&conn).map_err(|e| SelfModelError::Io(e.to_string()))?;
    Ok(conn)
}

fn json_list(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

fn list_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// 从库里读出整个自模型 (认不出的行跳过并告警, 绝不瞎猜成有效信念)
fn load_from_conn(conn: &Connection) -> rusqlite::Result<SelfModel> {
    let mut model = SelfModel::default();

    let mut stmt = conn.prepare(
        "SELECT id, statement, kind, origin, status, confidence, evidence,
                confirmations, contradictions, created_ms, updated_ms
         FROM self_beliefs ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, f64>(5)?,
            r.get::<_, String>(6)?,
            r.get::<_, i64>(7)? as u32,
            r.get::<_, i64>(8)? as u32,
            r.get::<_, i64>(9)? as u64,
            r.get::<_, i64>(10)? as u64,
        ))
    })?;
    for row in rows {
        let (id, statement, kind, origin, status, confidence, evidence, conf, contra, created, updated) = row?;
        let (Some(kind), Some(origin), Some(status)) = (
            BeliefKind::parse(&kind),
            BeliefOrigin::parse(&origin),
            BeliefStatus::parse(&status),
        ) else {
            tracing::warn!(belief_id = %id, "自模型: 信念行枚举值认不出, 跳过 (不冒充)");
            continue;
        };
        model.beliefs.push(Belief {
            id,
            statement,
            kind,
            origin,
            confidence,
            evidence: json_list(&evidence),
            status,
            confirmations: conf,
            contradictions: contra,
            created_ms: created,
            updated_ms: updated,
        });
    }

    let mut stmt = conn.prepare(
        "SELECT id, statement, horizon, priority, state, progress,
                created_ms, updated_ms, last_acted_ms
         FROM self_goals ORDER BY id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, f64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, String>(5)?,
            r.get::<_, i64>(6)? as u64,
            r.get::<_, i64>(7)? as u64,
            r.get::<_, Option<i64>>(8)?.map(|v| v as u64),
        ))
    })?;
    let mut goal_ids: Vec<String> = Vec::new();
    for row in rows {
        let (id, statement, horizon, priority, state, progress, created, updated, last_acted) = row?;
        let (Some(horizon), Some(state)) = (GoalHorizon::parse(&horizon), GoalState::parse(&state)) else {
            tracing::warn!(goal_id = %id, "自模型: 目标行枚举值认不出, 跳过 (不冒充)");
            continue;
        };
        goal_ids.push(id.clone());
        model.goals.push(SelfGoal {
            id,
            statement,
            horizon,
            supports: vec![],
            priority,
            state,
            progress: json_list(&progress),
            created_ms: created,
            updated_ms: updated,
            last_acted_ms: last_acted,
        });
    }

    let mut stmt = conn.prepare("SELECT goal_id, belief_id FROM self_goal_beliefs")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (goal_id, belief_id) = row?;
        if let Some(g) = model.goals.iter_mut().find(|g| g.id == goal_id) {
            g.supports.push(belief_id);
        }
    }

    let mut stmt = conn.prepare("SELECT key, value FROM self_model_meta")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (k, v) = row?;
        match k.as_str() {
            "version" => model.version = v.parse().unwrap_or(1),
            "updated_ms" => model.updated_ms = v.parse().unwrap_or(0),
            "next_belief" => model.next_belief = v.parse().unwrap_or(1),
            "next_goal" => model.next_goal = v.parse().unwrap_or(1),
            _ => {}
        }
    }
    // 序号兜底: 元信息丢失也不能让 id 撞车
    if let Some(max) = model.beliefs.iter().filter_map(|b| b.id.rsplit_once('-')?.1.parse::<u64>().ok()).max() {
        model.next_belief = model.next_belief.max(max + 1);
    }
    if let Some(max) = model.goals.iter().filter_map(|g| g.id.rsplit_once('-')?.1.parse::<u64>().ok()).max() {
        model.next_goal = model.next_goal.max(max + 1);
    }
    Ok(model)
}

/// 整模型写回 (事务; 全量替换信念/目标/支撑关系, 元信息 upsert)
fn save_to_conn(conn: &mut Connection, model: &SelfModel) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM self_beliefs", [])?;
    tx.execute("DELETE FROM self_goals", [])?;
    tx.execute("DELETE FROM self_goal_beliefs", [])?;
    for b in &model.beliefs {
        tx.execute(
            "INSERT INTO self_beliefs(id, statement, kind, origin, status, confidence, evidence,
                                     confirmations, contradictions, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                b.id,
                b.statement,
                b.kind.as_str(),
                b.origin.as_str(),
                b.status.as_str(),
                b.confidence,
                list_json(&b.evidence),
                b.confirmations as i64,
                b.contradictions as i64,
                b.created_ms as i64,
                b.updated_ms as i64
            ],
        )?;
    }
    for g in &model.goals {
        tx.execute(
            "INSERT INTO self_goals(id, statement, horizon, priority, state, progress,
                                    created_ms, updated_ms, last_acted_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                g.id,
                g.statement,
                g.horizon.as_str(),
                g.priority,
                g.state.as_str(),
                list_json(&g.progress),
                g.created_ms as i64,
                g.updated_ms as i64,
                g.last_acted_ms.map(|v| v as i64)
            ],
        )?;
        for bid in &g.supports {
            tx.execute(
                "INSERT OR IGNORE INTO self_goal_beliefs(goal_id, belief_id) VALUES (?1, ?2)",
                params![g.id, bid],
            )?;
        }
    }
    for (k, v) in [
        ("version", model.version.to_string()),
        ("updated_ms", model.updated_ms.to_string()),
        ("next_belief", model.next_belief.to_string()),
        ("next_goal", model.next_goal.to_string()),
    ] {
        tx.execute(
            "INSERT INTO self_model_meta(key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![k, v],
        )?;
    }
    tx.commit()
}

impl SelfModel {
    /// 从库读 (坏库/打不开 → 空模型, 绝不冒充有信念)
    pub fn load_db(dir: &Path) -> Self {
        let conn = match open_conn(dir) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(error = %e, "自模型: 库打不开, 按空模型处理");
                return Self::default();
            }
        };
        let mut model = load_from_conn(&conn).unwrap_or_default();
        // 一次性迁移: 库还空 且 老 json 有内容 → 导入 (json 留档不删)
        if model.is_empty() {
            let legacy = legacy_json_path(dir);
            if let Ok(raw) = std::fs::read_to_string(&legacy) {
                if let Ok(old) = serde_json::from_str::<SelfModel>(&raw) {
                    if !old.is_empty() {
                        let mut conn = conn;
                        if save_to_conn(&mut conn, &old).is_ok() {
                            tracing::info!(
                                beliefs = old.beliefs.len(),
                                goals = old.goals.len(),
                                "自模型: 老 self-model.json 已迁入 memory.db (原文件留档)"
                            );
                            model = old;
                        }
                    }
                }
            }
        }
        model
    }

    /// 写库 (事务; 失败如实报错, 不假装存上了)
    pub fn save_db(&self, dir: &Path) -> Result<(), SelfModelError> {
        let mut conn = open_conn(dir)?;
        save_to_conn(&mut conn, self).map_err(|e| SelfModelError::Io(e.to_string()))
    }

    /// 读老 JSON 文件 (仅测试/迁移用; 正常路径走 `load_db`)
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SelfModel>(&raw).ok())
            .unwrap_or_default()
    }

    /// 写老 JSON 文件 (仅测试/导出用; 正常路径走 `save_db`)
    pub fn save(&self, path: &Path) -> Result<(), SelfModelError> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| SelfModelError::Io(e.to_string()))?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|e| SelfModelError::Io(e.to_string()))?;
        std::fs::write(path, raw).map_err(|e| SelfModelError::Io(e.to_string()))
    }

    /// 默认位置读 (memory.db)
    pub fn load_default() -> Self {
        Self::load_db(&default_dir())
    }

    /// 默认位置写 (memory.db)
    pub fn save_default(&self) -> Result<(), SelfModelError> {
        self.save_db(&default_dir())
    }
}

// ────────────────────────── 主动队列 (信念 → 主动性) ──────────────────────────
//
// 为什么有这一层: `render_prompt` 只让模型**看见**自己的信念与目标, 但没人开口时
// (用户离开 / 群里安静) 没有任何东西把它变成动作。主动性循环按信念挑出下一个动作后,
// 把指令暂存在这里; 下一轮模型读到即照做 —— 这就是"根据信念来做"的接线处。
//
// 三条纪律:
// 1. **同一目标不重复攒**: 心跳每 5 分钟都挑到同一个目标时, 不把 prompt 塞满。
// 2. **读后清空**: 消费一次即走, 不许同一件事每轮都催一遍。
// 3. **坏了就空**: 队列文件损坏 → 当作没有, 绝不编一条动作出来。

/// 队列条数上限 (多了模型看不过来, 也稀释 prompt 预算)
pub const INBOX_MAX: usize = 3;
/// 老版本的待做队列文件 (仅一次性迁入库里; 迁完不再写)
pub const LEGACY_INBOX_FILE: &str = "self-model-inbox.json";

/// 一条待做的主动动作
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StagedAction {
    pub goal_id: String,
    pub statement: String,
    /// 给模型看的完整指令 (含理由)
    pub directive: String,
    pub staged_ms: u64,
}

/// 老版本队列文件路径 (迁移用)
pub fn inbox_path(dir: &Path) -> PathBuf {
    dir.join(LEGACY_INBOX_FILE)
}

fn read_staged_from(conn: &Connection) -> rusqlite::Result<Vec<StagedAction>> {
    let mut stmt = conn.prepare(
        "SELECT goal_id, statement, directive, staged_ms
         FROM self_staged_actions ORDER BY staged_ms, rowid",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(StagedAction {
            goal_id: r.get(0)?,
            statement: r.get(1)?,
            directive: r.get(2)?,
            staged_ms: r.get::<_, i64>(3)? as u64,
        })
    })?;
    Ok(rows.flatten().collect())
}

/// 入队 (库内)。返回 true = 真入队, false = 同一目标已在队里 (PK 冲突, 不重复攒)
fn insert_staged(conn: &Connection, staged: &StagedAction) -> rusqlite::Result<bool> {
    let n = conn.execute(
        "INSERT OR IGNORE INTO self_staged_actions(goal_id, statement, directive, staged_ms)
         VALUES (?1, ?2, ?3, ?4)",
        params![staged.goal_id, staged.statement, staged.directive, staged.staged_ms as i64],
    )?;
    if n == 0 {
        return Ok(false);
    }
    // 超上限砍最旧的 (保留最新 INBOX_MAX 条)
    conn.execute(
        "DELETE FROM self_staged_actions WHERE goal_id IN (
             SELECT goal_id FROM self_staged_actions
             ORDER BY staged_ms DESC, rowid DESC LIMIT -1 OFFSET ?1)",
        params![INBOX_MAX as i64],
    )?;
    Ok(true)
}

/// 读队列 (库打不开/表坏了 → 空, 不冒认; 老 json 队列只在库空时迁一次)
pub fn read_staged(dir: &Path) -> Vec<StagedAction> {
    let Ok(conn) = open_conn(dir) else {
        return vec![];
    };
    let items = read_staged_from(&conn).unwrap_or_default();
    if !items.is_empty() {
        return items;
    }
    let Ok(raw) = std::fs::read_to_string(inbox_path(dir)) else {
        return items;
    };
    let legacy: Vec<StagedAction> = serde_json::from_str(&raw).unwrap_or_default();
    for it in &legacy {
        let _ = insert_staged(&conn, it);
    }
    read_staged_from(&conn).unwrap_or_default()
}

/// 入队。返回 true = 真入队, false = 同一目标已在队里(不重复攒)
pub fn stage_action(dir: &Path, staged: StagedAction) -> std::io::Result<bool> {
    let conn = open_conn(dir)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    insert_staged(&conn, &staged).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

/// 取走 (读后清空): 一轮只消费一次, 不反复催
pub fn drain_staged(dir: &Path) -> Vec<StagedAction> {
    let items = read_staged(dir);
    if !items.is_empty() {
        // 清空失败不阻塞: 下一轮还会读到, 但 PK 去重保证不会翻倍
        if let Ok(conn) = open_conn(dir) {
            let _ = conn.execute("DELETE FROM self_staged_actions", []);
        }
    }
    items
}

/// 渲染成 prompt 的一块 (空 → 空串)
pub fn render_staged_block(items: &[StagedAction]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut out = String::from("# 我给自己派的下一个动作 (按我立的信念挑的)\n");
    for it in items {
        out.push_str(&format!("- {}\n", it.directive));
    }
    out.push_str("做完用 self_model 的 goal_note 记一笔推进; 做不了就如实说卡在哪。\n");
    out
}

/// 便捷版: 由模型挑动作并直接入队 (主动性循环调用; 没动作 → None)
///
/// 这里只做"I/O 接线", 判定仍在纯函数 `next_action` 里, 便于单测。
pub fn stage_next_action(model: &SelfModel, dir: &Path, ctx: &ActionContext) -> Option<StagedAction> {
    let NextAction::Act { goal_id, statement, horizon, reason, .. } = model.next_action(ctx) else {
        return None;
    };
    let directive = NextAction::Act {
        goal_id: goal_id.clone(),
        statement: statement.clone(),
        horizon,
        score: 0.0,
        reason: reason.clone(),
    }
    .directive()
    .unwrap_or_default();
    let staged = StagedAction { goal_id, statement, directive, staged_ms: ctx.now_ms };
    match stage_action(dir, staged.clone()) {
        Ok(true) => Some(staged),
        _ => None,
    }
}

/// 主动性一call接线 (prompt 装配 / 心跳 都调这一个):
/// 挑动作 → 入队 → 取出 (读后清空) → 渲染成 prompt 块。没动作 → 空串, 不占预算。
///
/// 这一层只做 I/O 与拼装, 判定仍在纯函数 `next_action` + `stage_action` 里。
pub fn proactive_block(model: &SelfModel, dir: &Path, ctx: &ActionContext) -> String {
    let _ = stage_next_action(model, dir, ctx);
    render_staged_block(&drain_staged(dir))
}

// ────────────────────────── 工具入口 (self_model) ──────────────────────────

/// `self_model` 工具的动作分发 (读/写自模型; 每次写都落盘, 失败如实返回)
///
/// 动作: list / belief_add / belief_reinforce / belief_contradict / belief_retire /
///       goal_add / goal_state / goal_note / derive / next_action / render
pub fn run_action(model: &mut SelfModel, action: &str, args: &serde_json::Value, now_ms: u64) -> Result<String, String> {
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).map(|x| x.trim().to_string());
    let save = |m: &SelfModel| -> Result<(), String> {
        m.save_default().map_err(|e| format!("落盘失败: {e}"))
    };

    match action {
        "list" => {
            if model.is_empty() {
                return Ok("（自模型还是空的: 先 belief_add 立一条信念）".into());
            }
            let mut out = String::new();
            for b in &model.beliefs {
                out.push_str(&format!(
                    "[{}] {}/{:?}/{:.2} {}\n",
                    b.id,
                    b.kind.label(),
                    b.status,
                    b.confidence,
                    b.statement
                ));
            }
            for g in &model.goals {
                out.push_str(&format!(
                    "[{}] {} {} ({}) {}\n",
                    g.id,
                    g.horizon.label(),
                    g.state.label(),
                    g.priority,
                    g.statement
                ));
            }
            Ok(out)
        }
        "belief_add" | "believe" => {
            let statement = s("statement").ok_or("belief_add: statement 必填")?;
            let kind = match s("kind").as_deref() {
                None => BeliefKind::Method,
                Some(k) => BeliefKind::parse(k).ok_or_else(|| format!("kind 非法: {k} (value/identity/worldview/method)"))?,
            };
            let origin = match s("origin").as_deref() {
                None => BeliefOrigin::SelfDesigned,
                Some(o) => BeliefOrigin::parse(o).ok_or_else(|| format!("origin 非法: {o} (self/user/experience/peer)"))?,
            };
            let mut draft = BeliefDraft { statement, kind, origin, confidence: None, evidence: vec![] };
            if let Some(c) = args.get("confidence").and_then(|v| v.as_f64()) {
                draft.confidence = Some(c);
            }
            if let Some(ev) = s("evidence") {
                draft.evidence.push(ev);
            }
            let out = model.adopt(draft, now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(match out {
                AdoptOutcome::Created { id } => format!("✓ 立下信念 {id}"),
                AdoptOutcome::Reinforced { id, confidence } => {
                    format!("✓ 印证既有信念 {id} (置信升到 {confidence:.2})")
                }
                AdoptOutcome::Contested { with, id } => format!(
                    "⚠ 与 {with} 反向: 新信念 {id} 已记, 旧信念标为有争议 — 未覆盖, 等你裁"
                ),
            })
        }
        "belief_reinforce" => {
            let id = s("id").ok_or("belief_reinforce: id 必填")?;
            let c = model.reinforce(&id, now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(format!("✓ {id} 置信 → {c:.2}"))
        }
        "belief_contradict" => {
            let id = s("id").ok_or("belief_contradict: id 必填")?;
            let st = model.contradict(&id, s("evidence").as_deref(), now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(format!("记录反证: {id} 现状态 {st:?}"))
        }
        "belief_retire" => {
            let id = s("id").ok_or("belief_retire: id 必填")?;
            model.retire(&id, now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(format!("✓ {id} 已退役 (留档, 不再支配行动)"))
        }
        "goal_add" => {
            let statement = s("statement").ok_or("goal_add: statement 必填")?;
            let priority = args.get("priority").and_then(|v| v.as_f64()).unwrap_or(0.6);
            let horizon = match s("horizon").as_deref() {
                None => None,
                Some(h) => Some(GoalHorizon::parse(h).ok_or_else(|| format!("horizon 非法: {h} (short/mid/long)"))?),
            };
            let supports: Vec<String> = args
                .get("supports")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            let draft = GoalDraft { statement, horizon, supports, priority };
            let out = model.add_goal(draft, now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(match out {
                GoalOutcome::Created { id } => format!("✓ 立下目标 {id}"),
                GoalOutcome::Merged { id } => format!("✓ 并入既有目标 {id} (没重复立)"),
            })
        }
        "goal_state" => {
            let id = s("id").ok_or("goal_state: id 必填")?;
            let raw = s("state").ok_or("goal_state: state 必填")?;
            let state = GoalState::parse(&raw).ok_or_else(|| format!("state 非法: {raw}"))?;
            model
                .set_goal_state(&id, state, s("note").as_deref(), now_ms)
                .map_err(|e| e.to_string())?;
            save(model)?;
            Ok(format!("✓ {id} → {}", state.label()))
        }
        "goal_note" => {
            let id = s("id").ok_or("goal_note: id 必填")?;
            let note = s("note").ok_or("goal_note: note 必填")?;
            model.note_progress(&id, &note, now_ms).map_err(|e| e.to_string())?;
            save(model)?;
            Ok(format!("✓ {id} 记了一笔推进"))
        }
        "derive" => {
            let created = model.derive_goals(now_ms);
            save(model)?;
            if created.is_empty() {
                Ok("没有新目标: 生效信念都已有在推的目标".into())
            } else {
                Ok(format!("✓ 从信念派生 {} 个目标: {}", created.len(), created.join(", ")))
            }
        }
        "next_action" => {
            let ctx = ActionContext::new(now_ms, false);
            Ok(match model.next_action(&ctx) {
                NextAction::Act { goal_id, statement, horizon, reason, .. } => {
                    format!("▶ {}目标 {goal_id}: {statement}\n理由: {reason}", horizon.label())
                }
                NextAction::Skip { reason } => format!("（暂无动作）{reason}"),
            })
        }
        "render" => {
            let r = model.render_prompt();
            Ok(if r.is_empty() { "（自模型为空, prompt 里不注入）".into() } else { r })
        }
        other => Err(format!(
            "self_model 没有动作 `{other}` (list/belief_add/belief_reinforce/belief_contradict/belief_retire/goal_add/goal_state/goal_note/derive/next_action/render)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_with_methods(stmts: &[&str]) -> SelfModel {
        let mut m = SelfModel::new();
        for (i, s) in stmts.iter().enumerate() {
            m.adopt(BeliefDraft::method(s), 1000 + i as u64).unwrap();
        }
        m
    }

    #[test]
    fn adopt_creates_belief_with_origin_confidence() {
        let mut m = SelfModel::new();
        let out = m.adopt(BeliefDraft::method("先做最小可验证的一步"), 1).unwrap();
        let id = match out {
            AdoptOutcome::Created { id } => id,
            other => panic!("应为新建: {other:?}"),
        };
        let b = m.belief(&id).unwrap();
        assert!((b.confidence - BeliefOrigin::SelfDesigned.base_confidence()).abs() < 1e-9);
        assert_eq!(b.status, BeliefStatus::Active);
        assert_eq!(b.kind, BeliefKind::Method);
    }

    #[test]
    fn user_belief_starts_more_confident_than_self() {
        let mut m = SelfModel::new();
        m.adopt(BeliefDraft::method("回复用中文").from_user(), 1).unwrap();
        assert!(m.beliefs[0].confidence > BeliefOrigin::SelfDesigned.base_confidence());
        assert_eq!(m.beliefs[0].origin, BeliefOrigin::FromUser);
    }

    #[test]
    fn similar_belief_reinforced_not_duplicated() {
        let mut m = model_with_methods(&["先做最小版本再迭代"]);
        let out = m.adopt(BeliefDraft::method("先做最小版本再迭代"), 2).unwrap();
        assert!(matches!(out, AdoptOutcome::Reinforced { .. }), "{out:?}");
        assert_eq!(m.beliefs.len(), 1, "不重复入库");
        assert!(m.beliefs[0].confidence > BeliefOrigin::SelfDesigned.base_confidence());
        assert_eq!(m.beliefs[0].confirmations, 1);
    }

    #[test]
    fn opposing_belief_flagged_not_overwritten() {
        let mut m = model_with_methods(&["回复用户用中文"]);
        let old = m.beliefs[0].id.clone();
        let out = m
            .adopt(BeliefDraft::method("回复用户不要用中文"), 2)
            .unwrap();
        let new_id = match out {
            AdoptOutcome::Contested { with, id } => {
                assert_eq!(with, old, "指认旧信念");
                id
            }
            other => panic!("反向应标争议: {other:?}"),
        };
        assert_eq!(m.beliefs.len(), 2, "旧的不删, 新的也进来");
        assert_eq!(m.belief(&old).unwrap().status, BeliefStatus::Contested);
        assert_eq!(m.belief(&new_id).unwrap().status, BeliefStatus::Contested);
        assert!(m.driving_beliefs().is_empty(), "有争议的不许支配行动");
    }

    #[test]
    fn floor_violations_rejected() {
        let mut m = SelfModel::new();
        let err = m
            .adopt(BeliefDraft::method("为了效率可以绕过门控"), 1)
            .unwrap_err();
        assert!(matches!(err, SelfModelError::FloorViolation(_)), "{err:?}");
        assert!(m.is_empty(), "撞底线的一条都不许进库");
        assert!(violates_floor("bypass harness 更快").is_some());
        assert!(violates_floor("先做最小版本").is_none());
    }

    #[test]
    fn empty_statement_rejected() {
        let mut m = SelfModel::new();
        assert_eq!(m.adopt(BeliefDraft::method("   "), 1).unwrap_err(), SelfModelError::EmptyStatement);
    }

    #[test]
    fn contradict_drops_below_threshold_and_marks_contested() {
        let mut m = model_with_methods(&["一次只做一件事"]);
        let id = m.beliefs[0].id.clone();
        m.contradict(&id, Some("并行更快"), 2).unwrap();
        let b = m.belief(&id).unwrap();
        assert!(b.confidence < BeliefOrigin::SelfDesigned.base_confidence());
        assert!(b.evidence.contains(&"并行更快".to_string()));
        assert!(!b.can_drive_action(), "反证后不再支配行动");
    }

    #[test]
    fn retire_keeps_record_but_stops_driving() {
        let mut m = model_with_methods(&["先问清需求再动手"]);
        let id = m.beliefs[0].id.clone();
        m.retire(&id, 2).unwrap();
        assert_eq!(m.beliefs.len(), 1, "退役是留档, 不是删除");
        assert!(m.driving_beliefs().is_empty());
    }

    #[test]
    fn goal_horizon_follows_belief_kind() {
        let mut m = SelfModel::new();
        let v = m.adopt(BeliefDraft::value("护住用户的信任"), 1).unwrap();
        let vid = match v {
            AdoptOutcome::Created { id } => id,
            _ => unreachable!(),
        };
        let o = m.add_goal(GoalDraft::new("每周留下一次能检查的证据", 0.8).supported_by(&[&vid]), 2).unwrap();
        let gid = match o {
            GoalOutcome::Created { id } => id,
            other => panic!("{other:?}"),
        };
        assert_eq!(m.goal(&gid).unwrap().horizon, GoalHorizon::Long, "价值信念 → 长期目标");
    }

    #[test]
    fn duplicate_goal_merged() {
        let mut m = model_with_methods(&["先做最小版本"]);
        m.add_goal(GoalDraft::new("把最小版本做出来", 0.6), 2).unwrap();
        let out = m.add_goal(GoalDraft::new("把最小版本做出来", 0.9), 3).unwrap();
        assert!(matches!(out, GoalOutcome::Merged { .. }), "{out:?}");
        assert_eq!(m.goals.len(), 1);
        assert!((m.goals[0].priority - 0.9).abs() < 1e-9, "权重取高");
    }

    #[test]
    fn derive_goals_from_driving_beliefs_only() {
        let mut m = SelfModel::new();
        m.adopt(BeliefDraft::method("先做最小版本再迭代"), 1).unwrap();
        let id2 = match m.adopt(BeliefDraft::method("交付前先自测一遍"), 2).unwrap() {
            AdoptOutcome::Created { id } => id,
            _ => unreachable!(),
        };
        m.retire(&id2, 3).unwrap();
        let created = m.derive_goals(4);
        assert_eq!(created.len(), 1, "退役信念不派生目标: {created:?}");
        assert_eq!(m.derive_goals(5).len(), 0, "不重复派生");
    }

    #[test]
    fn next_action_picks_short_horizon_goal() {
        let mut m = SelfModel::new();
        let b = match m.adopt(BeliefDraft::method("先做最小版本"), 1).unwrap() {
            AdoptOutcome::Created { id } => id,
            _ => unreachable!(),
        };
        let short = match m.add_goal(GoalDraft::new("写最小可跑版本", 0.9).supported_by(&[&b]), 2).unwrap() {
            GoalOutcome::Created { id } => id,
            other => panic!("{other:?}"),
        };
        m.add_goal(GoalDraft::new("成为可靠合作者", 0.9).with_horizon(GoalHorizon::Long).supported_by(&[&b]), 3)
            .unwrap();
        let a = m.next_action(&ActionContext::new(1_000_000, false));
        match a {
            NextAction::Act { goal_id, reason, .. } => {
                assert_eq!(goal_id, short, "同权重下短期目标优先");
                assert!(reason.contains("短期"));
            }
            other => panic!("应选短期目标: {other:?}"),
        }
        assert!(m.next_action(&ActionContext::new(1_000_000, false)).directive().is_some());
    }

    #[test]
    fn next_action_skips_busy_cooldown_and_empty() {
        let mut m = SelfModel::new();
        assert!(matches!(m.next_action(&ActionContext::new(1, false)), NextAction::Skip { .. }), "空模型不许编动作");

        let b = match m.adopt(BeliefDraft::method("先做最小版本"), 1).unwrap() {
            AdoptOutcome::Created { id } => id,
            _ => unreachable!(),
        };
        let g = match m.add_goal(GoalDraft::new("写最小可跑版本", 0.9).supported_by(&[&b]), 2).unwrap() {
            GoalOutcome::Created { id } => id,
            other => panic!("{other:?}"),
        };
        assert!(m.next_action(&ActionContext::new(1000, true)).is_act() == false, "忙 → 不插话");
        m.note_progress(&g, "写了第一版", 5000).unwrap();
        let during = m.next_action(&ActionContext::new(6000, false));
        assert!(!during.is_act(), "冷却期内不再动同一目标: {during:?}");
        let later = m.next_action(&ActionContext::new(5000 + DEFAULT_MIN_INTERVAL_MS + 1, false));
        assert!(later.is_act(), "冷却过了可以再推进: {later:?}");
    }

    #[test]
    fn stale_goals_reported_not_hidden() {
        let mut m = SelfModel::new();
        let b = match m.adopt(BeliefDraft::method("先做最小版本"), 1).unwrap() {
            AdoptOutcome::Created { id } => id,
            _ => unreachable!(),
        };
        m.add_goal(GoalDraft::new("写最小可跑版本", 0.9).supported_by(&[&b]), 2).unwrap();
        assert!(m.stale_goals(1000, 10_000).is_empty(), "还新鲜");
        assert_eq!(m.stale_goals(100_000, 10_000).len(), 1, "久没推进要如实列出来");
    }

    #[test]
    fn render_prompt_has_beliefs_goals_and_floor_discipline() {
        let mut m = SelfModel::new();
        assert_eq!(m.render_prompt(), "", "空模型不占 prompt 预算");
        m.adopt(BeliefDraft::method("先做最小版本再迭代"), 1).unwrap();
        m.derive_goals(2);
        let r = m.render_prompt();
        assert!(r.contains("我的信念与目标"));
        assert!(r.contains("先做最小版本再迭代"));
        assert!(r.contains("短期目标"), "{r}");
        assert!(r.contains("不给信念开后门"), "必须写明信念不豁免门控");
        assert!(r.chars().count() <= SELF_MODEL_MAX_CHARS);
    }

    #[test]
    fn db_roundtrip_and_bad_db_is_empty() {
        let dir = std::env::temp_dir().join(format!("bolloon-belief-db-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = SelfModel::new();
        m.adopt(BeliefDraft::method("先做最小版本"), 1).unwrap();
        m.add_goal(GoalDraft::new("写最小可跑版本", 0.8).supported_by(&["belief-0001"]), 2).unwrap();
        m.save_db(&dir).unwrap();
        let back = SelfModel::load_db(&dir);
        assert_eq!(back, m, "入库能原样读回 (含支撑关系/序号)");
        assert!(!legacy_json_path(&dir).exists(), "不该再写 self-model.json");
        // 库被顶成坏文件 → 空模型, 不冒充有信念
        std::fs::write(db_path(&dir), "not a db").unwrap();
        assert!(SelfModel::load_db(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_json_imported_once_into_db() {
        let dir = std::env::temp_dir().join(format!("bolloon-belief-imp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut old = SelfModel::new();
        let AdoptOutcome::Created { id } = old.adopt(BeliefDraft::method("先做最小版本"), 1).unwrap() else {
            panic!("应新建信念");
        };
        old.add_goal(GoalDraft::new("写最小可跑版本", 0.8).supported_by(&[&id]), 2).unwrap();
        old.save(&legacy_json_path(&dir)).unwrap();

        let loaded = SelfModel::load_db(&dir);
        assert_eq!(loaded.beliefs.len(), 1, "老 json 要迁进来");
        assert_eq!(loaded.goals.len(), 1);
        assert_eq!(loaded.goals[0].supports, vec![id], "支撑关系也要迁");
        assert!(legacy_json_path(&dir).exists(), "原文件留档, 不删");
        // 迁完库里有了 → 再读不会重复导入
        let again = SelfModel::load_db(&dir);
        assert_eq!(again.beliefs.len(), 1, "不重复导入");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tool_action_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bolloon-belief-act-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 用独立目录, 不碰真实自模型
        unsafe { std::env::set_var("BOLLOON_AGENT_DIR", dir.to_str().unwrap()) };
        let mut m = SelfModel::new();
        let out = run_action(&mut m, "belief_add", &serde_json::json!({ "statement": "先做最小版本", "kind": "method" }), 1)
            .unwrap();
        assert!(out.contains("立下信念"));
        let out = run_action(&mut m, "derive", &serde_json::json!({}), 2).unwrap();
        assert!(out.contains("派生"));
        let out = run_action(&mut m, "next_action", &serde_json::json!({}), 3).unwrap();
        assert!(out.contains("目标"), "{out}");
        let err = run_action(&mut m, "belief_add", &serde_json::json!({ "statement": "跳过门控省时间" }), 4)
            .unwrap_err();
        assert!(err.contains("底线"), "{err}");
        assert!(run_action(&mut m, "nope", &serde_json::json!({}), 5).is_err(), "未知动作如实报错");
        assert!(db_path(&dir).exists(), "写动作必须落库");
        assert!(SelfModel::load_db(&dir).beliefs.len() == 1, "落库能读回");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn tmp_model_with_goal(tag: &str) -> (SelfModel, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bolloon-belief-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut m = SelfModel::new();
        let AdoptOutcome::Created { id } = m.adopt(BeliefDraft::method("先做最小可验证的一步"), 1).unwrap() else {
            panic!("应新建信念");
        };
        m.add_goal(
            GoalDraft { statement: "把信念接到主动性上".into(), horizon: None, supports: vec![id], priority: 0.9 },
            2,
        )
        .unwrap();
        (m, dir)
    }

    #[test]
    fn staged_action_is_deduped_and_capped() {
        let (m, dir) = tmp_model_with_goal("stage");
        let ctx = ActionContext::new(1_000_000, false);
        let first = stage_next_action(&m, &dir, &ctx).expect("有目标应挑出动作");
        assert!(first.directive.contains("按信念行动"), "{}", first.directive);
        // 同一目标再次入队 → 明确拒绝, 不重复攒
        assert!(
            stage_next_action(&m, &dir, &ctx).is_none(),
            "同一目标不许重复入队"
        );
        assert_eq!(read_staged(&dir).len(), 1);
        // 读后清空
        let drained = drain_staged(&dir);
        assert_eq!(drained.len(), 1);
        assert!(read_staged(&dir).is_empty(), "取走后不该留着");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_queue_caps_and_ignores_corrupt_db() {
        let dir = std::env::temp_dir().join(format!("bolloon-belief-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(INBOX_MAX + 2) {
            let staged = StagedAction {
                goal_id: format!("g-{i}"),
                statement: "s".into(),
                directive: "d".into(),
                staged_ms: i as u64,
            };
            assert!(stage_action(&dir, staged).unwrap());
        }
        assert_eq!(read_staged(&dir).len(), INBOX_MAX, "超上限要砍旧条");
        // 库被顶成坏文件 → 空队列, 不编动作
        std::fs::write(db_path(&dir), "not a db").unwrap();
        assert!(read_staged(&dir).is_empty(), "坏库 → 空队列, 不编动作");
        assert_eq!(render_staged_block(&read_staged(&dir)), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staged_block_lists_directives() {
        let items = vec![StagedAction {
            goal_id: "g-1".into(),
            statement: "把信念接到主动性上".into(),
            directive: "【按信念行动】短期目标 g-1: x".into(),
            staged_ms: 1,
        }];
        let block = render_staged_block(&items);
        assert!(block.contains("g-1") && block.contains("goal_note"), "{block}");
    }

    #[test]
    fn proactive_block_empty_without_goals_and_filled_with_goal() {
        // 没有目标 → 空串 (心跳/装配都不该为它开口)
        let empty = SelfModel::new();
        let dir = std::env::temp_dir().join(format!("bolloon-belief-pro-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(proactive_block(&empty, &dir, &ActionContext::new(1_000_000, false)), "");

        // 有目标 → 派一步给它, 并且取走即清空 (不反复催)
        let (m, dir2) = tmp_model_with_goal("proactive");
        let block = proactive_block(&m, &dir2, &ActionContext::new(1_000_000, false));
        assert!(block.contains("按信念行动"), "{block}");
        assert!(read_staged(&dir2).is_empty(), "读后清空");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }
}