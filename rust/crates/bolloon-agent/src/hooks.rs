//! Hooks 引擎 — 事件 → 匹配 → 动作
//!
//! 对齐 TS 版 `hooks/hooks-engine.ts`:
//! - 8 类事件 (preToolUse 可拒 / postToolUse·onMessage 可注入 system)
//! - toolFilter: preToolUse 只对指定工具名触发
//! - 执行模式 shell/llm 通过 trait 抽象 (Rust 版不真 spawn shell, 执行器注入)
//! - 结果如实带 timedOut/error, 不吞失败

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::RwLock;

/// 支持的 hook 事件类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HookEventType {
    PreToolUse,
    PostToolUse,
    OnMessage,
    OnSessionStart,
    OnSessionEnd,
    OnLoopStart,
    OnLoopEnd,
    OnError,
}

impl HookEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreToolUse => "preToolUse",
            Self::PostToolUse => "postToolUse",
            Self::OnMessage => "onMessage",
            Self::OnSessionStart => "onSessionStart",
            Self::OnSessionEnd => "onSessionEnd",
            Self::OnLoopStart => "onLoopStart",
            Self::OnLoopEnd => "onLoopEnd",
            Self::OnError => "onError",
        }
    }
}

/// hook 执行模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookExecMode {
    Shell,
    Llm,
}

/// hook 配置
#[derive(Debug, Clone)]
pub struct HookConfig {
    pub id: String,
    pub event: HookEventType,
    pub mode: HookExecMode,
    /// shell 命令 (mode=Shell)
    pub command: Option<String>,
    /// LLM 评估 prompt (mode=Llm)
    pub prompt: Option<String>,
    pub timeout_ms: u64,
    pub enabled: bool,
    /// 仅匹配指定工具名 (PreToolUse)
    pub tool_filter: Option<Vec<String>>,
    pub description: Option<String>,
}

impl HookConfig {
    pub fn new(id: impl Into<String>, event: HookEventType, mode: HookExecMode) -> Self {
        Self {
            id: id.into(),
            event,
            mode,
            command: None,
            prompt: None,
            timeout_ms: 5000,
            enabled: true,
            tool_filter: None,
            description: None,
        }
    }
}

/// hook 上下文
#[derive(Debug, Clone, Default)]
pub struct HookContext {
    pub tool_name: Option<String>,
    pub tool_args: Option<serde_json::Value>,
    pub tool_result: Option<serde_json::Value>,
    pub message_content: Option<String>,
    pub message_role: Option<String>,
    pub channel_id: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub error: Option<String>,
}

/// hook 执行结果
#[derive(Debug, Clone, Default)]
pub struct HookResult {
    pub id: String,
    pub deny: bool,
    pub reason: Option<String>,
    pub modified: bool,
    pub system_addition: Option<String>,
    pub raw_output: Option<String>,
    pub elapsed_ms: u128,
    pub timed_out: bool,
    pub error: Option<String>,
}

/// 执行器抽象 (shell/llm 由宿主注入; Rust 版不真 spawn shell)
#[async_trait::async_trait]
pub trait HookExecutor: Send + Sync {
    /// 返回 (输出文本, 是否 deny, 注入文本)
    async fn execute(&self, hook: &HookConfig, ctx: &HookContext) -> Result<String, String>;
}

/// hook 引擎
#[derive(Default)]
pub struct HooksEngine {
    hooks: RwLock<HashMap<String, HookConfig>>,
    executor: RwLock<Option<Arc<dyn HookExecutor>>>,
}

impl HooksEngine {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, hook: HookConfig) {
        self.hooks.write().await.insert(hook.id.clone(), hook);
    }

    pub async fn unregister(&self, id: &str) -> bool {
        self.hooks.write().await.remove(id).is_some()
    }

    pub async fn set_executor(&self, executor: Arc<dyn HookExecutor>) {
        *self.executor.write().await = Some(executor);
    }

    pub async fn hook_count(&self) -> usize {
        self.hooks.read().await.len()
    }

    /// 匹配 (纯函数): 事件 + toolFilter + enabled
    pub async fn matching_hooks(&self, event: HookEventType, ctx: &HookContext) -> Vec<HookConfig> {
        self.hooks
            .read()
            .await
            .values()
            .filter(|h| {
                h.enabled
                    && h.event == event
                    && match &h.tool_filter {
                        Some(filters) if event == HookEventType::PreToolUse => ctx
                            .tool_name
                            .as_ref()
                            .map(|t| filters.iter().any(|f| f == t))
                            .unwrap_or(false),
                        Some(_) => false, // toolFilter 只在 preToolUse 有意义
                        None => true,
                    }
            })
            .cloned()
            .collect()
    }

    /// 触发事件: 顺序执行全部匹配 hook, 聚合结果
    ///
    /// 任一 deny ⇒ 短路返回 (拒绝优先, 不再跑后续 hook)
    pub async fn emit(&self, event: HookEventType, ctx: &HookContext) -> Vec<HookResult> {
        let matched = self.matching_hooks(event, ctx).await;
        let executor = self.executor.read().await.clone();
        let mut results = Vec::new();
        for hook in matched {
            let start = Instant::now();
            let mut result = HookResult {
                id: hook.id.clone(),
                ..Default::default()
            };
            match &executor {
                None => {
                    // 未注入执行器: 不假装执行过
                    result.error = Some("hook executor 未注入".into());
                }
                Some(exec) => {
                    let exec_fut = exec.execute(&hook, ctx);
                    match tokio::time::timeout(Duration::from_millis(hook.timeout_ms), exec_fut).await {
                        Ok(Ok(output)) => {
                            result.raw_output = Some(output.clone());
                            let lower = output.to_lowercase();
                            if lower.starts_with("deny") {
                                result.deny = true;
                                result.reason = Some(output.trim_start_matches("deny").trim().to_string());
                            }
                            if let Some(add) = output.strip_prefix("system:") {
                                result.modified = true;
                                result.system_addition = Some(add.trim().to_string());
                            }
                        }
                        Ok(Err(e)) => result.error = Some(e),
                        Err(_) => {
                            result.timed_out = true;
                            result.error = Some(format!("超时 ({}ms)", hook.timeout_ms));
                        }
                    }
                }
            }
            result.elapsed_ms = start.elapsed().as_millis();
            let denied = result.deny;
            results.push(result);
            if denied {
                break; // 拒绝优先, 短路
            }
        }
        results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoExecutor;
    #[async_trait::async_trait]
    impl HookExecutor for EchoExecutor {
        async fn execute(&self, hook: &HookConfig, ctx: &HookContext) -> Result<String, String> {
            match hook.mode {
                HookExecMode::Shell => Ok(match hook.command.as_deref() {
                    Some("deny-run") => "deny 不许跑".into(),
                    Some("inject") => "system: 注入的提示".into(),
                    Some("ok") => "ok".into(),
                    other => Err(format!("未知命令: {other:?}"))?,
                }),
                HookExecMode::Llm => Ok(format!(
                    "llm-eval: tool={:?} content={:?}",
                    ctx.tool_name, ctx.message_content
                )),
            }
        }
    }

    fn deny_hook() -> HookConfig {
        let mut h = HookConfig::new("h-deny", HookEventType::PreToolUse, HookExecMode::Shell);
        h.command = Some("deny-run".into());
        h
    }

    fn inject_hook() -> HookConfig {
        let mut h = HookConfig::new("h-inject", HookEventType::PostToolUse, HookExecMode::Shell);
        h.command = Some("inject".into());
        h
    }

    async fn engine_with(hooks: Vec<HookConfig>) -> HooksEngine {
        let e = HooksEngine::new();
        for h in hooks {
            e.register(h).await;
        }
        e.set_executor(Arc::new(EchoExecutor)).await;
        e
    }

    #[tokio::test]
    async fn pre_tool_use_deny_short_circuits() {
        let engine = engine_with(vec![deny_hook(), inject_hook()]).await;
        // inject hook 挂在 postToolUse, 不该在 preToolUse 触发
        let ctx = HookContext { tool_name: Some("shell".into()), ..Default::default() };
        let results = engine.emit(HookEventType::PreToolUse, &ctx).await;
        assert_eq!(results.len(), 1);
        assert!(results[0].deny);
        assert_eq!(results[0].reason.as_deref(), Some("不许跑"));
    }

    #[tokio::test]
    async fn tool_filter_narrows_pre_tool_use() {
        let mut h = deny_hook();
        h.tool_filter = Some(vec!["terminal".into()]);
        let engine = engine_with(vec![h]).await;
        let ctx = HookContext { tool_name: Some("shell".into()), ..Default::default() };
        assert!(engine.emit(HookEventType::PreToolUse, &ctx).await.is_empty());
        let ctx2 = HookContext { tool_name: Some("terminal".into()), ..Default::default() };
        assert_eq!(engine.emit(HookEventType::PreToolUse, &ctx2).await.len(), 1);
    }

    #[tokio::test]
    async fn post_tool_use_injects_system() {
        let engine = engine_with(vec![inject_hook()]).await;
        let ctx = HookContext::default();
        let results = engine.emit(HookEventType::PostToolUse, &ctx).await;
        assert_eq!(results.len(), 1);
        assert!(results[0].modified);
        assert_eq!(results[0].system_addition.as_deref(), Some("注入的提示"));
    }

    #[tokio::test]
    async fn llm_mode_receives_context() {
        let mut h = HookConfig::new("h-llm", HookEventType::OnMessage, HookExecMode::Llm);
        h.prompt = Some("评估消息".into());
        let engine = engine_with(vec![h]).await;
        let ctx = HookContext {
            message_content: Some("你好".into()),
            message_role: Some("user".into()),
            ..Default::default()
        };
        let results = engine.emit(HookEventType::OnMessage, &ctx).await;
        assert!(results[0].raw_output.as_deref().unwrap().contains("你好"));
    }

    #[tokio::test]
    async fn no_executor_reports_error_not_fake_success() {
        let engine = HooksEngine::new();
        engine.register(deny_hook()).await;
        let ctx = HookContext::default();
        let results = engine.emit(HookEventType::PreToolUse, &ctx).await;
        assert!(results[0].error.as_deref().unwrap().contains("未注入"));
        assert!(!results[0].deny, "未执行不许假装拒绝");
    }

    #[tokio::test]
    async fn disabled_hook_never_fires() {
        let mut h = deny_hook();
        h.enabled = false;
        let engine = engine_with(vec![h]).await;
        let ctx = HookContext::default();
        assert!(engine.emit(HookEventType::PreToolUse, &ctx).await.is_empty());
    }

    #[tokio::test]
    async fn all_eight_event_types_supported() {
        let engine = HooksEngine::new();
        for ev in [
            HookEventType::PreToolUse,
            HookEventType::PostToolUse,
            HookEventType::OnMessage,
            HookEventType::OnSessionStart,
            HookEventType::OnSessionEnd,
            HookEventType::OnLoopStart,
            HookEventType::OnLoopEnd,
            HookEventType::OnError,
        ] {
            let h = HookConfig::new(format!("h-{ev:?}"), ev, HookExecMode::Shell);
            engine.register(h).await;
        }
        assert_eq!(engine.hook_count().await, 8);
    }
}
