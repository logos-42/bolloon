//! scratch 工具: agent 侧入口 (`run_scratch_script`), 把脚本派发到 `ScriptRunPort`。
//!
//! 权限: `EffectKind::Scratch`, `default_allowed=false` —— 未显式授权或完全访问下不放行
//! (与 `shell` 同级的 fail-closed)。

use async_trait::async_trait;
use serde_json::json;

use bolloon_harness::{EffectKind, ToolCall, ToolExecutor, ToolResult, ToolDef};

use crate::home::BolloonHome;
use crate::scratch::{ScriptRunPort, ScriptRunRequest};

pub struct ScratchExecutor {
    pub port: ScriptRunPort,
}

impl ScratchExecutor {
    pub fn new(port: ScriptRunPort) -> Self {
        Self { port }
    }
}

#[async_trait]
impl ToolExecutor for ScratchExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        let code = call
            .arguments
            .get("code")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let lang = call
            .arguments
            .get("lang")
            .and_then(|v| v.as_str())
            .unwrap_or("sh")
            .to_string();
        let timeout_ms = call
            .arguments
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(60_000);

        if code.trim().is_empty() {
            return ToolResult {
                ok: false,
                output: "code 为空".into(),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: None,
            };
        }

        let run_id = crate::scratch::new_run_id();
        let scratch = BolloonHome::resolve().scratch_dir();
        let _ = std::fs::create_dir_all(&scratch);
        let run_dir = scratch.join(&run_id);
        let req = ScriptRunRequest {
            run_id: run_id.clone(),
            lang,
            code,
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
                    verified: Some(true),
                    evidence: Some(json!({
                        "run_id": run_id,
                        "exit": r.exit_code,
                        "run_dir": run_dir.to_string_lossy()
                    })),
                }
            }
            Err(e) => ToolResult {
                ok: false,
                output: format!("运行失败: {e}"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(json!({ "error": format!("{e}"), "run_id": run_id })),
            },
        }
    }
}

pub fn scratch_tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "run_scratch_script".into(),
        description: "在内部 scratch 目录(~/.bolloon/rust/scratch)跑一段临时脚本(sh/python3/node 等), \
            用于快速验证/原型; 运行痕迹落盘且可被孤儿恢复 catch。受权限门控(默认不放开)。"
            .into(),
        parameters: json!({
            "type": "object",
            "properties": {
                "code": { "type": "string", "description": "要执行的脚本源码" },
                "lang": { "type": "string", "description": "解释器: sh(默认) | bash | python3 | node", "default": "sh" },
                "timeout_ms": { "type": "integer", "description": "超时毫秒(默认 60000)" }
            },
            "required": ["code"],
            "additionalProperties": false
        }),
        effect: EffectKind::Scratch,
        default_allowed: false,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratch::TokioScriptRunner;
    use std::sync::Arc;

    #[tokio::test]
    async fn scratch_tool_runs_through_port() {
        let exec = ScratchExecutor::new(ScriptRunPort::new(Arc::new(TokioScriptRunner::new())));
        let r = exec
            .execute(ToolCall {
                id: "c1".into(),
                name: "run_scratch_script".into(),
                arguments: json!({ "code": "echo via-tool", "lang": "sh" }),
            })
            .await;
        assert!(r.ok, "{}", r.output);
        assert!(r.output.contains("via-tool"), "{}", r.output);
    }

    #[test]
    fn def_is_fail_closed() {
        let d = &scratch_tool_defs()[0];
        assert_eq!(d.name, "run_scratch_script");
        assert_eq!(d.effect, EffectKind::Scratch);
        assert!(!d.default_allowed);
    }
}
