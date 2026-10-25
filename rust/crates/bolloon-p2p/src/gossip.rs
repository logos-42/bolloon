//! Gossip 广播总线 — 去中心化协作传输 (kernel Transport 端口实现)
//!
//! 语义对齐 TS 版 p2p 群复制:
//! - 节点加入 hub 后互相可见 (peers)
//! - broadcast = 签名信封投递给所有其他节点
//! - 接收侧必须验签, 不过即丢 (拒伪造, 不静默降级为"收下")
//! - 去重: 同一 content_hash 的信封只投递一次 (seen 表)
//!
//! 这是进程内多节点 hub (单机可真验多智能体协作闭环);
//! 跨机接 iroh/libp2p 时替换同一 `Transport` 端口即可, kernel 不改。

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use bolloon_kernel::transport::{PeerInfo, Transport, TransportError, TransportMessage};

use crate::envelope::{SignedEnvelope, EnvelopeError};
use crate::identity::KeyPair;

/// hub 收到的已验签信封回调载体
#[derive(Debug, Clone)]
pub struct Delivered {
    pub envelope: SignedEnvelope,
}

/// 广播总线：多节点共享的投递中枢
pub struct GossipHub {
    nodes: Mutex<Vec<Arc<GossipNode>>>,
}

impl Default for GossipHub {
    fn default() -> Self {
        Self {
            nodes: Mutex::new(Vec::new()),
        }
    }
}

impl GossipHub {
    pub fn new() -> Self {
        Self::default()
    }

    /// 节点加入 hub
    pub async fn join(&self, node: Arc<GossipNode>) {
        self.nodes.lock().await.push(node);
    }

    /// 当前成员 (调试/测试)
    pub async fn member_count(&self) -> usize {
        self.nodes.lock().await.len()
    }
}

/// gossip 节点：一个身份 + 已收信封日志 + seen 去重
pub struct GossipNode {
    pub kp: KeyPair,
    pub peer_id: String,
    hub: Arc<GossipHub>,
    inbox: Mutex<Vec<Delivered>>,
    seen: Mutex<HashSet<String>>,
}

impl GossipNode {
    pub fn new(peer_id: impl Into<String>, kp: KeyPair, hub: Arc<GossipHub>) -> Arc<Self> {
        Arc::new(Self {
            kp,
            peer_id: peer_id.into(),
            hub,
            inbox: Mutex::new(Vec::new()),
            seen: Mutex::new(HashSet::new()),
        })
    }

    /// 签名 + 广播给 hub 内其他所有节点 (投递侧验签)
    pub async fn broadcast(&self, topic: &str, payload: serde_json::Value) -> Result<usize, EnvelopeError> {
        let env = SignedEnvelope::seal(
            &self.kp,
            topic,
            payload,
            chrono::Utc::now().timestamp_millis() as u64,
        );
        env.verify()?; // 自己先自检
        let hash = env.content_hash();
        self.seen.lock().await.insert(hash);

        let nodes = self.hub.nodes.lock().await;
        let mut delivered = 0;
        for node in nodes.iter() {
            if node.peer_id == self.peer_id {
                continue; // 不回环给自己
            }
            if node.deliver(env.clone()).await {
                delivered += 1;
            }
        }
        Ok(delivered)
    }

    /// 已收到的信封 (全部已验签)
    pub async fn inbox(&self) -> Vec<Delivered> {
        self.inbox.lock().await.clone()
    }

    /// 收到信封：验签 + 去重, 过了才入库。返回是否真收下。
    async fn deliver(&self, env: SignedEnvelope) -> bool {
        // 验签不过 → 丢弃 (拒伪造)
        if env.verify().is_err() {
            tracing::warn!(peer = %self.peer_id, "gossip 信封验签失败, 已丢弃");
            return false;
        }
        // 去重
        let hash = env.content_hash();
        {
            let mut seen = self.seen.lock().await;
            if !seen.insert(hash) {
                return false; // 重复投递
            }
        }
        self.inbox.lock().await.push(Delivered { envelope: env });
        true
    }
}

/// 实现 kernel Transport 端口 (节点句柄侧)
#[async_trait]
impl Transport for GossipNode {
    async fn send(&self, msg: TransportMessage) -> Result<(), TransportError> {
        // 定向发送 = 只投给目标 peer
        let to = msg.to.clone().ok_or(TransportError::PeerNotFound("(空)".into()))?;
        let env = SignedEnvelope::seal(
            &self.kp,
            msg.topic.as_deref().unwrap_or("direct"),
            msg.payload,
            chrono::Utc::now().timestamp_millis() as u64,
        );
        let nodes = self.hub.nodes.lock().await;
        for node in nodes.iter() {
            if node.peer_id == to {
                if node.deliver(env).await {
                    return Ok(());
                }
                return Err(TransportError::Io("对端拒绝 (验签/去重)".into()));
            }
        }
        Err(TransportError::PeerNotFound(to))
    }

    async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError> {
        let topic = msg.topic.as_deref().unwrap_or("broadcast");
        self.broadcast(topic, msg.payload)
            .await
            .map_err(|e| TransportError::Io(e.to_string()))?;
        Ok(())
    }

    async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
        let nodes = self.hub.nodes.lock().await;
        Ok(nodes
            .iter()
            .filter(|n| n.peer_id != self.peer_id)
            .map(|n| PeerInfo {
                peer_id: n.peer_id.clone(),
                name: None,
                did: Some(n.kp.did.as_str().to_string()),
                addrs: vec![],
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::KeyPair;

    async fn two_nodes() -> (Arc<GossipNode>, Arc<GossipNode>, Arc<GossipHub>) {
        let hub = Arc::new(GossipHub::new());
        let a = GossipNode::new("node-a", KeyPair::generate(), hub.clone());
        let b = GossipNode::new("node-b", KeyPair::generate(), hub.clone());
        hub.join(a.clone()).await;
        hub.join(b.clone()).await;
        (a, b, hub)
    }

    #[tokio::test]
    async fn broadcast_reaches_other_nodes() {
        let (a, b, _hub) = two_nodes().await;
        let n = a
            .broadcast("group.msg", serde_json::json!({"text": "大家好"}))
            .await
            .unwrap();
        assert_eq!(n, 1, "广播应送达 1 个其他节点");
        let inbox = b.inbox().await;
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].envelope.payload["text"], "大家好");
        assert!(inbox[0].envelope.verify().is_ok());
    }

    #[tokio::test]
    async fn peers_lists_others_with_did() {
        let (a, _b, _hub) = two_nodes().await;
        let peers = Transport::peers(a.as_ref()).await.unwrap();
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].peer_id, "node-b");
        assert!(peers[0].did.as_deref().unwrap().starts_with("did:pi:"));
    }

    #[tokio::test]
    async fn duplicate_delivery_deduped() {
        let (a, b, _hub) = two_nodes().await;
        a.broadcast("t", serde_json::json!({"x": 1})).await.unwrap();
        // 同内容再发 (新时间戳会变 hash —— 用定向 deliver 模拟重放)
        let env = SignedEnvelope::seal(&a.kp, "t", serde_json::json!({"x": 1}), 12345);
        assert!(b.deliver(env.clone()).await, "新 hash 首次收下");
        assert!(!b.deliver(env).await, "同 hash 重放必须去重");
        assert_eq!(b.inbox().await.len(), 2, "广播 1 条 + 定向 1 条, 重放被去重");
    }

    #[tokio::test]
    async fn forged_envelope_dropped() {
        let (a, b, _hub) = two_nodes().await;
        let mut env = SignedEnvelope::seal(
            &a.kp,
            "t",
            serde_json::json!({"evil": true}),
            chrono::Utc::now().timestamp_millis() as u64,
        );
        env.payload = serde_json::json!({"evil": false}); // 篡改正文
        assert!(!b.deliver(env).await, "伪造信封必须被丢");
        assert!(b.inbox().await.is_empty());
    }

    #[tokio::test]
    async fn direct_send_to_unknown_peer_errors() {
        let (a, _b, _hub) = two_nodes().await;
        let msg = TransportMessage {
            to: Some("ghost".into()),
            topic: None,
            payload: serde_json::json!({}),
            from: None,
        };
        let err = Transport::send(a.as_ref(), msg).await.unwrap_err();
        assert!(matches!(err, TransportError::PeerNotFound(_)));
    }

    #[tokio::test]
    async fn three_node_mesh() {
        let hub = Arc::new(GossipHub::new());
        let nodes: Vec<Arc<GossipNode>> = (0..3)
            .map(|i| GossipNode::new(format!("n{i}"), KeyPair::generate(), hub.clone()))
            .collect();
        for n in &nodes {
            hub.join(n.clone()).await;
        }
        let n = nodes[0]
            .broadcast("topic", serde_json::json!({"hello": 1}))
            .await
            .unwrap();
        assert_eq!(n, 2, "应送达另外 2 个节点");
        for node in &nodes[1..] {
            assert_eq!(node.inbox().await.len(), 1);
        }
    }
}
