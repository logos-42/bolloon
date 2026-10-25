//! trace.rs — 执行描述 (把"它在想什么"换成"它在做什么")
//!
//! **复用 TS 原文** `src/cli/trace-line.ts`:
//!   · `describeToolCall` — 工具名 → 中文动作短语 (按"人看到这一步在干嘛"来写, 不照搬工具名)
//!   · `traceLabel`       — `动作 · 工具名` (认不出就只给工具名, **绝不显示空白**)
//!   · `toolArgsSummary`  — 参数摘要上工具行 (2026-10-14 leo: 「看不到过程」)
//!
//! 起因 (TS 注释原文): 原来显示的是模型的**思维流**(💭) —— 英文、常重复四遍、还夹着**错的推断** ✗
//!   (例: 同一句 "The user wants to push to GitHub." 出现四次)。人要的是"它**在做什么**" ✓。

enum Kind {
    /** `^(a|b)$` — 全名相等 */
    Exact,
    /** `^a|^b` — 前缀 */
    Prefix,
    /** `^task|^plan|^todo/i` — 前缀且忽略大小写 */
    PrefixInsensitive,
}

struct Rule {
    pats: &'static [&'static str],
    kind: Kind,
    label: &'static str,
}

/// 工具名 → 中文动作短语 (**顺序即优先级**, 与 TS 的 ACTIONS 表逐条对齐)
const ACTIONS: &[Rule] = &[
    Rule { pats: &["git_status"], kind: Kind::Exact, label: "查看 git 状态" },
    Rule { pats: &["git_diff"], kind: Kind::Exact, label: "看改动差异" },
    Rule { pats: &["git_log"], kind: Kind::Exact, label: "看提交历史" },
    Rule { pats: &["git_commit"], kind: Kind::Exact, label: "提交改动" },
    Rule { pats: &["git_push"], kind: Kind::Exact, label: "推送" },
    Rule { pats: &["grep_files"], kind: Kind::Exact, label: "搜内容" },
    Rule { pats: &["glob_files"], kind: Kind::Exact, label: "找文件" },
    Rule { pats: &["list_files"], kind: Kind::Exact, label: "列目录" },
    Rule { pats: &["read_file"], kind: Kind::Exact, label: "读文件" },
    Rule { pats: &["read_document"], kind: Kind::Exact, label: "读文档" },
    Rule { pats: &["write_file"], kind: Kind::Exact, label: "写文件" },
    Rule { pats: &["edit_file", "patch"], kind: Kind::Exact, label: "改文件" },
    Rule { pats: &["mkdir", "move_file", "delete_file", "copy_file"], kind: Kind::Exact, label: "改文件系统" },
    Rule { pats: &["terminal"], kind: Kind::Exact, label: "跑命令" },
    Rule { pats: &["execute_code"], kind: Kind::Exact, label: "跑代码" },
    Rule { pats: &["tsc_check"], kind: Kind::Exact, label: "查类型" },
    Rule { pats: &["list_tools"], kind: Kind::Exact, label: "看有哪些工具" },
    // 2026-10-13 (leo: 「加载技能记忆类似工具调用… 看到技能之后运行它, 上下文里就能看到」):
    //   技能加载走 📚 前缀 —— 一眼可辨"这是技能/记忆按需加载", 不是普通工具调用。
    Rule { pats: &["list_skills"], kind: Kind::Exact, label: "📚 找技能" },
    Rule { pats: &["read_skill"], kind: Kind::Exact, label: "📚 读技能" },
    Rule { pats: &["memory_recall", "memory_search", "memory_query", "memory_load"], kind: Kind::Exact, label: "📚 取记忆" },
    Rule { pats: &["process"], kind: Kind::Exact, label: "管后台进程/服务" },
    Rule { pats: &["task", "plan", "todo"], kind: Kind::PrefixInsensitive, label: "理计划/待办" },
    Rule { pats: &["send_", "broadcast", "check_inbox", "list_peers"], kind: Kind::Prefix, label: "发消息/看连接" },
    Rule { pats: &["group", "create_group", "join_group"], kind: Kind::Prefix, label: "群聊操作" },
    Rule { pats: &["wallet", "get_balance", "tx", "token"], kind: Kind::Prefix, label: "链上/钱包操作" },
    Rule { pats: &["fetch_url", "web_search"], kind: Kind::Prefix, label: "联网取信息" },
    Rule { pats: &["get_identity", "set_persona", "bolloon_config"], kind: Kind::Prefix, label: "看/改身份与配置" },
    Rule { pats: &["delegate_task", "agent_call"], kind: Kind::Prefix, label: "派子智能体" },
];

/** 一句话说清这一步在做什么; 认不出的工具 ⇒ 返回空 (调用方退回显示工具名) ✓ */
pub fn describe_tool_call(name: &str) -> &'static str {
    let n = name.trim();
    if n.is_empty() {
        return "";
    }
    for r in ACTIONS {
        let hit = match r.kind {
            Kind::Exact => r.pats.contains(&n),
            Kind::Prefix => r.pats.iter().any(|p| n.starts_with(p)),
            Kind::PrefixInsensitive => r
                .pats
                .iter()
                .any(|p| n.to_lowercase().starts_with(&p.to_lowercase())),
        };
        if hit {
            return r.label;
        }
    }
    ""
}

/** 渲染成工具行文字 (认不出就用工具名本身, **绝不显示空白** ✓) */
pub fn trace_label(name: &str) -> String {
    let d = describe_tool_call(name);
    if d.is_empty() {
        name.to_string()
    } else {
        format!("{d} · {name}")
    }
}

/**
 * 工具参数摘要 (2026-10-14, leo: 「调用工具的时候, 把执行的命令缩写也附带上」)。
 *
 * 从 args 里挑「人看到就懂的」关键字段, 截断成一行的命令缩写:
 *   terminal(command='npx vitest run src/test/x') → `npx vitest run src/test/x`
 *   read_file(path='src/index.ts')               → `src/index.ts`
 *   grep_files(pattern='foo', path='src')        → `foo · src`
 * 认不出该工具的参数形态 → 返回空 (工具行不带摘要, 保持现状)。
 *
 * 只吃**对象形态** (TS 里 string 形态不解析 —— step_* 事件给的是对象)。
 */
pub fn tool_args_summary(name: &str, args: Option<&serde_json::Value>) -> String {
    let n = name.trim();
    let obj = args.and_then(|v| v.as_object());
    if n.is_empty() {
        return String::new();
    }

    /// TS `pick(keys)`: 第一个非空且非 `"undefined"` 的值
    let pick = |keys: &[&str]| -> String {
        let Some(map) = obj else { return String::new() };
        for k in keys {
            if let Some(v) = map.get(*k) {
                if v.is_null() {
                    continue;
                }
                let s = json_to_js_string(v);
                let s = s.trim();
                if !s.is_empty() && s != "undefined" {
                    return s.to_string();
                }
            }
        }
        String::new()
    };

    let summary = if n == "terminal" {
        pick(&["command", "cmd", "script"])
    } else if matches!(
        n,
        "read_file" | "read_document" | "write_file" | "read_directory" | "list_files"
    ) {
        pick(&["path", "filePath", "file", "dir", "directory"])
    } else if matches!(n, "grep_files" | "search_files") {
        let p = pick(&["pattern", "query"]);
        let d = pick(&["path", "dir"]);
        [p, d].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(" · ")
    } else if matches!(n, "git_log" | "git_diff" | "git_status" | "git_commit" | "git_push") {
        pick(&["args", "message", "scope"])
    } else if matches!(n, "memory_recall" | "memory_search") {
        pick(&["query"])
    } else if matches!(n, "tsc_check" | "vitest_run" | "npm_run") {
        pick(&["args", "script", "command"])
    } else if n == "process" {
        pick(&["name", "command"])
    } else {
        String::new()
    };

    // 截断到工具行友好长度 (**保留头尾关键信息**)
    let s = summary.trim();
    if s.is_empty() {
        return String::new();
    }
    let cs: Vec<char> = s.chars().collect();
    if cs.len() > 56 {
        let head: String = cs[..48].iter().collect();
        let tail: String = cs[cs.len() - 6..].iter().collect();
        format!("{head}…{tail}")
    } else {
        s.to_string()
    }
}

/// JS `String(value)` 的口径: 字符串原样 / 数字·布尔转文本 / 对象 → `[object Object]`
fn json_to_js_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        _ => "[object Object]".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn describes_known_tools() {
        assert_eq!(describe_tool_call("git_status"), "查看 git 状态");
        assert_eq!(describe_tool_call("terminal"), "跑命令");
        assert_eq!(describe_tool_call("read_skill"), "📚 读技能");
        assert_eq!(describe_tool_call("wallet_balance"), "链上/钱包操作"); // 前缀
        assert_eq!(describe_tool_call("TODO_list"), "理计划/待办"); // 忽略大小写前缀
    }

    #[test]
    fn unknown_tool_is_empty() {
        assert_eq!(describe_tool_call(""), "");
        assert_eq!(describe_tool_call("   "), "");
        assert_eq!(describe_tool_call("some_unknown_thing"), "");
    }

    /// 认不出就用工具名本身, 绝不显示空白
    #[test]
    fn trace_label_never_blank() {
        assert_eq!(trace_label("some_unknown_thing"), "some_unknown_thing");
        assert_eq!(trace_label("git_status"), "查看 git 状态 · git_status");
    }

    #[test]
    fn args_summary_picks_human_fields() {
        assert_eq!(
            tool_args_summary("terminal", Some(&json!({"command": "npx vitest run"}))),
            "npx vitest run"
        );
        assert_eq!(
            tool_args_summary("read_file", Some(&json!({"path": "src/index.ts"}))),
            "src/index.ts"
        );
        assert_eq!(
            tool_args_summary("grep_files", Some(&json!({"pattern": "foo", "path": "src"}))),
            "foo · src"
        );
    }

    #[test]
    fn args_summary_skips_null_and_string_form() {
        assert_eq!(tool_args_summary("terminal", Some(&json!({"command": null}))), "");
        // string 形态不解析 (TS 同口径)
        assert_eq!(tool_args_summary("terminal", Some(&json!("raw string"))), "");
        assert_eq!(tool_args_summary("terminal", None), "");
    }

    /// 超长摘要保留头尾 (56 字上限: 前 48 + `…` + 后 6)
    #[test]
    fn args_summary_keeps_head_and_tail() {
        let long = "x".repeat(80);
        let s = tool_args_summary("terminal", Some(&json!({"command": long})));
        assert_eq!(s.chars().count(), 48 + 1 + 6);
        assert_eq!(&s[..48], "x".repeat(48).as_str());
        assert_eq!(s.chars().nth(48), Some('…'));
        assert_eq!(&s[s.len() - 6..], "xxxxxx");
    }
}
