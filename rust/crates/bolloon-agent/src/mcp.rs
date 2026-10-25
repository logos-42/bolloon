//! MCP (Model Context Protocol) 桥 — JSON-RPC 形状的纯函数核心
//!
//! 对齐 TS 版 `pi-ecosystem-mcp/`:
//! - 协议序: initialize → notifications/initialized → tools/list → tools/call
//! - 请求/响应/通知三种信封 (jsonrpc 2.0)
//! - 状态机: 未 initialize 就 tools/list → 拒 (对齐 TS 的 initialized 门)
//! - stdio 传输由调用方注入; 这里只做协议帧构造/解析/校验 (可测)

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// JSON-RPC 版本 (冻结)
pub const JSONRPC_VERSION: &str = "2.0";

/// MCP 协议错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum McpError {
    #[error("未 initialize (协议序: initialize → initialized → tools/*)")]
    NotInitialized,
    #[error("方法不支持: {0}")]
    UnknownMethod(String),
    #[error("JSON-RPC 帧形状不对: {0}")]
    BadFrame(String),
    #[error("工具不存在: {0}")]
    ToolNotFound(String),
}

/// 工具定义 (MCP tools/list 项)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolDef {
    pub name: String,
    pub description: String,
    /// JSON Schema (透传)
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

/// 协议状态机
#[derive(Debug, Default)]
pub struct McpSessionState {
    initialized: bool,
    tools: HashMap<String, McpToolDef>,
}

impl McpSessionState {
    pub fn new() -> Self {
        Self::default()
    }

    /// 构造 initialize 请求
    pub fn initialize_request(id: u64, client_name: &str, client_version: &str) -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "clientInfo": { "name": client_name, "version": client_version },
            }
        })
    }

    /// 构造 initialized 通知 (无 id = notification)
    pub fn initialized_notification() -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": JSONRPC_VERSION,
            "method": "notifications/initialized",
        })
    }

    /// 处理 initialize 响应 → 状态迁移
    pub fn on_initialized(&mut self) {
        self.initialized = true;
    }

    /// 注册工具 (tools/list 响应落地)
    pub fn register_tools(&mut self, tools: Vec<McpToolDef>) -> Result<(), McpError> {
        if !self.initialized {
            return Err(McpError::NotInitialized);
        }
        for t in tools {
            self.tools.insert(t.name.clone(), t);
        }
        Ok(())
    }

    /// 构造 tools/list 请求 (协议序门: 未 initialize 拒)
    pub fn list_tools_request(&self, id: u64) -> Result<serde_json::Value, McpError> {
        if !self.initialized {
            return Err(McpError::NotInitialized);
        }
        Ok(serde_json::json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "method": "tools/list",
        }))
    }

    /// 构造 tools/call 请求
    pub fn call_tool_request(&self, id: u64, tool: &str, args: serde_json::Value) -> Result<serde_json::Value, McpError> {
        if !self.initialized {
            return Err(McpError::NotInitialized);
        }
        if !self.tools.contains_key(tool) {
            return Err(McpError::ToolNotFound(tool.into()));
        }
        Ok(serde_json::json!({
            "jsonrpc": JSONRPC_VERSION,
            "id": id,
            "method": "tools/call",
            "params": { "name": tool, "arguments": args },
        }))
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    pub fn tool_count(&self) -> usize {
        self.tools.len()
    }
}

/// 解析入站帧 (响应或通知)
#[derive(Debug, Clone, PartialEq)]
pub enum InboundFrame {
    /// 带 id 的响应
    Response { id: u64, result: serde_json::Value },
    /// 带错误码的响应
    ErrorResponse { id: Option<u64>, code: i64, message: String },
    /// 无 id 的通知
    Notification { method: String, params: serde_json::Value },
}

/// 解析 JSON-RPC 帧 (形状不对如实报错)
pub fn parse_frame(raw: &str) -> Result<InboundFrame, McpError> {
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| McpError::BadFrame(format!("非 JSON: {e}")))?;
    if v["jsonrpc"].as_str() != Some(JSONRPC_VERSION) {
        return Err(McpError::BadFrame("jsonrpc 字段缺失或不是 2.0".into()));
    }
    let method = v["method"].as_str().map(|s| s.to_string());
    let id = v["id"].as_u64();
    match (id, method) {
        (Some(id), None) => {
            if let Some(err) = v["error"].as_object() {
                Ok(InboundFrame::ErrorResponse {
                    id: Some(id),
                    code: err.get("code").and_then(|c| c.as_i64()).unwrap_or(-32603),
                    message: err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
            } else {
                Ok(InboundFrame::Response { id, result: v["result"].clone() })
            }
        }
        (None, Some(m)) => Ok(InboundFrame::Notification {
            method: m,
            params: v["params"].clone(),
        }),
        (Some(_), Some(m)) => Err(McpError::BadFrame(format!("响应帧不该带 method: {m}"))),
        (None, None) => Err(McpError::BadFrame("帧既无 id 也无 method".into())),
    }
}

/// 服务端侧: 响应帧构造
pub fn response_frame(id: u64, result: serde_json::Value) -> serde_json::Value {
    serde_json::json!({ "jsonrpc": JSONRPC_VERSION, "id": id, "result": result })
}

/// 服务端侧: 错误帧构造
pub fn error_frame(id: Option<u64>, code: i64, message: &str) -> serde_json::Value {
    let mut f = serde_json::json!({ "jsonrpc": JSONRPC_VERSION, "error": { "code": code, "message": message } });
    if let Some(id) = id {
        f["id"] = serde_json::json!(id);
    }
    f
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_sequence_enforced() {
        let mut s = McpSessionState::new();
        assert_eq!(s.list_tools_request(1).unwrap_err(), McpError::NotInitialized, "未 initialize 就 tools/list 拒");
        s.on_initialized();
        assert!(s.list_tools_request(1).is_ok());
    }

    #[test]
    fn initialize_frames_shape() {
        let req = McpSessionState::initialize_request(1, "bolloon", "0.6.10");
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["method"], "initialize");
        assert_eq!(req["params"]["clientInfo"]["name"], "bolloon");
        let note = McpSessionState::initialized_notification();
        assert!(note.get("id").is_none(), "通知无 id");
    }

    #[test]
    fn tools_register_only_after_init() {
        let mut s = McpSessionState::new();
        let tool = McpToolDef {
            name: "read_file".into(),
            description: "读文件".into(),
            input_schema: serde_json::json!({"type": "object"}),
        };
        assert_eq!(s.register_tools(vec![tool.clone()]).unwrap_err(), McpError::NotInitialized);
        s.on_initialized();
        assert!(s.register_tools(vec![tool]).is_ok());
        assert_eq!(s.tool_count(), 1);
    }

    #[test]
    fn call_unknown_tool_rejected() {
        let mut s = McpSessionState::new();
        s.on_initialized();
        assert_eq!(s.call_tool_request(1, "ghost", serde_json::json!({})).unwrap_err(), McpError::ToolNotFound("ghost".into()));
    }

    #[test]
    fn frame_parse_response_notification_error() {
        let resp = parse_frame(r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(resp, InboundFrame::Response { id: 7, result: serde_json::json!({"tools": []}) });

        let note = parse_frame(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#).unwrap();
        assert_eq!(
            note,
            InboundFrame::Notification { method: "notifications/initialized".into(), params: serde_json::Value::Null }
        );

        let err = parse_frame(r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"no such tool"}}"#).unwrap();
        assert_eq!(
            err,
            InboundFrame::ErrorResponse { id: Some(3), code: -32601, message: "no such tool".into() }
        );
    }

    #[test]
    fn frame_parse_bad_shapes_reported() {
        assert!(matches!(parse_frame("不是json"), Err(McpError::BadFrame(_))));
        assert!(matches!(parse_frame(r#"{"id":1}"#), Err(McpError::BadFrame(_))), "缺 jsonrpc 字段拒");
        assert!(matches!(parse_frame(r#"{"jsonrpc":"2.0"}"#), Err(McpError::BadFrame(_))), "既无 id 也无 method 拒");
    }

    #[test]
    fn server_frames_roundtrip() {
        let f = response_frame(5, serde_json::json!({"ok": true}));
        match parse_frame(&serde_json::to_string(&f).unwrap()).unwrap() {
            InboundFrame::Response { id, result } => {
                assert_eq!(id, 5);
                assert_eq!(result["ok"], true);
            }
            other => panic!("应为 Response, 实得 {other:?}"),
        }
        let ef = error_frame(Some(6), -32601, "bad");
        match parse_frame(&serde_json::to_string(&ef).unwrap()).unwrap() {
            InboundFrame::ErrorResponse { id, code, .. } => {
                assert_eq!(id, Some(6));
                assert_eq!(code, -32601);
            }
            other => panic!("应为 ErrorResponse, 实得 {other:?}"),
        }
    }
}
