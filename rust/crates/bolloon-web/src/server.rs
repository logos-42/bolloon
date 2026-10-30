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
use bolloon_agent::deliberation::{ElectionMode, MemberRole};
use bolloon_agent::judgment::JudgmentStore;
use bolloon_agent::world::{Opportunity, OpportunityStream};
use bolloon_agent::memory_db::MemoryDb;
use bolloon_agent::clarity::{clarity_of, ClaritySummary};
use bolloon_x402::{
    direct_payment::{verify_direct_payment, DirectPaymentConfig, PaymentClaim, RpcObservation},
    paid_info::{compute_content_hash, PaidInfoItem},
};
use bolloon_llm::{LlmRuntime, ProviderConfig};
use bolloon_p2p::{make_invite_link, pubkey_of_did, verify_invite_link, GroupAcl, GroupOrbitHub, KeyPair};
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
    /// 跨节点公共池视图缓存（node did → 最近一次验签通过的快照）；拉取式，不 gossip
    pub pool_peers: Arc<Mutex<std::collections::BTreeMap<String, PoolPeer>>>,
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
    /// 群聊/商议的"谁正在想"运行时 (内存态; 见 room_bus)
    pub room_bus: Arc<crate::room_bus::RoomBus>,
    /// 更新安装互斥 (两个请求同时替换同一二进制会把自己装残)
    pub updating: Arc<std::sync::atomic::AtomicBool>,
    /// Forge 兼容层状态 (agents/sessions/profile/settings/auth 队列)
    pub forge: Arc<Mutex<crate::native::NativeState>>,
    /// 群内商议中枢 (按 group_id 分群; 运行态, 不持久化): 推选 / 控麦 / 并发去重 / 命令门禁
    pub deliberation:
        Arc<Mutex<std::collections::HashMap<String, Arc<bolloon_agent::deliberation::DeliberationHub>>>>,
    /// 项目 skills 注册表 (经验提炼后升级到这里; 做梦机制用)
    pub skills: Arc<Mutex<bolloon_agent::skills_runtime::SkillEvolver>>,
    pub session_store: Arc<bolloon_agent::SessionStore>,
    pub version: &'static str,
    /// QUIC 端对端直连传输 (feature 门控; 默认启用): 好友对话的直连底座, 不经 HTTP 中继
    #[cfg(feature = "quic-transport")]
    pub quic: Option<Arc<bolloon_p2p::quic_transport::QuicTransport>>,
    /// scratch 子系统执行端口 (宿主注入真执行器; 默认 noop)
    pub script_run: bolloon_agent::scratch::ScriptRunPort,
    /// 受治理动态配置管理器 (A/B/C 类动态配置 + 审计/回滚; 重启恢复)
    pub config: std::sync::Arc<bolloon_config::ConfigManager>,
    /// LLM 调用健康计数 (真实测量: 供配置优化闭环当可信指标源; 进程内共享一份)
    pub llm_health: std::sync::Arc<bolloon_agent::kernel_loop::LlmHealth>,
    /// 旁路经济层 (默认关闭; 配置加载后才真正构造 — 见 `serve_on`)
    pub econ: std::sync::Arc<std::sync::OnceLock<std::sync::Arc<bolloon_econ::ShadowEconomy>>>,
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
                    .map(|(role, content)| ChatMessageView { role, content, name: None })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        Self {
            llm: Arc::new(std::sync::RwLock::new(Arc::new(llm))),
            sessions: Arc::new(Mutex::new(vec![])),
            messages: Arc::new(Mutex::new(restored)),
            identity,
            pool_peers: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
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
            room_bus: Arc::new(crate::room_bus::RoomBus::default()),
            updating: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            forge: Arc::new(Mutex::new(crate::native::NativeState::load(&dir))),
            deliberation: Arc::new(Mutex::new(std::collections::HashMap::new())),
            skills: Arc::new(Mutex::new(bolloon_agent::skills_runtime::SkillEvolver::new())),
            session_store,
            version: "0.6.10",
            #[cfg(feature = "quic-transport")]
            quic: None,
            script_run: bolloon_agent::scratch::ScriptRunPort::noop(),
            // 受治理配置: 默认 (文件加载在 serve_on 异步完成, 此处先建空管理器)
            config: std::sync::Arc::new(bolloon_config::ConfigManager::new(Some(
                data_dir().join("config.json"),
            ))),
            llm_health: std::sync::Arc::new(bolloon_agent::kernel_loop::LlmHealth::default()),
            econ: std::sync::Arc::new(std::sync::OnceLock::new()),
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
    /// 说话者名字（智能体名）。None = 用户本人或未知；前端不要再用 "AI" 占位
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
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
    let mut router = Router::new()
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
        // 图标: 以前**没有任何 /icons 路由** ⇒ `<img src="/icons/icon.png">` 一律 404,
        // 左上角 logo / 头像兜底图全都不显示。内嵌字节 (Tauri 壳只带二进制, 不能靠磁盘路径)。
        .route("/icons/{name}", get(icon_file))
        .route("/favicon.ico", get(favicon))
        // 确定性头像: 稳定 ID → 同一张图 (hashavatar 本地生成; 旧版是"人人同脸"的渐变 SVG)
        .route("/api/avatars", get(avatar_families))
        .route("/api/avatar/{seed}", get(avatar_svg))
        .route("/api/sessions/delete", post(crate::native::delete_session))
        .route("/api/sessions/truncate", post(crate::native::truncate_session))
        .route("/api/sessions/share", post(crate::native::share_session))
        // 分享快照取回 (链接真能打开, 不是死链)
        .route("/api/share/{token}", get(crate::native::share_json))
        .route("/share/{token}", get(crate::native::share_page))
        .route("/api/agents", post(crate::native::create_agent))
        .route("/api/agents/update", post(crate::native::update_agent))
        .route("/api/agents/delete", post(crate::native::delete_agent))
        .route("/api/agents/share", post(crate::native::share_agent))
        .route("/api/agents/ping", post(crate::native::set_agent_ping))
        // 智能体档案（DID 缩写 + soul 介绍 + 功能简介），眼镜端详情页用
        .route("/api/agents/{id}/profile", get(crate::native::agent_profile))
        .route("/api/wallet/authorize", post(crate::native::authorize_wallet))
        // 眼镜端钱包视图: 地址 + 链上余额（真实 RPC）
        .route("/api/wallet", get(crate::wallet::wallet))
        // ── 充值 / 按量扣费 (2026-10-30) ──────────────────────────────
        // 收费口径: 先充值 (USDC/支付宝/微信/PayPal, 人工核销) → 余额 → 按量扣减。
        // 未核销的充值只进 pending, 不计入余额; confirm 只在本机做 (收款人本人核对到账)。
        // 菜单栏角标: 待处理好友请求 + 待核销充值
        .route("/api/notify/count", get(crate::native::notify_count))
        .route("/api/pay/info", get(crate::pay::pay_info))
        // 只卖两款 (DeepSeek V4.1 Flash / V4 Pro), 单价 + 用户等级从这里读
        .route("/api/pay/pricing", get(crate::pay::pay_pricing))
        // 给特定用户定等级/配额 (本机管理, 收款人本人操作)
        .route("/api/pay/user", post(crate::pay::pay_set_user))
        // 收款人手动入账 (给某个 DID 开额度 = 开权限) + 所有账户余额总览
        // 智能体钱包: 创建本地钱包 (自建不限) / 绑定已有地址 (上限 20) / 列表 / 解绑
        // 智能体自查: 自己的 DID / persona / memory / workspace 路径
        .route("/api/agents/{id}/paths", get(crate::native::agent_paths))
        .route("/api/agents/{id}/wallets", get(crate::agent_wallet::list_wallets))
        .route("/api/agents/{id}/wallets/create", post(crate::agent_wallet::create_wallet))
        .route("/api/agents/{id}/wallets/bind", post(crate::agent_wallet::bind_wallet))
        .route("/api/agents/{id}/wallets/remove", post(crate::agent_wallet::remove_wallet))
        .route("/api/pay/credit", post(crate::pay::pay_credit))
        .route("/api/pay/accounts", get(crate::pay::pay_accounts))
        // 收款码图片 (支付宝/微信), 只读 pay 目录
        .route("/api/pay/qr/{name}", get(crate::pay::pay_qr))
        // 今日用量汇总 + 余额提醒阈值; 以及你自己的 DeepSeek 账户余额 (服务端 key)
        .route("/api/pay/summary", get(crate::pay::pay_summary))
        .route("/api/pay/upstream", get(crate::pay::pay_upstream))
        .route("/api/pay/claim", post(crate::pay::pay_claim))
        .route("/api/pay/confirm", post(crate::pay::pay_confirm))
        .route("/api/phone/bind", post(crate::native::bind_phone))
        .route("/api/phone", get(crate::native::phone_status))
        // 手机号登录 = 挑战-应答 + 公钥验签 (证明手机号与 DID 同一个身份; 不是短信登录)
        .route("/api/phone/challenge", post(crate::native::phone_challenge))
        .route("/api/phone/login", post(crate::native::phone_login))
        .route("/api/profile", post(crate::native::set_profile))
        .route("/api/settings", post(crate::native::set_settings))
        .route("/api/chat", post(crate::native::chat))
        // 眼镜端语音: POST 原始 WAV → 本机 whisper 转文本
        .route("/api/asr", post(crate::asr::asr))
        // 眼镜最小化后的实时意图 → OrbitDB(intent-stream) → 群聊 prompt
        .route("/api/intent/observe", post(crate::native::intent_observe))
        .route("/api/identity/env", get(crate::native::identity_env))
        .route("/api/turns", get(crate::native::turns))
        // 眼镜扫码登录：电脑/手机出码，眼镜扫 → 令牌（也可以在 /login 输 6 位码授权）
        .route("/login", get(crate::qr_login::login_page))
        .route("/api/auth/qr/issue", post(crate::qr_login::qr_issue))
        .route("/api/auth/qr/svg", get(crate::qr_login::qr_svg))
        .route("/api/auth/qr/approve", post(crate::qr_login::qr_approve))
        .route("/api/auth/qr/scan", post(crate::qr_login::qr_scan))
        .route("/api/auth/qr/claim", post(crate::qr_login::qr_claim))
        .route("/api/auth/qr/status", get(crate::qr_login::qr_status))
        .route("/api/auth/device-code", get(crate::qr_login::device_code))
        .route("/api/auth/session", get(crate::qr_login::session_check))
        // 判断力/意图自动存档（电脑总账 + 智能体侧账）
        .route("/api/archive", post(crate::archive::archive))
        .route("/api/archive/summary", get(crate::archive::summary))
        // 眼镜端「扫一眼」: POST 图片 → 离线 OCR + 意图匹配
        .route("/api/vision", post(crate::vision::vision))
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
        // 世界卡片跨机投递 (对齐 TS routes-world: cards / push / protocol)
        .route("/api/world/cards", get(crate::native::world_cards))
        .route("/api/world/cards/push", post(crate::native::world_cards_push))
        .route("/api/world/cards/share", post(crate::native::world_cards_share))
        .route("/api/world/cards/protocol", get(crate::native::world_cards_protocol))
        // 人类目录 (手机号/邮箱盲化 + 跨机查询 + 跨机加好友)
        .route("/api/directory/publish", post(crate::native::directory_publish))
        .route("/api/directory/lookup", get(crate::native::directory_lookup))
        .route("/api/directory/retract", post(crate::native::directory_retract))
        .route("/api/directory/remote-lookup", get(crate::native::directory_remote_lookup))
        // 真跨机的接收侧 (对端探针) + 对端节点登记
        .route("/api/directory/rpc", post(crate::native::directory_rpc))
        .route(
            "/api/directory/peers",
            get(crate::native::directory_peers_list)
                .post(crate::native::directory_peers_add)
                .delete(crate::native::directory_peers_remove),
                )
                .route("/api/node/connect", post(crate::native::node_connect))
                .route("/api/scratch/run", post(crate::native::scratch_run))
                .route("/api/scratch/list", get(crate::native::scratch_list))
                .route("/api/config/current", get(crate::native::config_current))
                .route("/api/config/apply", post(crate::native::config_apply))
                .route("/api/config/rollback", post(crate::native::config_rollback))
                // 可观测: 配置指标 + 任务↔版本证据链 + 回滚点
                .route(
                    "/api/config/observability",
                    get(crate::native::config_observability),
                )
                // AI 优化闭环 (默认建议级: 只出提案, 不写配置)
                .route("/api/config/optimize", post(crate::native::config_optimize))
                // 多节点: 从对端拉取配置 (最终一致; 对端不可用则本地不变)
                .route("/api/config/peer-sync", post(crate::native::config_peer_sync))
                // 监控面板 (自包含静态页, 不进前端构建)
                .route("/config", get(crate::native::config_panel))
                // 经济层 (旁路计量) 报告: 影子模式下的真实成本/本该被拦/影子路由
                .route("/api/econ/report", get(crate::native::econ_report))
                .route(
                    "/api/groups/{id}/reply-limit",
                    post(set_reply_limit).get(get_reply_limit),
                )
                .route("/api/groups/{id}/invite", get(group_invite))
                .route("/api/groups/{id}/members", get(group_members_api))
                .route("/api/econ/probe", get(crate::native::econ_probe))
                .route("/api/econ/reputation/{principal}", get(econ_reputation))
                .route("/api/econ/immune/report", post(immune_report))
                .route("/api/econ/immune/{subject}", get(immune_status))
                .route("/api/econ/consciousness/{principal}", get(econ_consciousness))
                .route("/api/econ/pool/view", get(pool_view))
                .route("/api/econ/pool/peers", post(pool_peer_add))
                .route(
                    "/api/econ/providers",
                    post(crate::native::econ_provider_register),
                )
                .route(
                    "/api/econ/providers/{id}/revoke",
                    post(crate::native::econ_provider_revoke),
                )
                .route(
                    "/api/econ/contributions",
                    post(crate::native::econ_contribute),
                )
                .route(
                    "/api/econ/contributions/{id}/confirm",
                    post(crate::native::econ_contribute_confirm),
                )
                .route("/api/econ/pool/topup", post(crate::native::econ_pool_topup))
                .route(
                    "/api/econ/intent/{id}/budget",
                    post(crate::native::econ_intent_budget),
                )
                .route("/api/friends/request", post(crate::native::friend_request))
        .route("/api/friends/accept", post(crate::native::friend_accept))
        .route("/api/friends/reject", post(crate::native::friend_reject))
        .route("/api/friends", get(crate::native::friend_list))
        // 2026-10-30 (用户): 点好友 → 看对方开放的智能体 → 跨机聊天
        .route("/api/friends/{did}/agents", get(crate::native::friend_agents))
        .route("/api/friends/{did}/chat", post(crate::native::friend_chat))
        // 对端接收面 (只对已加好友的 did 开放; 由上面的代理面在对方机器上调)
        .route("/api/agents/public", get(crate::native::agents_public))
        .route("/api/agents/public/chat", post(crate::native::agents_public_chat))
        // 通讯录 (2026-10-28): 网页端/APP 端统一的联系人搜索面 — 手机号走跨机目录, 名称走本机名片本
        .route("/api/contacts", get(crate::native::contact_list))
        .route("/api/contacts/set", post(crate::native::contact_set))
        .route("/api/contacts/search", post(crate::native::contact_search))
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
        // 子讨论 (小组讨论 / 组织内部) + 统一分享 + 凭邀请加入
        .route(
            "/api/groups/{id}/topics",
            get(group_topics).post(group_create_topic),
        )
        .route("/api/groups/{id}/share", post(group_share))
        .route("/api/groups/join", post(group_join))
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
        .route("/api/permission", get(get_permission).post(set_permission));
    // QUIC 直连对端管理接口 (feature 门控; 默认启用): 暴露本节点收件地址 + 登记对端 socket
    #[cfg(feature = "quic-transport")]
    {
        router = router.merge(
            Router::new()
                .route("/api/quic/addr", get(crate::native::quic_addr))
                .route("/api/quic/peers", post(crate::native::quic_peer_add)),
        );
    }
    router.with_state(state)
}

pub async fn serve(state: AppState, port: u16) -> anyhow::Result<()> {
    // 双核 Kernel HA: 按 BOLLOON_HA 启用; 两进程各选 A/B 经心跳文件互维互保。
    // 接管动作 = 真孤儿接管 (reconcileOrphans + prepareResume), 不再接 NoopRecovery。
    let _ha = bolloon_kernel::dual_core::spawn_kernel_ha_from_env(std::sync::Arc::new(
        bolloon_kernel::orphan_recovery::OrphanRecovery::new(
            bolloon_kernel::orphan_recovery::runs_dir(),
        ),
    ));
    // 默认只听回环（网页只给本机的眼镜/浏览器用）。
    // 手机也要打开 /login 扫码时: BOLLOON_BIND=0.0.0.0 bolloon web —— 同 Wi-Fi 下用 http://<本机 IP>:<port>/login。
    let host = std::env::var("BOLLOON_BIND").unwrap_or_else(|_| "127.0.0.1".to_string());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    tracing::info!("bolloon web listening on http://{host}:{port}");
    serve_on(state, listener).await
}

/// 在已绑定的监听器上服务 (测试: 端口 0 → 用 OS 分配的端口, 不抢固定端口)
pub async fn serve_on(state: AppState, listener: tokio::net::TcpListener) -> anyhow::Result<()> {
    // 让 agent 侧工具（group_invite / group_join / econ_*）知道本机 API 基址。
    // 只在未设置时注入，避免覆盖部署方显式配置。
    if std::env::var("BOLLOON_LOCAL_API").is_err() {
        if let Ok(addr) = listener.local_addr() {
            unsafe { std::env::set_var("BOLLOON_LOCAL_API", format!("http://{addr}")) };
        }
    }

    // 启动即按本机配置装好模型通路 (200+ provider 里能解析的那些)
    state.reload_llm().await;

    // QUIC 端对端直连传输: 起一个端点, 并起接收循环把直连收到的信封接到世界卡片跨机投递路径。
    // 失败仅降级为"仅 HTTP 跨机", 不拖垮 web 服务。
    #[cfg(feature = "quic-transport")]
    let state = {
        let mut state = state;
        match bolloon_p2p::quic_transport::QuicTransport::new(&state.identity).await {
            Ok(q) => {
                let q = std::sync::Arc::new(q);
                let st = state.clone();
                let q2 = q.clone();
                tokio::spawn(async move {
                    loop {
                        let env = q2.recv().await;
                        if let Err(e) = crate::native::deliver_world_card(&st, &env).await {
                            tracing::warn!("QUIC 世界卡片投递失败: {e}");
                        }
                    }
                });
                tracing::info!("QUIC 端对端直连传输已启用 (收件端点已起)");
                state.quic = Some(q.clone());
                // 直连全自动: 立即 + 周期把 directory_peers 的 QUIC 地址同步给直连端点,
                // 之后 share 自动经 QUIC 直发, 不再依赖 HTTP 中继。
                let st_sync = state.clone();
                tokio::spawn(async move {
                    crate::native::sync_quic_peers(&st_sync, &q).await;
                    let mut ticker =
                        tokio::time::interval(std::time::Duration::from_secs(30));
                    loop {
                        ticker.tick().await;
                        crate::native::sync_quic_peers(&st_sync, &q).await;
                    }
                });
            }
            Err(e) => {
                tracing::warn!("QUIC 传输启动失败, 降级为仅 HTTP 跨机: {e}");
            }
        }
        state
    };

    // scratch 子系统: 注入真执行器 (tokio::process); 默认 noop, 这里装上
    let mut state = state;
    state.script_run = bolloon_agent::scratch::ScriptRunPort::new(std::sync::Arc::new(
        bolloon_agent::scratch::TokioScriptRunner::new(),
    ));
    // 受治理配置: 启动时从文件恢复 (失败则保持默认, fail-closed —— 但**不吃掉原因**)
    if let Err(e) = state.config.load_from_file().await {
        tracing::warn!(error = %e, "配置加载失败, 保持默认 (fail-closed; 文件格式或校验没过)");
    }
    // 经济层: 按已加载配置构造 (默认 enabled=false ⇒ 空转, 零行为差异)
    {
        let ec = state.config.current().config.economic.clone();
        let dir = data_dir().join("econ");
        let econ = std::sync::Arc::new(bolloon_econ::ShadowEconomy::new(ec, Some(dir.as_path())));
        if econ.enabled() {
            tracing::info!(mode = %econ.report().mode, "经济层已启用 (shadow 默认: 只计量不阻断)");
        }
        let _ = state.econ.set(econ);
    }
    // 孤儿 catch: 周期 reconcile scratch 运行 (crash 后未收尾的 run 标 interrupted)
    let scratch_dir = bolloon_agent::home::BolloonHome::resolve().scratch_dir();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            bolloon_agent::scratch::reconcile_scratch_runs(&scratch_dir).await;
        }
    });

    axum::serve(listener, app(state))
        .await
        .map_err(|e| anyhow::anyhow!("web server: {e}"))
}

/// 主页面（内嵌 HTML）
async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

// ── 内嵌图标 (index.html 里写的是 `/icons/<file>`, 必须真能取到) ──
const ICON_PNG: &[u8] = include_bytes!("../assets/icons/icon.png");
const TOUCH_PNG: &[u8] = include_bytes!("../assets/icons/apple-touch-icon.png");
const FAVICON_32: &[u8] = include_bytes!("../assets/icons/favicon-32.png");

/// `/icons/<name>`: 只认白名单三张图 (不做出目录遍历, 也不偷偷 404)
async fn icon_file(axum::extract::Path(name): axum::extract::Path<String>) -> axum::response::Response {
    use axum::response::IntoResponse;
    let (body, ctype): (&'static [u8], &'static str) = match name.as_str() {
        "icon.png" => (ICON_PNG, "image/png"),
        "apple-touch-icon.png" => (TOUCH_PNG, "image/png"),
        "favicon-32.png" => (FAVICON_32, "image/png"),
        _ => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                [(axum::http::header::CONTENT_TYPE, "text/plain")],
                "no such icon".to_string(),
            )
                .into_response()
        }
    };
    (
        [
            (axum::http::header::CONTENT_TYPE, ctype),
            // 图标几乎不变: 给长缓存, 省得每次开面板都重下 900KB
            (axum::http::header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        body,
    )
        .into_response()
}

/// `/favicon.ico` (浏览器自动请求, 不给就是控制台一条 404 噪音)
async fn favicon() -> axum::response::Response {
    use axum::response::IntoResponse;
    (
        [(axum::http::header::CONTENT_TYPE, "image/png")],
        FAVICON_32,
    )
        .into_response()
}

/// `/api/avatar/<seed>`: 确定性头像 (同一 seed 永远同一张图)
#[derive(Deserialize)]
struct AvatarQuery {
    /// 家族序号 (0..31); 缺省按 seed 派生
    k: Option<u8>,
}

async fn avatar_svg(Path(seed): Path<String>, Query(q): Query<AvatarQuery>) -> axum::response::Response {
    let svg = crate::avatar::svg(&seed, q.k);
    (
        [
            (axum::http::header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            // 头像按身份恒定: 长缓存, 打开面板不再重算
            (axum::http::header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        svg,
    )
        .into_response()
}

/// `/api/avatars`: 家族目录 (前端"换头像家族"的按钮来源)
async fn avatar_families() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "families": crate::avatar::families() }))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "version": "0.6.13" }))
}

async fn sessions(State(st): State<AppState>) -> Json<Vec<SessionMeta>> {
    Json(st.sessions.lock().await.clone())
}

async fn send(State(st): State<AppState>, Json(req): Json<SendRequest>) -> Json<SendResponse> {
    let session_id = req.session_id.unwrap_or_else(|| "default".to_string());

    // 记录用户消息
    {
        let mut msgs = st.messages.lock().await;
        msgs.push(ChatMessageView { role: "user".into(), content: req.text.clone(), name: None });
    }

    // 真实模型调用（唯一咽喉 generate；provider/model 由 UI 选择与配置决定）
    let agent = crate::native::agent_by_id(&st, None).await;
    let reply = match crate::native::reply_with_model(&st, &req.text, agent.as_ref()).await {
        Ok(r) => r,
        Err(e) => format!("[AI 服务调用失败] {e}"),
    };

    // 记录回复 + 仅追加落盘 (可审计)
    {
        let mut msgs = st.messages.lock().await;
        msgs.push(ChatMessageView { role: "assistant".into(), content: reply.clone(), name: None });
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

/// 群组 id = 名字 (用户 2026-10-30: 「群组以名字来进行, 并不加数字」)。
///
/// 语义: **同名 = 同一个群组** —— 重复创建直接返回既有那个, 不再生成 `gw-xxxx` 技术 id,
/// 也不会出现「项目群 2」这种自动编号。只有名字里会破坏 URL/路径的字符被替换成 `_`
/// (展示层永远用 `name`, id 只是内部键)。
pub(crate) fn group_id_from_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .take(40)
        .map(|c| match c {
            '/' | '\\' | '?' | '#' | '%' | '&' | ':' => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() { "新群组".to_string() } else { cleaned }
}

async fn create_group(
    State(st): State<AppState>,
    Json(req): Json<CreateGroupRequest>,
) -> Json<serde_json::Value> {
    let name = {
        let n = req.name.trim().to_string();
        if n.is_empty() { "新群组".to_string() } else { n.chars().take(40).collect::<String>() }
    };
    let id = group_id_from_name(&name);
    // 同名群组已存在 ⇒ 直接复用 (群组以名字为身份, 不做自动编号)
    if let Some(meta) = st.groups.meta(&id) {
        return Json(serde_json::json!({
            "id": meta.id,
            "name": meta.name,
            "owner": meta.owner,
            "acl": meta.acl,
            "address": meta.address,
            "created_at_ms": meta.created_at_ms,
            "member_count": 1,
            "reused": true,
        }));
    }
    let acl = match req.members {
        Some(wl) if !wl.is_empty() => GroupAcl::Whitelist(wl),
        _ => GroupAcl::OwnerOnly,
    };
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    let meta = st
        .groups
        .create_group(&id, &name, st.identity.did.as_str(), acl, now_ms);
    // 兼容旧 GroupInfo 形状 (前端旧字段) + 新增 orbit address
    Json(serde_json::json!({
        "id": meta.id,
        "name": meta.name,
        "owner": meta.owner,
        "acl": meta.acl,
        "address": meta.address,
        "created_at_ms": meta.created_at_ms,
        "member_count": 1,
        "reused": false,
    }))
}

async fn list_groups(State(st): State<AppState>) -> Json<serde_json::Value> {
    let groups: Vec<serde_json::Value> = st
        .groups
        .list_groups()
        .iter()
        // 内部存储不算"我的群组"：眼镜意图流是观察账本，出现在群列表里只会误导用户
        .filter(|m| !m.id.starts_with("intent-"))
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
    /// 调用方身份：`agent` 才看得见诚信标识（人类侧一律剥掉 —— leo 2026-10-29 定）
    role: Option<String>,
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
    // 诚信标识只给智能体看：人类侧看不到「谁被标了低信任」，避免公开处刑/标签化
    let as_agent = q.role.as_deref() == Some("agent");
    let out: Vec<serde_json::Value> = msgs
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let mut v = serde_json::json!({
                "seq": i as u64 + 1,
                "from": m.from,
                "sender": m.signer,
                "kind": m.kind,
                "content": m.text,
                "signature": m.signature,
                "timestamp_ms": m.ts,
                "reply_to": m.reply_to,
            });
            if as_agent {
                if let Some(t) = &m.trust {
                    v["trust"] = t.clone();
                }
            }
            v
        })
        .collect();
    // 谁正在想 (前端据此显示"X 正在想…", 不让用户以为没人理)
    let thinking: Vec<String> = {
        let names = st.forge.lock().await.agents.clone();
        st.room_bus
            .thinking(&id)
            .into_iter()
            .map(|aid| names.iter().find(|a| a.id == aid).map(|a| a.name.clone()).unwrap_or(aid))
            .collect()
    };
    Json(serde_json::json!({
        "messages": out,
        "thinking": thinking,
        // 如实告知调用方：这个视图里有没有诚信标识（人类侧没有）
        "trust_visible": as_agent,
    }))
}

#[derive(Deserialize)]
struct CreateTopicRequest {
    name: String,
    /// 能在这个小组里发言的成员 DID —— **其余人在这个子讨论里被 ACL 拒** ("组织内部讨论"的硬约束)
    #[serde(default)]
    members: Vec<String>,
    /// 子讨论 id (不填则按 `<父群id>-t<ts>` 生成)
    #[serde(default)]
    id: Option<String>,
}

#[derive(Deserialize)]
struct ShareGroupRequest {
    /// `join` = 签发邀请链接 (对方可按 ACL 写入); `read` = 只读快照页 (不加入也能看)
    #[serde(default = "default_share_mode")]
    mode: String,
    /// 邀请截止 epoch ms (不填 = 7 天后)
    #[serde(default)]
    exp_ms: Option<u64>,
}

#[derive(Deserialize)]
struct JoinGroupRequest {
    /// 群主签发的 `bolloon://join/...` 邀请链接
    link: String,
    /// 子讨论邀请可携带父群 id, 以便挂到正确的父下
    #[serde(default)]
    parent: Option<String>,
}

fn default_share_mode() -> String {
    "read".to_string()
}

/// 分享 token = 身份私钥对 (群|时间) 签名取前 24 hex ⇒ 不可猜 (不依赖随机源)
fn group_share_token(st: &AppState, group_id: &str, now: u64) -> String {
    let sig = st.identity.sign(format!("groupshare|{group_id}|{now}").as_bytes());
    sig.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// 取邀请链接里的查询参数 (链接含 `?t=&exp=&by=&m=`)
fn link_query(link: &str, key: &str) -> Option<String> {
    let q = link.split_once('?')?.1;
    q.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == key).then(|| v.to_string())
    })
}

/// POST /api/groups/{id}/topics — 在群内开**子讨论** (小组讨论 / 组织内部: 只让 `members` 发言)
async fn group_create_topic(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<CreateTopicRequest>,
) -> Json<serde_json::Value> {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let topic_id = req
        .id
        .clone()
        .unwrap_or_else(|| format!("{id}-t{:x}", now % 0xffff_ffff));
    match st
        .groups
        .create_topic(&id, &topic_id, &req.name, req.members.clone(), &st.identity, now)
    {
        Ok(meta) => Json(serde_json::json!({
            "id": meta.id, "name": meta.name, "parent": meta.parent,
            "address": meta.address, "members": req.members,
        })),
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// GET /api/groups/{id}/topics — 列出某个群的子讨论
async fn group_topics(State(st): State<AppState>, Path(id): Path<String>) -> Json<serde_json::Value> {
    let topics: Vec<serde_json::Value> = st
        .groups
        .topics(&id)
        .iter()
        .map(|m| serde_json::json!({
            "id": m.id, "name": m.name, "address": m.address, "created_at_ms": m.created_at_ms,
        }))
        .collect();
    Json(serde_json::json!({ "topics": topics }))
}

/// POST /api/groups/{id}/share — **统一分享**: 整群与子讨论走**同一入口、同一套判据**
///
/// - `mode=join`: 群主签**邀请链接** (`bolloon://join/…`, 带 manifest) ⇒ 对方开出的是**同一个** store
///   (内容寻址, 而不是另建一个长得一样的群)
/// - `mode=read`: **只读快照**页 (`/share/<token>`), 不加入也能看; token 由身份签名派生 ⇒ 不可猜
async fn group_share(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ShareGroupRequest>,
) -> Json<serde_json::Value> {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let Some(meta) = st.groups.meta(&id) else {
        return Json(serde_json::json!({ "error": format!("群不存在: {id}") }));
    };
    match req.mode.as_str() {
        "join" => {
            let Some(manifest) = st.groups.manifest_of(&id) else {
                return Json(serde_json::json!({ "error": "取不到该群 manifest (store 未打开)" }));
            };
            let exp = req.exp_ms.unwrap_or(now + 7 * 24 * 3600 * 1000);
            match make_invite_link(&id, &st.identity, &manifest, exp, now) {
                Ok(link) => Json(serde_json::json!({
                    "mode": "join", "invite": link, "expires_at_ms": exp,
                    "group_id": id, "address": manifest.address(),
                })),
                Err(e) => Json(serde_json::json!({ "error": format!("邀请链接签发失败: {e}") })),
            }
        }
        "read" => {
            let Ok(msgs) = st.groups.history(&id, 200) else {
                return Json(serde_json::json!({ "error": format!("读不到群历史: {id}") }));
            };
            let self_did = st.identity.did.as_str().to_string();
            let rows: Vec<serde_json::Value> = msgs
                .iter()
                .map(|m| serde_json::json!({
                    "role": if m.signer == self_did { "user" } else { "agent" },
                    "from": m.from, "text": m.text, "ts": m.ts,
                    "kind": m.kind, "signer": m.signer, "hash": m.hash,
                }))
                .collect();
            let n = rows.len();
            let token = group_share_token(&st, &id, now);
            let snapshot = serde_json::json!({
                "token": token,
                "kind": if meta.parent.is_some() { "topic" } else { "group" },
                "group_id": id, "parent": meta.parent, "title": meta.name,
                "by_did": self_did, "shared_at_ms": now, "messages": rows,
            });
            let dir = data_dir().join("shares");
            if let Err(e) = std::fs::create_dir_all(&dir) {
                return Json(serde_json::json!({ "error": e.to_string() }));
            }
            let body = serde_json::to_string_pretty(&snapshot).unwrap_or_default();
            if let Err(e) = std::fs::write(dir.join(format!("{token}.json")), body) {
                return Json(serde_json::json!({ "error": e.to_string() }));
            }
            Json(serde_json::json!({
                "mode": "read", "url": format!("/share/{token}"), "token": token, "messages": n,
            }))
        }
        other => Json(serde_json::json!({
            "error": format!("未知分享模式: {other} (可用 join | read)"),
        })),
    }
}

/// POST /api/groups/join — 凭邀请链接加入**同一个** store
///
/// 把此前**从未接线的**签名邀请机能在运行时闭环。验签用邀请者公钥, **从链接里的 `by=<did>` 反解**
/// (`did:pi:` / `did:key:z` 都支持) ⇒ 不需要额外人工交换公钥。
async fn group_join(
    State(st): State<AppState>,
    Json(req): Json<JoinGroupRequest>,
) -> Json<serde_json::Value> {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let Some(inviter_did) = link_query(&req.link, "by") else {
        return Json(serde_json::json!({ "error": "邀请链接里读不到邀请者 DID (by=)" }));
    };
    let Some(pk) = pubkey_of_did(&inviter_did) else {
        return Json(serde_json::json!({
            "error": format!("邀请者 DID 反解不出公钥: {inviter_did}"),
        }));
    };
    match verify_invite_link(&req.link, now, &pk) {
        Ok((gid, manifest)) => {
            // 加群额度（leo 2026-10-29 定）：新面孔 10/天 → 第 5 天 100/天 → 满月无违规 500/天；
            // 任何违规操作 ⇒ 5/天。**不是封号**：已有群的发言/干活/接任务一律不受影响。
            let principal = st.identity.did.to_string();
            let today = chrono::Local::now().format("%Y-%m-%d").to_string();
            let (age_days, used) = {
                let mut fs = st.forge.lock().await;
                let first = fs
                    .first_seen
                    .entry(principal.clone())
                    .or_insert_with(|| today.clone())
                    .clone();
                let age = (chrono::NaiveDate::parse_from_str(&today, "%Y-%m-%d")
                    .ok()
                    .zip(chrono::NaiveDate::parse_from_str(&first, "%Y-%m-%d").ok())
                    .map(|(a, b)| (a - b).num_days().max(0) as u32))
                    .unwrap_or(0);
                let used = fs
                    .join_today
                    .get(&principal)
                    .filter(|(d, _)| d == &today)
                    .map(|(_, n)| *n)
                    .unwrap_or(0);
                fs.save(&data_dir());
                (age, used)
            };
            let violations = st
                .econ
                .get()
                .map(|e| e.history_for(&principal).blocked_attempts)
                .unwrap_or(0);
            let allowed = {
                let q = bolloon_econ::quota_with_age(age_days, violations, used);
                if q.remaining == 0 {
                    Err(format!(
                        "今天的加群额度用完了（{}/{}，账号第 {} 天）：{}。已有群里发言、干活、接任务都不受影响，明天自动恢复",
                        used,
                        q.groups_per_day,
                        age_days + 1,
                        q.reason
                    ))
                } else {
                    let mut fs = st.forge.lock().await;
                    let e = fs.join_today.entry(principal.clone()).or_insert((today.clone(), 0));
                    if e.0 != today {
                        *e = (today.clone(), 0);
                    }
                    e.1 += 1;
                    fs.save(&data_dir());
                    Ok(q.remaining - 1)
                }
            };
            if let Err(why) = allowed {
                return Json(serde_json::json!({ "error": why, "quota_exhausted": true }));
            }
            let meta = st.groups.import_group_as(&gid, manifest, req.parent.clone(), now);
            Json(serde_json::json!({
                "group_id": meta.id, "name": meta.name, "parent": meta.parent,
                "address": meta.address,
                "same_store_as_inviter": st.groups.address_of(&gid).as_deref() == Some(meta.address.as_str()),
                "join_quota_remaining": allowed.unwrap_or(0),
            }))
        }
        Err(e) => Json(serde_json::json!({ "error": format!("邀请链接校验失败: {e}") })),
    }
}

#[derive(Deserialize)]
struct GroupSayRequest {
    text: String,
    /// `agent` = 智能体调用（才回 trust_flag）；人类前端不传
    #[serde(default)]
    role: Option<String>,
}

/// 别的节点报过来的池子视图（验签通过才进缓存）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PoolPeer {
    pub node: String,
    pub at_ms: i64,
    pub cash_available_usd: f64,
    pub contribution_cash_usd: f64,
    pub committed_usd: f64,
    pub spent_usd: f64,
    pub providers: Vec<String>,
    pub sig: String,
    /// 本节点验签结果（false 的记录也留着，但数据不参与"全网可用"求和）
    pub verified: bool,
    /// 本节点多久前看到的（毫秒）
    pub age_ms: i64,
}

/// 规范化 JSON（键排序），签名/验签必须对同一份字节
fn canonical(v: &serde_json::Value) -> String {
    fn walk(v: &serde_json::Value, out: &mut String) {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                out.push('{');
                for (i, k) in keys.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(k).unwrap_or_default());
                    out.push(':');
                    walk(&m[*k], out);
                }
                out.push('}');
            }
            serde_json::Value::Array(a) => {
                out.push('[');
                for (i, x) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    walk(x, out);
                }
                out.push(']');
            }
            other => out.push_str(&serde_json::to_string(other).unwrap_or_default()),
        }
    }
    let mut o = String::new();
    walk(v, &mut o);
    o
}

fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

fn b58_decode_64(s: &str) -> Option<[u8; 64]> {
    let v = bs58::decode(s).into_vec().ok()?;
    if v.len() != 64 {
        return None;
    }
    let mut out = [0u8; 64];
    out.copy_from_slice(&v);
    Some(out)
}

/// 生成**可被别的节点验签**的池子快照
async fn pool_snapshot(st: &AppState) -> serde_json::Value {
    let (pool, providers) = match st.econ.get() {
        Some(e) => {
            let r = e.report();
            (
                r.pool,
                e.registry()
                    .selectable()
                    .iter()
                    .map(|p| p.id.clone())
                    .collect::<Vec<_>>(),
            )
        }
        None => (
            bolloon_econ::PublicPool::default(),
            vec![],
        ),
    };
    let node = st.identity.did.to_string();
    let at_ms = chrono::Utc::now().timestamp_millis();
    // 「可用现金」= 配置里的储备 + 已到账贡献（后者才是众筹进池的钱）
    let cash_available = pool.cash_available_usd + pool.contribution_cash_usd;
    let body = serde_json::json!({
        "node": node,
        "at_ms": at_ms,
        "cash_available_usd": cash_available,
        "contribution_cash_usd": pool.contribution_cash_usd,
        "committed_usd": pool.committed_usd,
        "spent_usd": pool.spent_usd,
        "providers": providers,
    });
    let sig = b58(&st.identity.sign(canonical(&body).as_bytes()));
    let mut out = body;
    out["sig"] = serde_json::Value::String(sig);
    out["schema"] = serde_json::Value::String("bolloon.pool-view/v1".into());
    out
}

/// GET /api/econ/pool/view → 本节点快照（已签名）+ 已验证的其它节点视图
async fn pool_view(State(st): State<AppState>) -> Json<serde_json::Value> {
    let local = pool_snapshot(&st).await;
    let peers: Vec<PoolPeer> = {
        let m = st.pool_peers.lock().await;
        m.values().cloned().collect()
    };
    let verified_cash: f64 = peers
        .iter()
        .filter(|p| p.verified)
        .map(|p| p.cash_available_usd)
        .sum();
    let local_cash = local["cash_available_usd"].as_f64().unwrap_or(0.0);
    Json(serde_json::json!({
        "ok": true,
        "local": local,
        "peers": peers,
        "network": {
            "verified_nodes": peers.iter().filter(|p| p.verified).count() + 1,
            "unverified_nodes": peers.iter().filter(|p| !p.verified).count(),
            "cash_available_sum_usd": local_cash + verified_cash,
            "note": "只求和**验签通过**的对端；未验签的留在列表里但不算钱",
        },
    }))
}

/// POST /api/econ/pool/peers  body: { url } 或 { peer: <snapshot> }
/// 拉取（或接收）另一节点的池子视图 → 验签 → 进缓存；同一节点只保留最新一份。
async fn pool_peer_add(
    State(st): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let snap: serde_json::Value = if let Some(s) = body.get("peer") {
        s.clone()
    } else if let Some(url) = body.get("url").and_then(|v| v.as_str()) {
        let url = format!("{}/api/econ/pool/view", url.trim_end_matches('/'));
        // 关键：同步 HTTP 必须丢到 blocking 线程池。
        // 直接在 async handler 里调用会占住 runtime worker，两节点同进程时互相饿死（实测会挂住）。
        let fetched = tokio::task::spawn_blocking(move || {
            ureq::get(&url)
                .timeout(std::time::Duration::from_secs(8))
                .call()
                .ok()
                .and_then(|r| r.into_json::<serde_json::Value>().ok())
                .map(|v| v.get("local").cloned().unwrap_or(v))
        })
        .await
        .ok()
        .flatten();
        match fetched {
            Some(v) => v,
            None => {
                return Json(
                    serde_json::json!({ "ok": false, "error": "拉取失败（超时或响应不合法）" }),
                )
            }
        }
    } else {
        return Json(serde_json::json!({ "ok": false, "error": "要 url 或 peer 快照" }));
    };

    let node = snap.get("node").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if node.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "快照缺 node" }));
    }
    if node == st.identity.did.to_string() {
        return Json(serde_json::json!({ "ok": false, "error": "这是本节点自己的快照" }));
    }
    // 验签：用 node DID 反解公钥，对去掉 sig/schema 的规范化 JSON 验 ed25519
    let mut body_only = snap.clone();
    if let Some(o) = body_only.as_object_mut() {
        o.remove("sig");
        o.remove("schema");
    }
    let sig_ok = match (pubkey_of_did(&node), snap.get("sig").and_then(|v| v.as_str())) {
        (Some(pubkey), Some(sig)) => match (Some(pubkey), b58_decode_64(sig)) {
            (Some(pubkey), Some(sig_bytes)) => {
                bolloon_p2p::identity::KeyPair::verify(&pubkey, canonical(&body_only).as_bytes(), &sig_bytes)
            }
            _ => false,
        },
        _ => false,
    };
    let peer = PoolPeer {
        node: node.clone(),
        at_ms: snap.get("at_ms").and_then(|v| v.as_i64()).unwrap_or(0),
        cash_available_usd: snap.get("cash_available_usd").and_then(|v| v.as_f64()).unwrap_or(0.0),
        contribution_cash_usd: snap
            .get("contribution_cash_usd")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0),
        committed_usd: snap.get("committed_usd").and_then(|v| v.as_f64()).unwrap_or(0.0),
        spent_usd: snap.get("spent_usd").and_then(|v| v.as_f64()).unwrap_or(0.0),
        providers: snap
            .get("providers")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default(),
        sig: snap.get("sig").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        verified: sig_ok,
        age_ms: 0,
    };
    {
        let mut m = st.pool_peers.lock().await;
        // 同节点只留最新
        match m.get(&node) {
            Some(old) if old.at_ms > peer.at_ms => {}
            _ => {
                m.insert(node.clone(), peer.clone());
            }
        }
    }
    Json(serde_json::json!({
        "ok": true,
        "node": node,
        "verified": sig_ok,
        "note": if sig_ok { "验签通过，已计入全网可用" } else { "验签失败：只记录不计数（不改别人数据，也不信它）" },
    }))
}

/// GET /api/econ/consciousness/{principal}[?role=agent]
///
/// **人类不可见量化指标**（leo 2026-10-29 定）：
/// - 人类侧只回 `needs` / `growth_path`（"你现在需要什么帮助、往哪走"），没有分数、没有阶段；
/// - `?role=agent`（智能体工具带）才回完整档案，agent 据此调整帮助方式。
async fn econ_consciousness(
    State(st): State<AppState>,
    Path(principal): Path<String>,
    Query(q): Query<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(econ) = st.econ.get() else {
        return Json(serde_json::json!({ "ok": false, "error": "经济层未启用" }));
    };
    let h = econ.history_for(&principal);
    // 信号只取**可核验事实**：兑现承诺=成功意图，分享=已验收贡献，不烧钱成事=零现金意图
    let sig = bolloon_econ::Signals {
        promises_kept: h.successful_intents,
        shares_verified: h.verified_contributions,
        zero_cost_successes: h.zero_cost_intents,
        ..Default::default()
    };
    let prof = bolloon_econ::assess_consciousness(&principal, &sig);
    let as_agent = q.get("role").and_then(|v| v.as_str()) == Some("agent");
    if as_agent {
        Json(serde_json::json!({ "ok": true, "role": "agent", "profile": prof }))
    } else {
        // 人类：剥掉 index/stage/permissions，只留"需要什么帮助"
        Json(serde_json::json!({
            "ok": true,
            "role": "human",
            "view": bolloon_econ::consciousness_human_view(&prof),
        }))
    }
}

/// POST /api/econ/immune/report  body: { subject, reporter, kind, note? }
/// 任何 agent 都能报；单个报告者最多把对方升到 watch（防免疫系统被武器化）。
async fn immune_report(
    State(st): State<AppState>,
    Json(body): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let Some(econ) = st.econ.get() else {
        return Json(serde_json::json!({ "ok": false, "error": "经济层未启用（免疫系统没有挂载）" }));
    };
    let subject = body.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim();
    let reporter = body.get("reporter").and_then(|v| v.as_str()).unwrap_or("").trim();
    if subject.is_empty() || reporter.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "subject 与 reporter 都必填" }));
    }
    let kind: bolloon_econ::AlarmKind = match serde_json::from_value(
        body.get("kind").cloned().unwrap_or(serde_json::json!("spam")),
    ) {
        Ok(k) => k,
        Err(_) => {
            return Json(serde_json::json!({
                "ok": false,
                "error": "kind 非法 (spam/failed_verification/budget_abuse/prompt_injection/data_exfiltration/impersonation)"
            }))
        }
    };
    let note = body.get("note").and_then(|v| v.as_str()).unwrap_or("");
    let now = chrono::Utc::now().timestamp_millis();
    let a = econ.immune().raise(subject, reporter, kind, now, note);
    Json(serde_json::json!({ "ok": true, "assessment": a }))
}

/// GET /api/econ/immune/{subject} → 当前设防姿态（浓度/报告者数/依据/怎么自愈）
async fn immune_status(
    State(st): State<AppState>,
    Path(subject): Path<String>,
) -> Json<serde_json::Value> {
    let Some(econ) = st.econ.get() else {
        return Json(serde_json::json!({ "ok": false, "error": "经济层未启用" }));
    };
    let a = econ.immune().assess(&subject, chrono::Utc::now().timestamp_millis());
    Json(serde_json::json!({ "ok": true, "assessment": a }))
}

/// 发言者诚信标识：从经济层算（未启用经济层 ⇒ 不打标，也不假装干净）。
async fn speaker_trust(st: &AppState, principal: &str) -> Option<serde_json::Value> {
    let econ = st.econ.get()?;
    let a = econ.allowance_for(principal, None);
    let h = econ.history_for(principal);
    let flag = bolloon_econ::speech_flag(a.tier, h.blocked_attempts)?;
    serde_json::to_value(flag).ok()
}

/// GET /api/econ/reputation/{principal} → 双层诚信档案：
/// `onchain`（紧凑、可上链、带 digest） + `offchain`（详细理由、加群额度、善意路径）。
async fn econ_reputation(
    State(st): State<AppState>,
    Path(principal): Path<String>,
) -> Json<serde_json::Value> {
    let Some(econ) = st.econ.get() else {
        return Json(serde_json::json!({ "ok": false, "error": "经济层未启用" }));
    };
    let h = econ.history_for(&principal);
    let a = econ.allowance_for(&principal, None);
    let day = chrono::Local::now().format("%Y-%m-%d").to_string();
    let used_joins = {
        let fs = st.forge.lock().await;
        fs.join_today
            .get(&principal)
            .filter(|(d, _)| d == &day)
            .map(|(_, n)| *n)
            .unwrap_or(0)
    };
    let age_days = {
        let fs = st.forge.lock().await;
        fs.first_seen
            .get(&principal)
            .and_then(|first| {
                chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")
                    .ok()
                    .zip(chrono::NaiveDate::parse_from_str(first, "%Y-%m-%d").ok())
                    .map(|(a, b)| (a - b).num_days().max(0) as u32)
            })
            .unwrap_or(0)
    };
    let (onchain, offchain) = bolloon_econ::build_reputation(
        &principal,
        &day,
        &h,
        &a,
        h.blocked_attempts,
        used_joins,
        age_days,
    );
    Json(serde_json::json!({
        "ok": true,
        "onchain": onchain,
        "offchain": offchain,
        "note": "上链只带计数/档位/细节哈希承诺；具体理由、善意路径与加群额度留在链下",
    }))
}

/// GET /api/groups/{id}/invite → 群邀请链接（人类点一下复制；智能体也调这个去邀请别人）。
///
/// 返回两种形态：
/// - `link`：`bolloon://join/…`（内容寻址，对方开出**同一个** orbit store）
/// - `abs_link`：网页可直接点开/复制的绝对地址（?join=<link>），手机端也能用
async fn group_invite(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let now = chrono::Utc::now().timestamp_millis() as u64;
    let Some(manifest) = st.groups.manifest_of(&id) else {
        return Json(serde_json::json!({ "ok": false, "error": "取不到该群 manifest (store 未打开)" }));
    };
    let exp = now + 7 * 24 * 3600 * 1000;
    match make_invite_link(&id, &st.identity, &manifest, exp, now) {
        Ok(link) => {
            let enc: String = link
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            Json(serde_json::json!({
                "ok": true,
                "group_id": id,
                "link": link,
                "abs_link": format!("https://bolloon.cn/?join={enc}"),
                "expires_at_ms": exp,
                "expires_in_days": 7,
                "note": "人类：点侧边栏底部「邀请」即复制；智能体：GET 本接口拿 link 发给其它智能体，对方 POST /api/groups/join",
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": format!("邀请链接签发失败: {e}") })),
    }
}

/// GET /api/groups/{id}/members → 群成员（智能体据此决定还要邀请谁）
async fn group_members_api(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let agents = {
        let fs = st.forge.lock().await;
        crate::native::room_candidate_agents(&fs, &id)
    };
    let roster = crate::native::roster_of(&st, &id).await;
    Json(serde_json::json!({
        "ok": true,
        "group_id": id,
        "members": agents.iter().map(|a| serde_json::json!({
            "id": a.id, "name": a.name,
            "direct_reply": roster.roster.eligible().contains(&a.id),
            "lead": roster.roster.leads.contains(&a.id),
            "foreman": roster.roster.foremen.contains(&a.id),
            "sheriff": roster.roster.sheriff.as_deref() == Some(a.id.as_str()),
        })).collect::<Vec<_>>(),
        "roster": roster.roster,
        "term_expires_at_ms": roster.expires_at_ms(),
    }))
}

/// POST /api/groups/{id}/reply-limit  body: { "n": 5, "by": "agent-id" }
/// 警长设定"每轮最多几个智能体接话"（大群默认 5，上限 1000）。
async fn set_reply_limit(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let n = req.get("n").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let by = req
        .get("by")
        .and_then(|v| v.as_str())
        .unwrap_or("sheriff")
        .to_string();
    match crate::native::set_room_reply_limit(&st, &id, n, &by).await {
        Ok(v) => Json(v),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e })),
    }
}

/// GET /api/groups/{id}/reply-limit → 当前生效值 + 来源（警长设定/大群默认）
async fn get_reply_limit(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> Json<serde_json::Value> {
    let members = {
        let fs = st.forge.lock().await;
        crate::native::room_candidate_agents(&fs, &id).len()
    };
    let sheriff = {
        let fs = st.forge.lock().await;
        fs.room_reply_limit.get(&id).copied()
    };
    let term = crate::native::sheriff_term(&st, &id).await;
    let roster = crate::native::roster_of(&st, &id).await.roster;
    Json(serde_json::json!({
        "ok": true,
        "group_id": id,
        "members": members,
        "reply_limit": crate::room_bus::reply_limit_for(members, sheriff),
        "source": if sheriff.is_some() { "sheriff" } else { "default" },
        "sheriff": term.as_ref().map(|t| t.agent_id.clone()),
        "roster": {
            "direct_reply": roster.direct_reply_count(),
            "leads": crate::room_bus::LEADS_PER_GROUP,
            "foremen": crate::room_bus::FOREMEN_PER_GROUP,
            "max_direct": crate::room_bus::DIRECT_REPLY_MAX,
            "foreman_ids": roster.foreman_list(),
        },
        "term_days": term.as_ref().map(|t| t.term_days),
        "term_expires_at_ms": term.as_ref().map(|t| t.expires_at_ms()),
        "large_threshold": crate::room_bus::GROUP_LARGE_THRESHOLD,
        "default_when_large": crate::room_bus::DEFAULT_REPLIES_WHEN_LARGE,
        "max": crate::room_bus::MAX_ELECTED_AGENTS,
    }))
}

async fn group_say(
    State(st): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<GroupSayRequest>,
) -> Json<serde_json::Value> {
    let kp = &st.identity;
    let now_ms = chrono::Utc::now().timestamp_millis() as u64;
    // 商议决策：推选谁回应 + 控麦 + 并发去重（落块前先决策，便于运行时接线真正驱动多 agent 讨论）。
    // 本地人类发言永不被命令门禁；外部顾问走 room_guide 的 from/command 入口判据。
    let hub = crate::native::room_hub(&st, &id).await;
    let decision = crate::native::decide_room_message(
        &hub,
        &id,
        kp.did.as_str(),
        MemberRole::Human,
        &req.text,
        req.text.starts_with('/'),
        now_ms,
        ElectionMode::AddressedFirst,
        0,
    )
    .expect("本地人类发言永不被命令门禁");
    // 签名 + 写门 + 落块 全部在 OrbitStore 内完成 (Ed25519 + hash 链)
    // 诚信标识：低诚信者的发言要在群里留痕（其它智能体据此设防），但**不禁言**
    let trust_flag = speaker_trust(&st, kp.did.as_str()).await;
    let entry = if trust_flag.is_some() {
        st.groups.say_flagged(
            &id,
            kp,
            kp.did.as_str(),
            &req.text,
            trust_flag.clone(),
            now_ms,
        )
    } else {
        st.groups.say(&id, kp, kp.did.as_str(), &req.text, now_ms)
    };
    match entry {
        Ok(entry) => {
            // 后台执行 (这次请求立刻返回): 推举 → 并发跑 → 只把汇报落回群
            // 接话人数：警长设定优先；没有则按群规模（>10 人默认 5 人接话）
            let limit = crate::native::room_reply_limit_of(&st, &id).await;
            // 组织名单：警长 1 + 小组长 5 + 领班 12 = 18 人可直接回复；名单外的人不刷群
            let roster = crate::native::roster_of(&st, &id).await.roster;
            // 免疫系统：隔离态成员本轮不进接话名单（到期自动解除，不需要人工放行）
            let now_i = chrono::Utc::now().timestamp_millis();
            let targets = {
                let fs = st.forge.lock().await;
                let agents = crate::native::room_candidate_agents(&fs, &id);
                let cursor = st.groups.history(&id, 0).map(|h| h.len()).unwrap_or(0);
                let picked = crate::room_bus::elect_from_roster(
                    &agents,
                    &crate::native::parse_addressed(&req.text),
                    &roster,
                    cursor,
                    limit,
                );
                match st.econ.get() {
                    Some(econ) => picked
                        .into_iter()
                        .filter(|a| econ.immune().may_speak(&a.id, now_i))
                        .collect(),
                    None => picked,
                }
            };
            let queued: Vec<String> = targets.iter().map(|a| a.name.clone()).collect();
            if let Some(first) = queued.first() {
                let mut fs = st.forge.lock().await;
                fs.room_last_speaker.insert(id.clone(), first.clone());
                fs.save(&data_dir());
            }
            // 记录人类发言（重置监督器沉默计时，避免自驱抢在人类前面）
            st.room_bus.mark_human(&id);
            // 一条群消息 = 一个根意图；被推举的 N 个 agent 的调用都记在它名下
            let intent = crate::room_bus::group_intent(&id, now_ms);
            crate::room_bus::spawn_reports(st.clone(), id.clone(), req.text.clone(), targets, intent);
            Json(serde_json::json!({
            "hash": entry.hash,
            "clock": entry.clock,
            "signer": entry.signer,
            "signature": entry.signature,
            "timestamp_ms": entry.timestamp_ms,
            "queued": queued,
            // 人类侧不回这个字段：标识只给智能体用来设防
            "trust_flag": if req.role.as_deref() == Some("agent") { trust_flag.clone() } else { None },
            "deliberation": {
                "seq": decision.seq,
                "duplicate": decision.duplicate,
                "speaker_id": decision.speaker_id,
                "reason": format!("{:?}", decision.reason),
                "floor_granted": decision.floor_granted,
                "can_command": decision.can_command,
                "cooldown_blocked": decision.cooldown_blocked,
            },
            }))
        }
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


    /// 2026-10-30 (leo): 群组以名字为身份 + 好友智能体跨机面 fail-closed + 界面真源门。
    ///
    /// 三件要一起钉住:
    /// ① `create_group` / `room_new` 的 id 就是名字(同名复用), 群列表里不再出现 `gw-<hex>`;
    /// ② `/api/agents/public` 与 `/api/agents/public/chat` 只对**已加好友的 did** 开口;
    /// ③ 桌面界面只有一份真源(`bolloon-web/assets/index.html`), 壳目录里那份不许再长第二个界面
    ///    —— 上一轮「外壳栏改动没生效」就是因为它只改了 `app-tauri/ui/index.html` 这份过期副本。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn group_name_identity_and_friend_agents_gates() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-web-grouptest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        // 造一个「已加好友」的 did (正向对照): 用真 keypair, 因为跨机来访现在要求 DID 签名
        let friend_kp = bolloon_p2p::KeyPair::generate();
        let friend_did = friend_kp.did.as_str().to_string();
        let server_did = state.identity.did.as_str().to_string();
        {
            let mut fs = state.forge.lock().await;
            let fr = fs.friends.inbound(&friend_did, &friend_did, 1_000);
            fs.friends.accept(&fr.request_id, 1_001).unwrap();
        }
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");

        tokio::task::spawn_blocking(move || {
            let get_json = |path: &str| -> serde_json::Value {
                ureq::get(&format!("{base}{path}")).call().unwrap().into_json().unwrap()
            };
            let post_json = |path: &str, body: serde_json::Value| -> serde_json::Value {
                ureq::post(&format!("{base}{path}")).send_json(body).unwrap().into_json().unwrap()
            };

            // ① 群组 id = 名字; 同名复用; 不留技术 id
            let g1 = post_json("/api/groups", serde_json::json!({ "name": "聚变小组" }));
            assert_eq!(g1["id"], "聚变小组");
            assert_eq!(g1["reused"], false);
            let g2 = post_json("/api/groups", serde_json::json!({ "name": "聚变小组" }));
            assert_eq!(g2["id"], "聚变小组");
            assert_eq!(g2["reused"], true);
            let list = get_json("/api/groups");
            let ids: Vec<String> = list["groups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|g| g["id"].as_str().unwrap_or_default().to_string())
                .collect();
            assert!(ids.contains(&"聚变小组".to_string()));
            assert!(!ids.iter().any(|i| i.starts_with("gw-")), "群列表里不该再出现技术 id: {ids:?}");

            // 商议群组同样按名字 (此前是「群组 1234」+ gw-xxxx)
            let r1 = post_json("/api/room/new", serde_json::json!({ "name": "商议A" }));
            assert_eq!(r1["id"], "商议A");
            assert_eq!(r1["name"], "商议A");
            assert_eq!(r1["reused"], false);
            let r2 = post_json("/api/room/new", serde_json::json!({ "name": "商议A" }));
            assert_eq!(r2["reused"], true);
            let r3 = post_json("/api/room/new", serde_json::json!({}));
            assert_eq!(r3["name"], "商议", "缺省名不许带数字");
            assert!(!r3["id"].as_str().unwrap().chars().any(|c| c.is_ascii_digit()));

            // ② 好友面: 缺 did / 非好友 / 好友 三种
            let no_did = get_json("/api/agents/public");
            assert_eq!(no_did["ok"], false);
            assert!(no_did["error"].as_str().unwrap().contains("缺少来访者 did"));
            let stranger = get_json("/api/agents/public?did=did:pi:stranger");
            assert_eq!(stranger["ok"], false);
            assert!(stranger["error"].as_str().unwrap().contains("不是本机好友"));
            let friend = get_json(&format!("/api/agents/public?did={friend_did}"));
            assert_eq!(friend["ok"], true, "已加好友的 did 必须能列举: {friend}");
            assert!(friend["agents"].is_array());

            // 对话面 (2026-10-30 起要求 DID 签名):
            // ① 没签名 ⇒ 直接拒, 连好友判断都不走 (防「请求体里写个好友 did 就冒充」)
            let unsigned = post_json(
                "/api/agents/public/chat",
                serde_json::json!({ "from_did": friend_did, "agent_id": "agent-001", "text": "hi" }),
            );
            assert_eq!(unsigned["ok"], false);
            assert!(unsigned["error"].as_str().unwrap().contains("缺签名"), "实得 {unsigned}");
            // ② 签了但不是好友 ⇒ 「不是本机好友」(fail-closed)
            let stranger_kp = bolloon_p2p::KeyPair::generate();
            let s_did = stranger_kp.did.as_str().to_string();
            let s_ts = chrono::Utc::now().timestamp_millis() as u64;
            let s_msg = crate::native::relay_message(&s_did, &server_did, "agent-001", "hi", s_ts);
            let stranger_chat = post_json(
                "/api/agents/public/chat",
                serde_json::json!({
                    "from_did": s_did, "agent_id": "agent-001", "text": "hi",
                    "ts_ms": s_ts, "sig": hex::encode(stranger_kp.sign(s_msg.as_bytes())),
                }),
            );
            assert_eq!(stranger_chat["ok"], false);
            assert!(stranger_chat["error"].as_str().unwrap().contains("不是本机好友"), "实得 {stranger_chat}");
            // ③ 好友签名有效, 但智能体不存在 ⇒ 如实报「没有这个智能体」(说明签名门已过)
            let ts = chrono::Utc::now().timestamp_millis() as u64;
            let msg = crate::native::relay_message(&friend_did, &server_did, "nope", "hi", ts);
            let missing_agent = post_json(
                "/api/agents/public/chat",
                serde_json::json!({
                    "from_did": friend_did, "agent_id": "nope", "text": "hi",
                    "ts_ms": ts, "sig": hex::encode(friend_kp.sign(msg.as_bytes())),
                }),
            );
            assert_eq!(missing_agent["ok"], false);
            assert!(missing_agent["error"].as_str().unwrap().contains("没有这个智能体"), "实得 {missing_agent}");
            // ④ 篡改文本 ⇒ 验签失败 (签名覆盖文本摘要)
            let ts2 = chrono::Utc::now().timestamp_millis() as u64;
            let msg2 = crate::native::relay_message(&friend_did, &server_did, "agent-001", "hi", ts2);
            let tampered = post_json(
                "/api/agents/public/chat",
                serde_json::json!({
                    "from_did": friend_did, "agent_id": "agent-001", "text": "hi, 但是被改了",
                    "ts_ms": ts2, "sig": hex::encode(friend_kp.sign(msg2.as_bytes())),
                }),
            );
            assert_eq!(tampered["ok"], false);
            assert!(tampered["error"].as_str().unwrap().contains("签名验不过"), "实得 {tampered}");

            // 本机代理面: 非好友一律拒 (不给对端地址也不假装成功)
            let proxy_agents = get_json("/api/friends/did:pi:stranger/agents");
            assert_eq!(proxy_agents["ok"], false);
            assert_eq!(proxy_agents["agents"], serde_json::json!([]));
            let proxy_chat = post_json(
                "/api/friends/did:pi:stranger/chat",
                serde_json::json!({ "agent_id": "agent-001", "text": "hi" }),
            );
            assert_eq!(proxy_chat["ok"], false);
        })
        .await
        .unwrap();

        // ③ 界面真源门 (源级): 群组页入口在真源里, 旧顶栏/旧外壳栏都没了, 壳目录那份只是占位
        //    2026-10-30 (用户第二轮): 外壳 = 第一栏本身 —— 不再有独立的 #shellRail 列
        //    (上一轮那列让"第一栏前面多出来一个栏"), 拖拽区挂到 #primaryRail 上。
        assert!(
            !INDEX_HTML.contains("id=\"shellRail\""),
            "不许再有独立外壳栏 —— 外壳就是第一栏 (#primaryRail)"
        );
        assert!(!INDEX_HTML.contains("id=\"titlebar\""), "旧顶部标题栏必须删掉 (否则与 header 叠两条横栏)");
        assert!(
            INDEX_HTML.contains("id=\"primaryRail\"") && INDEX_HTML.contains("data-tauri-drag-region"),
            "第一栏必须存在且自己是窗口拖拽区"
        );
        for need in ["id=\"addFriendBtn\"", "id=\"joinGroupBtn\"", "id=\"groupDots\"", "id=\"friendAgents\""] {
            assert!(INDEX_HTML.contains(need), "群组页入口缺失: {need}");
        }
        assert!(INDEX_HTML.contains("/api/friends/"), "跨机好友面必须接到界面上");
        const TAURI_UI: &str = include_str!("../../../app-tauri/ui/index.html");
        assert!(
            !TAURI_UI.contains("desktop3col"),
            "rust/app-tauri/ui/index.html 只能是占位页 —— 真源是 bolloon-web/assets/index.html"
        );
    }

    /// `BOLLOON_HOME` 是**进程级全局环境变量**: 两条起真服务的 e2e 并行跑会互相串
    /// (后写的那个把前一条的 home 抢走)。用一把静态锁把它们串起来 ——
    /// 不加这把锁, 通讯录用例会把这条的目录换成自己的。
    static HOME_GUARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// 真起一个服务 (端口 0), 用 ureq 走真 HTTP:
    /// bootstrap 带真实消息流 → 分享链接能打开 → 梦想文档作者取 profile → 状态登记
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn share_bootstrap_dream_routes_e2e() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
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

            // 4) 群 + 子讨论: **分开讨论** —— 小组消息不混进父群
            let grp = post_json("/api/groups", serde_json::json!({ "name": "研发群" }));
            let gid = grp["id"].as_str().expect("group id").to_string();
            let topic = post_json(
                &format!("/api/groups/{gid}/topics"),
                serde_json::json!({ "id": "t1", "name": "上线评审", "members": [] }),
            );
            assert_eq!(topic["id"], serde_json::json!("t1"), "{topic}");
            assert_eq!(topic["parent"], serde_json::json!(gid), "{topic}");

            let tid = "t1".to_string();
            let r1 = post_json(&format!("/api/groups/{tid}/say"), serde_json::json!({ "text": "小组内部意见" }));
            let r2 = post_json(&format!("/api/groups/{gid}/say"), serde_json::json!({ "text": "群里公开说" }));
            assert!(r1["error"].is_null(), "子讨论发言应成功: {r1}");
            assert!(r2["error"].is_null(), "父群发言应成功: {r2}");

            let sub = get_json(&format!("/api/groups/{tid}/messages"));
            let parent = get_json(&format!("/api/groups/{gid}/messages"));
            // 注意: 群消息的 HTTP 形状字段是 content/sender/seq (不是 text)
            let sub_txt: Vec<&str> = sub["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
            let par_txt: Vec<&str> = parent["messages"].as_array().unwrap().iter().filter_map(|m| m["content"].as_str()).collect();
            assert!(sub_txt.contains(&"小组内部意见"), "{sub_txt:?}");
            assert!(!par_txt.contains(&"小组内部意见"), "子讨论消息不该混进父群: {par_txt:?}");
            assert!(par_txt.contains(&"群里公开说"), "{par_txt:?}");
            assert!(
                parent["messages"].as_array().unwrap().iter().any(|m| m["kind"] == "topic"),
                "父群应留有签名 topic 记录"
            );
            assert_eq!(get_json(&format!("/api/groups/{gid}/topics"))["topics"].as_array().unwrap().len(), 1);

            // 5) **统一分享**: 整群与子讨论同一入口、同一套判据
            let join_share = post_json(&format!("/api/groups/{gid}/share"), serde_json::json!({ "mode": "join" }));
            let link = join_share["invite"].as_str().expect("invite link").to_string();
            assert!(link.starts_with(&format!("bolloon://join/{gid}?")), "{link}");
            assert!(link.contains("&m="), "邀请链接必须带 manifest ⇒ 对方开同一个 store: {link}");

            let read_share = post_json(&format!("/api/groups/{gid}/share"), serde_json::json!({ "mode": "read" }));
            let gtok = read_share["token"].as_str().expect("token").to_string();
            assert_eq!(gtok.len(), 24, "{read_share}");
            assert!(get_text(&format!("/share/{gtok}")).contains("群里公开说"), "只读快照页应有群消息");
            let gsnap = get_json(&format!("/api/share/{gtok}"));
            assert_eq!(gsnap["kind"], serde_json::json!("group"), "{gsnap}");
            assert_eq!(gsnap["group_id"], serde_json::json!(gid));

            // 未知模式 → 明确报错, 不静默走默认
            let bad = post_json(&format!("/api/groups/{gid}/share"), serde_json::json!({ "mode": "zip" }));
            assert!(bad["error"].as_str().unwrap().contains("未知分享模式"), "{bad}");

            // 6) **凭邀请加入**闭环: 从链接的 by=<did> 反解邀请者公钥验签 ⇒ 开出同一个 store
            let joined = post_json("/api/groups/join", serde_json::json!({ "link": link.clone() }));
            assert!(joined["error"].is_null(), "邀请加入应成功: {joined}");
            assert_eq!(joined["same_store_as_inviter"], serde_json::json!(true), "{joined}");
            // 篡改签名 ⇒ 必须被拒 (不让伪造链接混进同一个 store)
            let tampered = link.replacen("t=", "t=zz", 1);
            let bad_join = post_json("/api/groups/join", serde_json::json!({ "link": tampered }));
            assert!(!bad_join["error"].is_null(), "伪造邀请链接必须被拒: {bad_join}");

            // 4) 梦想文档: 作者取真实 profile 名 (不硬编码 user), 并登记到状态
            let dream = post_json("/api/dream/topic", serde_json::json!({ "topic": "核聚变口径" }));
            assert_eq!(dream["author"], serde_json::json!("用户"));
            let written = dream["written"].as_str().expect("写入路径").to_string();
            assert!(written.ends_with("核聚变口径.md"), "{written}");
            let last = get_json("/api/dream/last");
            assert_eq!(last["dreams"], serde_json::json!([written]));
            assert!(last["last"].is_null(), "还没做过梦 → 如 null 不编报告");

            // 5) 世界卡片跨机投递: 自己签的 world.card 帧收下入库, 伪卡一律拒收
            let kp = bolloon_p2p::identity::KeyPair::generate();
            let card = bolloon_agent::world::WorldCard {
                title: "跨机卡片".into(),
                summary: "从另一台机器投递".into(),
                media: vec![bolloon_agent::world::CardMedia {
                    kind: bolloon_agent::world::CardMediaKind::Video,
                    url: "ipfs://v".into(),
                    mime: None,
                    name: None,
                }],
                cover: Some(bolloon_agent::world::CardCover {
                    url: "ipfs://cover".into(),
                    kind: bolloon_agent::world::CoverKind::Video,
                }),
                provider_did: kp.did.as_str().into(),
                provider_name: None,
                scope: bolloon_agent::world::CardScope::Public,
                issued_at_ms: 1,
                verification: bolloon_agent::world::CardVerification::Unverified,
            };
            let env = bolloon_agent::world::pack_world_card(&kp, &card, 1);
            let pushed = post_json("/api/world/cards/push", serde_json::to_value(&env).unwrap());
            assert_eq!(pushed["ok"], serde_json::json!(true), "{pushed}");
            assert_eq!(pushed["card"]["title"], serde_json::json!("跨机卡片"));
            assert_eq!(pushed["card"]["card"]["verification"], serde_json::json!("verified"));
            // 封面档位随卡片一起过网 (video → 前端渲染成高卡)
            assert_eq!(pushed["card"]["card"]["cover"]["kind"], serde_json::json!("video"));

            // 伪卡: 换掉正文 (签名不覆盖新内容) → 拒收, 不静默降级
            let mut forged = env.clone();
            forged.payload = serde_json::to_value(bolloon_agent::world::WorldCard {
                title: "伪卡".into(),
                ..card.clone()
            })
            .unwrap();
            let rejected = post_json("/api/world/cards/push", serde_json::to_value(&forged).unwrap());
            assert!(rejected["error"].as_str().unwrap().contains("拒收"), "{rejected}");

            // 列表端点读到的是刚收的那张 (伪卡没入库)
            let cards = get_json("/api/world/cards");
            assert_eq!(cards["count"], serde_json::json!(1), "{cards}");

            // 6) 两种分享路径: 好友模式 = 自动定向给好友 (不进公域); 公开模式 = 广播给世界
            let mut priv_card = card.clone();
            priv_card.scope = bolloon_agent::world::CardScope::Private;
            let shared_priv = post_json("/api/world/cards/share", serde_json::to_value(&priv_card).unwrap());
            assert_eq!(shared_priv["ok"], serde_json::json!(true), "{shared_priv}");
            assert_eq!(shared_priv["mode"], serde_json::json!("friends"));
            assert_eq!(
                shared_priv["targets"], serde_json::json!([]),
                "本用例没有好友 → 如实'没人收到', 不退化成广播"
            );
            // 好友卡发出的信封 scope 仍是 private (把它改成 public 验签必败, 不能偷扩受众)
            let priv_env: bolloon_p2p::envelope::SignedEnvelope =
                serde_json::from_value(shared_priv["envelope"].clone()).unwrap();
            assert_eq!(
                bolloon_agent::world::unpack_world_card(&priv_env).unwrap().scope,
                bolloon_agent::world::CardScope::Private
            );

            let mut pub_card = card.clone();
            pub_card.scope = bolloon_agent::world::CardScope::Public;
            let shared_pub = post_json("/api/world/cards/share", serde_json::to_value(&pub_card).unwrap());
            assert_eq!(shared_pub["mode"], serde_json::json!("broadcast"), "{shared_pub}");
            assert!(shared_pub["delivery"].as_str().unwrap().contains("世界"), "{shared_pub}");

            // 好友模式的卡: 非好友投递 → 拒收 (接收侧也不放水)
            let env2 = bolloon_agent::world::pack_world_card(&kp, &priv_card, 2);
            let rejected_friend =
                post_json("/api/world/cards/push", serde_json::to_value(&env2).unwrap());
            assert!(
                rejected_friend["error"].as_str().unwrap().contains("好友"),
                "{rejected_friend}"
            );
            // 被拒的没入库
            assert_eq!(get_json("/api/world/cards")["count"], serde_json::json!(1));

            // ── 手机号: 绑定 (DID 签名) → 身份一致 → 挑战登录 → 一次性 → 篡改必须露馅 ──
            assert_eq!(get_json("/api/phone")["bound"], serde_json::json!(false));
            let bind = post_json(
                "/api/phone/bind",
                serde_json::json!({ "phone": "+86 138 0000 0000" }),
            );
            assert_eq!(bind["ok"], serde_json::json!(true), "{bind}");
            assert_eq!(bind["verified"], serde_json::json!(true));
            assert_eq!(bind["phone"], serde_json::json!("8613800000000"), "手机号要归一成纯数字");
            let pk = bind["public_key"].as_str().expect("公钥").to_string();
            assert_eq!(pk.len(), 64, "公钥是 32 字节 hex");

            let pst = get_json("/api/phone");
            assert_eq!(pst["identity_match"], serde_json::json!(true), "{pst}");
            assert_eq!(pst["checks"]["signature"], serde_json::json!(true));

            // 一个手机号不许被第二个 DID 顶掉 (把绑定文件写成别的 DID 模拟另一台机器)
            let bpath = data_dir().join("phone_binding.json");
            let good = std::fs::read_to_string(&bpath).unwrap();
            let mut other: serde_json::Value = serde_json::from_str(&good).unwrap();
            other["did"] = serde_json::json!("did:pi:someone-else");
            std::fs::write(&bpath, serde_json::to_string_pretty(&other).unwrap()).unwrap();
            let clash = post_json("/api/phone/bind", serde_json::json!({ "phone": "8613800000000" }));
            assert!(
                clash["error"].as_str().unwrap().contains("已绑定另一个 DID"),
                "{clash}"
            );

            std::fs::write(&bpath, &good).unwrap();
            let ch = post_json("/api/phone/challenge", serde_json::json!({}));
            assert_eq!(ch["nonce"].as_str().unwrap().len(), 32, "{ch}");
            let login = post_json("/api/phone/login", serde_json::json!({}));
            assert_eq!(login["ok"], serde_json::json!(true), "{login}");
            // 挑战一次性: 同一个 nonce 重放必拒
            let replay = post_json("/api/phone/login", serde_json::json!({}));
            assert!(replay["error"].as_str().unwrap().contains("已用过"), "{replay}");

            // 篡改签名 ⇒ "身份一致" 必须变 false (证明它在真验签, 不是自己签自己)
            let mut tampered: serde_json::Value = serde_json::from_str(&good).unwrap();
            let mut flipped: Vec<char> = tampered["signature"].as_str().unwrap().chars().collect();
            flipped[0] = if flipped[0] == 'a' { 'b' } else { 'a' };
            tampered["signature"] = serde_json::json!(flipped.into_iter().collect::<String>());
            std::fs::write(&bpath, serde_json::to_string_pretty(&tampered).unwrap()).unwrap();
            let after = get_json("/api/phone");
            assert_eq!(after["identity_match"], serde_json::json!(false), "{after}");
            assert_eq!(after["checks"]["signature"], serde_json::json!(false));
            // 被篡改的绑定也不能登录
            let _ = post_json("/api/phone/challenge", serde_json::json!({}));
            let bad = post_json("/api/phone/login", serde_json::json!({}));
            assert_eq!(bad["ok"], serde_json::json!(false), "{bad}");

            let _ = std::fs::remove_dir_all(&home);
        })
        .await
        .unwrap();
    }

    /// 通讯录 (2026-10-28): 真起服务 + 真 HTTP —— 「顶部搜索框搜手机号或姓名找出特定的人」。
    ///
    /// 钉住三件事:
    /// ① **姓名**走本机名片本, 大小写不敏感, 改名不产生重影;
    /// ② **手机号**形状的查询真的去做了跨机尝试 (`cross_machine_tried`), 但没登记对端时
    ///    **如实不命中** —— 不拿本机目录冒充对端、不把"没对手域"说成"查无此人";
    /// ③ 空查询 = 打开通讯录的全量。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn contacts_search_endpoint_e2e() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-web-contacts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");

        tokio::task::spawn_blocking(move || {
            let get_json = |path: &str| -> serde_json::Value {
                ureq::get(&format!("{base}{path}")).call().unwrap().into_json().unwrap()
            };
            let post_json = |path: &str, body: serde_json::Value| -> serde_json::Value {
                ureq::post(&format!("{base}{path}"))
                    .send_json(body)
                    .unwrap()
                    .into_json()
                    .unwrap()
            };

            // 1) 起手是空的
            let empty = get_json("/api/contacts");
            assert!(empty["items"].as_array().unwrap().is_empty(), "新 home 通讯录为空: {empty}");

            // 2) 存两个备注名
            let a = post_json(
                "/api/contacts/set",
                serde_json::json!({ "did": "did:pi:AAA111", "name": "老李" }),
            );
            assert_eq!(a["ok"], serde_json::json!(true), "{a}");
            post_json(
                "/api/contacts/set",
                serde_json::json!({ "did": "did:pi:BBB222", "name": "Leo" }),
            );

            // 3) 按**姓名**搜 — 大小写不敏感, 且明确不是跨机搜索
            let s1 = post_json("/api/contacts/search", serde_json::json!({ "query": "老李" }));
            assert_eq!(s1["count"], serde_json::json!(1), "{s1}");
            assert_eq!(s1["locals"][0]["did"], serde_json::json!("did:pi:AAA111"));
            assert_eq!(s1["locals"][0]["name"], serde_json::json!("老李"));
            assert_eq!(s1["cross_machine_tried"], serde_json::json!(false), "名字走本机名片本, 不假装跨机: {s1}");

            let s2 = post_json("/api/contacts/search", serde_json::json!({ "query": "leo" }));
            assert_eq!(s2["count"], serde_json::json!(1), "大小写不敏感: {s2}");
            assert_eq!(s2["locals"][0]["did"], serde_json::json!("did:pi:BBB222"));

            // DID 片段也能搜到 (拿半截 DID 找人)
            let s3 = post_json("/api/contacts/search", serde_json::json!({ "query": "AAA111" }));
            assert_eq!(s3["count"], serde_json::json!(1), "{s3}");

            // 4) 按**手机号**搜 — 形状合法 ⇒ 真的去做了跨机尝试; 但**没登记任何对端**
            //    ⇒ 如实不命中, 不拿本机目录冒充对端
            let s4 = post_json(
                "/api/contacts/search",
                serde_json::json!({ "query": "13800001111" }),
            );
            assert_eq!(s4["cross_machine_tried"], serde_json::json!(true), "手机号形状要走跨机: {s4}");
            assert!(s4["directory"].is_null(), "没有对手域就不该有目录命中 — 不冒充: {s4}");

            // 5) 空查询 = 打开通讯录的全量
            let s5 = post_json("/api/contacts/search", serde_json::json!({ "query": "" }));
            assert_eq!(s5["count"], serde_json::json!(2), "{s5}");

            // 6) 改名不产生重影 (同一 DID 只留一条)
            post_json(
                "/api/contacts/set",
                serde_json::json!({ "did": "did:pi:AAA111", "name": "老李叔" }),
            );
            let s6 = post_json("/api/contacts/search", serde_json::json!({ "query": "" }));
            assert_eq!(s6["count"], serde_json::json!(2), "改名而不是新增: {s6}");
            let s7 = post_json("/api/contacts/search", serde_json::json!({ "query": "老李" }));
            assert_eq!(s7["locals"][0]["name"], serde_json::json!("老李叔"), "{s7}");

            // 7) 空名字写得进去就出鬼了 → 拒
            let bad = post_json(
                "/api/contacts/set",
                serde_json::json!({ "did": "did:pi:CCC333", "name": "  " }),
            );
            assert!(bad["error"].as_str().is_some(), "空名字必须拒: {bad}");
        })
        .await
        .unwrap();

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 公共池跨节点：A 的快照在 B 上**验签通过**才计入全网可用；被改一个数字立刻作废。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pool_view_crosses_nodes_only_when_signature_holds() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-pool-x-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("rust")).unwrap();
        std::fs::write(
            home.join("rust").join("config.json"),
            r#"{"version":1,"applied_at":"2026-10-29T00:00:00Z","source":"test","operator":"e2e",
                "reason":"pool cross node","config":{"economic":{"enabled":true,"metering_enabled":true}}}"#,
        )
        .unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        // 两个节点（各自独立身份 = 不同 did）：B 换成一把新钥匙，模拟另一台机器
        let a = AppState::new(offline_llm());
        let mut b = AppState::new(offline_llm());
        b.identity = Arc::new(KeyPair::generate());
        assert_ne!(
            a.identity.did.to_string(),
            b.identity.did.to_string(),
            "两个节点必须是不同身份"
        );
        let la = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let lb = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let (ua, ub) = (
            format!("http://{}", la.local_addr().unwrap()),
            format!("http://{}", lb.local_addr().unwrap()),
        );
        tokio::spawn(async move {
            let _ = serve_on(a, la).await;
        });
        tokio::spawn(async move {
            let _ = serve_on(b, lb).await;
        });

        let (ua2, ub2) = (ua.clone(), ub.clone());
        tokio::task::spawn_blocking(move || {
            // A 先给公共池充 5 美元（已到账），快照才会有非零现金
            let _: serde_json::Value = ureq::post(&format!("{ua2}/api/econ/pool/topup"))
                .send_json(serde_json::json!({ "usd": 5.0, "by": "alice" }))
                .unwrap()
                .into_json()
                .unwrap();

            // B 是空池
            let b_view: serde_json::Value =
                ureq::get(&format!("{ub2}/api/econ/pool/view")).call().unwrap().into_json().unwrap();
            assert_eq!(b_view["local"]["cash_available_usd"], serde_json::json!(0.0));

            // B 拉 A 的快照 ⇒ 验签通过，全网可用 = B(0) + A(5)
            let r: serde_json::Value = ureq::post(&format!("{ub2}/api/econ/pool/peers"))
                .send_json(serde_json::json!({ "url": ua2 }))
                .unwrap()
                .into_json()
                .unwrap();
            assert_eq!(r["verified"], serde_json::json!(true), "签名必须能验过: {r}");

            let after: serde_json::Value =
                ureq::get(&format!("{ub2}/api/econ/pool/view")).call().unwrap().into_json().unwrap();
            assert_eq!(after["peers"].as_array().unwrap().len(), 1);
            assert_eq!(after["network"]["verified_nodes"], serde_json::json!(2));
            assert_eq!(
                after["network"]["cash_available_sum_usd"],
                serde_json::json!(5.0),
                "只求和验签通过的对端: {after}"
            );

            // 篡改一个数字 ⇒ 验签失败，不计钱，但如实留在列表里
            let snap: serde_json::Value = ureq::get(&format!("{ua2}/api/econ/pool/view"))
                .call()
                .unwrap()
                .into_json()
                .unwrap();
            let mut tampered = snap["local"].clone();
            tampered["cash_available_usd"] = serde_json::json!(999999.0);
            let r2: serde_json::Value = ureq::post(&format!("{ub2}/api/econ/pool/peers"))
                .send_json(serde_json::json!({ "peer": tampered }))
                .unwrap()
                .into_json()
                .unwrap();
            assert_eq!(r2["verified"], serde_json::json!(false), "改数字必须验不过: {r2}");
            let after2: serde_json::Value =
                ureq::get(&format!("{ub2}/api/econ/pool/view")).call().unwrap().into_json().unwrap();
            assert_eq!(
                after2["network"]["cash_available_sum_usd"],
                serde_json::json!(0.0),
                "伪造的不许计入: {after2}"
            );
            assert_eq!(after2["network"]["unverified_nodes"], serde_json::json!(1));
        })
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 诚信标识**只给智能体**：人类侧 messages 视图没有 trust、也没有 trust_visible=true。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn trust_badge_is_hidden_from_humans_but_visible_to_agents() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-trust-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("rust")).unwrap();
        std::fs::write(
            home.join("rust").join("config.json"),
            r#"{"version":1,"applied_at":"2026-10-29T00:00:00Z","source":"test","operator":"e2e",
                "reason":"trust visibility","config":{"economic":{"enabled":true,"metering_enabled":true}}}"#,
        )
        .unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");
        tokio::task::spawn_blocking(move || {
            let grp: serde_json::Value = ureq::post(&format!("{base}/api/groups"))
                .send_json(serde_json::json!({ "name": "标识测试群" }))
                .unwrap()
                .into_json()
                .unwrap();
            let gid = grp["id"].as_str().unwrap().to_string();
            let _: serde_json::Value = ureq::post(&format!("{base}/api/groups/{gid}/say"))
                .send_json(serde_json::json!({ "text": "大家好" }))
                .unwrap()
                .into_json()
                .unwrap();

            // 人类视角：没有 trust_visible，也拿不到任何 trust 字段
            let human: serde_json::Value = ureq::get(&format!("{base}/api/groups/{gid}/messages"))
                .call()
                .unwrap()
                .into_json()
                .unwrap();
            assert_eq!(human["trust_visible"], serde_json::json!(false), "{human}");
            for m in human["messages"].as_array().unwrap() {
                assert!(m.get("trust").is_none(), "人类侧不许出现诚信标识: {m}");
            }

            // 智能体视角：标记可见（这条是普通消息，所以只是"视图可见"，不代表有标记）
            let agent: serde_json::Value =
                ureq::get(&format!("{base}/api/groups/{gid}/messages?role=agent"))
                    .call()
                    .unwrap()
                    .into_json()
                    .unwrap();
            assert_eq!(agent["trust_visible"], serde_json::json!(true), "{agent}");
        })
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 共享资源池接口真跑（真 HTTP）：登记供给 → 认捐 → 确认入池 → 给意图挂预算 → 探针可见。
    ///
    /// 判据：① `owner_authorized=false` 的供给可登记但**不可选用**；② 认捐只是承诺，
    /// 确认后公共池才有钱；③ 意图预算挂上后 `limits` 回读一致；④ 探针能看到同一份事实。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn econ_shared_pool_endpoints_e2e() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-econ-shared-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join("rust")).unwrap();
        std::fs::write(
            home.join("rust").join("config.json"),
            r#"{"version":1,"applied_at":"2026-10-29T00:00:00Z","source":"test","operator":"e2e",
                "reason":"共享池 e2e","config":{"economic":{"enabled":true,"metering_enabled":true}}}"#,
        )
        .unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = serve_on(state, listener).await;
        });
        let base = format!("http://{addr}");

        tokio::task::spawn_blocking(move || {
            let get = |p: &str| -> serde_json::Value {
                ureq::get(&format!("{base}{p}")).call().unwrap().into_json().unwrap()
            };
            let post = |p: &str, b: serde_json::Value| -> serde_json::Value {
                ureq::post(&format!("{base}{p}")).send_json(b).unwrap().into_json().unwrap()
            };

            // ① 未授权的供给：登记成功但不可被自动选用
            let r = post(
                "/api/econ/providers",
                serde_json::json!({ "id": "alice-gpu", "kind": "community_model",
                                    "models": [{ "model": "qwen3-27b" }], "owner_authorized": false }),
            );
            assert_eq!(r["ok"], serde_json::json!(true), "{r}");
            assert_eq!(r["selectable"], serde_json::json!(false), "登记 ≠ 授权: {r}");

            // 授权后就进可选用集合
            let r = post(
                "/api/econ/providers",
                serde_json::json!({ "id": "alice-gpu", "kind": "community_model",
                                    "models": [{ "model": "qwen3-27b" }], "owner_authorized": true }),
            );
            assert_eq!(r["selectable"], serde_json::json!(true), "{r}");

            // ② 认捐 → 承诺不进池；确认后进池
            let c = post(
                "/api/econ/contributions",
                serde_json::json!({ "contributor": "alice", "kind": "cash_sponsor", "cash_usd": 5.0 }),
            );
            assert_eq!(c["ok"], serde_json::json!(true), "{c}");
            let cid = c["id"].as_str().unwrap().to_string();
            let probe0 = get("/api/econ/probe");
            assert_eq!(
                probe0["pool"]["contribution_cash_usd"],
                serde_json::json!(0.0),
                "只是承诺，池子里不许有钱: {probe0}"
            );
            let cfg = post(
                &format!("/api/econ/contributions/{cid}/confirm"),
                serde_json::json!({ "by": "bob" }),
            );
            assert_eq!(cfg["ok"], serde_json::json!(true), "{cfg}");
            assert_eq!(
                cfg["pool"]["contribution_cash_usd"],
                serde_json::json!(5.0),
                "确认后入池: {cfg}"
            );

            // 自证无效：alice 不能自己确认自己的贡献
            let c2 = post(
                "/api/econ/contributions",
                serde_json::json!({ "contributor": "carol", "kind": "cash_sponsor", "cash_usd": 1.0 }),
            );
            let cid2 = c2["id"].as_str().unwrap().to_string();
            let self_ok = post(
                &format!("/api/econ/contributions/{cid2}/confirm"),
                serde_json::json!({ "by": "carol" }),
            );
            assert_eq!(self_ok["ok"], serde_json::json!(false), "自己验收自己必须拒: {self_ok}");

            // ③ 意图预算
            let b = post(
                "/api/econ/intent/group:g1:1/budget",
                serde_json::json!({ "max_model_calls": 5, "max_cash_usd": 0.5 }),
            );
            assert_eq!(b["ok"], serde_json::json!(true), "{b}");
            assert_eq!(b["limits"]["max_model_calls"], serde_json::json!(5));
            assert_eq!(b["enforcement"], serde_json::json!(false), "默认 shadow 不拦");

            // ④ 探针能看到同一份事实 + 群聊接话规则
            let probe = get("/api/econ/probe");
            assert_eq!(probe["pool"]["contribution_cash_usd"], serde_json::json!(5.0), "{probe}");
            assert!(probe["providers"].as_array().unwrap().iter().any(|p| p["id"] == "alice-gpu"));
            assert_eq!(probe["group_reply"]["default_when_large"], serde_json::json!(5));

            // ⑤ 接话人数：默认规则 + 警长设定
            let l0 = get("/api/groups/none/reply-limit");
            assert_eq!(l0["reply_limit"], serde_json::json!(0), "空群 0 人");
            // 空群没有可选的内部智能体 ⇒ 没有警长 ⇒ 设置必须被拒（fail-closed，不臆造授权）
            let l1 = post("/api/groups/g1/reply-limit", serde_json::json!({ "n": 7, "by": "sheriff" }));
            assert_eq!(l1["ok"], serde_json::json!(false), "无警长时不许设置: {l1}");
            assert!(
                l1["error"].as_str().unwrap_or("").contains("警长"),
                "拒绝理由必须说清是缺警长: {l1}"
            );
            let l2 = post("/api/groups/g1/reply-limit", serde_json::json!({ "n": 5000 }));
            assert_eq!(l2["ok"], serde_json::json!(false), "超过 1000 上限要拒: {l2}");
        })
        .await
        .unwrap();

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 群聊计量: **一条群消息触发的多个 agent 调用共用一个根意图**，且每次调用一条事件。
    ///
    /// 判据（走真咽喉 `call_model_metered`，不是直接调 econ）：
    /// ① 三个 agent 各调一次 ⇒ 账本 3 条事件，`intent_id` 全同、`agent_id` 各异、`group_id` 同一个；
    /// ② 失败也记（status=failed、token 留空不编），provider/model 如实落盘；
    /// ③ 经济层没挂 ⇒ 一条都不记（关闭态零记录）。
    #[tokio::test]
    async fn group_calls_share_one_root_intent_in_meter() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-econ-group-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        let state = AppState::new(offline_llm());
        // 让 provider 解析走 test 这条（否则会在解析阶段提前返回，根本到不了调用）
        {
            let mut fs = state.forge.lock().await;
            fs.settings.provider = "test".into();
            fs.settings.model = "test-model".into();
        }
        let cfg = bolloon_config::EconomicConfig {
            enabled: true,
            metering_enabled: true,
            ..Default::default()
        };
        let econ = std::sync::Arc::new(bolloon_econ::ShadowEconomy::new(cfg, None));
        assert!(state.econ.set(econ.clone()).is_ok());

        let intent = "group:g1:1700000000000";
        for agent in ["agent-a", "agent-b", "agent-c"] {
            let r = crate::native::call_model_metered(
                &state,
                "你是群成员",
                vec![],
                Some(crate::native::EconCtx {
                    intent_id: intent.to_string(),
                    group_id: Some("g1".into()),
                    agent_id: Some(agent.into()),
                    bill_did: None,
            surface: "web-room".into(),
                }),
            )
            .await;
            assert!(r.is_err(), "假上游必然失败: {r:?}");
        }

        let evs = econ.meter().events_for_intent(intent);
        assert_eq!(evs.len(), 3, "三个 agent 调用 ⇒ 三条事件");
        let mut agents: Vec<String> = evs
            .iter()
            .filter_map(|e| {
                e.evidence
                    .as_ref()?
                    .get("agent_id")?
                    .as_str()
                    .map(str::to_string)
            })
            .collect();
        agents.sort();
        assert_eq!(agents, vec!["agent-a", "agent-b", "agent-c"], "每个 agent 各自一条");
        for e in &evs {
            assert_eq!(e.status, bolloon_econ::MeterStatus::Failed, "失败也要记");
            assert!(e.tokens_in.is_none() && e.tokens_out.is_none(), "失败时 token 不许编 0");
            assert_eq!(e.provider, "test");
            assert_eq!(
                e.evidence.as_ref().and_then(|v| v.get("group_id")).and_then(|v| v.as_str()),
                Some("g1")
            );
            assert_eq!(e.intent_id.as_deref(), Some(intent), "根意图必须共用");
        }
        // 同一条群消息的总花费 = 这条 intent 下所有事件之和（这里没价格表 ⇒ 只有 token 维度）
        assert_eq!(econ.report().by_intent[intent].events, 3);

        // ③ 关闭态：不挂 econ ⇒ 零记录、也不报错
        let state2 = AppState::new(offline_llm());
        {
            let mut fs = state2.forge.lock().await;
            fs.settings.provider = "test".into();
            fs.settings.model = "test-model".into();
        }
        let r = crate::native::call_model_metered(
            &state2,
            "x",
            vec![],
            Some(crate::native::EconCtx {
                intent_id: "group:g1:2".into(),
                group_id: Some("g1".into()),
                agent_id: Some("a".into()),
                bill_did: None,
            surface: "web-room".into(),
            }),
        )
        .await;
        assert!(r.is_err());
        assert!(state2.econ.get().is_none(), "关闭态根本没构造经济层");

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 经济层 shadow 真跑: **默认关闭时零行为**, 打开后只记账不拦不换。
    ///
    /// 判据 (真 HTTP, 不是读代码):
    /// ① 没有 config.json ⇒ `/api/econ/report` 回 `enabled=false` 且账本为空;
    /// ② 写 `{"economic":{"enabled":true}}` 重启服务 ⇒ `enabled=true` / `mode=shadow` /
    ///    `enforcement_enabled=false` (没有显式强制就不许强制);
    /// ③ 报告里不出现任何凭证字段 (密钥不上线)。
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn econ_shadow_mode_is_off_by_default_and_honest_when_on() {
        let _guard = HOME_GUARD.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("bolloon-econ-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        unsafe { std::env::set_var("BOLLOON_HOME", &home) };

        // 起一个服务 (端口 0) 并取一条报告
        async fn report_once(home: &std::path::Path) -> serde_json::Value {
            let _ = home;
            let state = AppState::new(offline_llm());
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let _ = serve_on(state, listener).await;
            });
            tokio::task::spawn_blocking(move || {
                ureq::get(&format!("http://{addr}/api/econ/report"))
                    .call()
                    .unwrap()
                    .into_json::<serde_json::Value>()
                    .unwrap()
            })
            .await
            .unwrap()
        }

        // ① 默认关闭: 报告如实说"没开", 账本是空的 (不是"零成本", 是"没在计量")
        let off = report_once(&home).await;
        assert_eq!(off["enabled"], serde_json::json!(false), "{off}");
        assert_eq!(off["meter"]["events"], serde_json::json!(0), "{off}");
        assert!(off["would_block"].as_array().unwrap().is_empty());
        assert_eq!(
            off["meter"]["unpriced_events"],
            serde_json::json!(0),
            "关闭态不是'零成本', 是'没在计量': {off}"
        );

        // ② 显式打开 (仍默认 shadow): 只记账, 不强制
        // 落盘形状是 **ConfigSnapshot** (version/config/…), 不是裸 AppConfig ——
        // 直接写 AppConfig 会被 load_from_file 判解析失败并静默保持默认。
        std::fs::create_dir_all(home.join("rust")).unwrap();
        std::fs::write(
            home.join("rust").join("config.json"),
            r#"{"version":2,"applied_at":"2026-10-29T00:00:00Z","source":"test",
                "operator":"e2e","reason":"打开经济层 shadow",
                "config":{"economic":{"enabled":true,"metering_enabled":true}}}"#,
        )
        .unwrap();
        let on = report_once(&home).await;
        assert_eq!(on["enabled"], serde_json::json!(true), "{on}");
        assert_eq!(on["mode"], serde_json::json!("shadow"), "{on}");
        assert_eq!(on["metering_enabled"], serde_json::json!(true));
        assert_eq!(
            on["enforcement_enabled"],
            serde_json::json!(false),
            "打开经济层不等于允许强制: {on}"
        );
        assert_eq!(on["settlement_enabled"], serde_json::json!(false));
        assert_eq!(on["price_version"], serde_json::Value::Null, "没价格表就不许编价格");

        // ③ 凭证不上线: 报告里不许出现 key/secret 形状
        let raw = on.to_string().to_lowercase();
        for forbidden in ["api_key", "apikey", "authorization", "sk-", "secret"] {
            assert!(!raw.contains(forbidden), "经济层报告泄漏了 `{forbidden}`: {on}");
        }

        let _ = std::fs::remove_dir_all(&home);
    }
}
