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
    /// 组装消息 + 调模型，返回结果
    async fn call(
        &self,
        model_id: &str,
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
        model_id: &str,
        messages: Vec<ChatMessage>,
        tools: Vec<ToolSchema>,
    ) -> Result<GenerateResult, String> {
        let mut params = GenerateParams::new(model_id, messages);
        params.tools = tools;
        self.llm
            .generate(model_id, params)
            .await
            .map_err(|e| e.to_string())
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
}

impl<S: LoopStrategy> KernelLoop<S> {
    pub fn new(strategy: Arc<S>, harness: Arc<Harness>) -> Self {
        Self {
            strategy,
            harness,
            max_steps: 20,
            max_no_progress: 3,
        }
    }

    pub fn with_limits(mut self, max_steps: u32, max_no_progress: u32) -> Self {
        self.max_steps = max_steps;
        self.max_no_progress = max_no_progress.max(1);
        self
    }

    pub fn harness(&self) -> &Arc<Harness> {
        &self.harness
    }

    /// 运行完整循环。调用方提供初始消息与工具集（从 harness 注册表取）。
    /// 每轮: model → tool_calls → harness gate → 结果拼回消息 → 继续
    pub async fn run(
        &self,
        model_id: &str,
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
                    tool_calls: None,
                },
            );
        }

        let mut steps = vec![];
        let mut no_progress = 0u32;

        for turn in 1..=self.max_steps {
            let resp = match self.strategy.call(model_id, messages.clone(), tools.clone()).await {
                Ok(r) => r,
                Err(e) => {
                    steps.push(LoopStep {
                        turn,
                        response: None,
                        tool_calls: vec![],
                        stop: Some(StopReason::Failed(e.clone())),
                    });
                    return Err(e);
                }
            };

            let has_tools = !resp.tool_calls.is_empty();
            // 每轮累计新进展判定：有 tool_calls 或内容非空
            if has_tools || !resp.content.trim().is_empty() {
                no_progress = 0;
            } else {
                no_progress += 1;
            }

            if !has_tools {
                // 模型决定停
                steps.push(LoopStep {
                    turn,
                    response: Some(resp),
                    tool_calls: vec![],
                    stop: Some(StopReason::Finished),
                });
                break;
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
            _model_id: &str,
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
                model: _model_id.to_string(),
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
            tool_calls: None,
        }];
        let steps = loop_.run("test-model", messages, vec![], None).await.unwrap();
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
                _model_id: &str,
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
        let steps = loop_.run("m", messages, vec![], None).await.unwrap();
        assert!(
            steps.len() <= 5,
            "循环必须遵守 max_steps (实际 {})",
            steps.len()
        );
    }
}