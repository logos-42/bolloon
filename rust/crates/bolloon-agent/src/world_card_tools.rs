//! world_card_tools.rs — 让 AI **自己**生成并分发世界媒体卡片 (2026-11-06 leo)
//!
//! 只打本机内嵌服务的一个白名单端点 (`/api/world/cards/media`), 不开放任意 POST:
//! - host 恒 `127.0.0.1`, port 只从 `BOLLOON_WEB_PORT` 读 (默认 54188)
//! - 字段白名单, 其余一律丢弃; distribute 默认 false (分发要显式要求)
//! - 失败如实回错误, 不假装成功

use bolloon_harness::{EffectKind, ToolDef};

pub fn world_card_tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "world_card_publish".into(),
        description: "生成一张世界媒体卡片（音乐/视频）并可去中心化分发给好友。音乐卡片有唱片动效与歌词跟随，视频卡片有封面与全屏/半全屏播放。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "kind": { "type": "string", "enum": ["music", "video"], "description": "卡片类型" },
                "title": { "type": "string", "description": "卡片标题" },
                "url": { "type": "string", "description": "http(s)/ipfs:// 音频或视频地址" },
                "summary": { "type": "string", "description": "一句话摘要" },
                "lyrics": { "type": "array", "items": { "type": "string" }, "description": "音乐卡片歌词（每行一句）" },
                "poster": { "type": "string", "description": "视频封面图片地址（可选）" },
                "sync_ms": { "type": "integer", "description": "歌词每句毫秒数（默认 4000）" },
                "distribute": { "type": "boolean", "description": "true 才按协议签名投递给好友" },
                "friends": { "type": "array", "items": { "type": "string" }, "description": "分发目标（留空由服务端按已授权好友处理）" }
            },
            "required": ["kind", "title", "url"]
        }),
        effect: EffectKind::Write,
        default_allowed: false,
    }]
}

fn done(ok: bool, output: String) -> bolloon_harness::ToolResult {
    bolloon_harness::ToolResult {
        ok, output, elapsed_ms: 0, verified: Some(ok), evidence: None,
    }
}
fn fail(msg: &str) -> bolloon_harness::ToolResult {
    done(false, msg.to_string())
}

/// 工具执行 (由 BuiltinExecutor 分发)
pub fn execute(call: &crate::ToolCall) -> bolloon_harness::ToolResult {
    let a = &call.arguments;
    let kind = a["kind"].as_str().unwrap_or_default().trim().to_lowercase();
    let title = a["title"].as_str().unwrap_or_default().trim().to_string();
    let url = a["url"].as_str().unwrap_or_default().trim().to_string();
    if (kind != "music" && kind != "video") || title.is_empty() || url.is_empty() {
        return fail("缺 kind(music/video) / title / url");
    }
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("ipfs://") || url.starts_with("ipns://")) {
        return fail("url 只支持 http(s)/ipfs/ipns");
    }
    let mut body = serde_json::json!({
        "kind": kind, "title": title, "url": url,
        "summary": a["summary"].as_str().unwrap_or(""),
    });
    if let Some(ly) = a["lyrics"].as_array() {
        body["lyrics"] = serde_json::json!(ly.iter().filter_map(|v| v.as_str()).take(200).collect::<Vec<_>>());
    }
    if let Some(p) = a["poster"].as_str().filter(|s| !s.is_empty()) {
        body["poster"] = serde_json::json!(p);
    }
    if let Some(s) = a["sync_ms"].as_u64() {
        body["sync_ms"] = serde_json::json!(s);
    }
    // 分发必须显式要求
    if a["distribute"].as_bool() == Some(true) {
        body["distribute"] = serde_json::json!(true);
        if let Some(f) = a["friends"].as_array() {
            body["friends"] = serde_json::json!(f.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>());
        }
    }
    let port = std::env::var("BOLLOON_WEB_PORT").ok().and_then(|s| s.parse::<u16>().ok()).unwrap_or(54188);
    let endpoint = format!("http://127.0.0.1:{port}/api/world/cards/media");
    match ureq::post(&endpoint)
        .timeout(std::time::Duration::from_secs(10))
        .send_json(body)
    {
        Ok(resp) => {
            let v: serde_json::Value = resp.into_json().unwrap_or(serde_json::json!({"ok": false, "error": "响应不是 JSON"}));
            if v["ok"] == serde_json::json!(true) {
                done(true, format!("卡片 {} 已生成；分发 {} 位", v["id"].as_str().unwrap_or(""), v["shared"].as_u64().unwrap_or(0)))
            } else {
                done(false, format!("生成被拒: {}", v["error"].as_str().unwrap_or("未知")))
            }
        }
        Err(e) => done(false, format!("本机内嵌服务不可达 ({endpoint}): {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn def_is_not_default_allowed() {
        let defs = world_card_tool_defs();
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "world_card_publish");
        assert!(!defs[0].default_allowed, "发布卡片不能默认放行");
    }

    #[test]
    fn rejects_bad_input_without_network() {
        let call = crate::ToolCall {
            id: "t1".into(),
            name: "world_card_publish".into(),
            arguments: serde_json::json!({ "kind": "music", "title": "", "url": "" }),
        };
        assert!(!execute(&call).ok);
    }
}
