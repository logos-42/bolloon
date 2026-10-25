//! HTTP API 服务（axum）— 学 hushforge 布局: 三栏网格 + 单页 index.html
//!
//! 本轮新增（Rust 原生版补齐）:
//! - DID 身份持久化 (`~/.bolloon/rust/identity.json`, 0600)
//! - 群聊端点 (GroupStore + 签名消息, ACL 创建者独占)
//! - 任务公告板端点 (`bolloon-task/1`, 签名 publish/claim)
//! - 记忆端点 (importance/decay, 快照落盘)
//! - 会话仅追加 JSONL 落盘 (`~/.bolloon/rust/sessions/`)

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    response::{Html, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use bolloon_agent::{MemoryLayer, MemoryStore, TaskBoard};
use bolloon_llm::{ChatMessage, GenerateParams, LlmRuntime};
use bolloon_p2p::{GroupAcl, GroupStore, KeyPair};

/// rust 原生版数据目录 (与 TS 版 `~/.bolloon` 共存, 子目录隔离)
fn data_dir() -> std::path::PathBuf {
    let home = std::env::var("BOLLOON_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            dirs_home().join(".bolloon")
        });
    home.join("rust")
}

fn dirs_home() -> std::path::PathBuf {
    std::env::var("HOME").map(std::path::PathBuf::from).unwrap_or_else(|_| std::path::PathBuf::from("/tmp"))
}

/// 服务状态（从上层注入）
#[derive(Clone)]
pub struct AppState {
    pub llm: Arc<LlmRuntime>,
    pub sessions: Arc<Mutex<Vec<SessionMeta>>>,
    pub messages: Arc<Mutex<Vec<ChatMessageView>>>,
    pub identity: Arc<KeyPair>,
    pub groups: Arc<GroupStore>,
    pub tasks: Arc<Mutex<TaskBoard>>,
    pub memory: Arc<Mutex<MemoryStore>>,
    pub session_store: Arc<bolloon_agent::SessionStore>,
    pub version: &'static str,
}

impl AppState {
    pub fn new(llm: LlmRuntime) -> Self {
        let dir = data_dir();
        let identity = Arc::new(load_or_create_identity(&dir));
        let memory = Arc::new(Mutex::new(load_memory(&dir)));
        let session_store = Arc::new(bolloon_agent::SessionStore::new(
            dir.join("sessions").join("default.jsonl"),
        ));
        // 任务公告板与 CLI 共用同一份落盘 (跨进程 dup/claim 判定同源)
        let tasks = Arc::new(Mutex::new(bolloon_agent::TaskBoard::load_json(
            &dir.join("task-board.json"),
        )));
        // 启动时恢复历史会话消息 (恢复不带任何权限 — 仅消息)
        let restored = session_store
            .load()
            .map(|(events, _)| {
                bolloon_agent::SessionStore::messages_of(&events)
                    .into_iter()
                    .map(|(role, content)| ChatMessageView { role, content })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Self {
            llm: Arc::new(llm),
            sessions: Arc::new(Mutex::new(vec![])),
            messages: Arc::new(Mutex::new(restored)),
            identity,
            groups: Arc::new(GroupStore::new()),
            tasks,
            memory,
            session_store,
            version: "0.6.10",
        }
    }
}

/// 加载或创建 DID 身份 (seed hex 落盘 0600)
fn load_or_create_identity(dir: &std::path::Path) -> KeyPair {
    let path = dir.join("identity.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(hex_seed) = v["seed_hex"].as_str() {
                if let Ok(seed) = hex::decode(hex_seed) {
                    if seed.len() == 32 {
                        let mut s = [0u8; 32];
                        s.copy_from_slice(&seed);
                        let kp = KeyPair::from_seed(&s);
                        tracing::info!("DID 身份已加载: {}", kp.did);
                        return kp;
                    }
                }
            }
        }
        tracing::warn!("identity.json 损坏, 重新生成 (旧 DID 作废)");
    }
    let kp = KeyPair::generate();
    let _ = std::fs::create_dir_all(dir);
    let body = serde_json::json!({
        "did": kp.did.as_str(),
        "seed_hex": hex::encode(kp_seed(&kp)),
    });
    if std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
    tracing::info!("DID 身份已创建: {}", kp.did);
    kp
}

/// 从 KeyPair 取种子 (ed25519-dalek: SigningKey bytes 即种子)
fn kp_seed(kp: &KeyPair) -> [u8; 32] {
    kp.secret_bytes()
}

/// 记忆快照落盘路径
fn memory_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("memory.json")
}

fn load_memory(dir: &std::path::Path) -> MemoryStore {
    match std::fs::read_to_string(memory_path(dir)) {
        Ok(raw) => match serde_json::from_str::<Vec<bolloon_agent::MemoryEntry>>(&raw) {
            Ok(entries) => {
                tracing::info!("记忆已恢复: {} 条", entries.len());
                MemoryStore::from_snapshot(entries)
            }
            Err(e) => {
                tracing::warn!("memory.json 解析失败, 从空记忆开始: {e}");
                MemoryStore::new()
            }
        },
        Err(_) => MemoryStore::new(),
    }
}

fn save_memory(dir: &std::path::Path, store: &MemoryStore) {
    if let Ok(raw) = serde_json::to_string_pretty(store.snapshot()) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(memory_path(dir), raw);
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
    did: String,
}

#[derive(Deserialize)]
struct SendRequest {
    text: String,
    session_id: Option<String>,
}

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
        // 群聊
        .route("/api/groups", get(list_groups).post(create_group))
        .route("/api/groups/{id}/messages", get(group_messages))
        .route("/api/groups/{id}/say", post(group_say))
        // 任务公告板
        .route("/api/tasks", get(list_tasks).post(publish_task))
        .route("/api/tasks/{id}/claim", post(claim_task))
        // 记忆
        .route("/api/memory", get(recall_memory).post(remember_memory))
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
        "did": st.identity.did.as_str(),
        "online": true,
    })];
    Json(BootstrapResponse {
        state: BootstrapState {
            agents,
            active_session_id: Some("default".into()),
            version: st.version.to_string(),
            edge: false,
            messages,
            did: st.identity.did.as_str().to_string(),
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

    // 记录回复 + 仅追加落盘 (可审计)
    {
        let mut msgs = st.messages.lock().await;
        msgs.push(ChatMessageView {
            role: "assistant".into(),
            content: reply.clone(),
        });
    }
    let _ = st.session_store.append(&bolloon_agent::SessionEvent::User { text: req.text });
    let _ = st
        .session_store
        .append(&bolloon_agent::SessionEvent::Assistant { text: reply.clone() });

    Json(SendResponse {
        session_id,
        reply,
    })
}

// ---------- 群聊 ----------

#[derive(Deserialize)]
struct CreateGroupRequest {
    name: String,
    /// 可选白名单 DID (缺省 = 创建者独占)
    members: Option<Vec<String>>,
}

async fn create_group(
    State(st): State<AppState>,
    Json(req): Json<CreateGroupRequest>,
) -> Json<serde_json::Value> {
    let id = format!("gw-{}", uuid_v4_short());
    let acl = match req.members {
        Some(wl) if !wl.is_empty() => GroupAcl::Whitelist(wl),
        _ => GroupAcl::OwnerOnly,
    };
    let info = st
        .groups
        .create_group(id.clone(), req.name, st.identity.did.clone(), acl)
        .await;
    Json(serde_json::to_value(info).unwrap())
}

async fn list_groups(State(st): State<AppState>) -> Json<serde_json::Value> {
    let groups = st.groups.list_groups().await;
    Json(serde_json::json!({ "groups": groups }))
}

#[derive(Deserialize)]
struct GroupQuery {
    after: Option<u64>,
}

async fn group_messages(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<GroupQuery>,
) -> Json<serde_json::Value> {
    let entries = st.groups.read(&id, q.after.unwrap_or(0), 200).await;
    Json(serde_json::json!({ "messages": entries }))
}

#[derive(Deserialize)]
struct GroupSayRequest {
    text: String,
}

async fn group_say(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<GroupSayRequest>,
) -> Json<serde_json::Value> {
    let kp = &st.identity;
    // 签名 = 对正文 + 发送者 DID 的 Ed25519 (b58)
    let mut sig_src = req.text.clone().into_bytes();
    sig_src.extend_from_slice(kp.did.as_str().as_bytes());
    let sig = bs58_encode(&kp.sign(&sig_src));
    let result = st
        .groups
        .append(
            &id,
            &kp.did,
            bolloon_p2p::EntryKind::Message,
            req.text,
            sig,
        )
        .await;
    match result {
        Ok(entry) => Json(serde_json::to_value(entry).unwrap()),
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

// ---------- 任务公告板 ----------

#[derive(Deserialize)]
struct PublishTaskRequest {
    capability: String,
    digest: String,
    budget: String,
    /// 截止 (epoch 毫秒, 可选)
    deadline_ms: Option<u64>,
}

async fn publish_task(
    State(st): State<AppState>,
    Json(req): Json<PublishTaskRequest>,
) -> Json<serde_json::Value> {
    let mut board = st.tasks.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let (id, dup) = board.publish(
        &st.identity,
        &req.capability,
        &req.digest,
        &req.budget,
        req.deadline_ms,
        now_ms,
    );
    let _ = board.save_json(&data_dir().join("task-board.json"));
    Json(serde_json::json!({ "id": id, "dup": dup, "protocol": bolloon_agent::TASK_PROTOCOL }))
}

async fn list_tasks(State(st): State<AppState>) -> Json<serde_json::Value> {
    let board = st.tasks.lock().await;
    let items: Vec<serde_json::Value> = board
        .board(None)
        .into_iter()
        .map(|a| {
            serde_json::json!({
                "id": a.id,
                "capability": a.capability,
                "digest": a.digest,
                "budget": a.budget,
                "issuer": a.issuer,
                "claimed": board.claimer_of(&a.id).is_some(),
                "claimer": board.claimer_of(&a.id),
            })
        })
        .collect();
    Json(serde_json::json!({ "tasks": items }))
}

async fn claim_task(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let mut board = st.tasks.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    match board.claim(&st.identity, &id, None, now_ms) {
        Ok(claim) => {
            let _ = board.save_json(&data_dir().join("task-board.json"));
            Json(serde_json::to_value(claim).unwrap())
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

// ---------- 记忆 ----------

#[derive(Deserialize)]
struct RememberRequest {
    content: String,
    /// 0.0 ~ 1.0, 缺省 0.5
    importance: Option<f64>,
    /// 层: run_fact | lesson | decision | temporary (缺省 run_fact)
    layer: Option<String>,
}

async fn remember_memory(
    State(st): State<AppState>,
    Json(req): Json<RememberRequest>,
) -> Json<serde_json::Value> {
    let layer = match req.layer.as_deref() {
        Some("lesson") => MemoryLayer::Lesson,
        Some("decision") => MemoryLayer::Decision,
        Some("temporary") => MemoryLayer::Temporary,
        _ => MemoryLayer::RunFact,
    };
    let mut mem = st.memory.lock().await;
    let entry = mem.remember(
        req.content,
        layer,
        req.importance.unwrap_or(0.5),
        None,
    );
    let view = serde_json::json!({
        "id": entry.id,
        "layer": entry.layer,
        "importance": entry.importance,
    });
    save_memory(&data_dir(), &mem);
    Json(view)
}

#[derive(Deserialize)]
struct RecallQuery {
    q: Option<String>,
    k: Option<usize>,
}

async fn recall_memory(State(st): State<AppState>, Query(q): Query<RecallQuery>) -> Json<serde_json::Value> {
    let mem = st.memory.lock().await;
    let items = mem.recall(q.q.as_deref(), q.k.unwrap_or(5), chrono::Utc::now());
    let items: Vec<serde_json::Value> = items
        .iter()
        .map(|e| {
            serde_json::json!({
                "id": e.id,
                "content": e.content,
                "layer": e.layer,
                "importance": e.importance,
                "created_at": e.created_at.to_rfc3339(),
            })
        })
        .collect();
    Json(serde_json::json!({ "memories": items }))
}

// ---------- utils ----------

fn uuid_v4_short() -> String {
    // 无 uuid 依赖时的简单随机 id (hex 12)
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs())
        .unwrap_or(0);
    format!("{nanos:012x}")
}

fn bs58_encode(bytes: &[u8]) -> String {
    // 复用 p2p crate 的 bs58 (web 自己不引依赖) — 直接重新导出使用
    bolloon_p2p::b58_encode(bytes)
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
