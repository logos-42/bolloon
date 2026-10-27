//! git_tools.rs — Git 族（迁移第 4 步）
//!
//! 复用 Rust 已有的 git 纪律（`bolloon-agent/src/git.rs`：force-push main/master 永远拒、
//! `--no-verify` / `reset --hard` 需显式），这里只做**工具面适配**（参数 → git 子命令 → 结果）。
//!
//! 执行方式: spawn 真 `git`（tokio::process），带超时；**不自己解析 porcelain**（git.rs 已做）。
//!
//! 权限分级（决策 2 + TS 基线 `deny-default-git-tools`）:
//!   · 只读（status / diff / log / show / branch）= Read，默认允许
//!   · 本地写（add / commit）= Write，需授予
//!   · `git_push` = **不可逆外部副作用**，不随本地写授予（TS default 模式也是只禁 push）

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use crate::tool_contract::{ErrorCode, error_evidence, with_error};

/// 单条 git 命令超时（ms）
const GIT_TIMEOUT_MS: u64 = 30_000;

pub struct GitExecutor;

#[async_trait]
impl ToolExecutor for GitExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "git_status" => run_git_tool(&call, &["status", "--short"]).await,
            "git_diff" => run_git_tool(&call, &["diff"]).await,
            "git_log" => {
                let n = call
                    .arguments
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10)
                    .clamp(1, 100);
                let n = n.to_string();
                run_git_tool(&call, &["log", "--oneline", "-n", &n]).await
            }
            "git_show" => run_git_tool(&call, &["show", "--stat"]).await,
            "git_branch" => run_git_tool(&call, &["branch", "-a"]).await,
            "git_add" => {
                let files = match call.arguments.get("files").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                    _ => ".".to_string(),
                };
                run_git_tool(&call, &["add", &files]).await
            }
            "git_commit" => {
                let msg = match call.arguments.get("message").and_then(|v| v.as_str()) {
                    Some(s) if !s.trim().is_empty() => s.trim().to_string(),
                    _ => {
                        return ToolResult {
                            ok: false,
                            output: "git_commit: message 必填".into(),
                            elapsed_ms: 0,
                            verified: Some(false),
                            evidence: Some(error_evidence(ErrorCode::InvalidArgument, "message 必填")),
                        };
                    }
                };
                run_git_tool(&call, &["commit", "-m", &msg]).await
            }
            "git_push" => do_push(&call).await,
            other => ToolResult {
                ok: false,
                output: format!("Git 族没有 `{other}`（不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

/// push 单独处理: **force push 到 main/master 永远拒**（Rust git.rs 纪律，不重复放宽）
async fn do_push(call: &ToolCall) -> ToolResult {
    let remote = call
        .arguments
        .get("remote")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("origin")
        .to_string();
    let branch = call
        .arguments
        .get("branch")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("")
        .to_string();
    let force = call.arguments.get("force").and_then(|v| v.as_bool()).unwrap_or(false);

    let protected = branch == "main" || branch == "master";
    if force && protected {
        return ToolResult {
            ok: false,
            output: format!("拒绝 force push 到 `{branch}` —— 这条永远不许（对齐 git.rs 纪律）"),
            elapsed_ms: 0,
            verified: Some(false),
            evidence: Some(with_error(
                serde_json::json!({ "branch": branch, "force": true }),
                ErrorCode::Denied,
                "force push 到保护分支",
            )),
        };
    }
    let mut args = vec!["push".to_string()];
    if force {
        args.push("--force-with-lease".to_string()); // 即便允许 force，也用 lease 而非裸 --force
    }
    args.push(remote);
    if !branch.is_empty() {
        args.push(branch);
    }
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    run_git_tool(call, &refs).await
}

/// 跑一条 git 子命令（带超时；cwd 可选）
async fn run_git_tool(call: &ToolCall, args: &[&str]) -> ToolResult {
    let started = std::time::Instant::now();
    let cwd = call
        .arguments
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args);
    if let Some(d) = &cwd {
        cmd.current_dir(d);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let child = cmd.spawn();
    let mut child = match child {
        Ok(c) => c,
        Err(e) => {
            return ToolResult {
                ok: false,
                output: format!("git 起不来（本机装了 git 吗）: {e}"),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Internal, "git 启动失败")),
            };
        }
    };
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let timeout = std::time::Duration::from_millis(GIT_TIMEOUT_MS);
    let end = tokio::time::timeout(timeout, child.wait()).await;

    let mut out = String::new();
    let mut err = String::new();
    if let Some(mut s) = stdout.take() {
        use tokio::io::AsyncReadExt;
        let _ = s.read_to_string(&mut out).await;
    }
    if let Some(mut s) = stderr.take() {
        use tokio::io::AsyncReadExt;
        let _ = s.read_to_string(&mut err).await;
    }

    let (ok, code) = match end {
        Ok(Ok(status)) => (status.success(), status.code()),
        Ok(Err(e)) => {
            return ToolResult {
                ok: false,
                output: format!("git 执行出错: {e}"),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "args": args, "io_error": e.to_string() }),
                    ErrorCode::Internal,
                    "git 执行出错",
                )),
            };
        }
        Err(_) => {
            // 超时 ⇒ kill
            let _ = child.kill().await;
            return ToolResult {
                ok: false,
                output: format!("git {GIT_TIMEOUT_MS}ms 超时（已 kill）"),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(with_error(
                    serde_json::json!({ "args": args }),
                    ErrorCode::Timeout,
                    "git 超时",
                )),
            };
        }
    };

    let body = if out.trim().is_empty() { err.trim().to_string() } else { out.trim().to_string() };
    ToolResult {
        ok,
        output: if body.is_empty() {
            format!("git {} ✓（无输出）", args.join(" "))
        } else {
            format!("$ git {}\n{}", args.join(" "), body)
        },
        elapsed_ms: started.elapsed().as_millis() as u64,
        verified: Some(ok),
        evidence: Some(if ok {
            serde_json::json!({ "args": args, "exit": code })
        } else {
            with_error(
                serde_json::json!({ "args": args, "exit": code }),
                ErrorCode::CommandFailed,
                "git 非零退出",
            )
        }),
    }
}

fn def(name: &str, desc: &str, params: serde_json::Value, effect: EffectKind) -> ToolDef {
    ToolDef {
        name: name.into(),
        description: desc.into(),
        parameters: params,
        effect,
        default_allowed: matches!(effect, EffectKind::Read),
    }
}

fn cwd_param() -> serde_json::Value {
    serde_json::json!({
        "path": { "type": "string", "description": "仓库路径（可选，默认当前目录）" }
    })
}

pub fn git_tool_defs() -> Vec<ToolDef> {
    vec![
        def("git_status", "查看工作区改动（只读，--short）。", serde_json::json!({
            "type": "object", "properties": cwd_param(), "additionalProperties": false
        }), EffectKind::Read),
        def("git_diff", "查看未暂存的差异（只读）。", serde_json::json!({
            "type": "object", "properties": cwd_param(), "additionalProperties": false
        }), EffectKind::Read),
        def("git_log", "查看提交历史（只读，--oneline）。", serde_json::json!({
            "type": "object",
            "properties": {
                "limit": { "type": "integer", "description": "条数（可选，默认 10，上限 100）" },
                "path": { "type": "string", "description": "仓库路径（可选）" }
            },
            "additionalProperties": false
        }), EffectKind::Read),
        def("git_show", "查看最近一次提交的改动统计（只读）。", serde_json::json!({
            "type": "object", "properties": cwd_param(), "additionalProperties": false
        }), EffectKind::Read),
        def("git_branch", "列出分支（只读）。", serde_json::json!({
            "type": "object", "properties": cwd_param(), "additionalProperties": false
        }), EffectKind::Read),
        def("git_add", "暂存改动（本地写）。", serde_json::json!({
            "type": "object",
            "properties": {
                "files": { "type": "string", "description": "要暂存的路径（可选，默认 `.`）" },
                "path": { "type": "string", "description": "仓库路径（可选）" }
            },
            "additionalProperties": false
        }), EffectKind::Write),
        def("git_commit", "提交（本地写，需 message）。", serde_json::json!({
            "type": "object",
            "properties": {
                "message": { "type": "string", "description": "提交说明（必填）" },
                "path": { "type": "string", "description": "仓库路径（可选）" }
            },
            "required": ["message"],
            "additionalProperties": false
        }), EffectKind::Write),
        def("git_push", "推送到远端（**不可逆外部副作用**，需显式授权；force push main/master 永远拒）。", serde_json::json!({
            "type": "object",
            "properties": {
                "remote": { "type": "string", "description": "远端名（可选，默认 origin）" },
                "branch": { "type": "string", "description": "分支（可选）" },
                "force": { "type": "boolean", "description": "是否强推（可选，默认 false；保护分支永远拒）" },
                "path": { "type": "string", "description": "仓库路径（可选）" }
            },
            "additionalProperties": false
        }), EffectKind::Write),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args }
    }

    /// 真仓库（临时 git init）—— 不依赖 bolloon 自身仓库状态
    fn tmp_repo(tag: &str) -> Option<std::path::PathBuf> {
        let d = std::env::temp_dir().join(format!("bolloon_git_{}_{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).ok()?;
        let ok = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&d)
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
        // 提交一次，保证 log/show 有内容
        std::fs::write(d.join("f.txt"), "hi").ok()?;
        std::process::Command::new("git").args(["add", "."]).current_dir(&d).status().ok()?;
        std::process::Command::new("git")
            .args(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"])
            .current_dir(&d)
            .status()
            .ok()?;
        Some(d)
    }

    #[tokio::test]
    async fn status_works_on_real_repo() {
        let Some(d) = tmp_repo("status") else { return }; // 无 git 环境则跳过
        std::fs::write(d.join("new.txt"), "x").unwrap();
        let r = GitExecutor
            .execute(call("git_status", serde_json::json!({ "path": d.display().to_string() })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("new.txt"), "未跟踪文件应出现: {}", r.output);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn log_and_show_return_history() {
        let Some(d) = tmp_repo("log") else { return };
        let r = GitExecutor
            .execute(call("git_log", serde_json::json!({ "path": d.display().to_string(), "limit": 5 })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("init"), "提交说明应在: {}", r.output);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// **纪律**: force push 到 main/master 永远拒（且不真正执行）
    #[tokio::test]
    async fn force_push_to_protected_branch_is_refused() {
        let r = GitExecutor
            .execute(call("git_push", serde_json::json!({ "branch": "main", "force": true })))
            .await;
        assert!(!r.ok, "必须拒绝");
        assert!(r.output.contains("拒绝"), "{}", r.output);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "denied");
        assert!(r.evidence.as_ref().unwrap()["error"]["retryable"] == false);
    }

    #[tokio::test]
    async fn commit_requires_message() {
        let r = GitExecutor.execute(call("git_commit", serde_json::json!({}))).await;
        assert!(!r.ok);
        assert!(r.output.contains("message 必填"), "{}", r.output);
    }

    /// 分级: 只读默认允许；add/commit/push 都不默认允许
    #[test]
    fn git_tools_are_graded_by_effect() {
        for d in git_tool_defs() {
            match d.name.as_str() {
                "git_status" | "git_diff" | "git_log" | "git_show" | "git_branch" => {
                    assert_eq!(d.effect, EffectKind::Read);
                    assert!(d.default_allowed, "{} 只读应默认允许", d.name);
                }
                other => {
                    assert_eq!(d.effect, EffectKind::Write, "{other}");
                    assert!(!d.default_allowed, "{other} 不该默认允许");
                }
            }
        }
    }
}
