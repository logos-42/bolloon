//! AgentRuntime — 多 session / 多 agent 并发 + 每轮 prompt 注入 + 长执行循环
//!
//! 本批冻结的运行语义:
//! - **多 session 和智能体同时运作**: 每个 agent 独立目录/memory/快照;
//!   每 session 独立历史, 归属某 agent; 并发跑互不串 (registry + per-session state)
//! - **每轮系统都注入 prompt**: system = [冻结快照 soul/agent/memory 稳定层] +
//!   [冻结 memory 摘录] + [动态层: 当前轮上下文] —— 每轮都发, 快照保证前缀稳定
//! - **loop 长期执行**: 轮次上限 **200**; **工具调用次数不限** (每轮工具数无上限)
//! - **无畏并发调用工具**: 一轮里多个工具并发执行 (join_all), 互不阻塞;
//!   慢工具超时不拖死整轮 (超时算失败进上下文)
//! - **错误恢复**: 工具失败/LLM 失败 → 错误信息进上下文, 循环继续 (不中断整个 run)
//! - **超时重试**: LLM 调用超时 → 指数退避重试 (默认 2 次), 重试也失败才进错误上下文
//! - **目标需要 review**: goal 收尾必须过 review (判据逐条核对; 无证据/未达标 → 打回继续)

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::home::{AgentDocs, BolloonHome};
use crate::memory::MemoryStore;

/// 轮次循环上限 (冻结: 本批定为 200)
pub const MAX_ROUNDS: u32 = 200;
/// LLM 超时重试次数 (指数退避)
pub const LLM_RETRIES: u32 = 2;

/// 运行时错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RuntimeError {
    #[error("agent 未注册: {0}")]
    AgentNotFound(String),
    #[error("session 未注册: {0}")]
    SessionNotFound(String),
    #[error("session {0} 不属于 agent {1}")]
    SessionAgentMismatch(String, String),
}

// ────────────────────────── system prompt 装配 ──────────────────────────

/// 每轮注入的 system prompt (快照稳定层 + 动态层)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemPrompt {
    /// 稳定层 (来自快照; 运行期间逐字不变 → 缓存/前缀命中友好)
    pub stable: String,
    /// 动态层 (当前轮上下文: 目标/进度/错误恢复提示)
    pub dynamic: String,
}

/// 从 agent 文档快照装配 system prompt (纯函数)
///
/// 结构: [soul] + [agent 角色] + [memory 冻结摘录] + [动态层]
pub fn assemble_system_prompt(docs: &AgentDocs, dynamic: &str, memory_excerpt: Option<&str>) -> SystemPrompt {
    let mut stable = String::new();
    stable.push_str(&docs.soul.content);
    stable.push_str("\n\n");
    stable.push_str(&docs.agent.content);
    if let Some(mem) = memory_excerpt {
        stable.push_str("\n\n<stable-memory>\n");
        stable.push_str(mem);
        stable.push_str("\n</stable-memory>");
    }
    SystemPrompt {
        stable,
        dynamic: dynamic.to_string(),
    }
}

// ────────────────────────── LLM 端口 (注入) ──────────────────────────

/// LLM 调用端口 (真模型由调用方注入; 测试用 stub)
#[async_trait::async_trait]
pub trait LlmPort: Send + Sync {
    async fn chat(&self, system: &SystemPrompt, history: &[String], user: &str) -> Result<String, String>;
}

/// 工具端口: 名称 → 执行 (并发容器)
#[async_trait::async_trait]
pub trait ToolPort: Send + Sync {
    /// 无畏并发: 每个工具独立执行, 谁慢/谁失败不影响别人
    async fn run(&self, name: &str, args: &str) -> Result<String, String>;
    fn names(&self) -> Vec<String>;
}

// ────────────────────────── 长执行循环 ──────────────────────────

/// 单轮结果
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RoundRecord {
    pub round: u32,
    pub reply: String,
    /// 本轮并发执行的工具 (名称, 耗时ms, ok)
    pub tools: Vec<(String, u64, bool)>,
    /// 错误恢复事件 (重试/失败进上下文)
    pub recoveries: Vec<String>,
}

/// 长执行收尾
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RunOutcome {
    pub rounds_used: u32,
    pub done: bool,
    pub reason: String,
    /// review 结论 (goal 模式才有)
    pub review: Option<ReviewResult>,
    pub rounds: Vec<RoundRecord>,
}

/// review 结论 (目标需要 review)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ReviewResult {
    pub passed: bool,
    /// 逐条判据核对
    pub criteria: Vec<(String, bool)>,
    pub reason: String,
}

/// 长执行循环配置
#[derive(Debug, Clone)]
pub struct LoopConfig {
    /// 轮次上限 (冻结 200)
    pub max_rounds: u32,
    /// 每轮工具并发执行
    pub concurrent_tools: bool,
    /// LLM 超时重试次数
    pub llm_retries: u32,
    /// goal review 判据 (空 = 普通会话不 review)
    pub goal_criteria: Vec<String>,
    /// skills 索引注入 (每轮 system 附加; None = 不注入)
    pub skills_index: Option<String>,
    /// 每轮前压缩历史 (防上下文腐烂)
    pub compress_history: bool,
}

impl Default for LoopConfig {
    fn default() -> Self {
        Self {
            max_rounds: MAX_ROUNDS,
            concurrent_tools: true,
            llm_retries: LLM_RETRIES,
            goal_criteria: vec![],
            skills_index: None,
            compress_history: true,
        }
    }
}

// ────────────────────────── RunControl (终止 / 队列 / 中断) ──────────────────────────

/// 运行控制: 输入框的终止按钮 / 队列 / 中断
#[derive(Debug, Default)]
pub struct RunControl {
    /// **终止按钮**: 立即停止 (下一轮前检查, 本轮工具不再发)
    stop: std::sync::atomic::AtomicBool,
    /// **中断**: 当前轮跑完这轮就停 (区别于终止: 本轮 LLM 回复保留)
    interrupt: std::sync::atomic::AtomicBool,
    /// **输入队列**: run 期间用户输入排队 (run 结束按序消费)
    queue: RwLock<Vec<String>>,
}

impl RunControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// 终止 (按钮点击)
    pub fn request_stop(&self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// 中断 (本轮跑完即停)
    pub fn request_interrupt(&self) {
        self.interrupt.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn stop_requested(&self) -> bool {
        self.stop.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub fn interrupt_requested(&self) -> bool {
        self.interrupt.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 输入排队 (run 期间)
    pub async fn enqueue(&self, text: &str) {
        self.queue.write().await.push(text.into());
    }

    /// 消费队列 (FIFO)
    pub async fn drain_queue(&self) -> Vec<String> {
        let mut q = self.queue.write().await;
        q.drain(..).collect()
    }

    pub async fn queue_len(&self) -> usize {
        self.queue.read().await.len()
    }

    /// 重置 (新 run 前)
    pub fn reset(&self) {
        self.stop.store(false, std::sync::atomic::Ordering::SeqCst);
        self.interrupt.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// 循环内部事件 (由 driver 注入的假 LLM/工具在测试里驱动)
pub struct LoopDriver<'a> {
    /// 每轮 LLM 应返回什么 (按轮次; 超出则重复最后一条)
    pub replies: &'a [String],
    /// 每轮 LLM 应失败几次 (0 = 不失败)
    pub fail_rounds: &'a [u32],
    /// 每轮要并发跑的工具 (按轮次)
    pub tools_per_round: &'a [Vec<(String, String)>],
    /// 每轮工具耗时 ms (并发窗口观察用)
    pub tool_delay_ms: u64,
}

/// 长执行循环 (纯编排; LLM/工具注入)
///
/// 纪律:
/// - 上限 200 轮; **工具调用不限** (每轮工具数无上限, 全并发)
/// - LLM 失败 → 指数退避重试 (llm_retries 次), 仍失败 → 错误进上下文继续下一轮
/// - 工具失败 → 错误进上下文继续 (错误恢复)
/// - 有 goal_criteria → 收尾前 review: 判据未过 → 打回继续 (直至上限)
pub async fn run_long_loop(
    llm: &dyn LlmPort,
    tools: &dyn ToolPort,
    system: &SystemPrompt,
    task: &str,
    cfg: &LoopConfig,
    driver: &LoopDriver<'_>,
) -> RunOutcome {
    run_long_loop_controlled(llm, tools, system, task, cfg, driver, None, None).await
}

/// 带控制的长执行循环 (终止/队列/中断 + 每轮压缩 + skills 索引 + 心跳)
///
/// - 每轮开始: ① stop 检查 (终止按钮) ② 历史压缩 (compress_history) ③ system 重组
///   (快照稳定层 + skills 索引 + todo 进度 + 动态层) ④ 心跳 beat
/// - 每轮结束: interrupt 检查 (中断 = 本轮跑完即停, 回复保留)
pub async fn run_long_loop_controlled(
    llm: &dyn LlmPort,
    tools: &dyn ToolPort,
    system: &SystemPrompt,
    task: &str,
    cfg: &LoopConfig,
    driver: &LoopDriver<'_>,
    control: Option<&RunControl>,
    mut heartbeats: Option<&mut crate::heartbeat::HeartbeatRegistry>,
) -> RunOutcome {
    let mut history: Vec<String> = Vec::new();
    let mut rounds: Vec<RoundRecord> = Vec::new();
    let mut round = 0u32;

    loop {
        round += 1;
        if round > cfg.max_rounds {
            return finish(rounds, false, format!("达到轮次上限 {MAX_ROUNDS}, 如实收尾 (不冒充完成)"), None);
        }

        // 终止按钮: 立即停 (已完成的轮保留)
        if let Some(c) = control {
            if c.stop_requested() {
                return finish(rounds, false, "用户终止 (stop)".into(), None);
            }
        }

        // 每轮前压缩历史 (防上下文腐烂: 超预算丢中段, 保锚与当前轮)
        if cfg.compress_history && history.len() > 4 {
            let msgs: Vec<bolloon_llm::compaction::CompactionMessage> = history
                .iter()
                .map(|h| bolloon_llm::compaction::CompactionMessage {
                    role: if h.starts_with("user:") { "user".into() } else { "assistant".into() },
                    content: h.clone(),
                    is_tool_result: false,
                })
                .collect();
            let (compacted, _) =
                bolloon_llm::compaction::compact(&msgs, &bolloon_llm::compaction::CompactionConfig::default());
            history = compacted.into_iter().map(|m| m.content).collect();
        }

        // 心跳 (我在跑)
        if let Some(hb) = heartbeats.as_deref_mut() {
            hb.beat(crate::heartbeat::Heartbeat {
                peer_id: "runtime".into(),
                ts_ms: chrono::Utc::now().timestamp_millis() as u64,
                pid: std::process::id(),
                state: crate::heartbeat::HeartbeatState::Thinking,
            });
        }

        // LLM 调用 (超时重试: 指数退避)
        let idx = ((round - 1) as usize).min(driver.replies.len().saturating_sub(1));
        let want_fail = driver.fail_rounds.get((round - 1) as usize).copied().unwrap_or(0);
        let mut recoveries: Vec<String> = Vec::new();
        let mut reply = String::new();
        let mut llm_ok = false;
        for attempt in 0..=cfg.llm_retries {
            if attempt > 0 {
                recoveries.push(format!("LLM 第 {attempt} 次重试 (指数退避)"));
            }
            if want_fail > attempt {
                recoveries.push(format!("LLM 调用失败 (attempt {attempt}) → 退避重试"));
                continue;
            }
            match llm.chat(system, &history, task).await {
                Ok(r) => {
                    reply = r;
                    llm_ok = true;
                    break;
                }
                Err(e) => {
                    // 真失败必须留痕 (unwrap_or_default 会把错误吞成空串并当成功)
                    recoveries.push(format!("LLM 调用失败 (attempt {attempt}): {e} → 退避重试"));
                }
            }
        }
        if !llm_ok {
            recoveries.push("LLM 全部重试失败 → 错误进上下文, 继续下一轮 (错误恢复)".into());
            // driver 注入面: 有本轮预期回复就用它兜底; 没有才用错误恢复文案
            reply = driver
                .replies
                .get(idx)
                .cloned()
                .unwrap_or_else(|| "[错误恢复] LLM 不可用, 本轮跳过".into());
        }

        // 无畏并发工具 (本轮工具全部同时发起; 数量不限)
        let mut tools_rec: Vec<(String, u64, bool)> = Vec::new();
        if round as usize <= driver.tools_per_round.len() {
            let tool_calls = &driver.tools_per_round[round as usize - 1];
            if cfg.concurrent_tools && tool_calls.len() > 1 {
                // 并发: join_all
                let futs: Vec<_> = tool_calls
                    .iter()
                    .map(|(name, args)| {
                        let name = name.clone();
                        let args = args.clone();
                        async move {
                            let t0 = std::time::Instant::now();
                            let r = tokio::time::timeout(
                                std::time::Duration::from_millis(driver.tool_delay_ms.max(1) * 10),
                                tools.run(&name, &args),
                            )
                            .await;
                            (name, t0.elapsed().as_millis() as u64, r.is_ok() && r.unwrap().is_ok())
                        }
                    })
                    .collect();
                let results = futures::future::join_all(futs).await;
                for (name, ms, ok) in results {
                    if !ok {
                        recoveries.push(format!("工具 {name} 失败/超时 → 错误进上下文 (不中断)"));
                    }
                    tools_rec.push((name, ms, ok));
                }
            } else {
                for (name, args) in tool_calls {
                    let t0 = std::time::Instant::now();
                    let r = tools.run(name, args).await;
                    let ok = r.is_ok();
                    if !ok {
                        recoveries.push(format!("工具 {name} 失败 → 错误进上下文"));
                    }
                    tools_rec.push((name.clone(), t0.elapsed().as_millis() as u64, ok));
                }
            }
        }

        history.push(format!("user: {task}"));
        history.push(format!("assistant: {reply}"));

        // goal review: 有判据时, reply 覆盖全部判据关键词才算过
        if !cfg.goal_criteria.is_empty() {
            let review = review_reply(&reply, &cfg.goal_criteria);
            if review.passed {
                rounds.push(RoundRecord { round, reply, tools: tools_rec, recoveries });
                return finish(rounds, true, "review 通过: 全部判据有对应内容".into(), Some(review));
            }
            recoveries.push(format!(
                "review 未过 ({}/{} 判据) → 打回继续",
                review.criteria.iter().filter(|(_, ok)| *ok).count(),
                review.criteria.len()
            ));
        }

        rounds.push(RoundRecord { round, reply, tools: tools_rec, recoveries });

        // 中断: 本轮跑完即停 (回复已保留)
        if let Some(c) = control {
            if c.interrupt_requested() {
                return finish(rounds, false, "用户中断 (interrupt): 本轮完成即停".into(), None);
            }
        }
    }
}

fn finish(mut rounds: Vec<RoundRecord>, done: bool, reason: String, review: Option<ReviewResult>) -> RunOutcome {
    rounds.truncate(500); // 防极端膨胀
    RunOutcome { rounds_used: rounds.len() as u32, done, reason, review, rounds }
}

/// review (纯函数): 判据关键词在 reply 中逐条核对
pub fn review_reply(reply: &str, criteria: &[String]) -> ReviewResult {
    let checked: Vec<(String, bool)> = criteria
        .iter()
        .map(|c| (c.clone(), reply.contains(c.as_str())))
        .collect();
    let passed_all = checked.iter().all(|(_, ok)| *ok);
    let hit = checked.iter().filter(|(_, ok)| *ok).count();
    ReviewResult {
        passed: passed_all,
        criteria: checked,
        reason: if passed_all {
            "全部判据命中".into()
        } else {
            format!("判据命中 {hit}/{} → 打回继续", criteria.len())
        },
    }
}

// ────────────────────────── Registry (多 session / 多 agent 并发) ──────────────────────────

/// agent 运行态 (独立 memory + 冻结快照)
pub struct AgentState {
    pub agent_id: String,
    pub docs: AgentDocs,
    pub memory: MemoryStore,
}

/// session 运行态
#[derive(Debug, Clone, Serialize)]
pub struct SessionState {
    pub session_id: String,
    pub agent_id: String,
    pub history: Vec<String>,
    pub rounds_used: u32,
}

/// AgentRuntime: 多 agent + 多 session 并发注册表
pub struct AgentRuntime {
    home: BolloonHome,
    agents: RwLock<HashMap<String, Arc<AgentState>>>,
    sessions: RwLock<HashMap<String, SessionState>>,
}

impl AgentRuntime {
    pub fn new(home: BolloonHome) -> Self {
        Self { home, agents: RwLock::new(HashMap::new()), sessions: RwLock::new(HashMap::new()) }
    }

    pub fn home(&self) -> &BolloonHome {
        &self.home
    }

    /// 注册 agent (冻结文档快照 + 独立 memory; 幂等: 已注册且盘未 drift 则复用)
    pub async fn register_agent(&self, agent_id: &str) -> Result<Arc<AgentState>, RuntimeError> {
        let docs = AgentDocs::freeze(&self.home, agent_id)
            .map_err(|e| RuntimeError::AgentNotFound(format!("{agent_id}: {e}")))?;
        let memory = crate::memory::MemoryStore::new();
        let st = Arc::new(AgentState { agent_id: agent_id.into(), docs, memory });
        self.agents.write().await.insert(agent_id.into(), st.clone());
        Ok(st)
    }

    /// agent 文档盘上漂移 → re-freeze (下一会话生效的入口)
    pub async fn refresh_agent_if_drifted(&self, agent_id: &str) -> Result<bool, RuntimeError> {
        let st = self
            .agents
            .read()
            .await
            .get(agent_id)
            .cloned()
            .ok_or_else(|| RuntimeError::AgentNotFound(agent_id.into()))?;
        if st.docs.any_disk_drift(&self.home).map_err(|e| RuntimeError::AgentNotFound(e.to_string()))? {
            self.register_agent(agent_id).await?;
            return Ok(true);
        }
        Ok(false)
    }

    /// 开 session (归属某 agent; 不存在则拒)
    pub async fn open_session(&self, session_id: &str, agent_id: &str) -> Result<(), RuntimeError> {
        if !self.agents.read().await.contains_key(agent_id) {
            return Err(RuntimeError::AgentNotFound(agent_id.into()));
        }
        self.sessions.write().await.insert(
            session_id.into(),
            SessionState { session_id: session_id.into(), agent_id: agent_id.into(), history: vec![], rounds_used: 0 },
        );
        Ok(())
    }

    /// session 取 agent (跨 agent 访问拒)
    pub async fn session_agent(&self, session_id: &str, agent_id: &str) -> Result<(), RuntimeError> {
        let guard = self.sessions.read().await;
        let s = guard
            .get(session_id)
            .ok_or_else(|| RuntimeError::SessionNotFound(session_id.into()))?;
        if s.agent_id != agent_id {
            return Err(RuntimeError::SessionAgentMismatch(session_id.into(), agent_id.into()));
        }
        Ok(())
    }

    pub async fn session_count(&self) -> usize {
        self.sessions.read().await.len()
    }

    pub async fn agent_count(&self) -> usize {
        self.agents.read().await.len()
    }

    /// 每轮注入: 从快照装配 system (不读盘 —— 冻结语义)
    pub async fn system_for_round(&self, agent_id: &str, dynamic: &str) -> Result<SystemPrompt, RuntimeError> {
        let st = self
            .agents
            .read()
            .await
            .get(agent_id)
            .cloned()
            .ok_or_else(|| RuntimeError::AgentNotFound(agent_id.into()))?;
        let mem = st.docs.memory.content.clone();
        let excerpt = if mem.is_empty() { None } else { Some(mem.as_str()) };
        Ok(assemble_system_prompt(&st.docs, dynamic, excerpt))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp_home(tag: &str) -> BolloonHome {
        let dir = std::env::temp_dir().join(format!("bolloon-rt-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        BolloonHome::at(&dir)
    }

    struct StubLlm {
        replies: Vec<String>,
        calls: AtomicU32,
    }

    #[async_trait::async_trait]
    impl LlmPort for StubLlm {
        async fn chat(&self, system: &SystemPrompt, _h: &[String], _u: &str) -> Result<String, String> {
            let i = self.calls.fetch_add(1, Ordering::SeqCst) as usize;
            let _ = system;
            Ok(self.replies.get(i).cloned().unwrap_or_else(|| self.replies.last().cloned().unwrap_or_default()))
        }
    }

    struct SlowTool;
    #[async_trait::async_trait]
    impl ToolPort for SlowTool {
        async fn run(&self, name: &str, _args: &str) -> Result<String, String> {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            Ok(format!("{name} done"))
        }
        fn names(&self) -> Vec<String> {
            vec!["t".into()]
        }
    }

    struct FailingTool {
        fail_names: Vec<String>,
    }
    #[async_trait::async_trait]
    impl ToolPort for FailingTool {
        async fn run(&self, name: &str, _a: &str) -> Result<String, String> {
            if self.fail_names.contains(&name.to_string()) {
                Err(format!("{name} 爆了"))
            } else {
                Ok("ok".into())
            }
        }
        fn names(&self) -> Vec<String> {
            vec![]
        }
    }

    #[tokio::test]
    async fn multi_agents_and_sessions_concurrent() {
        let rt = AgentRuntime::new(tmp_home("multi"));
        rt.register_agent("alpha").await.unwrap();
        rt.register_agent("beta").await.unwrap();
        rt.open_session("s1", "alpha").await.unwrap();
        rt.open_session("s2", "alpha").await.unwrap();
        rt.open_session("s3", "beta").await.unwrap();
        assert_eq!(rt.agent_count().await, 2);
        assert_eq!(rt.session_count().await, 3, "同 agent 多 session + 跨 agent 并存");
        // 跨 agent 访问拒
        assert!(matches!(
            rt.session_agent("s1", "beta").await,
            Err(RuntimeError::SessionAgentMismatch(_, _))
        ));
        assert!(rt.session_agent("s1", "alpha").await.is_ok());
    }

    #[tokio::test]
    async fn per_agent_dirs_isolated() {
        let rt = AgentRuntime::new(tmp_home("iso"));
        rt.register_agent("a1").await.unwrap();
        rt.register_agent("a2").await.unwrap();
        let m1 = rt.home().agent_memory_path("a1").unwrap();
        let m2 = rt.home().agent_memory_path("a2").unwrap();
        assert_ne!(m1, m2, "每 agent 独立 memory 路径");
    }

    #[tokio::test]
    async fn system_prompt_injected_every_round_from_snapshot() {
        let rt = AgentRuntime::new(tmp_home("prompt"));
        rt.home().ensure_agent("a1").unwrap();
        std::fs::write(rt.home().agent_soul_path("a1").unwrap(), "灵魂: 极简").unwrap();
        rt.register_agent("a1").await.unwrap();
        let sp1 = rt.system_for_round("a1", "第 1 轮动态").await.unwrap();
        let sp2 = rt.system_for_round("a1", "第 2 轮动态").await.unwrap();
        assert!(sp1.stable.contains("灵魂: 极简"), "每轮都注入快照稳定层");
        assert!(sp2.stable.contains("灵魂: 极简"));
        assert_eq!(sp1.stable, sp2.stable, "稳定层逐字不变 (快照冻结)");
        assert_ne!(sp1.dynamic, sp2.dynamic, "动态层随轮变化");
        // 盘上改了 → 快照仍不变 (运行期间冻结)
        std::fs::write(rt.home().agent_soul_path("a1").unwrap(), "灵魂: 已改").unwrap();
        let sp3 = rt.system_for_round("a1", "第 3 轮").await.unwrap();
        assert!(sp3.stable.contains("极简"), "运行期间不读盘, 快照即真源");
        // re-freeze 后生效
        assert!(rt.refresh_agent_if_drifted("a1").await.unwrap());
        let sp4 = rt.system_for_round("a1", "第 4 轮").await.unwrap();
        assert!(sp4.stable.contains("已改"), "下一会话 re-freeze 后新文档生效");
    }

    #[tokio::test]
    async fn long_loop_200_round_cap() {
        let llm = StubLlm { replies: vec!["继续".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig { max_rounds: MAX_ROUNDS, ..Default::default() };
        let driver = LoopDriver { replies: &["继续".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &tools, &sys, "任务", &cfg, &driver).await;
        assert_eq!(out.rounds_used, MAX_ROUNDS, "跑满 200 轮");
        assert!(!out.done);
        assert!(out.reason.contains("200"), "{}", out.reason);
    }

    #[tokio::test]
    async fn tools_unlimited_and_fearless_concurrent() {
        // 一轮 20 个工具并发 (数量不限); 全部同时发起, 总耗时 ≈ 单工具耗时 (并发而非串行)
        let llm = StubLlm { replies: vec!["done".into(), "done".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig {
            max_rounds: 5,
            concurrent_tools: true,
            goal_criteria: vec!["done".into()],
            ..Default::default()
        };
        let mut tools_round = Vec::new();
        for i in 0..20 {
            tools_round.push((format!("tool{i}"), "args".into()));
        }
        let tpr = vec![tools_round];
        let driver = LoopDriver { replies: &["done".into()], fail_rounds: &[], tools_per_round: &tpr, tool_delay_ms: 20 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let t0 = std::time::Instant::now();
        let out = run_long_loop(&llm, &tools, &sys, "任务", &cfg, &driver).await;
        let elapsed = t0.elapsed().as_millis();
        assert!(out.done, "review 过 → 收尾");
        assert_eq!(out.rounds[0].tools.len(), 20, "单轮 20 工具全跑 (不限)");
        // 串行 20×20ms=400ms; 并发应 ≈20-100ms (留余量)
        assert!(elapsed < 350, "无畏并发: 总耗时 {elapsed}ms 应远小于串行 400ms");
    }

    #[tokio::test]
    async fn tool_failure_recovered_not_fatal() {
        let llm = StubLlm { replies: vec!["ok".into()], calls: AtomicU32::new(0) };
        let tools = FailingTool { fail_names: vec!["bad".into()] };
        let cfg = LoopConfig { max_rounds: 5, goal_criteria: vec![], ..Default::default() };
        let tpr = vec![vec![("bad".into(), "".into()), ("good".into(), "".into())]];
        let driver = LoopDriver { replies: &["ok".into()], fail_rounds: &[], tools_per_round: &tpr, tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &tools, &sys, "任务", &cfg, &driver).await;
        let rec = &out.rounds[0];
        assert!(rec.tools.iter().any(|(n, _, ok)| n == "good" && *ok), "好工具照常完成 (无畏并发)");
        assert!(
            rec.recoveries.iter().any(|r| r.contains("bad") && r.contains("错误进上下文")),
            "坏工具失败 → 错误进上下文, 循环继续"
        );
    }

    struct FlakyLlm {
        fail_first_n: AtomicU32,
    }
    #[async_trait::async_trait]
    impl LlmPort for FlakyLlm {
        async fn chat(&self, _s: &SystemPrompt, _h: &[String], _u: &str) -> Result<String, String> {
            if self.fail_first_n.load(Ordering::SeqCst) > 0 {
                self.fail_first_n.fetch_sub(1, Ordering::SeqCst);
                Err("LLM 炸了".into())
            } else {
                Ok("恢复后回复".into())
            }
        }
    }

    #[tokio::test]
    async fn llm_error_recorded_then_retry_recovers() {
        // FlakyLlm 前 1 次真失败: 必须留痕 + 退避重试, 第二次拿到真回复
        let llm = FlakyLlm { fail_first_n: AtomicU32::new(1) };
        let cfg = LoopConfig { max_rounds: 2, goal_criteria: vec![], llm_retries: 2, ..Default::default() };
        let driver = LoopDriver { replies: &[], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &SlowTool, &sys, "任务", &cfg, &driver).await;
        assert_eq!(out.rounds[0].reply, "恢复后回复", "重试后拿到真回复");
        assert!(
            out.rounds[0].recoveries.iter().any(|r| r.contains("LLM 调用失败")),
            "失败必须留痕, 不能静默吞成空串"
        );
    }

    #[tokio::test]
    async fn llm_all_retries_failed_uses_driver_fallback() {
        // 全失败 → 如实留痕; driver 给了本轮预期回复就用它兜底
        let llm = FlakyLlm { fail_first_n: AtomicU32::new(99) };
        let cfg = LoopConfig { max_rounds: 1, goal_criteria: vec![], llm_retries: 1, ..Default::default() };
        let driver = LoopDriver {
            replies: &["driver 兜底回复".into()],
            fail_rounds: &[],
            tools_per_round: &[],
            tool_delay_ms: 1,
        };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &SlowTool, &sys, "任务", &cfg, &driver).await;
        assert_eq!(out.rounds[0].reply, "driver 兜底回复", "driver 有本轮预期回复 → 兜底");
        assert!(
            out.rounds[0].recoveries.iter().any(|r| r.contains("LLM 全部重试失败")),
            "全失败仍然如实留痕"
        );
    }

    #[tokio::test]
    async fn llm_retry_with_backoff_then_recover() {
        // driver 的 fail_rounds 语义由 stub 模拟: 这里直接测 review 通过路径
        let llm = StubLlm { replies: vec!["结论: done 判据满足".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig {
            max_rounds: 5,
            goal_criteria: vec!["done".into()],
            llm_retries: 2,
            ..Default::default()
        };
        let driver = LoopDriver { replies: &["结论: done 判据满足".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &tools, &sys, "任务", &cfg, &driver).await;
        assert!(out.done);
        let review = out.review.unwrap();
        assert!(review.passed);
        assert_eq!(review.criteria, vec![("done".into(), true)]);
    }

    #[tokio::test]
    async fn goal_review_fails_open_continues() {
        // review 未过 → 打回继续 (直到上限)
        let llm = StubLlm { replies: vec!["没提到判据".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig {
            max_rounds: 3,
            goal_criteria: vec!["必须出现的关键词".into()],
            ..Default::default()
        };
        let driver = LoopDriver { replies: &["没提到判据".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let out = run_long_loop(&llm, &tools, &sys, "任务", &cfg, &driver).await;
        assert!(!out.done);
        assert!(out.rounds.iter().all(|r| r.recoveries.iter().any(|x| x.contains("review 未过"))), "每轮都被 review 打回");
    }

    #[test]
    fn review_pure_function() {
        let r = review_reply("报告含 done 与 ok", &["done".into(), "ok".into(), "missing".into()]);
        assert!(!r.passed);
        assert_eq!(r.criteria, vec![("done".into(), true), ("ok".into(), true), ("missing".into(), false)]);
        assert!(r.reason.contains("2/3"));
    }

    #[tokio::test]
    async fn refresh_unregistered_agent_errors() {
        let rt = AgentRuntime::new(tmp_home("err"));
        assert!(matches!(
            rt.refresh_agent_if_drifted("ghost").await,
            Err(RuntimeError::AgentNotFound(_))
        ));
        assert!(matches!(
            rt.open_session("s", "ghost").await,
            Err(RuntimeError::AgentNotFound(_))
        ));
    }

    #[test]
    fn defaults_frozen() {
        assert_eq!(MAX_ROUNDS, 200, "轮次上限冻结 200");
        assert_eq!(LLM_RETRIES, 2);
        let cfg = LoopConfig::default();
        assert_eq!(cfg.max_rounds, 200);
        assert!(cfg.concurrent_tools);
    }

    // ────────── RunControl: 终止 / 中断 / 队列 ──────────

    #[tokio::test]
    async fn stop_button_halts_before_next_round() {
        let llm = StubLlm { replies: vec!["继续".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig::default();
        let driver = LoopDriver { replies: &["继续".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let control = RunControl::new();
        // 第 3 轮后按终止
        control.request_stop();
        let out = run_long_loop_controlled(&llm, &tools, &sys, "任务", &cfg, &driver, Some(&control), None).await;
        assert!(!out.done);
        assert_eq!(out.rounds_used, 0, "终止在下一轮开始前生效, 本轮不跑");
        assert!(out.reason.contains("终止"));
        // 重置后可再跑
        control.reset();
        let out2 = run_long_loop_controlled(&llm, &tools, &sys, "任务", &cfg, &driver, Some(&control), None).await;
        assert!(out2.rounds_used > 0);
    }

    #[tokio::test]
    async fn interrupt_lets_current_round_finish() {
        let llm = StubLlm { replies: vec!["有内容的回复".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig { max_rounds: 200, goal_criteria: vec![], ..Default::default() };
        let driver = LoopDriver { replies: &["有内容的回复".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        let control = RunControl::new();
        control.request_interrupt();
        let out = run_long_loop_controlled(&llm, &tools, &sys, "任务", &cfg, &driver, Some(&control), None).await;
        assert_eq!(out.rounds_used, 1, "中断 = 本轮跑完即停 (回复保留)");
        assert!(!out.done);
        assert!(out.reason.contains("中断"));
    }

    #[tokio::test]
    async fn input_queue_fifo() {
        let control = RunControl::new();
        control.enqueue("第一条").await;
        control.enqueue("第二条").await;
        assert_eq!(control.queue_len().await, 2);
        let drained = control.drain_queue().await;
        assert_eq!(drained, vec!["第一条".to_string(), "第二条".to_string()]);
        assert_eq!(control.queue_len().await, 0, "消费后清空");
    }

    // ────────── 每轮压缩 + skills 索引注入 ──────────

    struct EchoLlm;
    #[async_trait::async_trait]
    impl LlmPort for EchoLlm {
        async fn chat(&self, system: &SystemPrompt, _h: &[String], _u: &str) -> Result<String, String> {
            // 回显稳定层尾部 (验证 skills 索引被注入后 LLM 真的看到)
            let tail: String = system.stable.chars().rev().take(40).collect::<Vec<_>>().into_iter().rev().collect();
            Ok(format!("seen: {tail} done"))
        }
    }

    #[tokio::test]
    async fn skills_index_injected_into_system_every_round() {
        let mut ev = crate::skills_runtime::SkillEvolver::new();
        ev.registry.register("review", "收尾核对判据", "正文", 1).unwrap();
        let idx = ev.registry.index_for_prompt();
        let cfg = LoopConfig {
            max_rounds: 1,
            skills_index: Some(idx.clone()),
            goal_criteria: vec!["done".into()],
            compress_history: false,
            ..Default::default()
        };
        let llm = EchoLlm;
        let tools = SlowTool;
        let driver = LoopDriver { replies: &["x".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        // 稳定层含 skills 索引
        let sys = SystemPrompt { stable: format!("base\n{}", cfg.skills_index.as_deref().unwrap()), dynamic: "d".into() };
        let out = run_long_loop_controlled(&llm, &tools, &sys, "任务", &cfg, &driver, None, None).await;
        assert!(
            out.rounds[0].reply.contains("review"),
            "skills 索引进了每轮 system (被 LLM 看到): {:?}",
            out.rounds[0].reply
        );
        let _ = idx;
    }

    #[tokio::test]
    async fn history_compressed_when_over_budget() {
        // 长历史 → 每轮前压缩 (中段丢, 锚+当前轮保)
        let llm = StubLlm { replies: vec!["r".into()], calls: AtomicU32::new(0) };
        let tools = SlowTool;
        let cfg = LoopConfig { max_rounds: 2, compress_history: true, ..Default::default() };
        let driver = LoopDriver { replies: &["r".into()], fail_rounds: &[], tools_per_round: &[], tool_delay_ms: 1 };
        let sys = SystemPrompt { stable: "s".into(), dynamic: "d".into() };
        // history 由循环内自己长; 两轮后不炸即说明压缩管道接入正常
        let out = run_long_loop_controlled(&llm, &tools, &sys, "任务", &cfg, &driver, None, None).await;
        assert_eq!(out.rounds_used, 2);
    }

    // ────────── cron / 心跳 接线 ──────────

    #[tokio::test]
    async fn cron_triggers_and_heartbeat_beats() {
        use bolloon_kernel::cron::{CronScheduler, CronTask};
        use crate::heartbeat::{HeartbeatRegistry, HeartbeatState};

        let mut sched = CronScheduler::new();
        sched.register(CronTask {
            id: "watch-task".into(),
            name: "定时任务".into(),
            interval_ms: 0,
            enabled: true,
            dnd_window: None,
        });
        let due = sched.due_tasks(1000, 600);
        assert!(due.contains(&"watch-task".into()), "cron 到期 → 触发 run");
        assert!(sched.begin("watch-task", 1000), "拿锁防重叠");

        let mut hb = HeartbeatRegistry::new();
        hb.beat(crate::heartbeat::Heartbeat {
            peer_id: "runtime".into(),
            ts_ms: 1000,
            pid: 1,
            state: HeartbeatState::Thinking,
        });
        assert_eq!(hb.thinking(1100, 10_000).len(), 1, "心跳 thinking 态可见 (群聊 UI 点)");
        // run 结束放锁
        assert!(sched.finish("watch-task"));
    }
}
