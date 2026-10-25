//! 通信端口（send / broadcast / peers，未注入即拒）
//!
//! Kernel 不实现具体传输（libp2p/iroh/pubsub 在 p2p crate），只定义端口。
//! 未注入任何传输实现时，所有调用返回 NotInjected。

use async_trait::async_trait;

/// 对端信息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerInfo {
    pub peer_id: String,
    pub name: Option<String>,
    pub did: Option<String>,
    pub addrs: Vec<String>,
}

/// 传输层消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TransportMessage {
    pub to: Option<String>, // None = broadcast
    pub topic: Option<String>,
    pub payload: serde_json::Value,
    pub from: Option<String>,
}

/// Transport 端口（K8 Communication Runtime 收口的 Rust 面）
///
/// 设计约束（对应 TS 版 kernel/transport.ts 的「未注入即拒」）:
/// - 未注入实现 → send/broadcast/peers 全部返回 Err(NotInjected)
/// - 注入的实现由 p2p crate 提供（libp2p gossipsub / DIAP 后端）
#[async_trait]
pub trait Transport: Send + Sync {
    /// 点对点发送
    async fn send(&self, msg: TransportMessage) -> Result<(), TransportError>;
    /// 广播（群聊 / 主题）
    async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError>;
    /// 当前对端列表
    async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError>;
}

/// 传输端口错误
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error("transport 未注入（p2p 后端未启动）")]
    NotInjected,
    #[error("传输失败: {0}")]
    Io(String),
    #[error("目标对端不存在: {0}")]
    PeerNotFound(String),
}

/// 空实现：未注入即拒
pub struct NoopTransport;

#[async_trait]
impl Transport for NoopTransport {
    async fn send(&self, _msg: TransportMessage) -> Result<(), TransportError> {
        Err(TransportError::NotInjected)
    }
    async fn broadcast(&self, _msg: TransportMessage) -> Result<(), TransportError> {
        Err(TransportError::NotInjected)
    }
    async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
        Err(TransportError::NotInjected)
    }
}

/// TransportPort：给调用方的句柄（可注入/替换）
#[derive(Clone)]
pub struct TransportPort {
    inner: std::sync::Arc<dyn Transport>,
}

impl std::fmt::Debug for TransportPort {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransportPort")
            .field("inner", &"<dyn Transport>")
            .finish()
    }
}

impl TransportPort {
    pub fn new(t: std::sync::Arc<dyn Transport>) -> Self {
        Self { inner: t }
    }

    pub fn noop() -> Self {
        Self::new(std::sync::Arc::new(NoopTransport))
    }

    /// 替换实现（注入点）
    pub fn inject(&mut self, t: std::sync::Arc<dyn Transport>) {
        self.inner = t;
    }

    pub async fn send(&self, msg: TransportMessage) -> Result<(), TransportError> {
        self.inner.send(msg).await
    }

    pub async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError> {
        self.inner.broadcast(msg).await
    }

    pub async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
        self.inner.peers().await
    }
}

impl Default for TransportPort {
    fn default() -> Self {
        Self::noop()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn noop_rejects_everything() {
        let port = TransportPort::noop();
        let msg = TransportMessage {
            to: Some("peer1".into()),
            topic: None,
            payload: serde_json::json!({"hi": 1}),
            from: None,
        };
        assert!(port.send(msg.clone()).await.is_err());
        assert!(port.broadcast(msg.clone()).await.is_err());
        assert!(port.peers().await.is_err());
    }

    #[tokio::test]
    async fn injected_impl_works() {
        struct FakeTransport {
            peer: String,
        }
        #[async_trait]
        impl Transport for FakeTransport {
            async fn send(&self, msg: TransportMessage) -> Result<(), TransportError> {
                assert_eq!(msg.to.as_deref(), Some("peer1"));
                Ok(())
            }
            async fn broadcast(&self, _msg: TransportMessage) -> Result<(), TransportError> {
                Ok(())
            }
            async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
                Ok(vec![PeerInfo {
                    peer_id: self.peer.clone(),
                    name: None,
                    did: None,
                    addrs: vec![],
                }])
            }
        }

        let mut port = TransportPort::noop();
        port.inject(std::sync::Arc::new(FakeTransport {
            peer: "fake-1".into(),
        }));

        let msg = TransportMessage {
            to: Some("peer1".into()),
            topic: None,
            payload: serde_json::json!({}),
            from: None,
        };
        assert!(port.send(msg).await.is_ok());
        let peers = port.peers().await.unwrap();
        assert_eq!(peers[0].peer_id, "fake-1");
    }
}