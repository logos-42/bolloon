//! LLM 运行时：OpenAI-compatible 调用
//!
//! 设计要点（对齐 bolloon-development skill 的 pi-ai 纪律）:
//! 1. generate_text 是全仓唯一模型调用咽喉（所有入口都经过它）
//! 2. 并发闸：同 provider|base_url 最多 LLM_MAX_CONCURRENCY 个在途，其余轮询排队
//! 3. 超时按上下文长度自适应（长上下文不被误杀）
//! 4. 429/5xx 指数退避；4xx 不重试（错误不是暂时的）
//! 5. 工具名出网前净化（^[a-zA-Z0-9_-]+$，不含 `.`）

use std::collections::HashMap;
use std::time::Duration;
use std::sync::Mutex; // 并发闸计数器: 同步锁 (凭证 Drop 里要能立刻归还, 不能 await)

use crate::config_store::Resolved;
use crate::provider_registry::Protocol;

/// 对话消息（OpenAI 形状）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallMsg>>,
    /// 附件图片 (**data URL**, `data:image/png;base64,…`)。
    ///
    /// 序列化口径见 `messages_payload`: **非空时** `content` 变成 OpenAI 视觉数组
    /// `[{type:text},{type:image_url}]`; 为空时消息形状与旧版**完全一致**
    /// (旧会话文件/旧调用方零迁移)。2026-10-26 前 `content` 是单模态 String,
    /// 贴图只能插 `@路径` —— 那是欠账, 这一版补上。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    /// 思考模式模型的思维链。DeepSeek v4 思考模式 **要求把上一轮的 reasoning_content
    /// 原样带回去**, 否则下一次请求直接 400 ("must be passed back to the API")。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolCallMsg {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: FunctionCall,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// 工具定义（发给模型的 schema）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ToolSchema {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: FunctionSchema,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FunctionSchema {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Provider 配置
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderConfig {
    pub id: String,
    pub base_url: String, // 必须含 /v1 前缀（教训: 不含前缀请求落站点根, 返回 HTML）
    pub api_key: Option<String>,
    pub default_model: String,
}

/// 请求参数
#[derive(Debug, Clone, serde::Serialize)]
pub struct GenerateParams {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolSchema>,
    pub temperature: f32,
    pub max_tokens: u32,
    /// 上下文长度（字符）——超时按它自适应
    pub context_chars: usize,
}

impl GenerateParams {
    pub fn new(model: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model: model.into(),
            messages,
            tools: vec![],
            temperature: 0.7,
            max_tokens: 4096,
            context_chars: 0,
        }
    }

    /// 自适应超时：短上下文 30s 底线，长上下文线性放宽
    pub fn timeout(&self) -> Duration {
        let base = Duration::from_secs(30);
        let extra = Duration::from_millis(
            ((self.context_chars as u64).saturating_div(1024)) * 4000 + 10_000,
        );
        base + extra
    }
}

/// 生成结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GenerateResult {
    pub content: String,
    pub tool_calls: Vec<ToolCallMsg>,
    pub finish_reason: String,
    pub usage: Usage,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Usage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
}

/// LLM 错误
#[derive(Debug, thiserror::Error)]
pub enum LlmError {
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("请求超时")]
    Timeout,
    #[error("网络错误: {0}")]
    Network(String),
    #[error("响应解析失败: {0}")]
    Parse(String),
    #[error("并发闸超时等待")]
    ConcurrencyQueueFull,
    #[error("配置错误: {0}")]
    Config(String),
}

/// 并发闸：同 key 最多 N 个在途（key = provider|base_url）
#[derive(Debug)]
/// 并发闸的**槽位凭证**: 靠 Drop 归还。
///
/// 2026-10-30 (leo: 运行到一半就停止了 / 之后一句都回不了):
/// 旧实现是「acquire 拿号 → await 完再手动 release」。只要这个 future 被丢掉
/// (客户端断线、点了停止、请求超时), release 就永远不会执行 ⇒ 槽位**永久泄漏**。
/// max=2 时泄漏两次之后, 之后每一次模型调用都会在 acquire 里无限轮询等待 ——
/// 表现为「聊天卡死 / 运行到一半停住」, 而且重启前不会自愈。
/// 现在归还由 RAII 保证 (计数器用同步锁, Drop 里能立刻还)。
struct GatePermit<'a> {
    gate: &'a ConcurrencyGate,
    key: String,
}

impl Drop for GatePermit<'_> {
    fn drop(&mut self) {
        let mut map = self
            .gate
            .in_flight
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(n) = map.get_mut(&self.key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(&self.key);
            }
        }
    }
}

#[derive(Debug)]
struct ConcurrencyGate {
    max: usize,
    in_flight: Mutex<HashMap<String, usize>>,
}

impl ConcurrencyGate {
    fn new(max: usize) -> Self {
        Self {
            max: max.max(1),
            in_flight: Mutex::new(HashMap::new()),
        }
    }

    /// 取一个槽位；满则轮询等待。凭证 drop 即归还（无论成功/失败/被丢弃）。
    async fn acquire(&self, key: &str) -> GatePermit<'_> {
        loop {
            {
                let mut map = self
                    .in_flight
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let n = map.entry(key.to_string()).or_insert(0);
                if *n < self.max {
                    *n += 1;
                    return GatePermit {
                        gate: self,
                        key: key.to_string(),
                    };
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }
}

/// 一个 provider 槽位 = 连接配置 + 走哪条协议分支
#[derive(Debug, Clone)]
pub struct ProviderSlot {
    pub cfg: ProviderConfig,
    pub protocol: Protocol,
}

/// LLM 运行时
#[derive(Debug)]
pub struct LlmRuntime {
    client: reqwest::Client,
    providers: HashMap<String, ProviderSlot>,
    gate: ConcurrencyGate,
}

impl LlmRuntime {
    pub fn new(providers: Vec<ProviderConfig>, max_concurrency: usize) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .expect("reqwest client 构造失败");
        Self {
            client,
            providers: providers
                .into_iter()
                .map(|p| {
                    let slot = ProviderSlot { cfg: p, protocol: Protocol::OpenAiCompatible };
                    (slot.cfg.id.clone(), slot)
                })
                .collect(),
            gate: ConcurrencyGate::new(max_concurrency),
        }
    }

    /// 注册/替换 provider（默认走 OpenAI 兼容协议）
    pub fn add_provider(&mut self, cfg: ProviderConfig) {
        self.add_provider_with(cfg, Protocol::OpenAiCompatible);
    }

    /// 注册/替换 provider 并指定协议分支
    pub fn add_provider_with(&mut self, cfg: ProviderConfig, protocol: Protocol) {
        self.providers.insert(cfg.id.clone(), ProviderSlot { cfg, protocol });
    }

    /// 从解析好的配置注册（协议、基址、key、模型一条带过来）
    pub fn add_resolved(&mut self, r: &Resolved) {
        self.add_provider_with(
            ProviderConfig {
                id: r.id.clone(),
                base_url: r.base_url.clone(),
                api_key: r.api_key.clone(),
                default_model: r.model.clone(),
            },
            r.protocol,
        );
    }

    /// 用当前配置重建: 只装**解析成功**的家 (没 key/没模型的进来只会在调用时报错)
    pub fn from_config(cfg: &crate::config_store::LlmConfig, max_concurrency: usize) -> Self {
        let usable = crate::config_store::usable(cfg);
        let mut rt = Self::new(vec![], max_concurrency);
        for r in &usable {
            rt.add_resolved(r);
        }
        rt
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.get(id).map(|s| &s.cfg)
    }

    /// 这家走哪条协议
    pub fn protocol_of(&self, id: &str) -> Option<Protocol> {
        self.providers.get(id).map(|s| s.protocol)
    }

    /// provider id 列表（web 展示用, 不含 key）
    pub fn provider_ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// 唯一调用入口：provider + params → 结果
    pub async fn generate(
        &self,
        provider_id: &str,
        params: GenerateParams,
    ) -> Result<GenerateResult, LlmError> {
        let slot = self
            .providers
            .get(provider_id)
            .ok_or_else(|| LlmError::Config(format!("provider {provider_id} 未配置")))?;

        // 并发闸（唯一咽喉）
        let key = format!("{}|{}", slot.cfg.id, slot.cfg.base_url);
        let _permit = self.gate.acquire(&key).await;

        let mut result = self.do_generate(slot, &params).await;
        if let Err(LlmError::Http { status: 400, body }) = &result {
            if body.contains("reasoning_content") {
                tracing::debug!(stream = false, shapes = %message_shapes(&params.messages), "400 缺思维链 — 请求形状");
                // ① 打补丁: 缺思维链的工具回合补空串再试
                let mut p1 = params.clone();
                fill_missing_reasoning(&mut p1.messages);
                result = match self.do_generate(slot, &p1).await {
                    Err(LlmError::Http { status: 400, body: b2 }) if b2.contains("reasoning_content") => {
                        // ② 仍被拒: 本次把工具协议摊平成纯文本轨迹 (语义保留, 不再要求思维链)
                        tracing::warn!(
                            provider = %slot.cfg.id,
                            "thinking 模式 reasoning_content 补不回来 — 本次降级为纯文本工具轨迹重试"
                        );
                        let mut p2 = params.clone();
                        flatten_tool_protocol(&mut p2.messages);
                        self.do_generate(slot, &p2).await
                    }
                    other => other,
                };
            }
        }
        result.inspect_err(|e| {
            tracing::debug!(provider = %slot.cfg.id, error = %e, "llm call failed");
        })
    }

    /// 流式生成 (SSE): 文本增量经 `on_delta` 逐段回调, 最终返回与 `generate`
    /// 同构的完整结果 (增量已全部累积, 调用方二选一用, 不会重复)。
    ///
    /// 只有 OpenAI 兼容协议真正走流式; 其余协议**如实退回**一次性 `generate`
    /// (on_delta 不触发 —— 不虚构逐 token, 调用方照常展示"思考中"动画)。
    pub async fn generate_streaming(
        &self,
        provider_id: &str,
        params: GenerateParams,
        on_delta: impl FnMut(&str),
    ) -> Result<GenerateResult, LlmError> {
        self.generate_streaming_full(provider_id, params, |_| {}, on_delta).await
    }

    /// 流式生成 + **思维链增量**回调: 思考模式下 `reasoning_content` 走 `on_thought`,
    /// 正文走 `on_delta`。界面据此显示"AI 真实在想什么/在写什么" —— 不做假进度文案。
    pub async fn generate_streaming_full(
        &self,
        provider_id: &str,
        params: GenerateParams,
        mut on_thought: impl FnMut(&str),
        mut on_delta: impl FnMut(&str),
    ) -> Result<GenerateResult, LlmError> {
        let slot = self
            .providers
            .get(provider_id)
            .ok_or_else(|| LlmError::Config(format!("provider {provider_id} 未配置")))?;
        if slot.protocol != Protocol::OpenAiCompatible {
            return self.generate(provider_id, params).await;
        }
        let key = format!("{}|{}", slot.cfg.id, slot.cfg.base_url);
        let _permit = self.gate.acquire(&key).await;
        let mut result = self
            .do_generate_stream(slot, &params, &mut on_thought, &mut on_delta)
            .await;
        // 两级兜底与**非流式那条完全对齐** (以前流式只做了第一级, 同样的问题在流式下会直接失败):
        // ① 缺思维链的工具回合补空串 ② 仍被拒 ⇒ 本次把工具协议摊平成纯文本轨迹
        if let Err(LlmError::Http { status: 400, body }) = &result {
            if body.contains("reasoning_content") {
                tracing::debug!(stream = true, shapes = %message_shapes(&params.messages), "400 缺思维链 — 请求形状");
                // 已吐出的增量不回滚, 只补发后续
                let mut p1 = params.clone();
                fill_missing_reasoning(&mut p1.messages);
                result = self
                    .do_generate_stream(slot, &p1, &mut on_thought, &mut on_delta)
                    .await;
                if let Err(LlmError::Http { status: 400, body: b2 }) = &result {
                    if b2.contains("reasoning_content") {
                        tracing::warn!(
                            provider = %slot.cfg.id,
                            "stream: reasoning_content 补不回来 — 本次降级为纯文本工具轨迹重试"
                        );
                        let mut p2 = params.clone();
                        flatten_tool_protocol(&mut p2.messages);
                        result = self
                            .do_generate_stream(slot, &p2, &mut on_thought, &mut on_delta)
                            .await;
                    }
                }
            }
        }
        result.inspect_err(|e| {
            tracing::debug!(provider = %slot.cfg.id, error = %e, "llm stream failed");
        })
    }

    async fn do_generate_stream(
        &self,
        slot: &ProviderSlot,
        params: &GenerateParams,
        on_thought: &mut impl FnMut(&str),
        on_delta: &mut impl FnMut(&str),
    ) -> Result<GenerateResult, LlmError> {
        let (url, headers, body) = openai_stream_request(&slot.cfg, params);
        let mut req = self.client.post(url).json(&body);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        // 429 / 5xx 退避重试 —— **与非流式那条同策略** (`post_json`), 不能"流式就直接失败":
        // 真实场景里交互第一轮就走流式, 那里不重试等于把限流直接甩到用户脸上。
        let max_retries: u32 = 2;
        let mut attempt: u32 = 0;
        let resp = loop {
            let r = req.try_clone().expect("请求必须可克隆").send().await.map_err(|e| {
                if e.is_timeout() {
                    LlmError::Timeout
                } else {
                    LlmError::Network(e.to_string())
                }
            })?;
            let st = r.status();
            if (st.as_u16() == 429 || st.as_u16() >= 500) && attempt < max_retries {
                attempt += 1;
                let exp: u32 = attempt.saturating_sub(1);
                let backoff = Duration::from_millis(300 * 2u64.pow(exp));
                tracing::warn!(
                    status = st.as_u16(),
                    backoff_ms = backoff.as_millis(),
                    stream = true,
                    "llm retry after backoff"
                );
                tokio::time::sleep(backoff).await;
                continue;
            }
            break r;
        };
        let status = resp.status();
        if !status.is_success() {
            let raw = resp.text().await.unwrap_or_default();
            return Err(LlmError::Http {
                status: status.as_u16(),
                body: truncate(&raw, 300),
            });
        }

        use futures::StreamExt;
        let mut acc = StreamAccumulator::default();
        let mut sse = SseBuffer::default();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| LlmError::Network(e.to_string()))?;
            for event in sse.push(&String::from_utf8_lossy(&chunk)) {
                let data = event.trim();
                if data == "[DONE]" {
                    return Ok(acc.finish(&params.model));
                }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    let (think, delta) = acc.feed_full(&v);
                    if !think.is_empty() {
                        on_thought(&think);
                    }
                    if !delta.is_empty() {
                        on_delta(&delta);
                    }
                }
            }
        }
        Ok(acc.finish(&params.model))
    }

    async fn do_generate(
        &self,
        slot: &ProviderSlot,
        params: &GenerateParams,
    ) -> Result<GenerateResult, LlmError> {
        match slot.protocol {
            Protocol::OpenAiCompatible => {
                let (url, headers, body) = openai_request(&slot.cfg, params);
                let v = self.post_json(slot, params, &url, headers, body).await?;
                parse_openai_response(v, &params.model)
            }
            Protocol::Anthropic => {
                let (url, headers, body) = anthropic_request(&slot.cfg, params)?;
                let v = self.post_json(slot, params, &url, headers, body).await?;
                parse_anthropic_response(v, &params.model)
            }
            Protocol::Gemini => {
                let (url, headers, body) = gemini_request(&slot.cfg, params)?;
                let v = self.post_json(slot, params, &url, headers, body).await?;
                parse_gemini_response(v, &params.model)
            }
            Protocol::Ollama => {
                let (url, headers, body) = ollama_request(&slot.cfg, params);
                let v = self.post_json(slot, params, &url, headers, body).await?;
                parse_ollama_response(v, &params.model)
            }
        }
    }

    /// 发请求 + 重试/退避 + 状态码判定 → JSON（协议无关的唯一出网口）
    async fn post_json(
        &self,
        slot: &ProviderSlot,
        params: &GenerateParams,
        url: &str,
        headers: Vec<(String, String)>,
        body: serde_json::Value,
    ) -> Result<serde_json::Value, LlmError> {
        let mut req = self.client.post(url).json(&body).timeout(params.timeout());
        for (k, v) in &headers {
            req = req.header(k, v);
        }

        // 退避参数（429/5xx）
        let max_retries: u32 = 2;
        let mut attempt: u32 = 0;
        loop {
            let started = std::time::Instant::now();
            let resp = match req.try_clone().expect("请求必须可克隆").send().await {
                Ok(r) => r,
                Err(e) if e.is_timeout() => {
                    return Err(LlmError::Timeout);
                }
                Err(e) => {
                    if attempt < max_retries {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
                        continue;
                    }
                    return Err(LlmError::Network(e.to_string()));
                }
            };
            let elapsed = started.elapsed();
            tracing::debug!(
                provider = %slot.cfg.id,
                protocol = slot.protocol.as_str(),
                model = %params.model,
                status = resp.status().as_u16(),
                elapsed_ms = elapsed.as_millis(),
                "llm http"
            );

            let status = resp.status();
            let raw = resp.text().await.unwrap_or_default();

            // 可重试：429 / 5xx（指数退避）
            if (status.as_u16() == 429 || status.as_u16() >= 500) && attempt < max_retries {
                attempt += 1;
                let exp: u32 = attempt.saturating_sub(1);
                let backoff = Duration::from_millis(300 * 2u64.pow(exp));
                tracing::warn!(
                    status = status.as_u16(),
                    backoff_ms = backoff.as_millis(),
                    "llm retry after backoff"
                );
                tokio::time::sleep(backoff).await;
                continue;
            }
            // 4xx 不重试（错误不是暂时的）
            if !status.is_success() {
                return Err(LlmError::Http {
                    status: status.as_u16(),
                    body: truncate(&raw, 300),
                });
            }

            return serde_json::from_str(&raw).map_err(|e| LlmError::Parse(e.to_string()));
        }
    }
}

// ────────────────────────── 4 条协议: 请求体 ──────────────────────────

fn base_of(cfg: &ProviderConfig) -> String {
    cfg.base_url.trim_end_matches('/').to_string()
}

/// OpenAI 兼容: `POST {base}/chat/completions`
fn openai_request(
    cfg: &ProviderConfig,
    params: &GenerateParams,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let url = format!("{}/chat/completions", base_of(cfg));
    let mut headers = vec![];
    if let Some(key) = &cfg.api_key {
        headers.push(("Authorization".to_string(), format!("Bearer {key}")));
    }
    let mut body = serde_json::json!({
        "model": params.model,
        "messages": messages_payload(&params.messages),
        "temperature": params.temperature,
        "max_tokens": params.max_tokens,
    });
    // 空 tools 不发 (有些家对 `"tools": []` 直接 400 — 200+ 家里不能赌)
    if !params.tools.is_empty() {
        body["tools"] = serde_json::to_value(&params.tools).unwrap_or_default();
    }
    (url, headers, body)
}

/// OpenAI 兼容流式请求体: 与 `openai_request` 同构, 但 `stream: true` (SSE)
fn openai_stream_request(
    cfg: &ProviderConfig,
    params: &GenerateParams,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let (url, headers, mut body) = openai_request(cfg, params);
    body["stream"] = serde_json::json!(true);
    (url, headers, body)
}

/// SSE 增量缓冲 (**纯函数**, 可单测): 网络字节流 → 完整的 `data:` 事件。
///
/// SSE 事件按行分隔; 半行留在缓冲里等下一个 chunk —— 断在转义/多字节 UTF-8
/// 中间也不会丢字 (调用方用 from_utf8_lossy, 事件行拼齐后再解析 JSON)。
#[derive(Default)]
pub(crate) struct SseBuffer {
    buf: String,
}

impl SseBuffer {
    pub fn push(&mut self, s: &str) -> Vec<String> {
        self.buf.push_str(s);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.find('\n') {
            let line: String = self.buf.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(data) = line.strip_prefix("data:") {
                out.push(data.trim().to_string());
            }
            // 其余行 (event:/id:/注释/空行) 对 OpenAI chunk 无意义, 丢弃
        }
        out
    }
}

/// 流式事件累积器 (**纯函数**, 可单测): OpenAI chunk → 文本增量 + 工具调用合并。
///
/// `tool_calls` 片段按 `index` 归位: id/name 取首个非空, arguments 逐段拼接
/// (上游把 JSON 参数拆成几个字符一片发过来)。
#[derive(Default)]
pub(crate) struct StreamAccumulator {
    content: String,
    /// 思考模式的思维链增量 (DeepSeek 要求回传)
    reasoning: String,
    tool_calls: Vec<ToolCallMsg>,
    finish_reason: String,
    usage: Usage,
}

impl StreamAccumulator {
    /// 喂一条 chunk; 返回 (**思维链增量**, **正文增量**)。
    ///
    /// 思考模式下模型先吐 `reasoning_content` 再吐 `content`, 两路要分开推给前端:
    /// 前者是"它真实在想什么", 后者是回答本身 —— 界面上不能混成一坨。
    pub fn feed_full(&mut self, v: &serde_json::Value) -> (String, String) {
        if let Some(u) = v.get("usage") {
            if u.is_object() {
                self.usage = serde_json::from_value(u.clone()).unwrap_or_default();
            }
        }
        let Some(choices) = v.get("choices").and_then(|c| c.as_array()) else {
            return (String::new(), String::new());
        };
        let Some(first) = choices.first() else {
            return (String::new(), String::new());
        };
        if let Some(f) = first.get("finish_reason").and_then(|f| f.as_str()) {
            self.finish_reason = f.to_string();
        }
        let mut delta_text = String::new();
        let mut think_text = String::new();
        let Some(delta) = first.get("delta") else {
            return (String::new(), delta_text);
        };
        if let Some(rc) = delta.get("reasoning_content").and_then(|c| c.as_str()) {
            self.reasoning.push_str(rc);
            think_text.push_str(rc);
        }
        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
            self.content.push_str(c);
            delta_text.push_str(c);
        }
        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
            for tc in tcs {
                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                while self.tool_calls.len() <= idx {
                    self.tool_calls.push(ToolCallMsg {
                        id: String::new(),
                        call_type: "function".into(),
                        function: FunctionCall { name: String::new(), arguments: String::new() },
                    });
                }
                let slot = &mut self.tool_calls[idx];
                if let Some(id) = tc.get("id").and_then(|x| x.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(f) = tc.get("function") {
                    if let Some(n) = f.get("name").and_then(|x| x.as_str()) {
                        if !n.is_empty() {
                            slot.function.name = n.to_string();
                        }
                    }
                    if let Some(a) = f.get("arguments").and_then(|x| x.as_str()) {
                        slot.function.arguments.push_str(a);
                    }
                }
            }
        }
        (think_text, delta_text)
    }

    pub fn finish(self, model: &str) -> GenerateResult {
        GenerateResult {
            content: self.content,
            tool_calls: self.tool_calls,
            finish_reason: self.finish_reason,
            usage: self.usage,
            model: model.to_string(),
            reasoning_content: if self.reasoning.is_empty() {
                None
            } else {
                Some(self.reasoning)
            },
        }
    }
}

/// 一条 HTTP 请求的形状: (url, 请求头, JSON 请求体)
pub type HttpRequestSpec = (String, Vec<(String, String)>, serde_json::Value);

/// Anthropic: `POST {base}/messages` + `x-api-key` + `anthropic-version`
fn anthropic_request(
    cfg: &ProviderConfig,
    params: &GenerateParams,
) -> Result<HttpRequestSpec, LlmError> {
    let key = cfg
        .api_key
        .as_ref()
        .ok_or_else(|| LlmError::Config("anthropic 协议需要 api_key".into()))?;
    let url = format!("{}/messages", base_of(cfg));
    let headers = vec![
        ("x-api-key".to_string(), key.clone()),
        ("anthropic-version".to_string(), "2023-06-01".to_string()),
    ];
    // system 消息要抬到顶层 `system` (Anthropic 不认 system role)
    let mut system = String::new();
    let mut msgs = vec![];
    for m in &params.messages {
        if m.role == "system" {
            if !system.is_empty() {
                system.push_str("\n\n");
            }
            system.push_str(&m.content);
            continue;
        }
        let role = if m.role == "assistant" { "assistant" } else { "user" };
        msgs.push(serde_json::json!({ "role": role, "content": m.content }));
    }
    let mut body = serde_json::json!({
        "model": params.model,
        "max_tokens": params.max_tokens,
        "temperature": params.temperature,
        "messages": msgs,
    });
    if !system.is_empty() {
        body["system"] = serde_json::Value::String(system);
    }
    if !params.tools.is_empty() {
        let tools: Vec<serde_json::Value> = params
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.function.name,
                    "description": t.function.description,
                    "input_schema": t.function.parameters,
                })
            })
            .collect();
        body["tools"] = serde_json::Value::Array(tools);
    }
    Ok((url, headers, body))
}

/// Gemini: `POST {base}/models/{model}:generateContent` + `x-goog-api-key`
fn gemini_request(
    cfg: &ProviderConfig,
    params: &GenerateParams,
) -> Result<HttpRequestSpec, LlmError> {
    let key = cfg
        .api_key
        .as_ref()
        .ok_or_else(|| LlmError::Config("gemini 协议需要 api_key".into()))?;
    let url = format!("{}/models/{}:generateContent", base_of(cfg), params.model);
    let headers = vec![("x-goog-api-key".to_string(), key.clone())];
    let mut contents = vec![];
    let mut system = String::new();
    for m in &params.messages {
        if m.role == "system" {
            if !system.is_empty() {
                system.push('\n');
            }
            system.push_str(&m.content);
            continue;
        }
        let role = if m.role == "assistant" { "model" } else { "user" };
        contents.push(serde_json::json!({
            "role": role,
            "parts": [{ "text": m.content }],
        }));
    }
    let mut body = serde_json::json!({
        "contents": contents,
        "generationConfig": {
            "temperature": params.temperature,
            "maxOutputTokens": params.max_tokens,
        },
    });
    if !system.is_empty() {
        body["systemInstruction"] = serde_json::json!({ "parts": [{ "text": system }] });
    }
    if !params.tools.is_empty() {
        let decls: Vec<serde_json::Value> = params
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "name": t.function.name,
                    "description": t.function.description,
                    "parameters": t.function.parameters,
                })
            })
            .collect();
        body["tools"] = serde_json::json!([{ "functionDeclarations": decls }]);
    }
    Ok((url, headers, body))
}

/// Ollama 本机: `POST {base}/api/chat` (不需要 key)
fn ollama_request(
    cfg: &ProviderConfig,
    params: &GenerateParams,
) -> (String, Vec<(String, String)>, serde_json::Value) {
    let url = format!("{}/api/chat", base_of(cfg));
    let msgs: Vec<serde_json::Value> = params
        .messages
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let body = serde_json::json!({
        "model": params.model,
        "messages": msgs,
        "stream": false,
        "options": {
            "temperature": params.temperature,
            "num_predict": params.max_tokens,
        },
    });
    (url, vec![], body)
}

/**
 * 消息数组 → 请求体里的 `messages`。
 *
 * 规则 (唯一收口, 别在调用方各拼一份):
 *   · **没图**: 原样序列化 (与旧版字节一致, 老会话文件/老调用方零迁移);
 *   · **有图**: `content` 换成 OpenAI 视觉数组 `[{type:text},{type:image_url,…}]`,
 *     其余字段 (role/name/tool_call_id/tool_calls) 原样带上。
 */
/// 请求形状摘要 (只出角色/结构/长度, **不出正文**) —— 400 时定位"哪条消息缺思维链"用。
///
/// 实测 (2026-10-30): DeepSeek 只在"assistant 带 tool_calls 却无 reasoning_content"时 400,
/// 纯文本带思维链、空串思维链都接受 ⇒ 摘要里 `tc=` 有值而 `rc=` 为 None 的就是那条。
fn message_shapes(msgs: &[ChatMessage]) -> String {
    msgs.iter()
        .enumerate()
        .map(|(i, m)| {
            let tc = m.tool_calls.as_ref().map(|c| c.len()).unwrap_or(0);
            let rc = m
                .reasoning_content
                .as_ref()
                .map(|r| r.chars().count().to_string())
                .unwrap_or_else(|| "None".to_string());
            format!("{i}:{}/tc={tc}/rc={rc}/len={}", m.role, m.content.chars().count())
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// DeepSeek 思考模式: **带 tool_calls 的 assistant 消息必须把 reasoning_content 原样带回**,
/// 少一个就 400「must be passed back to the API」。有些回合模型/中转不返回思维链 ⇒ 我们手上没有。
/// 第一步补丁: 缺的补成空串 (字段在场)。
pub fn fill_missing_reasoning(messages: &mut [ChatMessage]) {
    for m in messages.iter_mut() {
        if m.role == "assistant" && m.tool_calls.is_some() && m.reasoning_content.is_none() {
            m.reasoning_content = Some(String::new());
        }
    }
}

/// 第二步兜底: 空串也被拒时, 把「原生工具协议」摊平成纯文本轨迹 ——
/// assistant 的工具调用写成一句话, tool 结果当 user 观察。语义不丢, 但不再要求 reasoning_content。
pub fn flatten_tool_protocol(messages: &mut Vec<ChatMessage>) {
    let old = std::mem::take(messages);
    let mut out = Vec::with_capacity(old.len());
    for m in old {
        match m.role.as_str() {
            "assistant" if m.tool_calls.is_some() => {
                let names: Vec<String> = m
                    .tool_calls
                    .as_ref()
                    .map(|t| t.iter().map(|c| c.function.name.clone()).collect())
                    .unwrap_or_default();
                let text = if m.content.trim().is_empty() {
                    format!("（这一步调用了工具：{}）", names.join("、"))
                } else {
                    format!("{}\n（这一步调用了工具：{}）", m.content, names.join("、"))
                };
                out.push(ChatMessage {
                    content: text,
                    tool_calls: None,
                    tool_call_id: None,
                    reasoning_content: None,
                    ..m
                });
            }
            "tool" => out.push(ChatMessage {
                role: "user".into(),
                content: format!("工具执行结果：{}", m.content),
                name: None,
                tool_call_id: None,
                tool_calls: None,
                images: m.images,
                reasoning_content: None,
            }),
            _ => out.push(m),
        }
    }
    *messages = out;
}

pub fn messages_payload(messages: &[ChatMessage]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .map(|m| {
            if m.images.is_empty() {
                let mut o = serde_json::to_value(m).unwrap_or(serde_json::Value::Null);
                // **出站边界兜底** (2026-10-30 实测): DeepSeek 思考模式只拒绝「assistant 带
                // tool_calls 却整条没有 reasoning_content 字段」——传空串它接受, 字段缺失必 400。
                // 所以这里补字段, 而不是只依赖上层填: 任何代码路径忘了填, 也不会把整轮打挂。
                if m.role == "assistant"
                    && m.tool_calls.as_ref().map(|c| !c.is_empty()).unwrap_or(false)
                    && m.reasoning_content.is_none()
                {
                    o["reasoning_content"] = serde_json::Value::String(String::new());
                }
                return o;
            }
            let mut parts = vec![serde_json::json!({ "type": "text", "text": m.content })];
            for url in &m.images {
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": { "url": url }
                }));
            }
            let mut o = serde_json::json!({ "role": m.role, "content": parts });
            if let Some(n) = &m.name {
                o["name"] = serde_json::json!(n);
            }
            if let Some(id) = &m.tool_call_id {
                o["tool_call_id"] = serde_json::json!(id);
            }
            if let Some(rc) = &m.reasoning_content {
                o["reasoning_content"] = serde_json::Value::String(rc.clone());
            }
            if let Some(tcs) = &m.tool_calls {
                o["tool_calls"] = serde_json::to_value(tcs).unwrap_or(serde_json::Value::Null);
            }
            o
        })
        .collect()
}

/**
 * 模型名是否**已知**支持视觉输入 (前缀匹配, 保守清单)。
 *
 * 这不是能力协商 —— OpenAI 兼容接口没有这个端点; 清单只防一个最常见的坑:
 * 默认模型 `deepseek-chat` 是纯文本, 把像素发过去只会收获一个 400。
 * 不在清单里的模型用 `BOLLOON_VISION=1` 强制 (调用方负责)。
 */
pub fn is_vision_model(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    const PREFIXES: &[&str] = &[
        "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5", "o3", "o4-", "chatgpt-4o",
        "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
        "gemini", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "glm-4v", "glm-4.5v", "glm-4.6v",
        "grok-2-vision", "grok-4", "pixtral", "llama-3.2-90b", "llama-3.2-11b", "llama-4",
        "mistral-small-3.1", "doubao-1.5-vision", "kimi-latest",
    ];
    PREFIXES.iter().any(|p| m.starts_with(p))
}

/** 发图前的闸: 已知视觉模型放行; 不认识就给出人话错误 (含强制开关提示) */
pub fn check_vision(model: &str, images: usize) -> Result<(), String> {
    if images == 0 || is_vision_model(model) {
        return Ok(());
    }
    Err(format!(
        "模型 {model} 不在已知视觉清单里, {images} 张图片发过去大概率 400; \
         确认支持就用 BOLLOON_VISION=1 强制发送"
    ))
}

/// 解析 OpenAI 兼容响应
fn parse_openai_response(v: serde_json::Value, model: &str) -> Result<GenerateResult, LlmError> {
    let choices = v
        .get("choices")
        .and_then(|c| c.as_array())
        .ok_or_else(|| LlmError::Parse("choices 缺失".into()))?;
    let first = choices
        .first()
        .ok_or_else(|| LlmError::Parse("choices 为空".into()))?;
    let msg = first
        .get("message")
        .ok_or_else(|| LlmError::Parse("message 缺失".into()))?;

    let content = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let reasoning_content = msg
        .get("reasoning_content")
        .and_then(|r| r.as_str())
        .filter(|r| !r.is_empty())
        .map(|r| r.to_string());

    let tool_calls = msg
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|tc| {
                    let id = tc.get("id")?.as_str()?.to_string();
                    let call_type = tc.get("type").and_then(|t| t.as_str()).unwrap_or("function").to_string();
                    let function = tc.get("function")?;
                    let name = function.get("name")?.as_str()?.to_string();
                    let arguments = function
                        .get("arguments")
                        .and_then(|a| a.as_str())
                        .unwrap_or("{}")
                        .to_string();
                    Some(ToolCallMsg {
                        id,
                        call_type,
                        function: FunctionCall { name, arguments },
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let finish_reason = first
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .unwrap_or("stop")
        .to_string();

    let usage = v
        .get("usage")
        .map(|u| Usage {
            prompt_tokens: u.get("prompt_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
            completion_tokens: u
                .get("completion_tokens")
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as u32,
        })
        .unwrap_or_default();

    Ok(GenerateResult {
        content,
        tool_calls,
        finish_reason,
        usage,
        model: model.to_string(),
        reasoning_content: reasoning_content.clone(),
    })
}

/// 解析 Anthropic 响应 (`content[]` 文本块 + `tool_use` 块)
fn parse_anthropic_response(v: serde_json::Value, model: &str) -> Result<GenerateResult, LlmError> {
    let blocks = v
        .get("content")
        .and_then(|c| c.as_array())
        .ok_or_else(|| LlmError::Parse("content 缺失".into()))?;
    let mut content = String::new();
    let mut tool_calls = vec![];
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "text" => {
                if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                    content.push_str(t);
                }
            }
            "tool_use" => {
                let id = b.get("id").and_then(|s| s.as_str()).unwrap_or("tool").to_string();
                let name = b.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string();
                let arguments = b
                    .get("input")
                    .map(|i| i.to_string())
                    .unwrap_or_else(|| "{}".to_string());
                tool_calls.push(ToolCallMsg {
                    id,
                    call_type: "function".into(),
                    function: FunctionCall { name, arguments },
                });
            }
            _ => {}
        }
    }
    let finish_reason = v
        .get("stop_reason")
        .and_then(|s| s.as_str())
        .unwrap_or("stop")
        .to_string();
    let usage = v
        .get("usage")
        .map(|u| Usage {
            prompt_tokens: u.get("input_tokens").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
            completion_tokens: u
                .get("output_tokens")
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as u32,
        })
        .unwrap_or_default();
    Ok(GenerateResult {
        content,
        tool_calls,
        finish_reason,
        usage,
        model: model.to_string(),
        reasoning_content: None,
    })
}

/// 解析 Gemini 响应 (`candidates[0].content.parts[]`)
fn parse_gemini_response(v: serde_json::Value, model: &str) -> Result<GenerateResult, LlmError> {
    let cand = v
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|a| a.first())
        .ok_or_else(|| LlmError::Parse("candidates 缺失".into()))?;
    let parts = cand
        .get("content")
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .cloned()
        .unwrap_or_default();
    let mut content = String::new();
    let mut tool_calls = vec![];
    let mut idx = 0usize;
    for p in &parts {
        if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
            content.push_str(t);
        }
        if let Some(fc) = p.get("functionCall") {
            idx += 1;
            let name = fc.get("name").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let arguments = fc
                .get("args")
                .map(|a| a.to_string())
                .unwrap_or_else(|| "{}".to_string());
            tool_calls.push(ToolCallMsg {
                id: format!("gemini-call-{idx}"),
                call_type: "function".into(),
                function: FunctionCall { name, arguments },
            });
        }
    }
    let finish_reason = cand
        .get("finishReason")
        .and_then(|s| s.as_str())
        .unwrap_or("stop")
        .to_lowercase();
    let usage = v
        .get("usageMetadata")
        .map(|u| Usage {
            prompt_tokens: u.get("promptTokenCount").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
            completion_tokens: u
                .get("candidatesTokenCount")
                .and_then(|n| n.as_u64())
                .unwrap_or(0) as u32,
        })
        .unwrap_or_default();
    Ok(GenerateResult {
        content,
        tool_calls,
        finish_reason,
        usage,
        model: model.to_string(),
        reasoning_content: None,
    })
}

/// 解析 Ollama 响应 (`message.content` + `message.tool_calls`)
fn parse_ollama_response(v: serde_json::Value, model: &str) -> Result<GenerateResult, LlmError> {
    let msg = v
        .get("message")
        .ok_or_else(|| LlmError::Parse("message 缺失".into()))?;
    let content = msg
        .get("content")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let tool_calls = msg
        .get("tool_calls")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .enumerate()
                .filter_map(|(i, tc)| {
                    let f = tc.get("function")?;
                    let name = f.get("name")?.as_str()?.to_string();
                    let arguments = f
                        .get("arguments")
                        .map(|a| {
                            if a.is_string() {
                                a.as_str().unwrap_or("{}").to_string()
                            } else {
                                a.to_string()
                            }
                        })
                        .unwrap_or_else(|| "{}".to_string());
                    Some(ToolCallMsg {
                        id: format!("ollama-call-{}", i + 1),
                        call_type: "function".into(),
                        function: FunctionCall { name, arguments },
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let finish_reason = if v.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
        v.get("done_reason")
            .and_then(|s| s.as_str())
            .unwrap_or("stop")
            .to_string()
    } else {
        "stop".to_string()
    };
    let usage = Usage {
        prompt_tokens: v.get("prompt_eval_count").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
        completion_tokens: v.get("eval_count").and_then(|n| n.as_u64()).unwrap_or(0) as u32,
    };
    Ok(GenerateResult {
        content,
        tool_calls,
        finish_reason,
        usage,
        model: model.to_string(),
        reasoning_content: None,
    })
}

/// 工具名净化：^[a-zA-Z0-9_-]+$（不含 `.`）
/// 非法字符 → `_`；超长截断 + hash 后缀。保留原名映射由上层做。
pub fn sanitize_tool_name(name: &str) -> String {
    const MAX_LEN: usize = 64;
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.len() > MAX_LEN {
        use sha2::{Digest, Sha256};
        let hash = Sha256::digest(name.as_bytes());
        let suffix = hex::encode(&hash[..4]);
        out.truncate(MAX_LEN - suffix.len() - 1);
        out.push('_');
        out.push_str(&suffix);
    }
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}…", &s[..max])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SSE 缓冲: chunk 随意切, 事件行必须一行不少 (跨 chunk 的半行要等拼齐)
    #[test]
    fn sse_buffer_splits_events_across_chunks() {
        let mut sse = SseBuffer::default();
        assert_eq!(sse.push("data: {\"a\":1}\n\ndata: {\"b"), vec!["{\"a\":1}"], "完整行立即出, 半行等拼齐");
        let events = sse.push("\":2}\n\ndata: [DONE]\n\n");
        assert_eq!(events, vec!["{\"b\":2}", "[DONE]"]);
    }

    /// 累积器: 文本增量逐段回调内容一致; 工具调用片段按 index 拼合
    #[test]
    fn stream_accumulator_merges_text_and_tool_fragments() {
        let mut acc = StreamAccumulator::default();
        // 思考模式: reasoning_content 与 content 必须分两路返回 (前端想法/正文分开显示)
        let (t0, d0) = acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {"reasoning_content": "先看"}}]
        }));
        assert_eq!((t0.as_str(), d0.as_str()), ("先看", ""), "思考帧只有想法, 不能冒充正文");
        let (t1, d1) = acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {"content": "你"}}]
        }));
        let (t2, d2) = acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {"content": "好"}, "finish_reason": null}]
        }));
        assert!(t1.is_empty() && t2.is_empty(), "无思维链时想法增量为空");
        acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "function": {"name": "read_file", "arguments": "{\"path\":"}}
            ]}}]
        }));
        acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": "\"a.txt\"}"}}
            ]}}]
        }));
        acc.feed_full(&serde_json::json!({
            "choices": [{"delta": {}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        }));
        assert_eq!(d1, "你");
        assert_eq!(d2, "好");
        let r = acc.finish("m1");
        assert_eq!(r.content, "你好");
        assert_eq!(r.reasoning_content.as_deref(), Some("先看"), "思维链必须累积并可回传");
        assert_eq!(r.finish_reason, "tool_calls");
        assert_eq!(r.usage.prompt_tokens, 10);
        assert_eq!(r.tool_calls.len(), 1);
        let tc = &r.tool_calls[0];
        assert_eq!(tc.id, "call_1");
        assert_eq!(tc.function.name, "read_file");
        assert_eq!(tc.function.arguments, "{\"path\":\"a.txt\"}", "参数片段必须拼合");
    }

    /// 出站边界: assistant 带 tool_calls 且思维链为 None ⇒ 必须补成空串字段
    /// (字段缺失会让 DeepSeek 思考模式 400; 空串它接受 —— 实测三种回传形状)
    #[test]
    fn payload_fills_missing_reasoning_on_tool_calls() {
        let mut m = msg("assistant", "先看看");
        m.tool_calls = Some(vec![ToolCallMsg {
            id: "c1".into(),
            call_type: "function".into(),
            function: FunctionCall { name: "read_file".into(), arguments: "{}".into() },
        }]);
        m.reasoning_content = None;
        let v = messages_payload(&[m]);
        assert_eq!(v[0]["reasoning_content"], serde_json::json!(""), "缺字段就必须补空串");
        // 纯文本消息不补 (不必要地发字段也不是错, 但别乱加)
        let plain = messages_payload(&[msg("assistant", "hi")]);
        assert!(plain[0].get("reasoning_content").is_none(), "无 tool_calls 不补");
    }

    /// 流式请求体: stream 必须是 true, 其余与一次性请求同构
    #[test]
    fn openai_stream_request_sets_stream_true() {
        let p = GenerateParams::new("m", vec![msg("user", "hi")]);
        let (_, _, body) = openai_stream_request(&cfg("p", "https://api.x/v1", Some("sk")), &p);
        assert_eq!(body["stream"], serde_json::json!(true));
        assert_eq!(body["model"], serde_json::json!("m"));
    }

    fn msg(role: &str, text: &str) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content: text.into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
            reasoning_content: None,
        }
    }

    /// **没图**: 请求体里的消息与旧版形状完全一致 (老调用方零迁移)
    #[test]
    fn payload_without_images_keeps_plain_shape() {
        let v = messages_payload(&[msg("user", "你好")]);
        assert_eq!(v[0]["role"], "user");
        assert_eq!(v[0]["content"], "你好");
        assert!(v[0].get("images").is_none(), "没图就不许出现 images 字段");
    }

    /// **有图**: content 变成 text + image_url 数组 (OpenAI 视觉形状)
    #[test]
    fn payload_with_images_uses_vision_array() {
        let mut m = msg("user", "看图");
        m.images = vec!["data:image/png;base64,AAAA".into(), "data:image/jpeg;base64,BBBB".into()];
        let v = messages_payload(&[m]);
        let content = v[0]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3, "1 段文本 + 2 张图");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "看图");
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(content[2]["image_url"]["url"], "data:image/jpeg;base64,BBBB");
        assert_eq!(v[0]["role"], "user");
    }

    /// 视觉闸: 默认模型 (deepseek-chat) 拦下, 已知视觉模型放行, 0 张图放行
    #[test]
    fn vision_gate_blocks_unknown_models() {
        assert!(check_vision("deepseek-chat", 0).is_ok(), "没图永远放行");
        assert!(check_vision("deepseek-chat", 1).is_err(), "默认纯文本模型拦下");
        assert!(check_vision("deepseek-chat", 2).is_err());
        let e = check_vision("deepseek-chat", 1).unwrap_err();
        assert!(e.contains("BOLLOON_VISION"), "错误里要给强制开关: {e}");
        assert!(check_vision("gpt-4o", 1).is_ok());
        assert!(check_vision("gemini-2.0-flash", 1).is_ok());
        assert!(check_vision("qwen-vl-max", 1).is_ok());
        assert!(check_vision("Claude-Sonnet-4", 1).is_ok(), "大小写不敏感");
    }

    /// 带图请求真的把视觉数组发上线路 (mock server 抓包核对请求体)
    #[tokio::test]
    async fn request_body_carries_image_parts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 65536];
            let n = sock.read(&mut buf).await.unwrap();
            let raw = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = raw.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
            let resp = r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#;
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = sock.write_all(out.as_bytes()).await;
            body
        });

        let rt = LlmRuntime::new(
            vec![ProviderConfig {
                id: "mock-vision".into(),
                base_url: format!("http://{addr}/v1"),
                api_key: None,
                default_model: "gpt-4o".into(),
            }],
            1,
        );
        let mut m = msg("user", "这是什么图?");
        m.images = vec!["data:image/png;base64,AAAA".into()];
        let res = rt
            .generate("mock-vision", GenerateParams::new("gpt-4o", vec![m]))
            .await
            .unwrap();
        assert_eq!(res.content, "ok");

        let body = server.await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        let content = v["messages"][0]["content"].as_array().unwrap();
        assert_eq!(content[1]["type"], "image_url");
        assert_eq!(content[1]["image_url"]["url"], "data:image/png;base64,AAAA");
    }


    #[test]
    fn sanitize_rejects_dot() {
        assert_eq!(sanitize_tool_name("contact.list_authorized"), "contact_list_authorized");
        assert_eq!(sanitize_tool_name("read_file"), "read_file");
        assert_eq!(sanitize_tool_name("a.b.c"), "a_b_c");
        // 超长截断
        let long = "x".repeat(100);
        let s = sanitize_tool_name(&long);
        assert!(s.len() <= 64, "超长工具名必须截断, 实际 {}", s.len());
    }

    #[test]
    fn parse_response_with_tool_calls() {
        let v = serde_json::json!({
            "choices": [{
                "message": {
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "read_file", "arguments": "{\"path\":\"/tmp/x\"}"}
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5}
        });
        let r = parse_openai_response(v, "m").unwrap();
        assert_eq!(r.tool_calls.len(), 1);
        assert_eq!(r.tool_calls[0].function.name, "read_file");
        assert_eq!(r.finish_reason, "tool_calls");
        assert_eq!(r.usage.prompt_tokens, 10);
    }

    #[test]
    fn parse_response_plain() {
        let v = serde_json::json!({
            "choices": [{"message": {"content": "你好"}, "finish_reason": "stop"}]
        });
        let r = parse_openai_response(v, "m").unwrap();
        assert_eq!(r.content, "你好");
        assert!(r.tool_calls.is_empty());
    }

    #[test]
    fn timeout_scales_with_context() {
        let p = GenerateParams::new("m", vec![]);
        let short = p.timeout();
        let mut long = GenerateParams::new("m", vec![]);
        long.context_chars = 200_000; // 200KB 上下文
        let long_timeout = long.timeout();
        assert!(long_timeout > short, "长上下文超时应更宽");
    }

    /// DeepSeek 思考模式 400 的两级兜底: ① 缺思维链的工具回合补空串 ② 摊平成纯文本轨迹。
    #[test]
    fn reasoning_content_fallback_shapes() {
        let base = ChatMessage {
            role: "assistant".into(),
            content: String::new(),
            name: None,
            tool_call_id: None,
            images: vec![],
            tool_calls: Some(vec![ToolCallMsg {
                id: "call_1".into(),
                call_type: "function".into(),
                function: FunctionCall { name: "read_file".into(), arguments: "{}".into() },
            }]),
            reasoning_content: None,
        };
        let mut msgs = vec![base.clone()];
        fill_missing_reasoning(&mut msgs);
        assert_eq!(msgs[0].reasoning_content.as_deref(), Some(""), "缺的补成空串");
        // 已有思维链不覆盖 (DeepSeek 要求原样传回)
        let mut keep = vec![ChatMessage { reasoning_content: Some("想过了".into()), ..base.clone() }];
        fill_missing_reasoning(&mut keep);
        assert_eq!(keep[0].reasoning_content.as_deref(), Some("想过了"));

        let mut flat = vec![
            base,
            ChatMessage {
                role: "tool".into(),
                content: "hello".into(),
                name: None,
                tool_call_id: Some("call_1".into()),
                tool_calls: None,
                images: vec![],
                reasoning_content: None,
            },
        ];
        flatten_tool_protocol(&mut flat);
        assert!(flat.iter().all(|m| m.tool_calls.is_none() && m.tool_call_id.is_none()));
        assert!(flat[0].content.contains("read_file"), "工具名要留在轨迹里");
        assert_eq!(flat[1].role, "user");
        assert!(flat[1].content.contains("hello"), "工具结果要留在轨迹里");
    }

    #[tokio::test]
    async fn concurrency_gate_caps_inflight() {
        let gate = ConcurrencyGate::new(2);
        let key = "k1";
        let p1 = gate.acquire(key).await;
        let p2 = gate.acquire(key).await;
        // 第三个会阻塞——用 timeout 验证不会立刻放行
        let wait = tokio::time::timeout(Duration::from_millis(100), gate.acquire(key));
        assert!(wait.await.is_err(), "第 3 个并发应等待");
        drop(p1);
        let got = tokio::time::timeout(Duration::from_secs(1), gate.acquire(key))
            .await
            .expect("释放后应能获取");
        drop(got);
        drop(p2);
    }

    /// 槽位必须靠 Drop 归还: future 被丢弃 (客户端断线 / 停止 / 超时) 也不能泄漏。
    /// 旧实现泄漏两次后 (max=2) 之后每一次模型调用都会在 acquire 里无限等待 ⇒「运行到一半就停住」。
    #[tokio::test]
    async fn concurrency_gate_returns_slot_when_future_dropped() {
        let gate = ConcurrencyGate::new(1);
        {
            let fut = async {
                let _p = gate.acquire("k").await;
                std::future::pending::<()>().await;
            };
            let timed_out = tokio::time::timeout(Duration::from_millis(50), fut).await;
            assert!(timed_out.is_err(), "前提: 这个 future 确实被超时丢弃");
        }
        let got = tokio::time::timeout(Duration::from_millis(400), gate.acquire("k")).await;
        assert!(got.is_ok(), "丢弃的 future 必须归还槽位, 否则并发闸会被永久锁死");
    }

    #[tokio::test]
    async fn no_retry_on_4xx_via_mock_server() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // 简易 mock: 返回 400
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let resp = "HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\n{}";
            let _ = sock.write_all(resp.as_bytes()).await;
        });

        let rt = LlmRuntime::new(
            vec![ProviderConfig {
                id: "mock".into(),
                base_url: format!("http://{addr}/v1"),
                api_key: None,
                default_model: "m".into(),
            }],
            2,
        );
        let err = rt
            .generate(
                "mock",
                GenerateParams::new("m", vec![ChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
    reasoning_content: None,
}]),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, LlmError::Http { status: 400, .. }), "400 不应重试: {err:?}");
        server.abort();
    }

    #[tokio::test]
    async fn retries_on_429_then_succeeds() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // mock: 第一次 429, 第二次 200
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // 请求1 → 429
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf).await;
            let r1 = "HTTP/1.1 429 Too Many Requests\r\nContent-Length: 2\r\n\r\n{}";
            let _ = sock.write_all(r1.as_bytes()).await;
            // 请求2（同一连接重发）→ 200（Content-Length 必须与 body 真实字节数一致）
            let _ = sock.read(&mut buf).await;
            let body2 = r#"{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}"#;
            let r2 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body2.len(),
                body2
            );
            let _ = sock.write_all(r2.as_bytes()).await;
        });

        let rt = LlmRuntime::new(
            vec![ProviderConfig {
                id: "mock429".into(),
                base_url: format!("http://{addr}/v1"),
                api_key: None,
                default_model: "m".into(),
            }],
            2,
        );
        let r = rt
            .generate(
                "mock429",
                GenerateParams::new("m", vec![ChatMessage {
                    role: "user".into(),
                    content: "hi".into(),
                    name: None,
                    tool_call_id: None,
                    images: vec![],
                    tool_calls: None,
    reasoning_content: None,
}]),
            )
            .await
            .expect("429 退避后应成功");
        assert_eq!(r.content, "ok");
        server.abort();
    }

    // ────────── 4 条协议分支 (支撑 200+ provider 的关键) ──────────

    fn cfg(id: &str, base: &str, key: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            id: id.into(),
            base_url: base.into(),
            api_key: key.map(|s| s.to_string()),
            default_model: "m".into(),
        }
    }

    #[test]
    fn openai_request_omits_empty_tools_keeps_them_when_present() {
        let p = GenerateParams::new("m", vec![msg("user", "hi")]);
        let (url, headers, body) =
            openai_request(&cfg("deepseek", "https://api.x/v1", Some("sk")), &p);
        assert_eq!(url, "https://api.x/v1/chat/completions");
        assert_eq!(headers[0].0, "Authorization");
        assert_eq!(headers[0].1, "Bearer sk");
        assert!(body.get("tools").is_none(), "空 tools 不发 (有的家会 400)");

        let mut p2 = p.clone();
        p2.tools = vec![ToolSchema {
            tool_type: "function".into(),
            function: FunctionSchema {
                name: "shell".into(),
                description: "跑命令".into(),
                parameters: serde_json::json!({"type":"object"}),
            },
        }];
        let (_, headers, body) = openai_request(&cfg("deepseek", "https://api.x/v1", None), &p2);
        assert!(body["tools"].is_array());
        assert!(headers.is_empty(), "没 key 就不带鉴权头");
    }

    #[test]
    fn anthropic_request_hoists_system_and_uses_x_api_key() {
        let p = GenerateParams::new(
            "claude-sonnet-5",
            vec![msg("system", "你是 bolloon"), msg("user", "你好")],
        );
        let (url, headers, body) =
            anthropic_request(&cfg("anthropic", "https://api.anthropic.com/v1", Some("sk-a")), &p)
                .unwrap();
        assert_eq!(url, "https://api.anthropic.com/v1/messages");
        assert!(headers.iter().any(|(k, v)| k == "x-api-key" && v == "sk-a"));
        assert!(
            headers.iter().any(|(k, v)| k == "anthropic-version" && v == "2023-06-01"),
            "Anthropic 必须带版本头"
        );
        assert_eq!(body["system"], "你是 bolloon", "system 抬到顶层");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1, "system 不再占消息位");
        assert_eq!(body["messages"][0]["role"], "user");
        // 没 key → 明确报错 (不是发出去再 401)
        let err = anthropic_request(&cfg("anthropic", "https://api.anthropic.com/v1", None), &p);
        assert!(err.is_err());
    }

    #[test]
    fn gemini_request_builds_generate_content_url() {
        let p = GenerateParams::new("gemini-3.5-flash", vec![msg("user", "hi")]);
        let (url, headers, body) = gemini_request(
            &cfg("gemini", "https://generativelanguage.googleapis.com/v1beta", Some("k")),
            &p,
        )
        .unwrap();
        assert_eq!(
            url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
        );
        assert_eq!(headers[0].0, "x-goog-api-key");
        assert_eq!(body["contents"][0]["parts"][0]["text"], "hi");
        assert!(body["generationConfig"]["maxOutputTokens"].is_number());
    }

    #[test]
    fn ollama_request_has_no_auth_and_uses_api_chat() {
        let p = GenerateParams::new("llama4", vec![msg("user", "hi")]);
        let (url, headers, body) =
            ollama_request(&cfg("ollama", "http://localhost:11434", None), &p);
        assert_eq!(url, "http://localhost:11434/api/chat");
        assert!(headers.is_empty());
        assert_eq!(body["stream"], serde_json::json!(false), "非流式才是一次性结果");
        assert!(body["options"]["num_predict"].is_number());
    }

    #[test]
    fn parse_anthropic_and_gemini_and_ollama() {
        let a = parse_anthropic_response(
            serde_json::json!({
                "content": [
                    {"type":"text","text":"你好"},
                    {"type":"tool_use","id":"t1","name":"shell","input":{"cmd":"ls"}}
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 3, "output_tokens": 5}
            }),
            "claude",
        )
        .unwrap();
        assert_eq!(a.content, "你好");
        assert_eq!(a.tool_calls[0].function.name, "shell");
        assert!(a.tool_calls[0].function.arguments.contains("ls"));
        assert_eq!(a.usage.completion_tokens, 5);

        let g = parse_gemini_response(
            serde_json::json!({
                "candidates": [{
                    "content": {"parts": [{"text":"hi"}, {"functionCall":{"name":"shell","args":{"cmd":"pwd"}}}]},
                    "finishReason": "STOP"
                }],
                "usageMetadata": {"promptTokenCount": 7, "candidatesTokenCount": 2}
            }),
            "gemini",
        )
        .unwrap();
        assert_eq!(g.content, "hi");
        assert_eq!(g.tool_calls[0].function.name, "shell");
        assert_eq!(g.finish_reason, "stop");
        assert_eq!(g.usage.prompt_tokens, 7);

        let o = parse_ollama_response(
            serde_json::json!({
                "message": {"content": "本地回", "tool_calls": [{"function": {"name": "shell", "arguments": {"a": 1}}}]},
                "done": true,
                "done_reason": "stop",
                "prompt_eval_count": 4,
                "eval_count": 6
            }),
            "llama4",
        )
        .unwrap();
        assert_eq!(o.content, "本地回");
        assert!(o.tool_calls[0].function.arguments.contains("\"a\":1"));
        assert_eq!(o.usage.completion_tokens, 6);
    }

    /// 真发一次 Anthropic 形状请求 (mock server 抓 URL/头) — 证明分派真的改了出网形状
    #[tokio::test]
    async fn anthropic_protocol_really_hits_messages_endpoint() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 65536];
            let n = sock.read(&mut buf).await.unwrap();
            let raw = String::from_utf8_lossy(&buf[..n]).to_string();
            let resp = r#"{"content":[{"type":"text","text":"来自 anthropic"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":2}}"#;
            let out = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                resp.len(),
                resp
            );
            let _ = sock.write_all(out.as_bytes()).await;
            raw
        });

        let mut rt = LlmRuntime::new(vec![], 1);
        rt.add_provider_with(
            cfg("anthropic", &format!("http://{addr}/v1"), Some("sk-a")),
            Protocol::Anthropic,
        );
        let res = rt
            .generate("anthropic", GenerateParams::new("claude-sonnet-5", vec![msg("user", "hi")]))
            .await
            .unwrap();
        assert_eq!(res.content, "来自 anthropic");

        let raw = server.await.unwrap();
        assert!(raw.starts_with("POST /v1/messages"), "路径要是 /messages: {raw}");
        assert!(raw.to_lowercase().contains("x-api-key: sk-a"), "要带 x-api-key");
        assert!(raw.to_lowercase().contains("anthropic-version"), "要带版本头");
    }

    /// from_config: 配置解析出来的家带着正确协议进 runtime
    #[test]
    fn runtime_built_from_config_carries_protocols() {
        let cfg = crate::config_store::LlmConfig::default();
        let rt = LlmRuntime::from_config(&cfg, 2);
        // 本机 ollama 无需 key → 一定解析成功, 协议是 Ollama
        assert_eq!(rt.protocol_of("ollama"), Some(Protocol::Ollama));
        assert!(rt.protocol_of("nonexistent").is_none());
    }
}