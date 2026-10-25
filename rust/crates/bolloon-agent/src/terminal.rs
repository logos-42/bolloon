//! Terminal 组件 — 命令分类 + 超时 + 输出截断 (真执行由 TerminalExecutor 注入)
//!
//! 对齐 TS 侧 terminal-tool / shell-guard 组合语义:
//! - 命令三级分类: ReadOnly (可直接跑) / Mutating (要 Harness permission 门) / Dangerous (拒)
//! - **只读命令白名单判定是纯函数** — 分类错了宁可偏保守 (归 Mutating)
//! - 超时: elapsed > timeout = 失败进上下文 (不拖死循环)
//! - 输出截断: 保留头尾 (超长输出裁中间)
//! - 工作目录约束: 命令不许越出授权 root (cd / 拒)

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 命令分类
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandClass {
    /// 只读: ls/cat/grep/git status 等, 可直接执行
    ReadOnly,
    /// 变更: 写文件/装依赖/git commit 等, 走 Harness permission 门
    Mutating,
    /// 危险: denylist 命中, 直接拒
    Dangerous,
}

/// 只读命令首词 (白名单; 管道里出现任何非只读段 → 整条 Mutating)
const READONLY_FIRST_WORDS: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "which", "whoami",
    "pwd", "echo", "date", "file", "stat", "du", "df", "ps", "uname", "env",
    "git", "cargo", "node", "python3", "npx", "rustc",
];

/// 只读 git 子命令 (git 本身可变更, 只读子命令白名单)
const READONLY_GIT_SUBCOMMANDS: &[&str] = &[
    "status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame",
];

/// 分类 (纯函数; 管道/命令替换取最严分类)
pub fn classify_command(command: &str) -> CommandClass {
    let cmd = command.trim();
    // denylist 命中 = Dangerous (复用 harness shell-guard 判据)
    if bolloon_harness::guard_shell(cmd).is_err() {
        return CommandClass::Dangerous;
    }
    // cd 出工作目录 → Dangerous (越权)
    for seg in cmd.split("&&").chain(cmd.split(';')).chain(cmd.split('|')) {
        let s = seg.trim();
        if s.starts_with("cd ") && (s == "cd /" || s.starts_with("cd /etc") || s.starts_with("cd ~")) {
            return CommandClass::Dangerous;
        }
    }
    // 按管道/分段取最严
    let mut worst = CommandClass::ReadOnly;
    for seg in cmd.split('|').chain(cmd.split("&&")).chain(cmd.split(';')) {
        let seg = seg.trim();
        if seg.is_empty() {
            continue;
        }
        let class = classify_single(seg);
        if class == CommandClass::Dangerous {
            return CommandClass::Dangerous;
        }
        if class == CommandClass::Mutating {
            worst = CommandClass::Mutating;
        }
    }
    worst
}

fn classify_single(seg: &str) -> CommandClass {
    let mut words = seg.split_whitespace();
    let Some(first) = words.next() else { return CommandClass::Mutating };
    // 带路径的 (./script.sh, /bin/x) 一律 Mutating
    if first.contains('/') {
        return CommandClass::Mutating;
    }
    // 重定向 = 写盘 → Mutating
    if seg.contains('>') {
        return CommandClass::Mutating;
    }
    match first {
        "rm" | "mv" | "cp" | "mkdir" | "touch" | "chmod" | "chown" | "ln" | "kill"
        | "npm" | "pip" | "brew" | "apt" | "sudo" => CommandClass::Mutating,
        "git" => {
            let sub = words.next().unwrap_or("");
            if READONLY_GIT_SUBCOMMANDS.contains(&sub) {
                CommandClass::ReadOnly
            } else {
                CommandClass::Mutating
            }
        }
        w if READONLY_FIRST_WORDS.contains(&w) => CommandClass::ReadOnly,
        _ => CommandClass::Mutating, // 未知命令宁可保守
    }
}

/// 终端错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum TerminalError {
    #[error("命令分类为 Dangerous: {0}")]
    Dangerous(String),
    #[error("命令需 Harness permission 门批准: {0}")]
    NeedsPermission(String),
    #[error("超时 ({timeout_ms}ms): 进上下文让模型下轮修正")]
    TimedOut { timeout_ms: u64 },
}

/// 执行请求
#[derive(Debug, Clone)]
pub struct TerminalRequest {
    pub command: String,
    /// 授权工作目录 (命令不许越出)
    pub workdir: String,
    pub timeout_ms: u64,
}

/// 执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutput {
    pub exit_ok: bool,
    /// 截断后的输出 (保留头尾)
    pub output: String,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

/// 终端最大输出 (字符)
pub const TERMINAL_OUTPUT_MAX: usize = 8000;

/// 门禁: 分类 → 只读放行 / Mutating 需 permission / Dangerous 拒 (纯函数)
pub fn gate(command: &str, permission_granted: bool) -> Result<CommandClass, TerminalError> {
    match classify_command(command) {
        CommandClass::ReadOnly => Ok(CommandClass::ReadOnly),
        CommandClass::Mutating => {
            if permission_granted {
                Ok(CommandClass::Mutating)
            } else {
                Err(TerminalError::NeedsPermission(command.to_string()))
            }
        }
        CommandClass::Dangerous => Err(TerminalError::Dangerous(command.to_string())),
    }
}

/// 超时判定
pub fn timed_out(elapsed: Duration, timeout_ms: u64) -> bool {
    elapsed.as_millis() as u64 > timeout_ms
}

/// 输出截断 (保留头尾, 中间裁掉并注明)
pub fn truncate_output(output: &str, max: usize) -> (String, bool) {
    let chars: Vec<char> = output.chars().collect();
    if chars.len() <= max {
        return (output.to_string(), false);
    }
    let head = max / 2;
    let tail = max - head;
    let h: String = chars[..head].iter().collect();
    let t: String = chars[chars.len() - tail..].iter().collect();
    (
        format!("{h}\n[输出已截断: 共 {} 字符, 保留头尾]\n{t}", chars.len()),
        true,
    )
}

/// TerminalExecutor: 真 spawn 由调用方注入 (Rust 版不直接跑 shell)
#[async_trait::async_trait]
pub trait TerminalExecutor: Send + Sync {
    async fn run(&self, req: &TerminalRequest) -> Result<(bool, String, Duration), String>;
}

/// 高层入口: 门禁 → 执行 → 超时/截断 (编排, executor 注入)
pub async fn execute_terminal(
    exec: &dyn TerminalExecutor,
    req: &TerminalRequest,
    permission_granted: bool,
) -> Result<TerminalOutput, TerminalError> {
    gate(&req.command, permission_granted)?;
    let fut = exec.run(req);
    let started = std::time::Instant::now();
    let res = tokio::time::timeout(Duration::from_millis(req.timeout_ms), fut).await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match res {
        Err(_) => Err(TerminalError::TimedOut { timeout_ms: req.timeout_ms }),
        Ok(Err(e)) => Err(TerminalError::Dangerous(format!("执行失败: {e}"))),
        Ok(Ok((exit_ok, raw, _dur))) => {
            let (output, truncated) = truncate_output(&raw, TERMINAL_OUTPUT_MAX);
            Ok(TerminalOutput { exit_ok, output, truncated, elapsed_ms })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_commands_classified() {
        assert_eq!(classify_command("ls -la"), CommandClass::ReadOnly);
        assert_eq!(classify_command("cat a.rs"), CommandClass::ReadOnly);
        assert_eq!(classify_command("grep -rn todo src/"), CommandClass::ReadOnly);
        assert_eq!(classify_command("git status"), CommandClass::ReadOnly);
        assert_eq!(classify_command("git log --oneline -10"), CommandClass::ReadOnly);
        assert_eq!(classify_command("cargo test"), CommandClass::ReadOnly);
    }

    #[test]
    fn mutating_classified() {
        assert_eq!(classify_command("rm a.txt"), CommandClass::Mutating);
        assert_eq!(classify_command("git commit -m x"), CommandClass::Mutating, "commit 是变更");
        assert_eq!(classify_command("git push"), CommandClass::Mutating);
        assert_eq!(classify_command("npm install foo"), CommandClass::Mutating);
        assert_eq!(classify_command("echo hi > f.txt"), CommandClass::Mutating, "重定向写盘");
        assert_eq!(classify_command("./build.sh"), CommandClass::Mutating, "路径命令保守归 Mutating");
        assert_eq!(classify_command("terraform apply"), CommandClass::Mutating, "未知命令保守");
    }

    #[test]
    fn dangerous_classified() {
        assert_eq!(classify_command("rm -rf /"), CommandClass::Dangerous);
        assert_eq!(classify_command("sudo rm x"), CommandClass::Dangerous);
        assert_eq!(classify_command("cd /etc && cat shadow"), CommandClass::Dangerous, "越出工作目录");
        assert_eq!(classify_command("cd ~ && ls"), CommandClass::Dangerous);
    }

    #[test]
    fn pipeline_takes_worst_class() {
        assert_eq!(classify_command("cat a | grep x"), CommandClass::ReadOnly);
        assert_eq!(classify_command("cat a | grep x > out.txt"), CommandClass::Mutating, "管道里出现写盘");
        assert_eq!(
            classify_command("ls && rm -rf /"),
            CommandClass::Dangerous,
            "拼接里出现高危 → 整条 Dangerous"
        );
    }

    #[test]
    fn gate_enforces_permission() {
        assert!(gate("ls", false).is_ok(), "只读无需 permission");
        assert!(matches!(
            gate("rm a.txt", false),
            Err(TerminalError::NeedsPermission(_))
        ));
        assert!(gate("rm a.txt", true).is_ok());
        assert!(matches!(gate("rm -rf /", true), Err(TerminalError::Dangerous(_))), "高危即使有 permission 也拒");
    }

    #[test]
    fn output_truncated_keeps_head_tail() {
        let long = "x".repeat(20000);
        let (out, truncated) = truncate_output(&long, 1000);
        assert!(truncated);
        assert!(out.chars().count() <= 1100, "截断后近上限");
        assert!(out.contains("输出已截断"));
        assert!(out.starts_with("xxxx"));
        assert!(out.ends_with("xxxx"));
        // 短输出不动
        let (short, t2) = truncate_output("hello", 1000);
        assert_eq!(short, "hello");
        assert!(!t2);
    }

    #[test]
    fn timeout_detection() {
        assert!(timed_out(Duration::from_millis(121), 120));
        assert!(!timed_out(Duration::from_millis(100), 120));
    }

    struct FakeExec {
        delay_ms: u64,
        output: String,
    }

    #[async_trait::async_trait]
    impl TerminalExecutor for FakeExec {
        async fn run(&self, _req: &TerminalRequest) -> Result<(bool, String, Duration), String> {
            tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
            Ok((true, self.output.clone(), Duration::from_millis(self.delay_ms)))
        }
    }

    #[tokio::test]
    async fn execute_end_to_end() {
        let exec = FakeExec { delay_ms: 1, output: "hello world".into() };
        let req = TerminalRequest {
            command: "ls".into(),
            workdir: "/tmp".into(),
            timeout_ms: 5000,
        };
        let out = execute_terminal(&exec, &req, false).await.unwrap();
        assert!(out.exit_ok);
        assert_eq!(out.output, "hello world");
        assert!(!out.truncated);
    }

    #[tokio::test]
    async fn execute_timeout_reported() {
        let exec = FakeExec { delay_ms: 500, output: String::new() };
        let req = TerminalRequest {
            command: "ls".into(),
            workdir: "/tmp".into(),
            timeout_ms: 50,
        };
        assert!(matches!(
            execute_terminal(&exec, &req, false).await,
            Err(TerminalError::TimedOut { timeout_ms: 50 })
        ));
    }

    #[tokio::test]
    async fn execute_dangerous_rejected_before_spawn() {
        let exec = FakeExec { delay_ms: 0, output: String::new() };
        let req = TerminalRequest {
            command: "rm -rf /".into(),
            workdir: "/tmp".into(),
            timeout_ms: 5000,
        };
        // 不该真的执行 (FakeExec 会成功) — 门禁在 spawn 之前拒
        assert!(matches!(
            execute_terminal(&exec, &req, true).await,
            Err(TerminalError::Dangerous(_))
        ));
    }
}
