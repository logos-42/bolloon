use serde::{Deserialize, Serialize};
use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 单条审计记录: 记录变更来源 / 版本 / 操作者 / 原因 / 结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    pub at: String,
    pub action: String, // apply / rollback / reject / load
    pub version: u64,
    pub based_on: Option<u64>,
    pub source: String,
    pub operator: String,
    pub reason: String,
    pub result: String, // ok / 错误信息
}

/// 配置审计日志: 内存保留 + 追加式 JSONL 落盘 (`<dir>/config-audit.jsonl`)。fire-and-forget, 失败仅告警。
pub struct ConfigAuditLog {
    path: Option<PathBuf>,
    buf: Mutex<Vec<AuditRecord>>,
}

impl ConfigAuditLog {
    pub fn new(path: Option<PathBuf>) -> Self {
        Self {
            path,
            buf: Mutex::new(vec![]),
        }
    }

    pub fn record(&self, rec: AuditRecord) {
        if let Some(p) = &self.path {
            if let Some(dir) = p.parent() {
                let _ = create_dir_all(dir);
            }
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(p) {
                if let Ok(line) = serde_json::to_string(&rec) {
                    let _ = writeln!(f, "{line}");
                }
            }
        }
        self.buf.lock().unwrap().push(rec);
    }

    /// 便捷构造并写入。
    pub fn log(
        &self,
        action: &str,
        version: u64,
        based_on: Option<u64>,
        source: &str,
        operator: &str,
        reason: &str,
        result: &str,
    ) {
        self.record(AuditRecord {
            at: chrono::Utc::now().to_rfc3339(),
            action: action.to_string(),
            version,
            based_on,
            source: source.to_string(),
            operator: operator.to_string(),
            reason: reason.to_string(),
            result: result.to_string(),
        });
    }

    pub fn records(&self) -> Vec<AuditRecord> {
        self.buf.lock().unwrap().clone()
    }
}
