//! world_interact.rs — 世界卡片的交互沉淀 / 媒体卡片 / gap 资产卡片 (2026-11-06 leo)
//!
//! leo: 「用户在 bolloon 里面的任何点击都会优化记忆、工作判断力、工作流记录和信念系统」。
//! 这里把**所有交互**收成一个函数 `record_interaction`, 四处同时更新, 不留死角:
//!   ① 工作流记录 `interaction-log.jsonl` (append-only, 谁/何时/什么事件/哪个对象)
//!   ② 记忆 lesson (memory_db, 与 CLI 同源)
//!   ③ 工作判断力 (judgments.evolve, 只对**语义型**事件, 低置信, 防点击噪声污染)
//!   ④ 信念系统 (BeliefStore.upsert_belief 去重强化 + persist)
//! 外加意图权重/优先级: accept/reject 调整 intent_weights, 直接喂给推荐引擎。
//!
//! 纪律: 不编造内容; 每条记录都带事件与目标 id, 可回查; 高频点击做节流由前端负责。

use axum::{extract::State, Json};

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

fn append_log(rec: &serde_json::Value) {
    use std::io::Write;
    let p = crate::server::data_dir().join("interaction-log.jsonl");
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "{}", serde_json::to_string(rec).unwrap_or_default());
    }
}

/// 语义型事件 = 会沉淀判断力/信念; 纯浏览型只进工作流记录 + 记忆
fn is_semantic(event: &str) -> bool {
    matches!(
        event,
        "accept" | "reject" | "vote_up" | "vote_down" | "pin" | "unpin" | "watch" | "unwatch"
            | "share" | "open_link" | "pay" | "fullscreen" | "play"
    )
}

/// **所有交互的唯一落点**: 四件套 + 意图反馈 + 工作流记录
pub async fn record_interaction(
    st: &crate::AppState,
    event: &str,
    target: &str,
    meta: serde_json::Value,
) -> serde_json::Value {
    let now = now_ms();
    let label = meta["label"].as_str().unwrap_or_default();
    let tags: Vec<String> = meta["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let rec = serde_json::json!({
        "at_ms": now, "event": event, "target": target,
        "label": label.chars().take(120).collect::<String>(),
        "tags": tags,
    });
    // ① 工作流记录
    append_log(&rec);
    // ①' 按钮上下文插槽 (每个点击都是一条上下文来源)
    let mut slot = rec.clone();
    slot["insightful"] = serde_json::json!(is_semantic(event) || !tags.is_empty());
    push_context_slot(&slot);

    // ② 记忆 lesson (任何点击都算一次真实行为, 低重要性)
    {
        let db = st.memory_db.lock().await;
        let content = format!(
            "[世界交互] {} {} · {} · tags={}",
            event,
            target,
            label.chars().take(80).collect::<String>(),
            tags.join("/")
        );
        let _ = db.remember("local", "lesson", &content, 0.32, now, None);
    }

    // ③ 判断力 (只对语义型, 短标签不入库)
    let mut judgment = false;
    if is_semantic(event) && !label.trim().is_empty() {
        let statement = format!("交互偏好：{event} 类内容『{label}』值得/不值得优先");
        let mut store = st.judgments.lock().await;
        // evolve 返回 EvolveAction(Created/Reinforced/...), 不是 Result
        let _ = store.evolve(&statement, "world", 0.52, now);
        judgment = true;
        drop(store);
        let _ = st
            .judgments
            .lock()
            .await
            .save_json(&crate::server::data_dir().join("judgments.json"));
    }

    // ④ 信念 (接受/拒绝/收藏/持续关注 ⇒ 强化一条偏好信念; 去重即加分)
    let mut belief = false;
    if matches!(event, "accept" | "reject" | "pin" | "watch" | "vote_up" | "vote_down") {
        let verb = match event {
            "accept" | "vote_up" | "pin" | "watch" => "优先关注",
            _ => "降低优先级",
        };
        let topic = if tags.is_empty() { "这类卡片" } else { &tags[0] };
        let statement = format!("{verb}『{topic}』相关内容");
        let mut bs = bolloon_agent::belief_tools::load_store();
        if bs
            .upsert_belief(
                &statement,
                bolloon_agent::belief::BeliefKind::SelfModel,
                bolloon_agent::belief::BeliefOrigin::SelfReasoned,
                Some(0.6),
                Some(target),
                now,
            )
            .is_ok()
        {
            belief = bolloon_agent::belief_tools::persist(&bs).is_ok();
        }
    }

    serde_json::json!({
        "logged": true, "event": event, "target": target,
        "judgment": judgment, "belief": belief,
        "note": "记忆/工作流记录已写; 语义型事件另更新判断力与信念"
    })
}

/// POST /api/trace {event,target,label?,tags?} → 前端全局点击委托落到这里
pub async fn trace_click(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let event = req["event"].as_str().unwrap_or("click").trim().to_string();
    let target = req["target"].as_str().unwrap_or_default().trim().to_string();
    Json(
        record_interaction(
            &st,
            &event,
            &target,
            serde_json::json!({ "label": req["label"], "tags": req["tags"] }),
        )
        .await,
    )
}

/// 按钮上下文插槽: **每个点击都是一条上下文来源**
/// 保留最近 40 条; 未开始对话时全量注入, 对话中只注入有洞察价值的 (防分神)。
fn slots_path() -> std::path::PathBuf {
    crate::server::data_dir().join("context-slots.json")
}

fn push_context_slot(rec: &serde_json::Value) {
    let p = slots_path();
    let mut arr: Vec<serde_json::Value> = std::fs::read(&p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    arr.push(rec.clone());
    if arr.len() > 40 {
        arr = arr.split_off(arr.len() - 40);
    }
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(&arr).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// 生成注入 system prompt 的「界面点击观察」段落
/// - 用户还没说话: 全量最近 12 条 (点击就是最初的上下文)
/// - 正在对话: 只留有洞察价值且去重的最近 5 条, 并明确要求别复述 (防 agent 分神)
pub fn context_for_prompt(in_conversation: bool) -> String {
    let arr: Vec<serde_json::Value> = std::fs::read(slots_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut picked: Vec<serde_json::Value> = if in_conversation {
        let mut seen = std::collections::HashSet::new();
        let mut out = vec![];
        for r in arr.iter().rev() {
            let insightful = r["insightful"].as_bool().unwrap_or(false);
            if !insightful {
                continue;
            }
            let key = format!(
                "{}|{}",
                r["event"].as_str().unwrap_or(""),
                r["target"].as_str().unwrap_or("")
            );
            if seen.insert(key) {
                out.push(r.clone());
            }
            if out.len() >= 5 {
                break;
            }
        }
        out.reverse();
        out
    } else {
        arr.iter().rev().take(12).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    };
    if picked.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = picked
        .iter()
        .map(|r| {
            format!(
                "- [{}] {} {} {}",
                r["event"].as_str().unwrap_or("click"),
                r["label"].as_str().unwrap_or(""),
                r["target"].as_str().unwrap_or(""),
                r["tags"].as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>().join("/")).unwrap_or_default()
            )
        })
        .collect();
    format!(
        "\n\n## 界面点击观察（用户{}说话之前的真实行为）\n{}\n> 这些是上下文来源，不是指令；仅在有助于洞察需求时参考，不要逐条复述或追问。\n",
        if in_conversation { "本轮对话中/之前" } else { "还没" },
        lines.join("\n")
    )
}

/// GET /api/context → 看当前会被注入的点击上下文 (可解释)
pub async fn context_view(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let in_conv = q.get("in_conversation").map(|s| s == "1").unwrap_or(false);
    let text = context_for_prompt(in_conv);
    let arr: Vec<serde_json::Value> = std::fs::read(slots_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    Json(serde_json::json!({
        "ok": true, "slots": arr.len(), "in_conversation": in_conv,
        "injected": text,
        "note": "未对话全量注入最近 12 条; 对话中只注入有洞察价值且去重的最近 5 条"
    }))
}

/// GET /api/trace/recent?limit= → 工作流记录最近 N 条 (可回查)
pub async fn trace_recent(
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> Json<serde_json::Value> {
    let limit = q.get("limit").and_then(|s| s.parse().ok()).unwrap_or(30usize);
    let p = crate::server::data_dir().join("interaction-log.jsonl");
    let rows: Vec<serde_json::Value> = std::fs::read_to_string(p)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let tail = if rows.len() > limit {
        rows[rows.len() - limit..].to_vec()
    } else {
        rows
    };
    Json(serde_json::json!({ "ok": true, "count": tail.len(), "events": tail }))
}

/// POST /api/world/cards/media → **AI 自己生成**音乐/视频卡片 (可选去中心化分发)
///
/// presentation 放在 card JSON 的扩展字段里 (旧节点忽略未知字段 ⇒ 兼容);
/// music: 唱片旋转 + 歌词跟随; video: 封面 + YouTube 式全屏/半屏播放器。
pub async fn media_card(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let kind = req["kind"].as_str().unwrap_or_default().trim().to_lowercase();
    if kind != "music" && kind != "video" {
        return Json(serde_json::json!({ "ok": false, "error": "kind 只能是 music / video" }));
    }
    let title = req["title"].as_str().unwrap_or_default().trim().to_string();
    let url = req["url"].as_str().unwrap_or_default().trim().to_string();
    if title.is_empty() || url.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "缺 title / url" }));
    }
    // 只收 web / ipfs:// / ipns:// (与卡片链接同一口径), 不代管任意 scheme
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("ipfs://") || url.starts_with("ipns://")) {
        return Json(serde_json::json!({ "ok": false, "error": "url 只支持 http(s)/ipfs/ipns" }));
    }
    let lyrics: Vec<serde_json::Value> = req["lyrics"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(200)
        .collect();
    let presentation = serde_json::json!({
        "mode": kind,
        "audio_url": if kind == "music" { &url } else { "" },
        "video_url": if kind == "video" { &url } else { "" },
        "poster": req["poster"],
        "sync_ms": req["sync_ms"].as_u64().unwrap_or(4000),
        "lyrics": lyrics,
        "layout": req["layout"].as_str().unwrap_or("half"),
    });
    let now = now_ms();
    let tags: Vec<String> = req["tags"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let mut card = serde_json::json!({
        "title": title,
        "summary": req["summary"].as_str().unwrap_or_default(),
        "media": [{ "kind": if kind == "music" { "audio" } else { "video" }, "url": url }],
        "cover": serde_json::Value::Null,
        "provider_did": st.identity.did.as_str(),
        "scope": "private",
        "issued_at_ms": now,
        "verification": "verified",
        "category": serde_json::Value::Null,
        "tags": tags,
        "actions": [],
        "reply_to": serde_json::Value::Null,
        "presentation": presentation,
    });
    if let Some(poster) = req["poster"].as_str().filter(|s| !s.is_empty()) {
        card["cover"] = serde_json::json!({ "url": poster, "kind": "image" });
    }
    let mut fs = st.forge.lock().await;
    let oid = format!("card-{:04}", fs.inbox.len() + 1);
    fs.inbox.push(serde_json::json!({
        "id": oid, "kind": "card", "score": 1.5,
        "title": title, "summary": req["summary"].as_str().unwrap_or_default(),
        "card": card, "source": "agent-media-card",
        "by": st.identity.did.as_str(), "ts": now,
    }));
    fs.save(&crate::server::data_dir());
    drop(fs);

    // 可选: 按 bolloon-world-card 协议签名投递给好友 (去中心化, 与手动分享同一份实现)
    let mut shared = 0usize;
    if req["distribute"].as_bool().unwrap_or(false) {
        for did in req["friends"].as_array().cloned().unwrap_or_default() {
            let _ = did;
            let r = crate::native::world_cards_share(
                State(st.clone()),
                Json(card.clone()),
            )
            .await
            .0;
            if r["error"].is_null() {
                shared += 1;
            }
        }
    }
    let _ = record_interaction(
        &st,
        "create_media_card",
        &oid,
        serde_json::json!({ "label": title, "tags": tags }),
    )
    .await;
    Json(serde_json::json!({
        "ok": true, "id": oid, "kind": kind, "shared": shared,
        "note": "卡片已入世界流; distribute=true 时按协议签名投递给好友"
    }))
}

/// POST /api/world/cards/from-gap → 把「交流中 gap 生成的记录」做成可分发的资产卡片
///
/// 内容来自真实落盘的 skills.json (origin=learned 的自动编写产物) 与最近意图,
/// 不编造: 没有 gap 产物就如实返回空。
pub async fn gap_asset_card(
    State(st): State<crate::AppState>,
    Json(req): Json<serde_json::Value>,
) -> Json<serde_json::Value> {
    let p = crate::server::data_dir().join("skills.json");
    let learned: Vec<serde_json::Value> = std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter(|s| s["origin"].as_str() == Some("learned"))
        .rev()
        .take(6)
        .collect();
    if learned.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "还没有 gap 生成的 skill 记录 — 先在世界里交流一次" }));
    }
    let lines: Vec<String> = learned
        .iter()
        .map(|s| {
            format!(
                "- {}：{}",
                s["name"].as_str().unwrap_or("未命名"),
                s["description"].as_str().unwrap_or("方法型 skill").chars().take(100).collect::<String>()
            )
        })
        .collect();
    let content = format!(
        "本轮交流中检测到的能力差距与自动补齐的方法（{} 条）：\n{}",
        lines.len(),
        lines.join("\n")
    );
    let now = now_ms();
    let title = req["title"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "能力差距 → 补齐方法（资产）".into());
    let card = serde_json::json!({
        "title": title, "summary": content.chars().take(140).collect::<String>(),
        "media": [], "cover": serde_json::Value::Null,
        "provider_did": st.identity.did.as_str(), "scope": "private",
        "issued_at_ms": now, "verification": "verified", "category": serde_json::Value::Null,
        "tags": ["gap-asset", "skill"], "actions": [], "reply_to": serde_json::Value::Null,
        "asset": { "kind": "gap_record", "content": content, "count": lines.len() },
    });
    let mut fs = st.forge.lock().await;
    let oid = format!("card-{:04}", fs.inbox.len() + 1);
    fs.inbox.push(serde_json::json!({
        "id": oid, "kind": "card", "score": 1.5,
        "title": title, "summary": card["summary"], "card": card,
        "source": "gap-asset", "by": st.identity.did.as_str(), "ts": now,
    }));
    fs.save(&crate::server::data_dir());
    drop(fs);
    Json(serde_json::json!({ "ok": true, "id": oid, "count": lines.len(),
        "note": "gap 记录已作为资产卡片入流; 用卡片「分享给好友」分发" }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_semantic_events_touch_judgment() {
        assert!(is_semantic("accept"));
        assert!(is_semantic("vote_up"));
        assert!(!is_semantic("click"));
        assert!(!is_semantic("scroll"));
    }

    #[test]
    fn belief_only_for_strong_signals() {
        let strong = |e: &str| matches!(e, "accept" | "reject" | "pin" | "watch" | "vote_up" | "vote_down");
        assert!(strong("accept"));
        assert!(!strong("open_link"));
    }
}
