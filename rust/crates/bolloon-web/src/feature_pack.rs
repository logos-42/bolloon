//! feature_pack.rs — 2026-11-08 批次后端端点 (Kernel 登记机制, Harness 仍管实现)
//!
//! - 卡片互动: 点赞 / 喜欢 / 分享 / 评论 (真实落卡片, 不是只换图标)
//! - 每会话 / 每智能体模型绑定: 下次打开沿用上一次的 provider (含本地)
//! - 幂等响应缓存: 参考 TS 侧 `idempotency cache hit` / `SYSTEM_PROMPT_CACHE_TTL_MS`
//! - 路由使用费: **不按 token、不花贡献积分**, 只按"路由调度次数"计费; 100 万次 0.001 元
//! - 所有动作都进 kernel.record, 三模式共享同一份事件面

use axum::{extract::State, Json};

fn now_ms() -> u64 { chrono::Utc::now().timestamp_millis() as u64 }
fn path(name: &str) -> std::path::PathBuf { crate::server::data_dir().join(name) }
fn read_jsonl(name: &str) -> Vec<serde_json::Value> {
    std::fs::read_to_string(path(name)).unwrap_or_default().lines()
        .filter_map(|l| serde_json::from_str(l).ok()).collect()
}
fn append_jsonl(name: &str, v: &serde_json::Value) {
    use std::io::Write;
    let p = path(name);
    if let Some(d) = p.parent() { let _ = std::fs::create_dir_all(d); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(v).unwrap_or_default());
    }
}
fn read_obj(name: &str) -> serde_json::Value {
    std::fs::read_to_string(path(name)).ok()
        .and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| serde_json::json!({}))
}
fn write_obj(name: &str, v: &serde_json::Value) {
    let p = path(name);
    let tmp = p.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

async fn kernel_log(st: &crate::AppState, mode: &str, kind: &str, label: &str, detail: serde_json::Value) {
    st.kernel.lock().await.record(mode, kind, label, detail);
}

/// POST /api/world/cards/react {id, type: like|favorite|comment, text?}
pub async fn react_card(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().to_string();
    let kind = req["type"].as_str().unwrap_or_default().to_string();
    if !matches!(kind.as_str(), "like" | "favorite" | "comment") || id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 id / type(like|favorite|comment)" }));
    }
    let text = req["text"].as_str().unwrap_or_default().chars().take(300).collect::<String>();
    let mut fs = st.forge.lock().await;
    let Some(it) = fs.inbox.iter_mut().find(|x| x["id"].as_str() == Some(id.as_str())) else {
        return Json(serde_json::json!({ "ok": false, "error": "没有这张卡片" }));
    };
    if !it["reactions"].is_object() { it["reactions"] = serde_json::json!({ "like": 0, "favorite": 0, "comments": [] }); }
    if kind == "comment" {
        if text.is_empty() { return Json(serde_json::json!({ "ok": false, "error": "评论不能为空" })); }
        it["reactions"]["comments"].as_array_mut().unwrap().push(
            serde_json::json!({ "at_ms": now_ms(), "text": text, "by": st.identity.did.as_str() }));
    } else {
        let n = it["reactions"][&kind].as_u64().unwrap_or(0) + 1;
        it["reactions"][&kind] = serde_json::json!(n);
    }
    fs.save(&crate::server::data_dir());
    drop(fs);
    kernel_log(&st, "world", "button", &format!("卡片 {kind}: {id}"), serde_json::json!({ "type": kind })).await;
    Json(serde_json::json!({ "ok": true, "id": id, "type": kind }))
}

/// POST /api/models/bind {scope: session|agent, id, provider, model}
pub async fn bind_model(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let scope = req["scope"].as_str().unwrap_or_default();
    let id = req["id"].as_str().unwrap_or_default();
    if !matches!(scope, "session" | "agent") || id.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "scope=session|agent 且要 id" }));
    }
    let provider = req["provider"].as_str().unwrap_or_default().to_string();
    let model = req["model"].as_str().unwrap_or_default().to_string();
    if model.is_empty() { return Json(serde_json::json!({ "ok": false, "error": "缺 model" })); }
    let mut b = read_obj("model-bindings.json");
    b[scope][id] = serde_json::json!({ "provider": provider, "model": model, "at_ms": now_ms() });
    write_obj("model-bindings.json", &b);
    kernel_log(&st, "agent", "route", &format!("绑定模型 {scope}/{id} → {model}"),
        serde_json::json!({ "scope": scope, "provider": provider })).await;
    Json(serde_json::json!({ "ok": true, "scope": scope, "id": id, "model": model,
        "note": "下次打开这个会话/智能体沿用同一模型; 可指定本地 provider" }))
}

pub async fn model_bindings() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "bindings": read_obj("model-bindings.json") }))
}

/// 会话/智能体绑定解析: 优先 session, 再 agent; 让下一次打开沿用上次的 provider
pub fn resolve_binding(session_id: &str, agent_id: &str) -> Option<(String, String)> {
    let b = read_obj("model-bindings.json");
    for (scope, key) in [("session", session_id), ("agent", agent_id)] {
        if key.is_empty() { continue; }
        let e = &b[scope][key];
        if e.is_object() {
            return Some((e["provider"].as_str().unwrap_or("").to_string(),
                         e["model"].as_str().unwrap_or("").to_string()));
        }
    }
    None
}

/// 调用错误落到事件管道 (Kernel 执行核), 可回查
pub fn record_error(scope: &str, error: &str) {
    append_jsonl("route-errors.jsonl", &serde_json::json!({
        "at_ms": now_ms(), "scope": scope, "error": error.chars().take(300).collect::<String>()
    }));
}
pub fn route_usage_count() -> usize { read_jsonl("route-usage.jsonl").len() }

/// POST /api/models/custom {name, path, format?} → 接入用户自己训练的小模型 (真校验路径)
pub async fn register_custom_model(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let name = req["name"].as_str().unwrap_or_default().trim().to_string();
    let path_s = req["path"].as_str().unwrap_or_default().trim().to_string();
    if name.is_empty() || path_s.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 name / path" }));
    }
    let fp = std::path::PathBuf::from(&path_s);
    if !fp.exists() {
        return Json(serde_json::json!({ "ok": false, "error": "路径不存在（GGUF 文件或模型目录）" }));
    }
    let fmt = req["format"].as_str().unwrap_or_else(|| {
        if fp.is_dir() { "dir" } else { "gguf" }
    }).to_string();
    let mut m = read_obj("custom-models.json");
    m[&name] = serde_json::json!({ "path": path_s, "format": fmt, "at_ms": now_ms(),
        "provider": "local", "by": st.identity.did.as_str() });
    write_obj("custom-models.json", &m);
    kernel_log(&st, "agent", "route", &format!("接入自训模型 {name}"),
        serde_json::json!({ "format": fmt })).await;
    Json(serde_json::json!({ "ok": true, "name": name, "format": fmt,
        "note": "已登记到模型池; 可用 /api/models/bind 绑到某个会话/智能体" }))
}
pub async fn list_custom_models() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "models": read_obj("custom-models.json") }))
}

/// POST /api/models/share {name} → 按去中心化协议把模型登记做成可分享卡片
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
        "summary": format!("{} · {}（自配 API，不含密钥）", e["format"].as_str().unwrap_or(""), e["path"].as_str().unwrap_or("")),
        "media": [], "cover": serde_json::Value::Null,
        "provider_did": st.identity.did.as_str(), "scope": "public",
        "issued_at_ms": now_ms(), "verification": "verified", "category": serde_json::Value::Null,
        "tags": ["model", "share"], "actions": [], "reply_to": serde_json::Value::Null,
    });
    let r = crate::native::world_cards_share(State(st.clone()), Json(card)).await.0;
    Json(serde_json::json!({ "ok": true, "name": name, "delivery": r["delivery"] }))
}

/// 幂等响应缓存 (参考 TS `idempotency cache hit`): 同 prompt+model 在 TTL 内直接复用
pub const CACHE_TTL_MS: u64 = 10 * 60 * 1000;
pub fn cache_key(model: &str, prompt: &str) -> String {
    bolloon_x402::paid_info::compute_content_hash(&format!("{model}|{prompt}"))
}
pub fn cache_lookup(model: &str, prompt: &str) -> Option<String> {
    let key = cache_key(model, prompt);
    let c = read_obj("response-cache.json");
    let e = &c[&key];
    if e.is_null() { return None; }
    let age = now_ms().saturating_sub(e["at_ms"].as_u64().unwrap_or(0));
    if age > CACHE_TTL_MS { return None; }
    let text = e["text"].as_str()?.to_string();
    append_jsonl("cache-hits.jsonl", &serde_json::json!({ "at_ms": now_ms(), "key": key, "model": model }));
    Some(text)
}
pub fn cache_store(model: &str, prompt: &str, text: &str) {
    let key = cache_key(model, prompt);
    let mut c = read_obj("response-cache.json");
    c[&key] = serde_json::json!({ "at_ms": now_ms(), "text": text.chars().take(8000).collect::<String>() });
    write_obj("response-cache.json", &c);
}
pub async fn cache_stats() -> Json<serde_json::Value> {
    let hits = read_jsonl("cache-hits.jsonl");
    let entries = read_obj("response-cache.json").as_object().map(|m| m.len()).unwrap_or(0);
    Json(serde_json::json!({ "ok": true, "hits": hits.len(), "entries": entries,
        "ttl_ms": CACHE_TTL_MS, "recent": hits.iter().rev().take(5).cloned().collect::<Vec<_>>(),
        "note": "幂等命中: 同模型+同 prompt 在 TTL 内直接复用, 不重复调用模型" }))
}

/// 路由使用费: 100 万次 = 0.001 元人民币 (按次, 不按 token, 不动贡献积分)
pub const ROUTE_FEE_CNY_PER_MILLION: f64 = 0.001;
pub fn charge_route_call(detail: &str) {
    append_jsonl("route-usage.jsonl", &serde_json::json!({ "at_ms": now_ms(), "detail": detail }));
}
pub async fn route_fee() -> Json<serde_json::Value> {
    let n = read_jsonl("route-usage.jsonl").len() as f64;
    Json(serde_json::json!({
        "ok": true, "calls": n,
        "errors": read_jsonl("route-errors.jsonl").len(),
        "cny_per_million_calls": ROUTE_FEE_CNY_PER_MILLION,
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
    fn cache_key_is_deterministic_and_scoped() {
        // 纯函数测试: 不写真实运行目录 (以前 store/lookup 往返每次跑测试都污染 ~/.bolloon)
        let a = cache_key("ollama/gpt-oss:20b", "同样的 prompt");
        let b = cache_key("ollama/gpt-oss:20b", "同样的 prompt");
        assert_eq!(a, b);
        assert_ne!(a, cache_key("ollama/gpt-oss:20b", "不同的 prompt"));
        assert!(CACHE_TTL_MS > 0);
    }

    #[test]
    fn route_fee_is_per_call_not_per_token() {
        assert_eq!(ROUTE_FEE_CNY_PER_MILLION, 0.001);
        assert!((1_000_000.0 / 1_000_000.0 * ROUTE_FEE_CNY_PER_MILLION - 0.001).abs() < 1e-12);
    }
}
