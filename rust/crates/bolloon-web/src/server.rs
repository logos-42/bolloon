//! HTTP API 服务（axum）— 学 hushforge 布局: 三栏网格 + 单页 index.html

use std::sync::Arc;

use axum::{
    extract::State,
    response::{Html, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use bolloon_llm::{ChatMessage, GenerateParams, LlmRuntime};

/// 服务状态（从上层注入）
#[derive(Clone)]
pub struct AppState {
    pub llm: Arc<LlmRuntime>,
    pub sessions: Arc<Mutex<Vec<SessionMeta>>>,
    pub messages: Arc<Mutex<Vec<ChatMessageView>>>,
    pub version: &'static str,
}

impl AppState {
    pub fn new(llm: LlmRuntime) -> Self {
        Self {
            llm: Arc::new(llm),
            sessions: Arc::new(Mutex::new(vec![])),
            messages: Arc::new(Mutex::new(vec![])),
            version: "0.6.10",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub agent: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageView {
    pub role: String,
    pub content: String,
}

/// bootstrap 响应（hushforge 的 /api/bootstrap 形状）
#[derive(Serialize)]
struct BootstrapResponse {
    state: BootstrapState,
    update: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct BootstrapState {
    agents: Vec<serde_json::Value>,
    active_session_id: Option<String>,
    version: String,
    edge: bool,
    messages: Vec<ChatMessageView>,
}

/// 发送消息的请求
#[derive(Deserialize)]
struct SendRequest {
    text: String,
    session_id: Option<String>,
}

/// 发送消息的响应
#[derive(Serialize)]
struct SendResponse {
    session_id: String,
    reply: String,
}

pub async fn serve(state: AppState, port: u16) -> anyhow::Result<()> {
    let app = Router::new()
        .route("/", get(index))
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/models", get(models))
        .route("/api/sessions", get(sessions))
        .route("/api/send", post(send))
        .route("/api/health", get(health))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!("bolloon web listening on http://127.0.0.1:{port}");
    axum::serve(listener, app)
        .await
        .map_err(|e| anyhow::anyhow!("web server: {e}"))
}

/// 主页面（内嵌 HTML）
async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": "0.6.10" }))
}

async fn bootstrap(State(st): State<AppState>) -> Json<BootstrapResponse> {
    let messages = st.messages.lock().await.clone();
    let agents = vec![serde_json::json!({
        "id": "local",
        "name": "Bolloon 本地智能体",
        "did": "did:pi:local",
        "online": true,
    })];
    Json(BootstrapResponse {
        state: BootstrapState {
            agents,
            active_session_id: Some("default".into()),
            version: st.version.to_string(),
            edge: false,
            messages,
        },
        update: None,
    })
}

async fn models(State(st): State<AppState>) -> Json<serde_json::Value> {
    let ids = st.llm.provider_ids();
    let providers: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            serde_json::json!({
                "id": id,
                "name": id,
                "models": st.llm.provider(id).map(|p| p.default_model.clone()).unwrap_or_default(),
            })
        })
        .collect();
    Json(serde_json::json!({ "providers": providers }))
}

async fn sessions(State(st): State<AppState>) -> Json<Vec<SessionMeta>> {
    Json(st.sessions.lock().await.clone())
}

async fn send(State(st): State<AppState>, Json(req): Json<SendRequest>) -> Json<SendResponse> {
    let session_id = req.session_id.unwrap_or_else(|| "default".to_string());

    // 记录用户消息
    {
        let mut msgs = st.messages.lock().await;
        msgs.push(ChatMessageView {
            role: "user".into(),
            content: req.text.clone(),
        });
    }

    // 真实模型调用（唯一咽喉 generate）
    let reply = match real_chat(&st.llm, &req.text).await {
        Ok(r) => r,
        Err(e) => format!("[AI 服务调用失败] {e}"),
    };

    // 记录回复
    {
        let mut msgs = st.messages.lock().await;
        msgs.push(ChatMessageView {
            role: "assistant".into(),
            content: reply.clone(),
        });
    }

    Json(SendResponse {
        session_id,
        reply,
    })
}

/// 单轮模型调用：provider 取第一个已配置的（web 是薄层, 不嵌 loop）
async fn real_chat(llm: &LlmRuntime, user_text: &str) -> Result<String, String> {
    let ids = llm.provider_ids();
    let provider_id = ids
        .first()
        .ok_or_else(|| "未配置模型 provider（bolloon model 设置）".to_string())?;
    let provider = llm
        .provider(provider_id)
        .ok_or_else(|| format!("provider {provider_id} 缺失"))?;

    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: "你是 Bolloon 智能体，运行在去中心化智能体资源交流网络中。回答中文，简洁、有依据。".into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
        ChatMessage {
            role: "user".into(),
            content: user_text.to_string(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
        },
    ];
    let params = GenerateParams::new(provider.default_model.clone(), messages);
    let result = llm.generate(provider_id, params).await.map_err(|e| e.to_string())?;
    Ok(result.content)
}

/// 内嵌单页 HTML（hushforge 布局: 284px 侧栏 + 主聊天 + room 面板）
const INDEX_HTML: &str = include_str!("../assets/index.html");