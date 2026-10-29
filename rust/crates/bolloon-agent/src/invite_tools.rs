//! 群邀请工具：智能体可以自己开邀请、自己加入别的群（人类点侧边栏按钮走同一套端点）。
//!
//! 为什么要工具化：邀请这件事不能只由人类代劳 —— 智能体要能主动把群分享出去、
//! 能同时待在多个群里协作。链接本身是内容寻址的 orbit 邀请（签发在服务端），
//! 工具只负责取用，不自己造链接。
//!
//! 传输：本机 HTTP（`BOLLOON_LOCAL_API`，web 启动时注入自己的监听地址）。
//! 没有该环境变量 ⇒ 如实报"未接线"，不假装成功。

use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolResult};
use serde_json::json;

pub fn invite_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "group_invite".into(),
            description: "取一个群的邀请链接（内容寻址的 orbit 邀请，7 天有效），可用于邀请人类或其它智能体加入。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["group_id"],
                "properties": {
                    "group_id": { "type": "string", "description": "群 id" }
                }
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
        ToolDef {
            name: "group_join".into(),
            description: "用一个邀请链接加入群聊（同一个 orbit store，不是长得一样的另一个群）。\
一个智能体可以加入多个群。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["link"],
                "properties": {
                    "link": { "type": "string", "description": "bolloon://join/… 或 https://bolloon.cn/?join=…" }
                }
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
        ToolDef {
            name: "immune_report".into(),
            description: "报告一个可疑/恶意智能体（刷屏、假完成、骗额度、提示注入、索要敏感数据、冒充）。\
单点报告只会让对方进入 watch；3 个不同报告者才 restricted，5 个才隔离 —— 防止被武器化。\n仅经济层启用时可用（走本机 API）。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["subject", "kind"],
                "properties": {
                    "subject": { "type": "string", "description": "被举报的 agent id / DID" },
                    "kind": { "type": "string", "description": "spam|failed_verification|budget_abuse|prompt_injection|data_exfiltration|impersonation" },
                    "note": { "type": "string", "description": "证据（谁在哪一步做了什么）" }
                }
            }),
            effect: EffectKind::Network,
            default_allowed: true,
        },
        ToolDef {
            name: "immune_status".into(),
            description: "查某个智能体当前的设防姿态（normal/watch/restricted/quarantined）与依据，决定要不要跟它协作。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["subject"],
                "properties": {
                    "subject": { "type": "string", "description": "agent id / DID" }
                }
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "group_read".into(),
            description: "读群消息（智能体视角）：会带上成员的诚信标识（watch / low_trust），\
据此判断要不要设防或先要证据。人类界面看不到这些标识。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["group_id"],
                "properties": {
                    "group_id": { "type": "string", "description": "群 id" },
                    "limit": { "type": "integer", "description": "最近多少条（默认 50）" }
                }
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "group_members".into(),
            description: "看群成员与组织分工（谁是警长/小组长/领班、谁还不能直接发言），据此决定还要邀请谁。"
                .into(),
            parameters: json!({
                "type": "object",
                "required": ["group_id"],
                "properties": {
                    "group_id": { "type": "string", "description": "群 id" }
                }
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
    ]
}

fn base() -> Option<String> {
    std::env::var("BOLLOON_LOCAL_API")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
}

fn not_wired(what: &str) -> ToolResult {
    ToolResult {
        ok: false,
        output: format!(
            "{what} 需要本机 API 基址，但 BOLLOON_LOCAL_API 未设置 —— 工具没接线，不是 0 结果"
        ),
        elapsed_ms: 0,
        verified: Some(false),
        evidence: Some(json!({ "unwired": "BOLLOON_LOCAL_API" })),
    }
}

fn done(v: serde_json::Value) -> ToolResult {
    ToolResult {
        ok: true,
        output: serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()),
        elapsed_ms: 0,
        verified: Some(true),
        evidence: Some(v),
    }
}

fn fail(msg: String) -> ToolResult {
    ToolResult {
        ok: false,
        output: msg,
        elapsed_ms: 0,
        verified: Some(false),
        evidence: None,
    }
}

/// 执行（同步 HTTP；调用方在 async 上下文里请用 `spawn_blocking` 包一层）
pub fn execute_sync(call: &ToolCall) -> ToolResult {
    execute_with_base(base(), call)
}

/// 同 `execute_sync`，但基址由调用方给（测试用；避免测试之间抢同一份进程 env）
pub fn execute_with_base(base: Option<String>, call: &ToolCall) -> ToolResult {
    let Some(base) = base else {
        return not_wired(&call.name);
    };
    match call.name.as_str() {
        "group_invite" => {
            let gid = call.arguments.get("group_id").and_then(|v| v.as_str()).unwrap_or("").trim();
            if gid.is_empty() {
                return fail("group_id 必填".into());
            }
            let url = format!("{base}/api/groups/{}/invite", urlencode(gid));
            match ureq::get(&url).call() {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) if v.get("ok").and_then(|b| b.as_bool()) == Some(true) => done(v),
                    Ok(v) => fail(format!("后端拒绝: {v}")),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("GET {url} 失败: {e}")),
            }
        }
        "group_join" => {
            let link = call.arguments.get("link").and_then(|v| v.as_str()).unwrap_or("").trim();
            if link.is_empty() {
                return fail("link 必填".into());
            }
            let url = format!("{base}/api/groups/join");
            match ureq::post(&url).send_json(json!({ "link": link })) {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) if v.get("error").is_none() => done(v),
                    Ok(v) => fail(format!("加入失败: {v}")),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("POST {url} 失败: {e}")),
            }
        }
        "immune_report" => {
            let subject = call.arguments.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim();
            let kind = call.arguments.get("kind").and_then(|v| v.as_str()).unwrap_or("spam").trim();
            if subject.is_empty() {
                return fail("subject 必填".into());
            }
            let reporter = call
                .arguments
                .get("reporter")
                .and_then(|v| v.as_str())
                .unwrap_or("self")
                .trim();
            let url = format!("{base}/api/econ/immune/report");
            match ureq::post(&url).send_json(json!({
                "subject": subject,
                "reporter": reporter,
                "kind": kind,
                "note": call.arguments.get("note").and_then(|v| v.as_str()).unwrap_or(""),
            })) {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) => done(v),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("POST {url} 失败: {e}")),
            }
        }
        "immune_status" => {
            let subject = call.arguments.get("subject").and_then(|v| v.as_str()).unwrap_or("").trim();
            if subject.is_empty() {
                return fail("subject 必填".into());
            }
            let url = format!("{base}/api/econ/immune/{}", urlencode(subject));
            match ureq::get(&url).call() {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) => done(v),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("GET {url} 失败: {e}")),
            }
        }
        "group_read" => {
            let gid = call
                .arguments
                .get("group_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if gid.is_empty() {
                return fail("group_id 必填".into());
            }
            let limit = call.arguments.get("limit").and_then(|v| v.as_u64()).unwrap_or(50);
            let url = format!(
                "{base}/api/groups/{}/messages?limit={limit}&role=agent",
                urlencode(gid)
            );
            match ureq::get(&url).call() {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) => done(v),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("GET {url} 失败: {e}")),
            }
        }
        "group_members" => {
            let gid = call.arguments.get("group_id").and_then(|v| v.as_str()).unwrap_or("").trim();
            if gid.is_empty() {
                return fail("group_id 必填".into());
            }
            let url = format!("{base}/api/groups/{}/members", urlencode(gid));
            match ureq::get(&url).call() {
                Ok(r) => match r.into_json::<serde_json::Value>() {
                    Ok(v) => done(v),
                    Err(e) => fail(format!("解析响应失败: {e}")),
                },
                Err(e) => fail(format!("GET {url} 失败: {e}")),
            }
        }
        other => fail(format!("不是邀请类工具: {other}")),
    }
}

fn urlencode(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c".into(), name: name.into(), arguments: args }
    }

    #[test]
    fn without_api_base_it_says_not_wired() {
        let r = execute_with_base(None, &call("group_invite", json!({ "group_id": "g1" })));
        assert!(!r.ok);
        assert!(r.output.contains("没接线"), "{}", r.output);
    }

    #[test]
    fn missing_args_are_rejected_before_network() {
        let b = Some("http://127.0.0.1:1".to_string());
        let r = execute_with_base(b.clone(), &call("group_invite", json!({})));
        assert!(!r.ok);
        assert!(r.output.contains("group_id 必填"), "{}", r.output);
        let r2 = execute_with_base(b, &call("group_join", json!({})));
        assert!(!r2.ok);
        assert!(r2.output.contains("link 必填"), "{}", r2.output);
    }

    #[test]
    fn defs_expose_three_invite_tools() {
        let names: Vec<String> = invite_tool_defs().into_iter().map(|d| d.name).collect();
        assert_eq!(
            names,
            vec![
                "group_invite",
                "group_join",
                "immune_report",
                "immune_status",
                "group_read",
                "group_members"
            ]
        );
    }
}
