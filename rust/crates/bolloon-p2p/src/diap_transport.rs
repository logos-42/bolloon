//! DIAP 传输后端 —— 用 `diap-rs-sdk` 的 iroh 通信器实现 `Transport` 端口。
//!
//! 与 `quic_transport` 的分工：
//! - quinn：双方 IP 可达时的端对端直连（无 NAT 穿透）
//! - DIAP/iroh：只交换 NodeId 即可，relay + discovery 负责打洞（跨 NAT）
//!
//! Kernel 只定义端口，这里是**注入的实现**；未开 `diap-backend` feature 时整个模块不存在。

use std::sync::Arc;

use bolloon_kernel::transport::{PeerInfo, Transport, TransportError, TransportMessage};
use diap_rs_sdk::iroh_communicator::{IrohCommunicator, IrohConfig, IrohMessage};

pub struct DiapTransport {
    comm: Arc<IrohCommunicator>,
    own_did: String,
}

impl DiapTransport {
    pub async fn new(own_did: impl Into<String>) -> Result<Self, String> {
        let comm = IrohCommunicator::new(IrohConfig::default())
            .await
            .map_err(|e| format!("DIAP iroh 端点启动失败: {e}"))?;
        Ok(Self {
            comm: Arc::new(comm),
            own_did: own_did.into(),
        })
    }

    /// 本机 iroh NodeId —— 交给对端即可建连，不需要 IP/端口。
    pub fn node_id(&self) -> String {
        self.comm.node_id()
    }

    /// 后台接收循环（accept 进来的连接 → 投递到内部 channel）。
    pub fn spawn_listener(&self) {
        let comm = Arc::clone(&self.comm);
        tokio::spawn(async move {
            if let Err(e) = comm.start_message_listener().await {
                eprintln!("[diap] listener 退出: {e}");
            }
        });
    }

    pub async fn recv(&self) -> Option<IrohMessage> {
        self.comm.receive_message().await
    }

    pub fn try_recv(&self) -> Option<IrohMessage> {
        self.comm.try_receive_message()
    }

    /// 完整端点地址（JSON）：与对端交换后即可直连。
    /// 只交换 NodeId 且 n0 relay 不可达时，iroh 会报 "No addressing information available"。
    pub fn address_json(&self) -> serde_json::Value {
        self.comm.address_json()
    }

    /// 用对端给的完整地址 JSON 发消息（不依赖 relay/discovery）。
    pub async fn send_to_addr(
        &self,
        addr: serde_json::Value,
        msg: TransportMessage,
    ) -> Result<(), TransportError> {
        let payload = serde_json::to_string(&msg.payload)
            .map_err(|e| TransportError::Io(format!("编码: {e}")))?;
        let im = self.comm.create_custom_message(
            msg.from.as_deref().unwrap_or(&self.own_did),
            None,
            &payload,
            msg.topic.as_deref().unwrap_or("bolloon"),
        );
        self.comm
            .send_to_addr_json(addr, im)
            .await
            .map_err(|e| TransportError::Io(format!("DIAP 地址发送失败: {e}")))
    }
}

#[async_trait::async_trait]
impl Transport for DiapTransport {
    async fn send(&self, msg: TransportMessage) -> Result<(), TransportError> {
        let to = msg
            .to
            .clone()
            .ok_or_else(|| TransportError::PeerNotFound("(空)".into()))?;
        let payload = serde_json::to_string(&msg.payload)
            .map_err(|e| TransportError::Io(format!("编码: {e}")))?;
        let im = self.comm.create_custom_message(
            msg.from.as_deref().unwrap_or(&self.own_did),
            None,
            &payload,
            msg.topic.as_deref().unwrap_or("bolloon"),
        );
        self.comm
            .send_message(&to, im)
            .await
            .map_err(|e| TransportError::Io(format!("DIAP 发送失败: {e}")))
    }

    async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError> {
        for p in self.comm.get_connected_nodes() {
            let mut one = msg.clone();
            one.to = Some(p.clone());
            if let Err(e) = self.send(one).await {
                eprintln!("[diap] broadcast 到 {} 失败: {e}", &p[..p.len().min(8)]);
            }
        }
        Ok(())
    }

    async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
        Ok(self
            .comm
            .get_connected_nodes()
            .into_iter()
            .map(|id| PeerInfo {
                peer_id: id,
                name: None,
                did: None,
                addrs: vec![],
            })
            .collect())
    }
}
