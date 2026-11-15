//! 插件执行工具（2026-11-15）—— 把插件栏里的插件接进**真实工具执行链**。
//!
//! 模型可调用 `run_plugin { name, lang?, timeout_ms? }`：
//! - **方法型插件**（body 是做法/提示词/Markdown）：直接返回正文，模型照着做（不执行代码）；
//! - **脚本型插件**：显式传 `lang`（或插件 body 的 frontmatter 写 `lang: python3`）时，
//!   走 `ScriptRunPort`（写文件 → spawn 解释器，**不经过 shell 拼接**）真实执行。
//!
//! 安全（fail-closed）：
//! - `EffectKind::Scratch` + `default_allowed: false` ⇒ 默认不授予，只有「完全访问」或显式授权才放行；
//! - 解释器白名单 `sh | bash | python3 | node`；超时上限 120s；
//! - 运行痕迹落在 `~/.bolloon/rust/scratch/<run_id>/`，`evidence` 回传 plugin/run_id/exit/run_dir；
//! - 插件来源不可信（导入无签名），所以**绝不把 body 拼进 shell 命令串**，也绝不默认按 `sh` 猜。

use async_trait::async_trait;
use serde_json::json;

use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};

use crate::home::BolloonHome;
use crate::scratch::{ScriptRunPort, ScriptRunRequest, new_run_id};

const ALLOWED_LANGS: &[&str] = &["sh", "bash", "python3", "node"];
const MAX_TIMEOUT_MS: u64 = 120_000;

pub struct PluginExecutor {
    pub port: ScriptRunPort,
}

impl PluginExecutor {
    pub fn new(port: ScriptRunPort) -> Self {
        Self { port }
    }
}

fn fail(msg: &str) -> ToolResult {
    ToolResult {
        ok: false,
        output: msg.to_string(),
        elapsed_ms: 0,
        verified: Some(false),
        evidence: None,
    }
}

/// 从 `~/.bolloon/rust/skills.json` 按名字取插件正文（与插件栏同一份真源）。
fn load_plugin(name: &str) -> Option<(String, String, String)> {
    let path = BolloonHome::resolve().root().join("skills.json");
    let raw = std::fs::read_to_string(path).ok()?;
    let arr: Vec<serde_json::Value> = serde_json::from_str(&raw).ok()?;
    for v in arr {
        if v.get("name").and_then(|x| x.as_str()) == Some(name) {
            let body = v
                .get("body")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let desc = v
                .get("description")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let origin = v
                .get("origin")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            return Some((body, origin, desc));
        }
    }
    None
}

/// 插件 body 的 frontmatter `lang:`（只认显式声明，不从普通代码围栏猜）。
fn body_lang(body: &str) -> Option<String> {
    for line in body.lines().take(12) {
        let t = line.trim().trim_start_matches('-').trim();
        if let Some(rest) = t
            .strip_prefix("lang:")
            .or_else(|| t.strip_prefix("language:"))
        {
            let v = rest.trim().trim_matches('"').trim_matches('\'').to_string();
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

#[async_trait]
impl ToolExecutor for PluginExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let name = call
            .arguments
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            return fail("缺少插件名 name");
        }
        let (body, origin, desc) = match load_plugin(&name) {
            Some(x) => x,
            None => return fail(&format!("没有名为「{name}」的插件（先到插件栏创建/导入）")),
        };

        let lang = call
            .arguments
            .get("lang")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| body_lang(&body));

        let lang = match lang {
            None => {
                // 方法型：把正文交给模型照做（明确标注是"方法"，不是执行结果）
                let mut out = format!("插件「{name}」（来源 {origin}，方法型）\n");
                if !desc.is_empty() {
                    out.push_str(&format!("说明：{desc}\n\n"));
                }
                out.push_str(&body);
                return ToolResult {
                    ok: true,
                    output: out,
                    elapsed_ms: 0,
                    verified: Some(true),
                    evidence: Some(json!({ "plugin": name, "mode": "method", "origin": origin })),
                };
            }
            Some(l) => l,
        };

        if !ALLOWED_LANGS.contains(&lang.as_str()) {
            return fail(&format!(
                "不支持的脚本语言「{lang}」（仅 sh / bash / python3 / node）"
            ));
        }

        let timeout_ms = call
            .arguments
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(60_000)
            .min(MAX_TIMEOUT_MS);

        let run_id = new_run_id();
        let scratch = BolloonHome::resolve().scratch_dir();
        let run_dir = scratch.join(&run_id);
        let _ = std::fs::create_dir_all(&run_dir);
        let req = ScriptRunRequest {
            run_id: run_id.clone(),
            lang,
            code: body,
            run_dir: run_dir.to_string_lossy().into_owned(),
            timeout_ms,
        };

        match self.port.run(req).await {
            Ok(r) => {
                let mut out = String::new();
                if let Some(c) = r.exit_code {
                    out.push_str(&format!("exit={c}\n"));
                } else {
                    out.push_str("exit=<signal>\n");
                }
                out.push_str(&r.stdout);
                if !r.stderr.trim().is_empty() {
                    out.push_str(&format!("\n[stderr]\n{}", r.stderr));
                }
                if r.killed {
                    out.push_str("\n[超时被杀]");
                }
                ToolResult {
                    ok: true,
                    output: out,
                    elapsed_ms: r.elapsed_ms,
                    verified: Some(r.exit_code == Some(0)),
                    evidence: Some(json!({
                        "plugin": name,
                        "mode": "script",
                        "run_id": run_id,
                        "exit": r.exit_code,
                        "run_dir": run_dir.to_string_lossy(),
                    })),
                }
            }
            Err(e) => ToolResult {
                ok: false,
                output: format!("插件脚本运行失败: {e}"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(
                    json!({ "plugin": name, "run_id": run_id, "error": format!("{e}") }),
                ),
            },
        }
    }
}

pub fn plugin_tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "run_plugin".into(),
        description: "运行/应用一个已安装的插件（智能体自己生成或导入的）。\
            方法型插件直接返回正文供你照做；脚本型插件在传 lang(或 body 顶部 lang: xxx) 时\
            在内部 scratch 目录真实执行脚本。受权限门控（默认不放开，需完全访问或显式授权）。"
            .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "name": { "type": "string", "description": "插件名" },
                "lang": { "type": "string", "description": "可选：脚本解释器 sh | bash | python3 | node；不填则按插件 frontmatter 的 lang，仍然没有就按方法文本返回" },
                "timeout_ms": { "type": "integer", "description": "超时毫秒（默认 60000，上限 120000）" }
            },
            "required": ["name"],
            "additionalProperties": false
        }),
        effect: EffectKind::Scratch,
        default_allowed: false,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn body_lang_reads_frontmatter() {
        assert_eq!(
            body_lang("---\nlang: python3\n---\nprint(1)").as_deref(),
            Some("python3")
        );
        assert_eq!(
            body_lang("lang: node\nconsole.log(1)").as_deref(),
            Some("node")
        );
        // 普通代码围栏不当作 lang
        assert_eq!(body_lang("```python\nprint(1)\n```"), None);
        assert_eq!(body_lang("这是方法文本"), None);
    }

    #[test]
    fn tool_def_is_fail_closed() {
        let d = &plugin_tool_defs()[0];
        assert_eq!(d.name, "run_plugin");
        assert_eq!(d.effect, EffectKind::Scratch);
        assert!(!d.default_allowed);
    }
}
