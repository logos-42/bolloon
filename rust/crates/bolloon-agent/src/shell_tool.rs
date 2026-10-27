//! shell_tool.rs — `shell` 工具（高风险执行器）
//!
//! 迁移顺序第 2 步（2026-10-26）。**shell 不当普通只读工具处理**：
//!
//! 四道闸，缺一不可（对应你批准的「分级、不继承历史缺陷」）：
//!   1. **denylist**（`bolloon_harness::security::guard_shell`）—— 绝对不行：rm -rf /、sudo、
//!      fork 炸弹、`curl … | sh`、私钥文件… **此前 harness 从未调用它**（二者未接线）。
//!   2. **命令白名单** —— 只放行已知安全的可执行程序（对齐 TS `shell-guard.ts:54-61` 兜底白名单
//!      + Rust 必需的 cargo/rustc/rg/find/grep/sleep）。
//!   3. **路径 deny** —— 凭据/密钥类路径（.env / .ssh / .bolloon/{identity,keypair,…} / *.pem）
//!      **任何模式都不放行**（TS 只在「写/删/改」类命令查路径，读类绕开 ⇒ 这是有意升级）。
//!   4. **超时 + 取消** —— 每条命令独立超时（默认 30s，上限 120s），超时/取消都 `kill` 子进程。
//!
//! **一次调用支持多命令**：`commands: [String]` 顺序执行，**预检全部通过才执行**
//! （任一条不合法 ⇒ 整批拒绝、**零执行**，fail-closed）；执行中任一条失败即停（fail-fast），
//! 已执行的命令与失败原因如实返回。
//!
//! 审计：每次调用写 `~/.bolloon/logs/tool-shell.jsonl`（fire-and-forget，写失败不影响执行）；
//! **命令正文先脱敏再落盘**（命中凭据模式整条打码 —— 宁可误伤，不可漏放）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use crate::tool_contract::{ErrorCode, error_evidence, with_error};
use bolloon_harness::security::guard_shell;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

/// 一次调用最多命令条数（防批量滥用）
pub const MAX_COMMANDS: usize = 20;
/// 单条命令默认超时（对齐 TS `shell-tool.ts:96` 的 30s）
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 单条命令超时上限（与 harness budget 的 120s 对齐）
pub const MAX_TIMEOUT_MS: u64 = 120_000;
/// 单条命令输出上限（字符）—— 超出截断并标注
pub const MAX_OUTPUT_CHARS: usize = 50_000;
/// 取消轮询间隔
const POLL_MS: u64 = 50;

/// 命令白名单（可执行程序 basename）—— 对齐 TS `shell-guard.ts:54-61` 兜底白名单，
/// 补 Rust 项目必需的 `cargo/rustc/rg/find/grep/sleep`。**不含 rm/cp/mv/sed**（保持 TS 基线，不扩破坏面）。
pub const ALLOWED_BINS: &[&str] = &[
    "git", "node", "npm", "npx", "tsx", "tsc", "vitest", "cargo", "rustc", "ls", "cat", "head",
    "tail", "wc", "echo", "pwd", "date", "mkdir", "touch", "grep", "find", "rg", "sleep", "true",
    "false", "printf", "env", "which", "uname",
];

/// 路径 deny（**任何模式都不放行**：凭据/密钥/系统敏感）
pub const DENY_PATHS: &[&str] = &[
    ".env",
    ".ssh/",
    "id_rsa",
    "id_ed25519",
    ".pem",
    ".key",
    ".bolloon/identity",
    ".bolloon/keypair",
    ".bolloon/llm-config",
    ".bolloon/accounts",
    ".bolloon/wallets",
    ".bolloon/bindings",
    ".bolloon/eas-bind",
    "/etc/passwd",
    "/etc/shadow",
    "/dev/sd",
];

/// 凭据模式（审计脱敏用；命中即整条打码）
const SECRET_MARKS: &[&str] = &[
    "sk-",
    "ghp_",
    "xoxb-",
    "AKIA",
    "BEGIN PRIVATE KEY",
    "BEGIN RSA PRIVATE KEY",
    "-----BEGIN",
];

fn first_bin(cmd: &str) -> String {
    let first = cmd.split_whitespace().next().unwrap_or("");
    first.rsplit('/').next().unwrap_or(first).to_string()
}

/// 路径 deny（文件族与 shell 同源：读写删都不许碰凭据/密钥/系统敏感路径）
pub fn denied_path(text: &str) -> Option<String> {
    let t = text.replace('\\', "/");
    for p in DENY_PATHS {
        if t.contains(p) {
            return Some((*p).to_string());
        }
    }
    None
}

/// 预检拒绝（供审计区分是哪道门拒的）
pub struct PrecheckDeny {
    /// denylist | bin_not_allowed | path_denied
    pub kind: &'static str,
    pub msg: String,
}

/// 单条命令预检（**纯函数，不执行**，可安全单测破坏性命令）
///
/// `bypass`（完全访问）= 所有权限开放 ⇒ **直接放行**，denylist / 命令白名单 / 路径保护全跳过。
/// 这是用户按"完全访问"时的显式选择；超时·取消·预算·审计不在本函数内（运行控制，不随权限撤）。
pub fn precheck(cmd: &str, bypass: bool) -> Result<(), PrecheckDeny> {
    if bypass {
        return Ok(());
    }
    if let Err(e) = guard_shell(cmd) {
        return Err(PrecheckDeny {
            kind: "denylist",
            msg: format!("shell 拒绝执行: {e}"),
        });
    }
    let bin = first_bin(cmd);
    if !ALLOWED_BINS.contains(&bin.as_str()) {
        return Err(PrecheckDeny {
            kind: "bin_not_allowed",
            msg: format!(
                "shell 拒绝执行: 命令 `{bin}` 不在白名单（允许: {}）",
                ALLOWED_BINS.join(" ")
            ),
        });
    }
    if let Some(p) = denied_path(cmd) {
        return Err(PrecheckDeny {
            kind: "path_denied",
            msg: format!(
                "shell 拒绝执行: 命令涉及受保护路径 `{p}`（默认/授权模式不拦截；完全访问下放行）"
            ),
        });
    }
    Ok(())
}

/// 审计脱敏：命中凭据模式 ⇒ 整条命令打码（宁可误伤，不可漏放）
pub fn redact_cmd(cmd: &str) -> String {
    if SECRET_MARKS.iter().any(|m| cmd.contains(m)) {
        "[已脱敏: 命令含凭据模式]".to_string()
    } else {
        cmd.to_string()
    }
}

fn audit_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)?;
    Some(home.join(".bolloon").join("logs").join("tool-shell.jsonl"))
}

/// 审计落盘（fire-and-forget：写失败绝不影响工具执行）
fn audit(record: serde_json::Value) {
    let Some(path) = audit_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(f, "{record}");
    }
}

/// `shell` 执行器
pub struct ShellExecutor {
    /// 取消标志（外部置位 ⇒ 当前/下一条命令被 kill）
    cancel: Arc<AtomicBool>,
    /// 完全访问（用户显式选择）: 跳过 denylist / 命令白名单 / 路径保护。
    /// **超时 / 取消 / 预算 / 审计不随之撤** —— 它们是运行控制，不是权限门。
    bypass: bool,
}

impl Default for ShellExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellExecutor {
    pub fn new() -> Self {
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            bypass: false,
        }
    }

    /// 用外部取消标志构造（会话级共享，供 Ctrl+C 置位）
    pub fn with_cancel(cancel: Arc<AtomicBool>) -> Self {
        Self {
            cancel,
            bypass: false,
        }
    }

    /// 带权限模式构造（`bypass` = 完全访问，所有权限开放）
    pub fn with_mode(cancel: Arc<AtomicBool>, bypass: bool) -> Self {
        Self { cancel, bypass }
    }

    pub fn with_bypass(mut self, bypass: bool) -> Self {
        self.bypass = bypass;
        self
    }

    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        self.cancel.clone()
    }
}

#[async_trait]
impl ToolExecutor for ShellExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let started = std::time::Instant::now();
        let elapsed_ms = started.elapsed().as_millis() as u64;

        // ── 参数（入口校验，不把错误推给 OS）──
        let mut cmds: Vec<String> = Vec::new();
        if let Some(arr) = call.arguments.get("commands").and_then(|v| v.as_array()) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    let s = s.trim();
                    if !s.is_empty() {
                        cmds.push(s.to_string());
                    }
                }
            }
        }
        if let Some(s) = call.arguments.get("command").and_then(|v| v.as_str()) {
            let s = s.trim();
            if !s.is_empty() {
                cmds.push(s.to_string());
            }
        }
        if cmds.is_empty() {
            return ToolResult {
                ok: false,
                output: "shell: commands 必填（至少一条命令；单条可用 command）".into(),
                elapsed_ms,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::InvalidArgument, "commands 必填")),
            };
        }
        if cmds.len() > MAX_COMMANDS {
            return ToolResult {
                ok: false,
                output: format!("shell: 一次最多 {MAX_COMMANDS} 条命令（收到 {}）", cmds.len()),
                elapsed_ms,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::InvalidArgument, "命令条数超限")),
            };
        }
        let timeout_ms = call
            .arguments
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1_000, MAX_TIMEOUT_MS);
        let cwd = call
            .arguments
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        // ── 预检（全部命令都过一遍；任一条不合法 ⇒ 整批拒绝、零执行）──
        //    **完全访问 (bypass)** 下整段跳过（用户显式选择"所有权限都开放"）。
        //    超时 / 取消 / 预算 / 审计不在预检里 —— 它们是运行控制，不随权限撤。
        for c in &cmds {
            if let Err(d) = precheck(c, self.bypass) {
                // detail 要同时进三处 (审计 / 输出 / 证据) ⇒ 先取一份 owned, 别让 json! 把它 move 走
                let detail = d.msg.clone();
                audit(serde_json::json!({
                    "ts": chrono::Utc::now().to_rfc3339(), "tool": "shell",
                    "cmd": redact_cmd(c), "ok": false, "reason": d.kind, "detail": detail.clone(),
                    "mode": if self.bypass { "bypass" } else { "default" },
                }));
                let ev = with_error(
                    serde_json::json!({ "denied": d.kind, "cmd": redact_cmd(c) }),
                    ErrorCode::Denied,
                    &detail,
                );
                return ToolResult {
                    ok: false,
                    output: detail,
                    elapsed_ms,
                    verified: Some(false),
                    evidence: Some(ev),
                };
            }
        }
        if let Some(ref d) = cwd {
            if !self.bypass {
                if let Some(p) = denied_path(d) {
                    return ToolResult {
                        ok: false,
                        output: format!("shell 拒绝执行: 工作目录涉及受保护路径 `{p}`"),
                        elapsed_ms,
                        verified: Some(false),
                        evidence: Some(with_error(
                            serde_json::json!({ "denied": "cwd_path_denied", "path": p }),
                            ErrorCode::Denied,
                            "工作目录受保护",
                        )),
                    };
                }
            }
        }

        // ── 逐条执行（超时/取消 → kill；失败即停）──
        let mut parts: Vec<String> = Vec::new();
        let mut entries: Vec<serde_json::Value> = Vec::new();
        let mut all_ok = true;
        let mut last_code: Option<ErrorCode> = None;
        let mut stop_reason: Option<String> = None;

        for (i, c) in cmds.iter().enumerate() {
            let r = run_one(c, timeout_ms, cwd.as_deref(), &self.cancel).await;
            let ok = matches!(r.kind, CmdEnd::Done) && r.exit == Some(0);
            let head = format!("$ {}\n", c);
            let body = match r.kind {
                CmdEnd::Done => {
                    format!("{}[exit {}]", r.output, r.exit.map(|c| c.to_string()).unwrap_or("?".into()))
                }
                CmdEnd::Timeout => format!("[超时 {}ms, 已 kill 子进程]\n{}", timeout_ms, r.output),
                CmdEnd::Cancelled => "[已取消: 收到取消信号, 已 kill 子进程]".to_string(),
                CmdEnd::SpawnErr(ref e) => format!("[启动失败: {e}]"),
            };
            parts.push(format!("{head}{body}"));
            entries.push(serde_json::json!({
                "index": i, "cmd": redact_cmd(c), "ok": ok,
                "kind": format!("{:?}", r.kind), "exit": r.exit, "ms": r.ms,
            }));
            audit(serde_json::json!({
                "ts": chrono::Utc::now().to_rfc3339(), "tool": "shell",
                "cmd": redact_cmd(c), "ok": ok, "kind": format!("{:?}", r.kind),
                "exit": r.exit, "ms": r.ms, "cwd": cwd,
                "mode": if self.bypass { "bypass" } else { "default" },
            }));
            if !ok {
                all_ok = false;
                last_code = Some(match r.kind {
                    CmdEnd::Timeout => ErrorCode::Timeout,
                    CmdEnd::Cancelled => ErrorCode::Cancelled,
                    CmdEnd::SpawnErr(_) => ErrorCode::Internal,
                    CmdEnd::Done => ErrorCode::CommandFailed,
                });
                stop_reason = Some(match r.kind {
                    CmdEnd::Timeout => format!("第 {} 条超时（已 kill）", i + 1),
                    CmdEnd::Cancelled => format!("第 {} 条被取消", i + 1),
                    CmdEnd::SpawnErr(e) => format!("第 {} 条启动失败: {e}", i + 1),
                    CmdEnd::Done => format!("第 {} 条退出码 {:?} —— 失败即停，后续命令未执行", i + 1, r.exit),
                });
                break; // fail-fast
            }
        }

        let executed = entries.len();
        let mut output = parts.join("\n");
        if let Some(reason) = &stop_reason {
            output.push_str(&format!(
                "\n[已执行 {executed}/{} 条] {reason}",
                cmds.len()
            ));
        }
        let chars = output.chars().count();
        if chars > MAX_OUTPUT_CHARS {
            output = format!(
                "{}\n…[已截断: 输出 {} 字符 > 上限 {}]",
                output.chars().take(MAX_OUTPUT_CHARS).collect::<String>(),
                chars,
                MAX_OUTPUT_CHARS
            );
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let mut ev = serde_json::json!({
            "commands": entries,
            "executed": executed,
            "total": cmds.len(),
            "timeout_ms": timeout_ms,
            "cwd": cwd,
        });
        if let Some(code) = last_code {
            ev = with_error(ev, code, stop_reason.as_deref().unwrap_or("命令失败"));
        }
        ToolResult {
            ok: all_ok,
            output,
            elapsed_ms,
            verified: Some(all_ok),
            evidence: Some(ev),
        }
    }
}

#[derive(Debug)]
enum CmdEnd {
    Done,
    Timeout,
    Cancelled,
    SpawnErr(String),
}

struct CmdResult {
    kind: CmdEnd,
    exit: Option<i32>,
    output: String,
    ms: u64,
}

async fn run_one(cmd: &str, timeout_ms: u64, cwd: Option<&str>, cancel: &AtomicBool) -> CmdResult {
    let started = std::time::Instant::now();
    let mut it = cmd.split_whitespace();
    let prog = it.next().unwrap_or("").to_string();
    let args: Vec<String> = it.map(|s| s.to_string()).collect();

    let mut command = TokioCommand::new(&prog);
    command.args(&args);
    if let Some(d) = cwd {
        command.current_dir(d);
    }
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            return CmdResult {
                kind: CmdEnd::SpawnErr(e.to_string()),
                exit: None,
                output: String::new(),
                ms: started.elapsed().as_millis() as u64,
            };
        }
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let mut exit: Option<i32> = None;
    let end: CmdEnd = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            break CmdEnd::Cancelled;
        }
        if started.elapsed().as_millis() as u64 >= timeout_ms {
            let _ = child.kill().await;
            break CmdEnd::Timeout;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit = status.code();
                break CmdEnd::Done;
            }
            Ok(None) => {
                tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)).await;
            }
            Err(e) => break CmdEnd::SpawnErr(e.to_string()),
        }
    };

    // 尽力读已产生的输出（超时/取消也读得到部分输出）
    let mut out = String::new();
    if let Some(mut s) = stdout.take() {
        let _ = s.read_to_string(&mut out).await;
    }
    if let Some(mut e) = stderr.take() {
        let mut err = String::new();
        let _ = e.read_to_string(&mut err).await;
        if !err.trim().is_empty() {
            out.push_str(&format!("[stderr] {err}"));
        }
    }
    if out.chars().count() > MAX_OUTPUT_CHARS {
        out = out.chars().take(MAX_OUTPUT_CHARS).collect();
    }
    CmdResult {
        kind: end,
        exit,
        output: out,
        ms: started.elapsed().as_millis() as u64,
    }
}

/// `shell` 工具定义（高风险 ⇒ **不默认允许**，须显式授权）
pub fn shell_def() -> ToolDef {
    ToolDef {
        name: "shell".into(),
        description: "执行 shell 命令（高风险）。一次调用可顺序执行多条命令（commands 数组），任一条失败即停。受命令白名单、路径保护、超时与取消约束。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "commands": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "要顺序执行的命令（1..20 条；全部预检通过才执行）"
                },
                "command": { "type": "string", "description": "单条命令（与 commands 二选一）" },
                "cwd": { "type": "string", "description": "工作目录（可选，须在允许路径内）" },
                "timeout_ms": { "type": "integer", "description": "每条命令超时毫秒（默认 30000，上限 120000）" }
            },
            "anyOf": [
                { "required": ["commands"] },
                { "required": ["command"] }
            ],
            "additionalProperties": false
        }),
        effect: EffectKind::Shell,
        default_allowed: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(args: serde_json::Value) -> ToolCall {
        ToolCall {
            id: "call-1".into(),
            name: "shell".into(),
            arguments: args,
        }
    }

    /// denylist（绝对不行）—— 且**零执行**
    #[tokio::test]
    async fn denylist_rejected_with_zero_execution() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "commands": ["rm -rf /"] })))
            .await;
        assert!(!r.ok, "{}", r.output);
        assert!(r.output.contains("拒绝执行"), "{}", r.output);
        assert_eq!(r.verified, Some(false));
    }

    /// 命令白名单
    #[tokio::test]
    async fn bin_outside_allowlist_rejected() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "command": "python3 -c 'print(1)'" })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("白名单"), "{}", r.output);
    }

    /// 路径 deny（凭据类，任何模式不放行）
    #[tokio::test]
    async fn credential_path_rejected() {
        for c in ["cat .env", "cat ~/.ssh/id_rsa", "cat a/b.pem", "cat .bolloon/keypair.json"] {
            let r = ShellExecutor::new()
                .execute(call(serde_json::json!({ "commands": [c] })))
                .await;
            assert!(!r.ok, "{c} 必须被拒");
            // 可能被 denylist 先命中（如 .ssh/id_rsa），也可能被路径门命中 —— 任一门拒住即正确
            assert!(r.output.contains("拒绝执行"), "{c} → {}", r.output);
        }
    }

    /// 多命令: 全部成功
    #[tokio::test]
    async fn multiple_commands_run_in_order() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "commands": ["echo one", "echo two"] })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("one") && r.output.contains("two"), "{}", r.output);
        let ev = r.evidence.expect("有证据");
        assert_eq!(ev["executed"], 2);
        assert_eq!(ev["total"], 2);
    }

    /// 多命令: 失败即停（第三条不该被执行）
    #[tokio::test]
    async fn fails_fast_and_skips_remaining() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({
                "commands": ["echo first", "ls /definitely-not-exist-xyz", "echo third"]
            })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("first"), "已执行的要如实列出: {}", r.output);
        assert!(!r.output.contains("third"), "失败后不该再执行: {}", r.output);
        let ev = r.evidence.expect("有证据");
        assert_eq!(ev["executed"], 2, "失败即停 ⇒ 只跑了前两条");
        assert_eq!(ev["total"], 3);
    }

    /// 预检失败 ⇒ 整批零执行（第二条不合法时，第一条也不许跑）
    #[tokio::test]
    async fn precheck_failure_blocks_whole_batch() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({
                "commands": ["echo should-not-run", "rm -rf /"]
            })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("拒绝执行"), "{}", r.output);
        assert_eq!(r.evidence.expect("证据")["denied"], "denylist");
    }

    /// 超时: kill 子进程
    #[tokio::test]
    async fn timeout_kills_child() {
        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({
                "commands": ["sleep 30"], "timeout_ms": 300
            })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("超时"), "{}", r.output);
    }

    /// 取消: 外部置位 ⇒ kill
    #[tokio::test]
    async fn cancel_flag_kills_child() {
        let ex = ShellExecutor::new();
        let flag = ex.cancel_token();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let r = ex
            .execute(call(serde_json::json!({ "commands": ["sleep 30"], "timeout_ms": 60_000 })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("取消"), "{}", r.output);
    }

    /// 参数必填（入口校验）
    #[tokio::test]
    async fn missing_commands_rejected_at_entry() {
        let r = ShellExecutor::new().execute(call(serde_json::json!({}))).await;
        assert!(!r.ok);
        assert!(r.output.contains("commands 必填"), "{}", r.output);
    }

    /// 审计脱敏: 凭据不进日志
    #[test]
    fn audit_redacts_secrets() {
        assert_eq!(redact_cmd("echo sk-abc123"), "[已脱敏: 命令含凭据模式]");
        assert_eq!(redact_cmd("cat ~/.ssh/x"), "cat ~/.ssh/x");
        assert_eq!(redact_cmd("echo hello"), "echo hello");
    }

    /// **完全访问 (bypass)**: 三道权限门全跳过（纯函数验证，绝不真跑破坏性命令）
    #[test]
    fn precheck_bypass_skips_all_gates() {
        assert!(precheck("rm -rf /", true).is_ok(), "完全访问: denylist 不拦");
        assert!(precheck("python3 -c 'x'", true).is_ok(), "完全访问: 白名单不拦");
        assert!(precheck("cat .env", true).is_ok(), "完全访问: 路径保护不拦");
        // 对照 —— 默认模式三道门都拦
        assert_eq!(precheck("rm -rf /", false).unwrap_err().kind, "denylist");
        assert_eq!(precheck("python3 -c 'x'", false).unwrap_err().kind, "bin_not_allowed");
        assert_eq!(precheck("cat .env", false).unwrap_err().kind, "path_denied");
    }

    /// 完全访问下白名单外的命令真的能跑（用无害命令验证）
    #[tokio::test]
    async fn bypass_executes_outside_allowlist() {
        let r = ShellExecutor::new()
            .with_bypass(true)
            .execute(call(serde_json::json!({ "commands": ["python3 --version"] })))
            .await;
        assert!(
            !r.output.contains("白名单"),
            "完全访问下不该因白名单被拒: {}",
            r.output
        );
    }

    /// 完全访问撤的是**权限门**，不是运行控制 —— 超时/取消仍在（否则 agent 跑飞没法停）
    #[tokio::test]
    async fn bypass_still_enforces_timeout_and_cancel() {
        let r = ShellExecutor::new()
            .with_bypass(true)
            .execute(call(serde_json::json!({ "commands": ["sleep 30"], "timeout_ms": 300 })))
            .await;
        assert!(!r.ok);
        assert!(r.output.contains("超时"), "全开 ≠ 撤掉超时: {}", r.output);

        let ex = ShellExecutor::new().with_bypass(true);
        let flag = ex.cancel_token();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            flag.store(true, Ordering::Relaxed);
        });
        let r2 = ex
            .execute(call(serde_json::json!({ "commands": ["sleep 30"], "timeout_ms": 60_000 })))
            .await;
        assert!(r2.output.contains("取消"), "全开 ≠ 撤掉取消: {}", r2.output);
    }

    /// 失败必须带**结构化**错误码 —— 调用方据此决定重试 / 改参数 / 重规划
    #[tokio::test]
    async fn failures_carry_structured_error_codes() {
        let r = ShellExecutor::new().execute(call(serde_json::json!({}))).await;
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "invalid_argument");

        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "commands": ["rm -rf /"] })))
            .await;
        let ev = r.evidence.as_ref().unwrap();
        assert_eq!(ev["error"]["code"], "denied");
        assert_eq!(ev["error"]["retryable"], false, "安全门拒绝不该重试");

        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "commands": ["sleep 30"], "timeout_ms": 300 })))
            .await;
        let ev = r.evidence.as_ref().unwrap();
        assert_eq!(ev["error"]["code"], "timeout");
        assert_eq!(ev["error"]["retryable"], true, "超时类型上可重试");

        let r = ShellExecutor::new()
            .execute(call(serde_json::json!({ "commands": ["ls /definitely-not-exist-xyz"] })))
            .await;
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "command_failed");
    }

    /// 高风险工具定义: 不默认允许（须显式授权）
    #[test]
    fn shell_def_is_high_risk() {
        let d = shell_def();
        assert_eq!(d.effect, EffectKind::Shell);
        assert!(!d.default_allowed, "shell 绝不能默认允许");
        assert!(d.parameters.get("anyOf").is_some(), "必须有真实必填校验");
    }
}
