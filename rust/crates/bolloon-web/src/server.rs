//! HTTP API 服务（axum）— 学 hushforge 布局: 三栏网格 + 单页 index.html
//!
//! 本轮新增（Rust 原生版补齐）:
//! - DID 身份持久化 (`~/.bolloon/rust/identity.json`, 0600)
//! - 群聊端点 (OrbitDB events store: 内容寻址 + 落盘 + 可复制)
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

use bolloon_agent::{MemoryLayer, MemoryStore, TaskBoard};
use bolloon_agent::judgment::JudgmentStore;
use bolloon_agent::world::{Opportunity, OpportunityStream};
use bolloon_agent::memory_db::MemoryDb;
use bolloon_agent::clarity::{clarity_of, ClaritySummary};
use bolloon_x402::{
    direct_payment::{verify_direct_payment, DirectPaymentConfig, PaymentClaim, RpcObservation},
    paid_info::{compute_content_hash, PaidInfoItem},
};
use bolloon_llm::{LlmRuntime, ProviderConfig};
use bolloon_p2p::{GroupAcl, GroupOrbitHub, KeyPair};
use std::io::Read;

/// rust 原生版数据目录 — **单一真源** (CLI/Web/App/SDK 同一口径: BolloonHome)
pub fn data_dir() -> std::path::PathBuf {
    bolloon_agent::home::BolloonHome::resolve().root().to_path_buf()
}

/// 服务状态（从上层注入）
#[derive(Clone)]
pub struct AppState {
    /// 模型运行时 — **可热替换**: 用户在 UI 里改 provider/key 后重建 (Arc 快照, 不持锁过 await)
    pub llm: Arc<std::sync::RwLock<Arc<LlmRuntime>>>,
    pub sessions: Arc<Mutex<Vec<SessionMeta>>>,
    pub messages: Arc<Mutex<Vec<ChatMessageView>>>,
    pub identity: Arc<KeyPair>,
    pub groups: Arc<GroupOrbitHub>,
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
    /// 更新安装互斥 (两个请求同时替换同一二进制会把自己装残)
    pub updating: Arc<std::sync::atomic::AtomicBool>,
    /// Forge 兼容层状态 (agents/sessions/profile/settings/auth 队列)
    pub forge: Arc<Mutex<crate::native::NativeState>>,
    /// 项目 skills 注册表 (经验提炼后升级到这里; 做梦机制用)
    pub skills: Arc<Mutex<bolloon_agent::skills_runtime::SkillEvolver>>,
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
            llm: Arc::new(std::sync::RwLock::new(Arc::new(llm))),
            sessions: Arc::new(Mutex::new(vec![])),
            messages: Arc::new(Mutex::new(restored)),
            identity,
            groups: Arc::new(GroupOrbitHub::new(dir.join("orbitdb"))),
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
            updating: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            forge: Arc::new(Mutex::new(crate::native::NativeState::load(&dir))),
            skills: Arc::new(Mutex::new(bolloon_agent::skills_runtime::SkillEvolver::new())),
            session_store,
            version: "0.6.10",
        }
    }

    /// 取当前 runtime 快照（Arc 克隆，不持锁过 await）
    pub fn llm_snapshot(&self) -> Arc<LlmRuntime> {
        self.llm
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// 配置/选择变了 → 重建 runtime（只装**能解析**的家：有 key 或本机服务）
    pub async fn reload_llm(&self) {
        let mut cfg = bolloon_llm::config_store::load();
        {
            // UI 里选中的 provider/model 也参与解析（不落盘，只影响本次 runtime）
            let fs = self.forge.lock().await;
            let p = fs.settings.provider.trim().to_string();
            let m = fs.settings.model.trim().to_string();
            if !p.is_empty() {
                bolloon_llm::config_store::apply_provider(
                    &mut cfg,
                    &p,
                    None,
                    None,
                    if m.is_empty() { None } else { Some(m.as_str()) },
                );
            }
        }
        let mut rt = LlmRuntime::from_config(&cfg, 2);
        // 环境变量兜底（BOLLOON_API_KEY/BASE_URL/MODEL 三件套仍然有效）
        if let Ok(key) = std::env::var("BOLLOON_API_KEY") {
            if !key.trim().is_empty() {
                rt.add_provider(ProviderConfig {
                    id: "env".into(),
                    base_url: std::env::var("BOLLOON_BASE_URL")
                        .unwrap_or_else(|_| "https://api.minimaxi.com/v1".to_string()),
                    api_key: Some(key),
                    default_model: std::env::var("BOLLOON_MODEL")
                        .unwrap_or_else(|_| "deepseek-chat".to_string()),
                });
            }
        }
        *self.llm.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(rt);
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

/// 路由表 (serve 与测试共用; 端口绑定与路由分离)
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        // 原生 UI 数据面 (前端 index.html 期望的形状: agents/sessions/profile/settings/update)
        .route("/api/bootstrap", get(crate::native::bootstrap_native))
        .route("/api/version", get(crate::native::version))
        .route("/api/models", get(crate::native::models))
        // 200+ provider: 全量列表 / 选一家 / 真连一次
        .route("/api/models/providers", get(providers))
        .route("/api/models/options", get(crate::native::models_options))
        .route("/api/models/select", post(crate::native::models_select))
        .route("/api/models/test", post(crate::native::models_test))
        .route("/api/sessions", get(sessions).post(crate::native::create_session))
        .route("/api/sessions/branch", post(crate::native::branch_session))
        .route("/api/sessions/update", post(crate::native::update_session))
        .route("/api/sessions/delete", post(crate::native::delete_session))
        .route("/api/sessions/truncate", post(crate::native::truncate_session))
        .route("/api/sessions/share", post(crate::native::share_session))
        // 分享快照取回 (链接真能打开, 不是死链)
        .route("/api/share/{token}", get(crate::native::share_json))
        .route("/share/{token}", get(crate::native::share_page))
        .route("/api/agents", post(crate::native::create_agent))
        .route("/api/agents/update", post(crate::native::update_agent))
        .route("/api/profile", post(crate::native::set_profile))
        .route("/api/settings", post(crate::native::set_settings))
        .route("/api/chat", post(crate::native::chat))
        .route("/api/chat/stream", post(crate::native::chat_stream))
        .route("/api/chat/status", get(crate::native::chat_status))
        .route("/api/chat/stop", post(crate::native::chat_stop))
        // 群聊 room 面板 (内部商议)
        .route("/api/room", get(crate::native::room))
        .route("/api/room/new", post(crate::native::room_new))
        .route("/api/room/start", post(crate::native::room_start))
        .route("/api/room/stop", post(crate::native::room_stop))
        .route("/api/room/close", post(crate::native::room_close))
        .route("/api/room/guide", post(crate::native::room_guide))
        // clarity 授权队列 (workspace 外路径: 仅一次/本项目/完全访问/拒绝)
        .route("/api/auth/requests", get(crate::native::auth_requests))
        .route("/api/auth/request", post(crate::native::auth_request))
        .route("/api/auth/decide", post(crate::native::auth_decide))
        // 自动更新 (前端 updateBtn)
        .route("/api/update", get(crate::native::update))
        .route("/api/update/apply", post(crate::native::update_apply))
        // 世界模式 (意图 / 机会流 / 校准环 / 信箱 — 对齐 TS routes-world)
        .route("/api/intents", get(crate::native::list_intents).post(crate::native::add_intent))
        .route("/api/intents/remove", post(crate::native::remove_intent))
        .route("/api/opportunities", get(crate::native::list_opportunities))
        .route("/api/opportunities/{id}/ignore", post(crate::native::ignore_opportunity))
        .route("/api/opportunities/{id}/accept", post(crate::native::accept_opportunity))
        .route("/api/world/profile", get(crate::native::world_profile))
        .route("/api/world/watch", get(crate::native::world_watch))
        .route("/api/world/inbox", get(crate::native::world_inbox).post(crate::native::world_inbox_post))
        .route("/api/world/stats", get(crate::native::world_stats))
        // 人类目录 (手机号/邮箱盲化 + 跨机查询 + 跨机加好友)
        .route("/api/directory/publish", post(crate::native::directory_publish))
        .route("/api/directory/lookup", get(crate::native::directory_lookup))
        .route("/api/directory/retract", post(crate::native::directory_retract))
        .route("/api/directory/remote-lookup", get(crate::native::directory_remote_lookup))
        .route("/api/friends/request", post(crate::native::friend_request))
        .route("/api/friends/accept", post(crate::native::friend_accept))
        .route("/api/friends/reject", post(crate::native::friend_reject))
        .route("/api/friends", get(crate::native::friend_list))
        // 做梦机制 (整理记忆与经验 → 升级项目 skills)
        .route("/api/dream", post(crate::native::dream_run))
        .route("/api/dream/last", get(crate::native::dream_last))
        .route("/api/dream/topic", post(crate::native::dream_topic))
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
        .with_state(state)
}

pub async fn serve(state: AppState, port: u16) -> anyhow::Result<()> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    tracing::info!("bolloon web listening on http://127.0.0.1:{port}");
    serve_on(state, listener).await
}

/// 在已绑定的监听器上服务 (测试: 端口 0 → 用 OS 分配的端口, 不抢固定端口)
pub async fn serve_on(state: AppState, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    // 启动即按本机配置装好模型通路 (200+ provider 里能解析的那些)
    state.reload_llm().await;
    axum::serve(listener, app(state))
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

    // 真实模型调用（唯一咽喉 generate；provider/model 由 UI 选择与配置决定）
    let reply = match crate::native::reply_with_model(&st, &req.text).await {
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
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let meta = st
        .groups
        .create_group(&id, &req.name, st.identity.did.as_str(), acl, now_ms);
    // 兼容旧 GroupInfo 形状 (前端旧字段) + 新增 orbit address
    Json(serde_json::json!({
        "id": meta.id,
        "name": meta.name,
        "owner": meta.owner,
        "acl": meta.acl,
        "address": meta.address,
        "created_at_ms": meta.created_at_ms,
        "member_count": 1,
    }))
}

async fn list_groups(State(st): State<AppState>) -> Json<serde_json::Value> {
    let groups: Vec<serde_json::Value> = st
        .groups
        .list_groups()
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "owner": m.owner,
                "acl": m.acl,
                "address": m.address,
                "created_at_ms": m.created_at_ms,
            })
        })
        .collect();
    Json(serde_json::json!({ "groups": groups }))
}

#[derive(Deserialize)]
struct GroupQuery {
    after: Option<u64>,
    limit: Option<u64>,
}

async fn group_messages(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<GroupQuery>,
) -> Json<serde_json::Value> {
    let limit = q.limit.unwrap_or(200) as usize;
    // after = offset (从全量历史按位置截断), limit = 取最近 N 条
    let mut msgs = st.groups.history(&id, 0).unwrap_or_default();
    if let Some(a) = q.after {
        let a = a as usize;
        if a < msgs.len() {
            msgs.drain(0..a);
        }
    }
    if limit > 0 && msgs.len() > limit {
        let cut = msgs.len() - limit;
        msgs.drain(0..cut);
    }
    let out: Vec<serde_json::Value> = msgs
        .iter()
        .enumerate()
        .map(|(i, m)| {
            serde_json::json!({
                "seq": i as u64 + 1,
                "sender": m.signer,
                "kind": m.kind,
                "content": m.text,
                "signature": m.signature,
                "timestamp_ms": m.ts,
                "reply_to": m.reply_to,
            })
        })
        .collect();
    Json(serde_json::json!({ "messages": out }))
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
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    // 签名 + 写门 + 落块 全部在 OrbitStore 内完成 (Ed25519 + hash 链)
    match st.groups.say(&id, kp, kp.did.as_str(), &req.text, now_ms) {
        Ok(entry) => Json(serde_json::json!({
            "hash": entry.hash,
            "clock": entry.clock,
            "signer": entry.signer,
            "signature": entry.signature,
            "timestamp_ms": entry.timestamp_ms,
        })),
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
    // 层按 MemoryLayer 解析 (未知/缺省 → run_fact; 不静默接受任意字符串)
    let layer = MemoryLayer::parse(req.layer.as_deref()).unwrap_or(MemoryLayer::RunFact);
    let importance = req.importance.unwrap_or(0.5);
    let row = {
        let db = st.memory_db.lock().await;
        db.remember("local", &layer.to_string(), &req.content, importance, now_ms, None)
            .map_err(|e| e.to_string())
    };
    // 快照同步落盘 (memory.json): 进程重启/离线读面用同一口径
    {
        let mut store = st.memory.lock().await;
        store.remember(&req.content, layer, importance, None);
        save_memory(&data_dir(), &store);
    }
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

/// 模型供应商列表 — **全量 200+ 家**（内置 13 + 目录 223 + 自定义），带来源/协议/有无线索
async fn providers(State(st): State<AppState>) -> Json<serde_json::Value> {
    let cfg = bolloon_llm::config_store::load();
    let active = {
        let fs = st.forge.lock().await;
        let ui = fs.settings.provider.trim().to_string();
        if ui.is_empty() { cfg.active_provider.clone() } else { ui }
    };
    let items = crate::native::provider_rows(&cfg);
    Json(serde_json::json!({
        "providers": items,
        "count": items.len(),
        "active": active,
    }))
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
    // 开启时: 把已挂起的非敏感授权请求直接放行, 让 agent 立即不被门拦截
    if on {
        let mut fs = st.forge.lock().await;
        for r in fs.auth.iter_mut() {
            if r.status == "pending" && !r.sensitive {
                r.status = "allow_full".into();
            }
        }
    }
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

/// 内嵌单页 HTML（hushforge 布局: 284px 侧栏 + 主聊天 + room 面板）
const INDEX_HTML: &str = include_str!("../assets/index.html");

#[cfg(test)]
mod route_tests {
    use super::*;

    fn offline_llm() -> LlmRuntime {
        LlmRuntime::new(
            vec![bolloon_llm::ProviderConfig {
                id: "test".into(),
                base_url: "http://127.0.0.1:1/v1".into(),
                api_key: None,
                default_model: "test-model".into(),
            }],
            1,
        )
    }

    /// 真起一个服务 (端口 0), 用 ureq 走真 HTTP:
    /// bootstrap 带真实消息流 → 分享链接能打开 → 梦想文档作者取 profile → 状态登记
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn share_bootstrap_dream_routes_e2e() {
        let home = std::env::temp_dir().join(format!("bolloon-web-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        // data_dir() 走 BolloonHome::resolve(); 本进程只有这条用例碰它
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");

        // ureq 是阻塞客户端 → 放 spawn_blocking, 不占 tokio worker
        tokio::task::spawn_blocking(move || {
            let get_json = |path: &str| -> serde_json::Value {
                ureq::get(&format!("{base}{path}")).call().unwrap().into_json().unwrap()
            };
            let get_text = |path: &str| -> String {
                ureq::get(&format!("{base}{path}")).call().unwrap().into_string().unwrap()
            };
            let post_json = |path: &str, body: serde_json::Value| -> serde_json::Value {
                ureq::post(&format!("{base}{path}"))
                    .send_json(body)
                    .unwrap()
                    .into_json()
                    .unwrap()
            };

            // 1) bootstrap: 首启种子会话 + 真实消息流 + 形状字段
            let boot = get_json("/api/bootstrap");
            let sid = boot["state"]["sessions"][0]["id"].as_str().expect("种子会话").to_string();
            assert!(boot["state"]["messages"].is_array());
            assert_eq!(boot["state"]["edge"], serde_json::json!(false));
            assert!(boot["state"]["active_session_id"].as_str().is_some());

            // 2) models: 前端形状 (含 has_key / write_tools)
            let models = get_json("/api/models");
            assert!(models["providers"].is_array());
            assert!(models["providers"][0]["has_key"].is_boolean());
            assert!(models["write_tools"].is_array());

            // 3) 分享: token 不可猜 (24 hex), 页面与 JSON 都真能打开
            let share = post_json("/api/sessions/share", serde_json::json!({ "id": sid }));
            let token = share["token"].as_str().expect("token").to_string();
            assert_eq!(token.len(), 24);
            assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(share["url"], serde_json::json!(format!("/share/{token}")));

            let page = get_text(&format!("/share/{token}"));
            assert!(page.contains("只读快照"), "{page}");
            let snap = get_json(&format!("/api/share/{token}"));
            assert_eq!(snap["session_id"], serde_json::json!(sid));

            // 坏 token → 如实说不存在 (不冒充)
            assert!(get_text("/share/deadbeef").contains("分享不存在或已失效"));
            // 会话不存在 → 明确报错, 不返回假链接
            let miss = post_json("/api/sessions/share", serde_json::json!({ "id": "sess-nope" }));
            assert!(miss["error"].as_str().unwrap().contains("会话不存在"));

            // 4) 梦想文档: 作者取真实 profile 名 (不硬编码 user), 并登记到状态
            let dream = post_json("/api/dream/topic", serde_json::json!({ "topic": "核聚变口径" }));
            assert_eq!(dream["author"], serde_json::json!("用户"));
            let written = dream["written"].as_str().expect("写入路径").to_string();
            assert!(written.ends_with("核聚变口径.md"), "{written}");
            let last = get_json("/api/dream/last");
            assert_eq!(last["dreams"], serde_json::json!([written]));
            assert!(last["last"].is_null(), "还没做过梦 → 如 null 不编报告");

            let _ = std::fs::remove_dir_all(&home);
        })
        .await
        .unwrap();
    }
}
