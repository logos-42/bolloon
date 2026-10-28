//! QUIC 直连传输 —— kernel `Transport` 端口的实现 (端对端好友对话的传输底座)
//!
//! 设计要点:
//! - 用 **quinn** (iroh 底层用的同一个 QUIC 库) 做**真正点对点直连**: 不走 HTTP 中继,
//!   两端各自起 QUIC 端点, 按对端 socket 地址直接建连。
//! - **静态自签证书** (`CERT_DER`/`KEY_DER`) 仅用于满足 QUIC 的 TLS 1.3 握手; 真实信任靠
//!   `SignedEnvelope` 的 Ed25519 验签。一个端点同时是服务端 (收 + TLS 服务端) 与客户端
//!   (发 + 信任静态证书, 经 `set_default_client_config`), 不需要第二个端点, 也不需要任何
//!   自定义证书校验器。注意: 这张证书**不是身份密钥** (身份是 DID 的 ed25519), 所有安装共享
//!   同一张, 仅作 QUIC 通道加密; 日后要按节点隔离可改为经注册表下发每节点证书。
//! - `TransportMessage.to` 在这里就是**对端 DID**; 对端地址 (`SocketAddr`) 靠 `add_peer` 手动下发
//!   (线上可接既有 `directory_peers` 注册表), 离线/测试照常直连。
//! - 整套传输对"人机不可分辨"零影响: 信封里本来就没有 human/AI 字段, AI 回复也走用户 KeyPair 签名。
//!
//! 同一 `Transport` 端口, 日后要换成 iroh 只是再写一份适配器 (iroh-net 0.28 在本工具链因
//! netwatch/socket2 冲突编不过, 故先落 quinn)。

use std::collections::{HashMap, HashSet};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;

use async_trait::async_trait;
use bolloon_kernel::transport::{PeerInfo, Transport, TransportError, TransportMessage};
use quinn::{ClientConfig, Endpoint, ServerConfig, VarInt};
use quinn::crypto::rustls::QuicClientConfig;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde_json::json;
use tokio::sync::{Mutex, Notify};

/// 单条 DM 信封上限 (防滥用); quinn 的 read_to_end 需要显式 size_limit
const MAX_MSG: usize = 16 * 1024 * 1024;

use crate::envelope::SignedEnvelope;
use crate::identity::KeyPair;

/// 静态自签证书 + 私钥 (见文件头说明): 仅供 QUIC 通道加密, 不作身份
const CERT_DER: &[u8] = &[
48,130,1,91,48,130,1,1,160,3,2,1,2,2,20,95,
20,38,169,93,57,213,20,245,79,180,22,79,43,226,178,133,
32,238,12,48,10,6,8,42,134,72,206,61,4,3,2,48,
18,49,16,48,14,6,3,85,4,3,12,7,98,111,108,108,
111,111,110,48,30,23,13,50,54,49,48,50,56,48,52,48,
57,51,54,90,23,13,51,54,49,48,50,53,48,52,48,57,
51,54,90,48,18,49,16,48,14,6,3,85,4,3,12,7,
98,111,108,108,111,111,110,48,89,48,19,6,7,42,134,72,
206,61,2,1,6,8,42,134,72,206,61,3,1,7,3,66,
0,4,185,22,121,47,102,175,24,70,128,126,182,209,56,17,
241,223,141,78,79,129,173,102,125,229,124,245,158,173,173,245,
117,59,243,179,242,76,92,19,200,134,239,40,93,170,223,112,
146,199,134,253,113,61,187,138,185,50,97,189,204,47,181,236,
181,189,163,53,48,51,48,18,6,3,85,29,17,4,11,48,
9,130,7,98,111,108,108,111,111,110,48,29,6,3,85,29,
14,4,22,4,20,17,129,110,22,137,181,84,228,48,244,153,
107,31,75,94,100,11,42,181,15,48,10,6,8,42,134,72,
206,61,4,3,2,3,72,0,48,69,2,33,0,239,189,126,
67,199,29,194,44,117,60,97,155,104,91,117,197,230,24,93,
11,80,73,59,102,191,23,250,165,183,74,107,70,2,32,32,
44,157,230,220,19,135,107,118,117,170,255,89,34,110,193,243,
85,34,48,213,234,22,118,174,30,99,20,151,54,152,192
];
const KEY_DER: &[u8] = &[
48,129,135,2,1,0,48,19,6,7,42,134,72,206,61,2,
1,6,8,42,134,72,206,61,3,1,7,4,109,48,107,2,
1,1,4,32,195,178,189,55,75,46,206,89,10,55,106,31,
148,206,76,67,167,94,118,193,80,155,210,85,91,202,123,175,
162,254,168,71,161,68,3,66,0,4,185,22,121,47,102,175,
24,70,128,126,182,209,56,17,241,223,141,78,79,129,173,102,
125,229,124,245,158,173,173,245,117,59,243,179,242,76,92,19,
200,134,239,40,93,170,223,112,146,199,134,253,113,61,187,138,
185,50,97,189,204,47,181,236,181,189
];

/// QUIC 直连传输节点 (单端点: 既收又发)
pub struct QuicTransport {
    endpoint: Endpoint,
    /// did → 对端 socket 地址 (手动登记; 线上经 directory_peers 注册表下发)
    peers: Mutex<HashMap<String, SocketAddr>>,
    inbox: Arc<Mutex<Vec<SignedEnvelope>>>,
    seen: Arc<Mutex<HashSet<String>>>,
    notify: Arc<Notify>,
    /// 本节点身份 (给发出去的信封签名 —— **用户的 KeyPair**, 不是 agent 的)
    kp: KeyPair,
}

impl QuicTransport {
    /// 起一个 QUIC 端点 (随机端口), 同时能收能发
    pub async fn new(kp: &KeyPair) -> anyhow::Result<Self> {
        let (server_config, client_config) = make_configs()?;
        let mut endpoint = Endpoint::server(server_config, "0.0.0.0:0".parse::<SocketAddr>().unwrap())
            .map_err(|e| anyhow::anyhow!("QUIC bind: {e}"))?;
        // 同一个端点, 外出连接用"信任静态证书"的客户端配置
        endpoint.set_default_client_config(client_config);
        let t = Self {
            endpoint,
            peers: Mutex::new(HashMap::new()),
            inbox: Arc::new(Mutex::new(Vec::new())),
            seen: Arc::new(Mutex::new(HashSet::new())),
            notify: Arc::new(Notify::new()),
            kp: kp.clone(),
        };
        t.spawn_accept_loop();
        Ok(t)
    }

    /// 本节点对外 socket 地址 (收件端点), 用于与对端交换。
    /// 若绑定在 0.0.0.0/:: 上, 返回回环地址让本地/同机交换可达; 真实跨机部署经
    /// directory_peers 注册表下发对端实际可达地址 (注册表记录的是对端源 IP)。
    pub async fn node_addr(&self) -> anyhow::Result<SocketAddr> {
        let mut a = self.endpoint.local_addr()?;
        if a.ip().is_unspecified() {
            a.set_ip(if a.is_ipv6() {
                std::net::IpAddr::V6(Ipv6Addr::LOCALHOST)
            } else {
                std::net::IpAddr::V4(Ipv4Addr::LOCALHOST)
            });
        }
        Ok(a)
    }

    /// 手动登记对端 (离线/测试: 直接喂 SocketAddr; 线上: 经 directory_peers 注册表下发)
    pub async fn add_peer(&self, did: &str, addr: SocketAddr) {
        self.peers.lock().await.insert(did.to_string(), addr);
    }

    /// 等待并取出一条已收信封 (编排/测试用)
    pub async fn recv(&self) -> SignedEnvelope {
        loop {
            {
                let mut inbox = self.inbox.lock().await;
                if let Some(e) = inbox.pop() {
                    return e;
                }
            }
            self.notify.notified().await;
        }
    }

    fn spawn_accept_loop(&self) {
        let ep = self.endpoint.clone();
        let inbox = self.inbox.clone();
        let seen = self.seen.clone();
        let notify = self.notify.clone();
        tokio::spawn(async move {
            while let Some(connecting) = ep.accept().await {
                let conn = match connecting.await {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(err = %e, "QUIC 入站连接建立失败");
                        continue;
                    }
                };
                let inbox = inbox.clone();
                let seen = seen.clone();
                let notify = notify.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_conn(conn, inbox, seen, notify).await {
                        tracing::warn!(err = %e, "QUIC 连接处理失败");
                    }
                });
            }
        });
    }
}

async fn handle_conn(
    conn: quinn::Connection,
    inbox: Arc<Mutex<Vec<SignedEnvelope>>>,
    seen: Arc<Mutex<HashSet<String>>>,
    notify: Arc<Notify>,
) -> anyhow::Result<()> {
    loop {
        let (_send, mut recv) = match conn.accept_bi().await {
            Ok(x) => x,
            Err(_) => break, // 对端关门 / 流结束
        };
        let buf = match recv.read_to_end(MAX_MSG).await {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(err = %e, "QUIC 读取失败");
                continue;
            }
        };
        if buf.is_empty() {
            continue;
        }
        let env: SignedEnvelope = match serde_json::from_slice(&buf) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(err = %e, "QUIC 信封解码失败, 跳过");
                continue;
            }
        };
        if env.verify().is_err() {
            tracing::warn!("QUIC 信封验签失败, 丢弃 (拒伪造)");
            continue;
        }
        let hash = env.content_hash();
        let fresh = seen.lock().await.insert(hash);
        if fresh {
            inbox.lock().await.push(env);
            notify.notify_waiters();
        }
        // 读完即关连接: 通知发送方 (它 await closed()) 消息已送达, 避免发完即关的竞态
        conn.close(VarInt::from(0u32), b"ok");
    }
    Ok(())
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

/// 构建 server / client 配置: 共用静态自签证书
fn make_configs() -> anyhow::Result<(ServerConfig, ClientConfig)> {
    let cert_der = CertificateDer::from(CERT_DER.to_vec());
    let key_der = PrivateKeyDer::try_from(KEY_DER.to_vec())
        .map_err(|e| anyhow::anyhow!("私钥解析: {e}"))?;

    let server_config = ServerConfig::with_single_cert(vec![cert_der.clone()], key_der)
        .map_err(|e| anyhow::anyhow!("QUIC server config: {e}"))?;

    // 客户端: 把静态证书放进根信任 (等同放行所有用这张证书的对端; 真实身份仍靠信封验签)
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert_der).map_err(|e| anyhow::anyhow!("根证书: {e}"))?;
    let rustls_client = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let quic_client = QuicClientConfig::try_from(rustls_client)
        .map_err(|e| anyhow::anyhow!("QuicClientConfig: {e}"))?;
    let client_config = ClientConfig::new(Arc::new(quic_client));

    Ok((server_config, client_config))
}

#[async_trait]
impl Transport for QuicTransport {
    async fn send(&self, msg: TransportMessage) -> Result<(), TransportError> {
        let to = msg
            .to
            .clone()
            .ok_or_else(|| TransportError::PeerNotFound("(空)".into()))?;
        let addr = {
            let peers = self.peers.lock().await;
            peers.get(&to).copied()
        }
        .ok_or_else(|| TransportError::PeerNotFound(to.clone()))?;

        let env = SignedEnvelope::seal(
            &self.kp,
            msg.topic.as_deref().unwrap_or("direct"),
            msg.payload,
            now_ms(),
        );
        let data =
            serde_json::to_vec(&env).map_err(|e| TransportError::Io(format!("编码: {e}")))?;

        let connecting = self
            .endpoint
            .connect(addr, "bolloon")
            .map_err(|e| TransportError::Io(format!("连接 {to}: {e}")))?;
        let conn = connecting
            .await
            .map_err(|e| TransportError::Io(format!("握手 {to}: {e}")))?;
        let (mut send, _recv) = conn
            .open_bi()
            .await
            .map_err(|e| TransportError::Io(format!("开流: {e}")))?;
        send.write_all(&data)
            .await
            .map_err(|e| TransportError::Io(format!("写: {e}")))?;
        send.finish()
            .map_err(|e| TransportError::Io(format!("finish: {e}")))?;
        // 等接收方读完并关闭连接 (它读完会 conn.close), 保证消息确实送达;
        // 否则发完即丢连接会 race 掉未传输完的流。兜底 30s 超时, 不无限阻塞。
        let _ = tokio::time::timeout(std::time::Duration::from_secs(30), conn.closed()).await;
        Ok(())
    }

    async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError> {
        let targets: Vec<String> = self.peers.lock().await.keys().cloned().collect();
        if targets.is_empty() {
            return Err(TransportError::PeerNotFound("没有已登记对端".into()));
        }
        let mut last = Ok(());
        for t in targets {
            let mut m = msg.clone();
            m.to = Some(t);
            last = self.send(m).await;
        }
        last
    }

    async fn peers(&self) -> Result<Vec<PeerInfo>, TransportError> {
        let peers = self.peers.lock().await;
        Ok(peers
            .iter()
            .map(|(did, addr)| PeerInfo {
                peer_id: did.clone(),
                name: None,
                did: Some(did.clone()),
                addrs: vec![addr.to_string()],
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::KeyPair;

    #[tokio::test]
    async fn quic_direct_dm_loopback() {
        let kp_a = KeyPair::from_seed(&[1u8; 32]);
        let kp_b = KeyPair::from_seed(&[2u8; 32]);
        let a = QuicTransport::new(&kp_a).await.expect("a 端点起不来");
        let b = QuicTransport::new(&kp_b).await.expect("b 端点起不来");

        // B 把自己的收件地址告诉 A (线上这步走 directory_peers 注册表)
        let b_addr = b.node_addr().await.expect("取 B 地址失败");
        a.add_peer(kp_b.did.as_str(), b_addr).await;

        let msg = TransportMessage {
            to: Some(kp_b.did.as_str().to_string()),
            topic: Some("dm".into()),
            payload: json!({ "text": "你好, 我是 A (走 QUIC 直连)" }),
            from: Some(kp_a.did.as_str().to_string()),
        };
        Transport::send(&a, msg).await.expect("send 失败");

        // B 必须在本地收到并验签通过 —— 这就是"端对端直连"的最小证明
        let env = tokio::time::timeout(std::time::Duration::from_secs(10), b.recv())
            .await
            .expect("10s 内没收到");
        assert!(env.verify().is_ok(), "对端验签必须过");
        assert_eq!(env.sender, kp_a.did.as_str());
        assert_eq!(env.payload["text"], "你好, 我是 A (走 QUIC 直连)");
    }
}
