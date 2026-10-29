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
}

impl RoomBus {
    /// 该群当前在跑的智能体 id
    pub fn thinking(&self, gid: &str) -> Vec<String> {
        self.inflight
            .lock()
            .map(|m| m.get(gid).map(|s| s.iter().cloned().collect()).unwrap_or_default())
            .unwrap_or_default()
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
    }
}

/// 推举: 被 @ 的内部智能体优先 (可多个 ⇒ 并发回应); 否则用商议中枢选的 speaker;
/// 再不行按 `cursor` 轮转 —— 群里总得有人接话, 不能"发了没人理"。
pub fn elect(
    agents: &[AgentView],
    addressed: &[String],
    speaker: Option<&str>,
    cursor: usize,
) -> Vec<AgentView> {
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
            // 并发上限 3: 群里一次 @ 五个智能体不该把本机拖死
            return hit.into_iter().take(3).collect();
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
pub fn spawn_reports(st: AppState, gid: String, trigger: String, targets: Vec<AgentView>) {
    for agent in targets {
        let st = st.clone();
        let gid = gid.clone();
        let trigger = trigger.clone();
        tokio::spawn(async move {
            if !st.room_bus.begin(&gid, &agent.id) {
                return;
            }
            let text = match agent_turn(&st, &gid, &agent, &trigger).await {
                Ok(t) if !t.trim().is_empty() => t.trim().to_string(),
                Ok(_) => format!("（{} 这一轮没有产出内容）", agent.name),
                Err(e) => format!("⚠ {} 没能完成这次汇报: {e}", agent.name),
            };
            st.room_bus.end(&gid, &agent.id);

            // 解析控制标记: [[terminate]] 宣布散会 / [[task:id:desc]] 派任务 (纯解析, 不触碰 I/O)
            let (clean, terminate, tasks) = parse_control(&text);
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

            // 汇报正文（去掉标记后）落群
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

            // 警长派发的任务: 分给对应成员后台执行（仍是"只汇报不跑进程"）
            for (tid, desc) in tasks {
                let target = {
                    let fs = st.forge.lock().await;
                    fs.agents
                        .iter()
                        .find(|a| a.id == tid || a.name == tid)
                        .cloned()
                };
                if let Some(t) = target {
                    spawn_reports(
                        st.clone(),
                        gid.clone(),
                        format!("（任务分配）{} 交给你：{}", agent.name, desc),
                        vec![t],
                    );
                }
            }

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
    spawn_reports(st, gid, trigger, targets);
}

/// 单轮群内回复: 用**这个智能体自己的身份**(名字/persona 覆盖) + 群最近上下文
async fn agent_turn(
    st: &AppState,
    gid: &str,
    agent: &AgentView,
    trigger: &str,
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
         - 不要复述思考过程、不要输出工具调用或 JSON\n\
         - 不要自称助手；用你自己的名字说话\n\
         - 没把握就直说不确定，不编造\n\
         - 若你认为本场已无共识空间，可在结尾写上 [[terminate]] 宣布散会\n\
         - 警长可在结尾写上 [[task:智能体id或名字:任务描述]] 把任务分配给某位成员后台执行"
    );
    let system = crate::native::build_web_system(st, trigger, Some(agent), &extra).await;
    let messages = vec![ChatMessage {
        role: "user".into(),
        content: trigger.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: vec![],
    }];
    crate::native::call_model(st, &system, messages).await
}

/// 解析汇报里的控制标记（纯函数）。返回 (去掉标记后的正文, 是否终止, 派发的任务列表)。
pub fn parse_control(text: &str) -> (String, bool, Vec<(String, String)>) {
    let mut terminate = false;
    let mut tasks: Vec<(String, String)> = Vec::new();
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
                        }
                        i = end + 2;
                    }
                }
            }
        }
    }
    (out.trim().to_string(), terminate, tasks)
}

fn short(s: &str) -> String {
    if s.len() <= 18 { s.to_string() } else { format!("{}…", &s[..16]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent(id: &str, name: &str) -> AgentView {
        AgentView {
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
        let (clean, term, tasks) =
            parse_control("我觉得可以推进。[[terminate]]");
        assert!(term);
        assert_eq!(clean, "我觉得可以推进。");
        assert!(tasks.is_empty());

        let (clean, term, tasks) = parse_control(
            "请你去查一下资料[[task:agent-002:调研竞品定价]]，我同步整理结论。",
        );
        assert!(!term);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].0, "agent-002");
        assert_eq!(tasks[0].1, "调研竞品定价");
        assert_eq!(clean, "请你去查一下资料，我同步整理结论。");
    }

    #[test]
    fn parse_control_no_markers() {
        let (clean, term, tasks) = parse_control("普通发言，没有标记。");
        assert!(!term);
        assert!(tasks.is_empty());
        assert_eq!(clean, "普通发言，没有标记。");
    }
}
