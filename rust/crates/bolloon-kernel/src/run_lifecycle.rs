//! Run 生命周期写口（start-run / record-step / finish-run / save-checkpoint）
//!
//! Kernel 只提供写接口 + 事件；持久化由调用方注入（端口注入，零依赖）。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Run ID
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct RunId(pub String);

impl RunId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
    pub fn random() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl std::fmt::Display for RunId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Run 状态机
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RunStatus {
    Pending,
    Running,
    Paused,
    Interrupted,
    Finished,
    Failed,
}

/// 一步记录
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StepRecord {
    pub step: u32,
    pub kind: String, // "model" | "tool" | "checkpoint"
    pub summary: String,
    pub timestamp: chrono::DateTime<chrono::Utc>,
    pub tool_calls: u32,
}

/// Run 生命周期事件（通知订阅方：web 运行视图 / supervisor）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum RunEvent {
    Started(RunId),
    Step(RunId, StepRecord),
    Finished(RunId, bool), // 第二个字段: success
    Failed(RunId, String),
    Interrupted(RunId),
}

/// Run 记录（内存态；持久化由 store 层做）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RunRecord {
    pub id: RunId,
    pub channel_id: String,
    pub goal_id: Option<String>,
    pub status: RunStatus,
    pub steps: Vec<StepRecord>,
    pub checkpoint: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl RunRecord {
    pub fn new(id: RunId, channel_id: impl Into<String>) -> Self {
        let now = chrono::Utc::now();
        Self {
            id,
            channel_id: channel_id.into(),
            goal_id: None,
            status: RunStatus::Pending,
            steps: vec![],
            checkpoint: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// 持久化端口（调用方注入；不注入 = 内存态）
#[async_trait::async_trait]
pub trait RunStore: Send + Sync {
    async fn save(&self, record: &RunRecord) -> anyhow::Result<()>;
    async fn load(&self, id: &RunId) -> anyhow::Result<Option<RunRecord>>;
}

/// 无操作 store（纯内存，测试/默认）
pub struct NoopRunStore;

#[async_trait::async_trait]
impl RunStore for NoopRunStore {
    async fn save(&self, _record: &RunRecord) -> anyhow::Result<()> {
        Ok(())
    }
    async fn load(&self, _id: &RunId) -> anyhow::Result<Option<RunRecord>> {
        Ok(None)
    }
}

/// RunLifecycle：Run 生命周期写口的唯一实现
pub struct RunLifecycle {
    store: Box<dyn RunStore>,
    records: Arc<Mutex<HashMap<RunId, RunRecord>>>,
}

impl std::fmt::Debug for RunLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunLifecycle")
            .field("store", &"<dyn RunStore>")
            .field("records", &self.records)
            .finish()
    }
}

impl RunLifecycle {
    pub fn new(store: Box<dyn RunStore>) -> Self {
        Self {
            store,
            records: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn in_memory() -> Self {
        Self::new(Box::new(NoopRunStore))
    }

    /// start-run：Pending → Running
    pub async fn start_run(
        &self,
        id: RunId,
        channel_id: impl Into<String>,
        goal_id: Option<String>,
    ) -> anyhow::Result<RunRecord> {
        let mut rec = RunRecord::new(id, channel_id);
        rec.goal_id = goal_id;
        rec.status = RunStatus::Running;
        let now = chrono::Utc::now();
        rec.updated_at = now;
        self.store.save(&rec).await?;
        self.records.lock().await.insert(rec.id.clone(), rec.clone());
        tracing::debug!(run = %rec.id, "run started");
        Ok(rec)
    }

    /// record-step：追加一步，状态保持 Running
    pub async fn record_step(&self, id: &RunId, step: StepRecord) -> anyhow::Result<()> {
        let mut map = self.records.lock().await;
        if let Some(rec) = map.get_mut(id) {
            rec.steps.push(step.clone());
            rec.updated_at = chrono::Utc::now();
            let snapshot = rec.clone();
            self.store.save(&snapshot).await?;
        }
        Ok(())
    }

    /// save-checkpoint：保存恢复点
    pub async fn save_checkpoint(
        &self,
        id: &RunId,
        checkpoint: serde_json::Value,
    ) -> anyhow::Result<()> {
        let mut map = self.records.lock().await;
        if let Some(rec) = map.get_mut(id) {
            rec.checkpoint = Some(checkpoint);
            rec.updated_at = chrono::Utc::now();
            let snapshot = rec.clone();
            self.store.save(&snapshot).await?;
        }
        Ok(())
    }

    /// finish-run：Running → Finished
    pub async fn finish_run(&self, id: &RunId, success: bool) -> anyhow::Result<RunRecord> {
        let mut map = self.records.lock().await;
        let rec = map
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("run {id} 不存在"))?;
        rec.status = if success {
            RunStatus::Finished
        } else {
            RunStatus::Failed
        };
        rec.updated_at = chrono::Utc::now();
        let snapshot = rec.clone();
        self.store.save(&snapshot).await?;
        Ok(snapshot)
    }

    /// 标记失败
    pub async fn fail_run(&self, id: &RunId, reason: &str) -> anyhow::Result<RunRecord> {
        let mut map = self.records.lock().await;
        let rec = map
            .get_mut(id)
            .ok_or_else(|| anyhow::anyhow!("run {id} 不存在"))?;
        rec.status = RunStatus::Failed;
        rec.updated_at = chrono::Utc::now();
        let snapshot = rec.clone();
        self.store.save(&snapshot).await?;
        tracing::warn!(run = %id, reason, "run failed");
        Ok(snapshot)
    }

    /// 中断恢复入口（SIGKILL 后新进程恢复同一 run）
    /// 优先从内存记录取（同进程内中断）；再从 store load（跨进程）。
    pub async fn resume(&self, id: &RunId) -> anyhow::Result<Option<RunRecord>> {
        // 1. 内存记录优先（同进程场景）
        if let Some(mut rec) = self.records.lock().await.get(id).cloned() {
            if rec.status == RunStatus::Interrupted || rec.status == RunStatus::Running {
                rec.status = RunStatus::Running;
                rec.updated_at = chrono::Utc::now();
                self.store.save(&rec).await?;
                self.records.lock().await.insert(rec.id.clone(), rec.clone());
            }
            return Ok(Some(rec));
        }
        // 2. 跨进程：从 store load
        let rec = self.store.load(id).await?;
        if let Some(mut rec) = rec {
            if rec.status == RunStatus::Interrupted || rec.status == RunStatus::Running {
                rec.status = RunStatus::Running;
                rec.updated_at = chrono::Utc::now();
                self.store.save(&rec).await?;
            }
            self.records.lock().await.insert(rec.id.clone(), rec.clone());
            Ok(Some(rec))
        } else {
            Ok(None)
        }
    }

    pub async fn get(&self, id: &RunId) -> Option<RunRecord> {
        self.records.lock().await.get(id).cloned()
    }

    pub async fn all(&self) -> Vec<RunRecord> {
        let mut v: Vec<RunRecord> = self.records.lock().await.values().cloned().collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        v
    }

    pub async fn len(&self) -> usize {
        self.records.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn full_lifecycle() {
        let lc = RunLifecycle::in_memory();
        let rid = RunId::random();

        let rec = lc
            .start_run(rid.clone(), "c1", Some("g1".to_string()))
            .await
            .unwrap();
        assert_eq!(rec.status, RunStatus::Running);

        lc.record_step(
            &rid,
            StepRecord {
                step: 1,
                kind: "model".into(),
                summary: "调用 deepseek".into(),
                timestamp: chrono::Utc::now(),
                tool_calls: 0,
            },
        )
        .await
        .unwrap();

        lc.save_checkpoint(&rid, serde_json::json!({"messages": 3}))
            .await
            .unwrap();

        let fin = lc.finish_run(&rid, true).await.unwrap();
        assert_eq!(fin.status, RunStatus::Finished);
        assert_eq!(fin.steps.len(), 1);
        assert!(fin.checkpoint.is_some());
    }

    #[tokio::test]
    async fn resume_after_interrupt() {
        // 模拟：上一个进程写盘后被杀。用内存 store 模拟 load
        let lc = RunLifecycle::in_memory();
        let rid = RunId::random();
        lc.start_run(rid.clone(), "c1", None).await.unwrap();
        lc.finish_run(&rid, true).await.unwrap();

        // resume 已 finished 的 run → 不重置状态（只对 interrupted/running 生效）
        let rec = lc.resume(&rid).await.unwrap().unwrap();
        assert_eq!(rec.status, RunStatus::Finished);
    }
}