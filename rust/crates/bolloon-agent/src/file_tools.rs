//! file_tools.rs — 文件族工具（迁移第 4 步第一批）
//!
//! 对齐 TS 基线 `pi-sdk-tools.ts` 的文件族:
//!   `read_file`（已在 builtin_tools）· `write_file` · `edit_file` · `list_directory`
//!   · `mkdir` · `move_file` · `delete_file`
//!
//! **write-verify 读回自证**（TS `src/agents/write-verify.ts`，由 `k10-write-verify-wiring.test.ts` 钉住）:
//!   写类工具**成功**返回必须自带读回事实 `[已核对] 文件已落盘: X (N 字节, ISO时间)`；
//!   **失败原样返回不拼**（不许把失败说成已核对）。这是 L4 闭环自治的第一块。
//!
//! 权限分级（决策 2）:
//!   · `list_directory` = Read，默认允许
//!   · `write_file` / `edit_file` / `mkdir` / `move_file` = Write（可逆写入），**不默认允许，需授予**
//!   · `delete_file` = Write 但**不可逆**，不随 CLI 默认授予（需显式授权），与可逆写分开
//!
//! **有意安全升级**（决策 1/2）:
//!   · 写/删同样拒绝凭据路径（`.env` / `.ssh` / `*.pem` / `.bolloon/{identity,keypair,…}`）
//!   · `edit_file` 命中多处 ⇒ 拒绝并要求更具体（不猜改哪一处）
//!   · `delete_file` 只删文件，目录拒绝（不可撤回的面更小）

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};

use crate::tool_contract::{ErrorCode, error_evidence, with_error};

/// 目录列出上限（防超大目录把上下文撑爆）
const MAX_LIST_ENTRIES: usize = 200;

/// 写后读回自证（对齐 TS `verifyWriteOutcome`）
///
/// 成功 → `[已核对] …`；读不回 → `[未核对] …别急着说"已完成"`（如实，不冒充成功）
pub fn verify_write(path: &str, is_dir: bool) -> String {
    match std::fs::metadata(path) {
        Ok(m) => {
            if is_dir {
                format!("[已核对] 目录存在: {path}")
            } else {
                let secs = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                let when = chrono::DateTime::from_timestamp(secs, 0)
                    .map(|t| t.to_rfc3339())
                    .unwrap_or_else(|| "未知时间".to_string());
                format!("[已核对] 文件已落盘: {path} ({} 字节, {when})", m.len())
            }
        }
        Err(e) => format!("[未核对] 读回失败: {e} —— 别急着说\"已完成\""),
    }
}

fn arg_str<'a>(call: &'a ToolCall, key: &str) -> Option<&'a str> {
    call.arguments.get(key).and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty())
}

/// 入口校验 + 路径 deny（所有写/删操作共用）
fn guard_write_path(call: &ToolCall, keys: &[&str]) -> Result<(Vec<String>, Option<String>), ToolResult> {
    let started = std::time::Instant::now();
    let mut vals = Vec::new();
    for k in keys {
        match arg_str(call, k) {
            Some(v) => vals.push(v.to_string()),
            None => {
                return Err(ToolResult {
                    ok: false,
                    output: format!("{k} 必填（参数校验在入口发生）"),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                    verified: Some(false),
                    evidence: Some(error_evidence(
                        ErrorCode::InvalidArgument,
                        &format!("{k} 必填"),
                    )),
                });
            }
        }
    }
    for v in &vals {
        if let Some(p) = crate::shell_tool::denied_path(v) {
            return Err(ToolResult {
                ok: false,
                output: format!("涉及受保护路径 `{p}` —— 读写删都不许碰（有意安全升级）"),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "denied": "path_denied", "path": p }),
                    ErrorCode::Denied,
                    "受保护路径",
                )),
            });
        }
    }
    Ok((vals, None))
}

/// 文件族统一分发执行器
pub struct FileExecutor;

#[async_trait]
impl ToolExecutor for FileExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "write_file" => do_write(call).await,
            "edit_file" => do_edit(call).await,
            "list_directory" => do_list(call).await,
            "mkdir" => do_mkdir(call).await,
            "move_file" => do_move(call).await,
            "delete_file" => do_delete(call).await,
            other => ToolResult {
                ok: false,
                output: format!("文件族没有 `{other}`（未迁移完成，不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

async fn do_write(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let (v, _) = match guard_write_path(&call, &["path", "content"]) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let (path, content) = (&v[0], &v[1]);
    // 父目录不存在 ⇒ 拒绝（不自动建整条路径，避免"写到了想不到的地方"）
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return ToolResult {
                ok: false,
                output: format!("父目录不存在: {}（先用 mkdir 建目录）", parent.display()),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::NotFound, "父目录不存在")),
            };
        }
    }
    match std::fs::write(path, content) {
        Ok(()) => ToolResult {
            ok: true,
            // 成功必须自带读回事实（TS write-verify 基线）
            output: format!("已写入 {path}（{} 字节）\n{}", content.len(), verify_write(path, false)),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(true),
            evidence: Some(serde_json::json!({ "path": path, "bytes": content.len() })),
        },
        Err(e) => ToolResult {
            ok: false,
            // 失败**原样返回不拼**已核对
            output: format!("写入失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "io_error": e.to_string() }),
                ErrorCode::Internal,
                "写入失败",
            )),
        },
    }
}

/// 统一 diff 的最大输出行数 (终端节选; 超出只报统计, 不把整段灌进上下文)
const DIFF_MAX_LINES: usize = 24;

/// 生成**有界** unified diff (无上下文行的行级 diff)。
///
/// 为什么要自己写: `edit_file` 的语义是"精确替换一处", 用户要看的是**改了什么**,
/// 而不是"已替换"三个字。输出必须短 (节选上限), 否则会把上下文窗口和终端一起冲垮。
pub fn bounded_diff(path: &str, before: &str, after: &str) -> String {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();
    // 公共前缀 / 后缀 (单点替换只需这两步就能定位)
    let mut pre = 0usize;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0usize;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let old_mid = &a[pre..a.len() - suf];
    let new_mid = &b[pre..b.len() - suf];
    if old_mid.is_empty() && new_mid.is_empty() {
        return String::new(); // 内容没变
    }
    let mut out = vec![format!("--- a/{path}"), format!("+++ b/{path}")];
    out.push(format!(
        "@@ -{},{} +{},{} @@",
        pre + 1,
        old_mid.len(),
        pre + 1,
        new_mid.len()
    ));
    let mut shown = 0usize;
    for l in old_mid {
        if shown >= DIFF_MAX_LINES {
            out.push(format!("… 省略 {} 行删除", old_mid.len() - shown));
            break;
        }
        out.push(format!("-{l}"));
        shown += 1;
    }
    shown = 0;
    for l in new_mid {
        if shown >= DIFF_MAX_LINES {
            out.push(format!("… 省略 {} 行新增", new_mid.len() - shown));
            break;
        }
        out.push(format!("+{l}"));
        shown += 1;
    }
    out.join("\n")
}

async fn do_edit(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let (v, _) = match guard_write_path(&call, &["path", "old_text", "new_text"]) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let (path, old_text, new_text) = (&v[0], v[1].as_str(), v[2].as_str());
    let src = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            return ToolResult {
                ok: false,
                output: format!("读取失败: {e}"),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "path": path, "io_error": e.to_string() }),
                    ErrorCode::NotFound,
                    "读取失败",
                )),
            };
        }
    };
    let hits = src.matches(old_text).count();
    if hits == 0 {
        return ToolResult {
            ok: false,
            output: format!("没找到要替换的内容（old_text 在 {path} 里 0 处命中）"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::NotFound, "old_text 未命中")),
        };
    }
    if hits > 1 {
        // 多处命中 ⇒ 拒绝并要求更具体（不猜改哪一处 —— 决策 2：不把歧义当许可）
        return ToolResult {
            ok: false,
            output: format!("old_text 命中 {hits} 处 —— 请把 old_text 写得更具体（不猜改哪一处）"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "hits": hits }),
                ErrorCode::InvalidArgument,
                "old_text 多处命中",
            )),
        };
    }
    let out = src.replace(old_text, new_text);
    // 先算 diff 再写 (write 会拿走所有权)
    let diff_txt = bounded_diff(path, &src, &out);
    match std::fs::write(path, out) {
        Ok(()) => ToolResult {
            ok: true,
            output: format!(
                "已编辑 {path}\n{diff}\n{}",
                verify_write(path, false),
                diff = if diff_txt.is_empty() { "(内容未变)".to_string() } else { diff_txt }
            ),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(true),
            evidence: Some(serde_json::json!({ "path": path, "hits": hits })),
        },
        Err(e) => ToolResult {
            ok: false,
            output: format!("写回失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "io_error": e.to_string() }),
                ErrorCode::Internal,
                "写回失败",
            )),
        },
    }
}

async fn do_list(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let path = arg_str(&call, "path").unwrap_or(".").to_string();
    if let Some(p) = crate::shell_tool::denied_path(&path) {
        return ToolResult {
            ok: false,
            output: format!("涉及受保护路径 `{p}`"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::Denied, "受保护路径")),
        };
    }
    match std::fs::read_dir(&path) {
        Ok(rd) => {
            let mut entries: Vec<String> = Vec::new();
            for e in rd.flatten().take(MAX_LIST_ENTRIES) {
                let name = e.file_name().to_string_lossy().to_string();
                let kind = e.file_type().map(|t| if t.is_dir() { "/" } else { "" }).unwrap_or("");
                entries.push(format!("{name}{kind}"));
            }
            entries.sort();
            ToolResult {
                ok: true,
                output: if entries.is_empty() {
                    format!("{path}（空目录）")
                } else {
                    format!("{path} 共 {} 项:\n{}", entries.len(), entries.join("\n"))
                },
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(true),
                evidence: Some(serde_json::json!({ "path": path, "count": entries.len() })),
            }
        }
        Err(e) => ToolResult {
            ok: false,
            output: format!("列目录失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "io_error": e.to_string() }),
                ErrorCode::NotFound,
                "列目录失败",
            )),
        },
    }
}

async fn do_mkdir(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let (v, _) = match guard_write_path(&call, &["path"]) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let path = &v[0];
    match std::fs::create_dir_all(path) {
        Ok(()) => ToolResult {
            ok: true,
            output: format!("已建目录 {path}\n{}", verify_write(path, true)),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(true),
            evidence: Some(serde_json::json!({ "path": path })),
        },
        Err(e) => ToolResult {
            ok: false,
            output: format!("建目录失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "io_error": e.to_string() }),
                ErrorCode::Internal,
                "建目录失败",
            )),
        },
    }
}

async fn do_move(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let (v, _) = match guard_write_path(&call, &["from", "to"]) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let (from, to) = (&v[0], &v[1]);
    match std::fs::rename(from, to) {
        Ok(()) => ToolResult {
            ok: true,
            output: format!("已移动 {from} → {to}\n{}", verify_write(to, false)),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(true),
            evidence: Some(serde_json::json!({ "from": from, "to": to })),
        },
        Err(e) => ToolResult {
            ok: false,
            output: format!("移动失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "from": from, "to": to, "io_error": e.to_string() }),
                ErrorCode::Internal,
                "移动失败",
            )),
        },
    }
}

async fn do_delete(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let (v, _) = match guard_write_path(&call, &["path"]) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let path = &v[0];
    let meta = std::path::Path::new(path);
    if meta.is_dir() {
        return ToolResult {
            ok: false,
            output: format!("{path} 是目录 —— delete_file 只删文件（目录删除不可撤回，需显式工具）"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::InvalidArgument, "目录不删")),
        };
    }
    match std::fs::remove_file(path) {
        Ok(()) => ToolResult {
            ok: true,
            // 删除后无物可读回 ⇒ **不拼** [已核对]（不许把"删掉了"说成"核对过"）
            output: format!("已删除 {path}（不可逆，无读回自证）"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(true),
            evidence: Some(serde_json::json!({ "path": path, "deleted": true })),
        },
        Err(e) => ToolResult {
            ok: false,
            output: format!("删除失败: {e}"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "path": path, "io_error": e.to_string() }),
                ErrorCode::NotFound,
                "删除失败",
            )),
        },
    }
}

// ── 工具定义 ────────────────────────────────────────────────

fn write_file_def() -> ToolDef {
    ToolDef {
        name: "write_file".into(),
        description: "写入文件（整篇覆盖）。成功后返回读回自证（字节数 + 时间）。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径（必填；父目录须已存在）" },
                "content": { "type": "string", "description": "完整内容（必填）" }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        }),
        effect: EffectKind::Write,
        default_allowed: false, // 可逆写入：需授予
    }
}

fn edit_file_def() -> ToolDef {
    ToolDef {
        name: "edit_file".into(),
        description: "按 old_text 精确替换一处（多处命中会拒绝并要求更具体）。成功后返回读回自证。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径（必填）" },
                "old_text": { "type": "string", "description": "要被替换的原文（必填，须唯一命中）" },
                "new_text": { "type": "string", "description": "替换后的内容（必填）" }
            },
            "required": ["path", "old_text", "new_text"],
            "additionalProperties": false
        }),
        effect: EffectKind::Write,
        default_allowed: false,
    }
}

fn list_directory_def() -> ToolDef {
    ToolDef {
        name: "list_directory".into(),
        description: "列出目录内容（最多 200 项）。只读。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "目录路径（可选，默认当前目录）" }
            },
            "additionalProperties": false
        }),
        effect: EffectKind::Read,
        default_allowed: true, // 只读
    }
}

fn mkdir_def() -> ToolDef {
    ToolDef {
        name: "mkdir".into(),
        description: "创建目录（含父目录）。成功后返回读回自证。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "目录路径（必填）" }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
        effect: EffectKind::Write,
        default_allowed: false,
    }
}

fn move_file_def() -> ToolDef {
    ToolDef {
        name: "move_file".into(),
        description: "移动/重命名文件。成功后返回读回自证。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "源路径（必填）" },
                "to": { "type": "string", "description": "目标路径（必填）" }
            },
            "required": ["from", "to"],
            "additionalProperties": false
        }),
        effect: EffectKind::Write,
        default_allowed: false,
    }
}

fn delete_file_def() -> ToolDef {
    ToolDef {
        name: "delete_file".into(),
        description: "删除文件（**不可逆**，只删文件不删目录）。不随默认授予，需显式授权。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "文件路径（必填）" }
            },
            "required": ["path"],
            "additionalProperties": false
        }),
        effect: EffectKind::Write,
        default_allowed: false, // 不可逆：与可逆写分级，不随 CLI 默认授予
    }
}

/// 文件族全部工具定义
pub fn file_tool_defs() -> Vec<ToolDef> {
    vec![
        write_file_def(),
        edit_file_def(),
        list_directory_def(),
        mkdir_def(),
        move_file_def(),
        delete_file_def(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("bolloon_file_tools_{}_{}", std::process::id(), name))
    }

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args }
    }

    /// **TS 基线**: 写成功必须自带读回事实（k10-write-verify-wiring 钉住的行为）
    #[tokio::test]
    async fn write_success_carries_readback_proof() {
        let p = tmp("write.txt");
        let r = FileExecutor
            .execute(call("write_file", serde_json::json!({ "path": p.display().to_string(), "content": "hello" })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("[已核对] 文件已落盘"), "必须有读回自证: {}", r.output);
        assert!(r.output.contains("5 字节"), "字节数要真: {}", r.output);
        let _ = std::fs::remove_file(&p);
    }

    /// **TS 基线**: 失败**原样返回不拼**已核对
    #[tokio::test]
    async fn write_failure_does_not_claim_verified() {
        let r = FileExecutor
            .execute(call("write_file", serde_json::json!({ "path": "/no/such/dir/x.txt", "content": "x" })))
            .await;
        assert!(!r.ok);
        assert!(!r.output.contains("[已核对]"), "失败不许拼已核对: {}", r.output);
        assert_eq!(r.verified, Some(false));
    }

    #[tokio::test]
    async fn edit_replaces_single_hit_and_proves() {
        let p = tmp("edit.txt");
        std::fs::write(&p, "aaa\nbbb\n").unwrap();
        let r = FileExecutor
            .execute(call("edit_file", serde_json::json!({
                "path": p.display().to_string(), "old_text": "bbb", "new_text": "ccc"
            })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("[已核对]"), "{}", r.output);
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "aaa\nccc\n");
        let _ = std::fs::remove_file(&p);
    }

    /// 多处命中 ⇒ 拒绝（不猜改哪一处）
    #[tokio::test]
    async fn edit_refuses_ambiguous_match() {
        let p = tmp("amb.txt");
        std::fs::write(&p, "x\nx\n").unwrap();
        let r = FileExecutor
            .execute(call("edit_file", serde_json::json!({
                "path": p.display().to_string(), "old_text": "x", "new_text": "y"
            })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("多处") || r.output.contains("更具体"), "{}", r.output);
        let _ = std::fs::remove_file(&p);
    }

    /// 安全升级: 读写删都不许碰凭据路径
    #[tokio::test]
    async fn credential_paths_refused_for_write_and_delete() {
        for (name, args) in [
            ("write_file", serde_json::json!({ "path": ".env", "content": "x" })),
            ("delete_file", serde_json::json!({ "path": "a/b.pem" })),
            ("mkdir", serde_json::json!({ "path": ".bolloon/keypair" })),
        ] {
            let r = FileExecutor.execute(call(name, args)).await;
            assert!(!r.ok, "{name} 必须拒绝凭据路径");
            assert!(r.output.contains("受保护路径"), "{name} → {}", r.output);
        }
    }

    /// 入口校验: 必填参数
    #[tokio::test]
    async fn missing_args_rejected_at_entry() {
        let r = FileExecutor.execute(call("write_file", serde_json::json!({ "path": "a" }))).await;
        assert!(!r.ok);
        assert!(r.output.contains("content 必填"), "{}", r.output);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "invalid_argument");
    }

    /// mkdir 成功 → 目录自证
    #[tokio::test]
    async fn mkdir_proves_directory_exists() {
        let p = tmp("dirA");
        let r = FileExecutor.execute(call("mkdir", serde_json::json!({ "path": p.display().to_string() }))).await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("[已核对] 目录存在"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&p);
    }

    /// delete 是文件级 + 删后**不**冒充核对
    #[tokio::test]
    async fn delete_removes_file_without_fake_proof() {
        let p = tmp("del.txt");
        std::fs::write(&p, "bye").unwrap();
        let r = FileExecutor.execute(call("delete_file", serde_json::json!({ "path": p.display().to_string() }))).await;
        assert!(r.ok, "{}", r.output);
        assert!(!r.output.contains("[已核对]"), "删后无物可读回, 不许拼自证: {}", r.output);
        assert!(!p.exists());
    }

    /// 只读默认允许；写/删都不默认允许（分级）
    #[test]
    fn effect_and_default_allowed_are_graded() {
        let ro = list_directory_def();
        assert_eq!(ro.effect, EffectKind::Read);
        assert!(ro.default_allowed, "只读默认允许");
        for d in [write_file_def(), edit_file_def(), mkdir_def(), move_file_def(), delete_file_def()] {
            assert_eq!(d.effect, EffectKind::Write);
            assert!(!d.default_allowed, "{} 不该默认允许", d.name);
        }
    }

    /// diff 必须**看得见改动**, 而且**有界** (24 行封顶), 不然会把终端/上下文一起冲垮
    #[test]
    fn bounded_diff_shows_single_replacement() {
        let d = super::bounded_diff("a.rs", "fn a() {}\nlet x = 1;\n", "fn a() {}\nlet x = 2;\n");
        assert!(d.contains("--- a/a.rs"), "{d}");
        assert!(d.contains("-let x = 1;"), "{d}");
        assert!(d.contains("+let x = 2;"), "{d}");
    }
    #[test]
    fn bounded_diff_is_capped() {
        let before: String = (0..200).map(|i| format!("old {i}\n")).collect();
        let after: String = (0..200).map(|i| format!("new {i}\n")).collect();
        let d = super::bounded_diff("big.txt", &before, &after);
        assert!(d.lines().count() <= 3 + 2 * super::DIFF_MAX_LINES + 2, "{}", d.lines().count());
        assert!(d.contains("省略"), "超长要如实说省略了多少: {d}");
    }
    #[test]
    fn bounded_diff_empty_when_unchanged() {
        assert_eq!(super::bounded_diff("x", "a\nb\n", "a\nb\n"), "");
    }
}
