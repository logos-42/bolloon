//! domain_tools.rs — 复用既有领域模块做薄适配（任务/记忆/技能/todo）
//!
//! **边界**: `TaskBoard::publish` / `claim` 需要 `&KeyPair` 签名, 属于「签名/身份」边界
//! （决策 1 + 钱包/支付同批），本轮**不接**; 只接不需要私钥的只读与本地状态工具。
//!
//! 状态落到 `~/.bolloon/agent/`（可由 `BOLLOON_AGENT_DIR` 覆盖, 测试用此隔离）:
//!   · skills.json      (SkillEvolver 落盘, 跨进程复用蒸馏出的 skill)
//!   · todo.json        (TodoList 计划底稿)
//!   · memory.db        (MemoryDb sqlite, agent 记忆)
//!   · task_board.json  (TaskBoard, 协作看板; 本轮只列不写)
//!
//! 这些工具操作的是 **agent 自身状态**, 不是用户工作区文件, 风险低 ⇒ `default_allowed: true`。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use serde_json::json;

use crate::memory_db::MemoryDb;
use crate::skills_runtime::SkillEvolver;
use crate::task_board::TaskBoard;
use crate::todo::{TodoList, TodoStatus};
use crate::tool_contract::{ErrorCode, error_evidence};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn agent_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BOLLOON_AGENT_DIR") {
        let p = PathBuf::from(d);
        let _ = std::fs::create_dir_all(&p);
        return p;
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    let p = PathBuf::from(home).join(".bolloon").join("agent");
    let _ = std::fs::create_dir_all(&p);
    p
}

fn load_todo(dir: &std::path::Path) -> TodoList {
    let p = dir.join("todo.json");
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_todo(dir: &std::path::Path, list: &TodoList) {
    let _ = std::fs::write(
        dir.join("todo.json"),
        serde_json::to_string_pretty(list).unwrap_or_default(),
    );
}

fn ok(output: String, evidence: serde_json::Value) -> ToolResult {
    ToolResult {
        ok: true,
        output,
        elapsed_ms: 0,
        verified: Some(true),
        evidence: Some(evidence),
    }
}

fn fail(code: ErrorCode, msg: &str) -> ToolResult {
    ToolResult {
        ok: false,
        output: msg.into(),
        elapsed_ms: 0,
        verified: Some(false),
        evidence: Some(error_evidence(code, msg)),
    }
}

async fn do_read_skill(call: ToolCall) -> ToolResult {
    let name = match call.arguments.get("name").and_then(|v| v.as_str()) {
        Some(n) if !n.trim().is_empty() => n.to_string(),
        _ => return fail(ErrorCode::InvalidArgument, "read_skill: name 必填"),
    };
    let dir = agent_dir();
    let evolver = SkillEvolver::load_json(&dir.join("skills.json"));
    match evolver.registry.read_skill(&name) {
        Some(body) => ok(
            format!("# {name}\n\n{body}"),
            json!({ "skill": name, "found": true }),
        ),
        None => fail(ErrorCode::NotFound, &format!("没有名为 `{name}` 的 skill")),
    }
}

async fn do_list_skills(_call: ToolCall) -> ToolResult {
    let dir = agent_dir();
    let evolver = SkillEvolver::load_json(&dir.join("skills.json"));
    let names = evolver.registry.names();
    let summary = if names.is_empty() {
        "（暂无已蒸馏 skill）".into()
    } else {
        format!(
            "{} 个 skill:\n{}",
            names.len(),
            names
                .iter()
                .map(|n| format!("- {n}"))
                .collect::<Vec<_>>()
                .join("\n")
        )
    };
    ok(summary, json!({ "count": names.len() }))
}

async fn do_todo_add(call: ToolCall) -> ToolResult {
    let content = match call.arguments.get("content").and_then(|v| v.as_str()) {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        _ => return fail(ErrorCode::InvalidArgument, "todo_add: content 必填"),
    };
    let dir = agent_dir();
    let mut list = load_todo(&dir);
    match list.add(&content, now_ms()) {
        Ok(id) => {
            save_todo(&dir, &list);
            ok(
                format!("已加入待办 `{id}`。\n{}", list.progress().unwrap_or_default()),
                json!({ "id": id }),
            )
        }
        Err(e) => fail(ErrorCode::InvalidArgument, &format!("todo_add 失败: {e}")),
    }
}

async fn do_todo_list(_call: ToolCall) -> ToolResult {
    let dir = agent_dir();
    let list = load_todo(&dir);
    let body = list
        .items
        .iter()
        .map(|i| {
            let mark = match i.status {
                TodoStatus::Pending => "○",
                TodoStatus::InProgress => "▶",
                TodoStatus::Completed => "✅",
                TodoStatus::Cancelled => "✗",
            };
            format!("{} {} {}", mark, i.id, i.content)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let output = format!(
        "{}\n\n{}",
        list.progress().unwrap_or_default(),
        if body.is_empty() { "（空清单）".into() } else { body }
    );
    ok(output, json!({ "count": list.items.len() }))
}

async fn do_todo_done(call: ToolCall) -> ToolResult {
    let id = match call.arguments.get("id").and_then(|v| v.as_str()) {
        Some(i) if !i.trim().is_empty() => i.to_string(),
        _ => return fail(ErrorCode::InvalidArgument, "todo_done: id 必填"),
    };
    let dir = agent_dir();
    let mut list = load_todo(&dir);
    // 状态机: Pending→Completed 非法, 必须先 InProgress。这里自动补全迁移链。
    if let Some(item) = list.items.iter().find(|i| i.id == id) {
        if item.status == TodoStatus::Pending {
            if let Err(e) = list.set_status(&id, TodoStatus::InProgress, now_ms()) {
                return fail(ErrorCode::Internal, &format!("todo_done 迁移失败: {e}"));
            }
        }
    }
    match list.set_status(&id, TodoStatus::Completed, now_ms()) {
        Ok(()) => {
            save_todo(&dir, &list);
            ok(
                format!("已标记 `{id}` 完成。\n{}", list.progress().unwrap_or_default()),
                json!({ "id": id }),
            )
        }
        Err(e) => fail(ErrorCode::NotFound, &format!("todo_done 失败: {e}")),
    }
}

async fn do_remember(call: ToolCall) -> ToolResult {
    let content = match call.arguments.get("content").and_then(|v| v.as_str()) {
        Some(c) if !c.trim().is_empty() => c.to_string(),
        _ => return fail(ErrorCode::InvalidArgument, "remember: content 必填"),
    };
    let agent_id = call
        .arguments
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let layer = call
        .arguments
        .get("layer")
        .and_then(|v| v.as_str())
        .unwrap_or("lesson")
        .to_string();
    let ttl_ms = call
        .arguments
        .get("ttl_ms")
        .and_then(|v| v.as_u64());
    let dir = agent_dir();
    let db = match MemoryDb::open(dir.join("memory.db").to_str().unwrap_or_default()) {
        Ok(d) => d,
        Err(e) => return fail(ErrorCode::Internal, &format!("memory.db 打开失败: {e}")),
    };
    match db.remember(&agent_id, &layer, &content, 0.5, now_ms(), ttl_ms) {
        Ok(row) => ok(
            format!("[已记] 写入 {layer} 记忆 (id={})", row.id),
            json!({ "id": row.id, "layer": layer }),
        ),
        Err(e) => fail(ErrorCode::Internal, &format!("remember 失败: {e}")),
    }
}

async fn do_recall(call: ToolCall) -> ToolResult {
    let agent_id = call
        .arguments
        .get("agent_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let query = call.arguments.get("query").and_then(|v| v.as_str()).map(|s| s.to_string());
    let k = call
        .arguments
        .get("k")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(5);
    let dir = agent_dir();
    let db = match MemoryDb::open(dir.join("memory.db").to_str().unwrap_or_default()) {
        Ok(d) => d,
        Err(e) => return fail(ErrorCode::Internal, &format!("memory.db 打开失败: {e}")),
    };
    match db.recall(&agent_id, query.as_deref(), k, now_ms()) {
        Ok(rows) => {
            let body = if rows.is_empty() {
                "（无命中记忆）".into()
            } else {
                rows.iter()
                    .map(|r| format!("[{}] {} {}", r.id, r.layer, r.content))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            ok(body, json!({ "count": rows.len() }))
        }
        Err(e) => fail(ErrorCode::Internal, &format!("recall 失败: {e}")),
    }
}

async fn do_task_list(call: ToolCall) -> ToolResult {
    let capability = call
        .arguments
        .get("capability")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let dir = agent_dir();
    let board = TaskBoard::load_json(&dir.join("task_board.json"));
    let items = board.board(capability.as_deref());
    let body = if items.is_empty() {
        "（看板空）".into()
    } else {
        items
            .iter()
            .map(|a| format!("[{}] {} | {} | 预算 {}", a.id, a.capability, a.issuer, a.budget))
            .collect::<Vec<_>>()
            .join("\n")
    };
    ok(body, json!({ "count": items.len() }))
}

pub struct DomainExecutor;

#[async_trait]
impl ToolExecutor for DomainExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "read_skill" => do_read_skill(call).await,
            "list_skills" => do_list_skills(call).await,
            "todo_add" => do_todo_add(call).await,
            "todo_list" => do_todo_list(call).await,
            "todo_done" => do_todo_done(call).await,
            "remember" => do_remember(call).await,
            "recall" => do_recall(call).await,
            "task_list" => do_task_list(call).await,
            other => ToolResult {
                ok: false,
                output: format!("领域族没有 `{other}`（不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

fn def(name: &str, desc: &str, params: serde_json::Value, effect: EffectKind) -> ToolDef {
    ToolDef {
        name: name.into(),
        description: desc.into(),
        parameters: params,
        effect,
        default_allowed: true, // agent 自身状态, 低风险
    }
}

pub fn domain_tool_defs() -> Vec<ToolDef> {
    vec![
        def("read_skill", "读取一个已蒸馏的 skill 正文（只读）。", json!({
            "type": "object",
            "properties": { "name": { "type": "string", "description": "skill 名" } },
            "required": ["name"], "additionalProperties": false
        }), EffectKind::Read),
        def("list_skills", "列出所有已蒸馏的 skill（只读）。", json!({
            "type": "object", "properties": {}, "additionalProperties": false
        }), EffectKind::Read),
        def("todo_add", "往计划清单加一项（同一时刻只许一个 in_progress）。", json!({
            "type": "object",
            "properties": { "content": { "type": "string", "description": "待办内容" } },
            "required": ["content"], "additionalProperties": false
        }), EffectKind::Write),
        def("todo_list", "查看当前计划清单与进度。", json!({
            "type": "object", "properties": {}, "additionalProperties": false
        }), EffectKind::Read),
        def("todo_done", "标记一项为已完成。", json!({
            "type": "object",
            "properties": { "id": { "type": "string", "description": "待办项 id" } },
            "required": ["id"], "additionalProperties": false
        }), EffectKind::Write),
        def("remember", "写入一条记忆（agent 长期记忆, sqlite 持久化）。", json!({
            "type": "object",
            "properties": {
                "content": { "type": "string", "description": "记忆内容" },
                "layer": { "type": "string", "description": "层: lesson/decision/run_fact/temporary（默认 lesson）" },
                "agent_id": { "type": "string", "description": "可选, 默认 default" },
                "ttl_ms": { "type": "integer", "description": "可选过期" }
            },
            "required": ["content"], "additionalProperties": false
        }), EffectKind::Write),
        def("recall", "召回记忆 top-k（只读）。", json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "可选子串过滤" },
                "k": { "type": "integer", "description": "可选, 默认 5" },
                "agent_id": { "type": "string", "description": "可选, 默认 default" }
            },
            "additionalProperties": false
        }), EffectKind::Read),
        def("task_list", "查看协作任务看板（只读; 发布/认领需签名身份, 属独立批次）。", json!({
            "type": "object",
            "properties": { "capability": { "type": "string", "description": "可选按能力过滤" } },
            "additionalProperties": false
        }), EffectKind::Read),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_harness::ToolExecutor;

    fn setup() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon_dom_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        unsafe { std::env::set_var("BOLLOON_AGENT_DIR", d.to_str().unwrap()) };
        d
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args }
    }

    #[tokio::test]
    async fn todo_roundtrip_add_list_done() {
        let _d = setup();
        let r = DomainExecutor.execute(call("todo_add", json!({ "content": "写迁移报告" }))).await;
        assert!(r.ok, "{}", r.output);
        let id = r.evidence.as_ref().unwrap()["id"].as_str().unwrap().to_string();
        let lst = DomainExecutor.execute(call("todo_list", json!({}))).await;
        assert!(lst.output.contains(&id));
        let done = DomainExecutor.execute(call("todo_done", json!({ "id": id }))).await;
        assert!(done.ok, "{}", done.output);
        assert!(done.output.contains("完成"));
    }

    #[tokio::test]
    async fn todo_add_requires_content() {
        let _d = setup();
        let r = DomainExecutor.execute(call("todo_add", json!({}))).await;
        assert!(!r.ok);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "invalid_argument");
    }

    #[tokio::test]
    async fn remember_and_recall() {
        let _d = setup();
        let r = DomainExecutor
            .execute(call("remember", json!({ "content": "rust 用 ureq 而非 reqwest", "layer": "lesson" })))
            .await;
        assert!(r.ok, "{}", r.output);
        let rc = DomainExecutor.execute(call("recall", json!({ "query": "ureq" }))).await;
        assert!(rc.ok, "{}", rc.output);
        assert!(rc.output.contains("ureq"), "{}", rc.output);
    }

    #[tokio::test]
    async fn read_skill_missing_is_not_found() {
        let _d = setup();
        // 空目录 ⇒ 无 skill
        let _ = std::fs::remove_file(std::env::temp_dir().join(format!("bolloon_dom_{}", std::process::id())).join("skills.json"));
        let r = DomainExecutor.execute(call("read_skill", json!({ "name": "nope" }))).await;
        assert!(!r.ok);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "not_found");
    }

    #[test]
    fn domain_tools_are_allowed_locally() {
        for d in domain_tool_defs() {
            assert!(d.default_allowed, "{} 是 agent 本地状态, 应默认允许", d.name);
        }
    }
}
