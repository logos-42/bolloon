//! specialize.rs — 特化包 (阶段2) 与外溢 (阶段3), 2026-11-06
//!
//! 不训小模型。特化 = **任务契约**: persona + skill 文本 + 工具白名单 + 固定评测用例。
//! 价值由评测数据证明: 同一个评测集上, 特化包 vs 通用 agent 的命中率/延迟/成本差多少。
//!
//! 纪律: ① 每条评测都写**真实调用**进路由账本 (task 标签 = `pack:<id>` / `base:<id>`);
//! ② 成本目前由账本的 cost 列给出 (免费档为 0 时如实写 0, 不编数字);
//! ③ 外溢只复用现有 skill 分享 / x402 付费卡片通道, 不新造协议;
//! ④ "有没有人真用真付钱"看卡片接收与 x402 订单, 本机不伪造结果。

use axum::{extract::State, Json};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EvalCase {
    pub input: String,
    /// 期望回复里出现的关键词 (任一命中即算命中; 确定性检查, 不让模型自评)
    #[serde(default)]
    pub expect_keywords: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SpecialPack {
    pub id: String,
    /// 语义任务标签 (写代码 / 整理日记 / 读论文 / 发帖 / 交易 ...)
    pub task: String,
    pub persona: String,
    pub skill_text: String,
    #[serde(default)]
    pub tool_allowlist: Vec<String>,
    #[serde(default)]
    pub eval_cases: Vec<EvalCase>,
    pub created_at_ms: u64,
}

fn path() -> std::path::PathBuf {
    crate::server::data_dir().join("special-packs.json")
}

fn load() -> Vec<SpecialPack> {
    std::fs::read(path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save(packs: &[SpecialPack]) -> Result<(), String> {
    let p = path();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(packs).unwrap_or_default())
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

/// GET /api/specialize/packs
pub async fn list_packs() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "ok": true, "packs": load() }))
}

/// POST /api/specialize/packs {id,task,persona,skill_text,tool_allowlist,eval_cases}
pub async fn upsert_pack(Json(req): Json<serde_json::Value>) -> Json<serde_json::Value> {
    let pack: SpecialPack = match serde_json::from_value(serde_json::json!({
        "id": req["id"], "task": req["task"], "persona": req["persona"],
        "skill_text": req["skill_text"], "tool_allowlist": req["tool_allowlist"],
        "eval_cases": req["eval_cases"], "created_at_ms": now_ms(),
    })) {
        Ok(p) => p,
        Err(e) => return Json(serde_json::json!({ "ok": false, "error": format!("包格式错误: {e}") })),
    };
    if pack.id.trim().is_empty() || pack.task.trim().is_empty() || pack.eval_cases.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 id / task / eval_cases（没有评测集不许自称特化）" }));
    }
    if pack.eval_cases.len() > 10 {
        return Json(serde_json::json!({ "ok": false, "error": "评测用例上限 10 条" }));
    }
    // 工具白名单只认**真实存在**的工具名 (不收编造的工具)
    let known: Vec<String> = bolloon_agent::builtin_tools::builtin_tool_defs()
        .into_iter()
        .map(|d| d.name)
        .collect();
    let unknown: Vec<&String> = pack
        .tool_allowlist
        .iter()
        .filter(|n| !known.contains(n))
        .collect();
    if !unknown.is_empty() {
        return Json(serde_json::json!({
            "ok": false, "error": format!("白名单里有不认识的工具: {unknown:?}")
        }));
    }
    let mut packs = load();
    packs.retain(|p| p.id != pack.id);
    let cases = pack.eval_cases.len();
    packs.push(pack.clone());
    if let Err(e) = save(&packs) {
        return Json(serde_json::json!({ "ok": false, "error": e }));
    }
    Json(serde_json::json!({ "ok": true, "id": pack.id, "task": pack.task, "eval_cases": cases }))
}

fn hit(input_ok: bool, reply: &str, kws: &[String]) -> bool {
    input_ok
        && (kws.is_empty()
            || kws
                .iter()
                .any(|k| reply.to_lowercase().contains(&k.to_lowercase())))
}

fn current_provider() -> String {
    let cfg = bolloon_llm::config_store::load();
    if !cfg.active_provider.trim().is_empty() {
        cfg.active_provider
    } else {
        "unknown".into()
    }
}

/// POST /api/specialize/eval {id} → 同一评测集上 baseline vs 特化包 (真实调用, 各写账本)
pub async fn eval_pack(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().trim().to_string();
    let pack = match load().into_iter().find(|p| p.id == id) {
        Some(p) => p,
        None => return Json(serde_json::json!({ "ok": false, "error": format!("没有这个特化包: {id}") })),
    };
    let provider = current_provider();
    let mut base = Vec::new();
    let mut spec = Vec::new();
    for case in &pack.eval_cases {
        for (label, system, bucket) in [
            (
                format!("base:{}", pack.task),
                String::new(),
                &mut base,
            ),
            (
                format!("pack:{}", pack.task),
                format!("{}\n\n{}", pack.persona, pack.skill_text),
                &mut spec,
            ),
        ] {
            let msg = bolloon_llm::ChatMessage {
                role: "user".into(),
                content: case.input.clone(),
                name: None,
                tool_call_id: None,
                tool_calls: None,
                images: vec![],
                reasoning_content: None,
            };
            // 语义 task 标签直接走 EconCtx.surface: 同一行账本同时带标签与真实成本,
            // 不再另写一行 marker (否则矩阵会双计调用次数)。
            let econ = crate::native::EconCtx {
                intent_id: format!("eval-{}", pack.id),
                group_id: None,
                agent_id: None,
                surface: label.clone(),
                bill_did: None,
            };
            let t = std::time::Instant::now();
            let r = crate::native::call_model_metered(&st, &system, vec![msg], Some(econ)).await;
            let latency = t.elapsed().as_millis() as u64;
            let ok = r.is_ok();
            let reply = r.unwrap_or_default();
            bucket.push(serde_json::json!({
                "input": case.input.chars().take(80).collect::<String>(),
                "ok": ok,
                "hit": hit(ok, &reply, &case.expect_keywords),
                "latency_ms": latency,
                "reply_head": reply.chars().take(120).collect::<String>(),
            }));
        }
    }
    let stat = |v: &Vec<serde_json::Value>| {
        let n = v.len() as f64;
        let hits = v.iter().filter(|x| x["hit"] == serde_json::json!(true)).count();
        let lat: u64 = v.iter().map(|x| x["latency_ms"].as_u64().unwrap_or(0)).sum();
        serde_json::json!({
            "cases": v.len(),
            "hit": hits,
            "hit_rate": if n == 0.0 { 0.0 } else { hits as f64 / n },
            "avg_latency_ms": if n == 0.0 { 0 } else { (lat as f64 / n) as u64 },
            "ok": v.iter().filter(|x| x["ok"] == serde_json::json!(true)).count(),
        })
    };
    let (b, s) = (stat(&base), stat(&spec));
    let verdict = if s["hit_rate"].as_f64().unwrap_or(0.0) > b["hit_rate"].as_f64().unwrap_or(0.0) {
        "特化包更准"
    } else if s["hit_rate"] == b["hit_rate"] {
        "打平 (别急着外溢)"
    } else {
        "特化包更差 (不要外溢, 先改 persona/skill)"
    };
    Json(serde_json::json!({
        "ok": true, "id": pack.id, "task": pack.task, "provider": provider,
        "baseline": b, "pack": s, "cases_base": base, "cases_pack": spec,
        "verdict": verdict,
        "note": "命中=期望关键词任一出现; 成本见路由账本(免费档为0时不编数字); 换 provider 或本地小模型后重跑即可对比"
    }))
}

/// POST /api/specialize/run {id, text} → 用特化包跑一次**带白名单的真实回合**
///
/// 与 eval 的区别: eval 只测 prompt 特化(不跑工具); run 走完整 KernelLoop,
/// `allowlist_harness` 只注册/只发/只授白名单工具 —— 白名单在这里是真门。
pub async fn run_pack(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().trim().to_string();
    let text = req["text"].as_str().unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 text" }));
    }
    let pack = match load().into_iter().find(|p| p.id == id) {
        Some(p) => p,
        None => return Json(serde_json::json!({ "ok": false, "error": format!("没有这个特化包: {id}") })),
    };
    let sid = format!("pack-run-{}", now_ms());
    let cancel = st.chat_runs.begin(&sid);
    let opts = crate::native::TurnOptions {
        session_id: sid.clone(),
        extra_system: format!("{}\n\n{}", pack.persona, pack.skill_text),
        tool_allowlist: Some(pack.tool_allowlist.clone()),
        max_turns: 2,
        tool_budget: 3,
        surface: "specialize",
        ..Default::default()
    };
    let allow = pack.tool_allowlist.clone();
    let r = crate::native::reply_with_agent_cfg(&st, &text, None, opts, None, cancel).await;
    st.chat_runs.finish(&sid, "Finished", "");
    let (ok, reply) = match r {
        Ok(t) => (true, t),
        Err(e) => (false, e),
    };
    Json(serde_json::json!({
        "ok": ok, "reply": reply, "id": pack.id, "task": pack.task,
        "tool_allowlist": allow,
        "note": "白名单在 harness 层生效: schema 里看不到白名单外工具, permission 也没授予"
    }))
}

/// POST /api/specialize/share {id, price_atomic?, agent_id?} → 外溢 (阶段3)
///
/// 免费: 用 `bolloon-world-card` 协议把 pack 定义签名投给好友 (复用 world_cards_share)。
/// 付费: 复用 x402 付费卡片 (agent_card_paid), 内容 = pack JSON, 对方付款验链后才拿到。
pub async fn share_pack(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let id = req["id"].as_str().unwrap_or_default().trim().to_string();
    let pack = match load().into_iter().find(|p| p.id == id) {
        Some(p) => p,
        None => return Json(serde_json::json!({ "ok": false, "error": format!("没有这个特化包: {id}") })),
    };
    let content = serde_json::to_string_pretty(&pack).unwrap_or_default();
    let price_atomic = req["price_atomic"].as_u64().unwrap_or(0);
    if price_atomic > 0 {
        let mut agent_id = req["agent_id"]
            .as_str()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default();
        if agent_id.is_empty() {
            let fs = st.forge.lock().await;
            agent_id = fs.agents.first().map(|a| a.id.clone()).unwrap_or_default();
        }
        if agent_id.is_empty() {
            return Json(serde_json::json!({ "ok": false, "error": "没有智能体可发布付费卡片" }));
        }
        let r = crate::native::agent_card_paid(
            State(st.clone()),
            axum::extract::Path(agent_id),
            Json(serde_json::json!({
                "title": format!("特化包 {}", pack.task),
                "summary": format!("persona + skill + 工具白名单 + {} 条评测", pack.eval_cases.len()),
                "content": content,
                "price_atomic": price_atomic,
                "tags": ["specialize", pack.task],
            })),
        )
        .await
        .0;
        return Json(serde_json::json!({
            "ok": r["ok"] == serde_json::json!(true), "mode": "x402_paid",
            "card_id": r["id"], "item_id": r["item_id"], "error": r["error"],
            "note": "已入世界流并带支付按钮; 有没有人真付钱看 /api/x402/orders 与 friend-audit"
        }));
    }
    let card = bolloon_agent::world::WorldCard {
        title: format!("特化包 {}", pack.task),
        summary: format!("{} 条评测用例, 可导入后自己重跑", pack.eval_cases.len()),
        media: vec![],
        cover: None,
        provider_did: st.identity.did.as_str().into(),
        provider_name: None,
        scope: bolloon_agent::world::CardScope::Private,
        issued_at_ms: now_ms(),
        verification: bolloon_agent::world::CardVerification::Verified,
        category: None,
        tags: vec!["specialize".into(), pack.task.clone()],
        actions: vec![],
        reply_to: None,
    };
    let mut v = serde_json::to_value(&card).unwrap_or(serde_json::Value::Null);
    v["pack"] = serde_json::to_value(&pack).unwrap_or(serde_json::Value::Null);
    let r = crate::native::world_cards_share(State(st), Json(v)).await.0;
    Json(serde_json::json!({
        "ok": r["error"].is_null(), "mode": "signed_card", "delivery": r,
        "note": "按 bolloon-world-card 协议签名投递给好友; 有没有人真用看对方是否导入并跑评测"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_is_deterministic() {
        assert!(hit(true, "先用最小版本再扩展", &["最小版本".into()]));
        assert!(!hit(true, "随便写点别的", &["最小版本".into()]));
        assert!(!hit(false, "最小版本", &["最小版本".into()]), "调用失败不算命中");
    }

    #[test]
    fn empty_keywords_count_as_hit_only_when_call_succeeded() {
        assert!(hit(true, "anything", &[]));
        assert!(!hit(false, "", &[]));
    }
}
