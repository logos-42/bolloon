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
    response::{Html, IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use bolloon_agent::{MemoryStore, TaskBoard};
use bolloon_agent::judgment::JudgmentStore;
use bolloon_agent::world::{Opportunity, OpportunityStream};
use bolloon_agent::memory_db::MemoryDb;
use bolloon_agent::clarity::{clarity_of, ClaritySummary};
use bolloon_x402::{
    direct_payment::{verify_direct_payment, DirectPaymentConfig, PaymentClaim, RpcObservation},
    paid_info::{compute_content_hash, PaidInfoItem},
};
use bolloon_llm::{ChatMessage, GenerateParams, LlmRuntime};
use bolloon_p2p::{GroupAcl, GroupStore, KeyPair};
use std::io::Read;

/// rust 原生版数据目录 — **单一真源** (CLI/Web/App/SDK 同一口径: BolloonHome)
fn data_dir() -> std::path::PathBuf {
    bolloon_agent::home::BolloonHome::resolve().root().to_path_buf()
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
    pub judgments: Arc<Mutex<JudgmentStore>>,
    pub world: Arc<Mutex<OpportunityStream>>,
    /// x402 付费信息店 (item 元数据 + 内容本体; 内容只在付款后交付)
    pub paid_info: Arc<Mutex<std::collections::HashMap<String, (PaidInfoItem, String)>>>,
    /// 直付台账 (txHash 去重)
    pub x402_used_txs: Arc<Mutex<std::collections::HashSet<String>>>,
    /// 轻量 SQL 记忆库 (SQLite 单文件; 与 CLI 同一路径)
    pub memory_db: Arc<Mutex<MemoryDb>>,
    /// 完全访问权限开关 (UI 可随时开/取消; 默认关 = 走 permission 门)
    pub full_access: Arc<std::sync::atomic::AtomicBool>,
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
            judgments: Arc::new(Mutex::new(JudgmentStore::new())),
            world: Arc::new(Mutex::new(OpportunityStream::new())),
            paid_info: Arc::new(Mutex::new(std::collections::HashMap::new())),
            x402_used_txs: Arc::new(Mutex::new(std::collections::HashSet::new())),
            memory_db: Arc::new(Mutex::new(
                MemoryDb::open(dir.join("memory.db").to_str().unwrap_or("memory.db"))
                    .unwrap_or_else(|_| MemoryDb::open(":memory:").expect("内存库")),
            )),
            full_access: Arc::new(std::sync::atomic::AtomicBool::new(false)),
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
        // 判断力 (注入门 top-N)
        .route("/api/judgment", get(top_judgments).post(evolve_judgment))
        // 世界流 (机会 feed)
        .route("/api/world/feed", get(world_feed))
        // x402 付费信息 (402 报价 → 直付判定 → 交付)
        .route("/api/x402/info/{id}", get(x402_info_quote))
        .route("/api/x402/info/{id}/payment", post(x402_info_payment))
        .route("/api/x402/info", post(x402_publish))
        // Clarity 一键说清楚
        .route("/api/clarity", get(clarity))
        // 模型供应商列表 (筛选按钮弹窗数据源)
        .route("/api/providers", get(providers))
        // 自动更新 (未检测到更新前端不显示入口)
        .route("/api/update/check", get(update_check))
        .route("/api/update/install", post(update_install))
        // 完全访问权限开关 (可随时开/取消)
        .route("/api/permission", get(get_permission).post(set_permission))
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
    // 轻量 SQL 记忆库 (SQLite; 单一真源, CLI 同路径)
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let layer = match req.layer.as_deref() {
        Some("lesson") => "lesson",
        Some("decision") => "decision",
        Some("temporary") => "temporary",
        _ => "run_fact",
    };
    let db = st.memory_db.lock().await;
    let row = db
        .remember("local", layer, &req.content, req.importance.unwrap_or(0.5), now_ms, None)
        .map_err(|e| e.to_string());
    match row {
        Ok(r) => Json(serde_json::json!({
            "id": format!("mem-{:06}", r.id),
            "layer": r.layer,
            "importance": r.importance,
            "store": "sqlite",
        })),
        Err(e) => Json(serde_json::json!({ "error": e })),
    }
}

#[derive(Deserialize)]
struct RecallQuery {
    q: Option<String>,
    k: Option<usize>,
}

async fn recall_memory(State(st): State<AppState>, Query(q): Query<RecallQuery>) -> Json<serde_json::Value> {
    let db = st.memory_db.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    match db.recall("local", q.q.as_deref(), q.k.unwrap_or(5), now_ms) {
        Ok(rows) => {
            let items: Vec<serde_json::Value> = rows
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "id": format!("mem-{:06}", r.id),
                        "content": r.content,
                        "layer": r.layer,
                        "importance": r.importance,
                        "created_at": r.created_at_ms,
                        "store": "sqlite",
                    })
                })
                .collect();
            Json(serde_json::json!({ "memories": items, "store": "sqlite" }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// Clarity 一键说清楚 (纯函数: 从当前会话事件提取结构化现状)
async fn clarity(
    State(st): State<AppState>,
    Query(q): Query<RecallQuery>,
) -> Json<ClaritySummary> {
    let msgs = st.messages.lock().await;
    let events: Vec<(&str, &str)> = msgs
        .iter()
        .map(|m| (m.role.as_str(), m.content.as_str()))
        .collect();
    let sid = q.q.clone().unwrap_or_else(|| "default".into());
    Json(clarity_of(&sid, &events, &[], &[]))
}

/// 模型供应商列表 (配置里的 provider ids + 当前默认模型)
async fn providers(State(st): State<AppState>) -> Json<serde_json::Value> {
    let ids = st.llm.provider_ids();
    let items: Vec<serde_json::Value> = ids
        .iter()
        .map(|id| {
            let cfg = st.llm.provider(id);
            serde_json::json!({
                "id": id,
                "base_url": cfg.map(|c| c.base_url.clone()).unwrap_or_default(),
                "model": cfg.map(|c| c.default_model.clone()).unwrap_or_default(),
                "has_key": cfg.map(|c| c.api_key.is_some()).unwrap_or(false),
            })
        })
        .collect();
    Json(serde_json::json!({ "providers": items }))
}

/// 自动更新检查 (源不可达/无更新 → update_available=false, 前端不显示入口)
async fn update_check() -> Json<bolloon_agent::updater::UpdateInfo> {
    struct GitHubSource;
    impl bolloon_agent::updater::UpdateSource for GitHubSource {
        fn latest_version(&self) -> Result<String, String> {
            // GitHub Release latest (无网络/超时 → Err, 如实 unknown)
            let body: serde_json::Value = ureq::get(
                "https://api.github.com/repos/logos-42/bolloon/releases/latest",
            )
            .timeout(std::time::Duration::from_secs(5))
            .set("User-Agent", "bolloon-updater")
            .call()
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())?;
            body["tag_name"]
                .as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| "无 tag_name".into())
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            let bytes = ureq::get("https://github.com/logos-42/bolloon/releases/latest/download/bolloon-bin")
                .timeout(std::time::Duration::from_secs(120))
                .call()
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            bytes
                .into_reader()
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
            Ok(out)
        }
    }
    Json(bolloon_agent::updater::check(&GitHubSource))
}

/// 内部安装一条龙: 下载→原子替换→请求重启 (无弹窗; 状态走按钮文字)
async fn update_install() -> Json<serde_json::Value> {
    struct GitHubSource;
    impl bolloon_agent::updater::UpdateSource for GitHubSource {
        fn latest_version(&self) -> Result<String, String> {
            Ok("latest".into())
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            let bytes = ureq::get("https://github.com/logos-42/bolloon/releases/latest/download/bolloon-bin")
                .timeout(std::time::Duration::from_secs(120))
                .call()
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            bytes
                .into_reader()
                .read_to_end(&mut out)
                .map_err(|e| e.to_string())?;
            Ok(out)
        }
    }
    let Ok(self_path) = std::env::current_exe() else {
        return Json(serde_json::json!({ "error": "无法定位自身二进制" }));
    };
    match bolloon_agent::updater::install(&GitHubSource, &self_path) {
        Ok(report) => {
            // 一条龙最后一步: spawn 新进程 (同参数) — 旧进程随后由调用方退出
            let args: Vec<String> = std::env::args().skip(1).collect();
            let new_pid = bolloon_agent::updater::restart(&self_path, &args).ok();
            Json(serde_json::json!({
                "installing": true,
                "restarting": new_pid.is_some(),
                "new_pid": new_pid,
                "report": report,
            }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// 完全访问权限: 读
async fn get_permission(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "full_access": st.full_access.load(std::sync::atomic::Ordering::SeqCst),
    }))
}

/// 完全访问权限: 开/取消 (随时可切)
async fn set_permission(
    State(st): State<AppState>,
    Json(req): Json<std::collections::HashMap<String, bool>>,
) -> Json<serde_json::Value> {
    let on = req.get("full_access").copied().unwrap_or(false);
    st.full_access.store(on, std::sync::atomic::Ordering::SeqCst);
    Json(serde_json::json!({ "full_access": on }))
}

// ---------- 判断力 ----------

async fn top_judgments(
    State(st): State<AppState>,
    Query(q): Query<RecallQuery>,
) -> Json<serde_json::Value> {
    let store = st.judgments.lock().await;
    let picks = store.top_for_domain(q.q.as_deref().unwrap_or("all"), q.k.unwrap_or(3));
    let items: Vec<serde_json::Value> = picks
        .iter()
        .map(|j| serde_json::json!({ "id": j.id, "statement": j.statement, "domain": j.domain, "confidence": j.confidence }))
        .collect();
    Json(serde_json::json!({ "judgments": items }))
}

#[derive(Deserialize)]
struct EvolveJudgmentRequest {
    statement: String,
    /// 意图域 (缺省 all)
    domain: Option<String>,
    confidence: Option<f64>,
}

async fn evolve_judgment(
    State(st): State<AppState>,
    Json(req): Json<EvolveJudgmentRequest>,
) -> Json<serde_json::Value> {
    let mut store = st.judgments.lock().await;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let action = store.evolve(&req.statement, req.domain.as_deref().unwrap_or("all"), req.confidence.unwrap_or(0.7), now_ms);
    let (kind, detail) = match &action {
        bolloon_agent::judgment::EvolveAction::None => ("none", "无动作".to_string()),
        bolloon_agent::judgment::EvolveAction::Merged { with, .. } => ("merged", format!("并入 {with}")),
        bolloon_agent::judgment::EvolveAction::Contradicted { with } => ("contradicted", format!("与 {with} 反向 (标记给用户)")),
        bolloon_agent::judgment::EvolveAction::Superseded { old } => ("superseded", format!("顶掉 {old}")),
        bolloon_agent::judgment::EvolveAction::Created { id } => ("created", format!("新增 {id}")),
    };
    Json(serde_json::json!({ "action": kind, "detail": detail }))
}

// ---------- 世界流 ----------

#[derive(Deserialize)]
struct WorldFeedQuery {
    /// 意图标签 (逗号分隔, 可选)
    tags: Option<String>,
}

async fn world_feed(
    State(st): State<AppState>,
    Query(q): Query<WorldFeedQuery>,
) -> Json<serde_json::Value> {
    let mut world = st.world.lock().await;
    // 演示种子 (真实机会由 world-watcher / P2P 投递注入; 无意图也流入, 永不空流)
    if world.feed().is_empty() {
        for (title, summary, tags, url) in [
            ("世界流: 默认流入不空", "没有意图也保持世界流动", vec!["world".to_string()], None),
            ("合作机会示例", "可控核聚变 论文合作招募", vec!["聚变".to_string(), "合作".to_string()], Some("https://example.com/1".into())),
        ] {
            let (score, reason) = bolloon_agent::world::score_opportunity(&tags, &[]);
            world.push(Opportunity {
                id: String::new(),
                title: title.into(),
                summary: summary.into(),
                source: "world".into(),
                score,
                reason,
                card: None,
                url,
            });
        }
        // 带意图时重打分 (透明 reason)
        if let Some(tags) = &q.tags {
            let intent_tags: Vec<String> = tags.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            let mut rescored = Vec::new();
            for opp in world.feed() {
                let mut o = opp.clone();
                let (score, reason) = bolloon_agent::world::score_opportunity(&intent_tags, &intent_tags.clone());
                let _ = (&o, &tags);
                o.score = score;
                o.reason = reason;
                rescored.push(o);
            }
            return Json(serde_json::json!({ "feed": rescored, "intent_tags": intent_tags }));
        }
    }
    let feed: Vec<serde_json::Value> = world
        .feed()
        .iter()
        .map(|o| {
            serde_json::json!({
                "id": o.id, "title": o.title, "summary": o.summary,
                "source": o.source, "score": o.score, "reason": o.reason,
                "url": o.url,
            })
        })
        .collect();
    Json(serde_json::json!({ "feed": feed }))
}

// ---------- x402 付费信息 ----------

#[derive(Deserialize)]
struct PublishInfoRequest {
    id: String,
    title: String,
    #[serde(default = "default_category")]
    category: String,
    price_amount: String,
    price_amount_atomic: u64,
    pay_to: String,
    content: String,
    provider_did: String,
}

fn default_category() -> String {
    "data".into()
}

/// 上架 (卖方本机; 内容本体只进本机 store)
async fn x402_publish(
    State(st): State<AppState>,
    Json(req): Json<PublishInfoRequest>,
) -> Json<serde_json::Value> {
    let item = PaidInfoItem {
        protocol: bolloon_x402::paid_info::INFO_PROTOCOL.into(),
        id: req.id.clone(),
        title: req.title,
        category: serde_json::from_value(serde_json::Value::String(req.category.clone()))
            .unwrap_or(bolloon_x402::paid_info::InfoCategory::Other),
        description: None,
        price: bolloon_x402::paid_info::InfoPrice {
            amount: req.price_amount,
            amount_atomic: req.price_amount_atomic,
            currency: "USDC".into(),
            network: "base".into(),
            pay_to: req.pay_to,
        },
        provider_did: req.provider_did,
        content_hash: compute_content_hash(&req.content),
        issued_at_ms: chrono::Utc::now().timestamp_millis() as u64,
    };
    st.paid_info.lock().await.insert(req.id.clone(), (item.clone(), req.content));
    Json(serde_json::to_value(&item).unwrap())
}

/// 无付款 → 402 报价 (形状与 TS 版一致)
async fn x402_info_quote(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> axum::response::Response {
    let store = st.paid_info.lock().await;
    let Some((item, _)) = store.get(&id) else {
        return (axum::http::StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"not found"}))).into_response();
    };
    let accepts = serde_json::json!({
        "scheme": "exact",
        "network": item.price.network,
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "amount": item.price.amount_atomic,
        "payTo": item.price.pay_to,
        "maxTimeoutSeconds": 60,
        "extra": { "name": "USDC", "itemId": item.id },
    });
    let body = serde_json::json!({
        "x402Version": 1,
        "error": "X402_PAYMENT_REQUIRED",
        "accepts": [accepts],
    });
    (
        axum::http::StatusCode::PAYMENT_REQUIRED,
        [("x-payment-required", serde_json::to_string(&accepts).unwrap().as_str())],
        Json(body),
    )
        .into_response()
}

/// 付款声明核验 (观察由买方/卖方注入; ≥2 RPC 一致才交付)
#[derive(Deserialize)]
struct PaymentVerifyRequest {
    claim: PaymentClaim,
    observations: Vec<RpcObservation>,
}

async fn x402_info_payment(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PaymentVerifyRequest>,
) -> Json<serde_json::Value> {
    let store = st.paid_info.lock().await;
    let Some((item, content)) = store.get(&id) else {
        return Json(serde_json::json!({"error": "not found"}));
    };
    let mut claim = req.claim.clone();
    claim.item_id = id.clone();
    claim.expected_amount_atomic = item.price.amount_atomic as u128;
    claim.pay_to = item.price.pay_to.to_lowercase();

    let used = st.x402_used_txs.lock().await.clone();
    let cfg = DirectPaymentConfig::default();
    let report = verify_direct_payment(&cfg, &claim, &req.observations, &used);
    match report.verdict {
        bolloon_x402::PaymentVerdict::Verified | bolloon_x402::PaymentVerdict::SelfAttested => {
            st.x402_used_txs.lock().await.insert(claim.tx_hash.clone());
            Json(serde_json::json!({
                "status": "delivered",
                "verdict": report.verdict,
                "content": content,
                "contentHash": item.content_hash,
                "selfAttested": report.verdict == bolloon_x402::PaymentVerdict::SelfAttested,
            }))
        }
        other => Json(serde_json::json!({
            "status": "rejected",
            "verdict": other,
            "failed": report.failed,
        })),
    }
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
