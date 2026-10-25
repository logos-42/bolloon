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
use tokio::sync::Mutex;

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

    /// 尝试获取槽位；满则轮询等待（可 abort）
    async fn acquire(&self, key: &str) -> bool {
        loop {
            {
                let mut map = self.in_flight.lock().await;
                let n = map.entry(key.to_string()).or_insert(0);
                if *n < self.max {
                    *n += 1;
                    return true;
                }
            }
            tokio::time::sleep(Duration::from_millis(120)).await;
        }
    }

    async fn release(&self, key: &str) {
        let mut map = self.in_flight.lock().await;
        if let Some(n) = map.get_mut(key) {
            *n = n.saturating_sub(1);
            if *n == 0 {
                map.remove(key);
            }
        }
    }
}

/// LLM 运行时
#[derive(Debug)]
pub struct LlmRuntime {
    client: reqwest::Client,
    providers: HashMap<String, ProviderConfig>,
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
                .map(|p| (p.id.clone(), p))
                .collect(),
            gate: ConcurrencyGate::new(max_concurrency),
        }
    }

    /// 注册/替换 provider
    pub fn add_provider(&mut self, cfg: ProviderConfig) {
        self.providers.insert(cfg.id.clone(), cfg);
    }

    pub fn provider(&self, id: &str) -> Option<&ProviderConfig> {
        self.providers.get(id)
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
        let provider = self
            .providers
            .get(provider_id)
            .ok_or_else(|| LlmError::Config(format!("provider {provider_id} 未配置")))?;

        // 并发闸（唯一咽喉）
        let key = format!("{}|{}", provider.id, provider.base_url);
        if !self.gate.acquire(&key).await {
            return Err(LlmError::ConcurrencyQueueFull);
        }

        let result = self
            .do_generate(provider, &params)
            .await
            .inspect_err(|e| {
                tracing::debug!(provider = %provider.id, error = %e, "llm call failed");
            });
        self.gate.release(&key).await;
        result
    }

    async fn do_generate(
        &self,
        provider: &ProviderConfig,
        params: &GenerateParams,
    ) -> Result<GenerateResult, LlmError> {
        let url = format!(
            "{}/chat/completions",
            provider.base_url.trim_end_matches('/')
        );

        let mut req = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "model": params.model,
                "messages": params.messages,
                "tools": params.tools,
                "temperature": params.temperature,
                "max_tokens": params.max_tokens,
            }))
            .timeout(params.timeout());

        if let Some(key) = &provider.api_key {
            req = req.bearer_auth(key);
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
                provider = %provider.id,
                model = %params.model,
                status = resp.status().as_u16(),
                elapsed_ms = elapsed.as_millis(),
                "llm http"
            );

            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();

            // 可重试：429 / 5xx（指数退避）
            if status.as_u16() == 429 || status.as_u16() >= 500 {
                if attempt < max_retries {
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
            }
            // 4xx 不重试（错误不是暂时的）
            if !status.is_success() {
                return Err(LlmError::Http {
                    status: status.as_u16(),
                    body: truncate(&body, 300),
                });
            }

            // 解析
            let parsed: serde_json::Value =
                serde_json::from_str(&body).map_err(|e| LlmError::Parse(e.to_string()))?;
            return parse_response(parsed, &params.model);
        }
    }
}

/// 解析 OpenAI 响应
fn parse_response(v: serde_json::Value, model: &str) -> Result<GenerateResult, LlmError> {
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
        let r = parse_response(v, "m").unwrap();
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
        let r = parse_response(v, "m").unwrap();
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

    #[tokio::test]
    async fn concurrency_gate_caps_inflight() {
        let gate = ConcurrencyGate::new(2);
        let key = "k1";
        assert!(gate.acquire(key).await);
        assert!(gate.acquire(key).await);
        // 第三个会阻塞——用 timeout 验证不会立刻放行
        let wait = tokio::time::timeout(Duration::from_millis(100), gate.acquire(key));
        assert!(wait.await.is_err(), "第 3 个并发应等待");
        gate.release(key).await;
        let got = tokio::time::timeout(Duration::from_secs(1), gate.acquire(key))
            .await
            .expect("释放后应能获取");
        assert!(got);
        gate.release(key).await;
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
                    tool_calls: None,
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
                    tool_calls: None,
                }]),
            )
            .await
            .expect("429 退避后应成功");
        assert_eq!(r.content, "ok");
        server.abort();
    }
}