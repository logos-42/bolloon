//! 群聊 / 内部商议的**后台执行**: 推举 → 并发调度 → 只把汇报落回群里 (HTTP 请求不阻塞)。
//!
//! 为什么单独一层: 之前 `room_start` 只写了一个 bool, `group_say` 只把人类那句话落块 ——
//! 群里永远只有自己说话 ("发消息无响应"), 商议推举算出来的 speaker 也没人执行 ("推举无反应")。
//! 这里把「谁该说话」变成真的后台任务: 每个被推举的智能体独立跑一轮模型调用,
//! 完成后把**结论**（不是思考过程）作为 `report` 事件写回同一个群, 前端轮询即可看到。
//!
//! 本批新增（警长 / 持续交流 / 任务）:
//! - **只汇报不跑进程**: 智能体后台跑任务, 群里只落结论 (`report`)。
//! - **持续交流 + 终止**: 监督器在「群运行态 + 距人类发言已沉默」时自驱下一轮; 任何智能体在汇报里写
//!   `[[terminate]]` 即宣布散会 (群回到待命)。无限次推进, 由终止信号收尾。
//! - **警长派任务**: 汇报里写 `[[task:<智能体id或名字>:<描述>]]` 即把任务分给该成员后台执行。
//!
//! 纪律:
//! - **不阻塞**: 调用方只等 `spawn_reports` 返回 (毫秒级), 模型调用在 tokio 任务里跑
//! - **并发**: 被 @ 的多个智能体各起一个任务, 互不排队
//! - **不重复**: 同一 (群, 智能体) 同时只跑一个 (`RoomBus::begin`)
//! - **不造假**: 失败就把失败原因作为汇报落进群, 不静默吞掉
//! - **fail-closed**: 无运行态 / 无候选时不动作, 不臆造

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use bolloon_llm::ChatMessage;

use crate::native::AgentView;
use crate::server::AppState;

/// 监督器自驱节奏: 距人类发言沉默超过此毫秒数, 且群仍运行 → 警长自驱下一轮。
/// 也避免「点完开聊」后立刻无限刷屏: 必须有这么一段沉默才续轮。
pub const SUPERVISOR_IDLE_MS: u64 = 15_000;

/// 群内"谁正在想"的运行时状态 (内存态, 不落盘: 重启后本来就没了)
#[derive(Default)]
pub struct RoomBus {
    inflight: Mutex<HashMap<String, BTreeSet<String>>>,
    /// 各群最近一次人类发言时间 (ms); 监督器据此判断"是否沉默可自驱"
    last_human_ms: Mutex<HashMap<String, u64>>,
    /// 各群当前阶段 (group → agent → 人话阶段)。前端据此显示「谁 正在想 · 哪一步」的流光,
    /// 工具调用/轮次这些细节只留在这里, 不进群消息正文。
    stages: Mutex<HashMap<String, HashMap<String, String>>>,
}

impl RoomBus {
    /// 该群当前在跑的智能体 id
    pub fn thinking(&self, gid: &str) -> Vec<String> {
        self.inflight
            .lock()
            .map(|m| m.get(gid).map(|s| s.iter().cloned().collect()).unwrap_or_default())
            .unwrap_or_default()
    }

    /// 记录某成员当前的阶段 (如「想下一步」「整理结论」)。空串 = 清掉。
    pub fn set_stage(&self, gid: &str, agent: &str, label: &str) {
        if let Ok(mut m) = self.stages.lock() {
            let e = m.entry(gid.to_string()).or_default();
            if label.is_empty() {
                e.remove(agent);
            } else {
                e.insert(agent.to_string(), label.to_string());
            }
            if e.is_empty() {
                m.remove(gid);
            }
        }
    }

    /// 该群在跑的成员 + 各自阶段（顺序稳定：按 id）
    pub fn thinking_detail(&self, gid: &str) -> Vec<(String, String)> {
        let ids = self.thinking(gid);
        let m = self.stages.lock().ok();
        ids.into_iter()
            .map(|id| {
                let stage = m
                    .as_ref()
                    .and_then(|s| s.get(gid))
                    .and_then(|e| e.get(&id).cloned())
                    .unwrap_or_default();
                (id, stage)
            })
            .collect()
    }

    pub fn is_thinking(&self, gid: &str, agent: &str) -> bool {
        self.inflight
            .lock()
            .map(|m| m.get(gid).map(|s| s.contains(agent)).unwrap_or(false))
            .unwrap_or(false)
    }

    /// 该群是否已无任何智能体在跑（监督器判断"本轮是否结束"）
    pub fn group_idle(&self, gid: &str) -> bool {
        self.inflight
            .lock()
            .map(|m| m.get(gid).map(|s| s.is_empty()).unwrap_or(true))
            .unwrap_or(true)
    }

    /// 记录一次人类发言（重置沉默计时，避免自驱抢在人类前面）
    pub fn mark_human(&self, gid: &str) {
        if let Ok(mut m) = self.last_human_ms.lock() {
            m.insert(gid.to_string(), chrono::Utc::now().timestamp_millis() as u64);
        }
    }

    pub fn last_human_ms(&self, gid: &str) -> u64 {
        self.last_human_ms
            .lock()
            .map(|m| m.get(gid).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    /// 抢一个 (群, 智能体) 的执行位; 已在跑则返回 false (同一条消息重复触发不会翻倍)
    fn begin(&self, gid: &str, agent: &str) -> bool {
        let Ok(mut m) = self.inflight.lock() else { return false };
        m.entry(gid.to_string()).or_default().insert(agent.to_string())
    }

    fn end(&self, gid: &str, agent: &str) {
        if let Ok(mut m) = self.inflight.lock() {
            if let Some(set) = m.get_mut(gid) {
                set.remove(agent);
                if set.is_empty() {
                    m.remove(gid);
                }
            }
        }
        self.set_stage(gid, agent, "");
    }
}

/// 推举: 被 @ 的内部智能体优先 (可多个 ⇒ 并发回应); 否则用商议中枢选的 speaker;
/// 再不行按 `cursor` 轮转 —— 群里总得有人接话, 不能"发了没人理"。
/// 一条群消息最多推举/接话的智能体数（群聊智能体上限；由 leo 2026-10-29 定为 1000）。
///
/// 它与成本直接相关：N 个 agent 各自一次模型调用 ⇒ 一条消息成本 = N × 单次成本。
/// 1000 上限下，一条消息在廉价档约 ¥3.4、旗舰档约 ¥106 —— 所以必须配合意图预算
/// (`default_max_model_calls`) 才有意义；没有预算闸就等于没有闸。
pub const MAX_ELECTED_AGENTS: usize = 1000;

/// 小群（≤ 这个人数）没有点名也让全员接话: 人少时并发成本可接受 (leo 2026-10-30)
pub const SMALL_GROUP_ALL_REPLY: usize = 3;

/// 群成员超过这个数就进入"小组长接话"模式（leo 2026-10-29 定：默认 >10 ⇒ 每轮 5 人）
pub const GROUP_LARGE_THRESHOLD: usize = 10;
/// 大群里每条消息默认允许接话的人数
pub const DEFAULT_REPLIES_WHEN_LARGE: usize = 5;

/// 大群组织：警长 1 + 小组长 5 + 领班 12 = 18 个"可直接回复"的成员（leo 2026-10-29 定）。
///
/// - 小组长：警长选出（同一套五特质评分），每条消息最多 5 个接话；
/// - 领班：由 5 个小组长一起选出（当前实现：评分排序后紧随小组长的 12 人），
///   负责把活派给其余成员；
/// - 其余成员**不直接刷群**，只接任务干活，重要结论才回群（异步协作）。
pub const LEADS_PER_GROUP: usize = 5;
pub const FOREMEN_PER_GROUP: usize = 12;
/// 可直接回复的总人数上限：1(警长) + 5(小组长) + 12(领班)
pub const DIRECT_REPLY_MAX: usize = 1 + LEADS_PER_GROUP + FOREMEN_PER_GROUP;

/// 一个群的组织名单（按评分排序切出来，三天随警长换届一起重算）
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct Roster {
    #[serde(default)]
    pub sheriff: Option<String>,
    #[serde(default)]
    pub leads: Vec<String>,
    #[serde(default)]
    pub foremen: Vec<String>,
}

impl Roster {
    /// 可以直接在群里发言的成员（警长 + 小组长 + 领班）
    pub fn eligible(&self) -> std::collections::BTreeSet<String> {
        let mut s = std::collections::BTreeSet::new();
        if let Some(x) = &self.sheriff {
            s.insert(x.clone());
        }
        s.extend(self.leads.iter().cloned());
        s.extend(self.foremen.iter().cloned());
        s
    }

    pub fn direct_reply_count(&self) -> usize {
        self.eligible().len()
    }

    /// 领班（派活的层）——其余成员由他们细分任务
    pub fn foreman_list(&self) -> &[String] {
        &self.foremen
    }
}

/// 从"已按分数降序排好的成员 id"切出组织名单：第 1 名警长，接着 5 小组长，再 12 领班。
pub fn roster_from_ranked(ranked: &[String]) -> Roster {
    let sheriff = ranked.first().cloned();
    let leads: Vec<String> = ranked
        .iter()
        .skip(1)
        .take(LEADS_PER_GROUP)
        .cloned()
        .collect();
    let foremen: Vec<String> = ranked
        .iter()
        .skip(1 + LEADS_PER_GROUP)
        .take(FOREMEN_PER_GROUP)
        .cloned()
        .collect();
    Roster { sheriff, leads, foremen }
}

/// 从组织名单里选出这一轮真正接话的人：@ 命中优先，其余按轮转补齐，且**只在名单内**。
///
/// 名单外的人不会因为被 @ 就直接刷群 —— 他们只能接任务（由领班派活）。
pub fn elect_from_roster(
    agents: &[AgentView],
    addressed: &[String],
    roster: &Roster,
    cursor: usize,
    limit: usize,
) -> Vec<AgentView> {
    let eligible = roster.eligible();
    if eligible.is_empty() {
        // 没有名单（人数不足 / 还没选举）⇒ 退回原逻辑
        return elect_limited(agents, addressed, None, cursor, limit);
    }
    let limit = limit.clamp(1, MAX_ELECTED_AGENTS);
    let inside: Vec<AgentView> = agents
        .iter()
        .filter(|a| eligible.contains(&a.id) || eligible.contains(&a.name))
        .cloned()
        .collect();
    if inside.is_empty() {
        return elect_limited(agents, addressed, None, cursor, limit);
    }
    elect_limited(&inside, addressed, None, cursor, limit)
}

/// 本次一条消息允许几个智能体接话。
///
/// - 警长显式设定（`sheriff_limit`）优先，并夹到 `MAX_ELECTED_AGENTS`；
/// - 否则按群规模：成员 ≤10 就按命中数，>10 只放 `DEFAULT_REPLIES_WHEN_LARGE` 个（默认 5）。
///
/// 目的：大群里"人人都接话"会把成本和延迟都放大 N 倍，改成警长选出的几个小组长接话，
/// 其余成员只接任务干活、有重要结论才回群 —— 异步协作，不刷屏。
pub fn reply_limit_for(members: usize, sheriff_limit: Option<usize>) -> usize {
    match sheriff_limit {
        Some(n) if n > 0 => n.min(MAX_ELECTED_AGENTS),
        _ => {
            if members > GROUP_LARGE_THRESHOLD {
                DEFAULT_REPLIES_WHEN_LARGE.min(members)
            } else {
                members.min(MAX_ELECTED_AGENTS)
            }
        }
    }
}

pub fn elect(
    agents: &[AgentView],
    addressed: &[String],
    speaker: Option<&str>,
    cursor: usize,
) -> Vec<AgentView> {
    elect_limited(agents, addressed, speaker, cursor, MAX_ELECTED_AGENTS)
}

/// 同 `elect`，但把"这一轮最多几个人接话"外置（警长设定 / 大群默认 5）。
pub fn elect_limited(
    agents: &[AgentView],
    addressed: &[String],
    speaker: Option<&str>,
    cursor: usize,
    limit: usize,
) -> Vec<AgentView> {
    let limit = limit.clamp(1, MAX_ELECTED_AGENTS);
    if agents.is_empty() {
        return vec![];
    }
    if !addressed.is_empty() {
        let needles: Vec<String> = addressed.iter().map(|s| s.to_lowercase()).collect();
        let hit: Vec<AgentView> = agents
            .iter()
            .filter(|a| {
                let id = a.id.to_lowercase();
                let name = a.name.to_lowercase();
                needles.iter().any(|n| id.contains(n) || name.contains(n))
            })
            .cloned()
            .collect();
        if !hit.is_empty() {
            // 一条消息最多推举这么多个智能体（2026-10-29 leo 定：群聊智能体上限 1000）。
            // 注意：这是**产品上限**，不是成本上限 —— 1000 个 agent 各自一次模型调用，
            // 一条消息的现金成本就是单次的 1000 倍。真正的成本闸在意图预算
            // (`economic.default_max_model_calls`) 上，两者必须一起用。
            return hit.into_iter().take(limit).collect();
        }
    }
    if let Some(sp) = speaker {
        if let Some(a) = agents.iter().find(|a| a.id == sp) {
            return vec![a.clone()];
        }
    }
    vec![agents[cursor % agents.len()].clone()]
}

/// 起后台任务: 每个目标智能体各跑一轮, 结束后把汇报写回群里。
/// 群内一轮的**根意图 id**：一条人类消息（或一次自驱）触发的所有 agent 调用共用它。
/// 这样"一条群消息总共花了多少、哪几个 agent 各花了多少"能从账本按 intent 直接查出来。
pub fn group_intent(gid: &str, ts_ms: u64) -> String {
    format!("group:{gid}:{ts_ms}")
}

pub fn spawn_reports(
    st: AppState,
    gid: String,
    trigger: String,
    targets: Vec<AgentView>,
    intent_id: String,
) {
    // 2026-10-31 实测到的问题: 人类在「开场轮」还没跑完时说话, 忙的成员会被静默跳过 ⇒
// 那句话只有 transcript 里有、却没人接。现在记下被跳过的人数, 没有人接就在 5s 后补一轮。
    let busy: Vec<AgentView> = targets
        .iter()
        .filter(|a| st.room_bus.is_thinking(&gid, &a.id))
        .cloned()
        .collect();
    if !busy.is_empty() {
        let st_r = st.clone();
        let gid_r = gid.clone();
        let trigger_r = trigger.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let still: Vec<AgentView> = busy
                .into_iter()
                .filter(|a| !st_r.room_bus.is_thinking(&gid_r, &a.id))
                .collect();
            if still.is_empty() {
                return;
            }
            tracing::info!(group = %gid_r, n = still.len(), "开场轮忙 ⇒ 5s 后补派这几位接话");
            let intent = group_intent(&gid_r, chrono::Utc::now().timestamp_millis() as u64);
            spawn_reports(st_r, gid_r, trigger_r, still, intent);
        });
    }
    for agent in targets {
        let st = st.clone();
        let gid = gid.clone();
        let trigger = trigger.clone();
        let intent_id = intent_id.clone();
        tokio::spawn(async move {
            if !st.room_bus.begin(&gid, &agent.id) {
                return;
            }
            st.room_bus.set_stage(&gid, &agent.id, "想一想");
            let text = match agent_turn(&st, &gid, &agent, &trigger, &intent_id).await {
                Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
                Ok(_) => format!("（{} 这一轮没有产出内容）", agent.name),
                Err(e) => format!("⚠ {} 没能完成这次汇报: {e}", agent.name),
            };
            st.room_bus.end(&gid, &agent.id);

            // 解析控制标记: [[terminate]] 宣布散会 / [[task:id:desc]] 派任务 (纯解析, 不触碰 I/O)
            let (clean, terminate, tasks, vetoes) = parse_control(&text);
            let now = chrono::Utc::now().timestamp_millis() as u64;

            // 终止: 群回到待命 + 落一条系统消息
            if terminate {
                {
                    let mut fs = st.forge.lock().await;
                    fs.room_running.insert(gid.clone(), false);
                }
                let _ = st.groups.append(
                    &gid,
                    &st.identity,
                    "system",
                    &agent.id,
                    &format!("{} 宣布散会，本场交流结束。", agent.name),
                    None,
                    now,
                );
            }

            // 汇报正文（去掉标记 + 工具调用噪声后）落群：
            // 群里只放人话结论 —— 工具过程属于后台, 前端用阶段流光表达, 不刷群
            let clean = strip_tool_noise(&clean);
            if !clean.is_empty() {
                if let Err(e) = st.groups.append(
                    &gid,
                    &st.identity,
                    "report",
                    &agent.id,
                    &clean,
                    None,
                    now,
                ) {
                    tracing::warn!(group = %gid, agent = %agent.id, error = %e, "群汇报落块失败");
                }
            }

            // ── 群内任务：**只有警长派单才执行** ──
            // 2026-10-31 (leo: 跑任务时警长的作用没出现): 以前谁写 [[task:…]] 都直接派下去。
            // 现在非警长的任务只进"待派"队列并在群里留提案，警长下一轮会在自己的上下文里
            // 看到这些提案，用 [[task:…]] 正式派单 (或明确否掉)。
            if !tasks.is_empty() {
                let sheriff = crate::native::elect_group_sheriff(&st, &gid).await;
                let is_sheriff = sheriff.as_deref() == Some(agent.id.as_str());
                // 人类这一轮的命令 ⇒ 直接执行（leo: 用户的命令也要执行, 不能等警长）
                let human_origin = !trigger.starts_with("（系统）")
                    && !trigger.starts_with("（任务分配")
                    && !trigger.starts_with("（任务分配·");
                let immediate = is_sheriff || human_origin;
                let now_t = chrono::Utc::now().timestamp_millis() as u64;
                for (tid, desc) in tasks {
                    let target = {
                        let fs = st.forge.lock().await;
                        fs.agents
                            .iter()
                            .find(|a| a.id == tid || a.name == tid)
                            .cloned()
                    };
                    let Some(t) = target else { continue };
                    {
                        let mut fs = st.forge.lock().await;
                        let seq = fs.room_tasks.len() + 1;
                        fs.room_tasks.push(crate::native::RoomTask {
                            id: format!("rt-{now_t}-{seq}"),
                            group_id: gid.clone(),
                            target: t.id.clone(),
                            desc: desc.clone(),
                            proposed_by: agent.id.clone(),
                            status: if immediate { "dispatched" } else { "proposed" }.into(),
                            source: if human_origin { "human" } else { "agent" }.into(),
                            created_at_ms: now_t,
                        });
                        if fs.room_tasks.len() > 200 {
                            let cut = fs.room_tasks.len() - 200;
                            fs.room_tasks.drain(0..cut);
                        }
                        fs.save(&crate::server::data_dir());
                    }
                    if immediate {
                        spawn_reports(
                            st.clone(),
                            gid.clone(),
                            format!("（任务分配·警长派单）{} 交给你：{}", agent.name, desc),
                            vec![t],
                            group_intent(&gid, chrono::Utc::now().timestamp_millis() as u64),
                        );
                    } else {
                        // 留提案: 警长下一轮会看到 (见 agent_turn 里的待派队列)
                        let sh_name = sheriff.clone().unwrap_or_default();
                        let _ = st.groups.append(
                            &gid,
                            &st.identity,
                            "system",
                            &agent.id,
                            &format!(
                                "（提案）{} 建议把「{}」交给 {} —— 警长 {} 可否掉；{}s 内没人处理就自动执行",
                                agent.name,
                                desc,
                                t.name,
                                if sh_name.is_empty() { "（未选出）" } else { sh_name.as_str() },
                                crate::native::ROOM_TASK_AUTO_DISPATCH_MS / 1000
                            ),
                            None,
                            now_t,
                        );
                    }
                }
            }

            // 警长否决: 把该目标还挂着的提案标成 rejected (真的不执行, 不是嘴上说)
            if !vetoes.is_empty() {
                let mut fs = st.forge.lock().await;
                let mut hit = 0usize;
                for v in &vetoes {
                    for t in fs.room_tasks.iter_mut() {
                        if t.group_id == gid && t.status == "proposed" && (&t.target == v || t.desc.contains(v.as_str())) {
                            t.status = "rejected".into();
                            hit += 1;
                        }
                    }
                }
                if hit > 0 {
                    fs.save(&crate::server::data_dir());
                    drop(fs);
                    let _ = st.groups.append(
                        &gid, &st.identity, "system", &agent.id,
                        &format!("{}（警长）否掉了 {} 条待派提案。", agent.name, hit), None, now,
                    );
                }
            }
            // 到期的提案自动派下去 (主动性: 警长忙/不在场也不停摆)
            sweep_due_tasks(st.clone(), gid.clone()).await;

            // 监督器: 本轮最后一个完成 && 群仍运行 && 距人类发言已沉默 → 自驱下一轮（无限推进）
            if st.room_bus.group_idle(&gid) {
                let running = st
                    .forge
                    .lock()
                    .await
                    .room_running
                    .get(&gid)
                    .copied()
                    .unwrap_or(false);
                let idle = now.saturating_sub(st.room_bus.last_human_ms(&gid));
                if running && idle >= SUPERVISOR_IDLE_MS {
                    let st2 = st.clone();
                    let gid2 = gid.clone();
                    tokio::spawn(async move {
                        continue_round(st2, gid2).await;
                    });
                }
            }
        });
    }
}

/// 监督器续轮: 群仍运行则让候选成员继续推进（警长自驱）。自驱的回合本身结束后会再次被监督器续上,
/// 形成"无限次"持续推进, 直到某智能体 [[terminate]] 收尾。
/// 扫描到期的提案任务, 自动派给目标成员后台执行（不收钱、不等警长）。
///
/// 主动性规则: 智能体可以自己提议/自己动手; 警长拥有的是**优先派单**和**否决权**,
/// 而不是唯一的闸门 —— 否则警长一忙, 整场就静止。
pub async fn sweep_due_tasks(st: AppState, gid: String) {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let mut due: Vec<crate::native::RoomTask> = Vec::new();
    {
        let mut fs = st.forge.lock().await;
        for t in fs.room_tasks.iter_mut() {
            if t.group_id == gid && crate::native::should_auto_dispatch(t, now) {
                t.status = "dispatched".into();
                due.push(t.clone());
            }
        }
        if !due.is_empty() {
            fs.save(&crate::server::data_dir());
        }
    }
    for t in due {
        let target = {
            let fs = st.forge.lock().await;
            fs.agents.iter().find(|a| a.id == t.target).cloned()
        };
        let Some(tg) = target else { continue };
        let _ = st.groups.append(
            &gid,
            &st.identity,
            "system",
            "system",
            &format!(
                "（自动派单）提案「{}」等待 {}s 无人处理，按主动性规则交给 {}。",
                t.desc,
                crate::native::ROOM_TASK_AUTO_DISPATCH_MS / 1000,
                tg.name
            ),
            None,
            now,
        );
        spawn_reports(
            st.clone(),
            gid.clone(),
            format!("（任务分配·提案到期）交给你：{}", t.desc),
            vec![tg],
            group_intent(&gid, now),
        );
    }
}

pub async fn continue_round(st: AppState, gid: String) {
    let running = st
        .forge
        .lock()
        .await
        .room_running
        .get(&gid)
        .copied()
        .unwrap_or(false);
    if !running {
        return;
    }
    let targets = {
        let fs = st.forge.lock().await;
        crate::native::room_candidate_agents(&fs, &gid)
    };
    if targets.is_empty() {
        return;
    }
    let trigger = "（系统）请继续推进本群议题：可继续发言、分配任务，或若已无共识空间则用 [[terminate]] 宣布散会。".to_string();
    let intent = group_intent(&gid, chrono::Utc::now().timestamp_millis() as u64);
    sweep_due_tasks(st.clone(), gid.clone()).await;
    spawn_reports(st, gid, trigger, targets, intent);
}

/// 单轮群内回复: 用**这个智能体自己的身份**(名字/persona 覆盖) + 群最近上下文
async fn agent_turn(
    st: &AppState,
    gid: &str,
    agent: &AgentView,
    trigger: &str,
    intent_id: &str,
) -> Result<String, String> {
    let hist = st.groups.history(gid, 16).unwrap_or_default();
    let group_name = st
        .groups
        .list_groups()
        .iter()
        .find(|g| g.id == gid)
        .map(|g| g.name.clone())
        .unwrap_or_default();
    let names: HashMap<String, String> = {
        let fs = st.forge.lock().await;
        fs.agents.iter().map(|a| (a.id.clone(), a.name.clone())).collect()
    };
    let mut transcript = String::new();
    for m in &hist {
        let who = names.get(&m.from).cloned().unwrap_or_else(|| short(&m.from));
        transcript.push_str(&format!("[{}] {}\n", who, m.text));
    }
    let extra = format!(
        "\n\n# 群聊现场\n你在群「{group_name}」里，正在以群成员身份接话。\n\
         最近的消息：\n{transcript}\n\
         对方刚说：{trigger}\n\n\
         只输出你要发到群里的那段话：结论 / 汇报 / 直接回答。\n\
         - 不要复述思考过程、不要输出工具调用或 JSON（不要写 <tool_call>/<tool_use>/函数调用块）\n\
         - 不要自称助手；用你自己的名字说话\n\
         - 没把握就直说不确定，不编造\n\
         - 若你认为本场已无共识空间，可在结尾写上 [[terminate]] 宣布散会\n\
         - 警长可在结尾写上 [[task:智能体id或名字:任务描述]] 把任务分配给某位成员后台执行"
    );
    // 警长能看到"待派"提案: 这样"别人提、警长批"才真的闭环
    let (extra, proposals) = {
        let fs = st.forge.lock().await;
        let sheriff = fs.sheriff_by_group.get(gid).cloned().unwrap_or_default();
        if sheriff == agent.id {
            let pend: Vec<String> = fs
                .room_tasks
                .iter()
                .filter(|t| t.group_id == gid && t.status == "proposed")
                .map(|t| format!("- {} 想让 {} 做：{}", t.proposed_by, t.target, t.desc))
                .collect();
            if pend.is_empty() {
                (extra, String::new())
            } else {
                let mut e = extra;
                e.push_str("\n\n# 你是本群警长，有待派任务单\n");
                e.push_str(&pend.join("\n"));
                e.push_str(
                    "\n要派就用 [[task:智能体id:任务描述]] 写进回复；不认可的可以明确说不派。",
                );
                (e, pend.join(" | "))
            }
        } else {
            (extra, String::new())
        }
    };
    let _ = &proposals;
    let system = crate::native::build_web_system(st, trigger, Some(agent), &extra).await;
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: trigger.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: vec![],
    reasoning_content: None,
}];
    // 2026-10-31 (leo: 群里说要跑 find 却没真的跑): 群内回合以前只调一次模型 ⇒ **只说不做**。
    // 现在按运行时设置走 harness + kernel loop：能真读文件、真跑命令、真的自纠多步。
    // 关掉 `runtime.tools` 才退回"纯发言"那条单次调用 (计量口径不变, 只是不执行)。
    let rt = {
        let fs = st.forge.lock().await;
        fs.room_runtime.clone()
    };
    if rt.tools {
        return crate::native::room_turn_exec(st, gid, agent, trigger, &extra, intent_id).await;
    }
    // 走**计量咽喉**：一条人类消息触发的多个 agent 调用共用同一个根意图
    crate::native::call_model_metered(
        st,
        &system,
        messages,
        Some(crate::native::EconCtx {
            intent_id: intent_id.to_string(),
            group_id: Some(gid.to_string()),
            agent_id: Some(agent.id.clone()),
            bill_did: None,
            surface: "web-room".to_string(),
        }),
    )
    .await
}

/// 去掉模型在群里"表演"出来的工具调用痕迹（纯函数）。
///
/// 群内回合**不提供工具**（只发言），但模型有时仍会输出 `<tool_call>{…}</tool_call>`、
/// `<tool_use>` 或带 "tool_call" 的代码块 —— 这些进群就是噪声，且会让用户以为"它在群里调工具了"。
/// 工具过程属于后台，前端用阶段流光表达。
pub fn strip_tool_noise(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        // 成对标签: <tool_call>…</tool_call> / <tool_use>…</tool_use>
        let mut hit: Option<(usize, usize)> = None;
        for tag in ["tool_call", "tool_use", "function_call"] {
            let open = format!("<{tag}>");
            if let Some(a) = rest.find(&open) {
                let close = format!("</{tag}>");
                if let Some(b) = rest[a..].find(&close) {
                    let end = a + b + close.len();
                    if hit.map(|(s, _)| a < s).unwrap_or(true) {
                        hit = Some((a, end));
                    }
                } else {
                    hit = Some((a, rest.len())); // 没闭合: 从这里全丢
                }
            }
        }
        // 代码块: ```json … "tool_call" … ```
        if let Some(a) = rest.find("```") {
            if let Some(b) = rest[a + 3..].find("```") {
                let end = a + 3 + b + 3;
                let block = &rest[a..end];
                if (block.contains("tool_call") || block.contains("tool_use") || block.contains("\"arguments\""))
                    && hit.map(|(s, _)| a < s).unwrap_or(true) {
                        hit = Some((a, end));
                    }
            }
        }
        match hit {
            Some((a, b)) => {
                out.push_str(&rest[..a]);
                rest = &rest[b..];
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    // 去掉剥离后留下的空行堆积
    let lines: Vec<&str> = out.lines().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut blank = 0;
    for l in lines {
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        kept.push(l);
    }
    kept.join("\n").trim().to_string()
}

/// 解析汇报里的控制标记（纯函数）。返回 (去掉标记后的正文, 是否终止, 派发的任务列表)。
pub fn parse_control(text: &str) -> (String, bool, Vec<(String, String)>, Vec<String>) {
    let mut terminate = false;
    let mut tasks: Vec<(String, String)> = Vec::new();
    let mut vetoes: Vec<String> = Vec::new();
    let mut out = String::new();
    let mut i = 0usize;
    let len = text.len();
    while i < len {
        let rest = &text[i..];
        match rest.find("[[") {
            None => {
                out.push_str(rest);
                break;
            }
            Some(rel) => {
                let abs = i + rel;
                out.push_str(&text[i..abs]);
                match rest[rel..].find("]]") {
                    None => {
                        out.push_str(&text[abs..]);
                        break;
                    }
                    Some(end_rel) => {
                        let end = abs + end_rel;
                        let inner = text[abs + 2..end].trim();
                        if inner.eq_ignore_ascii_case("terminate") {
                            terminate = true;
                        } else if let Some(spec) = inner.strip_prefix("task:").map(|s| s.trim()) {
                            if let Some((id, desc)) = spec.split_once(':') {
                                tasks.push((id.trim().to_string(), desc.trim().to_string()));
                            }
                        } else if let Some(spec) = inner.strip_prefix("veto:").map(|s| s.trim()) {
                            // 警长否决: [[veto:<目标 id 或名字>]] ⇒ 该目标待派提案一律不执行
                            if !spec.is_empty() {
                                vetoes.push(spec.to_string());
                            }
                        }
                        i = end + 2;
                    }
                }
            }
        }
    }
    (out.trim().to_string(), terminate, tasks, vetoes)
}

fn short(s: &str) -> String {
    if s.len() <= 18 { s.to_string() } else { format!("{}…", &s[..16]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 主动性: 提案到期自动派单; 已派发/被否决的不重复派
    #[test]
    fn proposals_auto_dispatch_after_window_but_not_before() {
        let t = crate::native::RoomTask {
            id: "rt-1".into(),
            group_id: "g".into(),
            target: "a1".into(),
            desc: "跑 ls".into(),
            proposed_by: "a2".into(),
            status: "proposed".into(),
            source: "agent".into(),
            created_at_ms: 1_000,
        };
        assert!(
            !crate::native::should_auto_dispatch(&t, 1_000 + 59_999),
            "窗口内先等警长"
        );
        assert!(
            crate::native::should_auto_dispatch(&t, 1_000 + 60_000),
            "到期必须自动执行, 不能因为警长没空就永远不派"
        );
        let mut done = t.clone();
        done.status = "dispatched".into();
        assert!(!crate::native::should_auto_dispatch(&done, u64::MAX), "已派发不重复派");
        let mut rej = t;
        rej.status = "rejected".into();
        assert!(!crate::native::should_auto_dispatch(&rej, u64::MAX), "被警长否掉的不执行");
    }

    /// 警长否决标记: 解析出来并从正文里去掉
    #[test]
    fn veto_marker_is_parsed_and_stripped() {
        let (clean, term, tasks, vetoes) = parse_control("这条先不派 [[veto:agent-002]]");
        assert!(tasks.is_empty());
        assert_eq!(vetoes, vec!["agent-002".to_string()]);
        assert!(!term);
        assert!(!clean.contains("veto"), "否决标记不该出现在群里: {clean}");
    }

    /// 大群组织：警长 1 + 小组长 5 + 领班 12 = 18 人可直接回复，其余只接任务。
    #[test]
    fn roster_splits_into_one_five_twelve() {
        let ranked: Vec<String> = (0..100).map(|i| format!("a{i}")).collect();
        let r = roster_from_ranked(&ranked);
        assert_eq!(r.sheriff.as_deref(), Some("a0"), "第 1 名当警长");
        assert_eq!(r.leads.len(), 5, "5 个小组长");
        assert_eq!(r.foremen.len(), 12, "12 个领班");
        assert_eq!(r.direct_reply_count(), 18, "合计 18 人可直接回复");
        assert_eq!(r.direct_reply_count(), DIRECT_REPLY_MAX);
        assert_eq!(r.leads[0], "a1");
        assert_eq!(r.foremen[0], "a6", "领班紧跟小组长之后");

        // 小群/人不齐：只切得出几个人就几个人，不凭空造
        let few = roster_from_ranked(&ranked[..3]);
        assert_eq!(few.sheriff.as_deref(), Some("a0"));
        assert_eq!(few.leads.len(), 2);
        assert!(few.foremen.is_empty());
        assert_eq!(few.direct_reply_count(), 3);
    }

    /// 名单外的人被 @ 也不能直接刷群（他们只接领班派的任务）。
    #[test]
    fn addressed_outside_roster_do_not_speak() {
        let ranked: Vec<String> = (0..40).map(|i| format!("a{i}")).collect();
        let roster = roster_from_ranked(&ranked);
        let agents: Vec<AgentView> = (0..40).map(|i| agent(&format!("a{i}"), &format!("名字{i}"))).collect();

        // @ 一个名单外的 id（a30）
        let picked = elect_from_roster(&agents, &["a30".into()], &roster, 0, 5);
        assert!(
            picked.iter().all(|p| p.id != "a30"),
            "名单外的人不许因为被 @ 就开口: {:?}",
            picked.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
        assert!(!picked.is_empty(), "但名单内的人仍要接话");

        // @ 名单内的领班（a10 = 第 11 名 ⇒ 领班）
        let picked2 = elect_from_roster(&agents, &["a10".into()], &roster, 0, 5);
        assert_eq!(picked2.len(), 1);
        assert_eq!(picked2[0].id, "a10", "名单内被 @ 的人必须优先接话");

        // 名单为空的群退回旧逻辑（不因名单缺失而失声）
        let empty = Roster::default();
        assert!(!elect_from_roster(&agents, &[], &empty, 0, 5).is_empty());
    }

    /// 大群默认只让 5 个小组长接话（leo 2026-10-29 定），小群按需全开，警长可覆盖。
    #[test]
    fn reply_limit_follows_size_and_sheriff() {
        assert_eq!(reply_limit_for(3, None), 3, "小群：命中几个就几个");
        assert_eq!(reply_limit_for(10, None), 10, "刚好 10 人仍算小群");
        assert_eq!(reply_limit_for(11, None), DEFAULT_REPLIES_WHEN_LARGE, ">10 默认 5");
        assert_eq!(reply_limit_for(1000, None), 5, "再大也只 5 个接话");
        assert_eq!(reply_limit_for(1000, Some(7)), 7, "警长可放大/缩小");
        assert_eq!(reply_limit_for(5, Some(2000)), MAX_ELECTED_AGENTS, "警长也不能越过产品上限");
        assert_eq!(reply_limit_for(5, Some(0)), 5, "0 视为未设定, 回落默认");

        // 12 个成员都被 @：限 5 时只推 5 个（不刷屏、不炸成本）
        let many: Vec<AgentView> = (0..12).map(|i| agent(&format!("m{i}"), "小星")).collect();
        let picked = elect_limited(&many, &["小星".to_string()], None, 0, reply_limit_for(12, None));
        assert_eq!(picked.len(), 5);
    }

    /// 群聊智能体上限 = 1000（leo 2026-10-29 定）：@ 到一大批人时推举数不许被截成 3。
    /// 同时钉住"不超过上限"—— 上限本身也是成本闸的前提。
    #[test]
    fn elect_is_capped_at_one_thousand_not_three() {
        let many: Vec<AgentView> = (0..1200).map(|i| agent(&format!("a{i}"), "小星")).collect();
        let picked = elect(&many, &["小星".to_string()], None, 0);
        assert_eq!(picked.len(), MAX_ELECTED_AGENTS, "上限 1000");
        assert_eq!(MAX_ELECTED_AGENTS, 1000, "上限值本身钉死");
        assert!(picked.len() > 3, "不许再退回旧的 3 人截断");

        // 不足上限时按命中数推举
        let few: Vec<AgentView> = (0..5).map(|i| agent(&format!("b{i}"), "小星")).collect();
        assert_eq!(elect(&few, &["小星".to_string()], None, 0).len(), 5);
        // 没被 @ 时仍然只推 1 个（轮转），不会因为上限变大人人开口
        assert_eq!(elect(&many, &[], None, 7).len(), 1);
    }

    fn agent(id: &str, name: &str) -> AgentView {
        AgentView {
            owner_did: String::new(),
            owner_signature: String::new(),
            id: id.into(),
            name: name.into(),
            did: format!("did:pi:{id}"),
            avatar: String::new(),
            persona: String::new(),
            workspace: String::new(),
            global_dir: String::new(),
            created_at_ms: 0,
        }
    }

    /// @ 到谁就谁回 (可多个 = 并发), 名字和 id 都认
    #[test]
    fn addressed_wins_and_multiple_are_parallel() {
        let agents = vec![agent("agent-001", "小宝"), agent("agent-002", "阿道")];
        let picked = elect(&agents, &["小宝".into(), "agent-002".into()], None, 0);
        assert_eq!(picked.len(), 2);
        let none = elect(&agents, &["不存在".into()], Some("agent-001"), 0);
        assert_eq!(none.len(), 1, "点名不到人时回落商议推举的 speaker");
    }

    /// 没人被 @ 也必须有人接话 (轮转), 否则就是"发消息无响应"
    #[test]
    fn fallback_round_robin() {
        let agents = vec![agent("a1", "A"), agent("a2", "B")];
        assert_eq!(elect(&agents, &[], None, 0)[0].id, "a1");
        assert_eq!(elect(&agents, &[], None, 1)[0].id, "a2");
        assert_eq!(elect(&agents, &[], None, 2)[0].id, "a1");
    }

    /// 空成员表 → 没人可推 (不 panic)
    #[test]
    fn no_agents_no_targets() {
        assert!(elect(&[], &["x".into()], Some("x"), 0).is_empty());
    }

    /// 同一 (群, 智能体) 同时只许跑一份
    #[test]
    fn inflight_dedup() {
        let bus = RoomBus::default();
        assert!(bus.begin("g", "a1"));
        assert!(!bus.begin("g", "a1"));
        assert!(bus.is_thinking("g", "a1"));
        bus.end("g", "a1");
        assert!(!bus.is_thinking("g", "a1"));
        assert!(bus.begin("g", "a1"));
    }

    /// 控制标记解析: terminate + task
    #[test]
    fn parse_control_markers() {
        let (clean, term, tasks, _vetoes) =
            parse_control("我觉得可以推进。[[terminate]]");
        assert!(term);
        assert_eq!(clean, "我觉得可以推进。");
        assert!(tasks.is_empty());

        let (clean, term, tasks, _vetoes) = parse_control(
            "请你去查一下资料[[task:agent-002:调研竞品定价]]，我同步整理结论。",
        );
        assert!(!term);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].0, "agent-002");
        assert_eq!(tasks[0].1, "调研竞品定价");
        assert_eq!(clean, "请你去查一下资料，我同步整理结论。");
    }

    /// 群里不出现模型表演的工具调用块；正常正文原样保留。
    #[test]
    fn strip_tool_noise_keeps_prose() {
        let raw = "我先查一下。\n<tool_call>{\"name\":\"read_file\"}</tool_call>\n结论：没问题。";
        assert_eq!(strip_tool_noise(raw), "我先查一下。\n\n结论：没问题。");
        let fenced = "看这个\n```json\n{\"tool_call\":{\"name\":\"shell\"}}\n```\n已处理完。";
        let out = strip_tool_noise(fenced);
        assert!(!out.contains("tool_call"), "工具块必须剥掉: {out}");
        assert!(out.contains("已处理完。"));
        // 普通代码块不是工具调用: 不动
        let plain = "示例：\n```rust\nfn main() {}\n```";
        assert!(strip_tool_noise(plain).contains("fn main"));
    }

    #[test]
    fn parse_control_no_markers() {
        let (clean, term, tasks, _vetoes) = parse_control("普通发言，没有标记。");
        assert!(!term);
        assert!(tasks.is_empty());
        assert_eq!(clean, "普通发言，没有标记。");
    }
}
