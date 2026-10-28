//! QUIC 直连传输 —— kernel `Transport` 端口的实现 (端对端好友对话的传输底座)
//!
//! 设计要点:
//! - 用 **quinn** (iroh 底层用的同一个 QUIC 库) 做**真正点对点直连**: 不走 HTTP 中继,
//!   两端各自起 QUIC 端点, 按对端 socket 地址直接建连。
//! - TLS 用自签证书 (仅满足 QUIC 的 TLS 1.3 握手要求); **真实信任靠 `SignedEnvelope` 的 Ed25519
//!   验签**, 所以客户端一律 `AcceptAnyCert` —— 证书身份无所谓。
//! - `TransportMessage.to` 在这里就是**对端 DID**; 对端地址 (`SocketAddr`) 靠 `add_peer` 手动下发
//!   (线上可接既有 `directory_peers` 注册表), 离线/测试照常直连。
//! - 整套传输对"人机不可分辨"零影响: 信封里本来就没有 human/AI 字段, AI 回复也走用户 KeyPair 签名。
//!
//! 同一 `Transport` 端口, 日后要换成 iroh 只是再写一份适配器 (iroh-net 0.28 在本工具链因
//! netwatch/socket2 冲突编不过, 故先落 quinn)。

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;

use async_trait::async_trait;
use bolloon_kernel::transport::{PeerInfo, Transport, TransportError, TransportMessage};
use quinn::{ClientConfig, Endpoint, ServerConfig};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, Notify};

use crate::envelope::SignedEnvelope;
use crate::identity::KeyPair;

/// 承载层 ALPN: 与信封协议名一致, 防止与其它 QUIC 应用串台
const BOLLOON_ALPN: &[u8] = b"bolloon-envelope/1";

/// QUIC 直连传输节点
pub struct QuicTransport {
    endpoint: Endpoint,
    /// did → 对端 socket 地址 (手动登记; 线上经 directory_peers 注册表下发)
    peers: Mutex<HashMap<String, SocketAddr>>,
    /// 已收且验签过的信封
    inbox: Mutex<Vec<SignedEnvelope>>,
    /// 内容哈希去重
    seen: Mutex<HashSet<String>>,
    /// 有新信封时唤醒等待者
    notify: Arc<Notify>,
    /// 本节点身份 (给发出去的信封签名 —— **用户的 KeyPair**, 不是 agent 的)
    kp: KeyPair,
}

impl QuicTransport {
    /// 起一个 QUIC 端点 (随机端口), 同时能收能发
    pub async fn new(kp: &KeyPair) -> anyhow::Result<Self> {
        let endpoint = make_endpoint()?;
        let t = Self {
            endpoint,
            peers: Mutex::new(HashMap::new()),
            inbox: Mutex::new(Vec::new()),
            seen: Mutex::new(HashSet::new()),
            notify: Arc::new(Notify::new()),
            kp: kp.clone(),
        };
        t.spawn_accept_loop();
        Ok(t)
    }

    /// 本节点对外 socket 地址, 用于与对端交换
    pub async fn node_addr(&self) -> anyhow::Result<SocketAddr> {
        Ok(self.endpoint.local_addr()?)
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

/// 处理一条入站连接: 逐个收取双向流, 解析+验签+去重后入库
async fn handle_conn(
    conn: quinn::Connection,
    inbox: Arc<Mutex<Vec<SignedEnvelope>>>,
    seen: Arc<Mutex<HashSet<String>>>,
    notify: Arc<Notify>,
) -> anyhow::Result<()> {
    loop {
        let (mut recv, _send) = match conn.accept_bi().await {
            Ok(x) => x,
            Err(_) => break, // 对端关门 / 流结束
        };
        let mut buf = Vec::new();
        if recv.read_to_end(&mut buf).await? == 0 && buf.is_empty() {
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
    }
    Ok(())
}

fn now_ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}

/// 生成一个自签证书 +  permissive 客户端的 QUIC 端点
/// (证书身份无关紧要, 真实信任靠信封验签)
fn make_endpoint() -> anyhow::Result<Endpoint> {
    // 自签证书 (QUIC 的 TLS 1.3 握手需要; 我们不靠它做身份识别)
    let mut params = rcgen::CertificateParams::new(vec!["bolloon".to_string()]);
    let key = rcgen::KeyPair::generate(&rcgen::PKCS_ECDSA_P256_SHA256)?;
    let certified = params.self_signed(&key)?;
    let cert_der = certified.der().clone();
    let key_der = rustls::pki_types::PrivateKeyDer::Pkcs8(
        rustls::pki_types::PrivatePkcs8KeyDer::from(key.serialize_der()),
    );

    let server_config =
        ServerConfig::with_single_cert(vec![cert_der], key_der).map_err(|e| anyhow::anyhow!("QUIC server config: {e}"))?;

    // 客户端: 接受任何证书 (身份由信封验签保证)
    let mut client_config = ClientConfig::new(Arc::new(AcceptAnyCert));
    client_config.enable_sni = false;

    let endpoint = Endpoint::new(
        server_config,
        Some(client_config),
        "0.0.0.0:0".parse::<SocketAddr>().unwrap(),
    )
    .map_err(|e| anyhow::anyhow!("QUIC bind: {e}"))?;
    Ok(endpoint)
}

/// 自定义证书校验: 一律放行 (QUIC 握手仍走 TLS 1.3, 但身份信任交给信封)
struct AcceptAnyCert;

impl rustls::client::danger::ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
        ]
    }
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

        let conn = self
            .endpoint
            .connect(addr, &addr.ip().to_string())
            .await
            .map_err(|e| TransportError::Io(format!("连接 {to}: {e}")))?;
        let (mut send, _recv) = conn
            .open_bi()
            .await
            .map_err(|e| TransportError::Io(format!("开流: {e}")))?;
        send.write_all(&data)
            .await
            .map_err(|e| TransportError::Io(format!("写: {e}")))?;
        send.finish()
            .await
            .map_err(|e| TransportError::Io(format!("finish: {e}")))?;
        Ok(())
    }

    async fn broadcast(&self, msg: TransportMessage) -> Result<(), TransportError> {
        // 直连语义下: 广播 = 发给所有已知对端
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

        // B 把自己的 socket 地址告诉 A (线上这步走 directory_peers 注册表)
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
            .expect("10s 内没收到")
            .unwrap_or_else(|| panic!("收件箱空"));
        assert!(env.verify().is_ok(), "对端验签必须过");
        assert_eq!(env.sender, kp_a.did.as_str());
        assert_eq!(env.payload["text"], "你好, 我是 A (走 QUIC 直连)");
    }
}
