//! 群聊 / 内部商议的**后台执行**: 推举 → 并发调度 → 只把汇报落回群里 (HTTP 请求不阻塞)。
//!
//! 为什么单独一层: 之前 `room_start` 只写了一个 bool, `group_say` 只把人类那句话落块 ——
//! 群里永远只有自己说话 ("发消息无响应"), 商议推举算出来的 speaker 也没人执行 ("推举无反应")。
//! 这里把「谁该说话」变成真的后台任务: 每个被推举的智能体独立跑一轮模型调用,
//! 完成后把**结论**（不是思考过程）作为 `report` 事件写回同一个群, 前端轮询即可看到。
//!
//! 纪律:
//! - **不阻塞**: 调用方只等 `spawn_reports` 返回 (毫秒级), 模型调用在 tokio 任务里跑
//! - **并发**: 被 @ 的多个智能体各起一个任务, 互不排队
//! - **不重复**: 同一 (群, 智能体) 同时只跑一个 (`RoomBus::begin`)
//! - **不造假**: 失败就把失败原因作为汇报落进群, 不静默吞掉

use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;

use bolloon_llm::ChatMessage;

use crate::native::AgentView;
use crate::server::AppState;

/// 群内"谁正在想"的运行时状态 (内存态, 不落盘: 重启后本来就没了)
#[derive(Default)]
pub struct RoomBus {
    inflight: Mutex<HashMap<String, BTreeSet<String>>>,
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
            let ts = chrono::Utc::now().timestamp_millis() as u64;
            if let Err(e) = st.groups.append(&gid, &st.identity, "report", &agent.id, &text, None, ts) {
                // 写不进群 (ACL/存储) 时不能静默: 至少留在服务端日志, 界面那边会显示"没人回"
                tracing::warn!(group = %gid, agent = %agent.id, error = %e, "群汇报落块失败");
            }
        });
    }
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
         - 没把握就直说不确定，不编造"
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
        // 大小写 / 子串宽松: 用户打 @xiaobao 命中不了中文名, 但打 @agent 也不该崩
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
}
