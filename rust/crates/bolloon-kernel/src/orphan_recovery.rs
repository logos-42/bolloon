//! 孤儿接管恢复动作 — 对齐 TS 侧 `run-store.reconcileOrphans` + `prepareResume` 语义。
//!
//! 职责 (纯机制 + 事实层, 不判业务):
//! - `reconcile_orphans`: 扫描 runs 目录, 把 **pid 已死** 的 `running` 记录改判 `interrupted`
//!   (不做这层, 重载/崩溃后 UI/CLI 会显示"还在跑"的幽灵运行 —— 最典型的假状态)。
//! - `prepare_resume`: 校验状态可恢复 → 落 `recovering` + 追加 recovery 留痕 → 生成恢复计划。
//! - `OrphanRecovery` 实现 `ha::RecoveryAction`: `recover()` = 对账孤儿 + 准备恢复 (真正"接管");
//!   `escalate()` = 连续失败后升级 (记日志, 本机无人工通道就诚实留痕)。
//!
//! 数据口径对齐 TS: `$BOLLOON_HOME/runs/<runId>.json` (缺省 `~/.bolloon/runs`)。
//! 读写**整份 JSON** (只改 status/pid/host/updatedAt/recovery 等键, 其余字段原样保留),
//! 因此与 TS 侧共读同一目录时互不破坏对方的字段。
//!
//! 接线: `spawn_kernel_ha_from_env(Arc::new(OrphanRecovery::new(orphan_recovery::runs_dir())))`
//! (cli / web / tauri 已在三处入口替换 NoopRecovery)。

use std::path::{Path, PathBuf};

use crate::ha::RecoveryAction;

/// 可恢复状态 (对齐 TS `RESUMABLE_STATUSES` 的子集, 与 Rust run 状态机对应的部分)。
const RESUMABLE: &[&str] = &[
    "recovering", "interrupted", "stalled", "paused", "needs_human", "awaiting_external",
];

/// 孤儿对账结果 (对齐 TS `reconcileOrphans` 的返回)。
#[derive(Debug, Default, Clone)]
pub struct OrphanReport {
    /// 改判为 interrupted 的 runId
    pub interrupted: Vec<String>,
    /// pid 仍存活, 保持 running (不是孤儿)
    pub still_running: Vec<String>,
    /// 读写失败未能处理的 runId (诚实留痕, 不假装都成功)
    pub failed: Vec<String>,
}

/// 恢复计划 (对齐 TS `ResumePlan` 的最小事实集)。
#[derive(Debug, Clone)]
pub struct ResumePlan {
    pub run_id: String,
    pub completed_steps: usize,
    pub next_action: String,
    pub replay_guards: usize,
}

/// runs 目录: `$BOLLOON_HOME/runs`, 缺省 `~/.bolloon/runs` (对齐 TS `bolloonHome()` + `runsDir()`)。
pub fn runs_dir() -> PathBuf {
    if let Ok(p) = std::env::var("BOLLOON_HOME") {
        if !p.trim().is_empty() {
            return PathBuf::from(p).join("runs");
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    PathBuf::from(home).join(".bolloon").join("runs")
}

/// pid 是否存活 (对齐 TS `pidAlive`: 0/缺失 = 死; 自身 pid = 活; kill(pid,0) 成功或 EPERM = 活)。
fn pid_alive(pid: u64) -> bool {
    if pid == 0 {
        return false;
    }
    if pid == std::process::id() as u64 {
        return true;
    }
    if pid > i32::MAX as u64 {
        return false; // 不是合法 pid (负 pid 会对进程组发信号, 必须防)
    }
    let r = unsafe { libc::kill(pid as i32, 0) };
    if r == 0 {
        return true;
    }
    // EPERM = 进程存在但无权探它 (别人的进程) → 也算活着
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn run_id_of(v: &serde_json::Value) -> String {
    v["runId"].as_str().unwrap_or("<no-runId>").to_string()
}

/// 原子写: tmp + rename (对齐 FileHeartbeatStore 与 TS 侧 tmp 写盘姿势)。
async fn atomic_write(path: &Path, v: &serde_json::Value) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    tokio::fs::write(&tmp, serde_json::to_vec(v).unwrap_or_default()).await?;
    tokio::fs::rename(&tmp, path).await
}

/// 孤儿对账: 扫描 runs 目录, pid 已死的 `running` 记录改判 `interrupted` (写回, 不丢其它字段)。
/// 单条失败不影响其它记录 (对账不能因为一条坏记录而整体放弃)。
pub async fn reconcile_orphans(dir: &Path) -> OrphanReport {
    let mut report = OrphanReport::default();
    let entries = match tokio::fs::read_dir(dir).await {
        Ok(rd) => rd,
        Err(_) => return report, // 目录不存在 = 没有孤儿; 不报警
    };
    let mut rd = entries;
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") || name.starts_with('_') {
            continue; // 跳过 _degradations.jsonl / .bak / .tmp 等非 run 文件
        }
        let path = e.path();
        let raw = match tokio::fs::read_to_string(&path).await {
            Ok(s) => s,
            Err(_) => {
                report.failed.push(name.clone());
                continue;
            }
        };
        let mut v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(x) => x,
            Err(_) => {
                report.failed.push(name.clone());
                continue; // 损坏记录不动它 (只留痕), 不擅自重写
            }
        };
        if v["status"].as_str() != Some("running") {
            continue; // 只对账 running
        }
        let run_id = run_id_of(&v);
        let pid = v["pid"].as_u64().unwrap_or(0);
        if pid_alive(pid) {
            report.still_running.push(run_id);
            continue;
        }
        v["status"] = serde_json::Value::String("interrupted".into());
        v["error"] = serde_json::Value::String(format!(
            "进程 {pid} 已不在 (崩溃/重载); 孤儿对账将其改判 interrupted"
        ));
        v["updatedAt"] = serde_json::Value::String(now_iso());
        match atomic_write(&path, &v).await {
            Ok(_) => report.interrupted.push(run_id),
            Err(_) => report.failed.push(run_id),
        }
    }
    report
}

/// 准备恢复 (对齐 TS `prepareResume` 语义): 校验可恢复 → 生成计划 → 落 `recovering` + 记 recovery。
/// 不执行任何工具; 恢复计划的消费留给宿主 (agent 用 next_action 继续同一 runId)。
pub async fn prepare_resume(dir: &Path, run_id: &str) -> anyhow::Result<Option<ResumePlan>> {
    let path = dir.join(format!("{run_id}.json"));
    let raw = tokio::fs::read_to_string(&path).await?;
    let mut v: serde_json::Value = serde_json::from_str(&raw)?;

    let cur_status = v["status"].as_str().unwrap_or("").to_string();
    if !RESUMABLE.contains(&cur_status.as_str()) {
        return Ok(None); // 不可恢复的状态 (finished/failed/running...): 不从这里"复活"
    }

    // ── 恢复计划 (对齐 TS buildPlanFromRecord 的最小事实集) ──
    let steps = v["steps"].as_array().cloned().unwrap_or_default();
    let completed = steps
        .iter()
        .filter(|s| s["ok"].as_bool().unwrap_or(false))
        .count();
    let replay_guards = steps
        .iter()
        .filter(|s| {
            s["ok"].as_bool().unwrap_or(false)
                && s["tool"].as_str().map(|t| !is_idempotent(t)).unwrap_or(false)
        })
        .count();
    // nextAction: checkpoint.nextAction 能给指路就用, 否则默认"继续未完成的目标"
    let checkpoint_next: Option<String> = v["checkpoint"]["nextAction"]
        .as_str()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty() && !s.contains("由这一步的结果决定"));
    let last_failed: Option<String> = steps
        .iter()
        .rev()
        .find(|s| s["ok"].as_bool() == Some(false))
        .map(|s| {
            s["tool"].as_str().unwrap_or("?").to_string()
                + ": "
                + s["error"].as_str().unwrap_or("未知错误")
        });
    let next_action = checkpoint_next.unwrap_or_else(|| {
        last_failed
            .map(|f| format!("先处理上一步失败 ({f}) 再继续目标"))
            .unwrap_or_else(|| "继续未完成的目标 (不要重复已成功的动作)".into())
    });

    // ── 落 recovering + 抢归属 (pid/host 归当前进程) + 记 recovery 留痕 ──
    v["status"] = serde_json::Value::String("recovering".into());
    v["pid"] = serde_json::Value::Number(serde_json::Number::from(std::process::id()));
    let host = std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".into());
    v["host"] = serde_json::Value::String(host);
    v["updatedAt"] = serde_json::Value::String(now_iso());
    let mut recovery = v["recovery"].as_array().cloned().unwrap_or_default();
    recovery.push(serde_json::json!({
        "ts": now_iso(),
        "errorClass": "crash",
        "message": format!("从 checkpoint 恢复 (已完成 {completed} 步, 非幂等守卫 {replay_guards} 条)"),
        "action": "resume",
        "attempt": recovery.len() as u64 + 1,
        "checkpointBefore": steps.len(),
        "changedPlan": steps.len() > 0,
    }));
    v["recovery"] = serde_json::Value::Array(recovery);

    atomic_write(&path, &v).await?;

    Ok(Some(ResumePlan {
        run_id: run_id.to_string(),
        completed_steps: completed,
        next_action,
        replay_guards,
    }))
}

/// 只读/幂等工具白名单 (对齐 TS `IDEMPOTENT_TOOLS` 的 Rust 子集; 不在列一律按非幂等保守处理)。
fn is_idempotent(tool: &str) -> bool {
    matches!(
        tool,
        "read_file"
            | "read_document"
            | "list_files"
            | "glob_files"
            | "grep_files"
            | "find_files"
            | "git_status"
            | "git_log"
            | "git_diff"
            | "git_branch"
            | "git_show"
            | "list_runs"
            | "list_goals"
            | "list_skills"
            | "ipfs_cat"
            | "ipfs_ls"
            | "ipns_resolve"
            | "list_peers"
            | "list_pending_friend_requests"
            | "get_tool_list"
    )
}

/// 真孤儿接管恢复动作: `recover()` = 对账孤儿 + 对可恢复的记录准备恢复。
/// 作为 `RecoveryAction` 注入 `DualGuard`, 取代 `NoopRecovery` (P4: 接管必须写事实)。
#[derive(Debug)]
pub struct OrphanRecovery {
    dir: PathBuf,
}

impl OrphanRecovery {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn runs_dir(&self) -> &Path {
        &self.dir
    }
}

#[async_trait::async_trait]
impl RecoveryAction for OrphanRecovery {
    async fn recover(&self) -> bool {
        let report = reconcile_orphans(&self.dir).await;
        if !report.failed.is_empty() {
            tracing::warn!(
                dir = %self.dir.display(),
                failed = report.failed.len(),
                "孤儿对账部分失败 (保持诚实, 不把 failed 当成功)"
            );
        }
        // 对改判出的孤儿逐个准备恢复 (尽力而为; 失败只留痕不阻塞其余)
        for run_id in &report.interrupted {
            match prepare_resume(&self.dir, run_id).await {
                Ok(Some(plan)) => {
                    tracing::info!(
                        run = %plan.run_id,
                        completed = plan.completed_steps,
                        "孤儿接管: 准备恢复"
                    );
                }
                Ok(None) => {
                    tracing::info!(run = %run_id, "孤儿已改判 interrupted (不可恢复, 不强行复活)");
                }
                Err(e) => {
                    tracing::warn!(run = %run_id, error = %e, "准备恢复失败 (只留痕, 不冒充成功)");
                }
            }
        }
        // 接管成功 = 至少有一条 running 被判 interrupted (真正"接管"了孤儿)
        !report.interrupted.is_empty()
    }

    async fn escalate(&self) {
        // 连续失败升级: 本机无人工通知通道, 诚实记 error 日志 (对齐 TS recordDegradation 姿态)
        tracing::error!(
            dir = %self.dir.display(),
            "孤儿接管连续失败, 升级: 请检查 runs 目录权限/损坏记录 (人工介入)"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ha::RecoveryAction; // 调用 recover() 需要 trait 在作用域内

    async fn test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bolloon-orphan-{tag}-{}", std::process::id()));
        let _ = tokio::fs::remove_dir_all(&dir).await;
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    fn write_run(dir: &Path, run_id: &str, status: &str, pid: u64) -> PathBuf {
        let path = dir.join(format!("{run_id}.json"));
        let v = serde_json::json!({
            "runId": run_id,
            "status": status,
            "pid": pid,
            "host": "test-host",
            "goal": "测试目标",
            "surface": "cli",
            "steps": [],
            "checkpoint": null,
            "meta": { "keep": "this-field-must-survive" },
        });
        std::fs::write(&path, serde_json::to_vec(&v).unwrap()).unwrap();
        path
    }

    #[tokio::test]
    async fn dead_pid_running_becomes_interrupted_and_keeps_fields() {
        let dir = test_dir("dead").await;
        let path = write_run(&dir, "r1", "running", 999_999_999); // 不存在的 pid
        let report = reconcile_orphans(&dir).await;
        assert_eq!(report.interrupted, vec!["r1".to_string()]);
        assert!(report.still_running.is_empty());

        let after: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(&path).await.unwrap()).unwrap();
        assert_eq!(after["status"], "interrupted");
        assert_eq!(after["meta"]["keep"], "this-field-must-survive"); // 其它字段原样保留
        assert!(after["error"].as_str().unwrap().contains("999999999"));
    }

    #[tokio::test]
    async fn alive_pid_keeps_running() {
        let dir = test_dir("alive").await;
        write_run(&dir, "r2", "running", std::process::id() as u64);
        let report = reconcile_orphans(&dir).await;
        assert!(report.interrupted.is_empty());
        assert_eq!(report.still_running, vec!["r2".to_string()]);
    }

    #[tokio::test]
    async fn non_running_records_untouched() {
        let dir = test_dir("nonrun").await;
        write_run(&dir, "r3", "finished", 999_999_999);
        write_run(&dir, "r4", "failed", 99);
        let report = reconcile_orphans(&dir).await;
        assert!(report.interrupted.is_empty());
        assert!(report.still_running.is_empty());
    }

    #[tokio::test]
    async fn prepare_resume_marks_recovering_with_plan() {
        let dir = test_dir("resume").await;
        write_run(&dir, "r5", "interrupted", 999_999_999);
        let plan = prepare_resume(&dir, "r5").await.unwrap().expect("应生成计划");
        assert_eq!(plan.run_id, "r5");
        assert!(plan.next_action.contains("继续未完成的目标"));

        let after: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join("r5.json")).await.unwrap())
                .unwrap();
        assert_eq!(after["status"], "recovering");
        assert_eq!(after["pid"], std::process::id());
        assert_eq!(after["recovery"].as_array().unwrap().len(), 1);
        assert_eq!(after["recovery"][0]["action"], "resume");
        assert_eq!(after["meta"]["keep"], "this-field-must-survive");
    }

    #[tokio::test]
    async fn prepare_resume_rejects_terminal_state() {
        let dir = test_dir("terminal").await;
        write_run(&dir, "r6", "finished", 0);
        let plan = prepare_resume(&dir, "r6").await.unwrap();
        assert!(plan.is_none(), "终态不许复活");
    }

    #[tokio::test]
    async fn recover_takes_over_orphan_and_reports() {
        let dir = test_dir("recover").await;
        write_run(&dir, "r7", "running", 999_999_999);
        let rec = OrphanRecovery::new(dir.clone());
        let ok = rec.recover().await;
        assert!(ok, "接管孤儿应返回 true");

        let after: serde_json::Value =
            serde_json::from_str(&tokio::fs::read_to_string(dir.join("r7.json")).await.unwrap())
                .unwrap();
        assert_eq!(after["status"], "recovering");
        assert_eq!(after["pid"], std::process::id());
    }

    #[tokio::test]
    async fn pid_alive_guards() {
        assert!(!pid_alive(0));
        assert!(pid_alive(std::process::id() as u64));
        assert!(!pid_alive(999_999_999));
        assert!(!pid_alive(u64::MAX)); // 超 i32 范围不算合法 pid
    }
}