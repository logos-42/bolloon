//! KernelLoop — 统一 Agent 执行循环（K4 的 Rust 版）
//!
//! 对应 TS 版：prepare → model call → harness tool call → checkpoint → reducer → continuation → finish
//! Pi/ReAct 旧循环降为策略或 Adapter；这里只保留一个 loop。

use std::sync::Arc;
use async_trait::async_trait;

use bolloon_harness::{Harness, ToolCall};
use bolloon_llm::{ChatMessage, GenerateParams, GenerateResult, LlmRuntime, ToolSchema};

/// 循环策略（模型调用的组成方式；Pi adapter 与 native adapter 共用）
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
        }
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

    pub fn harness(&self) -> &Arc<Harness> {
        &self.harness
    }

    /// 运行完整循环。调用方提供初始消息与工具集（从 harness 注册表取）。
    /// 每轮: model → tool_calls → harness gate → 结果拼回消息 → 继续
    pub async fn run(
        &self,
        provider_id: &str,
        model: &str,
        mut messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
        initial_context: Option<String>,
    ) -> Result<Vec<LoopStep>, String> {
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

        for turn in 1..=self.max_steps {
            // 模型调用带重试兜底: 超时/瞬时错误退避重试, 避免"上次回复超时了"直接中断整个会话
            let resp = {
                let mut last_err = String::new();
                let mut got: Option<GenerateResult> = None;
                for attempt in 0..=3 {
                    match self.strategy.call(provider_id, model, messages.clone(), tools.clone()).await {
                        Ok(r) => {
                            got = Some(r);
                            break;
                        }
                        Err(e) => {
                            last_err = e.clone();
                            if attempt < 3 {
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
                if reflect_streak >= self.max_reflect {
                    steps.push(LoopStep {
                        turn,
                        response: Some(resp),
                        tool_calls: vec![],
                        stop: Some(StopReason::Finished),
                    });
                    break;
                }
                let aligned = if did_tools {
                    let transcript = build_transcript(&messages, &resp);
                    match &self.goal_review {
                        Some(reviewer) => {
                            reviewer.is_aligned(provider_id, model, &initial_intent, &transcript).await.unwrap_or(false)
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
                    break;
                }
                // 未对齐: 把本轮回应当 observation 拼回, 下一轮模型继续/自纠
                steps.push(LoopStep {
                    turn,
                    response: Some(resp.clone()),
                    tool_calls: vec![],
                    stop: None,
                });
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
                let outcome = self.harness.gate(call.clone()).await;
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
            if no_progress >= self.max_no_progress && !has_tools {
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
                l.stop = Some(StopReason::MaxTurns(self.max_steps));
            }
        }

        Ok(steps)
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
}