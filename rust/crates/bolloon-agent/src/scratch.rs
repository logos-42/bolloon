//! scratch 子系统: 内部 tmp 目录跑临时脚本 + 孤儿恢复 catch。
//!
//! 能力模型 (对应 §8: 能力 = Kernel Port + Adapter + Harness Gate + Run Evidence):
//! - `ScriptRunPort` (trait + Noop + Port 句柄, **未注入即拒**) —— 真执行器由宿主注入。
//! - `TokioScriptRunner` —— 默认真执行器 (tokio::process 派生子进程), 落盘运行记录。
//! - `ScratchRunRecord` —— 每个 run 落 `<scratch_dir>/<run_id>/run.json`, 含 status/pid/输出。
//! - `reconcile_scratch_runs` —— 孤儿 catch: 进程崩溃后未收尾的 run 标 `interrupted`。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command as TokioCommand;

static RUN_SEQ: AtomicU64 = AtomicU64::new(0);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 生成全局唯一 run_id (毫秒时间戳 + 进程内自增, 足够区分同进程内的并发 run)
pub fn new_run_id() -> String {
    let seq = RUN_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("run-{}-{:08x}", now_ms(), seq)
}

/// 执行请求: 跑 `code` (经 `lang` 解释器), 落盘到 `run_dir`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptRunRequest {
    pub run_id: String,
    pub lang: String,
    pub code: String,
    /// 该 run 专属目录 (通常 `BolloonHome::scratch_dir()/<run_id>`)
    pub run_dir: String,
    pub timeout_ms: u64,
}

/// 执行结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScriptRunResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u64,
    pub killed: bool,
}

#[derive(Debug, Error)]
pub enum ScriptRunError {
    #[error("script runner 未注入（宿主未提供执行器）")]
    NotInjected,
    #[error("spawn 失败: {0}")]
    Spawn(String),
    #[error("IO: {0}")]
    Io(String),
}

/// 真执行器接口 (宿主注入; 这里给一个默认 tokio::process 实现)
#[async_trait::async_trait]
pub trait ScriptRunner: Send + Sync {
    async fn run(&self, req: ScriptRunRequest) -> Result<ScriptRunResult, ScriptRunError>;
}

/// 未注入即拒: 宿主没装执行器时一律 NotInjected
pub struct NoopScriptRunner;

#[async_trait::async_trait]
impl ScriptRunner for NoopScriptRunner {
    async fn run(&self, _req: ScriptRunRequest) -> Result<ScriptRunResult, ScriptRunError> {
        Err(ScriptRunError::NotInjected)
    }
}

/// ScriptRunPort: 给调用方的句柄 (可注入/替换), 照搬 kernel `TransportPort` 范式
#[derive(Clone)]
pub struct ScriptRunPort {
    inner: Arc<dyn ScriptRunner>,
}

impl ScriptRunPort {
    pub fn new(r: Arc<dyn ScriptRunner>) -> Self {
        Self { inner: r }
    }
    pub fn noop() -> Self {
        Self::new(Arc::new(NoopScriptRunner))
    }
    pub fn inject(&mut self, r: Arc<dyn ScriptRunner>) {
        self.inner = r;
    }
    pub async fn run(&self, req: ScriptRunRequest) -> Result<ScriptRunResult, ScriptRunError> {
        self.inner.run(req).await
    }
}

impl Default for ScriptRunPort {
    fn default() -> Self {
        Self::noop()
    }
}

fn interpreter_for(lang: &str) -> &'static str {
    match lang {
        "sh" | "shell" => "sh",
        "bash" => "bash",
        "python3" | "python" => "python3",
        "node" | "js" => "node",
        _ => "sh",
    }
}

fn ext_for(lang: &str) -> &'static str {
    match lang {
        "sh" | "shell" => "sh",
        "bash" => "bash",
        "python3" | "python" => "py",
        "node" | "js" => "js",
        _ => "sh",
    }
}

/// 运行记录 (落盘 `<run_dir>/run.json`); status: running | done | interrupted | failed
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScratchRunRecord {
    pub run_id: String,
    pub lang: String,
    pub status: String,
    pub pid: i64,
    pub code: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub exit_code: Option<i32>,
    pub elapsed_ms: u64,
    pub stdout: String,
    pub stderr: String,
}

const MAX_OUTPUT: usize = 200_000;

fn write_record(run_dir: &Path, rec: &ScratchRunRecord) {
    let _ = std::fs::create_dir_all(run_dir);
    let p = run_dir.join("run.json");
    let tmp = run_dir.join("run.json.tmp");
    if let Ok(s) = serde_json::to_string_pretty(rec) {
        let _ = std::fs::write(&tmp, &s);
        let _ = std::fs::rename(&tmp, &p);
    }
}

/// pid 是否存活 (unix: `kill -0`; 其它平台保守返回 false)
async fn pid_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    #[cfg(unix)]
    {
        let out = TokioCommand::new("kill")
            .arg("-0")
            .arg(pid.to_string())
            .status()
            .await;
        matches!(out, Ok(s) if s.success())
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// 默认真执行器: 把 `code` 写到 `<run_dir>/script.<ext>`, 用 `lang` 解释器执行,
/// 全程落盘运行记录 (running+pid → done/interrupted/failed), 供孤儿恢复 catch。
pub struct TokioScriptRunner;

impl TokioScriptRunner {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TokioScriptRunner {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ScriptRunner for TokioScriptRunner {
    async fn run(&self, req: ScriptRunRequest) -> Result<ScriptRunResult, ScriptRunError> {
        let run_dir = PathBuf::from(&req.run_dir);
        std::fs::create_dir_all(&run_dir).map_err(|e| ScriptRunError::Io(e.to_string()))?;
        let code_path = run_dir.join(format!("script.{}", ext_for(&req.lang)));
        std::fs::write(&code_path, &req.code).map_err(|e| ScriptRunError::Io(e.to_string()))?;

        let mut cmd = TokioCommand::new(interpreter_for(&req.lang));
        cmd.arg(&code_path).current_dir(&run_dir);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let started = Instant::now();
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let rec = ScratchRunRecord {
                    run_id: req.run_id.clone(),
                    lang: req.lang.clone(),
                    status: "failed".into(),
                    pid: 0,
                    code: req.code.clone(),
                    created_at: now_ms(),
                    updated_at: now_ms(),
                    exit_code: None,
                    elapsed_ms: 0,
                    stdout: String::new(),
                    stderr: format!("spawn 失败: {e}"),
                };
                write_record(&run_dir, &rec);
                return Err(ScriptRunError::Spawn(e.to_string()));
            }
        };
        let pid = child.id().unwrap_or(0) as i64;

        // 记录 running (带 pid) —— 崩溃恢复靠这个 pid 判定
        write_record(
            &run_dir,
            &ScratchRunRecord {
                run_id: req.run_id.clone(),
                lang: req.lang.clone(),
                status: "running".into(),
                pid,
                code: req.code.clone(),
                created_at: now_ms(),
                updated_at: now_ms(),
                exit_code: None,
                elapsed_ms: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        );

        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let mut out = String::new();
        let mut err = String::new();

        let deadline = Duration::from_millis(req.timeout_ms.max(100));
        let mut killed = false;
        let mut exit: Option<i32> = None;
        loop {
            if started.elapsed() >= deadline {
                let _ = child.kill().await;
                killed = true;
                break;
            }
            if let Some(s) = stdout.as_mut() {
                let mut buf = [0u8; 4096];
                match s.read(&mut buf).await {
                    Ok(0) => stdout = None,
                    Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
                    Err(_) => stdout = None,
                }
            }
            if let Some(s) = stderr.as_mut() {
                let mut buf = [0u8; 4096];
                match s.read(&mut buf).await {
                    Ok(0) => stderr = None,
                    Ok(n) => err.push_str(&String::from_utf8_lossy(&buf[..n])),
                    Err(_) => stderr = None,
                }
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit = status.code();
                    break;
                }
                Ok(None) => tokio::time::sleep(Duration::from_millis(20)).await,
                Err(e) => {
                    err.push_str(&format!("wait 错误: {e}"));
                    break;
                }
            }
        }
        // 收尾读尽剩余输出
        if let Some(mut s) = stdout.take() {
            let mut b = String::new();
            let _ = s.read_to_string(&mut b).await;
            out.push_str(&b);
        }
        if let Some(mut s) = stderr.take() {
            let mut b = String::new();
            let _ = s.read_to_string(&mut b).await;
            err.push_str(&b);
        }
        if out.chars().count() > MAX_OUTPUT {
            out = out.chars().take(MAX_OUTPUT).collect();
        }
        if err.chars().count() > MAX_OUTPUT {
            err = err.chars().take(MAX_OUTPUT).collect();
        }

        let elapsed = started.elapsed().as_millis() as u64;
        let status = if killed { "interrupted" } else { "done" };
        write_record(
            &run_dir,
            &ScratchRunRecord {
                run_id: req.run_id.clone(),
                lang: req.lang.clone(),
                status: status.to_string(),
                pid,
                code: req.code.clone(),
                created_at: now_ms(),
                updated_at: now_ms(),
                exit_code: exit,
                elapsed_ms: elapsed,
                stdout: out.clone(),
                stderr: err.clone(),
            },
        );
        Ok(ScriptRunResult {
            exit_code: exit,
            stdout: out,
            stderr: err,
            elapsed_ms: elapsed,
            killed,
        })
    }
}

#[derive(Debug, Default, Clone)]
pub struct ReconcileReport {
    pub interrupted: Vec<String>,
    pub still_running: Vec<String>,
}

/// 孤儿 catch: 扫描 `scratch_dir` 下各 run 的 `run.json`, 对 `status=running` 且 pid 已死的
/// 运行标 `interrupted` (进程崩溃/被杀后未收尾的情况)。周期性调用即可兜底。
pub async fn reconcile_scratch_runs(scratch_dir: &Path) -> ReconcileReport {
    let mut report = ReconcileReport::default();
    if !scratch_dir.exists() {
        return report;
    }
    let rd = match std::fs::read_dir(scratch_dir) {
        Ok(r) => r,
        Err(_) => return report,
    };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let jp = p.join("run.json");
        let s = match std::fs::read_to_string(&jp) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let mut rec: ScratchRunRecord = match serde_json::from_str(&s) {
            Ok(r) => r,
            Err(_) => continue,
        };
        if rec.status != "running" {
            continue;
        }
        if pid_alive(rec.pid).await {
            report.still_running.push(rec.run_id.clone());
        } else {
            rec.status = "interrupted".to_string();
            rec.updated_at = now_ms();
            rec.stderr
                .push_str("\n[catch] 进程中断, 由 reconcile 标记 interrupted");
            write_record(&p, &rec);
            report.interrupted.push(rec.run_id.clone());
        }
    }
    report
}

/// 列出所有 scratch run 记录 (按 updated_at 倒序), 用于 catch 位置视图
pub fn list_runs(scratch_dir: &Path) -> Vec<ScratchRunRecord> {
    let mut out = Vec::new();
    if !scratch_dir.exists() {
        return out;
    }
    if let Ok(rd) = std::fs::read_dir(scratch_dir) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if let Ok(s) = std::fs::read_to_string(p.join("run.json")) {
                if let Ok(r) = serde_json::from_str::<ScratchRunRecord>(&s) {
                    out.push(r);
                }
            }
        }
    }
    out.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn scratch_runs_sh_echo_and_records() {
        let base = std::env::temp_dir().join(format!("bolloon_scratch_test_{}", now_ms()));
        let run_id = new_run_id();
        let run_dir = base.join(&run_id);
        let runner = TokioScriptRunner::new();
        let res = runner
            .run(ScriptRunRequest {
                run_id: run_id.clone(),
                lang: "sh".into(),
                code: "echo hello-scratch".into(),
                run_dir: run_dir.to_string_lossy().into_owned(),
                timeout_ms: 5000,
            })
            .await
            .expect("run");
        assert!(res.stdout.contains("hello-scratch"), "{}", res.stdout);
        assert!(!res.killed);
        // 记录已落盘
        let rec: ScratchRunRecord =
            serde_json::from_str(&std::fs::read_to_string(run_dir.join("run.json")).unwrap()).unwrap();
        assert_eq!(rec.status, "done");
        assert_eq!(rec.exit_code, Some(0));
        // list 能拿到
        let runs = list_runs(&base);
        assert!(runs.iter().any(|r| r.run_id == run_id));
        let _ = std::fs::remove_dir_all(&base);
    }
}
