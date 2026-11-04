//! belief_tools.rs — 让 agent **自己写**信念与长短期目标的工具族
//!
//! 只有存储与排序 (见 `belief.rs`) 而没有写入口, 信念层就只是"人给的一段文本";
//! 这一族工具补的是写入口 + 读回执, 让模型能在对话里真的立/改/退休自己的判断。
//!
//! 落盘位置: 与 `domain_tools` 同一个 agent 目录 (`~/.bolloon/agent/beliefs.db`, SQLite),
//! 表 `beliefs` / `commitments` / `belief_meta`。老 `beliefs.json` 只在库空时一次性导入。
//! 这些工具操作的是 **agent 自身状态**, 不是用户工作区文件,
//! 风险低 ⇒ `default_allowed: true` (与 todo/remember 同级)。

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use serde_json::json;

use crate::belief::{
    BeliefKind, BeliefOrigin, BeliefStore, CommitmentStatus, Horizon, MAX_BELIEFS, MAX_COMMITMENTS,
};
use crate::tool_contract::{error_evidence, ErrorCode};

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 信念库路径 (`BOLLOON_AGENT_DIR` 可覆盖; 与 todo.json / memory.db 同目录)
///
/// 2026-11-06: 从 `beliefs.json` 改成 SQLite `beliefs.db` —— 信念/目标要能按条件查、
/// 要能跟记忆 join、也不再每次写都重写整篇历史。老 json 由 `BeliefStore::load` 一次性导入。
pub fn beliefs_path() -> std::path::PathBuf {
    crate::domain_tools::agent_dir().join("beliefs.db")
}

/// 读一遍信念库 (web 侧注入 prompt 也走这里, 与工具同一份真源)
///
/// 读的同时**自愈一次重复条目** (`BeliefStore::merge_similar`): 去重只在写入时生效,
/// 真机上已经存在的回声条目 (同一判断 4 种措辞) 得靠这一步收敛, 否则排序与注入继续被污染。
/// 幂等: 没有可合并的就不写文件。
pub fn load_store() -> BeliefStore {
    let mut store = BeliefStore::load(&beliefs_path());
    let now = now_ms();
    if store.merge_similar(now) > 0 {
        if let Err(e) = persist(&store) {
            tracing::warn!("信念库自动合并后落盘失败: {e}");
        }
    }
    store
}

fn ok(output: String, evidence: serde_json::Value) -> ToolResult {
    ToolResult { ok: true, output, elapsed_ms: 0, verified: Some(true), evidence: Some(evidence) }
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

fn str_arg(call: &ToolCall, key: &str) -> Option<String> {
    call.arguments
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

async fn do_belief_set(call: ToolCall) -> ToolResult {
    let statement = match str_arg(&call, "statement") {
        Some(s) => s,
        None => return fail(ErrorCode::InvalidArgument, "belief_set: statement 必填"),
    };
    let kind = str_arg(&call, "kind")
        .as_deref()
        .and_then(BeliefKind::parse)
        .unwrap_or(BeliefKind::World);
    let origin = str_arg(&call, "origin")
        .as_deref()
        .and_then(BeliefOrigin::parse)
        .unwrap_or(BeliefOrigin::SelfReasoned);
    let confidence = call.arguments.get("confidence").and_then(|v| v.as_f64());
    let evidence = str_arg(&call, "evidence");
    let mut store = load_store();
    match store.upsert_belief(&statement, kind, origin, confidence, evidence.as_deref(), now_ms()) {
        Ok((id, created)) => {
            if let Err(e) = persist(&store) {
                return fail(ErrorCode::Internal, &e);
            }
            let conf = store.beliefs.iter().find(|b| b.id == id).map(|b| b.confidence);
            let live = store.live_beliefs().len();
            ok(
                format!(
                    "{}信念 `{id}`: {statement}\n(活着 {live} 条, 上限 {MAX_BELIEFS})",
                    if created { "已立" } else { "已更新" }
                ),
                json!({ "id": id, "created": created, "live": live, "confidence": conf }),
            )
        }
        Err(e) => fail(ErrorCode::InvalidArgument, &format!("belief_set 失败: {e}")),
    }
}

async fn do_belief_list(_call: ToolCall) -> ToolResult {
    let store = load_store();
    let live = store.live_beliefs();
    if live.is_empty() {
        return ok("（还没有信念: 用 belief_set 立一条）".into(), json!({ "count": 0 }));
    }
    let body = live
        .iter()
        .map(|b| {
            let ev = b
                .evidence
                .first()
                .map(|e| format!(" (证据: {e})"))
                .unwrap_or_default();
            format!(
                "- {} [{}·{:.2}·{}] {}{ev}",
                b.id,
                b.kind.as_str(),
                b.confidence,
                b.origin.as_str(),
                b.statement
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    ok(format!("{} 条活着的信念:\n{body}", live.len()), json!({ "count": live.len() }))
}

async fn do_belief_retire(call: ToolCall) -> ToolResult {
    let id = match str_arg(&call, "id") {
        Some(i) => i,
        None => return fail(ErrorCode::InvalidArgument, "belief_retire: id 必填"),
    };
    let mut store = load_store();
    match store.retire_belief(&id, now_ms()) {
        Ok(()) => {
            if let Err(e) = persist(&store) {
                return fail(ErrorCode::Internal, &e);
            }
            ok(
                format!("已退休信念 `{id}` (留痕, 不再参与排序与注入)"),
                json!({ "id": id, "live": store.live_beliefs().len() }),
            )
        }
        Err(e) => fail(ErrorCode::NotFound, &format!("belief_retire 失败: {e}")),
    }
}

async fn do_goal_set(call: ToolCall) -> ToolResult {
    let statement = match str_arg(&call, "statement") {
        Some(s) => s,
        None => return fail(ErrorCode::InvalidArgument, "goal_set: statement 必填"),
    };
    let horizon = match str_arg(&call, "horizon").as_deref().and_then(Horizon::parse) {
        Some(h) => h,
        None => return fail(ErrorCode::InvalidArgument, "goal_set: horizon 必填 (short|long)"),
    };
    let next_action = match str_arg(&call, "next_action") {
        Some(n) => n,
        None => {
            return fail(
                ErrorCode::InvalidArgument,
                "goal_set: next_action 必填 —— 没有下一步的是愿望, 不是目标",
            )
        }
    };
    let why = str_arg(&call, "why");
    let parent_belief = str_arg(&call, "parent_belief");
    let due_ms = call.arguments.get("due_ms").and_then(|v| v.as_u64());
    let mut store = load_store();
    match store.upsert_commitment(
        &statement,
        horizon,
        why.as_deref(),
        &next_action,
        due_ms,
        parent_belief.as_deref(),
        now_ms(),
    ) {
        Ok((id, created)) => {
            if let Err(e) = persist(&store) {
                return fail(ErrorCode::Internal, &e);
            }
            let active = store.active_commitments().len();
            ok(
                format!(
                    "{}目标 `{id}` ({}): {statement}\n下一步: {next_action}\n(活着 {active} 个, 上限 {MAX_COMMITMENTS})",
                    if created { "已立" } else { "已更新" },
                    horizon.as_str()
                ),
                json!({
                    "id": id,
                    "created": created,
                    "horizon": horizon.as_str(),
                    "active": active,
                }),
            )
        }
        Err(e) => fail(ErrorCode::InvalidArgument, &format!("goal_set 失败: {e}")),
    }
}

async fn do_goal_list(_call: ToolCall) -> ToolResult {
    let store = load_store();
    let active = store.active_commitments();
    if active.is_empty() {
        return ok("（还没有目标: 用 goal_set 立一个）".into(), json!({ "count": 0 }));
    }
    let body = active
        .iter()
        .map(|c| {
            format!(
                "- {} [{}·{}·{}%] {} → 下一步: {}{}",
                c.id,
                c.horizon.as_str(),
                c.status.as_str(),
                c.progress,
                c.statement,
                c.next_action,
                c.due_ms.map(|d| format!(" (到期 {d})")).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let pick = store
        .pick_next(now_ms())
        .map(|ch| format!("\n\n现在该做: {} → {} ({})", ch.statement, ch.next_action, ch.why))
        .unwrap_or_default();
    ok(format!("{} 个活着目标:\n{body}{pick}", active.len()), json!({ "count": active.len() }))
}

async fn do_goal_update(call: ToolCall) -> ToolResult {
    let id = match str_arg(&call, "id") {
        Some(i) => i,
        None => return fail(ErrorCode::InvalidArgument, "goal_update: id 必填"),
    };
    let status = match str_arg(&call, "status") {
        Some(s) => match CommitmentStatus::parse(&s) {
            Some(st) => Some(st),
            None => {
                return fail(
                    ErrorCode::InvalidArgument,
                    "goal_update: status 只能是 open|doing|paused|done|dropped",
                )
            }
        },
        None => None,
    };
    let next_action = str_arg(&call, "next_action");
    let evidence = str_arg(&call, "evidence");
    let progress = call
        .arguments
        .get("progress")
        .and_then(|v| v.as_u64())
        .map(|p| p.min(100) as u8);
    let mut store = load_store();
    match store.update_commitment(
        &id,
        status,
        next_action.as_deref(),
        progress,
        evidence.as_deref(),
        now_ms(),
    ) {
        Ok(()) => {
            if let Err(e) = persist(&store) {
                return fail(ErrorCode::Internal, &e);
            }
            let c = store.commitments.iter().find(|c| c.id == id);
            ok(
                format!(
                    "已更新目标 `{id}`: {}·{}%",
                    c.map(|c| c.status.as_str()).unwrap_or("-"),
                    c.map(|c| c.progress).unwrap_or(0)
                ),
                json!({ "id": id, "status": status.map(|s| s.as_str()) }),
            )
        }
        Err(e) => fail(ErrorCode::NotFound, &format!("goal_update 失败: {e}")),
    }
}

async fn do_goal_pick(_call: ToolCall) -> ToolResult {
    let store = load_store();
    match store.pick_next(now_ms()) {
        Some(ch) => ok(
            format!(
                "现在该做: {}\n下一步: {}\n为什么: {}\n(目标 {})",
                ch.statement, ch.next_action, ch.why, ch.commitment_id
            ),
            json!({
                "commitment_id": ch.commitment_id,
                "horizon": ch.horizon.as_str(),
                "score": ch.score,
            }),
        ),
        None => ok(
            "没有活着的目标 —— 先按自己的信念立一个 (goal_set)".into(),
            json!({ "commitment_id": null }),
        ),
    }
}

/// 统一落盘: 私有库 (beliefs.db) + 同步进项目既有 goal 目录 (~/.bolloon/goals/)。
///
/// 两处同源: beliefs.db 是本体, goals/<id>.json 是给项目其它部分 (页面/flywheel/supervisor)
/// 看的投影。写失败必须冒泡 —— 只写了一半的"已立目标"比没写更坏。
pub fn persist(store: &BeliefStore) -> Result<usize, String> {
    store
        .save(&beliefs_path())
        .map_err(|e| format!("beliefs.db 落盘失败: {e}"))?;
    let goals_dir = crate::home::BolloonHome::resolve().root().join("goals");
    store
        .sync_goal_files(&goals_dir, now_ms())
        .map_err(|e| format!("同步 goal 目录失败: {e}"))
}

/// agent 自身状态目录 (`~/.bolloon/agent`, `BOLLOON_AGENT_DIR` 可覆盖)。
/// 执行侧 (web/CLI) 要读写这份状态时走这里, 不要各自拼路径。
pub fn state_dir() -> std::path::PathBuf {
    crate::domain_tools::agent_dir()
}

/// 读 agent 自己的待办进度 (心跳按信念挑出的下一步就落在 todo.json 里)。
///
/// 为什么必须由这里提供: web/CLI 的 system prompt 组装函数有 `todo_progress` 这一层,
/// 但调用方一直传 `None` —— 于是工具写的待办、心跳落的下一步, 模型**一轮也看不见**,
/// "信念 → 目标 → 行动"的链条断在最后一步。这个函数是那条链的接头。
pub fn todo_progress_text() -> Option<String> {
    let path = crate::domain_tools::agent_dir().join("todo.json");
    let list: crate::todo::TodoList = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())?;
    list.progress()
}

/// 心跳出手时用: 按自己的信念挑下一步, 并**落成待办** —— 让下一轮真的接着推。
///
/// 为什么落 todo 而不是只打日志: todo 是唯一已经接进 system prompt 的"计划层"
/// (`dynamic.todo`), 心跳写的动作下一轮就会被模型看见并执行; 只写日志等于没做。
///
/// 幂等: 同一动作已在清单里 (未完成) 就不重复加, 免得心跳把清单刷成一堆重复项。
/// 返回 (commitment_id, next_action); 没有活着的目标 ⇒ None (那时不出手, 也不假装在做)。
pub fn tick_into_todo(now_ms: u64) -> Option<(String, String)> {
    let store = load_store();
    let ch = store.pick_next(now_ms)?;
    write_todo_once(&ch.next_action, &ch.statement, now_ms);
    Some((ch.commitment_id, ch.next_action))
}

/// **主动出手前的"信念 → 目标"两步筛** —— 心跳和 cron 必须走这个。
///
/// 与 `tick_into_todo` 的差别就是那句"根据信念来做": 只接受**挂在活着的信念上**的目标。
/// 挑不出时**不出手**, 并给出人可读的理由 (会原样写进 `/api/cron` 的
/// `initiative_goal_last`), 这样"没动"和"动了但没内容"在外部能逐字区分。
pub fn pick_for_initiative(now_ms: u64) -> (Option<(String, String)>, String) {
    let store = load_store();
    match store.pick_next_belief_backed(now_ms) {
        Some(ch) => {
            write_todo_once(&ch.next_action, &ch.statement, now_ms);
            let why = format!("{} (目标 {} · {})", ch.why, ch.commitment_id, ch.statement);
            (Some((ch.commitment_id, ch.next_action)), why)
        }
        None => {
            let active = store.active_commitments().len();
            let backed = store.belief_backed_count();
            let reason = if active == 0 {
                "没有活着的目标: 不出手 (先让自省立信念与目标)".to_string()
            } else {
                format!(
                    "{active} 个活目标里有 {backed} 个挂在活信念上: 挑不出有根据的一步 ⇒ 不出手, 先给自己补信念/挂 parent_belief"
                )
            };
            (None, reason)
        }
    }
}

/// 把挑出的一步落成 todo (幂等: 已在清单里就不重复加)
fn write_todo_once(next_action: &str, statement: &str, now_ms: u64) {
    let dir = crate::domain_tools::agent_dir();
    let path = dir.join("todo.json");
    let mut list = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<crate::todo::TodoList>(&s).ok())
        .unwrap_or_default();
    let already = list.items.iter().any(|i| {
        matches!(i.status, crate::todo::TodoStatus::Pending | crate::todo::TodoStatus::InProgress)
            && (i.content == next_action || i.content.contains(statement))
    });
    if already {
        return;
    }
    if list.add(next_action, now_ms).is_ok() {
        let body = serde_json::to_string_pretty(&list).unwrap_or_default();
        let _ = std::fs::write(&path, body);
    }
}

pub struct BeliefExecutor;

#[async_trait]
impl ToolExecutor for BeliefExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "belief_set" => do_belief_set(call).await,
            "belief_list" => do_belief_list(call).await,
            "belief_retire" => do_belief_retire(call).await,
            "goal_set" => do_goal_set(call).await,
            "goal_list" => do_goal_list(call).await,
            "goal_update" => do_goal_update(call).await,
            "goal_pick" => do_goal_pick(call).await,
            other => ToolResult {
                ok: false,
                output: format!("信念族没有 `{other}`（不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

/// (工具定义见下)
fn def(name: &str, desc: &str, params: serde_json::Value, effect: EffectKind) -> ToolDef {
    ToolDef {
        name: name.into(),
        description: desc.into(),
        parameters: params,
        effect,
        default_allowed: true, // agent 自身状态, 低风险
    }
}

pub fn belief_tool_defs() -> Vec<ToolDef> {
    vec![
        def(
            "belief_set",
            "立/更新一条**你自己的**信念（关于我/世界/主人/手头事）。同一句会合并证据与置信度，不会重复。信念要具体、可被证据推翻。",
            json!({
                "type": "object",
                "properties": {
                    "statement": { "type": "string", "description": "一句话信念（具体，不写空话）" },
                    "kind": { "type": "string", "description": "self|world|owner|work（默认 world）" },
                    "origin": { "type": "string", "description": "self|owner|inferred（默认 self 自省）" },
                    "confidence": { "type": "number", "description": "0..1；不填按来源给默认" },
                    "evidence": { "type": "string", "description": "支撑证据（文件/回执/某轮对话）" }
                },
                "required": ["statement"], "additionalProperties": false
            }),
            EffectKind::Write,
        ),
        def(
            "belief_list",
            "列出你还活着的信念（含置信度与来源）。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            EffectKind::Read,
        ),
        def(
            "belief_retire",
            "退休一条信念（被推翻/不再成立）。不删除，留痕，但不再参与排序与注入。",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "信念 id" } },
                "required": ["id"], "additionalProperties": false
            }),
            EffectKind::Write,
        ),
        def(
            "goal_set",
            "立/更新一个**你自己的**目标（short 短期 / long 长期）。必须给 next_action：没有下一步的是愿望，不是目标。",
            json!({
                "type": "object",
                "properties": {
                    "statement": { "type": "string", "description": "目标一句话" },
                    "horizon": { "type": "string", "description": "short|long（必填）" },
                    "next_action": { "type": "string", "description": "下一步具体做什么（必填）" },
                    "why": { "type": "string", "description": "为什么立它，通常指向某条信念" },
                    "due_ms": { "type": "integer", "description": "期望完成时刻 Unix ms（可选）" },
                    "parent_belief": { "type": "string", "description": "支撑它的信念 id（可选）" }
                },
                "required": ["statement", "horizon", "next_action"], "additionalProperties": false
            }),
            EffectKind::Write,
        ),
        def(
            "goal_list",
            "列出活着的目标（长/短期、状态、进度、下一步），并给出按信念排出的『现在该做』。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            EffectKind::Read,
        ),
        def(
            "goal_update",
            "更新一个目标：状态（open|doing|paused|done|dropped）/ 下一步 / 进度 / 追加证据。做完就标 done，别留着悬空。",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "目标 id" },
                    "status": { "type": "string", "description": "open|doing|paused|done|dropped" },
                    "next_action": { "type": "string", "description": "新的下一步" },
                    "progress": { "type": "integer", "description": "0..100" },
                    "evidence": { "type": "string", "description": "本轮证据" }
                },
                "required": ["id"], "additionalProperties": false
            }),
            EffectKind::Write,
        ),
        def(
            "goal_pick",
            "按你自己的信念排序，挑出『现在该做什么』（心跳/空闲时会走同一套排序）。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            EffectKind::Read,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use bolloon_harness::ToolExecutor;

    /// 每个测试**独占** BOLLOON_AGENT_DIR: 环境变量是进程级的, 并行测试共用同一目录会互相踩
    /// (2026-11-05 实测: 固定 tmp 名 + 共享目录 ⇒ `goal_update` 找不到刚写的目标)。
    /// 返回的 guard 必须活到测试结束 —— 它保证同一时刻只有一个测试在改这个环境变量。
    fn setup() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("bolloon_beltools_{}_{}", std::process::id(), n));
        let _ = std::fs::create_dir_all(&d);
        unsafe { std::env::set_var("BOLLOON_AGENT_DIR", d.to_str().unwrap()) };
        guard
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args }
    }

    #[tokio::test]
    async fn belief_and_goal_roundtrip() {
        let _d = setup();
        let r = BeliefExecutor
            .execute(call(
                "belief_set",
                json!({ "statement": "心跳只有在有活着目标时才有意义", "kind": "self", "confidence": 0.7 }),
            ))
            .await;
        assert!(r.ok, "{}", r.output);
        let bid = r.evidence.as_ref().unwrap()["id"].as_str().unwrap().to_string();

        let g = BeliefExecutor
            .execute(call(
                "goal_set",
                json!({
                    "statement": "把信念层接进 system prompt",
                    "horizon": "short",
                    "next_action": "改 native.rs 注入 commitments 段",
                    "parent_belief": bid
                }),
            ))
            .await;
        assert!(g.ok, "{}", g.output);

        let lst = BeliefExecutor.execute(call("goal_list", json!({}))).await;
        assert!(lst.output.contains("接进 system prompt"), "{}", lst.output);
        let pick = BeliefExecutor.execute(call("goal_pick", json!({}))).await;
        assert!(pick.ok);
        assert!(pick.output.contains("现在该做"), "{}", pick.output);
    }

    #[tokio::test]
    async fn goal_set_without_next_action_is_rejected() {
        let _d = setup();
        let r = BeliefExecutor
            .execute(call("goal_set", json!({ "statement": "变强", "horizon": "long" })))
            .await;
        assert!(!r.ok);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "invalid_argument");
    }

    #[tokio::test]
    async fn goal_update_marks_done() {
        let _d = setup();
        let g = BeliefExecutor
            .execute(call(
                "goal_set",
                json!({ "statement": "写测试", "horizon": "short", "next_action": "跑 cargo test" }),
            ))
            .await;
        let gid = g.evidence.as_ref().unwrap()["id"].as_str().unwrap().to_string();
        let u = BeliefExecutor
            .execute(call("goal_update", json!({ "id": gid, "status": "done" })))
            .await;
        assert!(u.ok, "{}", u.output);
        assert!(u.output.contains("done"), "{}", u.output);
    }

    /// 心跳链路 (2026-11-05): 有活着目标 ⇒ 挑出下一步并**落成 todo**, 下一轮 prompt 才带得动;
    /// 同一动作重复调用不重复入清单 (心跳每 5 分钟一次, 刷清单就废了)。
    #[tokio::test]
    async fn tick_into_todo_writes_next_action_once() {
        let _d = setup();
        let g = BeliefExecutor
            .execute(call(
                "goal_set",
                json!({ "statement": "把信念层接进心跳", "horizon": "short", "next_action": "跑 tick_into_todo" }),
            ))
            .await;
        assert!(g.ok, "{}", g.output);

        let now = now_ms();
        let first = tick_into_todo(now);
        let (gid, action) = first.expect("有活着目标时必须挑出一步");
        assert_eq!(gid.len() > 0, true);
        assert!(action.contains("tick_into_todo"), "{action}");

        let todo_path = state_dir().join("todo.json");
        let after_first = std::fs::read_to_string(&todo_path).expect("todo.json 应已落盘");
        assert!(after_first.contains("tick_into_todo"), "{after_first}");

        // 幂等: 再挑一次不新增同一条
        assert!(tick_into_todo(now).is_some());
        let after_second = std::fs::read_to_string(&todo_path).unwrap_or_default();
        assert_eq!(
            after_second.matches("tick_into_todo").count(),
            after_first.matches("tick_into_todo").count(),
            "重复调用不许把清单刷成重复项"
        );
    }

    #[test]
    fn belief_tools_are_allowed_locally() {
        for d in belief_tool_defs() {
            assert!(d.default_allowed, "{} 是 agent 自身状态, 应默认允许", d.name);
        }
    }
}