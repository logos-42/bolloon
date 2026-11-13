//! DIAP HTTP 隧道 —— 让 web 的跨机链路（手机号 → 好友 → 聊天）走 DIAP/iroh。
//!
//! 设计（2026-11-11）：
//! - 进程内单例（`OnceLock`），因为 `peer_json` 有 17 个调用点，不想每个都加 `st` 参数；
//! - 对端按 `url`（`http://host:port`）登记完整 `EndpointAddr`；
//! - `peer_json` 发请求前先问 hub「这个 url 有没有 DIAP 地址」：有就走隧道，没有回落 HTTP；
//! - 隧道协议是两条 `IrohMessage`：
//!   `BOLLOON_HTTP_REQ {id, method, path, body, reply_addr}` → 对端用 ureq 打本机回环；
//!   `BOLLOON_HTTP_RESP {id, ok, status, body}` → 回到请求方 pending 表。
//!
//! 安全边界（如实）：
//! - 服务端只允许 `127.0.0.1:<本机 web 端口>` + 以 `/` 开头的 path，不能变成任意 SSRF 跳板；
//! - 目前只校验 path 形状，不做「对端必须是好友」的二次鉴权 —— 依赖上层 API 自己的签名/授权门。

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use diap_rs_sdk::iroh_communicator::{IrohCommunicator, IrohConfig, IrohMessage};
use tokio::sync::{oneshot, Mutex};

const MSG_REQ: &str = "BOLLOON_HTTP_REQ";
const MSG_RESP: &str = "BOLLOON_HTTP_RESP";
const REQ_TIMEOUT: Duration = Duration::from_secs(20);

pub struct DiapHub {
    comm: Arc<IrohCommunicator>,
    local_port: u16,
    /// 请求 id → 等待响应的一方
    pending: Mutex<HashMap<String, oneshot::Sender<serde_json::Value>>>,
    /// 对端 HTTP 基址（`http://host:port`）→ 完整 EndpointAddr JSON
    peers: Mutex<HashMap<String, serde_json::Value>>,
}

static GLOBAL: OnceLock<Arc<DiapHub>> = OnceLock::new();

/// 进程内单例；未启用 `diap-backend`/`BOLLOON_DIAP` 时为 None。
pub fn global() -> Option<&'static Arc<DiapHub>> {
    GLOBAL.get()
}

pub fn set_global(hub: Arc<DiapHub>) {
    let _ = GLOBAL.set(hub);
}

/// 把 `http://host:port/path` 拆成 (base, path)；没有 path 时 path = "/"。
fn split_http_url(url: &str) -> Option<(String, String)> {
    let (scheme, rest) = if let Some(r) = url.strip_prefix("http://") {
        ("http", r)
    } else if let Some(r) = url.strip_prefix("https://") {
        ("https", r)
    } else {
        return None;
    };
    let (host, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if host.is_empty() {
        return None;
    }
    Some((format!("{scheme}://{host}"), path.to_string()))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl DiapHub {
    /// 起一个 DIAP iroh 节点。`local_port` = 本机 web 端口（隧道落点）。
    pub async fn start(own_did: &str, local_port: u16) -> Result<Arc<Self>, String> {
        let comm = IrohCommunicator::new(IrohConfig::default())
            .await
            .map_err(|e| format!("DIAP iroh 端点启动失败: {e}"))?;
        let _ = own_did;
        Ok(Arc::new(Self {
            comm: Arc::new(comm),
            local_port,
            pending: Mutex::new(HashMap::new()),
            peers: Mutex::new(HashMap::new()),
        }))
    }

    pub fn node_id(&self) -> String {
        self.comm.node_id()
    }

    /// 本机完整地址（JSON）：交给对端登记，含 NodeId + 可达 IP。
    pub fn address_json(&self) -> serde_json::Value {
        self.comm.address_json()
    }

    pub async fn register(&self, url: &str, addr: serde_json::Value) {
        if let Some((base, _)) = split_http_url(url) {
            self.peers.lock().await.insert(base, addr);
        }
    }

    /// 已登记对端的 HTTP 基址列表（gossip 广播目标）
    pub async fn peer_urls(&self) -> Vec<String> {
        self.peers.lock().await.keys().cloned().collect()
    }

    pub async fn peers_snapshot(&self) -> Vec<serde_json::Value> {
        self.peers
            .lock()
            .await
            .iter()
            .map(|(url, addr)| serde_json::json!({ "url": url, "addr": addr }))
            .collect()
    }

    /// 两个后台循环：accept 进来的连接 + 消费消息（请求转发 / 响应唤醒）。
    pub fn spawn(self: &Arc<Self>) {
        let comm = Arc::clone(&self.comm);
        tokio::spawn(async move {
            if let Err(e) = comm.start_message_listener().await {
                eprintln!("[diap] listener 退出: {e}");
            }
        });

        let me = Arc::clone(self);
        tokio::spawn(async move {
            let comm = Arc::clone(&me.comm);
            while let Some(msg) = comm.receive_message().await {
                match msg.message_type {
                    diap_rs_sdk::iroh_communicator::IrohMessageType::Custom(ref t)
                        if t == MSG_REQ =>
                    {
                        let me2 = Arc::clone(&me);
                        tokio::spawn(async move { me2.handle_request(msg).await });
                    }
                    diap_rs_sdk::iroh_communicator::IrohMessageType::Custom(ref t)
                        if t == MSG_RESP =>
                    {
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.content) {
                            let id = v["id"].as_str().unwrap_or_default().to_string();
                            if let Some(tx) = me.pending.lock().await.remove(&id) {
                                let _ = tx.send(v);
                            }
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    /// 处理对端请求：打本机回环 web 端口，把响应回过去。
    async fn handle_request(&self, msg: IrohMessage) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&msg.content) else {
            return;
        };
        let id = v["id"].as_str().unwrap_or_default().to_string();
        // owned String: 下面要 move 进 spawn_blocking（要求 'static）
        let method = v["method"].as_str().unwrap_or("GET").to_string();
        let path = v["path"].as_str().unwrap_or("/").to_string();
        let body = v.get("body").cloned().filter(|b| !b.is_null());
        let reply_addr = v["reply_addr"].clone();
        if id.is_empty() || !path.starts_with('/') {
            return;
        }
        // 2026-11-13: 留痕用的副本（method/path 下面要 move 进闭包）
        let started_in = now_ms();
        let method_log = method.clone();
        let path_log = path.clone();
        let req_len = v.to_string().len();
        // 只允许打本机回环的 web 端口
        let url = format!("http://127.0.0.1:{}{}", self.local_port, path);
        let resp = tokio::task::spawn_blocking(move || -> serde_json::Value {
            let req = if method.eq_ignore_ascii_case("POST") {
                ureq::post(&url)
            } else {
                ureq::get(&url)
            };
            let req = req.timeout(Duration::from_secs(15));
            let result = match body {
                Some(b) => req.send_json(b),
                None => req.call(),
            };
            match result {
                Ok(r) => {
                    let status = r.status();
                    let body = r.into_json::<serde_json::Value>().unwrap_or(serde_json::Value::Null);
                    serde_json::json!({ "id": id, "ok": true, "status": status, "body": body })
                }
                Err(e) => serde_json::json!({
                    "id": id, "ok": false, "status": 0,
                    "error": format!("本机 API 调用失败: {e}")
                }),
            }
        })
        .await
        .unwrap_or_else(|e| serde_json::json!({ "id": "", "ok": false, "error": e.to_string() }));

        let resp_len = resp.to_string().len();
        let ok = resp["ok"].as_bool().unwrap_or(false);
        if !reply_addr.is_null() {
            let im = self
                .comm
                .create_custom_message("diap-hub", None, &resp.to_string(), MSG_RESP);
            if let Err(e) = self.comm.send_to_addr_json(reply_addr, im).await {
                eprintln!("[diap] 回响应失败: {e}");
            }
        }
        // 对端经 QUIC 打进来的这次请求也留痕（in）
        crate::transport_history::record(
            "in",
            &msg.from_did,
            "diap/iroh-quic",
            &method_log,
            &path_log,
            req_len,
            resp_len,
            ok,
            now_ms().saturating_sub(started_in),
        );
    }

    /// 若该 url 有 DIAP 地址则走隧道；否则返回 None（调用方回落 HTTP）。
    pub async fn request_url(
        &self,
        url: &str,
        method: &str,
        body: Option<serde_json::Value>,
    ) -> Option<Result<serde_json::Value, String>> {
        let (base, path) = split_http_url(url)?;
        let addr = self.peers.lock().await.get(&base)?.clone();
        Some(self.request(&addr, method, &path, body).await)
    }

    pub async fn request(
        &self,
        addr: &serde_json::Value,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let started = now_ms();
        let peer = addr["id"].as_str().unwrap_or("unknown").to_string();
        let req_bytes = body.as_ref().map(|b| b.to_string().len()).unwrap_or(0);
        let id = format!("http-{}", now_ms());
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let payload = serde_json::json!({
            "id": id, "method": method, "path": path,
            "body": body, "reply_addr": self.address_json(),
        });
        let im = self
            .comm
            .create_custom_message("diap-hub", None, &payload.to_string(), MSG_REQ);

        let out = match self.comm.send_to_addr_json(addr.clone(), im).await {
            Err(e) => {
                self.pending.lock().await.remove(&id);
                Err(format!("DIAP 发送失败: {e}"))
            }
            Ok(()) => match tokio::time::timeout(REQ_TIMEOUT, rx).await {
                Ok(Ok(v)) => {
                    if v["ok"].as_bool().unwrap_or(false) {
                        Ok(v["body"].clone())
                    } else {
                        Err(v["error"]
                            .as_str()
                            .unwrap_or("对端 API 调用失败")
                            .to_string())
                    }
                }
                Ok(Err(_)) => Err("DIAP 响应通道关闭".to_string()),
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    Err(format!("DIAP 请求超时 ({}s)", REQ_TIMEOUT.as_secs()))
                }
            },
        };
        // 2026-11-13: QUIC 隧道上的每次收发都留历史（失败也记，便于回溯）
        let (resp_bytes, ok) = match &out {
            Ok(v) => (v.to_string().len(), true),
            Err(_) => (0, false),
        };
        crate::transport_history::record(
            "out",
            &peer,
            "diap/iroh-quic",
            method,
            path,
            req_bytes,
            resp_bytes,
            ok,
            now_ms().saturating_sub(started),
        );
        out
    }
}

/// GET /api/diap/addr → 本机 DIAP NodeId + 完整地址 + 已登记对端。
pub async fn diap_addr() -> axum::Json<serde_json::Value> {
    match global() {
        Some(hub) => axum::Json(serde_json::json!({
            "ok": true,
            "enabled": true,
            "node_id": hub.node_id(),
            "address": hub.address_json(),
            "peers": hub.peers_snapshot().await,
        })),
        None => axum::Json(serde_json::json!({
            "ok": false,
            "enabled": false,
            "error": "DIAP 未启用 (启动时设 BOLLOON_DIAP=1, 且编译 feature diap-backend)"
        })),
    }
}
