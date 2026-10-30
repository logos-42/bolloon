//! Git 组件 — porcelain 解析器 + 纪律守卫 (真执行由 GitExecutor 注入)
//!
//! 对齐 TS 侧 agent 用 git 的纪律 (与 CodeBuddy git-safety 同源):
//! - status/diff/log 的 porcelain 输出解析 (纯函数, 可测)
//! - 纪律守卫: **force-push main/master 拒** · `--no-verify` 拒 (除非显式声明) ·
//!   `reset --hard` / 强推需显式确认 · commit 风格校验 (`feat(scope): 中文一句话`)
//! - 不改 git config
//! - 危险命令先过 harness security denylist

use serde::{Deserialize, Serialize};

/// git 命令错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum GitGuardError {
    #[error("禁止 force-push {0}: 会覆盖远端历史 (除非用户明确要求, 且 main/master 永远拒)")]
    ForcePushProtected(String),
    #[error("--no-verify 跳过钩子需要用户显式要求")]
    NoVerifySkipsHooks,
    #[error("reset --hard / checkout -- . 属破坏性操作, 需用户明确要求")]
    DestructiveNeedsExplicit,
    #[error("禁止修改 git config")]
    NoConfigChange,
    #[error("命令命中 denylist: {0}")]
    Denied(String),
}

/// git 纪律守卫 (纯函数; 只管 git 子命令, 不替换 shell-guard)
pub fn guard_git_command(args: &[String], user_explicitly_demanded: bool) -> Result<(), GitGuardError> {
    let joined = args.join(" ");
    let lower = joined.to_lowercase();
    // git config 不改
    if args.first().map(|s| s.as_str()) == Some("config") {
        return Err(GitGuardError::NoConfigChange);
    }
    // force push
    let has_force = args.iter().any(|a| a == "--force" || a == "-f");
    let is_push = args.first().map(|s| s.as_str()) == Some("push");
    if is_push && has_force {
        // 任一非 flag 参数指向 main/master 即受保护
        let refspecs: Vec<String> = args
            .iter()
            .skip(1)
            .filter(|a| !a.starts_with('-'))
            .map(|s| s.to_lowercase())
            .collect();
        let protected = refspecs.iter().any(|r| r.contains("main") || r.contains("master"));
        if protected || !user_explicitly_demanded {
            return Err(GitGuardError::ForcePushProtected(
                if protected { refspecs.join(" ") } else { "分支".into() },
            ));
        }
    }
    // --no-verify
    if args.iter().any(|a| a == "--no-verify" || a == "-n") && !user_explicitly_demanded {
        return Err(GitGuardError::NoVerifySkipsHooks);
    }
    // 破坏性
    let is_reset = args.first().map(|s| s.as_str()) == Some("reset");
    if is_reset && args.contains(&"--hard".to_string()) && !user_explicitly_demanded {
        return Err(GitGuardError::DestructiveNeedsExplicit);
    }
    if args.first().map(|s| s.as_str()) == Some("checkout")
        && (args.contains(&"--.".to_string()) || (args.contains(&"--".to_string()) && args.contains(&".".to_string())))
        && !user_explicitly_demanded
    {
        return Err(GitGuardError::DestructiveNeedsExplicit);
    }
    // 危险字样 (与 shell-guard 同款 denylist 交叉)
    for rule in ["rm -rf /", "sudo ", "curl .. | sh"] {
        if lower.contains(rule) {
            return Err(GitGuardError::Denied(rule.into()));
        }
    }
    Ok(())
}

/// porcelain v1 status 解析 (git status --porcelain)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusEntry {
    /// X (staged 状态字符)
    pub x: char,
    /// Y (worktree 状态字符)
    pub y: char,
    pub path: String,
}

pub fn parse_status_porcelain(out: &str) -> Vec<StatusEntry> {
    out.lines()
        .filter(|l| l.len() >= 3)
        .map(|l| StatusEntry {
            x: l.chars().next().unwrap_or('?'),
            y: l.chars().nth(1).unwrap_or(' '),
            path: l[3..].trim().trim_matches('"').to_string(),
        })
        .collect()
}

/// log --oneline 解析
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CommitLine {
    pub hash: String,
    pub subject: String,
}

pub fn parse_log_oneline(out: &str) -> Vec<CommitLine> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.splitn(2, ' ');
            let hash = it.next()?;
            let subject = it.next()?.to_string();
            Some(CommitLine { hash: hash.into(), subject })
        })
        .collect()
}

/// commit message 风格校验 (本仓约定: `feat(scope): 中文一句话`)
pub fn validate_commit_subject(subject: &str) -> Result<(), String> {
    let re_prefixes = ["feat", "fix", "refactor", "docs", "test", "chore", "style", "perf"];
    let Some((prefix, rest)) = subject.split_once('(') else {
        return Err(format!("缺 type(scope) 前缀: {subject}"));
    };
    if !re_prefixes.contains(&prefix) {
        return Err(format!("type 不在约定集: {prefix}"));
    }
    let Some((scope, desc)) = rest.split_once("): ") else {
        return Err(format!("缺 scope 或 \"): \" 分隔: {subject}"));
    };
    if scope.is_empty() {
        return Err("scope 不能为空".into());
    }
    if desc.is_ascii() {
        return Err("描述应为中文一句话".into());
    }
    Ok(())
}

/// diff --stat 末行解析 (files changed, insertions, deletions)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DiffStat {
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

pub fn parse_diff_stat_summary(out: &str) -> Option<DiffStat> {
    let last = out.lines().rev().find(|l| l.contains("changed"))?;
    // 格式: " 2 files changed, 10 insertions(+), 3 deletions(-)" — 数字都在词前
    let files = extract_num_before(last, "file")?;
    let insertions = extract_num_before(last, "insertion").or(Some(0));
    let deletions = extract_num_before(last, "deletion").or(Some(0));
    Some(DiffStat {
        files_changed: files,
        insertions: insertions.unwrap_or(0),
        deletions: deletions.unwrap_or(0),
    })
}

fn extract_num_before(line: &str, word: &str) -> Option<usize> {
    let idx = line.find(word)?;
    let before = line[..idx].trim_end();
    let num: String = before.chars().rev().take_while(|c| c.is_ascii_digit()).collect::<String>().chars().rev().collect();
    num.parse().ok()
}

fn extract_num_after_word(line: &str, word: &str) -> Option<usize> {
    let idx = line.find(word)?;
    let after = &line[idx + word.len()..];
    let num: String = after.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit()).collect();
    num.parse().ok()
}

/// 分支行 [ahead N, behind M] 解析 (数字在词**后**, 与 diff --stat 相反)
///
/// 形状: `## main...origin/main [ahead 2, behind 1]`
/// 推之前先知道自己领先/落后几条 —— 没对账就不许强推 (见 guard_git_command)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AheadBehind {
    pub ahead: usize,
    pub behind: usize,
}

pub fn parse_ahead_behind(branch_line: &str) -> AheadBehind {
    AheadBehind {
        ahead: extract_num_after_word(branch_line, "ahead").unwrap_or(0),
        behind: extract_num_after_word(branch_line, "behind").unwrap_or(0),
    }
}

/// Git 执行端口 (真 spawn 由调用方注入; 测试用内存实现)
pub trait GitExecutor {
    fn run(&self, args: &[String]) -> Result<String, String>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_porcelain_parsed() {
        let out = " M src/main.rs\n?? new-file.rs\nA  added.rs\nD  gone.rs\n";
        let entries = parse_status_porcelain(out);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0], StatusEntry { x: ' ', y: 'M', path: "src/main.rs".into() });
        assert_eq!(entries[1], StatusEntry { x: '?', y: '?', path: "new-file.rs".into() });
        assert_eq!(entries[3], StatusEntry { x: 'D', y: ' ', path: "gone.rs".into() });
    }

    #[test]
    fn ahead_behind_parsed_from_branch_line() {
        assert_eq!(
            parse_ahead_behind("## main...origin/main [ahead 2, behind 1]"),
            AheadBehind { ahead: 2, behind: 1 }
        );
        assert_eq!(
            parse_ahead_behind("## feat/x...origin/feat/x [ahead 5]"),
            AheadBehind { ahead: 5, behind: 0 },
            "只领先不落后"
        );
        assert_eq!(
            parse_ahead_behind("## main...origin/main"),
            AheadBehind { ahead: 0, behind: 0 },
            "无 ahead/behind 段 = 与上游同步"
        );
    }

    #[test]
    fn log_oneline_parsed() {
        let out = "d62d565 feat(rust): 双内核\nfe8093e feat(web): 0.6.10\n";
        let lines = parse_log_oneline(out);
        assert_eq!(lines[0].hash, "d62d565");
        assert_eq!(lines[0].subject, "feat(rust): 双内核");
    }

    #[test]
    fn commit_style_validated() {
        assert!(validate_commit_subject("feat(rust): 双内核 kernel/harness").is_ok());
        assert!(validate_commit_subject("fix(web): 修群聊邀请反馈 (v0.2.X)").is_ok());
        assert!(validate_commit_subject("random message").is_err(), "缺 type(scope)");
        assert!(validate_commit_subject("hack(web): 改了").is_err(), "type 不在约定集");
        assert!(validate_commit_subject("feat(): 空 scope").is_err());
        assert!(validate_commit_subject("feat(web): english only").is_err(), "描述应中文");
    }

    #[test]
    fn force_push_main_always_denied() {
        let args: Vec<String> = "push --force origin main".split(' ').map(String::from).collect();
        // 即使"用户明确要求", main 也拒
        assert!(matches!(
            guard_git_command(&args, true),
            Err(GitGuardError::ForcePushProtected(t)) if t.contains("main")
        ));
        let args2: Vec<String> = "push -f origin feature-x".split(' ').map(String::from).collect();
        assert!(matches!(
            guard_git_command(&args2, false),
            Err(GitGuardError::ForcePushProtected(_))
        ));
        // 用户明确要求 + 非 main → 放行
        assert!(guard_git_command(&args2, true).is_ok());
    }

    #[test]
    fn no_verify_denied_unless_explicit() {
        let args: Vec<String> = "commit -m x --no-verify".split(' ').map(String::from).collect();
        assert!(matches!(
            guard_git_command(&args, false),
            Err(GitGuardError::NoVerifySkipsHooks)
        ));
        assert!(guard_git_command(&args, true).is_ok(), "用户显式要求 → 放行");
    }

    #[test]
    fn hard_reset_needs_explicit() {
        let args: Vec<String> = "reset --hard HEAD~1".split(' ').map(String::from).collect();
        assert!(matches!(
            guard_git_command(&args, false),
            Err(GitGuardError::DestructiveNeedsExplicit)
        ));
        let checkout: Vec<String> = "checkout -- .".split(' ').map(String::from).collect();
        assert!(guard_git_command(&checkout, false).is_err());
    }

    #[test]
    fn config_change_denied() {
        let args: Vec<String> = "config user.email x@y".split(' ').map(String::from).collect();
        assert!(matches!(guard_git_command(&args, true), Err(GitGuardError::NoConfigChange)));
    }

    #[test]
    fn safe_git_commands_pass() {
        assert!(guard_git_command(&["status".to_string()], false).is_ok());
        assert!(guard_git_command(&["log".into(), "--oneline".into(), "-10".into()], false).is_ok());
        assert!(guard_git_command(&["diff".into(), "--stat".into()], false).is_ok());
        assert!(guard_git_command(&["commit".into(), "-m".into(), "feat(x): 信息".into()], false).is_ok());
    }

    #[test]
    fn diff_stat_summary_parsed() {
        let out = " a.rs | 2 ++\n b.rs | 10 +++++++---\n 2 files changed, 10 insertions(+), 3 deletions(-)\n";
        let s = parse_diff_stat_summary(out).unwrap();
        assert_eq!(s.files_changed, 2);
        assert_eq!(s.insertions, 10);
        assert_eq!(s.deletions, 3);
    }
}
