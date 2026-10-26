//! tool_contract.rs — 统一工具契约：结果 / 错误码 / 重试语义
//!
//! 迁移顺序第 3 步（2026-10-26）: 补齐「模型 ⇄ 执行器」契约。
//!   已就位: `ToolDef` / `ToolSchema`（含桥接）/ 真实执行器 / 调用 ID（tool_call_id 回传）/ 续轮。
//!   **本文件补齐: 结果错误格式** —— 此前失败只有人话文本，调用方无法判断
//!   该重试、改参数、重规划还是放弃（决策 3 要求「按错误类型决定恢复动作」）。
//!
//! 纪律:
//!   · 错误码是**给机器分类用的**，output 文本仍写人话（给模型看）；两者并存，不互相替代。
//!   · `retryable` 只表示「这个错误类型本身允许重试」，**不等于**自动重试 ——
//!     写/支付类即便 Timeout 也不许盲目重试（决策 3: 副作用操作超时先查实际状态）。
//!   · 无法验证的结果不许报成功：失败一律 `verified: Some(false)`。

use serde_json::Value;

/// 工具错误码（机器可读；与 TS `error-classifier` 的 severity 思路对应，但这里是分类不是严重度）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    /// 参数缺失/类型不对 —— 重试同样的参数没用，得改参数
    InvalidArgument,
    /// 目标不存在（工具未注册 / 文件不存在）
    NotFound,
    /// 未授权（高风险工具没被授予）
    PermissionDenied,
    /// 安全门拒绝（denylist / 白名单 / 路径）—— 重试也没用，且不该绕过
    Denied,
    /// 命令本身失败（非零退出）
    CommandFailed,
    /// 超时 —— **类型上**可重试（是否真重试看是否幂等/只读）
    Timeout,
    /// 用户取消 —— 不重试
    Cancelled,
    /// 已注册但没有接执行器（迁移未完成）—— 不重试，是工程缺口
    Unwired,
    /// 执行器内部错误（spawn 失败等）
    Internal,
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::InvalidArgument => "invalid_argument",
            ErrorCode::NotFound => "not_found",
            ErrorCode::PermissionDenied => "permission_denied",
            ErrorCode::Denied => "denied",
            ErrorCode::CommandFailed => "command_failed",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Unwired => "unwired",
            ErrorCode::Internal => "internal",
        }
    }

    /// 这个错误类型**是否允许**重试（≠ 自动重试；写类/支付类仍不许盲目重试）
    pub fn retryable(&self) -> bool {
        matches!(self, ErrorCode::Timeout)
    }
}

/// 把结构化错误挂进 evidence（保留原有字段，只追加 `error` 段）
pub fn with_error(mut ev: Value, code: ErrorCode, message: &str) -> Value {
    if let Some(obj) = ev.as_object_mut() {
        obj.insert(
            "error".into(),
            serde_json::json!({
                "code": code.as_str(),
                "retryable": code.retryable(),
                "message": message,
            }),
        );
    }
    ev
}

/// 只含错误的 evidence（简单失败路径用）
pub fn error_evidence(code: ErrorCode, message: &str) -> Value {
    with_error(serde_json::json!({}), code, message)
}

/// 从 evidence 里读出人类可读的 `[code] message`（工具行/日志展示用）
pub fn format_error(ev: Option<&Value>) -> Option<String> {
    let e = ev?.get("error")?;
    let code = e.get("code").and_then(|v| v.as_str()).unwrap_or("unknown");
    let msg = e.get("message").and_then(|v| v.as_str()).unwrap_or("");
    Some(format!("[{code}] {msg}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_timeout_is_retryable_by_type() {
        assert!(ErrorCode::Timeout.retryable());
        // 其余一律不重试（改参数 / 改命令 / 是安全门 / 被取消 / 工程缺口）
        for c in [
            ErrorCode::InvalidArgument,
            ErrorCode::NotFound,
            ErrorCode::PermissionDenied,
            ErrorCode::Denied,
            ErrorCode::CommandFailed,
            ErrorCode::Cancelled,
            ErrorCode::Unwired,
            ErrorCode::Internal,
        ] {
            assert!(!c.retryable(), "{:?} 不该被判可重试", c);
        }
    }

    #[test]
    fn with_error_keeps_existing_fields() {
        let ev = with_error(
            serde_json::json!({ "path": "a.txt", "bytes": 3 }),
            ErrorCode::NotFound,
            "没这个文件",
        );
        assert_eq!(ev["path"], "a.txt");
        assert_eq!(ev["error"]["code"], "not_found");
        assert_eq!(ev["error"]["retryable"], false);
    }

    #[test]
    fn format_error_renders_code_and_message() {
        let ev = error_evidence(ErrorCode::Denied, "命中高危规则");
        assert_eq!(
            format_error(Some(&ev)).unwrap_or_default(),
            "[denied] 命中高危规则"
        );
        assert!(format_error(None).is_none());
    }
}
