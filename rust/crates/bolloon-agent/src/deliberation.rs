//! 群内商议机制：推选（谁发言）/ 发言（控麦）/ 并发（去重 + 序号 + 冷却）
//!
//! 参考 hushfusion forge `internal/kernel/ha` 的纪律：
//! - 所有"决策"是**纯函数**（不碰 I/O，可单测）：`select_next_speaker` / `elect_moderator` / `admit_speech`
//! - 运行时副作用（真正调 LLM / 发消息）经**端口注入**；未注入即不动作（fail-closed）
//!
//! bolloon 独特设定：外部智能体（经 world-inbox / p2p-visitor 加入）是 [`MemberRole::Advisor`]
//! —— 可作为「人类代理 / 合作顾问」发言献策，但**不具命令权威**（`can_command=false`），
//! 也**不能握有控麦主持权**（`can_moderate=false`）。其内部智能体 / 人类才能被命令与主持。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

// ────────────────────────── 角色 ──────────────────────────

/// 群成员角色
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemberRole {
    /// 用户本人（可命令、可主持）
    Human,
    /// 本 bolloon 智能体（commandable agent；可命令、可主持）
    Internal,
    /// 外部智能体（经 world-inbox / p2p-visitor 加入）：合作顾问——不可命令、不可主持
    Advisor,
}

impl MemberRole {
    /// 可被内部命令执行（Human / Internal）。Advisor 否。
    pub fn can_command(&self) -> bool {
        matches!(self, MemberRole::Human | MemberRole::Internal)
    }
    /// 可握有控麦主持权威（Human / Internal）。Advisor 否——外部顾问不能当群主持。
    pub fn can_moderate(&self) -> bool {
        matches!(self, MemberRole::Human | MemberRole::Internal)
    }
}

/// 入口判据：某条消息能否作为「命令」被本地 agent 执行。
///
/// - 普通发言 / 建议（`is_command = false`）：任何角色都可（含 Advisor 献策）
/// - 要求执行（`is_command = true`）：只有 `Human` / `Internal` 可下；`Advisor`（外部顾问）**不可**
///
/// 这是「外部顾问拒绝被命令」的边界：外部智能体可以进群发言献策，但**不能对本机 agent 下指令**。
pub fn admit_command(author_role: MemberRole, is_command: bool) -> bool {
    if !is_command {
        return true;
    }
    author_role.can_command()
}

/// 便捷判定：某角色是否可被命令（Advisor 否）。
pub fn may_execute_command(role: MemberRole) -> bool {
    role.can_command()
}

// ────────────────────────── 成员 / 候选 ──────────────────────────

/// 群成员（运行态）
#[derive(Debug, Clone)]
pub struct Member {
    pub id: String,
    pub role: MemberRole,
    pub last_spoke_ms: u64,
}

/// 推选候选（针对一条入站消息构造）
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub role: MemberRole,
    /// 是否被 @（点名）
    pub addressed: bool,
    /// 与话题相关性 ∈ [0,1]
    pub relevance: f64,
    pub last_spoke_ms: u64,
}

// ────────────────────────── 推选（纯函数）──────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ElectionMode {
    /// 优先满足"被@"者；无人被@则取可主持者里相关性最高；若群里只剩 Advisor 则让最相关的 Advisor 献策
    AddressedFirst,
    /// 取相关性最高者（不限角色，Advisor 也可被推选出声献策）
    MostRelevant,
    /// 在候选里按游标轮转（稳定的公平轮流）
    RoundRobin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpeakReason {
    Addressed,
    MostRelevant,
    RoundRobin,
}

/// 推选下一个发言者（**纯函数**，不碰 I/O）。
///
/// - `AddressedFirst`：先在被@候选里取相关性最高；没人被@则取可主持者里相关性最高；
///   若群里只剩 Advisor（无 Human/Internal），则让最相关的 Advisor 献策（只发言、不主持）。
/// - `MostRelevant`：全体候选里相关性最高（Advisor 也可被推选出口献策）。
/// - `RoundRobin`：按 `cursor` 在候选里轮转。
pub fn select_next_speaker(
    candidates: &[Candidate],
    mode: ElectionMode,
    cursor: usize,
) -> Option<(String, SpeakReason)> {
    if candidates.is_empty() {
        return None;
    }
    match mode {
        ElectionMode::AddressedFirst => {
            let addressed: Vec<&Candidate> = candidates.iter().filter(|c| c.addressed).collect();
            if !addressed.is_empty() {
                let best = best_by_relevance(addressed.iter().copied()).expect("非空");
                return Some((best.id.clone(), SpeakReason::Addressed));
            }
            // 没人被@：优先让"可主持"角色里最相关的开口（命令权威留在内部）
            if let Some(best) = candidates
                .iter()
                .filter(|c| c.role.can_moderate())
                .max_by(|a, b| relevance_cmp(a, b))
            {
                return Some((best.id.clone(), SpeakReason::MostRelevant));
            }
            // 群里只剩 Advisor（无内部成员）→ 让最相关的 Advisor 献策
            let best = best_by_relevance(candidates.iter()).expect("非空");
            Some((best.id.clone(), SpeakReason::MostRelevant))
        }
        ElectionMode::MostRelevant => {
            let best = best_by_relevance(candidates.iter()).expect("非空");
            Some((best.id.clone(), SpeakReason::MostRelevant))
        }
        ElectionMode::RoundRobin => {
            let idx = cursor % candidates.len();
            let c = &candidates[idx];
            Some((c.id.clone(), SpeakReason::RoundRobin))
        }
    }
}

/// 推选主持（控麦权威）：**只从可主持角色里选**；无候选 ⇒ None（Advisor 不能主持）。
pub fn elect_moderator(candidates: &[Candidate]) -> Option<String> {
    let eligible: Vec<&Candidate> = candidates.iter().filter(|c| c.role.can_moderate()).collect();
    if eligible.is_empty() {
        return None;
    }
    // 主持轮转：取 last_spoke_ms 最小（最久没主持的）优先，稳定可测
    eligible
        .iter()
        .min_by_key(|c| c.last_spoke_ms)
        .map(|c| c.id.clone())
}

fn relevance_cmp(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.relevance
        .partial_cmp(&b.relevance)
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn best_by_relevance<'a, I>(iter: I) -> Option<&'a Candidate>
where
    I: Iterator<Item = &'a Candidate>,
{
    iter.max_by(|a, b| relevance_cmp(a, b))
}

// ────────────────────────── 发言（控麦）──────────────────────────

/// 控麦运行态：同一时刻只有 `holder` 能说，其余入队等待。
#[derive(Debug, Clone, Default)]
pub struct Floor {
    pub holder: Option<String>,
    pub queue: VecDeque<String>,
}

impl Floor {
    /// 申请发言权：麦空则直接获得；已是 holder 则保持；否则排队（不重复入队）。
    /// 返回是否拿到了当前发言权（即成为 holder）。
    pub fn claim(&mut self, id: &str) -> bool {
        if self.holder.is_none() {
            self.holder = Some(id.to_string());
            true
        } else if self.holder.as_deref() == Some(id) {
            true
        } else {
            if !self.queue.contains(&id.to_string()) {
                self.queue.push_back(id.to_string());
            }
            false
        }
    }

    /// 释放发言权：holder 释放后由队首补位（仍是同一个麦，只是易主）。
    pub fn release(&mut self, id: &str) {
        if self.holder.as_deref() == Some(id) {
            self.holder = self.queue.pop_front();
        } else {
            self.queue.retain(|q| q != id);
        }
    }

    /// 把麦让给指定 id（若当前 holder 是调用方）；被让者直接上位，跳过队列。
    pub fn yield_to(&mut self, from: &str, to: &str) -> bool {
        if self.holder.as_deref() == Some(from) {
            self.queue.retain(|q| q != to);
            self.holder = Some(to.to_string());
            true
        } else {
            false
        }
    }
}

/// 发言许可（**纯函数**）：避免两人同时开口。
///
/// - `speaker == holder` ⇒ 允许（握麦者继续说）
/// - `holder` 为空 且 `speaker` 被@（任何角色，含 Advisor 被@献策）⇒ 允许
/// - 否则拒绝（麦被别人握着，或没人被@就抢话）
pub fn admit_speech(floor: &Floor, speaker: &str, addressed: bool) -> bool {
    if floor.holder.as_deref() == Some(speaker) {
        return true;
    }
    if floor.holder.is_none() && addressed {
        return true;
    }
    false
}

// ────────────────────────── 并发（DeliberationHub）──────────────────────────

/// 单条入站消息的处理决策（并发安全 `ingest` 的返回值）
#[derive(Debug, Clone)]
pub struct IngestDecision {
    pub seq: u64,
    pub duplicate: bool,
    pub speaker_id: Option<String>,
    pub reason: Option<SpeakReason>,
    /// 该消息触发了"获麦"（成为当前发言者）
    pub floor_granted: bool,
    /// 该发言者是否可被命令（false ⇒ Advisor，外部顾问不可命令）
    pub can_command: bool,
    /// 因冷却被拦（距上次开口不够久）
    pub cooldown_blocked: bool,
}

/// 群内商议中枢（运行态）。
///
/// 多 worker task 并发 `ingest` 同一条/不同消息时：
/// - `seen` 幂等去重 ⇒ 同一消息只处理一次
/// - `seq` 严格递增 ⇒ 输出保序
/// - `floor` 控麦 ⇒ 同一时刻只有一个 holder 在说
/// - `last_spoke` 每发言者冷却 ⇒ 防止刷屏
///
/// **fail-closed**：`emit`（真正调 LLM / 发消息）等副作用经端口注入；未注入只算决策不动作。
pub struct DeliberationHub {
    members: Mutex<HashMap<String, Member>>,
    seen: Mutex<HashSet<String>>,
    seq: Mutex<u64>,
    floor: Mutex<Floor>,
    last_spoke: Mutex<HashMap<String, u64>>,
    cooldown_ms: u64,
    /// 副作用端口：真正让某成员发言 / 调 LLM。未注入 = fail-closed（只算决策不动作）
    emit: Mutex<Option<EmitPort>>,
}

/// 副作用端口: 真正让某成员发言 / 调 LLM 的出口 (未注入 = fail-closed)
pub type EmitPort = Box<dyn Fn(&str, u64) + Send + Sync>;

impl DeliberationHub {
    pub fn new(cooldown_ms: u64) -> Self {
        Self {
            members: Mutex::new(HashMap::new()),
            seen: Mutex::new(HashSet::new()),
            seq: Mutex::new(0),
            floor: Mutex::new(Floor::default()),
            last_spoke: Mutex::new(HashMap::new()),
            cooldown_ms,
            emit: Mutex::new(None),
        }
    }

    /// 注入副作用端口（真正发言 / 调 LLM 的出口）
    pub fn set_emit(&self, f: EmitPort) {
        *self.emit.lock().unwrap() = Some(f);
    }

    /// 注册成员（**幂等**：已存在则保留其 `last_spoke_ms`，不重置）。
    pub fn add_member(&self, id: &str, role: MemberRole) {
        let mut m = self.members.lock().unwrap();
        m.entry(id.to_string())
            .or_insert(Member {
                id: id.to_string(),
                role,
                last_spoke_ms: 0,
            });
    }

    pub fn member_role(&self, id: &str) -> Option<MemberRole> {
        self.members.lock().unwrap().get(id).map(|m| m.role)
    }

    /// 群成员角色快照（供运行时 / 前端查询谁是被当作顾问的外部智能体）。
    pub fn member_roles(&self) -> HashMap<String, MemberRole> {
        self.members
            .lock()
            .unwrap()
            .iter()
            .map(|(k, m)| (k.clone(), m.role))
            .collect()
    }

    /// 用群内成员构建推选候选（针对一条入站消息）。
    pub fn build_candidates(
        &self,
        relevance: &HashMap<String, f64>,
        addressed: &[String],
    ) -> Vec<Candidate> {
        let members = self.members.lock().unwrap();
        let addressed_set: HashSet<&String> = addressed.iter().collect();
        members
            .values()
            .map(|m| Candidate {
                id: m.id.clone(),
                role: m.role,
                addressed: addressed_set.contains(&m.id),
                relevance: relevance.get(&m.id).copied().unwrap_or(0.0),
                last_spoke_ms: m.last_spoke_ms,
            })
            .collect()
    }

    /// 推选本群发言者（纯决策，不改运行态）
    pub fn elect_speaker(
        &self,
        relevance: &HashMap<String, f64>,
        addressed: &[String],
        mode: ElectionMode,
        cursor: usize,
    ) -> Option<(String, SpeakReason)> {
        let cands = self.build_candidates(relevance, addressed);
        select_next_speaker(&cands, mode, cursor)
    }

    /// 推选主持者（控麦权威，仅 Human/Internal）
    pub fn elect_moderator(&self) -> Option<String> {
        let cands = self.build_candidates(&HashMap::new(), &[]);
        elect_moderator(&cands)
    }

    /// 并发安全地摄入一条入站消息，返回处理决策。
    ///
    /// 流程：幂等去重 → 分配 seq → 推选发言者 → 控麦 claim + `admit_speech` → 冷却判定 →
    /// （若获麦且过冷却且注入了 emit）触发副作用。
    ///
    /// 注意：获麦后**不自动释放**——发言轮次结束由运行时调用 [`DeliberationHub::release_floor`]
    /// 收尾，这样麦在整轮（含异步生成回复）期间都握在发言者手里，真正防止两人同时说。
    // 入参就是这次消息的全部事实 (去重键/来源/相关度/被@/命令门/时序), 拆结构体只是搬一层
    #[allow(clippy::too_many_arguments)]
    pub fn ingest(
        &self,
        msg_id: &str,
        _from: &str,
        relevance: &HashMap<String, f64>,
        addressed: &[String],
        now_ms: u64,
        mode: ElectionMode,
        cursor: usize,
    ) -> IngestDecision {
        // 幂等去重：同一消息只处理一次
        {
            let mut seen = self.seen.lock().unwrap();
            if !seen.insert(msg_id.to_string()) {
                return IngestDecision {
                    seq: 0,
                    duplicate: true,
                    speaker_id: None,
                    reason: None,
                    floor_granted: false,
                    can_command: self
                        .member_role(_from)
                        .map(|r| r.can_command())
                        .unwrap_or(false),
                    cooldown_blocked: false,
                };
            }
        }
        let seq = {
            let mut s = self.seq.lock().unwrap();
            *s += 1;
            *s
        };

        let (speaker_id, reason) = match self.elect_speaker(relevance, addressed, mode, cursor) {
            Some(x) => x,
            None => {
                return IngestDecision {
                    seq,
                    duplicate: false,
                    speaker_id: None,
                    reason: None,
                    floor_granted: false,
                    can_command: false,
                    cooldown_blocked: false,
                };
            }
        };

        let can_command = self
            .member_role(&speaker_id)
            .map(|r| r.can_command())
            .unwrap_or(false);
        let speaker_addressed = addressed.iter().any(|a| a == &speaker_id);

        // 控麦 + 发言许可（纯判定）
        let mut fl = self.floor.lock().unwrap();
        fl.claim(&speaker_id);
        let floor_granted = admit_speech(&fl, &speaker_id, speaker_addressed);
        drop(fl);

        // 冷却：发言者距上次开口是否够久
        let cooldown_blocked = {
            let last = self.last_spoke.lock().unwrap();
            match last.get(&speaker_id) {
                Some(t) => now_ms.saturating_sub(*t) < self.cooldown_ms,
                None => false,
            }
        };

        // 副作用（fail-closed）：获麦 + 过冷却 + 注入了 emit ⇒ 让该成员发言
        if floor_granted && !cooldown_blocked {
            if let Some(f) = &*self.emit.lock().unwrap() {
                f(&speaker_id, seq);
            }
            *self.last_spoke.lock().unwrap().entry(speaker_id.clone()).or_insert(0) = now_ms;
            if let Some(m) = self.members.lock().unwrap().get_mut(&speaker_id) {
                m.last_spoke_ms = now_ms;
            }
        }

        IngestDecision {
            seq,
            duplicate: false,
            speaker_id: Some(speaker_id),
            reason: Some(reason),
            floor_granted,
            can_command,
            cooldown_blocked,
        }
    }

    /// 发言轮次结束：释放发言者的麦（由运行时在回复生成完毕后调用），让下一轮能易主。
    pub fn release_floor(&self, id: &str) {
        self.floor.lock().unwrap().release(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    // ── 角色边界 ──
    #[test]
    fn roles_command_and_moderate() {
        assert!(MemberRole::Human.can_command() && MemberRole::Human.can_moderate());
        assert!(MemberRole::Internal.can_command() && MemberRole::Internal.can_moderate());
        // Advisor：合作顾问 —— 不可命令、不可主持
        assert!(!MemberRole::Advisor.can_command());
        assert!(!MemberRole::Advisor.can_moderate());
    }

    // ── 入口门禁：外部顾问拒绝被命令 ──
    #[test]
    fn admit_command_gate_excludes_advisor() {
        // 指令：只有 Human/Internal 可下；Advisor 否
        assert!(admit_command(MemberRole::Human, true));
        assert!(admit_command(MemberRole::Internal, true));
        assert!(!admit_command(MemberRole::Advisor, true));
        // 建议 / 普通发言：任何角色都可（含 Advisor 献策）
        assert!(admit_command(MemberRole::Advisor, false));
        assert!(may_execute_command(MemberRole::Human));
        assert!(!may_execute_command(MemberRole::Advisor));
    }

    // ── 推选：AddressedFirst ──
    #[test]
    fn addressed_first_picks_addressed_highest_relevance() {
        let cands = vec![
            cand("a", MemberRole::Internal, false, 0.9),
            cand("b", MemberRole::Internal, true, 0.3),
            cand("c", MemberRole::Internal, true, 0.8),
        ];
        let (id, r) = select_next_speaker(&cands, ElectionMode::AddressedFirst, 0).unwrap();
        assert_eq!(id, "c"); // 被@里相关性最高
        assert_eq!(r, SpeakReason::Addressed);
    }

    #[test]
    fn addressed_first_falls_back_to_moderatable_when_none_addressed() {
        let cands = vec![
            cand("int", MemberRole::Internal, false, 0.2),
            cand("adv", MemberRole::Advisor, false, 0.99), // 相关性最高但不可主持
        ];
        let (id, r) = select_next_speaker(&cands, ElectionMode::AddressedFirst, 0).unwrap();
        // 没人被@ ⇒ 优先内部最高相关者；Advisor 不抢主持发言
        assert_eq!(id, "int");
        assert_eq!(r, SpeakReason::MostRelevant);
    }

    #[test]
    fn addressed_first_allows_advisor_when_only_advisors() {
        let cands = vec![
            cand("adv1", MemberRole::Advisor, false, 0.4),
            cand("adv2", MemberRole::Advisor, false, 0.9),
        ];
        let (id, _) = select_next_speaker(&cands, ElectionMode::AddressedFirst, 0).unwrap();
        assert_eq!(id, "adv2"); // 群里只剩 Advisor ⇒ 让最相关的献策（不主持）
    }

    // ── 推选：MostRelevant ──
    #[test]
    fn most_relevant_ignores_role() {
        let cands = vec![
            cand("int", MemberRole::Internal, false, 0.1),
            cand("adv", MemberRole::Advisor, false, 0.95),
        ];
        let (id, r) = select_next_speaker(&cands, ElectionMode::MostRelevant, 0).unwrap();
        assert_eq!(id, "adv"); // Advisor 也可被推选出声献策
        assert_eq!(r, SpeakReason::MostRelevant);
    }

    // ── 推选：RoundRobin ──
    #[test]
    fn round_robin_cycles() {
        let cands = vec![
            cand("x", MemberRole::Internal, false, 0.0),
            cand("y", MemberRole::Internal, false, 0.0),
            cand("z", MemberRole::Internal, false, 0.0),
        ];
        assert_eq!(select_next_speaker(&cands, ElectionMode::RoundRobin, 0).unwrap().0, "x");
        assert_eq!(select_next_speaker(&cands, ElectionMode::RoundRobin, 1).unwrap().0, "y");
        assert_eq!(select_next_speaker(&cands, ElectionMode::RoundRobin, 2).unwrap().0, "z");
        assert_eq!(select_next_speaker(&cands, ElectionMode::RoundRobin, 3).unwrap().0, "x");
    }

    #[test]
    fn empty_candidates_none() {
        assert!(select_next_speaker(&[], ElectionMode::MostRelevant, 0).is_none());
    }

    // ── 主持：Advisor 不能主持 ──
    #[test]
    fn moderator_excludes_advisor() {
        let cands = vec![
            cand("human", MemberRole::Human, false, 0.0),
            cand("adv", MemberRole::Advisor, false, 0.0),
        ];
        assert_eq!(elect_moderator(&cands), Some("human".into()));

        let only_adv = vec![cand("adv", MemberRole::Advisor, false, 0.0)];
        assert_eq!(elect_moderator(&only_adv), None); // 无可主持者 ⇒ 无主持
    }

    // ── 控麦 ──
    #[test]
    fn floor_claim_release_yield() {
        let mut f = Floor::default();
        assert!(f.claim("a")); // 麦空 ⇒ a 获得
        assert!(!f.claim("b")); // b 排队
        assert_eq!(f.holder.as_deref(), Some("a"));
        f.release("a"); // a 释放 ⇒ 队首 b 补位
        assert_eq!(f.holder.as_deref(), Some("b"));

        // yield：当前 holder 把麦让给指定者
        assert!(f.yield_to("b", "c"));
        assert_eq!(f.holder.as_deref(), Some("c"));
        assert!(!f.yield_to("b", "x")); // 不是 holder ⇒ 失败
    }

    // ── 发言许可（防同时说）──
    #[test]
    fn admit_speech_blocks_simultaneous() {
        let mut f = Floor::default();
        f.claim("a");
        assert!(admit_speech(&f, "a", false)); // holder 可说
        assert!(!admit_speech(&f, "b", false)); // 别人不能抢
        // 麦空 + 被@ ⇒ 可说（含 Advisor 被@献策）
        let empty = Floor::default();
        assert!(admit_speech(&empty, "adv", true));
        assert!(!admit_speech(&empty, "adv", false)); // 没被@就抢 ⇒ 拒绝
    }

    // ── 并发 Hub：去重 + 序号 + 冷却 ──
    #[test]
    fn hub_dedup_one_processing_per_message() {
        let h = Arc::new(DeliberationHub::new(1000));
        let d1 = h.ingest("m1", "u", &HashMap::new(), &[], 1, ElectionMode::MostRelevant, 0);
        let d2 = h.ingest("m1", "u", &HashMap::new(), &[], 2, ElectionMode::MostRelevant, 0);
        assert!(!d1.duplicate);
        assert!(d2.duplicate); // 同一消息第二次 ⇒ 去重
    }

    #[test]
    fn hub_seq_monotonic_unique() {
        let h = Arc::new(DeliberationHub::new(1000));
        let mut last = 0u64;
        for i in 0..50 {
            let d = h.ingest(&format!("m{i}"), "u", &HashMap::new(), &[], i as u64, ElectionMode::MostRelevant, 0);
            assert!(d.seq > last, "seq 必须严格递增");
            last = d.seq;
        }
    }

    #[test]
    fn hub_cooldown_blocks_repeat_speaker() {
        let h = Arc::new(DeliberationHub::new(10_000)); // 10s 冷却
        h.add_member("a", MemberRole::Internal);
        let mut rel = HashMap::new();
        rel.insert("a".to_string(), 1.0);
        let d1 = h.ingest("m1", "u", &rel, &["a".to_string()], 1_000, ElectionMode::MostRelevant, 0);
        assert!(d1.floor_granted && !d1.cooldown_blocked);
        // 同发言者 1ms 后再来一条 ⇒ 冷却拦下
        let d2 = h.ingest("m2", "u", &rel, &["a".to_string()], 1_001, ElectionMode::MostRelevant, 0);
        assert!(d2.cooldown_blocked);
        // 冷却窗口后 ⇒ 放行
        let d3 = h.ingest("m3", "u", &rel, &["a".to_string()], 20_000, ElectionMode::MostRelevant, 0);
        assert!(!d3.cooldown_blocked);
    }

    #[test]
    fn hub_advisor_not_commandable() {
        let h = Arc::new(DeliberationHub::new(1000));
        h.add_member("adv", MemberRole::Advisor);
        let mut rel = HashMap::new();
        rel.insert("adv".to_string(), 1.0);
        let d = h.ingest("m1", "u", &rel, &["adv".to_string()], 1, ElectionMode::MostRelevant, 0);
        assert_eq!(d.speaker_id.as_deref(), Some("adv"));
        assert!(!d.can_command); // 外部顾问不可命令
    }

    // ── 并发：多线程同吃一批消息，无竞争、序号唯一、去重生效 ──
    #[test]
    fn hub_concurrent_ingest_unique_seq_no_panic() {
        let h = Arc::new(DeliberationHub::new(1000));
        // 并发喂 32 条各异消息（不同 msg_id），断言：序号唯一 1..=32、无重复、不 panic
        let mut handles = vec![];
        for i in 0..32 {
            let h = h.clone();
            handles.push(thread::spawn(move || {
                h.ingest(
                    &format!("t{i}"),
                    "u",
                    &HashMap::new(),
                    &[],
                    i as u64 + 1,
                    ElectionMode::MostRelevant,
                    0,
                )
            }));
        }
        let mut seqs = vec![];
        for hd in handles {
            let d = hd.join().unwrap();
            assert!(!d.duplicate);
            seqs.push(d.seq);
        }
        seqs.sort_unstable();
        // 32 条各异消息 ⇒ 32 个唯一序号（并发下无重复、保序）
        assert_eq!(seqs, (1..=32).collect::<Vec<_>>());
    }

    // ── 轮转：每个发言者拿到麦后释放，下一轮易主；端口在多轮下被逐个触发 ──
    #[test]
    fn hub_turnover_emits_each_speaker() {
        let h = Arc::new(DeliberationHub::new(1000));
        let counter = Arc::new(Mutex::new(0usize));
        h.set_emit(Box::new({
            let counter = counter.clone();
            move |_, _| {
                *counter.lock().unwrap() += 1;
            }
        }));
        for i in 0..32 {
            let spk = format!("a{i}");
            h.add_member(&spk, MemberRole::Internal);
            let mut rel = HashMap::new();
            rel.insert(spk.clone(), 1.0);
            let d = h.ingest(
                &format!("m{i}"),
                "u",
                &rel,
                std::slice::from_ref(&spk),
                1, // 同一时刻，靠 release 轮转而非冷却
                ElectionMode::MostRelevant,
                0,
            );
            assert!(d.floor_granted, "第 {i} 轮应拿到麦");
            h.release_floor(&spk); // 一轮结束 ⇒ 释放，下一轮易主
        }
        assert_eq!(*counter.lock().unwrap(), 32); // 注入端口逐轮触发
    }

    // ── fail-closed：未注入 emit ⇒ 不动作 ──
    #[test]
    fn hub_fail_closed_without_emit() {
        let h = Arc::new(DeliberationHub::new(1000));
        h.add_member("a", MemberRole::Internal);
        let mut rel = HashMap::new();
        rel.insert("a".to_string(), 1.0);
        let d = h.ingest("m1", "u", &rel, &["a".to_string()], 1, ElectionMode::MostRelevant, 0);
        // 没有 emit 端口 ⇒ 决策照算（floor_granted），但不触发任何副作用（这里无端口，天然 fail-closed）
        assert!(d.floor_granted);
    }

    fn cand(id: &str, role: MemberRole, addressed: bool, relevance: f64) -> Candidate {
        Candidate {
            id: id.to_string(),
            role,
            addressed,
            relevance,
            last_spoke_ms: 0,
        }
    }
}
