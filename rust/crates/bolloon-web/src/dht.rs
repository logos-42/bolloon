//! 路径 B：**真 DHT（libp2p Kademlia）** 做「手机号 → DIAP 地址」发现。
//!
//! 2026-11-11：gossip（路径 A）要求对方在线广播过且网络连通；DHT 把带签名的记录
//! 按 key 分散存放在 Kademlia 网络里，查询方只输手机号就能从网络取回，
//! **不需要和对方有过任何直接登记**。
//!
//! key = `discovery_topic(phone)`（32B，全局确定性）；value = DID 签名过的
//! `{topic,did,diap,ts_ms,sig}` JSON。记录验签仍由 `discovery.rs` 负责，DHT 只管存取。
//!
//! 诚实边界：Kademlia 仍需要 bootstrap 节点（可多个、互为 bootstrap，不是单点）；
//! 这里是自建 DHT，公共 Mainline/pkarr relay 在本机网络不可达。

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use libp2p::{
    Multiaddr, PeerId, SwarmBuilder, identity, kad, noise,
    swarm::{NetworkBehaviour, SwarmEvent},
    tcp, yamux,
};
use tokio::sync::{Mutex, mpsc, oneshot};

#[derive(NetworkBehaviour)]
struct DhtBehaviour {
    kad: kad::Behaviour<kad::store::MemoryStore>,
}

enum Cmd {
    Put {
        key: Vec<u8>,
        value: Vec<u8>,
        tx: oneshot::Sender<bool>,
    },
    Get {
        key: Vec<u8>,
        tx: oneshot::Sender<Option<Vec<u8>>>,
    },
}

pub struct Dht {
    peer_id: PeerId,
    listen: Vec<Multiaddr>,
    cmd: mpsc::UnboundedSender<Cmd>,
    peers: Arc<Mutex<usize>>,
    bootstraps: Vec<String>,
}

static GLOBAL: OnceLock<Arc<Dht>> = OnceLock::new();

pub fn global() -> Option<&'static Arc<Dht>> {
    GLOBAL.get()
}

pub fn set_global(d: Arc<Dht>) {
    let _ = GLOBAL.set(d);
}

impl Dht {
    pub async fn start(port: u16, bootstraps: Vec<String>) -> Result<Arc<Self>, String> {
        let kp = identity::Keypair::generate_ed25519();
        let peer_id = kp.public().to_peer_id();
        let mut swarm = SwarmBuilder::with_existing_identity(kp)
            .with_tokio()
            .with_tcp(
                tcp::Config::default(),
                noise::Config::new,
                yamux::Config::default,
            )
            .map_err(|e| format!("DHT TCP 配置: {e}"))?
            .with_behaviour(|key| DhtBehaviour {
                kad: kad::Behaviour::new(
                    key.public().to_peer_id(),
                    kad::store::MemoryStore::new(key.public().to_peer_id()),
                ),
            })
            .map_err(|e| format!("DHT behaviour: {e}"))?
            .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(120)))
            .build();

        let listen_on: Multiaddr = format!("/ip4/0.0.0.0/tcp/{port}").parse()
            .map_err(|e| format!("DHT 监听地址: {e}"))?;
        swarm.listen_on(listen_on.clone())
            .map_err(|e| format!("DHT listen: {e}"))?;
        // 每个 bolloon 节点都是完整 DHT 节点：client 模式不存记录，PUT 会找不到落点。
        swarm.behaviour_mut().kad.set_mode(Some(kad::Mode::Server));

        for b in &bootstraps {
            if let Some((addr, pid)) = b.rsplit_once("/p2p/") {
                if let (Ok(ma), Ok(peer)) = (addr.parse::<Multiaddr>(), pid.parse::<PeerId>()) {
                    swarm.behaviour_mut().kad.add_address(&peer, ma);
                }
            }
        }
        // 加入 DHT 路由表（无 bootstrap 时如实返回 Err，不假装已入网）
        let _ = swarm.behaviour_mut().kad.bootstrap();

        let (tx, mut rx) = mpsc::unbounded_channel::<Cmd>();
        let peers = Arc::new(Mutex::new(0usize));
        let peers2 = Arc::clone(&peers);
        // QueryId 在 0.57 上不保证 Hash，用线性表配对（并发量很小）
        let mut pending_get: Vec<(kad::QueryId, oneshot::Sender<Option<Vec<u8>>>)> = Vec::new();
        let mut pending_put: Vec<(kad::QueryId, oneshot::Sender<bool>)> = Vec::new();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    Some(cmd) = rx.recv() => match cmd {
                        Cmd::Put { key, value, tx } => {
                            let record = kad::Record::new(key, value);
                            match swarm.behaviour_mut().kad.put_record(record, kad::Quorum::One) {
                                Ok(id) => pending_put.push((id, tx)),
                                Err(e) => { eprintln!("[dht] put_record 失败: {e}"); let _ = tx.send(false); }
                            }
                        }
                        Cmd::Get { key, tx } => {
                            let id = swarm.behaviour_mut().kad.get_record(key.into());
                            pending_get.push((id, tx));
                        }
                    },
                    ev = swarm.select_next_some() => {
                        if let SwarmEvent::Behaviour(DhtBehaviourEvent::Kad(kad::Event::OutboundQueryProgressed { id, result, .. })) = ev {
                            match result {
                                kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FoundRecord(rec))) => {
                                    if let Some(pos) = pending_get.iter().position(|(q, _)| *q == id) {
                                        let (_, tx) = pending_get.remove(pos);
                                        let _ = tx.send(Some(rec.record.value));
                                    }
                                }
                                kad::QueryResult::GetRecord(Err(_)) | kad::QueryResult::GetRecord(Ok(kad::GetRecordOk::FinishedWithNoAdditionalRecord { .. })) => {
                                    if let Some(pos) = pending_get.iter().position(|(q, _)| *q == id) {
                                        let (_, tx) = pending_get.remove(pos);
                                        let _ = tx.send(None);
                                    }
                                }
                                kad::QueryResult::PutRecord(Ok(_)) => {
                                    if let Some(pos) = pending_put.iter().position(|(q, _)| *q == id) {
                                        let (_, tx) = pending_put.remove(pos);
                                        let _ = tx.send(true);
                                    }
                                }
                                kad::QueryResult::PutRecord(Err(_)) => {
                                    if let Some(pos) = pending_put.iter().position(|(q, _)| *q == id) {
                                        let (_, tx) = pending_put.remove(pos);
                                        let _ = tx.send(false);
                                    }
                                }
                                _ => {}
                            }
                        } else if let SwarmEvent::ConnectionEstablished { .. } = ev {
                            *peers2.lock().await += 1;
                        }
                    }
                }
            }
        });

        Ok(Arc::new(Self {
            peer_id,
            listen: vec![listen_on],
            cmd: tx,
            peers,
            bootstraps,
        }))
    }

    pub fn peer_id(&self) -> String {
        self.peer_id.to_string()
    }

    pub fn listen_addrs(&self) -> Vec<String> {
        self.listen
            .iter()
            .map(|a| format!("{a}/p2p/{}", self.peer_id))
            .collect()
    }

    pub async fn status(&self) -> serde_json::Value {
        serde_json::json!({
            "ok": true,
            "enabled": true,
            "peer_id": self.peer_id(),
            "listen": self.listen_addrs(),
            "connections": *self.peers.lock().await,
            "bootstraps": self.bootstraps,
        })
    }

    pub async fn put(&self, key: Vec<u8>, value: Vec<u8>) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.cmd.send(Cmd::Put { key, value, tx })
            .map_err(|_| "DHT 任务已退出".to_string())?;
        match tokio::time::timeout(Duration::from_secs(6), rx).await {
            Ok(Ok(true)) => Ok(()),
            Ok(Ok(false)) => Err("DHT put_record 未达 Quorum（没有可用 bootstrap 节点？）".to_string()),
            Ok(Err(_)) => Err("DHT put 通道关闭".to_string()),
            Err(_) => Err("DHT put 超时".to_string()),
        }
    }

    pub async fn get(&self, key: Vec<u8>) -> Option<Vec<u8>> {
        let (tx, rx) = oneshot::channel();
        self.cmd.send(Cmd::Get { key, tx }).ok()?;
        match tokio::time::timeout(Duration::from_secs(8), rx).await {
            Ok(Ok(v)) => v,
            _ => None,
        }
    }
}

/// GET /api/dht/status
pub async fn dht_status() -> axum::Json<serde_json::Value> {
    match global() {
        Some(d) => axum::Json(d.status().await),
        None => axum::Json(serde_json::json!({
            "ok": false, "enabled": false,
            "error": "DHT 未启用 (BOLLOON_DHT=1 且编译 feature dht-backend)"
        })),
    }
}
