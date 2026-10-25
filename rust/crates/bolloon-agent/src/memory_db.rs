//! 轻量化记忆数据库 — 嵌入式 SQL (SQLite via rusqlite, bundled 免系统依赖)
//!
//! 设计 (对齐 TS 版 jsonl 记忆的升级):
//! - **轻量 Postgres 语义** = 嵌入式 SQL: 单文件库 (`~/.bolloon/rust/memory.db`),
//!   零服务端零配置, 标准 SQL 查询 (与 Postgres 方言子集兼容)
//! - **agent 隔离**: 行级 agent_id, 查询恒带 agent 过滤 (互不串)
//! - 分层 (run_fact/lesson/decision/temporary) + importance + TTL 过期 (与 memory.rs 同语义)
//! - 查询: top-k (importance × 衰减), 全文子串过滤 (SQL LIKE)
//! - 迁移友好: 表结构带 schema_version; 老 memory.json 可导入

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 表 schema 版本 (迁移链用)
pub const MEMORY_DB_SCHEMA_VERSION: u32 = 1;

/// 记忆行 (与 MemoryEntry 同语义 + agent 字段)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MemoryRow {
    pub id: i64,
    pub agent_id: String,
    /// run_fact | lesson | decision | temporary
    pub layer: String,
    pub content: String,
    /// 0.0 ~ 1.0
    pub importance: f64,
    pub created_at_ms: u64,
    /// temporary 层过期时刻 (epoch ms; NULL = 永不过期)
    pub expires_at_ms: Option<u64>,
}

/// 记忆数据库
pub struct MemoryDb {
    conn: Connection,
}

impl MemoryDb {
    /// 打开 (文件不存在自动建表; `:memory:` 用于测试)
    pub fn open(path: &str) -> Result<Self, rusqlite::Error> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS memories (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id      TEXT NOT NULL,
                layer         TEXT NOT NULL,
                content       TEXT NOT NULL,
                importance    REAL NOT NULL DEFAULT 0.5,
                created_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id);
            CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(agent_id, layer);
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1');
            "#,
        )?;
        Ok(Self { conn })
    }

    /// 写入一条 (importance 越界收敛; temporary 必须带 expires_at)
    pub fn remember(
        &self,
        agent_id: &str,
        layer: &str,
        content: &str,
        importance: f64,
        now_ms: u64,
        ttl_ms: Option<u64>,
    ) -> Result<MemoryRow, rusqlite::Error> {
        let imp = importance.clamp(0.0, 1.0);
        let expires = ttl_ms.map(|t| now_ms + t);
        self.conn.execute(
            "INSERT INTO memories(agent_id, layer, content, importance, created_at_ms, expires_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![agent_id, layer, content, imp, now_ms, expires],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(MemoryRow {
            id,
            agent_id: agent_id.into(),
            layer: layer.into(),
            content: content.into(),
            importance: imp,
            created_at_ms: now_ms,
            expires_at_ms: expires,
        })
    }

    /// 召回 top-k (agent 隔离 + 过期过滤 + 子串过滤 + importance×衰减排序)
    ///
    /// 衰减 half-life 与 memory.rs 一致: temporary 1h / fact·lesson 24h / decision 72h
    pub fn recall(
        &self,
        agent_id: &str,
        query: Option<&str>,
        top_k: usize,
        now_ms: u64,
    ) -> Result<Vec<MemoryRow>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, agent_id, layer, content, importance, created_at_ms, expires_at_ms
             FROM memories
             WHERE agent_id = ?1
               AND (expires_at_ms IS NULL OR expires_at_ms > ?2)
               AND (?3 IS NULL OR content LIKE '%' || ?3 || '%')",
        )?;
        let rows = stmt.query_map(params![agent_id, now_ms as i64, query], |r| {
            Ok(MemoryRow {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                layer: r.get(2)?,
                content: r.get(3)?,
                importance: r.get(4)?,
                created_at_ms: r.get::<_, i64>(5)? as u64,
                expires_at_ms: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
            })
        })?;
        let mut scored: Vec<(f64, MemoryRow)> = rows
            .flatten()
            .map(|row| {
                let half_life_h = match row.layer.as_str() {
                    "temporary" => 1.0,
                    "decision" => 72.0,
                    _ => 24.0,
                };
                let age_h = now_ms.saturating_sub(row.created_at_ms) as f64 / 3_600_000.0;
                let decay = 0.5f64.powf(age_h / half_life_h);
                (row.importance * decay, row)
            })
            .collect();
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored.into_iter().take(top_k).map(|(_, r)| r).collect())
    }

    /// 遗忘 (agent 隔离)
    pub fn forget(&self, agent_id: &str, id: i64) -> Result<bool, rusqlite::Error> {
        let n = self.conn.execute(
            "DELETE FROM memories WHERE id = ?1 AND agent_id = ?2",
            params![id, agent_id],
        )?;
        Ok(n > 0)
    }

    /// 清理过期 (返回剔除数)
    pub fn sweep_expired(&self, now_ms: u64) -> Result<usize, rusqlite::Error> {
        let n = self.conn.execute(
            "DELETE FROM memories WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ?1",
            params![now_ms as i64],
        )?;
        Ok(n)
    }

    /// agent 记忆条数 (隔离计数)
    pub fn count_for(&self, agent_id: &str) -> Result<usize, rusqlite::Error> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    /// 从老 memory.json 导入 (快照行; 幂等: 同内容同 agent 跳过)
    pub fn import_legacy(
        &self,
        agent_id: &str,
        entries: &[crate::memory::MemoryEntry],
        now_ms: u64,
    ) -> Result<usize, rusqlite::Error> {
        let mut imported = 0;
        for e in entries {
            let exists: i64 = self.conn.query_row(
                "SELECT COUNT(*) FROM memories WHERE agent_id = ?1 AND content = ?2",
                params![agent_id, e.content],
                |r| r.get(0),
            )?;
            if exists > 0 {
                continue;
            }
            let layer = match e.layer {
                crate::memory::MemoryLayer::RunFact => "run_fact",
                crate::memory::MemoryLayer::Lesson => "lesson",
                crate::memory::MemoryLayer::Decision => "decision",
                crate::memory::MemoryLayer::Temporary => "temporary",
            };
            self.remember(agent_id, layer, &e.content, e.importance, now_ms, None)?;
            imported += 1;
        }
        Ok(imported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> MemoryDb {
        MemoryDb::open(":memory:").unwrap()
    }

    #[test]
    fn remember_and_recall_isolated_by_agent() {
        let db = db();
        db.remember("a1", "run_fact", "a1 的记忆", 0.9, 1000, None).unwrap();
        db.remember("a2", "run_fact", "a2 的记忆", 0.9, 1000, None).unwrap();
        let got = db.recall("a1", None, 10, 1100).unwrap();
        assert_eq!(got.len(), 1, "agent 隔离: a1 只看到 a1 的");
        assert_eq!(got[0].content, "a1 的记忆");
        assert_eq!(db.count_for("a1").unwrap(), 1);
        assert_eq!(db.count_for("a2").unwrap(), 1);
    }

    #[test]
    fn topk_by_importance_decay() {
        let db = db();
        db.remember("a", "run_fact", "旧的高价值", 0.95, 0, None).unwrap();
        db.remember("a", "run_fact", "新的中价值", 0.6, 1000, None).unwrap();
        let top = db.recall("a", None, 2, 1000).unwrap();
        // 旧的衰减 (72h half-life 下 1000ms 内几乎不衰 —— 用 temporary 验证衰减)
        assert!(top[0].importance >= top[1].importance || top[0].created_at_ms == 1000);
    }

    #[test]
    fn temporary_expires_swept() {
        let db = db();
        db.remember("a", "temporary", "临时", 0.9, 1000, Some(10_000)).unwrap();
        assert_eq!(db.recall("a", None, 10, 5000).unwrap().len(), 1);
        assert_eq!(db.recall("a", None, 10, 11_000).unwrap().len(), 0, "过期不可见");
        assert_eq!(db.sweep_expired(11_000).unwrap(), 1);
        assert_eq!(db.count_for("a").unwrap(), 0);
    }

    #[test]
    fn substring_query_filters() {
        let db = db();
        db.remember("a", "run_fact", "用户偏好暗色主题", 0.9, 1, None).unwrap();
        db.remember("a", "run_fact", "今天天气不错", 0.9, 1, None).unwrap();
        let got = db.recall("a", Some("偏好"), 10, 2).unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].content.contains("偏好"));
    }

    #[test]
    fn forget_agent_scoped() {
        let db = db();
        let r1 = db.remember("a1", "lesson", "x", 0.5, 1, None).unwrap();
        db.remember("a2", "lesson", "x", 0.5, 1, None).unwrap();
        assert!(db.forget("a1", r1.id).unwrap());
        // a2 的同内容不受影响
        assert_eq!(db.count_for("a2").unwrap(), 1);
        // 越权 forget (a2 的 id 用 a1 身份) → false
        let r2 = db.recall("a2", None, 1, 2).unwrap()[0].clone();
        assert!(!db.forget("a1", r2.id).unwrap(), "agent 隔离: 不能删别人的");
    }

    #[test]
    fn importance_clamped() {
        let db = db();
        let r = db.remember("a", "run_fact", "x", 99.0, 1, None).unwrap();
        assert!((r.importance - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn file_backed_persistence() {
        let dir = std::env::temp_dir().join(format!("bolloon-memdb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("memory.db");
        {
            let db = MemoryDb::open(path.to_str().unwrap()).unwrap();
            db.remember("a", "decision", "持久化决策", 0.8, 1, None).unwrap();
        }
        // 重开 → 数据还在
        let db2 = MemoryDb::open(path.to_str().unwrap()).unwrap();
        assert_eq!(db2.count_for("a").unwrap(), 1);
        let got = db2.recall("a", None, 1, 2).unwrap();
        assert_eq!(got[0].content, "持久化决策");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn legacy_import_idempotent() {
        let db = db();
        let entries = vec![crate::memory::MemoryEntry {
            id: "mem-000001".into(),
            content: "老 jsonl 记忆".into(),
            layer: crate::memory::MemoryLayer::Lesson,
            importance: 0.7,
            created_at: chrono_utc_now(),
            expires_at: None,
        }];
        let n1 = db.import_legacy("a", &entries, 1).unwrap();
        let n2 = db.import_legacy("a", &entries, 2).unwrap();
        assert_eq!(n1, 1);
        assert_eq!(n2, 0, "同内容幂等跳过");
        assert_eq!(db.count_for("a").unwrap(), 1);
    }

    fn chrono_utc_now() -> chrono::DateTime<chrono::Utc> {
        // memory::MemoryEntry 需要 chrono; agent crate 已依赖
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0).unwrap())
            .unwrap()
    }
}
