//! KernelLoop — 统一 Agent 执行循环（K4 的 Rust 版）
//!
//! 对应 TS 版：prepare → model call → harness tool call → checkpoint → reducer → continuation → finish
//! Pi/ReAct 旧循环降为策略或 Adapter；这里只保留一个 loop。

use std::sync::Arc;
use async_trait::async_trait;

use bolloon_config::{policy::RuntimePolicy, ConfigView};
use bolloon_harness::{GateOutcome, Harness, ToolCall};
use bolloon_llm::{ChatMessage, GenerateParams, GenerateResult, LlmRuntime, ToolSchema};

/// 循环策略（模型调用的组成方式；Pi adapter 与 native adapter 共用）
///
/// 流式渲染/中断监听这类"怎么调模型"的差异属于**策略**（在 `call` 内部自理），
/// 轮次推进、工具门、无进展保护、配置覆盖属于**循环**（本文件）。
/// 这样 CLI 与 Web 共用同一个循环，不再各自实现一套。
#[async_trait]
pub trait LoopStrategy: Send + Sync {
    /// 组装消息 + 调模型，返回结果 (provider_id 选供应商, model 选具体模型)
    async fn call(
        &self,
        provider_id: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
    ) -> Result<GenerateResult, String>;
}

/// 默认策略：直连 llm crate
pub struct DefaultStrategy {
    pub llm: LlmRuntime,
}

#[async_trait]
impl LoopStrategy for DefaultStrategy {
    async fn call(
        &self,
        provider_id: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
    ) -> Result<GenerateResult, String> {
        let mut params = GenerateParams::new(model, messages);
        params.tools = tools;
        self.llm
            .generate(provider_id, params)
            .await
            .map_err(|e| e.to_string())
    }
}

/// 目标审查员: 把关 agent 自问自答后的收尾是否对齐用户初始意图
#[async_trait]
pub trait GoalReviewer: Send + Sync {
    async fn is_aligned(
        &self,
        provider_id: &str,
        model: &str,
        intent: &str,
        transcript: &str,
    ) -> Result<bool, String>;
}

/// 默认 LLM 审查员: 把初始意图 + 最近对话交给模型, 只答 ALIGNED / NOT_ALIGNED
pub struct LlmGoalReviewer {
    pub llm: Arc<LlmRuntime>,
    pub provider_id: String,
    pub model: String,
}

impl LlmGoalReviewer {
    pub fn new(llm: Arc<LlmRuntime>, provider_id: String, model: String) -> Self {
        Self { llm, provider_id, model }
    }
}

#[async_trait]
impl GoalReviewer for LlmGoalReviewer {
    async fn is_aligned(
        &self,
        _provider_id: &str,
        _model: &str,
        intent: &str,
        transcript: &str,
    ) -> Result<bool, String> {
        let sys = "你是目标审查员。判断 agent 的进展是否已经达成用户的初始意图并与之对齐。\n只回答 ALIGNED 或 NOT_ALIGNED, 不要解释。";
        let user = format!(
            "【用户初始意图】\n{intent}\n\n【当前进展(最近对话)】\n{transcript}\n\n是否对齐? 只回 ALIGNED 或 NOT_ALIGNED:"
        );
        let mut params = GenerateParams::new(
            self.model.clone(),
            vec![
                ChatMessage {
                    role: "system".into(),
                    content: sys.into(),
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                },
                ChatMessage {
                    role: "user".into(),
                    content: user,
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                },
            ],
        );
        params.tools = vec![];
        let r = self
            .llm
            .generate(&self.provider_id, params)
            .await
            .map_err(|e| e.to_string())?;
        let c = r.content.to_uppercase();
        Ok(c.contains("ALIGNED") && !c.contains("NOT_ALIGNED"))
    }
}

/// 循环停止判据
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum StopReason {
    /// 模型说 stop / 无 tool_calls
    Finished,
    /// 达到最大轮数（adaptive 不允许压硬上限 —— 由调用方定 max_turns）
    MaxTurns(u32),
    /// 控制面 abort
    Aborted,
    /// 失败（模型调用错误且不可恢复）
    Failed(String),
}

/// 一轮循环的产物
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LoopStep {
    pub turn: u32,
    pub response: Option<GenerateResult>,
    pub tool_calls: Vec<ToolCall>,
    pub stop: Option<StopReason>,
}

/// 一次运行的完整产物: 步骤 + **被循环改写后的消息历史** (调用方据此落盘会话)。
pub struct LoopRun {
    pub steps: Vec<LoopStep>,
    pub messages: Vec<ChatMessage>,
    pub stop: Option<StopReason>,
    /// 本次运行**捕获**的配置版本 (任务级快照; 中途配置更新不改变它)。
    /// 调用方据此把 `任务 ID ↔ 配置版本` 写进证据链。
    pub config_version: u64,
}

/// LLM 调用健康计数 (真实测量, 供 AI 优化闭环的可信指标源使用)。
/// 只有**实际发生**的调用/失败才会计数 —— 模型自述不算指标。
#[derive(Debug, Default)]
pub struct LlmHealth {
    attempts: std::sync::atomic::AtomicU64,
    failures: std::sync::atomic::AtomicU64,
    retries: std::sync::atomic::AtomicU64,
}

impl LlmHealth {
    pub fn record_attempt(&self, ok: bool) {
        use std::sync::atomic::Ordering;
        self.attempts.fetch_add(1, Ordering::Relaxed);
        if !ok {
            self.failures.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn record_retry(&self) {
        self.retries
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    pub fn attempts(&self) -> u64 {
        self.attempts.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn failures(&self) -> u64 {
        self.failures.load(std::sync::atomic::Ordering::Relaxed)
    }
    pub fn retries(&self) -> u64 {
        self.retries.load(std::sync::atomic::Ordering::Relaxed)
    }
    /// 失败率 (无样本时返回 0; 调用方据 attempts 判断样本是否足够)
    pub fn failure_rate(&self) -> f64 {
        let a = self.attempts();
        if a == 0 {
            0.0
        } else {
            self.failures() as f64 / a as f64
        }
    }
}

/// 循环观察者: 上层 (CLI/TUI/Web) 在循环的关键节点插入自己的渲染/记账,
/// 而不必复制一份循环。观察者**只读**循环事实, 不得改执行语义
/// (想改语义就改策略或配置, 不许在这里旁路 Harness 门)。
#[async_trait]
pub trait LoopObserver: Send + Sync {
    /// 一轮开始 (模型调用之前)
    async fn on_turn_start(&self, _turn: u32, _max_steps: u32) {}
    /// 单个工具调用进入 Harness 门之前
    async fn on_tool_begin(&self, _turn: u32, _call: &ToolCall) {}
    /// Harness 门返回后 (denied / 执行结果都在里面)
    async fn on_tool_result(&self, _turn: u32, _call: &ToolCall, _outcome: &GateOutcome) {}
    /// 一轮结束 (本轮 step 已定型)
    async fn on_turn_end(&self, _turn: u32, _step: &LoopStep) {}
}

/// 观察者链: 多个观察者按顺序收同一份事实 (UI 渲染 + 经济计量互不干扰)。
/// 任何一环都不许改变执行语义 (它们只读)。
pub struct ObserverChain<'a> {
    obs: Vec<&'a dyn LoopObserver>,
}

impl<'a> ObserverChain<'a> {
    pub fn new(obs: Vec<&'a dyn LoopObserver>) -> Self {
        Self { obs }
    }
}

#[async_trait]
impl LoopObserver for ObserverChain<'_> {
    async fn on_turn_start(&self, turn: u32, max_steps: u32) {
        for o in &self.obs {
            o.on_turn_start(turn, max_steps).await;
        }
    }
    async fn on_tool_begin(&self, turn: u32, call: &ToolCall) {
        for o in &self.obs {
            o.on_tool_begin(turn, call).await;
        }
    }
    async fn on_tool_result(&self, turn: u32, call: &ToolCall, outcome: &GateOutcome) {
        for o in &self.obs {
            o.on_tool_result(turn, call, outcome).await;
        }
    }
    async fn on_turn_end(&self, turn: u32, step: &LoopStep) {
        for o in &self.obs {
            o.on_turn_end(turn, step).await;
        }
    }
}

/// 不做任何事的观察者 (Web / 无界面场景)。
pub struct NoopObserver;

#[async_trait]
impl LoopObserver for NoopObserver {}

/// KernelLoop：可注入依赖的循环执行器
pub struct KernelLoop<S: LoopStrategy> {
    strategy: Arc<S>,
    harness: Arc<Harness>,
    /// 上下文上限（消息或字符，防御膨胀）
    max_steps: u32,
    /// 无进展保护：连续 N 轮无工具调用无新内容 → 停
    max_no_progress: u32,
    /// 自问自答上限：连续 N 轮「无工具调用但有内容」→ 视为收尾(防空转)
    max_reflect: u32,
    /// 目标审查员：自问自答收尾前把关是否对齐初始意图 (None = 不审查, 退化为原行为)
    goal_review: Option<Arc<dyn GoalReviewer>>,
    /// 受治理配置视图 (可选): B 类任务级 + C 类运行参数覆盖。只读, 不绕过既有门。
    config: Option<ConfigView>,
    /// LLM 调用健康计数 (真实测量; 与调用方共享时可供配置优化闭环读取)
    health: Arc<LlmHealth>,
}

impl<S: LoopStrategy> KernelLoop<S> {
    pub fn new(strategy: Arc<S>, harness: Arc<Harness>) -> Self {
        Self {
            strategy,
            harness,
            max_steps: 20,
            max_no_progress: 3,
            max_reflect: 4,
            goal_review: None,
            config: None,
            health: Arc::new(LlmHealth::default()),
        }
    }

    /// 注入共享的健康计数器 (同一进程内多次运行/多个入口共用一份统计)。
    pub fn with_health(mut self, health: Arc<LlmHealth>) -> Self {
        self.health = health;
        self
    }

    pub fn health(&self) -> Arc<LlmHealth> {
        self.health.clone()
    }

    pub fn with_limits(mut self, max_steps: u32, max_no_progress: u32) -> Self {
        self.max_steps = max_steps;
        self.max_no_progress = max_no_progress.max(1);
        self
    }

    pub fn with_max_reflect(mut self, max_reflect: u32) -> Self {
        self.max_reflect = max_reflect.max(1);
        self
    }

    pub fn with_goal_review(mut self, reviewer: Arc<dyn GoalReviewer>) -> Self {
        self.goal_review = Some(reviewer);
        self
    }

    /// 注入受治理配置视图。B 类 (模型/prompt/预算) 与 C 类 (超时/重试/并发/步数) 经此覆盖; 只读。
    pub fn with_config(mut self, config: ConfigView) -> Self {
        self.config = Some(config);
        self
    }

    pub fn harness(&self) -> &Arc<Harness> {
        &self.harness
    }

    /// 运行完整循环（无观察者）。调用方提供初始消息与工具集（从 harness 注册表取）。
    pub async fn run(
        &self,
        provider_id: &str,
        model: &str,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
        initial_context: Option<String>,
    ) -> Result<Vec<LoopStep>, String> {
        let r = self
            .run_observed(
                &NoopObserver,
                provider_id,
                model,
                messages,
                tools,
                initial_context,
            )
            .await?;
        Ok(r.steps)
    }

    /// 运行完整循环 + 观察者回调（CLI/TUI 用）。返回 steps **和被改写后的消息历史**。
    /// 每轮: model → tool_calls → harness gate → 结果拼回消息 → 继续
    pub async fn run_observed<O: LoopObserver>(
        &self,
        obs: &O,
        provider_id: &str,
        model: &str,
        mut messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
        initial_context: Option<String>,
    ) -> Result<LoopRun, String> {
        // 受治理配置覆盖 (B 类任务级 + C 类运行参数): 仅对新任务/新 run 生效, 不中途改语义
        let snap = self.config.as_ref().map(|v| v.read().unwrap().clone());
        let model = match snap
            .as_ref()
            .and_then(|s| RuntimePolicy::model_override(&**s).0)
        {
            Some(m) => m,
            None => model.to_string(),
        };
        let max_steps = snap
            .as_ref()
            .map(|s| RuntimePolicy::max_steps(&**s))
            .unwrap_or(self.max_steps);
        let max_no_progress = snap
            .as_ref()
            .map(|s| RuntimePolicy::max_no_progress(&**s))
            .unwrap_or(self.max_no_progress);
        let max_reflect = snap
            .as_ref()
            .map(|s| RuntimePolicy::max_reflect(&**s))
            .unwrap_or(self.max_reflect);
        let retries = snap
            .as_ref()
            .map(|s| RuntimePolicy::llm_retries(&**s))
            .unwrap_or(3) as u32;
        let initial_context = initial_context;

        if let Some(ctx) = initial_context {
            messages.insert(
                0,
                ChatMessage {
                    role: "system".into(),
                    content: ctx,
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                },
            );
        }

        // B 类 prompt 覆盖 (需 Operator 授权): 显式**替换**首条 system 提示。
        // 没有 system 消息时插到最前; 有则原地替换 —— 覆盖是"覆盖", 不做拼接, 免得
        // 身份提示与覆盖段并存造成语义漂移 (审计里 operator/reason 已记录谁改的)。
        if let Some(p) = snap
            .as_ref()
            .and_then(|s| RuntimePolicy::prompt_override(&**s))
        {
            match messages.iter_mut().find(|m| m.role == "system") {
                Some(m) => m.content = p,
                None => messages.insert(
                    0,
                    ChatMessage {
                        role: "system".into(),
                        content: p,
                        name: None,
                        tool_call_id: None,
                        images: vec![],
                        tool_calls: None,
                    },
                ),
            }
        }

        let mut steps = vec![];
        let mut no_progress = 0u32;
        // 初始意图: 取首条 user 消息, 目标 review 用它对齐
        let initial_intent = messages
            .iter()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_default();
        // 自问自答连击: 连续「无工具但有内容」的轮数
        let mut reflect_streak: u32 = 0;

        for turn in 1..=max_steps {
            obs.on_turn_start(turn, max_steps).await;
            // 模型调用带重试兜底: 超时/瞬时错误退避重试, 避免"上次回复超时了"直接中断整个会话
            let resp = {
                let mut last_err = String::new();
                let mut got: Option<GenerateResult> = None;
                for attempt in 0..=retries {
                    match self.strategy.call(provider_id, &model, messages.clone(), tools.clone()).await {
                        Ok(r) => {
                            self.health.record_attempt(true);
                            got = Some(r);
                            break;
                        }
                        Err(e) => {
                            self.health.record_attempt(false);
                            last_err = e.clone();
                            if attempt < retries {
                                self.health.record_retry();
                                tokio::time::sleep(std::time::Duration::from_secs(2u64 * (attempt as u64 + 1))).await;
                            }
                        }
                    }
                }
                match got {
                    Some(r) => r,
                    None => {
                        steps.push(LoopStep {
                            turn,
                            response: None,
                            tool_calls: vec![],
                            stop: Some(StopReason::Failed(last_err.clone())),
                        });
                        return Err(last_err);
                    }
                }
            };

            let has_tools = !resp.tool_calls.is_empty();
            let has_content = !resp.content.trim().is_empty();
            // 进展/反思计数: 有工具=清零; 无工具但有内容=自问自答连击; 全空=无进展
            if has_tools {
                no_progress = 0;
                reflect_streak = 0;
            } else if has_content {
                no_progress = 0;
                reflect_streak += 1;
            } else {
                no_progress += 1;
            }

            if !has_tools {
                // 模型本轮回了文本(可能自问自答 / 阶段性结论), 不直接收尾:
                // 1) 连续纯文本反思过多 → 视为已收尾(防空转)
                // 2) 本轮前若动过工具 → 跑目标 review 对齐初始意图; 通过对才停, 否则让模型下一轮自纠
                // 3) 从未动过工具(纯闲聊) → 退化为原行为: 无工具即停(省一次 review 调用)
                let did_tools = steps.iter().any(|s| !s.tool_calls.is_empty());
                if reflect_streak >= max_reflect {
                    steps.push(LoopStep {
                        turn,
                        response: Some(resp),
                        tool_calls: vec![],
                        stop: Some(StopReason::Finished),
                    });
                    if let Some(st) = steps.last() {
                        obs.on_turn_end(turn, st).await;
                    }
                    break;
                }
                let aligned = if did_tools {
                    let transcript = build_transcript(&messages, &resp);
                    match &self.goal_review {
                        Some(reviewer) => {
                            reviewer.is_aligned(provider_id, &model, &initial_intent, &transcript).await.unwrap_or(false)
                        }
                        None => true,
                    }
                } else {
                    true
                };
                if aligned {
                    steps.push(LoopStep {
                        turn,
                        response: Some(resp),
                        tool_calls: vec![],
                        stop: Some(StopReason::Finished),
                    });
                    if let Some(st) = steps.last() {
                        obs.on_turn_end(turn, st).await;
                    }
                    break;
                }
                // 未对齐: 把本轮回应当 observation 拼回, 下一轮模型继续/自纠
                steps.push(LoopStep {
                    turn,
                    response: Some(resp.clone()),
                    tool_calls: vec![],
                    stop: None,
                });
                if let Some(st) = steps.last() {
                    obs.on_turn_end(turn, st).await;
                }
                messages.push(ChatMessage {
                    role: "assistant".into(),
                    content: resp.content.clone(),
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                });
                continue;
            }

            // 执行工具（全部走 harness 门）
            let mut executed: Vec<ToolCall> = vec![];
            let mut tool_messages: Vec<ChatMessage> = vec![];
            for tc in &resp.tool_calls {
                let call = ToolCall {
                    id: tc.id.clone(),
                    name: tc.function.name.clone(),
                    arguments: serde_json::from_str(&tc.function.arguments)
                        .unwrap_or_else(|_| serde_json::json!({})),
                };
                obs.on_tool_begin(turn, &call).await;
                let outcome = self.harness.gate(call.clone()).await;
                obs.on_tool_result(turn, &call, &outcome).await;
                executed.push(call.clone());
                let (out_txt, tool_ok) = match &outcome {
                    bolloon_harness::GateOutcome {
                        denied: Some(d), ..
                    } => (format!("DENIED: {}", d.reason), false),
                    _ => {
                        let r = outcome.result.clone().expect("非 denied 必有 result");
                        (r.output.clone(), r.ok)
                    }
                };
                tool_messages.push(ChatMessage {
                    role: "tool".into(),
                    content: out_txt,
                    name: None,
                    tool_call_id: Some(tc.id.clone()),
                    images: vec![],
                    tool_calls: None,
                });
                if !tool_ok {
                    // 工具失败不打断循环（下一次模型调用会看到 tool 结果）
                }
            }

            steps.push(LoopStep {
                turn,
                response: Some(resp.clone()),
                tool_calls: executed.clone(),
                stop: None,
            });
            if let Some(st) = steps.last() {
                obs.on_turn_end(turn, st).await;
            }

            // 把 assistant 消息 + tool 结果拼回 history
            let assistant_msg = ChatMessage {
                role: "assistant".into(),
                content: resp.content.clone(),
                name: None,
                tool_call_id: None,
                images: vec![],
                tool_calls: Some(
                    resp.tool_calls
                        .iter()
                        .map(|tc| bolloon_llm::ToolCallMsg {
                            id: tc.id.clone(),
                            call_type: "function".into(),
                            function: tc.function.clone(),
                        })
                        .collect(),
                ),
            };
            messages.push(assistant_msg);
            messages.extend(tool_messages);

            // 无进展保护
            if no_progress >= max_no_progress && !has_tools {
                steps.push(LoopStep {
                    turn,
                    response: None,
                    tool_calls: vec![],
                    stop: Some(StopReason::MaxTurns(turn)),
                });
                break;
            }
        }

        let last = steps.last_mut();
        if let Some(l) = last {
            if l.stop.is_none() {
                // 跑满 max_steps 且没有正常停止 → 合并进最后一步（不追加新 step）
                l.stop = Some(StopReason::MaxTurns(max_steps));
            }
        }

        let stop = steps.last().and_then(|s| s.stop.clone());
        let config_version = snap.as_ref().map(|s| s.version).unwrap_or(0);
        Ok(LoopRun {
            steps,
            messages,
            stop,
            config_version,
        })
    }
}

/// 把最近对话 + 当前回复压成审查用 transcript (取最近 24 条, 防过长)
fn build_transcript(messages: &[ChatMessage], current: &GenerateResult) -> String {
    let mut msgs: Vec<ChatMessage> = messages.to_vec();
    msgs.push(ChatMessage {
        role: "assistant".into(),
        content: current.content.clone(),
        name: None,
        tool_call_id: None,
        images: vec![],
        tool_calls: None,
    });
    msgs.into_iter()
        .rev()
        .take(24)
        .rev()
        .map(|m| format!("[{}] {}", m.role, m.content))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_harness::{Budget, EffectKind, ToolDef, ToolExecutor, ToolRegistry, ToolResult};

    struct MockExecutor;
    #[async_trait]
    impl ToolExecutor for MockExecutor {
        async fn execute(&self, call: ToolCall) -> ToolResult {
            ToolResult {
                ok: true,
                output: format!("result_of_{}", call.name),
                elapsed_ms: 1,
                verified: None,
                evidence: None,
            }
        }
    }

    struct MockStrategy {
        /// 已调用次数（可变的）
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl LoopStrategy for MockStrategy {
        async fn call(
            &self,
            _provider_id: &str,
            _model: &str,
            _messages: Vec<ChatMessage>,
            _tools: Vec<ToolSchema>,
        ) -> Result<GenerateResult, String> {
            let idx = self
                .calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let (tools, content) = if idx == 0 {
                (1, "需要查一下".to_string())
            } else {
                (0, "完成".to_string())
            };
            let calls = if tools == 1 {
                vec![bolloon_llm::ToolCallMsg {
                    id: "call_1".into(),
                    call_type: "function".into(),
                    function: bolloon_llm::FunctionCall {
                        name: "read_file".into(),
                        arguments: "{}".into(),
                    },
                }]
            } else {
                vec![]
            };
            Ok(GenerateResult {
                content,
                tool_calls: calls,
                finish_reason: if tools == 1 { "tool_calls".into() } else { "stop".into() },
                usage: bolloon_llm::Usage::default(),
                model: _provider_id.to_string(),
            })
        }
    }

    async fn setup() -> (Arc<Harness>, Arc<MockStrategy>) {
        let reg = Arc::new(ToolRegistry::new());
        let def = ToolDef {
            name: "read_file".into(),
            description: "读文件".into(),
            parameters: serde_json::json!({}),
            effect: EffectKind::Read,
            default_allowed: true,
        };
        reg.register(def).await;
        let harness = Arc::new(Harness::new(reg, Arc::new(MockExecutor), Budget::new(10, 60_000)));
        (harness, Arc::new(MockStrategy { calls: std::sync::atomic::AtomicUsize::new(0) }))
    }

    #[tokio::test]
    async fn loop_runs_tool_then_finishes() {
        let (harness, strategy) = setup().await;
        let loop_ = KernelLoop::new(strategy, harness);

        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "请读取文件".into(),
            name: None,
            tool_call_id: None,
            images: vec![],
            tool_calls: None,
        }];
        let steps = loop_.run("p", "m", messages, vec![], None).await.unwrap();
        assert!(steps.len() >= 2, "至少两轮: 工具轮 + 完成轮");
        let last = steps.last().unwrap();
        assert!(matches!(last.stop, Some(StopReason::Finished)));
        // 第一轮执行了工具
        assert_eq!(steps[0].tool_calls.len(), 1);
    }

    #[tokio::test]
    async fn loop_honors_max_steps() {
        struct InfiniteStrategy;
        #[async_trait]
        impl LoopStrategy for InfiniteStrategy {
            async fn call(
                &self,
                _provider_id: &str,
                _model: &str,
                _messages: Vec<ChatMessage>,
                _tools: Vec<ToolSchema>,
            ) -> Result<GenerateResult, String> {
                Ok(GenerateResult {
                    content: "".into(),
                    tool_calls: vec![bolloon_llm::ToolCallMsg {
                        id: "c".into(),
                        call_type: "function".into(),
                        function: bolloon_llm::FunctionCall {
                            name: "read_file".into(),
                            arguments: "{}".into(),
                        },
                    }],
                    finish_reason: "tool_calls".into(),
                    usage: bolloon_llm::Usage::default(),
                    model: "m".into(),
                })
            }
        }
        let (harness, _) = setup().await;
        let loop_ = KernelLoop::new(Arc::new(InfiniteStrategy), harness).with_limits(5, 10);
        let messages = vec![];
        let steps = loop_.run("p", "m", messages, vec![], None).await.unwrap();
        assert!(
            steps.len() <= 5,
            "循环必须遵守 max_steps (实际 {})",
            steps.len()
        );
    }

    /// 自问自答持续推进 + 目标 review 对齐: 模型先调工具→自问自答(未对齐)→再调工具→结论(对齐)才收尾
    #[tokio::test]
    async fn loop_self_qa_continues_until_aligned() {
        struct SelfQaStrategy {
            calls: std::sync::atomic::AtomicUsize,
        }
        #[async_trait]
        impl LoopStrategy for SelfQaStrategy {
            async fn call(
                &self,
                _provider_id: &str,
                _model: &str,
                _messages: Vec<ChatMessage>,
                _tools: Vec<ToolSchema>,
            ) -> Result<GenerateResult, String> {
                let idx = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // 0: 工具; 1: 自问自答(无工具); 2: 工具; 3: 结论(无工具)
                let (tools, content) = match idx {
                    0 => (1, "先读一下".to_string()),
                    1 => (0, "让我再核对一下结果是否覆盖全部意图".to_string()),
                    2 => (1, "补一个检查".to_string()),
                    _ => (0, "已完成, 覆盖全部意图".to_string()),
                };
                let calls = if tools == 1 {
                    vec![bolloon_llm::ToolCallMsg {
                        id: "call_1".into(),
                        call_type: "function".into(),
                        function: bolloon_llm::FunctionCall {
                            name: "read_file".into(),
                            arguments: "{}".into(),
                        },
                    }]
                } else {
                    vec![]
                };
                Ok(GenerateResult {
                    content,
                    tool_calls: calls,
                    finish_reason: if tools == 1 { "tool_calls".into() } else { "stop".into() },
                    usage: bolloon_llm::Usage::default(),
                    model: "m".into(),
                })
            }
        }

        // 审查员: 第 1 次(自问自答)说未对齐, 第 2 次(结论)说对齐
        struct MockReviewer {
            answers: std::sync::Mutex<Vec<bool>>,
        }
        #[async_trait]
        impl GoalReviewer for MockReviewer {
            async fn is_aligned(
                &self,
                _provider_id: &str,
                _model: &str,
                _intent: &str,
                _transcript: &str,
            ) -> Result<bool, String> {
                Ok(self.answers.lock().unwrap().remove(0))
            }
        }

        let (harness, _) = setup().await;
        let strategy = Arc::new(SelfQaStrategy { calls: std::sync::atomic::AtomicUsize::new(0) });
        let reviewer = Arc::new(MockReviewer {
            answers: std::sync::Mutex::new(vec![false, true]),
        });
        let loop_ = KernelLoop::new(strategy, harness)
            .with_limits(20, 3)
            .with_goal_review(reviewer);
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "帮我做 X".into(),
            name: None,
            tool_call_id: None,
            images: vec![],
            tool_calls: None,
        }];
        let steps = loop_.run("p", "m", messages, vec![], None).await.unwrap();
        // 自问自答没有提前停: 走了 工具→自问→工具→结论 共 4 轮
        assert_eq!(steps.len(), 4, "自问自答应持续推进到对齐才收尾");
        let last = steps.last().unwrap();
        assert!(matches!(last.stop, Some(StopReason::Finished)), "最终应 Finished");
        assert!(steps.iter().filter(|s| !s.tool_calls.is_empty()).count() >= 2, "应至少调了 2 次工具");
    }

    /// `run_observed`: 观察者拿到轮次/工具回调, 且返回被改写的历史 + 捕获的配置版本。
    /// 这是 CLI 接入统一循环的契约 (CLI 只提供策略+观察者, 循环本体唯一)。
    #[tokio::test]
    async fn run_observed_hooks_history_and_config_version() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct CountingObserver {
            turns: AtomicUsize,
            tools: AtomicUsize,
        }
        #[async_trait]
        impl LoopObserver for CountingObserver {
            async fn on_turn_start(&self, _t: u32, _m: u32) {
                self.turns.fetch_add(1, Ordering::SeqCst);
            }
            async fn on_tool_result(&self, _t: u32, _c: &ToolCall, _o: &GateOutcome) {
                self.tools.fetch_add(1, Ordering::SeqCst);
            }
        }

        let (harness, strategy) = setup().await;
        let mgr = bolloon_config::ConfigManager::new(None);
        let mut cfg = bolloon_config::AppConfig::default();
        cfg.task.max_steps = 3;
        mgr.apply(bolloon_config::ConfigProposal::system(cfg, "test"))
            .await
            .unwrap();

        let obs = CountingObserver {
            turns: AtomicUsize::new(0),
            tools: AtomicUsize::new(0),
        };
        let loop_ = KernelLoop::new(strategy, harness).with_config(mgr.view());
        let messages = vec![ChatMessage {
            role: "user".into(),
            content: "请读取文件".into(),
            name: None,
            tool_call_id: None,
            images: vec![],
            tool_calls: None,
        }];
        let run = loop_
            .run_observed(&obs, "p", "m", messages, vec![], None)
            .await
            .unwrap();

        assert!(obs.turns.load(Ordering::SeqCst) >= 2, "至少两轮");
        assert_eq!(obs.tools.load(Ordering::SeqCst), 1, "一个工具调用");
        assert_eq!(run.config_version, 1, "必须是本次运行捕获的配置版本");
        assert!(
            run.messages.iter().any(|m| m.role == "tool"),
            "返回的历史里必须有工具结果 (CLI 靠它落盘会话)"
        );
        assert!(matches!(run.stop, Some(StopReason::Finished)));
        assert_eq!(loop_.health().attempts(), 2, "真实计量: 两次模型调用");
        assert_eq!(loop_.health().failures(), 0);
    }

    /// B 类 `system_prompt_override`: **替换**首条 system, 不是拼接 (覆盖就是覆盖)
    #[tokio::test]
    async fn config_prompt_override_replaces_system_prompt() {
        use std::sync::Mutex;

        struct EchoStrategy {
            seen_system: Mutex<String>,
        }
        #[async_trait]
        impl LoopStrategy for EchoStrategy {
            async fn call(
                &self,
                _provider_id: &str,
                _model: &str,
                messages: Vec<ChatMessage>,
                _tools: Vec<ToolSchema>,
            ) -> Result<GenerateResult, String> {
                if let Some(m) = messages.iter().find(|m| m.role == "system") {
                    *self.seen_system.lock().unwrap() = m.content.clone();
                }
                Ok(GenerateResult {
                    content: "ok".into(),
                    tool_calls: vec![],
                    finish_reason: "stop".into(),
                    usage: bolloon_llm::Usage::default(),
                    model: "m".into(),
                })
            }
        }

        let (harness, _) = setup().await;
        let mgr = bolloon_config::ConfigManager::new(None);
        let mut cfg = bolloon_config::AppConfig::default();
        cfg.task.system_prompt_override = Some("你是被覆盖后的提示".into());
        mgr.apply(bolloon_config::ConfigProposal::system(cfg, "override"))
            .await
            .unwrap();

        let strategy = Arc::new(EchoStrategy {
            seen_system: Mutex::new(String::new()),
        });
        let loop_ = KernelLoop::new(strategy.clone(), harness).with_config(mgr.view());
        let _ = loop_
            .run(
                "p",
                "m",
                vec![ChatMessage {
                    role: "system".into(),
                    content: "原始身份提示".into(),
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
                }],
                vec![],
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            strategy.seen_system.lock().unwrap().as_str(),
            "你是被覆盖后的提示",
            "配置的 prompt 覆盖必须替换 system, 而不是把它追加到身份提示后面"
        );
    }

}