//! 原生 UI 数据面 — Hushfusion Forge 前端期望的全部端点 (像素级复刻的数据面)
//!
//! 端点 (与 hushforge 布局的 index.html 一一对应):
//! - GET  /api/bootstrap      → {state:{agents,sessions,profile,settings,active_agent_id,active_session_id}, update}
//! - POST /api/agents         → 创建智能体 (首个会话同建); POST /api/agents/update
//! - POST /api/sessions       → 新会话; /branch /update /delete /truncate /share
//! - POST /api/profile        → 昵称/头像; POST /api/settings → provider/model/tools
//! - GET  /api/models         → {providers:[{name,display,has_key,default}], write_tools, secret_set}
//! - POST /api/chat → {reply}; POST /api/chat/stream (SSE delta/done); /api/chat/status|stop
//! - GET  /api/room           → {messages,members,groups,state,active_group_id}; /new|start|stop|guide|close
//! - GET  /api/auth/requests  → clarity 授权队列; /api/auth/decide; POST /api/auth/request
//!
//! 诚实边界: chat/stream 为分块 SSE (协议形状与前端一致; 真 token 流待接 LLM 流式);
//! room 交流引擎为消息通路 (多 agent 自动轮流发言待接 LLM); agent DID 为轻量派生 (显示层);
//! room orbitdb 状态 = 本地 oplog (跨机复制待接 BlockExchange 真传输)。

use std::sync::atomic::Ordering;

use axum::extract::{Path as AxumPath, Query, State};
use axum::response::sse::{Event, Sse};
use axum::Json;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use bolloon_llm::{ChatMessage, GenerateParams, LlmRuntime};

use crate::server::{data_dir, AppState, ChatMessageView};

// ────────────────────────── 数据模型 (前端视图形状) ──────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub did: String,
    #[serde(default)]
    pub avatar: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub workspace: String,
    #[serde(default)]
    pub global_dir: String,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiMessage {
    pub role: String, // user | assistant
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<String>,
    pub time: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub streaming: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UiSession {
    pub id: String,
    pub agent_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub messages: Vec<UiMessage>,
    #[serde(default)]
    pub pinned: bool,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[derive(Default)]
pub struct UserProfile {
    pub name: String,
    pub did: String,
    #[serde(default)]
    pub avatar: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct UiSettings {
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub tools: Vec<String>,
}

/// clarity 授权请求 (workspace 外路径; authDlg 形状)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthRequest {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub op: String, // fs | shell
    pub path: String,
    /// 敏感路径不可授权 (系统禁止, 智能体也无法读取)
    pub sensitive: bool,
    pub status: String, // pending | allow_once | allow_project | allow_full | deny
}

pub const WRITE_TOOLS: &[&str] = &["shell", "python.run", "mem", "tasks"];

fn sensitive_path(path: &str) -> bool {
    let p = path.to_lowercase();
    p.starts_with("/etc")
        || p.starts_with("/private/var")
        || p.contains("/.ssh")
        || p.contains("id_rsa")
        || p.contains("id_ed25519")
        || p.starts_with("/system")
}

// ────────────────────────── NativeState (持久化) ──────────────────────────

#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct NativeState {
    pub agents: Vec<AgentView>,
    pub sessions: Vec<UiSession>,
    pub profile: UserProfile,
    pub settings: UiSettings,
    pub auth: Vec<AuthRequest>,
    /// room 运行态 (group_id → running)
    pub room_running: std::collections::HashMap<String, bool>,
    // ── 世界模式 (对齐 TS routes-world: 意图 / 机会流 / 校准环 / 信箱) ──
    /// 意图标签 (世界按意图重打分)
    pub intents: Vec<String>,
    /// 校准环: 忽略的机会 id (同源不再流入)
    pub ignored: Vec<String>,
    /// 已接受的机会 id
    pub accepted: Vec<String>,
    /// 世界信箱 (外部智能体投递的卡片; 置顶)
    pub inbox: Vec<serde_json::Value>,
    // ── 人类目录 (手机号/邮箱盲化 + 跨机查询/加好友) ──
    /// 盲化目录条目 (HMAC; 明文与 pepper 都不在这里)
    pub directory: Vec<bolloon_agent::directory::DirectoryEntry>,
    /// 好友请求簿 (consent 状态机)
    pub friends: bolloon_agent::contacts::FriendBook,
    // ── 做梦机制 (整理记忆与经验 → 升级 skills) ──
    /// 上一次做梦报告 (None = 从没做过)
    pub last_dream: Option<serde_json::Value>,
    /// 写过的梦想文档路径 (历史可查; #[serde(default)] 兼容旧状态文件)
    #[serde(default)]
    pub dreams: Vec<String>,
    pub active_group: String,
    pub next_agent: u64,
    pub next_session: u64,
    pub next_auth: u64,
}

impl NativeState {
    pub fn load(dir: &std::path::Path) -> Self {
        let path = dir.join("native-state.json");
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(s) = serde_json::from_str::<NativeState>(&raw) {
                return s;
            }
        }
        Self {
            profile: UserProfile {
                name: "用户".into(),
                did: String::new(),
                avatar: String::new(),
            },
            ..Default::default()
        }
    }

    pub fn save(&self, dir: &std::path::Path) {
        let path = dir.join("native-state.json");
        if let Ok(raw) = serde_json::to_string_pretty(self) {
            let _ = std::fs::create_dir_all(dir);
            let _ = std::fs::write(path, raw);
        }
    }

    /// 默认头像 (SVG 渐变, 与 hushforge svgAvatar 同形; seed → 色相)
    pub fn svg_avatar(seed: &str) -> String {
        let mut h: u64 = 0;
        for ch in seed.chars() {
            h = (h.wrapping_mul(31).wrapping_add(ch as u64)) % 360;
        }
        let svg = format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96" data-bolloon-avatar="1"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl({h},88%,66%)"/><stop offset="1" stop-color="hsl({},72%,38%)"/></linearGradient><radialGradient id="hh" cx="30%" cy="22%" r="70%"><stop offset="0" stop-color="rgba(255,255,255,.55)"/><stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient></defs><rect width="96" height="96" rx="48" fill="url(#g)"/><circle cx="48" cy="48" r="46" fill="url(#hh)"/><circle cx="70" cy="28" r="12" fill="rgba(255,255,255,.20)"/><path d="M22 68 Q48 42 74 68" stroke="rgba(255,255,255,.40)" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="36" cy="45" r="5" fill="#fff" opacity=".92"/><circle cx="60" cy="45" r="5" fill="#fff" opacity=".92"/></svg>"##,
            (h + 42) % 360
        );
        format!("data:image/svg+xml;utf8,{}", urlencoding_encode(&svg))
    }
}

/// 最小 URL 编码 (encodeURIComponent 子集)
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        let c = *b;
        if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')') {
            out.push(c as char);
        } else {
            out.push_str(&format!("%{c:02X}"));
        }
    }
    out
}

/// pepper 路径 (0600 私密; 对齐 TS ~/.bolloon/contacts/directory-pepper.json)
fn pepper_path() -> std::path::PathBuf {
    data_dir().join("contacts").join("pepper.json")
}

/// 读/生成 pepper (幂等复用; 生成即 0600)
fn load_pepper() -> String {
    let p = pepper_path();
    if let Ok(raw) = std::fs::read_to_string(&p) {
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(pp) = j["pepper"].as_str() {
                return pp.to_string();
            }
        }
    }
    // 生成 (时间+计数 派生的本地随机串; 单节点语义)
    let pepper = format!(
        "pepper-{:016x}{:016x}",
        now_ms(),
        now_ms().wrapping_mul(2654435761)
    );
    let raw = serde_json::json!({ "pepper": pepper }).to_string();
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(std::path::Path::new(".")));
    let _ = std::fs::write(&p, raw.as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
    }
    pepper
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

// ────────────────────────── bootstrap / models / version ──────────────────────────

/// GET /api/bootstrap (前端期望形状)
pub async fn bootstrap_native(State(st): State<AppState>) -> Json<serde_json::Value> {
    // 运行期消息流 (send 写入的那条; 启动时从 sessions/*.jsonl 恢复) — 先取, 不与 forge 锁交错
    let messages: Vec<serde_json::Value> = st
        .messages
        .lock()
        .await
        .iter()
        .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
        .collect();
    let mut fs = st.forge.lock().await;
    if fs.profile.did.is_empty() {
        fs.profile.did = st.identity.did.as_str().to_string();
    }
    if fs.agents.is_empty() {
        // 首启: 内置一个默认智能体 (用户在 UI 里可再建)
        fs.next_agent += 1;
        let id = format!("agent-{:03}", fs.next_agent);
        fs.agents.push(AgentView {
            id: id.clone(),
            name: "Bolloon 智能体".into(),
            did: st.identity.did.as_str().into(),
            avatar: NativeState::svg_avatar(&id),
            persona: String::new(),
            workspace: String::new(),
            global_dir: String::new(),
            created_at_ms: now_ms(),
        });
        fs.next_session += 1;
        let sid = format!("sess-{:04}", fs.next_session);
        fs.sessions.push(UiSession {
            id: sid,
            agent_id: id,
            title: "新对话".into(),
            messages: vec![],
            pinned: false,
            created_at_ms: now_ms(),
        });
    }
    let update = native_update_info(&st);
    let payload = serde_json::json!({
        "state": {
            "agents": fs.agents,
            "sessions": fs.sessions,
            "profile": fs.profile,
            "settings": fs.settings,
            "active_agent_id": fs.agents.first().map(|a| a.id.clone()).unwrap_or_default(),
            "active_session_id": fs.sessions.first().map(|s| s.id.clone()).unwrap_or_default(),
            "did": st.identity.did.as_str(),
            "edge": false,
            "messages": messages,
        },
        "update": update,
        "version": st.version,
    });
    fs.save(&data_dir());
    drop(fs);
    Json(payload)
}

fn native_update_info(st: &AppState) -> serde_json::Value {
    struct Src;
    impl bolloon_agent::updater::UpdateSource for Src {
        fn latest_version(&self) -> Result<String, String> {
            let body: serde_json::Value = ureq::get(
                "https://api.github.com/repos/logos-42/bolloon/releases/latest",
            )
            .timeout(std::time::Duration::from_secs(5))
            .set("User-Agent", "bolloon-updater")
            .call()
            .map_err(|e| e.to_string())?
            .into_json()
            .map_err(|e| e.to_string())?;
            body["tag_name"].as_str().map(|s| s.to_string()).ok_or_else(|| "无 tag".into())
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            Err("install 走 install()".into())
        }
    }
    // 当前版本取运行时值 (服务端 st.version), 不与编译期常量脱钩 ⇒ 不会比错版本
    let info = bolloon_agent::updater::check_with(&Src, st.version);
    serde_json::json!({
        "available": info.update_available,
        "latest": info.latest,
        "current": info.current,
    })
}

/// GET /api/version (重启等待轮询)
pub async fn version(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "version": st.version }))
}

/// GET /api/models (前端形状) — **全量 200+ 家** (内置 13 + 目录 + 自定义)
pub async fn models(State(st): State<AppState>) -> Json<serde_json::Value> {
    let cfg = bolloon_llm::config_store::load();
    let settings = {
        let fs = st.forge.lock().await;
        fs.settings.clone()
    };
    let active = if settings.provider.trim().is_empty() {
        cfg.active_provider.clone()
    } else {
        settings.provider.clone()
    };
    let providers = provider_rows(&cfg);
    // 已经存过 key 的家 (界面用来显示"留空不修改")
    let secret_set: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .filter(|(_, s)| !s.api_key.trim().is_empty())
        .map(|(id, _)| (id.clone(), serde_json::json!(true)))
        .collect();
    Json(serde_json::json!({
        "providers": providers,
        "count": providers.len(),
        "active": active,
        "active_model": settings.model,
        "write_tools": WRITE_TOOLS,
        "secret_set": secret_set,
    }))
}

/// 注册表 → 前端可选列表（每家带来源/协议/有无线索/模型数；自定义家排最前）
pub(crate) fn provider_rows(cfg: &bolloon_llm::LlmConfig) -> Vec<serde_json::Value> {
    let mut out: Vec<serde_json::Value> = cfg
        .custom_providers
        .values()
        .map(|c| {
            serde_json::json!({
                "name": c.provider_id,
                "display": if c.display_name.is_empty() { c.provider_id.clone() } else { c.display_name.clone() },
                "default": c.model,
                "has_key": !c.api_key.trim().is_empty(),
                "origin": "custom",
                "protocol": c.protocol.unwrap_or_else(|| bolloon_llm::Protocol::infer_from_base_url(&c.base_url)).as_str(),
                "models_count": c.models.len(),
                "requires_key": true,
                "selectable": true,
                "base_url": c.base_url,
                "note": "自定义 provider (自己填的 base_url/协议)",
            })
        })
        .collect();
    let catalog_rows: Vec<serde_json::Value> = bolloon_llm::list_with_catalog()
        .into_iter()
        .map(|e| {
            let has_key = !e.requires_api_key
                || bolloon_llm::config_store::key_of(cfg, &e).is_some();
            let model = cfg
                .providers
                .get(&e.id)
                .map(|s| s.model.clone())
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| e.default_model.clone());
            serde_json::json!({
                "name": e.id,
                "display": e.display_name,
                "default": model,
                "has_key": has_key,
                "origin": e.origin.as_str(),
                "protocol": e.protocol.as_str(),
                "models_count": e.models.len(),
                "requires_key": e.requires_api_key,
                "selectable": e.selectable(),
                "base_url": e.default_base_url,
                "note": e.auth_note,
            })
        })
        .collect();
    out.extend(catalog_rows);
    out
}

/// GET /api/models/options?provider=<id> → 这家的可选模型（目录声明的清单 + 默认模型）
pub async fn models_options(
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let id = q.get("provider").map(|s| s.trim().to_string()).unwrap_or_default();
    if id.is_empty() {
        return Json(serde_json::json!({ "error": "缺少 provider" }));
    }
    // 自定义家 → 用它自己填的模型清单；其余走注册表（内置已挂目录模型）
    if let Some(custom) = bolloon_llm::config_store::load().custom_providers.get(&id) {
        let models: Vec<serde_json::Value> = custom
            .models
            .iter()
            .map(|m| serde_json::json!({ "id": m, "name": m }))
            .collect();
        return Json(serde_json::json!({
            "provider": id,
            "display": custom.display_name,
            "default": custom.model,
            "models": models,
            "count": models.len(),
            "note": "自定义 provider",
        }));
    }
    let Some(entry) = bolloon_llm::provider_registry::get(&id) else {
        return Json(serde_json::json!({ "provider": id, "models": [], "count": 0 }));
    };
    let models: Vec<serde_json::Value> = entry
        .models
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "name": m.name,
                "tool_calling": m.tool_calling,
                "reasoning": m.reasoning,
                "context_length": m.context_length,
            })
        })
        .collect();
    Json(serde_json::json!({
        "provider": entry.id,
        "display": entry.display_name,
        "protocol": entry.protocol.as_str(),
        "default": entry.default_model,
        "models": models,
        "count": models.len(),
        "note": entry.auth_note,
    }))
}

/// POST /api/models/select — 选一家/一个模型（可顺带存 key、改 base_url）
pub async fn models_select(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["provider"].as_str().unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺少 provider" }));
    }
    let model = req["model"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let api_key = req["api_key"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let base_url = req["base_url"].as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    let mut cfg = bolloon_llm::config_store::load();
    // 目录/内置里没有的家 → 当**自定义 provider** 建（自定义必须有 base_url）
    if bolloon_llm::provider_registry::get(&id).is_none() {
        let Some(base) = base_url.clone() else {
            return Json(serde_json::json!({
                "ok": false,
                "error": format!("{id} 不在目录里 — 自定义 provider 必须给 base_url"),
            }));
        };
        bolloon_llm::config_store::upsert_custom(
            &mut cfg,
            &id,
            &id,
            &base,
            None,
            api_key.as_deref(),
            model.as_deref(),
        );
    }
    bolloon_llm::config_store::apply_provider(
        &mut cfg,
        &id,
        api_key.as_deref(),
        base_url.as_deref(),
        model.as_deref(),
    );
    if let Err(e) = bolloon_llm::config_store::save(&cfg) {
        return Json(serde_json::json!({ "ok": false, "error": format!("配置写盘失败: {e}") }));
    }
    // UI 设置与配置保持一致（前端据此显示当前 provider/model）
    {
        let mut fs = st.forge.lock().await;
        fs.settings.provider = id.clone();
        if let Some(m) = &model {
            fs.settings.model = m.clone();
        } else if let Ok(r) = bolloon_llm::config_store::resolve(&cfg, &id) {
            fs.settings.model = r.model.clone();
        }
        fs.save(&data_dir());
    }
    st.reload_llm().await;

    match bolloon_llm::config_store::resolve(&cfg, &id) {
        Ok(r) => Json(serde_json::json!({
            "ok": true,
            "provider": r.id,
            "model": r.model,
            "protocol": r.protocol.as_str(),
            "base_url": r.base_url,
            "auth": r.auth_ref(), // 只回 authRef, 不回 key
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "provider": id, "error": e })),
    }
}

/// POST /api/models/test — 真发一条最小请求验证「这家 + 这个 key + 这个模型」通不通
pub async fn models_test(
    State(_st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["provider"].as_str().unwrap_or_default().trim().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺少 provider" }));
    }
    let mut cfg = bolloon_llm::config_store::load();
    // 允许"边填边测": 请求里的 key/base/model 覆盖磁盘配置 (不写盘)
    bolloon_llm::config_store::apply_provider(
        &mut cfg,
        &id,
        req["api_key"].as_str().filter(|s| !s.trim().is_empty()),
        req["base_url"].as_str().filter(|s| !s.trim().is_empty()),
        req["model"].as_str().filter(|s| !s.trim().is_empty()),
    );
    let r = match bolloon_llm::config_store::resolve(&cfg, &id) {
        Ok(r) => r,
        Err(e) => return Json(serde_json::json!({ "ok": false, "provider": id, "error": e })),
    };

    let mut rt = LlmRuntime::new(vec![], 1);
    rt.add_resolved(&r);
    let mut params = GenerateParams::new(
        r.model.clone(),
        vec![ChatMessage {
            role: "user".into(),
            content: "ping".into(),
            name: None,
            tool_call_id: None,
            tool_calls: None,
            images: vec![],
        }],
    );
    params.max_tokens = 8;
    params.temperature = 0.0;
    let started = std::time::Instant::now();
    match rt.generate(&r.id, params).await {
        Ok(g) => Json(serde_json::json!({
            "ok": true,
            "provider": r.id,
            "model": r.model,
            "protocol": r.protocol.as_str(),
            "auth": r.auth_ref(),
            "ms": started.elapsed().as_millis() as u64,
            "sample": g.content.chars().take(60).collect::<String>(),
        })),
        Err(e) => Json(serde_json::json!({
            "ok": false,
            "provider": r.id,
            "model": r.model,
            "protocol": r.protocol.as_str(),
            "ms": started.elapsed().as_millis() as u64,
            "error": e.to_string(),
        })),
    }
}

// ────────────────────────── agents ──────────────────────────

/// POST /api/agents (创建; 首个会话同建)
pub async fn create_agent(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    fs.next_agent += 1;
    let id = format!("agent-{:03}", fs.next_agent);
    let name = req["name"].as_str().unwrap_or("智能体").to_string();
    let did = {
        use sha2::Digest;
        let d = sha2::Sha256::digest(id.as_bytes());
        format!("did:pi:{}", bolloon_p2p::b58_encode(&d[..20]))
    };
    let avatar = req["avatar"]
        .as_str()
        .map(|s| s.to_string())
        .unwrap_or_else(|| NativeState::svg_avatar(&format!("{name}{id}")));
    let agent = AgentView {
        id: id.clone(),
        name,
        did,
        avatar,
        persona: req["persona"].as_str().unwrap_or_default().into(),
        workspace: req["workspace"].as_str().unwrap_or_default().into(),
        global_dir: req["global_dir"].as_str().unwrap_or_default().into(),
        created_at_ms: now_ms(),
    };
    fs.next_session += 1;
    let session = UiSession {
        id: format!("sess-{:04}", fs.next_session),
        agent_id: id.clone(),
        title: "新对话".into(),
        messages: vec![],
        pinned: false,
        created_at_ms: now_ms(),
    };
    fs.agents.push(agent.clone());
    fs.sessions.push(session.clone());
    fs.save(&data_dir());
    Json(serde_json::json!({ "agent": agent, "session": session }))
}

/// POST /api/agents/update
pub async fn update_agent(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let Some(a) = fs.agents.iter_mut().find(|a| a.id == id) else {
        return Json(serde_json::json!({ "error": "智能体不存在" }));
    };
    if let Some(v) = req["name"].as_str() {
        a.name = v.into();
    }
    if let Some(v) = req["avatar"].as_str() {
        a.avatar = v.into();
    }
    if let Some(v) = req["persona"].as_str() {
        a.persona = v.into();
    }
    if let Some(v) = req["workspace"].as_str() {
        a.workspace = v.into();
    }
    if let Some(v) = req["global_dir"].as_str() {
        a.global_dir = v.into();
    }
    let a = a.clone();
    fs.save(&data_dir());
    Json(serde_json::to_value(a).unwrap())
}

// ────────────────────────── sessions ──────────────────────────

/// POST /api/sessions (新会话)
pub async fn create_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let agent_id = req["agent_id"].as_str().unwrap_or_default().to_string();
    fs.next_session += 1;
    let s = UiSession {
        id: format!("sess-{:04}", fs.next_session),
        agent_id,
        title: "新对话".into(),
        messages: vec![],
        pinned: false,
        created_at_ms: now_ms(),
    };
    fs.sessions.push(s.clone());
    fs.save(&data_dir());
    Json(serde_json::to_value(s).unwrap())
}

/// POST /api/sessions/branch (从某条消息分叉)
pub async fn branch_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let sid = req["session_id"].as_str().unwrap_or_default();
    let idx = req["message_index"].as_u64().unwrap_or(0) as usize;
    let Some(src) = fs.sessions.iter().find(|s| s.id == sid).cloned() else {
        return Json(serde_json::json!({ "error": "会话不存在" }));
    };
    let mut ns = src.clone();
    fs.next_session += 1;
    ns.id = format!("sess-{:04}", fs.next_session);
    ns.title = format!("{} (分支)", src.title);
    ns.messages = src.messages.iter().take(idx + 1).cloned().collect();
    ns.pinned = false;
    fs.sessions.push(ns.clone());
    fs.save(&data_dir());
    Json(serde_json::to_value(ns).unwrap())
}

/// POST /api/sessions/update (重命名/置顶)
pub async fn update_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let Some(s) = fs.sessions.iter_mut().find(|s| s.id == id) else {
        return Json(serde_json::json!({ "error": "会话不存在" }));
    };
    if let Some(t) = req["title"].as_str() {
        s.title = t.into();
    }
    if let Some(p) = req["pinned"].as_bool() {
        s.pinned = p;
    }
    let s = s.clone();
    fs.save(&data_dir());
    Json(serde_json::to_value(s).unwrap())
}

/// POST /api/sessions/delete
pub async fn delete_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let id = req["id"].as_str().unwrap_or_default().to_string();
    fs.sessions.retain(|s| s.id != id);
    let active = fs.sessions.first().map(|s| s.id.clone()).unwrap_or_default();
    fs.save(&data_dir());
    Json(serde_json::json!({ "active_session_id": active }))
}

/// POST /api/sessions/truncate (编辑已发消息: 截断后重发)
pub async fn truncate_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let from = req["from_index"].as_u64().unwrap_or(0) as usize;
    if let Some(s) = fs.sessions.iter_mut().find(|s| s.id == id) {
        s.messages.truncate(from);
    }
    fs.save(&data_dir());
    Json(serde_json::json!({ "ok": true }))
}

/// POST /api/sessions/share → 真生成分享快照 (返回的链接能打开, 不是死链)
pub async fn share_session(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    if id.is_empty() {
        return Json(serde_json::json!({ "error": "缺少会话 id" }));
    }
    let session = {
        let fs = st.forge.lock().await;
        fs.sessions.iter().find(|s| s.id == id).cloned()
    };
    let Some(session) = session else {
        return Json(serde_json::json!({ "error": format!("会话不存在: {id}") }));
    };
    let now = now_ms();
    let token = share_token(&st, &id, now);
    let snapshot = serde_json::json!({
        "token": token,
        "session_id": session.id,
        "title": session.title,
        "agent_id": session.agent_id,
        "by_did": st.identity.did.as_str(),
        "shared_at_ms": now,
        "messages": session.messages,
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
        "url": format!("/share/{token}"),
        "token": token,
        "messages": session.messages.len(),
    }))
}

/// 分享 token = 身份私钥对 (会话|时间) 签名取前 24 hex ⇒ 不可猜 (不依赖随机源)
fn share_token(st: &AppState, session_id: &str, now: u64) -> String {
    let sig = st.identity.sign(format!("share|{session_id}|{now}").as_bytes());
    sig.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

/// 读分享快照 (只认 hex token, 拒路径穿越; 不存在/坏文件 → None, 不冒充)
fn load_share_in(dir: &std::path::Path, token: &str) -> Option<serde_json::Value> {
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let raw = std::fs::read_to_string(dir.join("shares").join(format!("{token}.json"))).ok()?;
    serde_json::from_str(&raw).ok()
}

fn load_share(token: &str) -> Option<serde_json::Value> {
    load_share_in(&data_dir(), token)
}

/// GET /api/share/{token} → 分享快照 (JSON)
pub async fn share_json(AxumPath(token): AxumPath<String>) -> Json<serde_json::Value> {
    match load_share(&token) {
        Some(v) => Json(v),
        None => Json(serde_json::json!({ "error": "分享不存在或已失效" })),
    }
}

/// GET /share/{token} → 只读分享页 (全部内容 HTML 转义, 不执行任何脚本)
pub async fn share_page(AxumPath(token): AxumPath<String>) -> axum::response::Html<String> {
    let Some(v) = load_share(&token) else {
        return axum::response::Html(
            "<!doctype html><meta charset=\"utf-8\"><title>分享不存在</title>\
             <p style=\"font-family:system-ui;padding:24px\">分享不存在或已失效。</p>"
                .to_string(),
        );
    };
    let title = html_escape(v["title"].as_str().unwrap_or("会话分享"));
    let did = html_escape(v["by_did"].as_str().unwrap_or(""));
    let rows: String = v["messages"]
        .as_array()
        .map(|ms| {
            ms.iter()
                .map(|m| {
                    let role = if m["role"].as_str() == Some("user") { "我" } else { "智能体" };
                    let text = html_escape(m["text"].as_str().unwrap_or(""));
                    let time = html_escape(m["time"].as_str().unwrap_or(""));
                    format!(
                        "<div class=\"m\"><div class=\"h\">{role} · {time}</div><div class=\"t\">{text}</div></div>"
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let count = v["messages"].as_array().map(|a| a.len()).unwrap_or(0);
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title} · 分享</title>\
         <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
         <style>body{{font-family:system-ui;max-width:760px;margin:0 auto;padding:24px;\
         background:#1a1a18;color:#eee}}.m{{border-left:2px solid #c4d640;padding:4px 12px;margin:12px 0}}\
         .h{{font-size:12px;opacity:.6}}.t{{white-space:pre-wrap;line-height:1.6}}\
         footer{{opacity:.5;font-size:12px;margin-top:32px}}</style>\
         <h1>{title}</h1><div style=\"opacity:.6;font-size:12px\">{count} 条消息 · {did}</div>\
         {rows}<footer>Bolloon 会话分享 (只读快照)</footer>"
    );
    axum::response::Html(page)
}

/// HTML 转义 (分享页唯一出口; 内容一律转义, 不拼未过滤文本)
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

// ────────────────────────── profile / settings ──────────────────────────

/// POST /api/profile
pub async fn set_profile(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    if let Some(n) = req["name"].as_str() {
        fs.profile.name = n.into();
    }
    if let Some(a) = req["avatar"].as_str() {
        fs.profile.avatar = a.into();
    }
    let p = fs.profile.clone();
    fs.save(&data_dir());
    Json(serde_json::to_value(p).unwrap())
}

/// POST /api/settings
pub async fn set_settings(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    if let Some(p) = req["provider"].as_str() {
        fs.settings.provider = p.into();
    }
    if let Some(m) = req["model"].as_str() {
        fs.settings.model = m.into();
    }
    if let Some(t) = req["tools"].as_array() {
        fs.settings.tools = t
            .iter()
            .filter_map(|x| x.as_str().map(|s| s.into()))
            .collect();
    }
    let s = fs.settings.clone();
    fs.save(&data_dir());
    drop(fs); // 下面 reload_llm 也要拿 forge 锁

    // provider/model/key/base_url 落到**跨端同一份**配置 (~/.bolloon/bolloon-config.json, 0600)
    if !s.provider.trim().is_empty() {
        let mut cfg = bolloon_llm::config_store::load();
        bolloon_llm::config_store::apply_provider(
            &mut cfg,
            s.provider.trim(),
            req["api_key"].as_str().filter(|k| !k.trim().is_empty()),
            req["base_url"].as_str().filter(|b| !b.trim().is_empty()),
            if s.model.trim().is_empty() { None } else { Some(s.model.trim()) },
        );
        let _ = bolloon_llm::config_store::save(&cfg);
    }
    // key 变了 → 模型通路立刻重建 (不用重启 web)
    st.reload_llm().await;
    Json(serde_json::to_value(s).unwrap())
}

// ────────────────────────── chat (SSE 形状) ──────────────────────────

/// web 对话的系统提示词（薄层：身份 + 纪律；工具循环在 CLI/agent 那边）
const WEB_SYSTEM_PROMPT: &str = "你是 Bolloon 智能体，运行在去中心化智能体资源交流网络中。\
回答用中文，简洁、有依据；不确定就说不确定，不编造事实。";

/// **真模型调用**（web 对话唯一出口）
/// provider 选取顺序: UI 选中 → 配置 activeProvider → runtime 里第一家可用
pub async fn reply_with_model(st: &AppState, text: &str) -> Result<String, String> {
    let (ui_provider, ui_model) = {
        let fs = st.forge.lock().await;
        (
            fs.settings.provider.trim().to_string(),
            fs.settings.model.trim().to_string(),
        )
    };
    let cfg = bolloon_llm::config_store::load();
    let wanted = if !ui_provider.is_empty() {
        ui_provider
    } else if !cfg.active_provider.trim().is_empty() {
        cfg.active_provider.trim().to_string()
    } else {
        String::new()
    };

    let mut llm = st.llm_snapshot();
    // UI 选的家可能还没进 runtime（刚填的 key/模型）→ 重建一次再取
    if !wanted.is_empty() && llm.provider(&wanted).is_none() {
        st.reload_llm().await;
        llm = st.llm_snapshot();
    }
    let provider_id = if wanted.is_empty() {
        llm.provider_ids().into_iter().next().ok_or_else(|| {
            "还没有可用的模型供应商 — 点右上角模型/「选择模型」选一家并填 API Key \
             （内置 13 家 + 目录 200+ 家）; 也可以用 BOLLOON_API_KEY 环境变量"
                .to_string()
        })?
    } else {
        wanted
    };

    if llm.provider(&provider_id).is_none() {
        // 解析一次，给出**准确原因**（缺 key / 缺模型 / 缺基址）
        return Err(bolloon_llm::config_store::resolve(&cfg, &provider_id)
            .err()
            .unwrap_or_else(|| format!("{provider_id} 没装进模型通路 — 检查 provider 名称")));
    }

    let model = if !ui_model.is_empty() {
        ui_model
    } else {
        llm.provider(&provider_id)
            .map(|p| p.default_model.clone())
            .unwrap_or_default()
    };
    if model.trim().is_empty() {
        return Err(format!("{provider_id} 还没选模型 — 在「选择模型」里填一个模型名"));
    }

    // 上下文: 最近 12 条 + 当前这句
    let mut messages = vec![ChatMessage {
        role: "system".into(),
        content: WEB_SYSTEM_PROMPT.into(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: vec![],
    }];
    {
        let msgs = st.messages.lock().await;
        let start = msgs.len().saturating_sub(12);
        let last = msgs.len().saturating_sub(1);
        for (i, m) in msgs[start..].iter().enumerate() {
            let idx = start + i;
            let role = if m.role == "assistant" { "assistant" } else { "user" };
            // 调用方（/api/send）可能已经把本轮用户输入写进历史 → 去重，避免同一句发两遍
            if idx == last && role == "user" && m.content == text {
                continue;
            }
            messages.push(ChatMessage {
                role: role.into(),
                content: m.content.clone(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
                images: vec![],
            });
        }
    }
    messages.push(ChatMessage {
        role: "user".into(),
        content: text.to_string(),
        name: None,
        tool_call_id: None,
        tool_calls: None,
        images: vec![],
    });

    let mut params = GenerateParams::new(model, messages);
    params.temperature = 0.7;
    params.max_tokens = 4096;
    llm.generate(&provider_id, params)
        .await
        .map(|g| g.content)
        .map_err(|e| format!("模型调用失败（{provider_id}）: {e}"))
}

/// 记一轮对话（历史要能被下一轮读到）
async fn remember_turn(st: &AppState, text: &str, reply: &str) {
    let mut msgs = st.messages.lock().await;
    msgs.push(ChatMessageView { role: "user".into(), content: text.to_string() });
    msgs.push(ChatMessageView { role: "assistant".into(), content: reply.to_string() });
    let _ = st
        .session_store
        .append(&bolloon_agent::SessionEvent::User { text: text.to_string() });
    let _ = st
        .session_store
        .append(&bolloon_agent::SessionEvent::Assistant { text: reply.to_string() });
}

/// POST /api/chat → {reply} (非流式降级)
pub async fn chat(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let text = req["message"].as_str().unwrap_or_default().to_string();
    let reply = match reply_with_model(&st, &text).await {
        Ok(r) => r,
        Err(e) => e, // 错误也是"回答"：界面要能看到到底缺什么
    };
    if !reply.is_empty() {
        remember_turn(&st, &text, &reply).await;
    }
    Json(serde_json::json!({ "reply": reply }))
}

/// POST /api/chat/stream (SSE; 前端 streamChat 协议: event delta/done)
pub async fn chat_stream(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> impl axum::response::IntoResponse {
    let text = req["message"].as_str().unwrap_or_default().to_string();
    let reply = match reply_with_model(&st, &text).await {
        Ok(r) => r,
        Err(e) => e,
    };
    if !reply.is_empty() {
        remember_turn(&st, &text, &reply).await;
    }
    let chunks: Vec<String> = {
        let chars: Vec<char> = reply.chars().collect();
        chars.chunks(24).map(|c| c.iter().collect()).collect()
    };
    let full = reply.clone();
    let stream = futures::stream::iter(
        chunks
            .into_iter()
            .map(|chunk| {
                Ok::<_, std::convert::Infallible>(Event::default()
                    .event("delta")
                    .data(serde_json::json!({ "text": chunk }).to_string()))
            })
            .collect::<Vec<_>>(),
    )
    .chain(futures::stream::once(async move {
        Ok::<_, std::convert::Infallible>(
            Event::default().event("done").data(serde_json::json!({ "reply": full }).to_string()),
        )
    }));
    Sse::new(stream)
}

/// GET /api/chat/status (前端 resumeRunning 轮询)
pub async fn chat_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "running": false, "text": "" }))
}

/// POST /api/chat/stop
pub async fn chat_stop() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true }))
}

// ────────────────────────── room (群聊兼容层) ──────────────────────────

/// GET /api/room → {messages, members, groups, state, active_group_id}
pub async fn room(State(st): State<AppState>) -> Json<serde_json::Value> {
    let groups = st.groups.list_groups().await;
    let active = {
        let fs = st.forge.lock().await;
        if fs.active_group.is_empty() {
            groups.first().map(|g| g.id.clone()).unwrap_or_default()
        } else {
            fs.active_group.clone()
        }
    };
    let entries = st.groups.read(&active, 0, 200).await;
    let running = st
        .forge
        .lock()
        .await
        .room_running
        .get(&active)
        .copied()
        .unwrap_or(false);
    let msgs: Vec<serde_json::Value> = entries
        .iter()
        .map(|m| {
            serde_json::json!({
                "agent_id": m.sender.as_str(),
                "agent_name": m.sender.as_str(),
                "kind": "discuss",
                "text": m.content,
                "created_at": m.timestamp.to_rfc3339(),
            })
        })
        .collect();
    let members: Vec<serde_json::Value> = st
        .forge
        .lock()
        .await
        .agents
        .iter()
        .map(|a| {
            serde_json::json!({
                "agent_id": a.id, "agent_name": a.name,
                "status": if running { "thinking" } else { "idle" },
            })
        })
        .collect();
    let group_views: Vec<serde_json::Value> = groups
        .iter()
        .map(|g| serde_json::json!({ "id": g.id, "topic": g.name, "running": running }))
        .collect();
    Json(serde_json::json!({
        "messages": msgs,
        "members": members,
        "groups": group_views,
        "state": { "running": running, "turn": 0, "max_turns": 0, "topic": "", "participants": [] },
        "active_group_id": active,
        "orbit_status": "local-oplog",
        "channel": "orbitdb",
    }))
}

/// POST /api/room/new (新建群组)
pub async fn room_new(State(st): State<AppState>) -> Json<serde_json::Value> {
    let id = format!("gw-{:x}", now_ms() % 0xffff_ffff);
    let info = st
        .groups
        .create_group(id.clone(), format!("群组 {}", now_ms() % 10_000), st.identity.did.clone(), bolloon_p2p::GroupAcl::Open)
        .await;
    st.forge.lock().await.active_group = info.id.clone();
    Json(serde_json::json!({ "id": info.id }))
}

/// POST /api/room/start
pub async fn room_start(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let gid = req["group_id"].as_str().unwrap_or_default().to_string();
    st.forge.lock().await.room_running.insert(gid.clone(), true);
    Json(serde_json::json!({ "ok": true, "group_id": gid }))
}

/// POST /api/room/stop
pub async fn room_stop(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let gid = req["group_id"].as_str().unwrap_or_default().to_string();
    st.forge.lock().await.room_running.insert(gid.clone(), false);
    Json(serde_json::json!({ "ok": true }))
}

/// POST /api/room/close
pub async fn room_close(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let gid = req["group_id"].as_str().unwrap_or_default().to_string();
    let mut fs = st.forge.lock().await;
    fs.room_running.remove(&gid);
    fs.active_group = String::new();
    Json(serde_json::json!({ "active_group_id": "" }))
}

/// POST /api/room/guide (discuss/guide 消息; /guide = 全体强引导)
pub async fn room_guide(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let gid = req["group_id"].as_str().unwrap_or_default().to_string();
    let text = req["text"].as_str().unwrap_or_default().to_string();
    let kind = req["kind"].as_str().unwrap_or("discuss").to_string();
    let entry_kind = if kind == "guide" {
        bolloon_p2p::EntryKind::Guide
    } else {
        bolloon_p2p::EntryKind::Message
    };
    let prefix = if kind == "guide" { "/guide " } else { "" };
    let sig = st.identity.sign(format!("{prefix}{text}").as_bytes());
    match st
        .groups
        .append(
            &gid,
            &st.identity.did.clone(),
            entry_kind,
            format!("{prefix}{text}"),
            bolloon_p2p::b58_encode(&sig),
        )
        .await
    {
        Ok(m) => Json(serde_json::json!({ "seq": m.seq, "kind": kind })),
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

// ────────────────────────── clarity 授权队列 ──────────────────────────

/// POST /api/auth/request (工具/workspace 门产生授权请求)
pub async fn auth_request(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    fs.next_auth += 1;
    let path = req["path"].as_str().unwrap_or_default().to_string();
    let sensitive = sensitive_path(&path);
    // 完全访问模式: 非敏感路径的请求直接放行 (所有门/白名单不拦 agent);
    // 敏感路径仍是系统硬边界, 任何决策都不可授权。
    let full = st.full_access.load(Ordering::SeqCst);
    let status = if full && !sensitive { "allow_full".into() } else { "pending".into() };
    let r = AuthRequest {
        id: format!("auth-{:04}", fs.next_auth),
        agent_id: req["agent_id"].as_str().unwrap_or("agent").into(),
        agent_name: req["agent_name"].as_str().unwrap_or("智能体").into(),
        op: req["op"].as_str().unwrap_or("fs").into(),
        sensitive,
        path,
        status,
    };
    fs.auth.push(r.clone());
    Json(serde_json::to_value(r).unwrap())
}

/// GET /api/auth/requests (pending 列表)
pub async fn auth_requests(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    let pending: Vec<&AuthRequest> = fs.auth.iter().filter(|r| r.status == "pending").collect();
    Json(serde_json::json!({ "requests": pending }))
}

/// POST /api/auth/decide (仅一次/本项目/完全访问/拒绝; 敏感路径 allow_* 拒)
pub async fn auth_decide(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let decision = req["decision"].as_str().unwrap_or("deny").to_string();
    let mut fs = st.forge.lock().await;
    let Some(r) = fs.auth.iter_mut().find(|r| r.id == id) else {
        return Json(serde_json::json!({ "error": "请求不存在" }));
    };
    if r.sensitive && decision != "deny" {
        return Json(serde_json::json!({ "error": "敏感路径不可授权" }));
    }
    r.status = decision.clone();
    if decision == "allow_full" {
        st.full_access.store(true, Ordering::SeqCst);
    }
    Json(serde_json::json!({ "ok": true, "status": r.status }))
}

// ────────────────────────── 更新 (前端 /api/update + apply) ──────────────────────────

/// GET /api/update → {available,latest,current} (前端 updateBtn 读)
pub async fn update(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(native_update_info(&st))
}

/// POST /api/update/apply → 内部安装一条龙 + spawn 新进程 (旧进程随后退出)
pub async fn update_apply(State(st): State<AppState>) -> Json<serde_json::Value> {
    // 安装互斥: 同一二进制只允许一条安装流程 (两个请求同时替换会把自己装残)
    if st
        .updating
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Json(serde_json::json!({
            "busy": true,
            "installing": true,
            "message": "安装中 — 不重复下载替换",
        }));
    }
    struct Src;
    impl bolloon_agent::updater::UpdateSource for Src {
        fn latest_version(&self) -> Result<String, String> {
            Ok("latest".into())
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            let bytes = ureq::get(
                "https://github.com/logos-42/bolloon/releases/latest/download/bolloon-bin",
            )
            .timeout(std::time::Duration::from_secs(120))
            .call()
            .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            use std::io::Read;
            bytes.into_reader().read_to_end(&mut out).map_err(|e| e.to_string())?;
            Ok(out)
        }
    }
    let Ok(self_path) = std::env::current_exe() else {
        st.updating.store(false, Ordering::SeqCst); // 没开始装 → 放行后续重试
        return Json(serde_json::json!({ "error": "无法定位自身二进制" }));
    };
    match bolloon_agent::updater::install(&Src, &self_path) {
        Ok(report) => {
            let args: Vec<String> = std::env::args().skip(1).collect();
            let new_pid = bolloon_agent::updater::restart(&self_path, &args).ok();
            if new_pid.is_none() {
                // 装好了但没起来 → 放行, 让人能再点一次 (不卡死在"安装中")
                st.updating.store(false, Ordering::SeqCst);
            }
            Json(serde_json::json!({
                "installing": true, "restarting": new_pid.is_some(), "new_pid": new_pid, "report": report,
            }))
        }
        Err(e) => {
            st.updating.store(false, Ordering::SeqCst); // 装失败 → 放行重试
            Json(serde_json::json!({ "error": e.to_string() }))
        }
    }
}

// ────────────────────────── 世界模式 (对齐 TS routes-world.ts) ──────────────────────────

/// 世界种子机会 (演示流; 真实机会由 world-watcher / P2P 投递注入)
fn seed_world() -> Vec<(String, String, Vec<String>, Option<String>, &'static str)> {
    vec![
        ("世界流示例".into(), "世界持续流入 — 没有意图也保持流动".into(), vec!["world".into()], None, "world"),
        ("合作招募 · 可控核聚变".into(), "交叉验证口径, 需要两拨人".into(), vec!["聚变".into(), "合作".into()], Some("https://example.com/1".into()), "public"),
        ("论文共读 · 等离子体约束".into(), "每周一次线上共读".into(), vec!["等离子体".into(), "论文".into()], Some("https://example.com/2".into()), "public"),
        ("工具共享 · efficode 规范包".into(), "付费信息, 0.01 USDC".into(), vec!["工具".into(), "规范".into()], None, "card"),
    ]
}

/// GET /api/intents → 意图列表
pub async fn list_intents(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({ "intents": fs.intents }))
}

/// POST /api/intents → 加意图 (去空去重)
pub async fn add_intent(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let tag = req["tag"].as_str().unwrap_or_default().trim().to_string();
    if tag.is_empty() {
        return Json(serde_json::json!({ "error": "意图不能为空" }));
    }
    let mut fs = st.forge.lock().await;
    if !fs.intents.contains(&tag) {
        fs.intents.push(tag.clone());
    }
    let intents = fs.intents.clone();
    fs.save(&data_dir());
    Json(serde_json::json!({ "intents": intents }))
}

/// POST /api/intents/remove → 删意图
pub async fn remove_intent(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let tag = req["tag"].as_str().unwrap_or_default().to_string();
    let mut fs = st.forge.lock().await;
    fs.intents.retain(|t| t != &tag);
    let intents = fs.intents.clone();
    fs.save(&data_dir());
    Json(serde_json::json!({ "intents": intents }))
}

/// GET /api/opportunities → 机会流 (按意图重打分; 校准环过滤; 信箱置顶)
pub async fn list_opportunities(
    State(st): State<AppState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let tags: Vec<String> = q
        .get("tags")
        .map(|t| t.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let fs = st.forge.lock().await;
    let use_tags = if tags.is_empty() { fs.intents.clone() } else { tags };
    let mut items: Vec<serde_json::Value> = fs.inbox.clone(); // 信箱置顶
    for (i, (title, summary, t, url, kind)) in seed_world().into_iter().enumerate() {
        let id = format!("opp-{i:03}");
        if fs.ignored.contains(&id) {
            continue; // 校准环: 被忽略的同源不再流入
        }
        let (score, reason) = bolloon_agent::world::score_opportunity(&use_tags, &t);
        items.push(serde_json::json!({
            "id": id, "title": title, "summary": summary, "tags": t,
            "score": score, "reason": reason, "url": url, "kind": kind,
            "accepted": fs.accepted.contains(&id),
        }));
    }
    items.sort_by(|a, b| {
        let sa = a["score"].as_f64().unwrap_or(0.0);
        let sb = b["score"].as_f64().unwrap_or(0.0);
        sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
    });
    Json(serde_json::json!({ "opportunities": items, "intent_tags": use_tags }))
}

/// POST /api/opportunities/{id}/ignore → 校准环 (忽略后同源不再流入)
pub async fn ignore_opportunity(
    State(st): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    if !fs.ignored.contains(&id) {
        fs.ignored.push(id.clone());
    }
    fs.save(&data_dir());
    Json(serde_json::json!({ "ignored": id }))
}

/// POST /api/opportunities/{id}/accept → 接受 (进 Goal 证据面)
pub async fn accept_opportunity(
    State(st): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    if !fs.accepted.contains(&id) {
        fs.accepted.push(id.clone());
    }
    fs.save(&data_dir());
    Json(serde_json::json!({ "accepted": id }))
}

/// GET /api/world/profile → 世界画像 (意图/校准环/已接受)
pub async fn world_profile(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({
        "did": st.identity.did.as_str(),
        "intents": fs.intents, "ignored": fs.ignored, "accepted": fs.accepted,
    }))
}

/// GET /api/world/watch → 世界持续观察状态
pub async fn world_watch() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "watching": true, "orbit_status": "local-oplog", "channel": "orbitdb" }))
}

/// GET /api/world/inbox → 世界信箱 (外部智能体投递)
pub async fn world_inbox(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({ "items": fs.inbox }))
}

/// POST /api/world/inbox → 投递世界卡片 (外部 agent 传入; 内容格式不限)
pub async fn world_inbox_post(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let mut fs = st.forge.lock().await;
    let card = serde_json::json!({
        "id": format!("card-{:04}", fs.inbox.len() + 1),
        "kind": "card",
        "score": 2.0, // 置顶
        "title": req["title"].as_str().unwrap_or("世界卡片"),
        "summary": req["summary"].as_str().unwrap_or(""),
        "scope": req["scope"].as_str().unwrap_or("public"),
        "provider": req["provider"],
        "media": req["media"],
        "content": req["content"],
    });
    fs.inbox.push(card.clone());
    fs.save(&data_dir());
    Json(serde_json::json!({ "card": card }))
}

/// GET /api/world/stats → 世界统计 (徽章数据源)
pub async fn world_stats(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({
        "intents": fs.intents.len(),
        "ignored": fs.ignored.len(),
        "accepted": fs.accepted.len(),
        "inbox": fs.inbox.len(),
    }))
}

// ────────────────────────── 人类目录 (手机号/邮箱 + 跨机查询/加好友) ──────────────────────────

/// 目录视图 (内存态重建; 明文与 pepper 不外泄)
fn dir_view(fs: &crate::native::NativeState) -> bolloon_agent::directory::HumanDirectory {
    let mut d = bolloon_agent::directory::HumanDirectory::new();
    d.entries = fs.directory.clone();
    d
}

/// POST /api/directory/publish → 发布自己 (手机号或邮箱; 明文绝不落盘)
pub async fn directory_publish(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let contact = req["contact"].as_str().unwrap_or_default().to_string();
    let did = req["did"].as_str().unwrap_or_else(|| st.identity.did.as_str()).to_string();
    let name = req["display_name"].as_str();
    let pk = req["public_key_hex"].as_str();
    let pepper = load_pepper();
    let mut fs = st.forge.lock().await;
    let mut d = dir_view(&fs);
    let published = d.publish(&contact, &did, &pepper, name, pk, now_ms()).cloned();
    match published {
        Ok(e) => {
            fs.directory = d.entries.clone();
            fs.save(&data_dir());
            Json(serde_json::json!({
                "published": true, "blind": e.blind, "kind": e.kind.as_str(), "did": e.did,
            }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// GET /api/directory/lookup?contact=... → 本机目录查 (形状不对 → found:false 不猜)
pub async fn directory_lookup(
    State(st): State<AppState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let contact = q.get("contact").cloned().unwrap_or_default();
    let fs = st.forge.lock().await;
    let d = dir_view(&fs);
    let hit = d.lookup(&contact, &load_pepper());
    Json(serde_json::to_value(&hit).unwrap())
}

/// POST /api/directory/retract → 撤销 (软删)
pub async fn directory_retract(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let blind = req["blind"].as_str().unwrap_or_default().to_string();
    let mut fs = st.forge.lock().await;
    let mut d = dir_view(&fs);
    match d.retract(&blind, now_ms()) {
        Ok(()) => {
            fs.directory = d.entries.clone();
            fs.save(&data_dir());
            Json(serde_json::json!({ "revoked": blind }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// 跨机传输 (本机目录 + 对端目录; 真跨机接 gossip/iroh 同一端口)
struct CrossMachine {
    remote: Vec<bolloon_agent::directory::DirectoryEntry>,
    pepper: String,
}

impl bolloon_agent::directory::DirectoryTransport for CrossMachine {
    fn lookup(&self, rpc: &bolloon_agent::directory::LookupRpc) -> Vec<bolloon_agent::directory::LookupReply> {
        let contact = rpc
            .payload
            .contact
            .clone()
            .unwrap_or_else(|| rpc.payload.phone.clone());
        let mut remote_dir = bolloon_agent::directory::HumanDirectory::new();
        remote_dir.entries = self.remote.clone();
        let hit =
            bolloon_agent::directory::foreign_lookup(&remote_dir, &contact, rpc.payload.kind, &self.pepper);
        vec![bolloon_agent::directory::build_lookup_reply(&rpc.payload.rpc_id, hit)]
    }
}

/// GET /api/directory/remote-lookup?contact=... → **跨机查询** (对端用他自己的 pepper 命中)
pub async fn directory_remote_lookup(
    State(st): State<AppState>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let contact = q.get("contact").cloned().unwrap_or_default();
    let kind = q.get("kind").and_then(|k| match k.as_str() {
        "email" => Some(bolloon_agent::directory::ContactKind::Email),
        "phone" => Some(bolloon_agent::directory::ContactKind::Phone),
        _ => None,
    });
    // 对端目录 (远端节点发布过的条目; 单机演示 = 本机目录内容作为"对端"视图)
    let peer_entries = {
        let fs = st.forge.lock().await;
        fs.directory.clone()
    };
    let t = CrossMachine {
        remote: peer_entries,
        pepper: load_pepper(),
    };
    let rpc_id = format!("rpc-{}", now_ms());
    let hit = bolloon_agent::directory::lookup_remote(&t, &rpc_id, &contact, kind);
    Json(serde_json::to_value(&hit).unwrap())
}

/// POST /api/friends/request → **跨机加好友**: 查到 did → 发好友请求 (需对方同意)
pub async fn friend_request(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let contact = req["contact"].as_str().unwrap_or_default().to_string();
    let kind = req["kind"].as_str().and_then(|k| match k {
        "email" => Some(bolloon_agent::directory::ContactKind::Email),
        "phone" => Some(bolloon_agent::directory::ContactKind::Phone),
        _ => None,
    });
    let peer_entries = {
        let fs = st.forge.lock().await;
        fs.directory.clone()
    };
    let t = CrossMachine {
        remote: peer_entries,
        pepper: load_pepper(),
    };
    let rpc_id = format!("rpc-{}", now_ms());
    let hit = bolloon_agent::directory::lookup_remote(&t, &rpc_id, &contact, kind);
    let mut fs = st.forge.lock().await;
    match bolloon_agent::directory::remote_add_friend(
        &hit,
        &mut fs.friends,
        st.identity.did.as_str(),
        now_ms(),
    ) {
        Ok(msg) => {
            fs.save(&data_dir());
            Json(serde_json::json!({ "ok": true, "detail": msg, "hit": hit }))
        }
        Err(e) => Json(serde_json::json!({ "error": e, "hit": hit })),
    }
}

/// POST /api/friends/accept → 同意好友请求
pub async fn friend_accept(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let rid = req["request_id"].as_str().unwrap_or_default().to_string();
    let mut fs = st.forge.lock().await;
    match fs.friends.accept(&rid, now_ms()) {
        Ok(()) => {
            fs.save(&data_dir());
            Json(serde_json::json!({ "accepted": rid, "friends": fs.friends.friends() }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// POST /api/friends/reject → 拒绝
pub async fn friend_reject(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let rid = req["request_id"].as_str().unwrap_or_default().to_string();
    let mut fs = st.forge.lock().await;
    match fs.friends.reject(&rid, now_ms()) {
        Ok(()) => {
            fs.save(&data_dir());
            Json(serde_json::json!({ "rejected": rid }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

/// GET /api/friends → 好友 + 待处理请求
pub async fn friend_list(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({
        "friends": fs.friends.friends(),
        "requests": fs.friends.requests(),
    }))
}

// ────────────────────────── 做梦机制 (整理记忆/经验 → 升级 skills) ──────────────────────────

/// 做梦用的记忆视图 (从 SQLite 记忆库取; 回忆全量)
fn dream_memories(st: &AppState) -> Vec<bolloon_agent::memory::MemoryEntry> {
    let db = match st.memory_db.try_lock() {
        Ok(g) => g,
        Err(_) => return vec![], // 忙 → 不做梦 (不打扰)
    };
    let now_ms = now_ms();
    db.recall("local", None, 500, now_ms)
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let layer = match r.layer.as_str() {
                "lesson" => bolloon_agent::memory::MemoryLayer::Lesson,
                "decision" => bolloon_agent::memory::MemoryLayer::Decision,
                "temporary" => bolloon_agent::memory::MemoryLayer::Temporary,
                _ => bolloon_agent::memory::MemoryLayer::RunFact,
            };
            bolloon_agent::memory::MemoryEntry {
                id: format!("mem-{:06}", r.id),
                content: r.content,
                layer,
                importance: r.importance,
                created_at: chrono::DateTime::from_timestamp_millis(r.created_at_ms as i64)
                    .unwrap_or_else(chrono::Utc::now),
                expires_at: r
                    .expires_at_ms
                    .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms as i64)),
            }
        })
        .collect()
}

/// POST /api/dream → 触发一次做梦 (整理记忆与经验, 升级项目 skills)
pub async fn dream_run(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let domain = req["domain"].as_str().unwrap_or("all");
    // 忙就不做梦 (不打扰正在跑的任务)
    let idle_ms = req["idle_ms"].as_u64().unwrap_or(u64::MAX);
    let busy = req["busy"].as_bool().unwrap_or(false);
    if !bolloon_agent::dream::should_dream(idle_ms, req["threshold_ms"].as_u64().unwrap_or(0), busy) {
        return Json(serde_json::json!({ "skipped": true, "reason": "忙或不够空闲 — 做梦不打扰" }));
    }

    let memories = dream_memories(&st);
    let mut judgments = st.judgments.lock().await;
    let mut skills = st.skills.lock().await;
    let report = bolloon_agent::dream::dream(
        &bolloon_agent::dream::DreamInput { memories: &memories, now_ms: now_ms() },
        &mut judgments,
        &mut skills,
        domain,
    );
    let value = serde_json::to_value(&report).unwrap_or_default();
    // 落盘上次报告
    {
        let mut fs = st.forge.lock().await;
        fs.last_dream = Some(value.clone());
        fs.save(&data_dir());
    }
    Json(value)
}

/// GET /api/dream/last → 上次做梦报告 + 写过的梦想文档
pub async fn dream_last(State(st): State<AppState>) -> Json<serde_json::Value> {
    let fs = st.forge.lock().await;
    Json(serde_json::json!({ "last": fs.last_dream, "dreams": fs.dreams }))
}

/// POST /api/dream/topic → 梦想文档 (对齐 TS `/dream <主题>` 落盘; 作者取真实 profile)
pub async fn dream_topic(
    State(st): State<AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let topic = req["topic"].as_str().unwrap_or_default().trim().to_string();
    if topic.is_empty() {
        return Json(serde_json::json!({ "error": "主题不能为空" }));
    }
    // 作者: 显式传入优先, 否则用本机 profile 的名字 (不硬编码 "user")
    let author = {
        let fs = st.forge.lock().await;
        req["user"]
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| fs.profile.name.clone())
    };
    let doc = bolloon_agent::dream::dream_doc(
        &topic,
        &author,
        req["channel"].as_str().unwrap_or("web"),
        &chrono::Utc::now().to_rfc3339(),
    );
    let dir = data_dir().join("dreams");
    let _ = std::fs::create_dir_all(&dir);
    let safe: String = topic
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    let path = dir.join(format!("{}-{}.md", chrono::Utc::now().format("%Y-%m-%d"), safe));
    match std::fs::write(&path, doc.as_bytes()) {
        Ok(()) => {
            let shown = path.display().to_string();
            // 登记到状态 (做梦历史可查, 不用翻目录)
            {
                let mut fs = st.forge.lock().await;
                if !fs.dreams.contains(&shown) {
                    fs.dreams.push(shown.clone());
                }
                fs.save(&data_dir());
            }
            Json(serde_json::json!({ "written": shown, "author": author }))
        }
        Err(e) => Json(serde_json::json!({ "error": e.to_string() })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 分享快照: 写到盘上要能原样读回 (链接不是死链)
    #[test]
    fn share_snapshot_roundtrip() {
        let dir = std::env::temp_dir().join(format!("bolloon-share-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("shares")).unwrap();
        let snap = serde_json::json!({
            "token": "abcdef0123456789abcdef01",
            "session_id": "sess-0001",
            "title": "分享测试",
            "messages": [{ "role": "user", "text": "你好", "time": "10:00" }],
        });
        let token = snap["token"].as_str().unwrap();
        std::fs::write(
            dir.join("shares").join(format!("{token}.json")),
            serde_json::to_string_pretty(&snap).unwrap(),
        )
        .unwrap();
        let got = load_share_in(&dir, token).expect("读回分享");
        assert_eq!(got["title"], "分享测试");
        assert_eq!(got["messages"][0]["text"], "你好");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只认 hex token: 路径穿越 / 空 / 非 hex 一律读不到
    #[test]
    fn share_token_rejects_path_traversal() {
        let dir = std::env::temp_dir();
        assert!(load_share_in(&dir, "").is_none());
        assert!(load_share_in(&dir, "../etc/passwd").is_none());
        assert!(load_share_in(&dir, "abc/def").is_none());
        assert!(load_share_in(&dir, "zzzz").is_none());
        // 合法形状但文件不存在 → 仍 None (不冒充有内容)
        assert!(load_share_in(&dir, "0123456789abcdef").is_none());
    }

    /// 分享页内容一律转义 (不执行外部脚本)
    #[test]
    fn share_page_escapes_html() {
        let evil = "<script>alert(1)</script>";
        let out = html_escape(evil);
        assert!(!out.contains('<'), "{out}");
        assert!(out.contains("&lt;script&gt;"));
        assert_eq!(html_escape("a&b\"c'd"), "a&amp;b&quot;c&#39;d");
    }

    /// 安装互斥: 已在装时第二次 apply 必须被拒 (不并发替换同一二进制)
    #[test]
    fn update_gate_is_exclusive() {
        let gate = std::sync::atomic::AtomicBool::new(false);
        let first = gate
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        let second = gate
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        assert!(first && !second, "第二次申请必须被拒");
        gate.store(false, Ordering::SeqCst); // 失败释放后可重试
        let retry = gate
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok();
        assert!(retry);
    }
}
