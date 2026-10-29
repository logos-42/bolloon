//! 用量计量 (Usage Meter) —— 消耗账本。
//!
//! 只记录**真实执行数据**: token 用量来自供应商响应, 耗时来自计时器, 成败来自调用结果。
//! 拿不到就写 `None` 并保留不确定性, 不补零、不编精确账单。
//!
//! 幂等: 每条事件有 `event_id`, 重复投递(重试/重复同步)只记一次, 重复计数单独统计 ——
//! 这样"重试导致的成本被算两遍"不会发生。

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::fs::{OpenOptions, create_dir_all};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub const SCHEMA_VERSION: u32 = 1;

/// 资源类型。**不同资源按各自维度记**, 不强行折算成同一种价值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceKind {
    /// 外部/本地模型推理
    ModelCall,
    /// 工具执行 (shell/文件/搜索…)
    ToolCall,
    /// Agent 间委托 (子任务派发)
    Delegation,
    /// 其他可计量资源 (存储/带宽; 本期只占位)
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MeterStatus {
    Ok,
    Failed,
    Cancelled,
    /// 同一次逻辑调用中的重试 (计费可能发生, 但不该算作"一次成功调用")
    Retried,
}

/// 一条用量记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeterEvent {
    /// 幂等键 (调用方生成: 同一逻辑调用重投时保持不变)
    pub event_id: String,
    pub schema_version: u32,
    pub at: String,
    pub resource: ResourceKind,
    /// 状态: ok / failed / cancelled / retried
    pub status: MeterStatus,

    /// 根意图 (None = 这次调用没有关联意图, 如实留空)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent_id: Option<String>,
    /// 本任务 id
    pub task_id: String,
    /// 父任务 id (委托链)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    /// 谁发起 (did / agent id / user)
    pub requester: String,
    /// 谁执行 (agent id; 本地直跑 = requester 同一方)
    pub executor: String,
    /// 资源提供者 (provider id; 本地模型 = local:<node>)
    pub provider: String,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 工具名 (resource=tool_call 时)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,

    /// 输入/输出/缓存 token —— 供应商不给就 None (不是 0)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_in: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_out: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_cache: Option<u32>,

    pub elapsed_ms: u64,

    /// 计价依据版本 (价格表版本号; None = 没有价格表)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub price_version: Option<String>,
    /// 估算成本 (价格表算出; 未经供应商账单核对)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd_estimated: Option<f64>,
    /// 已确认成本 (对过供应商账单/用量接口后才有)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd_confirmed: Option<f64>,

    /// unsettled / settled / unsupported
    pub settlement_state: String,

    /// 证据引用 (tool evidence / 响应 id), 不放 prompt 原文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<serde_json::Value>,
}

impl MeterEvent {
    pub fn new(
        event_id: impl Into<String>,
        resource: ResourceKind,
        task_id: impl Into<String>,
        provider: impl Into<String>,
    ) -> Self {
        Self {
            event_id: event_id.into(),
            schema_version: SCHEMA_VERSION,
            at: chrono::Utc::now().to_rfc3339(),
            resource,
            status: MeterStatus::Ok,
            intent_id: None,
            task_id: task_id.into(),
            parent_task_id: None,
            requester: "unknown".into(),
            executor: "unknown".into(),
            provider: provider.into(),
            model: None,
            tool: None,
            tokens_in: None,
            tokens_out: None,
            tokens_cache: None,
            elapsed_ms: 0,
            price_version: None,
            cost_usd_estimated: None,
            cost_usd_confirmed: None,
            settlement_state: "unsettled".into(),
            evidence: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordOutcome {
    New,
    /// 幂等命中 (重复投递) —— 不重复记账
    Duplicate,
}

const MEM_LIMIT: usize = 20_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MeterTotals {
    pub events: u64,
    pub duplicates: u64,
    pub write_failures: u64,
    pub model_calls: u64,
    pub tool_calls: u64,
    pub delegations: u64,
    pub failures: u64,
    pub retries: u64,
    pub tokens_in: u64,
    pub tokens_out: u64,
    /// 只有 price_version 存在的事件才计入
    pub cost_usd_estimated: f64,
    pub cost_usd_confirmed: f64,
    /// 有多少条事件**没有**金额 (缺价格表/缺用量) —— 诚实计数, 不假装 0 成本
    pub unpriced_events: u64,
}

/// 消耗账本: 内存近期保留 + 追加式 JSONL 落盘。
pub struct UsageMeter {
    path: Option<PathBuf>,
    seen: Mutex<HashSet<String>>,
    buf: Mutex<VecDeque<MeterEvent>>,
    duplicates: AtomicU64,
    write_failures: AtomicU64,
}

impl UsageMeter {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            seen: Mutex::new(HashSet::new()),
            buf: Mutex::new(VecDeque::new()),
            duplicates: AtomicU64::new(0),
            write_failures: AtomicU64::new(0),
        }
    }

    pub fn path(&self) -> Option<&PathBuf> {
        self.path.as_ref()
    }

    /// 记一条。重复 `event_id` 只算一次。
    pub fn record(&self, e: MeterEvent) -> RecordOutcome {
        {
            let mut seen = self.seen.lock().unwrap();
            if !seen.insert(e.event_id.clone()) {
                self.duplicates.fetch_add(1, Ordering::Relaxed);
                return RecordOutcome::Duplicate;
            }
        }
        if let Some(p) = &self.path {
            if let Some(dir) = p.parent() {
                let _ = create_dir_all(dir);
            }
            match OpenOptions::new().create(true).append(true).open(p) {
                Ok(mut f) => {
                    let line = serde_json::to_string(&e).unwrap_or_default();
                    if writeln!(f, "{line}").is_err() {
                        self.write_failures.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(path = %p.display(), "经济层计量落盘失败 (事件仍在内存)");
                    }
                }
                Err(err) => {
                    self.write_failures.fetch_add(1, Ordering::Relaxed);
                    tracing::warn!(path = %p.display(), error = %err, "经济层计量落盘失败 (事件仍在内存)");
                }
            }
        }
        let mut buf = self.buf.lock().unwrap();
        buf.push_back(e);
        while buf.len() > MEM_LIMIT {
            buf.pop_front();
        }
        RecordOutcome::New
    }

    pub fn events(&self) -> Vec<MeterEvent> {
        self.buf.lock().unwrap().iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.buf.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 某意图的全部事件 (从一个意图能查到它产生的每一次调用)
    pub fn events_for_intent(&self, intent_id: &str) -> Vec<MeterEvent> {
        self.buf
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.intent_id.as_deref() == Some(intent_id))
            .cloned()
            .collect()
    }

    pub fn totals(&self) -> MeterTotals {
        let buf = self.buf.lock().unwrap();
        let mut t = MeterTotals {
            duplicates: self.duplicates.load(Ordering::Relaxed),
            write_failures: self.write_failures.load(Ordering::Relaxed),
            ..Default::default()
        };
        for e in buf.iter() {
            t.events += 1;
            match e.resource {
                ResourceKind::ModelCall => t.model_calls += 1,
                ResourceKind::ToolCall => t.tool_calls += 1,
                ResourceKind::Delegation => t.delegations += 1,
                ResourceKind::Other => {}
            }
            if e.status == MeterStatus::Failed || e.status == MeterStatus::Cancelled {
                t.failures += 1;
            }
            if e.status == MeterStatus::Retried {
                t.retries += 1;
            }
            t.tokens_in += e.tokens_in.unwrap_or(0) as u64;
            t.tokens_out += e.tokens_out.unwrap_or(0) as u64;
            match (e.cost_usd_confirmed, e.cost_usd_estimated) {
                (Some(c), _) => t.cost_usd_confirmed += c,
                (None, Some(c)) => t.cost_usd_estimated += c,
                (None, None) => t.unpriced_events += 1,
            }
        }
        t
    }

    /// 每个意图的合计 (按 estimated+confirmed 求和; 没有金额的意图会被单列)
    pub fn totals_by_intent(&self) -> std::collections::BTreeMap<String, MeterTotals> {
        let mut out: std::collections::BTreeMap<String, MeterTotals> =
            std::collections::BTreeMap::new();
        for e in self.buf.lock().unwrap().iter() {
            let key = e
                .intent_id
                .clone()
                .unwrap_or_else(|| format!("<no-intent:{}>", e.task_id));
            let t = out.entry(key).or_default();
            t.events += 1;
            match e.resource {
                ResourceKind::ModelCall => t.model_calls += 1,
                ResourceKind::ToolCall => t.tool_calls += 1,
                ResourceKind::Delegation => t.delegations += 1,
                ResourceKind::Other => {}
            }
            if e.status == MeterStatus::Failed {
                t.failures += 1;
            }
            t.tokens_in += e.tokens_in.unwrap_or(0) as u64;
            t.tokens_out += e.tokens_out.unwrap_or(0) as u64;
            match (e.cost_usd_confirmed, e.cost_usd_estimated) {
                (Some(c), _) => t.cost_usd_confirmed += c,
                (None, Some(c)) => t.cost_usd_estimated += c,
                (None, None) => t.unpriced_events += 1,
            }
        }
        out
    }
}
