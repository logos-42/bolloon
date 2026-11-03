//! sql_tools.rs — SQL 工具类 (只读查询; 2026-11-04)
//!
//! 纪律 (与 web_fetch 同级: 有真实用途, 但必须窄):
//! - **只读**: 只允许 `SELECT` / `WITH` / `EXPLAIN`; 其余 (INSERT/UPDATE/DELETE/DROP/
//!   ALTER/CREATE/PRAGMA/ATTACH/DETACH/VACUUM/REPLACE) 一律拒, 且**多语句**(分号后还有内容)拒
//! - **只读连接**: 用 `SQLITE_OPEN_READ_ONLY` 打开 —— 就算守卫被绕过, 库也写不进去 (第二道闸)
//! - **路径白名单**: 别名 `memory` (= `~/.bolloon/rust/memory.db`) 或 **~/.bolloon 与当前工作目录之内**
//!   的绝对路径; 库文件必须已存在 (不新建)
//! - **行数上限**: 默认 50 / 最多 200, 超了截断并在输出里写明 (不假装返回全量)
//!
//! 不给好友的只读指挥用 (那是 `READONLY_TOOL_NAMES` 白名单, 刻意不含 SQL —— 本地库里有对话与记忆)。

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use rusqlite::{Connection, OpenFlags};

use crate::tool_contract::{error_evidence, ErrorCode};

/// 默认行数上限
pub const DEFAULT_LIMIT: usize = 50;
/// 硬上限
pub const MAX_LIMIT: usize = 200;

/// 守卫: 只允许只读语句 (纯函数, 可测)
///
/// 判据: 去掉注释/前导空白后, 首个关键字必须是 SELECT/WITH/EXPLAIN;
/// 任何位置不得出现 `;` 之后还有非空白内容 (多语句); 出现写类关键字也拒 (纵深防御)。
pub fn is_read_only_sql(sql: &str) -> Result<(), String> {
    let cleaned = strip_leading_comments(sql).trim();
    if cleaned.is_empty() {
        return Err("SQL 为空".into());
    }
    let lower = cleaned.to_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    if !matches!(first, "select" | "with" | "explain") {
        return Err(format!(
            "只允许只读查询 (SELECT/WITH/EXPLAIN)，收到 `{first}` —— 写/DDL/PRAGMA/ATTACH 一律拒绝"
        ));
    }
    // 多语句: 第一个 `;` 之后必须只剩空白
    if let Some((_, tail)) = cleaned.split_once(';') {
        if !tail.trim().is_empty() {
            return Err("只允许单条语句（分号后还有内容）".into());
        }
    }
    for bad in [
        "insert ", "update ", "delete ", "drop ", "alter ", "create ", "replace ", "attach ",
        "detach ", "pragma ", "vacuum ", "reindex ", "begin ", "commit ",
    ] {
        if lower.contains(bad) {
            return Err(format!("语句里出现写/管理类关键字 `{}` —— 只读工具拒绝", bad.trim()));
        }
    }
    Ok(())
}

fn strip_leading_comments(sql: &str) -> &str {
    let mut s = sql.trim_start();
    loop {
        if let Some(rest) = s.strip_prefix("--") {
            s = rest.split_once('\n').map(|(_, r)| r).unwrap_or("").trim_start();
            continue;
        }
        if s.starts_with("/*") {
            if let Some(idx) = s.find("*/") {
                s = s[idx + 2..].trim_start();
                continue;
            }
            return "";
        }
        return s;
    }
}

/// 解析库路径 (别名 / 白名单)
pub fn resolve_db(spec: &str) -> Result<PathBuf, String> {
    let spec = spec.trim();
    if spec.is_empty() || spec == "memory" {
        let p = crate::home::BolloonHome::resolve().root().join("memory.db");
        if !p.exists() {
            return Err(format!("memory.db 还不存在: {}", p.display()));
        }
        return Ok(p);
    }
    let p = PathBuf::from(spec);
    if !p.is_absolute() {
        return Err("db 要么是 `memory`，要么是绝对路径".into());
    }
    let canon = p
        .canonicalize()
        .map_err(|e| format!("库文件不存在或不可读: {} ({e})", p.display()))?;
    let home = crate::home::BolloonHome::resolve()
        .root()
        .canonicalize()
        .unwrap_or_else(|_| crate::home::BolloonHome::resolve().root().to_path_buf());
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd = cwd.canonicalize().unwrap_or(cwd);
    let allowed: Vec<&Path> = vec![home.as_path(), cwd.as_path()];
    if !allowed.iter().any(|a| canon.starts_with(a)) {
        return Err("只允许打开 ~/.bolloon 或当前工作目录之内的库（不越界）".into());
    }
    Ok(canon)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 执行只读查询 (唯一的执行入口; 工具与 HTTP 端点共用)
pub fn run_query(db_spec: &str, sql: &str, limit: Option<usize>) -> Result<serde_json::Value, String> {
    is_read_only_sql(sql)?;
    let path = resolve_db(db_spec)?;
    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let started = std::time::Instant::now();
    let conn = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开库失败（只读）: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
    let mut stmt = conn.prepare(sql).map_err(|e| format!("SQL 解析失败: {e}"))?;
    let cols: Vec<String> = stmt.column_names().into_iter().map(|c| c.to_string()).collect();
    let mut rows_out: Vec<Vec<String>> = Vec::new();
    let mut truncated = false;
    {
        let mut rows = stmt.query([]).map_err(|e| format!("查询失败: {e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("读行失败: {e}"))? {
            if rows_out.len() >= limit {
                truncated = true;
                break;
            }
            let mut one: Vec<String> = Vec::with_capacity(cols.len());
            for i in 0..cols.len() {
                let v: rusqlite::types::Value = row.get(i).unwrap_or(rusqlite::types::Value::Null);
                one.push(match v {
                    rusqlite::types::Value::Null => "NULL".to_string(),
                    rusqlite::types::Value::Integer(n) => n.to_string(),
                    rusqlite::types::Value::Real(f) => f.to_string(),
                    rusqlite::types::Value::Text(t) => t,
                    rusqlite::types::Value::Blob(b) => format!("<blob {} bytes>", b.len()),
                });
            }
            rows_out.push(one);
        }
    }
    Ok(serde_json::json!({
        "db": path.display().to_string(),
        "columns": cols,
        "rows": rows_out,
        "row_count": rows_out.len(),
        "truncated": truncated,
        "limit": limit,
        "elapsed_ms": started.elapsed().as_millis() as u64,
        "read_only": true,
        "at_ms": now_ms(),
    }))
}

/// 渲染成人读文本 (工具输出用)
pub fn render(rep: &serde_json::Value) -> String {
    let cols: Vec<&str> = rep["columns"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let mut out = String::new();
    out.push_str(&format!("[sql] {}\n", rep["db"].as_str().unwrap_or("")));
    out.push_str(&cols.join(" | "));
    out.push('\n');
    out.push_str(&"-".repeat(cols.join(" | ").chars().count().min(120)));
    out.push('\n');
    if let Some(rows) = rep["rows"].as_array() {
        for r in rows {
            let cells: Vec<&str> = r.as_array().map(|a| a.iter().filter_map(|v| v.as_str()).collect()).unwrap_or_default();
            out.push_str(&cells.join(" | "));
            out.push('\n');
        }
    }
    out.push_str(&format!(
        "({} 行{}{})\n",
        rep["row_count"].as_u64().unwrap_or(0),
        if rep["truncated"].as_bool().unwrap_or(false) { "，已截断" } else { "" },
        rep["elapsed_ms"].as_u64().map(|ms| format!("，{ms}ms")).unwrap_or_default()
    ));
    out
}

pub fn sql_tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "sql_query".into(),
        description: "只读 SQL 查询本地库（SELECT/WITH/EXPLAIN；默认 memory.db，行数上限 50，超限截断）。写/DDL/PRAGMA/多语句一律拒绝。".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "sql": { "type": "string", "description": "只读 SQL（SELECT / WITH / EXPLAIN）" },
                "db": { "type": "string", "description": "`memory`(默认) 或 ~/.bolloon 与当前工作目录内的绝对路径" },
                "limit": { "type": "integer", "description": "行数上限，默认 50，最大 200" }
            },
            "required": ["sql"],
            "additionalProperties": false
        }),
        effect: EffectKind::Read,
        default_allowed: true,
    }]
}

pub struct SqlExecutor;

#[async_trait]
impl ToolExecutor for SqlExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let started = std::time::Instant::now();
        let sql = call.arguments.get("sql").and_then(|v| v.as_str()).unwrap_or("");
        let db = call.arguments.get("db").and_then(|v| v.as_str()).unwrap_or("memory");
        let limit = call.arguments.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
        match run_query(db, sql, limit) {
            Ok(rep) => ToolResult {
                ok: true,
                output: render(&rep),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(true),
                evidence: Some(serde_json::json!({
                    "db": rep["db"], "row_count": rep["row_count"],
                    "truncated": rep["truncated"], "read_only": true
                })),
            },
            Err(e) => ToolResult {
                ok: false,
                output: e.clone(),
                elapsed_ms: started.elapsed().as_millis() as u64,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::InvalidArgument, &e)),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_allows_read_queries() {
        assert!(is_read_only_sql("SELECT 1").is_ok());
        assert!(is_read_only_sql("  with x as (select 1) select * from x").is_ok());
        assert!(is_read_only_sql("-- 注释\nSELECT 1;").is_ok());
        assert!(is_read_only_sql("/* c */ EXPLAIN SELECT 1").is_ok());
    }

    #[test]
    fn guard_blocks_writes_and_multi_statement() {
        for sql in [
            "INSERT INTO t VALUES (1)",
            "UPDATE t SET a=1",
            "delete from t",
            "DROP TABLE t",
            "PRAGMA journal_mode=WAL",
            "ATTACH DATABASE 'x' AS y",
            "CREATE TABLE t(a)",
            "SELECT 1; DROP TABLE t",
        ] {
            assert!(is_read_only_sql(sql).is_err(), "必须拒: {sql}");
        }
    }

    #[test]
    fn read_only_connection_actually_blocks_writes() {
        // 建一个真库 → 用只读连接 → 写必败 (守卫之外的第二道闸)
        let dir = std::env::temp_dir().join(format!("bolloon-sql-t-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.db");
        {
            let c = Connection::open(&p).unwrap();
            c.execute_batch("CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (1);").unwrap();
        }
        let c = Connection::open_with_flags(&p, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(c.execute("INSERT INTO t VALUES (2)", []).is_err(), "只读连接不许写");
        let v: i64 = c.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(v, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_absolute_db_is_rejected() {
        assert!(resolve_db("relative.db").is_err());
    }
}
