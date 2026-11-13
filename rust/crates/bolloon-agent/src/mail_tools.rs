//! `mail_*` 工具族 —— Agent 自主读写邮件的入口。
//!
//! 纪律:
//! - 工具只做「参数解析 → 调 MailService → 序列化结果」, 不在这里写业务判断;
//! - 批量 / 凭据外发的硬拒在 `crate::mail::service::check_send_guard`, 任何工具参数都绕不过;
//! - 未注入 `MailService` 时**如实说未接线**, 绝不返回空成功。

use std::sync::Arc;

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use serde_json::{json, Value};

use crate::mail::{MailDraft, MailId, MailQuery, MailService};

fn result(ok: bool, output: String, evidence: Option<Value>, started: std::time::Instant) -> ToolResult {
    ToolResult {
        ok,
        output,
        elapsed_ms: started.elapsed().as_millis() as u64,
        verified: Some(ok),
        evidence,
    }
}

fn not_wired(tool: &str, started: std::time::Instant) -> ToolResult {
    result(
        false,
        format!("{tool} 未接线：这次会话没有注入邮件服务(没配账号或未启用)，不是「没有邮件」"),
        Some(json!({ "mail": "not_wired", "tool": tool })),
        started,
    )
}

/// 邮件工具定义（注册进 `builtin_tool_defs()`）
pub fn mail_tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "mail_accounts".into(),
            description: "列出本机已配置的邮件账号与同步游标。只读。".into(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "mail_search".into(),
            description: "在本地邮件索引里检索（不联网）。可按账号/邮箱夹/未读/关键词过滤。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "account": { "type": "string", "description": "账号，可选" },
                    "mailbox": { "type": "string", "description": "邮箱夹，如 INBOX，可选" },
                    "unread_only": { "type": "boolean", "description": "只看未读，可选" },
                    "keyword": { "type": "string", "description": "主题/发件人/摘要关键词，可选" },
                    "limit": { "type": "integer", "description": "最多返回条数，默认 20" }
                },
                "additionalProperties": false
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "mail_read".into(),
            description: "读取一封邮件的正文（本地有缓存就用缓存，没有则向账号拉取一次）。只读。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "邮件 id（形如 account/INBOX/uid）" }
                },
                "required": ["id"],
                "additionalProperties": false
            }),
            effect: EffectKind::Read,
            default_allowed: true,
        },
        ToolDef {
            name: "mail_sync".into(),
            description: "向已配置账号拉取增量邮件并写本地索引。联网。".into(),
            parameters: json!({
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }),
            effect: EffectKind::Network,
            default_allowed: false,
        },
        ToolDef {
            name: "mail_send".into(),
            description: "发送一封邮件。硬约束：只允许单收件人；正文含密码/OTP/私钥/卡号会被拒绝。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "account": { "type": "string", "description": "用哪个账号发" },
                    "to": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "收件人（只允许 1 个）"
                    },
                    "subject": { "type": "string" },
                    "text": { "type": "string", "description": "正文纯文本" },
                    "in_reply_to": { "type": "string", "description": "回复的邮件 id，可选" }
                },
                "required": ["account", "to", "subject", "text"],
                "additionalProperties": false
            }),
            effect: EffectKind::Write,
            default_allowed: false,
        },
    ]
}

/// 邮件工具执行器
pub struct MailExecutor {
    svc: Arc<MailService>,
}

impl MailExecutor {
    pub fn new(svc: Arc<MailService>) -> Self {
        Self { svc }
    }

    async fn accounts(&self, started: std::time::Instant) -> ToolResult {
        let mut out = Vec::new();
        for a in self.svc.accounts() {
            let cursor = self.svc.store().get_cursor(a, "INBOX").ok().flatten();
            out.push(json!({
                "account": a,
                "inbox_cursor": cursor.map(|(v, u)| json!({ "uidvalidity": v, "last_uid": u })),
            }));
        }
        result(true, serde_json::to_string_pretty(&out).unwrap_or_default(), Some(json!({ "count": out.len() })), started)
    }

    async fn search(&self, call: &ToolCall, started: std::time::Instant) -> ToolResult {
        let a = &call.arguments;
        let q = MailQuery {
            account: a.get("account").and_then(|v| v.as_str()).map(String::from),
            mailbox: a.get("mailbox").and_then(|v| v.as_str()).map(String::from),
            unread_only: a.get("unread_only").and_then(|v| v.as_bool()).unwrap_or(false),
            keyword: a.get("keyword").and_then(|v| v.as_str()).map(String::from),
            limit: Some(a.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize),
        };
        match self.svc.list(&q) {
            Ok(list) => {
                let n = list.len();
                result(true, serde_json::to_string_pretty(&list).unwrap_or_default(), Some(json!({ "count": n })), started)
            }
            Err(e) => result(false, format!("{}: {}", e.kind(), e.message()), Some(json!({ "error": e.kind() })), started),
        }
    }

    async fn read(&self, call: &ToolCall, started: std::time::Instant) -> ToolResult {
        let Some(id) = call.arguments.get("id").and_then(|v| v.as_str()) else {
            return result(false, "缺少参数 id".into(), Some(json!({ "error": "missing_id" })), started);
        };
        match self.svc.read(&MailId(id.to_string())).await {
            Ok(body) => result(true, serde_json::to_string_pretty(&body).unwrap_or_default(), Some(json!({ "id": id })), started),
            Err(e) => result(false, format!("{}: {}", e.kind(), e.message()), Some(json!({ "error": e.kind(), "id": id })), started),
        }
    }

    async fn sync(&self, started: std::time::Instant) -> ToolResult {
        let reports = self.svc.sync_all().await;
        let failed = reports.iter().filter(|r| r.error.is_some()).count();
        result(
            failed == 0,
            serde_json::to_string_pretty(&reports).unwrap_or_default(),
            Some(json!({ "accounts": reports.len(), "failed": failed })),
            started,
        )
    }

    async fn send(&self, call: &ToolCall, started: std::time::Instant) -> ToolResult {
        let a = &call.arguments;
        let account = a.get("account").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let to: Vec<String> = match a.get("to") {
            Some(Value::Array(arr)) => arr.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
            Some(Value::String(s)) => vec![s.clone()],
            _ => vec![],
        };
        let draft = MailDraft {
            account,
            to,
            subject: a.get("subject").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            text: a.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            in_reply_to: a.get("in_reply_to").and_then(|v| v.as_str()).map(String::from),
        };
        match self.svc.send(&draft).await {
            Ok(id) => result(true, format!("已提交: {id}"), Some(json!({ "id": id.to_string() })), started),
            Err(e) => result(false, format!("{}: {}", e.kind(), e.message()), Some(json!({ "error": e.kind() })), started),
        }
    }
}

#[async_trait]
impl ToolExecutor for MailExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let started = std::time::Instant::now();
        match call.name.as_str() {
            "mail_accounts" => self.accounts(started).await,
            "mail_search" => self.search(&call, started).await,
            "mail_read" => self.read(&call, started).await,
            "mail_sync" => self.sync(started).await,
            "mail_send" => self.send(&call, started).await,
            other => result(
                false,
                format!("未知邮件工具: {other}"),
                Some(json!({ "error": "unknown_tool" })),
                started,
            ),
        }
    }
}

/// 未注入服务时的占位执行器（注册表要知道这些名字存在但没接线）
pub fn not_wired_result(tool: &str) -> ToolResult {
    not_wired(tool, std::time::Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mail::{LocalSinkMailPort, MailStore};

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_mail_tools_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn svc(dir: &std::path::Path) -> Arc<MailService> {
        let store = Arc::new(MailStore::open(dir).unwrap());
        let port = Arc::new(LocalSinkMailPort::new("me@x.com", dir));
        Arc::new(MailService::new(store, vec![port]))
    }

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall { id: "t1".into(), name: name.into(), arguments: args }
    }

    #[tokio::test]
    async fn send_then_search_finds_it() {
        let dir = tmp("send_search");
        let ex = MailExecutor::new(svc(&dir));
        let r = ex
            .execute(call(
                "mail_send",
                json!({
                    "account": "me@x.com",
                    "to": ["a@b.com"],
                    "subject": "报价单",
                    "text": "附件稍后发"
                }),
            ))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("已提交"));

        let s = ex.execute(call("mail_search", json!({ "keyword": "报价" }))).await;
        assert!(s.ok, "{}", s.output);
        assert!(s.output.contains("报价单"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn send_with_two_recipients_is_refused_by_tool_layer() {
        let dir = tmp("batch");
        let ex = MailExecutor::new(svc(&dir));
        let r = ex
            .execute(call(
                "mail_send",
                json!({
                    "account": "me@x.com",
                    "to": ["a@b.com", "c@d.com"],
                    "subject": "hi",
                    "text": "正文"
                }),
            ))
            .await;
        assert!(!r.ok, "多收件人必须失败");
        assert!(r.output.contains("batch_forbidden"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn send_with_password_is_refused_by_tool_layer() {
        let dir = tmp("secret");
        let ex = MailExecutor::new(svc(&dir));
        let r = ex
            .execute(call(
                "mail_send",
                json!({
                    "account": "me@x.com",
                    "to": ["a@b.com"],
                    "subject": "账号",
                    "text": "密码: hunter2"
                }),
            ))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("forbidden_content"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn accounts_lists_configured_port() {
        let dir = tmp("accounts");
        let ex = MailExecutor::new(svc(&dir));
        let r = ex.execute(call("mail_accounts", json!({}))).await;
        assert!(r.ok);
        assert!(r.output.contains("me@x.com"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn read_missing_id_is_refused_not_faked() {
        let dir = tmp("missing");
        let ex = MailExecutor::new(svc(&dir));
        let r = ex.execute(call("mail_read", json!({}))).await;
        assert!(!r.ok);
        assert!(r.output.contains("缺少参数 id"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
