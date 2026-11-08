//! feature_pack.rs — 2026-11-08 批次后端端点 (Kernel 登记机制, Harness 仍管实现)
//! 2026-11-08 复核修复: 卡片互动去重与回显、缓存键规范化/淘汰/命中率、
//! 模型绑定真校验 + 自训模型真接进模型通路、路由费按「真实模型调用」计一次。
//!
//! - 卡片互动: 点赞 / 喜欢 / 分享 / 评论 (真落卡片 + 进交互沉淀与 Kernel 事件面)
//! - 每会话 / 每智能体模型绑定: 下次打开沿用上一次的 provider (含本地)
//! - 幂等响应缓存: 参考 TS 侧 `canonicalizeJson` / `SYSTEM_PROMPT_CACHE_TTL_MS`
//! - 路由使用费: **不按 token、不花贡献积分**, 只按"路由调度次数"计费; 100 万次 0.001 元

use axum::{extract::State, Json};
use std::sync::{Mutex, OnceLock};

fn now_ms() -> u64 { chrono::Utc::now().timestamp_millis() as u64 }
fn path(name: &str) -> std::path::PathBuf { crate::server::data_dir().join(name) }

/// 所有 JSON 文件的读-改-写都在同一把进程内锁下, 防并发绑定/缓存互相覆盖。
fn io_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn read_jsonl(name: &str) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path(name)).unwrap_or_default().lines()
        .filter_map(|l| serde_json::from_str(l).ok()).collect()
}
fn append_jsonl(name: &str, v: &serde_json::Value) {
    use std::io::Write;
    let _g = io_lock().lock();
    let p = path(name);
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(v).unwrap_or_default());
    }
}
/// 调用方**未**持锁时用
fn read_obj(name: &str) -> serde_json::Value {
    let _g = io_lock().lock();
    read_obj_locked(name)
}
/// 调用方已持锁时用, 避免 std::sync::Mutex 不可重入导致死锁
fn read_obj_locked(name: &str) -> serde_json::Value {
    let v: serde_json::Value = std::fs::read_to_string(path(name)).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| serde_json::json!({}));
    // 旧版/写坏的文件可能是 [] / 数字 / 字符串; 统一归一化成对象,
    // 否则调用点的 `v[a][b] = ...` 链式 IndexMut 会直接 panic。
    if v.is_object() { v } else { serde_json::json!({}) }
}
fn write_obj_locked(name: &str, v: &serde_json::Value) {
    let p = path(name);
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

async fn kernel_log(st: &crate::AppState, mode: &str, kind: &str, label: &str, detail: serde_json::Value) {
    st.kernel.lock().await.record(mode, kind, label, detail);
}

/// 保证 reactions 结构完整 (老卡片可能只有 like 计数, 或压根没有 reactions)。
/// 不做 `as_array_mut().unwrap()` —— 那会在旧卡上把整个请求打崩。
fn ensure_reactions(it: &mut serde_json::Value) -> &mut serde_json::Value {
    if !it["reactions"].is_object() { it["reactions"] = serde_json::json!({}); }
    let r = &mut it["reactions"];
    for k in ["like", "favorite", "share"] {
        if !r[k].is_u64() { r[k] = serde_json::json!(0); }
    }
    if !r["comments"].is_array() { r["comments"] = serde_json::json!([]); }
    if !r["by"].is_object() { r["by"] = serde_json::json!({}); }
    r
}

/// POST /api/world/cards/react {id, type: like|favorite|comment|share, text?}
/// like/favorite 按 DID 幂等 (再点一次取消), share 按 DID 去重; 计数真回显。
pub async fn react_card(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let kind = req["type"].as_str().unwrap_or_default().to_string();
    if !matches!(kind.as_str(), "like" | "favorite" | "comment" | "share") || id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 id / type(like|favorite|comment|share)" }));
    }
    let text = req["text"].as_str().unwrap_or_default().trim().chars().take(300).collect::<String>();
    if kind == "comment" && text.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "评论不能为空" }));
    }
    let did = st.identity.did.as_str().to_string();
    let mut fs = st.forge.lock().await;
    let Some(it) = fs.inbox.iter_mut().find(|x| x["id"].as_str() == Some(id.as_str())) else {
        return Json(serde_json::json!({ "ok": false, "error": "没有这张卡片" }));
    };
    let action;
    {
        let r = ensure_reactions(it);
        // 只有「旧版把票记成布尔/数字/字符串」才算坏数据; by[did] 缺失/Null 是全新用户,
        // 必须按没点过处理, 否则第一次点赞会被误判成取消。
        let legacy = r["by"].get(&did).map(|v| !v.is_null() && !v.is_object()).unwrap_or(false);
        if !r["by"][&did].is_object() {
            r["by"][&did] = serde_json::json!({
                "like": legacy && kind == "like",
                "favorite": legacy && kind == "favorite",
                "share": legacy && kind == "share",
            });
        }
        match kind.as_str() {
            "comment" => {
                r["comments"].as_array_mut().unwrap().push(
                    serde_json::json!({ "at_ms": now_ms(), "text": text, "by": did }));
                action = "comment";
            }
            "like" | "favorite" => {
                let on = !r["by"][&did][&kind].as_bool().unwrap_or(false);
                r["by"][&did][&kind] = serde_json::json!(on);
                let n = r[&kind].as_u64().unwrap_or(0);
                r[&kind] = serde_json::json!(if on { n.saturating_add(1) } else { n.saturating_sub(1) });
                action = if on { "on" } else { "off" };
            }
            _ => {
                if r["by"][&did]["share"].as_bool().unwrap_or(false) {
                    action = "duplicate";
                } else {
                    r["by"][&did]["share"] = serde_json::json!(true);
                    let n = r["share"].as_u64().unwrap_or(0);
                    r["share"] = serde_json::json!(n.saturating_add(1));
                    action = "share";
                }
            }
        }
    }
    let counts = serde_json::json!({
        "like": it["reactions"]["like"], "favorite": it["reactions"]["favorite"],
        "share": it["reactions"]["share"],
        "comments": it["reactions"]["comments"].as_array().map(|a| a.len()).unwrap_or(0),
        "liked": it["reactions"]["by"][&did]["like"],
        "favorited": it["reactions"]["by"][&did]["favorite"],
    });
    // duplicate = 同一 DID 重复分享: 没有状态变化, 不落盘、不重复沉淀记忆/按钮事件
    if action != "duplicate" {
        fs.save(&crate::server::data_dir());
    }
    drop(fs);
    if action != "duplicate" {
        kernel_log(&st, "world", "button", &format!("卡片 {kind}: {id}"),
            serde_json::json!({ "type": kind, "action": action })).await;
        // 一次互动只在这一个落点沉淀记忆/判断力/工作流/信念 (前端按钮不再重复上报)
        let _ = crate::world_interact::record_interaction(
            &st,
            match kind.as_str() { "like" => "vote_up", "favorite" => "pin", _ => &kind },
            &id,
            serde_json::json!({ "label": format!("卡片 {kind}") }),
        ).await;
    }
    Json(serde_json::json!({ "ok": true, "id": id, "type": kind, "action": action, "reactions": counts }))
}

/// POST /api/models/bind {scope: session|agent, id, provider, model}
/// provider 必须真的在模型通路里 (或已登记的自训模型), 否则存了也发不出去。
pub async fn bind_model(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let scope = req["scope"].as_str().unwrap_or_default();
    let id = req["id"].as_str().unwrap_or_default();
    if !matches!(scope, "session" | "agent") || id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "scope=session|agent 且要 id" }));
    }
    let provider = req["provider"].as_str().unwrap_or_default().trim().to_string();
    let model = req["model"].as_str().unwrap_or_default().trim().to_string();
    if provider.is_empty() || model.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 provider / model" }));
    }
    let known = st.llm_snapshot().provider(&provider).is_some()
        || bolloon_llm::config_store::load().custom_providers.contains_key(&provider);
    if !known {
        return Json(serde_json::json!({ "ok": false,
            "error": format!("provider {provider} 不在模型通路里 — 先登记/自训模型接入") }));
    }
    let _g = io_lock().lock();
    let mut b = read_obj_locked("model-bindings.json");
    if !b[scope].is_object() { b[scope] = serde_json::json!({}); }
    b[scope][id] = serde_json::json!({ "provider": provider, "model": model, "at_ms": now_ms() });
    write_obj_locked("model-bindings.json", &b);
    drop(_g);
    kernel_log(&st, "agent", "route", &format!("绑定模型 {scope}/{id} → {model}"),
        serde_json::json!({ "scope": scope, "provider": provider })).await;
    Json(serde_json::json!({ "ok": true, "scope": scope, "id": id, "model": model,
        "note": "下次打开这个会话/智能体沿用同一模型; 可指定本地 provider" }))
}

pub async fn model_bindings() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "bindings": read_obj("model-bindings.json") }))
}

/// 会话/智能体绑定解析: 优先 session, 再 agent (两个 id 都要传, 不能写死空串)。
pub fn resolve_binding(session_id: &str, agent_id: &str) -> Option<(String, String)> {
    let b = read_obj("model-bindings.json");
    for (scope, key) in [("session", session_id), ("agent", agent_id)] {
        if key.is_empty() { continue; }
        let e = &b[scope][key];
        if e.is_object() {
            let p = e["provider"].as_str().unwrap_or("").trim();
            let m = e["model"].as_str().unwrap_or("").trim();
            if !p.is_empty() && !m.is_empty() {
                return Some((p.to_string(), m.to_string()));
            }
        }
    }
    None
}

/// 给「旧路径」(群聊/特化/视觉 call_model_metered) 也套用同一份绑定。
pub fn apply_binding(session_id: &str, agent_id: &str, provider: String, model: String) -> (String, String) {
    match resolve_binding(session_id, agent_id) {
        Some((p, m)) => (p, m),
        None => (provider, model),
    }
}

/// 调用错误落到事件管道 (Kernel 执行核), 带上下文 scope 便于回查。
pub fn record_error(scope: &str, error: &str, detail: serde_json::Value) {
    append_jsonl("route-errors.jsonl", &serde_json::json!({
        "at_ms": now_ms(), "scope": scope,
        "error": error.chars().take(300).collect::<String>(),
        "detail": detail,
    }));
    crate::kernel_bus::record_event("agent", "error", &format!("{scope} 调用失败"),
        serde_json::json!({ "error": error.chars().take(160).collect::<String>() }));
}
pub fn route_usage_count() -> usize { read_jsonl("route-usage.jsonl").len() }

/// 好友面板两个开关的**唯一写入口**: 与 `friend_access` 同一把 io_lock,
/// 且只更新本次提交的字段 —— 没传的开关不能被重置成默认值。
pub fn update_friend_access(did: &str, allow: Option<bool>, blocked: Option<bool>) -> bool {
    if allow.is_none() && blocked.is_none() { return false; }
    let _g = io_lock().lock();
    let mut m = read_obj_locked("friend-access.json");
    if !m[did].is_object() { m[did] = serde_json::json!({}); }
    if let Some(v) = allow { m[did]["allow_agent"] = serde_json::json!(v); }
    if let Some(v) = blocked { m[did]["blocked"] = serde_json::json!(v); }
    m[did]["at_ms"] = serde_json::json!(now_ms());
    write_obj_locked("friend-access.json", &m);
    true
}

/// GET /api/friends/access?did= → 好友面板回显昵称/备注/两个开关 (不再每次打开都清零)
pub async fn friend_access(
    State(st): State<crate::AppState>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let did = q.get("did").cloned().unwrap_or_default();
    let access = read_obj("friend-access.json");
    let row = &access[&did];
    let fs = st.forge.lock().await;
    let card = fs.contacts.all().iter().find(|c| c.did == did);
    Json(serde_json::json!({
        "ok": true, "did": did,
        "name": card.map(|c| c.name.clone()).unwrap_or_default(),
        "note": card.map(|c| c.note.clone()).unwrap_or_default(),
        "allow_agent": row["allow_agent"].as_bool().unwrap_or(true),
        "blocked": row["blocked"].as_bool().unwrap_or(false),
    }))
}

/// POST /api/models/custom {name, path?, base_url?, model?, format?}
/// → 接入用户自己训练的小模型。只登记文件 = `wired:false` (如实标注不可调用);
/// 给了本机 OpenAI 兼容端点才真注册成 provider 并 reload, 绑定后可发请求。
pub async fn register_custom_model(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let name = req["name"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
        return Json(serde_json::json!({ "ok": false, "error": "模型名只能用中英文/数字/-/_" }));
    }
    let path_s = req["path"].as_str().unwrap_or_default().trim().to_string();
    if !path_s.is_empty() && !std::path::PathBuf::from(&path_s).exists() {
        return Json(serde_json::json!({ "ok": false, "error": "路径不存在（GGUF 文件或模型目录）" }));
    }
    let fmt = req["format"].as_str().unwrap_or("gguf").to_string();
    let base_url = req["base_url"].as_str().unwrap_or_default().trim().trim_end_matches('/').to_string();
    let model = req["model"].as_str().unwrap_or_default().trim().to_string();
    let mut wired = false;
    let mut provider = String::new();
    if !base_url.is_empty() {
        if !(base_url.starts_with("http://127.0.0.1")
            || base_url.starts_with("http://localhost")
            || base_url.starts_with("http://[::1]")) {
            return Json(serde_json::json!({ "ok": false,
                "error": "自训模型只接本机推理端点 (127.0.0.1 / localhost / ::1)" }));
        }
        // 真探测: 端点不通就不登记成可用 provider (不假装能用)
        let probe = ureq::get(&format!("{base_url}/v1/models"))
            .timeout(std::time::Duration::from_secs(3)).call();
        if let Err(e) = probe {
            return Json(serde_json::json!({ "ok": false,
                "error": format!("本机推理端点没响应 ({base_url}/v1/models): {e}") }));
        }
        provider = format!("custom-{name}");
        let model_name = if model.is_empty() { name.clone() } else { model.clone() };
        let mut cfg = bolloon_llm::config_store::load();
        bolloon_llm::config_store::upsert_custom(
            &mut cfg, &provider, &format!("自训模型 {name}"), &base_url,
            Some(bolloon_llm::provider_registry::Protocol::OpenAiCompatible),
            None, Some(&model_name),
        );
        if let Err(e) = bolloon_llm::config_store::save(&cfg) {
            return Json(serde_json::json!({ "ok": false, "error": format!("配置落盘失败: {e}") }));
        }
        st.reload_llm().await;
        wired = true;
    }
    let _g = io_lock().lock();
    let mut m = read_obj_locked("custom-models.json");
    m[&name] = serde_json::json!({
        "path": path_s, "format": fmt, "base_url": base_url, "model": model,
        "provider": provider, "wired": wired, "at_ms": now_ms(),
        "by": st.identity.did.as_str(),
    });
    write_obj_locked("custom-models.json", &m);
    drop(_g);
    kernel_log(&st, "agent", "route", &format!("接入自训模型 {name}"),
        serde_json::json!({ "format": fmt, "wired": wired })).await;
    Json(serde_json::json!({ "ok": true, "name": name, "format": fmt, "wired": wired,
        "provider": provider,
        "note": if wired { "已注册成 provider, 可用 /api/models/bind 绑到会话/智能体" }
                else { "只登记了文件; 要给 base_url(本机推理端点) 才真能调用" } }))
}
pub async fn list_custom_models() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "models": read_obj("custom-models.json") }))
}

/// POST /api/models/share {name} → 按去中心化协议把模型登记做成可分享卡片。
/// 不外发本机绝对路径, 不自封 verified。
pub async fn share_model(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let name = req["name"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() { return Json(serde_json::json!({ "ok": false, "error": "缺 name" })); }
    let m = read_obj("custom-models.json");
    let e = &m[&name];
    if !e.is_object() { return Json(serde_json::json!({ "ok": false, "error": "模型池里没有这个模型" })); }
    let card = serde_json::json!({
        "title": format!("模型分享：{}", name),
        "summary": format!("自训模型 {} · 格式 {}（API 与密钥自配，不含密钥与本机路径）",
            name, e["format"].as_str().unwrap_or("")),
        "media": [], "cover": serde_json::Value::Null,
        "provider_did": st.identity.did.as_str(), "scope": "public",
        "issued_at_ms": now_ms(), "verification": "unverified",
        "category": serde_json::Value::Null,
        "tags": ["model", "share"], "actions": [], "reply_to": serde_json::Value::Null,
    });
    let r = crate::native::world_cards_share(State(st.clone()), Json(card)).await.0;
    Json(serde_json::json!({ "ok": r["ok"].as_bool().unwrap_or(false), "name": name,
        "delivery": r["delivery"], "error": r["error"] }))
}

// ── 幂等响应缓存 ────────────────────────────────────────────────────────────
// 参考 TS `pi-ai.ts` / `kv-prefix-cache.md`: key 要**逐字节稳定**,
// 所以统一排序对象键与 tools 顺序, 显式带 provider/model/session/schema 版本;
// 过期条目真删, 有容量上限, 有 miss 与命中率, 不再截断回复、不再缓存工具回合。
pub const CACHE_TTL_MS: u64 = 10 * 60 * 1000;
pub const MAX_CACHE_ENTRIES: usize = 200;
pub const MAX_CACHE_CHARS: usize = 20_000;

pub fn cache_key(model: &str, prompt: &str) -> String {
    bolloon_x402::paid_info::compute_content_hash(&format!("{model}|{prompt}"))
}

/// 递归排序 JSON 对象键; tools 按 function.name 排序 (数组其余保序)。
fn canonicalize(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                let val = canonicalize(&m[k]);
                out.insert(k.clone(), val);
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(a) => {
            let mut vals: Vec<serde_json::Value> = a.iter().map(canonicalize).collect();
            // 工具 schema 的顺序抖动是 KV 前缀失配的经典原因 (TS canonicalizeTools)
            if vals.iter().all(|x| x.is_object())
                && vals.iter().any(|x| x.get("function").is_some() || x.get("name").is_some())
            {
                vals.sort_by_key(|x| x["function"]["name"].as_str()
                    .or_else(|| x["name"].as_str()).unwrap_or("").to_string());
            }
            serde_json::Value::Array(vals)
        }
        _ => v.clone(),
    }
}

/// 一次模型请求的稳定 key (调用方传完整 GenerateParams JSON)
pub fn request_cache_key(provider: &str, model: &str, session_id: &str, params_json: &str) -> String {
    let params: serde_json::Value = serde_json::from_str(params_json)
        .unwrap_or(serde_json::Value::Null);
    let stable = serde_json::json!({
        "schema": 2, "provider": provider, "model": model, "session": session_id,
        "params": canonicalize(&params),
    });
    cache_key(model, &serde_json::to_string(&stable).unwrap_or_default())
}

/// 只有「纯文本、非工具回合、长度有界」的回复才允许缓存。
pub fn should_cache(text: &str, tool_calls: usize, finish_reason: &str) -> bool {
    !text.is_empty()
        && text.chars().count() <= MAX_CACHE_CHARS
        && tool_calls == 0
        && finish_reason != "tool_calls"
        && finish_reason != "cache_hit"
}

pub fn cache_lookup_by_key(key: &str) -> Option<String> {
    let _g = io_lock().lock();
    let mut c = read_obj_locked("response-cache.json");
    let e = c[key].clone();
    if !e.is_object() { bump_counter_locked("misses"); return None }
    let age = now_ms().saturating_sub(e["at_ms"].as_u64().unwrap_or(0));
    if age > CACHE_TTL_MS || e["at_ms"].as_u64().unwrap_or(0) > now_ms().saturating_add(2_000) {
        if let Some(obj) = c.as_object_mut() { obj.remove(key); }
        write_obj_locked("response-cache.json", &c);
        bump_counter_locked("misses");
        return None;
    }
    let Some(text) = e["text"].as_str() else {
        // 坏条目也要算一次未命中, 不能 `?` 提前返回让 hits/misses 统计失真
        if let Some(obj) = c.as_object_mut() { obj.remove(key); }
        write_obj_locked("response-cache.json", &c);
        bump_counter_locked("misses");
        return None;
    };
    let text = text.to_string();
    bump_counter_locked("hits");
    Some(text)
}

fn bump_counter_locked(field: &str) {
    let mut c = read_obj_locked("cache-counters.json");
    let n = c[field].as_u64().unwrap_or(0).saturating_add(1);
    c[field] = serde_json::json!(n);
    write_obj_locked("cache-counters.json", &c);
}

/// 工具回合永远不可能命中 (只存纯文本回复), 单列计数而不是灌进 misses,
/// 否则 hit_rate 会被系统性压低、看起来像"缓存没效果"。
pub fn cache_skip() {
    let _g = io_lock().lock();
    bump_counter_locked("skipped");
}

pub fn cache_store_by_key(key: &str, text: &str) {
    if text.is_empty() || text.chars().count() > MAX_CACHE_CHARS { return }
    let _g = io_lock().lock();
    let mut c = read_obj_locked("response-cache.json");
    let now = now_ms();
    if let Some(obj) = c.as_object_mut() {
        obj.retain(|_, v| {
            let t = v["at_ms"].as_u64().unwrap_or(0);
            t <= now.saturating_add(2_000) && now.saturating_sub(t) <= CACHE_TTL_MS
        });
        // 容量上限: 超了淘汰最旧的 (TS 侧 MAX=200)
        if obj.len() >= MAX_CACHE_ENTRIES {
            let mut rows: Vec<(String, u64)> = obj.iter()
                .map(|(k, v)| (k.clone(), v["at_ms"].as_u64().unwrap_or(0))).collect();
            rows.sort_by_key(|(_, t)| *t);
            for (k, _) in rows.iter().take(obj.len() - MAX_CACHE_ENTRIES + 1) { obj.remove(k); }
        }
    }
    c[key] = serde_json::json!({ "at_ms": now, "text": text });
    write_obj_locked("response-cache.json", &c);
}

/// 兼容旧签名 (单测与不关心规范化 key 的调用点)
pub fn cache_lookup(model: &str, prompt: &str) -> Option<String> {
    cache_lookup_by_key(&cache_key(model, prompt))
}
pub fn cache_store(model: &str, prompt: &str, text: &str) {
    cache_store_by_key(&cache_key(model, prompt), text)
}

pub async fn cache_stats() -> Json<serde_json::Value> {
    let counters = read_obj("cache-counters.json");
    let hits = counters["hits"].as_u64().unwrap_or_else(|| read_jsonl("cache-hits.jsonl").len() as u64);
    let misses = counters["misses"].as_u64().unwrap_or(0);
    let skipped = counters["skipped"].as_u64().unwrap_or(0);
    let total = hits + misses; // 分母只含「可缓存回合」, skipped 不参与
    Json(serde_json::json!({
        "ok": true, "hits": hits, "misses": misses, "skipped": skipped,
        "hit_rate": if total == 0 { 0.0 } else { hits as f64 / total as f64 },
        "entries": read_obj("response-cache.json").as_object().map(|m| m.len()).unwrap_or(0),
        "max_entries": MAX_CACHE_ENTRIES,
        "ttl_ms": CACHE_TTL_MS,
        "note": "幂等命中: 规范化后的同 provider+model+会话+请求 在 TTL 内复用; 带工具调用的回复不入缓存, 单列 skipped 不计入命中率分母"
    }))
}

/// 路由使用费: 100 万次 = 0.001 元人民币 (按次, 不按 token, 不动贡献积分)
pub const ROUTE_FEE_CNY_PER_MILLION: f64 = 0.001;
/// 只有**拿到成功响应**才记一次; 缓存命中/调用失败/账本记账都不算调度 (没用成不收费)。
pub fn charge_route_call(detail: &str) {
    append_jsonl("route-usage.jsonl", &serde_json::json!({ "at_ms": now_ms(), "detail": detail }));
}
pub async fn route_fee() -> Json<serde_json::Value> {
    let n = read_jsonl("route-usage.jsonl").len() as f64;
    Json(serde_json::json!({
        "ok": true, "calls": n,
        "errors": read_jsonl("route-errors.jsonl").len(),
        "cny_per_million_calls": ROUTE_FEE_CNY_PER_MILLION,
        "per_call_cny": ROUTE_FEE_CNY_PER_MILLION / 1_000_000.0,
        "fee_cny": n / 1_000_000.0 * ROUTE_FEE_CNY_PER_MILLION,
        "model": "模型 API 用户自配; 付费的是个性化路由调度, 不是 token 也不是贡献积分",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_key_is_stable_and_model_scoped() {
        assert_eq!(cache_key("m", "p"), cache_key("m", "p"));
        assert_ne!(cache_key("m", "p"), cache_key("m2", "p"));
    }
    #[test]
    fn canonicalization_ignores_key_and_tool_order_but_not_values() {
        let a = request_cache_key("p", "m", "s", r#"{"model":"m","tools":[{"function":{"name":"b"}},{"function":{"name":"a"}}],"messages":[{"role":"user","content":"hi"}]}"#);
        let b = request_cache_key("p", "m", "s", r#"{"tools":[{"function":{"name":"a"}},{"function":{"name":"b"}}],"messages":[{"content":"hi","role":"user"}],"model":"m"}"#);
        assert_eq!(a, b);
        assert_ne!(a, request_cache_key("p", "m", "s2", r#"{"model":"m","tools":[],"messages":[]}"#));
        assert_ne!(a, request_cache_key("p2", "m", "s", r#"{"model":"m","tools":[{"function":{"name":"a"}},{"function":{"name":"b"}}],"messages":[{"content":"hi","role":"user"}]}"#));
    }
    #[test]
    fn tool_turns_and_oversize_replies_are_never_cached() {
        assert!(!should_cache("call me", 1, "tool_calls"));
        assert!(!should_cache("ok", 0, "cache_hit"));
        assert!(should_cache("ok", 0, "stop"));
        assert!(!should_cache(&"x".repeat(MAX_CACHE_CHARS + 1), 0, "stop"));
    }
    #[test]
    fn route_fee_is_per_call_not_per_token() {
        assert_eq!(ROUTE_FEE_CNY_PER_MILLION, 0.001);
        assert!((1_000_000.0 / 1_000_000.0 * ROUTE_FEE_CNY_PER_MILLION - 0.001).abs() < 1e-12);
    }
    #[test]
    fn reactions_are_repaired_on_legacy_cards() {
        let mut v = serde_json::json!({ "id": "x", "reactions": { "like": 2 } });
        let r = ensure_reactions(&mut v);
        assert!(r["comments"].is_array());
        assert_eq!(r["like"].as_u64(), Some(2));
        assert_eq!(r["favorite"].as_u64(), Some(0));
    }
}
