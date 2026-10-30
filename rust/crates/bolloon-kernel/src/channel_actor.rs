//! K5 ChannelActor + SerialMailbox
//!
//! 同 channel 串行、异 channel 并发、ALS 重入（Actor-Like Serialization）。
//! 所有入口（Web/CLI/P2P/cron/supervisor）只能投递事件，不能直接调 prompt()。

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::control::Control;

/// 通道 ID（对应 TS 的 channelId）
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct ChannelId(pub String);

impl ChannelId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    pub fn random() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl std::fmt::Display for ChannelId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 通道事件（外部入口投递进来的东西）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ChannelEvent {
    pub id: Uuid,
    pub channel: ChannelId,
    pub kind: EventKind,
    pub payload: Option<serde_json::Value>,
    /// ALS 重入标记：同一 channel 的同一逻辑轮内的嵌套事件
    pub reentrant: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum EventKind {
    UserMessage,
    P2PMessage,
    CronTick,
    SupervisorCommand,
    Followup,
    External,
}

impl ChannelEvent {
    pub fn new(channel: ChannelId, kind: EventKind, payload: Option<serde_json::Value>) -> Self {
        Self {
            id: Uuid::new_v4(),
            channel,
            kind,
            payload,
            reentrant: false,
        }
    }
}

/// K5 的 mailbox 规则：
/// - enqueue 永不被拒（无界等待，调用方不阻塞——用 tokio mpsc 自带 backpressure 语义但容量 0 = rendezvous
///   会阻塞发送方；这里用大容量 + try_send 失败返回 busy）
/// - 同 channel 的事件按入队顺序串行出队
/// - 异 channel 相互独立（各自一个 mpsc，天然并发）
#[derive(Debug, Clone)]
pub struct SerialMailbox {
    tx: mpsc::Sender<ChannelEvent>,
}

impl SerialMailbox {
    pub fn new(tx: mpsc::Sender<ChannelEvent>) -> Self {
        Self { tx }
    }

    /// 入队。容量满时返回 Err(事件)，由调用方决定重试/丢弃。
    pub async fn enqueue(&self, event: ChannelEvent) -> Result<(), ChannelEvent> {
        self.tx.send(event).await.map_err(|e| e.0)
    }
}

/// ChannelActor 的对外句柄：入口方持有，用来投递事件与订阅事件流
#[derive(Debug, Clone)]
pub struct ChannelHandle {
    pub id: ChannelId,
    mailbox: Arc<Mutex<Option<SerialMailbox>>>,
}

impl ChannelHandle {
    pub fn new(id: ChannelId) -> Self {
        Self {
            id,
            mailbox: Arc::new(Mutex::new(None)),
        }
    }

    pub fn attach(&self, mailbox: SerialMailbox) {
        let mut slot = self.mailbox.blocking_lock();
        *slot = Some(mailbox);
    }

    /// async 版 attach（在 async context 里用，禁 blocking_lock）
    pub async fn attach_async(&self, mailbox: SerialMailbox) {
        let mut slot = self.mailbox.lock().await;
        *slot = Some(mailbox);
    }

    pub async fn enqueue(&self, event: ChannelEvent) -> Result<(), ChannelEvent> {
        let slot = self.mailbox.lock().await;
        match slot.as_ref() {
            Some(mb) => mb.enqueue(event).await,
            None => Err(event), // 未注入即拒（对应 TS 的 transport 未注入即拒语义）
        }
    }

    pub fn channel_id(&self) -> &ChannelId {
        &self.id
    }
}

/// K5 ChannelActor：一个 channel 一条执行循环，串行消费 mailbox
///
/// 构造参数:
/// - id: 通道 ID
/// - capacity: mailbox 容量
/// - handler: 事件处理闭包（由 agent 层注入——kernel 不判业务，只做串行化与生命周期）
/// - control: 控制面句柄（pause/resume/abort 由 control 注入, actor 只响应）
pub struct ChannelActor<H, E>
where
    H: FnMut(ChannelEvent) -> E,
    E: std::future::Future<Output = ()>,
{
    id: ChannelId,
    mailbox_tx: mpsc::Sender<ChannelEvent>,
    mailbox_rx: Option<mpsc::Receiver<ChannelEvent>>,
    handler: Option<H>,
    control: Arc<Control>,
    running: Arc<Mutex<bool>>,
}

impl<H, E> ChannelActor<H, E>
where
    H: FnMut(ChannelEvent) -> E + Send + 'static,
    E: std::future::Future<Output = ()> + Send + 'static,
{
    pub fn new(id: ChannelId, capacity: usize, handler: H, control: Arc<Control>) -> Self {
        let (tx, rx) = mpsc::channel(capacity);
        Self {
            id,
            mailbox_tx: tx,
            mailbox_rx: Some(rx),
            handler: Some(handler),
            control,
            running: Arc::new(Mutex::new(false)),
        }
    }

    /// 申请 mailbox（入口方用来投递）
    pub fn mailbox(&self) -> SerialMailbox {
        SerialMailbox::new(self.mailbox_tx.clone())
    }

    /// 启动消费循环。同 channel 串行：事件一个个处理，处理完再取下一个。
    /// 循环在 paused 时挂起消费（事件堆积在 mailbox，不丢）；aborted 时清空 mailbox 退出。
    pub async fn run(mut self) {
        let mut rx = self.mailbox_rx.take().expect("run 只能调用一次");
        {
            *self.running.lock().await = true;
        }
        loop {
            // 控制面检查：aborted → 清空退出
            if self.control.is_aborted() {
                tracing::debug!(channel = %self.id, "channel aborted, draining mailbox");
                while rx.recv().await.is_some() {}
                break;
            }
            // paused → 等待 resume 信号（spin 会烧 CPU，用短暂 sleep）
            if self.control.is_paused() {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            match rx.recv().await {
                Some(event) => {
                    if let Some(h) = self.handler.as_mut() {
                        h(event).await;
                    }
                }
                None => break, // 所有发送端关闭
            }
        }
        {
            *self.running.lock().await = false;
        }
    }

    /// 当前是否在跑（测试/度量用）
    pub async fn is_running(&self) -> bool {
        *self.running.lock().await
    }
}

/// 多通道注册表：管理所有活着的 ChannelActor，供统一入口投递
#[derive(Debug, Default)]
pub struct ChannelRegistry {
    channels: Arc<Mutex<HashMap<ChannelId, ChannelHandle>>>,
}

impl ChannelRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个通道（幂等：已存在则直接返回既有句柄）
    pub async fn register(&self, handle: ChannelHandle) -> ChannelHandle {
        let mut map = self.channels.lock().await;
        map.entry(handle.id.clone())
            .or_insert_with(|| handle.clone())
            .clone()
    }

    pub async fn get(&self, id: &ChannelId) -> Option<ChannelHandle> {
        self.channels.lock().await.get(id).cloned()
    }

    pub async fn unregister(&self, id: &ChannelId) {
        self.channels.lock().await.remove(id);
    }

    pub async fn len(&self) -> usize {
        self.channels.lock().await.len()
    }

    /// 与 `len()` 配套 (clippy: 有 len 就该有 is_empty)
    pub async fn is_empty(&self) -> bool {
        self.channels.lock().await.is_empty()
    }

    pub async fn ids(&self) -> Vec<ChannelId> {
        self.channels.lock().await.keys().cloned().collect()
    }

    /// 向某通道投递事件（统一入口投递点——所有外部入口只能走这里）
    pub async fn deliver(&self, event: ChannelEvent) -> Result<(), ChannelEvent> {
        let id = event.channel.clone();
        match self.channels.lock().await.get(&id) {
            Some(handle) => handle.enqueue(event).await,
            None => Err(event), // 通道不存在
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel_actor::EventKind::UserMessage;

    #[tokio::test]
    async fn same_channel_serial_ordering() {
        let control = Arc::new(Control::new());
        let channel = ChannelId::new("c1");
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();

        let actor = ChannelActor::new(
            channel.clone(),
            32,
            move |ev: ChannelEvent| {
                let seen = seen2.clone();
                async move {
                    let payload = ev.payload.unwrap_or(serde_json::json!(null));
                    seen.lock().await.push(payload.to_string());
                    // 模拟处理耗时 — 并发投递下顺序也必须保持
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            },
            control,
        );
        let mb = actor.mailbox();
        let run = tokio::spawn(actor.run());

        // 并发投 10 条，顺序必须保持
        let mut handles = vec![];
        for i in 0..10 {
            let mb2 = mb.clone();
            let ch = channel.clone();
            handles.push(tokio::spawn(async move {
                let _ = mb2
                    .enqueue(ChannelEvent::new(
                        ch,
                        UserMessage,
                        Some(serde_json::json!(i)),
                    ))
                    .await;
            }));
        }
        for h in handles {
            h.await.unwrap();
        }
        // 等消费完
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let got = seen.lock().await.clone();
        let expected: Vec<String> = (0..10).map(|i| serde_json::json!(i).to_string()).collect();
        assert_eq!(got, expected, "同 channel 消息必须按入队顺序串行处理");
        run.abort();
    }

    #[tokio::test]
    async fn registry_deliver_to_registered_channel() {
        let control = Arc::new(Control::new());
        let channel = ChannelId::new("reg-1");
        let delivered: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let delivered2 = delivered.clone();

        let actor = ChannelActor::new(
            channel.clone(),
            16,
            move |ev: ChannelEvent| {
                let delivered = delivered2.clone();
                async move {
                    if let Some(p) = ev.payload {
                        delivered.lock().await.push(p.to_string());
                    }
                }
            },
            control,
        );
        // 先取 mailbox 再 move actor 进 spawn
        let mb = actor.mailbox();
        let run = tokio::spawn(actor.run());

        let registry = ChannelRegistry::new();
        let handle = ChannelHandle::new(channel.clone());
        handle.attach_async(mb).await;
        registry.register(handle).await;

        for i in 0..5 {
            let ev = ChannelEvent::new(
                channel.clone(),
                UserMessage,
                Some(serde_json::json!(i)),
            );
            registry.deliver(ev).await.unwrap();
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let got = delivered.lock().await.clone();
        assert_eq!(got.len(), 5, "5 条事件都应被投递处理");
        assert_eq!(registry.len().await, 1);

        // 投给不存在的通道 → 拒绝
        let ghost = ChannelId::new("ghost");
        let ev = ChannelEvent::new(ghost.clone(), UserMessage, None);
        assert!(registry.deliver(ev).await.is_err(), "未知通道应拒绝投递");
        run.abort();
    }
}