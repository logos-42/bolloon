//! LSP (Language Server Protocol) 桥 — 状态机 + 帧形状 (Content-Length 分帧)
//!
//! 对齐 TS 版 `lsp/`:
//! - 状态机: 未 initialize 拒一切请求 (除了 initialize 本身)
//! - 分帧: `Content-Length: N\r\n\r\n{json}` (粘包/半包如实报错)
//! - didOpen/didChange/didClose 文档簿

use std::collections::HashMap;

/// LSP 错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum LspError {
    #[error("未 initialize (先 initialize 再发请求)")]
    NotInitialized,
    #[error("分帧错误: {0}")]
    BadFrame(String),
    #[error("JSON-RPC 形状不对: {0}")]
    BadMessage(String),
}

/// LSP 会话状态机
#[derive(Debug, Default)]
pub struct LspSession {
    initialized: bool,
    /// 文档簿: uri → 当前文本
    documents: HashMap<String, String>,
    next_id: u64,
}

impl LspSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// 构造 initialize 请求
    pub fn initialize_request(&mut self, root_uri: &str) -> (u64, String) {
        self.next_id += 1;
        let id = self.next_id;
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": root_uri,
                "capabilities": {},
            }
        });
        (id, frame_message(&msg))
    }

    /// 收到 initialize 响应 → 迁移
    pub fn on_initialized(&mut self) {
        self.initialized = true;
    }

    /// didOpen (登记文档)
    pub fn did_open(&mut self, uri: &str, text: &str) -> Result<String, LspError> {
        if !self.initialized {
            return Err(LspError::NotInitialized);
        }
        self.documents.insert(uri.into(), text.into());
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": { "textDocument": { "uri": uri, "text": text } },
        });
        Ok(frame_message(&msg))
    }

    /// didChange (全量同步语义: 直接替换文本)
    pub fn did_change(&mut self, uri: &str, new_text: &str) -> Result<String, LspError> {
        if !self.initialized {
            return Err(LspError::NotInitialized);
        }
        if !self.documents.contains_key(uri) {
            return Err(LspError::BadMessage(format!("didChange 前没 didOpen: {uri}")));
        }
        self.documents.insert(uri.into(), new_text.into());
        let msg = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": { "textDocument": { "uri": uri }, "contentChanges": [{ "text": new_text }] },
        });
        Ok(frame_message(&msg))
    }

    pub fn document_text(&self, uri: &str) -> Option<&str> {
        self.documents.get(uri).map(|s| s.as_str())
    }

    pub fn is_initialized(&self) -> bool {
        self.initialized
    }
}

/// 帧封装: `Content-Length: N\r\n\r\n{json}`
pub fn frame_message(msg: &serde_json::Value) -> String {
    let body = serde_json::to_string(msg).unwrap_or_default();
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body)
}

/// 帧解析 (支持粘包; 半包如实报错)
pub fn parse_frames(buf: &str) -> Result<Vec<serde_json::Value>, LspError> {
    let mut out = Vec::new();
    let mut rest = buf;
    while !rest.is_empty() {
        let Some(header_end) = rest.find("\r\n\r\n") else {
            if out.is_empty() {
                return Err(LspError::BadFrame("缺 \\r\\n\\r\\n 分隔 (半包)".into()));
            }
            break; // 尾部残包: 已解析的返回, 剩余丢弃 (调用方续包)
        };
        let header = &rest[..header_end];
        let content_length = header
            .lines()
            .find_map(|l| l.strip_prefix("Content-Length: "))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .ok_or_else(|| LspError::BadFrame(format!("Content-Length 头缺失: {header:?}")))?;
        let body_start = header_end + 4;
        if rest.len() < body_start + content_length {
            if out.is_empty() {
                return Err(LspError::BadFrame(format!(
                    "体不完整 (要 {content_length}, 只有 {})",
                    rest.len().saturating_sub(body_start)
                )));
            }
            break;
        }
        let body = &rest[body_start..body_start + content_length];
        let msg: serde_json::Value = serde_json::from_str(body)
            .map_err(|e| LspError::BadMessage(format!("体非 JSON: {e}")))?;
        out.push(msg);
        rest = &rest[body_start + content_length..];
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_roundtrip_with_sticky_packets() {
        let mut s = LspSession::new();
        let (id, framed) = s.initialize_request("file:///proj");
        assert!(framed.starts_with("Content-Length: "), "LSP 分帧头");
        let frames = parse_frames(&framed).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["id"], id);
        // 粘包: 两帧一次解析
        let (_, f2) = s.initialize_request("file:///p2");
        let sticky = format!("{framed}{f2}");
        let frames = parse_frames(&sticky).unwrap();
        assert_eq!(frames.len(), 2, "粘包全解出");
    }

    #[test]
    fn half_packet_reported_not_guessed() {
        let mut s = LspSession::new();
        let (_, framed) = s.initialize_request("file:///p");
        let cut = &framed[..framed.len() / 2];
        assert!(matches!(parse_frames(cut), Err(LspError::BadFrame(_))), "半包如实报错");
    }

    #[test]
    fn protocol_gate_before_initialize() {
        let mut s = LspSession::new();
        assert_eq!(s.did_open("file:///a.rs", "fn main(){}").unwrap_err(), LspError::NotInitialized);
        s.on_initialized();
        assert!(s.did_open("file:///a.rs", "fn main(){}").is_ok());
    }

    #[test]
    fn document_lifecycle_open_change() {
        let mut s = LspSession::new();
        s.on_initialized();
        s.did_open("file:///a.rs", "v1").unwrap();
        assert_eq!(s.document_text("file:///a.rs"), Some("v1"));
        s.did_change("file:///a.rs", "v2").unwrap();
        assert_eq!(s.document_text("file:///a.rs"), Some("v2"));
        // 没 open 就 change → 拒
        assert!(matches!(
            s.did_change("file:///b.rs", "x"),
            Err(LspError::BadMessage(_))
        ));
    }
}
