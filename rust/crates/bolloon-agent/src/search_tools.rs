//! search_tools.rs — 搜索族（迁移第 4 步：grep_files / glob_files）
//!
//! 纯 Rust 实现（不 spawn 外部命令），因此**可被取消/超时语义之外**天然安全：
//!   · 跳过 `.git` / `node_modules` / `target` / `dist` 等噪声目录
//!   · 跳过超大文件（>1MB）与二进制（含 NUL 字节）
//!   · 结果条数硬上限（不把整个仓库倒进上下文）
//!
//! 权限: 只读（`EffectKind::Read`，默认允许）。

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use crate::tool_contract::{ErrorCode, error_evidence};

/// 单文件读取上限（超过就跳过，不读进内存）
const MAX_FILE_BYTES: u64 = 1_000_000;
/// 命中条数上限
const MAX_HITS: usize = 100;
/// 遍历目录/文件上限（防巨仓卡死）
const MAX_WALK: usize = 20_000;

const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", "vendor"];

/// 极简 glob（`*` / `?`，够用且无新依赖）
pub fn glob_match(name: &str, pattern: &str) -> bool {
    let mut ni = name.chars();
    let mut pi = pattern.chars().peekable();
    let mut pending = String::new();
    while let Some(p) = pi.next() {
        match p {
            '*' => {
                if pi.peek().is_none() {
                    return true; // 以 * 结尾 ⇒ 前缀匹配即可
                }
                // 贪心: 用剩余 pattern 去 name 里找
                let star = pending.clone();
                let rest: String = pi.collect();
                let name_rest: String = ni.by_ref().collect::<String>();
                let full = format!("{}{}", pending, name_rest);
                return find_star(&full, &star, &rest);
            }
            '?' => match ni.next() {
                Some(c) => pending.push(c),
                None => return false,
            },
            c => match ni.next() {
                Some(n) if n == c => pending.push(c),
                _ => return false,
            },
        }
    }
    ni.next().is_none()
}

/// `*` 的回溯匹配（够用：单层通配）
fn find_star(name: &str, prefix: &str, rest: &str) -> bool {
    if !name.starts_with(prefix) {
        return false;
    }
    let tail = &name[prefix.len()..];
    if rest.is_empty() {
        return true;
    }
    // 尝试每个切点
    let mut buf = String::new();
    let chars: Vec<char> = tail.chars().collect();
    for i in 0..=chars.len() {
        buf.clear();
        let suffix: String = chars[i..].iter().collect();
        // 剩余 pattern 与 suffix 逐字比（`*` 已被切分处理）
        if match_simple(&suffix, rest) {
            return true;
        }
    }
    false
}

/// 无 `*` 的逐字匹配（`?` 通配单字符）
fn match_simple(s: &str, p: &str) -> bool {
    let mut si = s.chars();
    for pc in p.chars() {
        match pc {
            '?' => {
                if si.next().is_none() {
                    return false;
                }
            }
            '*' => return true,
            c => {
                if si.next() != Some(c) {
                    return false;
                }
            }
        }
    }
    si.next().is_none()
}

/// 递归收集文件（带上限与噪声目录跳过）
fn walk_files(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= MAX_WALK {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                let is_skip = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| SKIP_DIRS.contains(&n))
                    .unwrap_or(false);
                if !is_skip {
                    stack.push(path);
                }
            } else if ft.is_file() {
                out.push(path);
            }
        }
    }
    out
}

pub struct SearchExecutor;

#[async_trait]
impl ToolExecutor for SearchExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "grep_files" => do_grep(call).await,
            "glob_files" => do_glob(call).await,
            other => ToolResult {
                ok: false,
                output: format!("搜索族没有 `{other}`（不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

async fn do_grep(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let pattern = call.arguments.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if pattern.is_empty() {
        return ToolResult {
            ok: false,
            output: "grep_files: pattern 必填".into(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::InvalidArgument, "pattern 必填")),
        };
    }
    let root = call
        .arguments
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(".")
        .to_string();
    if let Some(p) = crate::shell_tool::denied_path(&root) {
        return ToolResult {
            ok: false,
            output: format!("涉及受保护路径 `{p}`"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::Denied, "受保护路径")),
        };
    }
    let case_sensitive = call
        .arguments
        .get("case_sensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let needle = if case_sensitive {
        pattern.clone()
    } else {
        pattern.to_lowercase()
    };

    let mut hits: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    for f in walk_files(std::path::Path::new(&root)) {
        if hits.len() >= MAX_HITS {
            break;
        }
        let Ok(meta) = std::fs::metadata(&f) else { continue };
        if meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&f) else { continue };
        if content.as_bytes().contains(&0) {
            continue; // 二进制
        }
        scanned += 1;
        for (i, line) in content.lines().enumerate() {
            if hits.len() >= MAX_HITS {
                break;
            }
            let hit = if case_sensitive {
                line.contains(&needle)
            } else {
                line.to_lowercase().contains(&needle)
            };
            if hit {
                hits.push(format!("{}:{}:{}", f.display(), i + 1, line.trim()));
            }
        }
    }
    ToolResult {
        ok: true,
        output: if hits.is_empty() {
            format!("grep `{pattern}` 无命中（扫了 {scanned} 个文件）")
        } else {
            format!(
                "grep `{pattern}` 命中 {} 条{}:\n{}",
                hits.len(),
                if hits.len() >= MAX_HITS { format!("（已达上限 {MAX_HITS}）") } else { String::new() },
                hits.join("\n")
            )
        },
        elapsed_ms: started.elapsed().as_millis() as u64,
        verified: Some(true),
        evidence: Some(serde_json::json!({ "pattern": pattern, "hits": hits.len(), "scanned": scanned })),
    }
}

async fn do_glob(call: ToolCall) -> ToolResult {
    let started = std::time::Instant::now();
    let pattern = call.arguments.get("pattern").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if pattern.is_empty() {
        return ToolResult {
            ok: false,
            output: "glob_files: pattern 必填".into(),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::InvalidArgument, "pattern 必填")),
        };
    }
    let root = call
        .arguments
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(".")
        .to_string();
    if let Some(p) = crate::shell_tool::denied_path(&root) {
        return ToolResult {
            ok: false,
            output: format!("涉及受保护路径 `{p}`"),
            elapsed_ms: started.elapsed().as_millis() as u64,
            verified: Some(false),
            evidence: Some(error_evidence(ErrorCode::Denied, "受保护路径")),
        };
    }
    let mut matched: Vec<String> = Vec::new();
    for f in walk_files(std::path::Path::new(&root)) {
        if matched.len() >= MAX_HITS {
            break;
        }
        let name = f.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if glob_match(name, &pattern) {
            matched.push(f.display().to_string());
        }
    }
    matched.sort();
    ToolResult {
        ok: true,
        output: if matched.is_empty() {
            format!("glob `{pattern}` 无匹配")
        } else {
            format!("glob `{pattern}` 命中 {} 个:\n{}", matched.len(), matched.join("\n"))
        },
        elapsed_ms: started.elapsed().as_millis() as u64,
        verified: Some(true),
        evidence: Some(serde_json::json!({ "pattern": pattern, "matched": matched.len() })),
    }
}

fn read_only_def(name: &str, desc: &str, params: serde_json::Value) -> ToolDef {
    ToolDef {
        name: name.into(),
        description: desc.into(),
        parameters: params,
        effect: EffectKind::Read,
        default_allowed: true, // 只读
    }
}

pub fn search_tool_defs() -> Vec<ToolDef> {
    vec![
        read_only_def(
            "grep_files",
            "在文件内容里搜字符串（只读）。返回 `路径:行号:内容`，带命中上限。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "要搜的字符串（必填）" },
                    "path": { "type": "string", "description": "搜索根目录（可选，默认当前目录）" },
                    "case_sensitive": { "type": "boolean", "description": "是否区分大小写（可选，默认 true）" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        read_only_def(
            "glob_files",
            "按文件名通配找文件（只读，支持 * 与 ?）。",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "文件名通配（必填，如 *.rs）" },
                    "path": { "type": "string", "description": "搜索根目录（可选，默认当前目录）" }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: serde_json::Value) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args }
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bolloon_search_{}_{}", std::process::id(), tag));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[tokio::test]
    async fn grep_finds_content_with_line_numbers() {
        let d = tmpdir("grep");
        std::fs::write(d.join("a.txt"), "alpha\nneedle here\nbeta").unwrap();
        let r = SearchExecutor
            .execute(call("grep_files", serde_json::json!({ "pattern": "needle", "path": d.display().to_string() })))
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("a.txt:2:needle here"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn grep_can_be_case_insensitive() {
        let d = tmpdir("grepci");
        std::fs::write(d.join("b.txt"), "NEEDLE").unwrap();
        let r = SearchExecutor
            .execute(call("grep_files", serde_json::json!({
                "pattern": "needle", "path": d.display().to_string(), "case_sensitive": false
            })))
            .await;
        assert!(r.ok);
        assert!(r.output.contains("b.txt:1:NEEDLE"), "{}", r.output);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn glob_matches_filenames() {
        let d = tmpdir("glob");
        std::fs::write(d.join("x.rs"), "").unwrap();
        std::fs::write(d.join("y.txt"), "").unwrap();
        let r = SearchExecutor
            .execute(call("glob_files", serde_json::json!({ "pattern": "*.rs", "path": d.display().to_string() })))
            .await;
        assert!(r.ok);
        assert!(r.output.contains("x.rs"), "{}", r.output);
        assert!(!r.output.contains("y.txt"), "不该匹配 .txt: {}", r.output);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[tokio::test]
    async fn missing_pattern_rejected_at_entry() {
        let r = SearchExecutor.execute(call("grep_files", serde_json::json!({}))).await;
        assert!(!r.ok);
        assert!(r.output.contains("pattern 必填"), "{}", r.output);
    }

    /// 只读族默认允许
    #[test]
    fn search_tools_are_read_only_and_allowed() {
        for d in search_tool_defs() {
            assert_eq!(d.effect, EffectKind::Read);
            assert!(d.default_allowed, "{} 只读应默认允许", d.name);
        }
    }

    #[test]
    fn glob_match_handles_star_and_question() {
        assert!(glob_match("a.rs", "*.rs"));
        assert!(!glob_match("a.txt", "*.rs"));
        assert!(glob_match("a1.rs", "a?.rs"));
        assert!(!glob_match("a12.rs", "a?.rs"));
    }
}
