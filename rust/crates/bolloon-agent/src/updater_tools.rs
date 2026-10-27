//! updater_tools.rs — 更新检查（`check_update`）
//!
//! 复用 `updater` 模块的 `UpdateSource` 端口 + `check`：真实现经 HTTP 拉取远端版本号,
//! 与 `CURRENT_VERSION` 比较。缺配置（`BOLLOON_UPDATE_URL`）⇒ `config_required`（**诚实**, 非 unwired）。
//!
//! 注意: 本工具**只检查**, 不下载/安装（`UpdateSource::download` 返回未实现）——安装是独立流程。
//! Network effect, 只读 ⇒ `default_allowed: true`。

use async_trait::async_trait;
use bolloon_harness::{EffectKind, ToolCall, ToolDef, ToolExecutor, ToolResult};
use crate::tool_contract::{ErrorCode, error_evidence};
use crate::updater::{UpdateInfo, UpdateSource};

/// 从任意响应体里抠出第一个 `v?x.y.z`
fn extract_version(s: &str) -> Option<String> {
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        // 允许前置 v
        let start = if bytes[i] == 'v' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            i + 1
        } else {
            i
        };
        if start < bytes.len()
            && bytes[start].is_ascii_digit()
            && start + 1 < bytes.len()
            && bytes[start + 1] == '.'
        {
            // 找到起始数字, 向后吃到非 [digit or .]
            let mut j = start;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == '.') {
                j += 1;
            }
            let tok: String = bytes[start..j].iter().collect();
            if tok.matches('.').count() == 2 {
                return Some(tok);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    None
}

struct HttpUpdateSource {
    url: String,
}

impl UpdateSource for HttpUpdateSource {
    fn latest_version(&self) -> Result<String, String> {
        let body = ureq::get(&self.url)
            .call()
            .map_err(|e| format!("拉取版本失败: {e}"))?
            .into_string()
            .map_err(|e| format!("读取响应失败: {e}"))?;
        extract_version(&body).ok_or_else(|| "响应里找不到 x.y.z 版本号".into())
    }
    fn download(&self) -> Result<Vec<u8>, String> {
        Err("check_update 工具只检查, 不下载安装".into())
    }
}

async fn do_check_update(_call: ToolCall) -> ToolResult {
    let url = match std::env::var("BOLLOON_UPDATE_URL") {
        Ok(u) if !u.trim().is_empty() => u,
        _ => {
            return ToolResult {
                ok: false,
                output: "check_update 未配置更新源: 设置 BOLLOON_UPDATE_URL（返回 x.y.z 版本号）后可用".into(),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, "缺少更新源配置")),
            }
        }
    };
    let src = HttpUpdateSource { url };
    let info: UpdateInfo = crate::updater::check(&src);
    let output = if info.update_available {
        format!(
            "有新版本: 当前 {} → 最新 {}{}",
            info.current,
            info.latest,
            info.notes
                .as_ref()
                .map(|n| format!("\n说明: {n}"))
                .unwrap_or_default()
        )
    } else if info.status == "ok" {
        format!("已是最新 ({}), 无可用更新", info.current)
    } else {
        format!("更新检查失败 ({}): {}", info.status, info.current)
    };
    ToolResult {
        ok: true,
        output,
        elapsed_ms: 0,
        verified: Some(true),
        evidence: Some(serde_json::json!({
            "current": info.current,
            "latest": info.latest,
            "update_available": info.update_available,
            "status": info.status,
        })),
    }
}

pub struct UpdaterExecutor;

#[async_trait]
impl ToolExecutor for UpdaterExecutor {
    async fn execute(&self, call: ToolCall) -> ToolResult {
        match call.name.as_str() {
            "check_update" => do_check_update(call).await,
            other => ToolResult {
                ok: false,
                output: format!("更新族没有 `{other}`（不许冒充成功）"),
                elapsed_ms: 0,
                verified: Some(false),
                evidence: Some(error_evidence(ErrorCode::Unwired, other)),
            },
        }
    }
}

pub fn updater_tool_defs() -> Vec<ToolDef> {
    vec![ToolDef {
        name: "check_update".into(),
        description: "检查是否有新版本（需配置 BOLLOON_UPDATE_URL, 返回 x.y.z 版本号）。只读网络检查。".into(),
        parameters: serde_json::json!({
            "type": "object", "properties": {}, "additionalProperties": false
        }),
        effect: EffectKind::Network,
        default_allowed: true,
    }]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::CURRENT_VERSION; // 只在本测试模块用 → 测试级 import, 不污染主引用
    use bolloon_harness::ToolExecutor;

    fn call(name: &str) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: serde_json::json!({}) }
    }

    #[test]
    fn extract_version_finds_semver() {
        assert_eq!(extract_version("{\"version\":\"0.6.11\"}"), Some("0.6.11".into()));
        assert_eq!(extract_version("latest v0.7.0 released"), Some("0.7.0".into()));
        assert_eq!(extract_version("no version here"), None);
    }

    #[tokio::test]
    async fn check_update_requires_config() {
        unsafe { std::env::remove_var("BOLLOON_UPDATE_URL") };
        let r = UpdaterExecutor.execute(call("check_update")).await;
        assert!(!r.ok);
        assert_eq!(r.evidence.as_ref().unwrap()["error"]["code"], "unwired");
    }

    #[test]
    fn current_version_known() {
        assert!(CURRENT_VERSION.contains('.'), "CURRENT_VERSION 应形如 x.y.z");
    }
}
