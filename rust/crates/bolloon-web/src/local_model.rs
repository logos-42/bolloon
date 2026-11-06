//! local_model.rs — 本地小模型接口 (2026-11-06 阶段4 的"运行位")
//!
//! 不做模型工厂、不做蒸馏: 只把本机已跑起来的小模型 (Ollama / LM Studio / llama.cpp
//! 的 OpenAI 兼容端点) 登记成**一个可选 provider**, 让路由账本能拿它跟通用模型做真实对比。
//!
//! 纪律: ① 免 key (本地不需要凭); ② 登记前真探测, 探测不通就如实报, 不假装可用;
//! ③ 协议按 `Protocol::Ollama` 显式指定 (URL 含 11434/local 也能自动推断, 这里不赌);
//! ④ 不自动设为默认, 除非显式 `activate=true`。

use axum::{extract::State, Json};

pub const LOCAL_PROVIDER_ID: &str = "local-small";
pub const DEFAULT_LOCAL_URL: &str = "http://127.0.0.1:11434";

/// 探测本机模型服务 (只问 `/api/tags`, 不发起推理, 不花钱)
fn probe(base_url: &str) -> Result<(bool, Vec<String>), String> {
    let url = format!("{}/api/tags", base_url.trim_end_matches('/'));
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .call()
        .map_err(|e| format!("本机模型服务没有响应 ({url}): {e}"))?;
    let v: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("响应不是 JSON: {e}"))?;
    let models: Vec<String> = v["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["name"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok((true, models))
}

/// GET /api/models/local → 本地小模型接口状态 (是否登记 / 是否可达 / 已装模型)
pub async fn local_status(
    State(st): State<crate::AppState>,
) -> Json<serde_json::Value> {
    let cfg = bolloon_llm::config_store::load();
    let entry = cfg.custom_providers.get(LOCAL_PROVIDER_ID);
    let base = entry
        .map(|e| e.base_url.clone())
        .unwrap_or_else(|| DEFAULT_LOCAL_URL.to_string());
    let (reachable, models, err) = match probe(&base) {
        Ok((_, m)) => (true, m, serde_json::Value::Null),
        Err(e) => (false, Vec::<String>::new(), serde_json::json!(e)),
    };
    Json(serde_json::json!({
        "provider_id": LOCAL_PROVIDER_ID,
        "registered": entry.is_some(),
        "base_url": base,
        "model": entry.and_then(|e| Some(e.model.clone())).unwrap_or_default(),
        "active": cfg.active_provider == LOCAL_PROVIDER_ID,
        "reachable": reachable,
        "installed_models": models,
        "error": err,
        "note": "本地小模型只作为可选 provider 参与路由评测; 不训练、不蒸馏、不自动替换通用模型"
    }))
}

/// POST /api/models/local {url?, model?, activate?} → 登记 (可选设默认)
pub async fn local_register(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let url = req["url"]
        .as_str()
        .map(|s| s.trim().trim_end_matches('/').to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_LOCAL_URL.to_string());
    if !url.starts_with("http://127.0.0.1")
        && !url.starts_with("http://localhost")
        && !url.starts_with("http://[::1]")
    {
        return Json(serde_json::json!({
            "ok": false,
            "error": "只允许本机地址 (127.0.0.1 / localhost / ::1); 远端服务请用常规 provider 登记"
        }));
    }
    let (reachable, installed) = match probe(&url) {
        Ok((_, m)) => (true, m),
        Err(e) => {
            return Json(serde_json::json!({
                "ok": false, "error": e,
                "note": "本机模型服务没起来就先别登记; 例如先 `ollama serve`"
            }))
        }
    };
    let model = req["model"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| installed.first().cloned())
        .unwrap_or_default();
    if model.is_empty() {
        return Json(serde_json::json!({
            "ok": false,
            "error": "本机服务可达但没装任何模型, 且未指定 model; 先 `ollama pull <小模型>`"
        }));
    }
    let mut cfg = bolloon_llm::config_store::load();
    bolloon_llm::config_store::upsert_custom(
        &mut cfg,
        LOCAL_PROVIDER_ID,
        "本地小模型",
        &url,
        Some(bolloon_llm::provider_registry::Protocol::Ollama),
        None,
        Some(&model),
    );
    let activate = req["activate"].as_bool().unwrap_or(false);
    if activate {
        bolloon_llm::config_store::set_active(&mut cfg, LOCAL_PROVIDER_ID);
    }
    if let Err(e) = bolloon_llm::config_store::save(&cfg) {
        return Json(serde_json::json!({ "ok": false, "error": format!("配置落盘失败: {e}") }));
    }
    st.reload_llm().await;
    Json(serde_json::json!({
        "ok": true, "provider_id": LOCAL_PROVIDER_ID, "base_url": url,
        "model": model, "reachable": reachable, "installed_models": installed,
        "active": activate,
        "note": "已登记进模型通路; 路由账本会把它当作一个可对比的 provider"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_loopback_is_allowed() {
        let ok = |s: &str| {
            s.starts_with("http://127.0.0.1")
                || s.starts_with("http://localhost")
                || s.starts_with("http://[::1]")
        };
        assert!(ok(DEFAULT_LOCAL_URL));
        assert!(ok("http://localhost:1234"));
        assert!(!ok("https://api.openai.com"));
    }

    #[test]
    fn probe_refuses_when_service_is_down() {
        // 用一个必然没人监听的端口; 断言"如实报错"而不是"假装可用"
        let r = probe("http://127.0.0.1:1");
        assert!(r.is_err(), "本机服务没起必须报错: {r:?}");
        assert!(r.unwrap_err().contains("没有响应"));
    }
}
