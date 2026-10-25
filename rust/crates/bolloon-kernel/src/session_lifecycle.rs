//! 会话规则（持久化映射 / 过滤水合 / 运行种子合并）
//!
//! 对应 TS 版 kernel/session-lifecycle.ts：
//! - 会话按 channel 持久化（映射表）
//! - 水合时过滤内部消息（reply-hygiene 判据：`isInternalChatter` 的 Rust 版）
//! - 新 run 的种子上下文与历史合并（composeRunSeed）

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

/// Session ID
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
    pub fn random() -> Self {
        Self(Uuid::new_v4().to_string())
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 一条会话消息（水合后）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionMessage {
    pub role: String, // "user" | "assistant" | "system" | "tool"
    pub content: String,
    pub tool_call_id: Option<String>,
    pub internal: bool,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

/// 会话状态（内存态 + 端口持久化）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionState {
    pub id: SessionId,
    pub channel_id: String,
    pub messages: Vec<SessionMessage>,
    pub run_seed: Option<serde_json::Value>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

impl SessionState {
    pub fn new(id: SessionId, channel_id: impl Into<String>) -> Self {
        let now = chrono::Utc::now();
        Self {
            id,
            channel_id: channel_id.into(),
            messages: vec![],
            run_seed: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// 会话事件
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum SessionEvent {
    Saved(SessionId),
    Hydrated(SessionId, usize), // 第二个字段: 消息条数
    SeedComposed(SessionId),
}

/// 会话持久化端口
#[async_trait::async_trait]
pub trait SessionStore: Send + Sync {
    async fn save(&self, state: &SessionState) -> anyhow::Result<()>;
    async fn load(&self, id: &SessionId) -> anyhow::Result<Option<SessionState>>;
}

/// 内存 store（默认）
#[derive(Debug, Default)]
pub struct MemorySessionStore {
    map: Arc<Mutex<HashMap<SessionId, SessionState>>>,
}

#[async_trait::async_trait]
impl SessionStore for MemorySessionStore {
    async fn save(&self, state: &SessionState) -> anyhow::Result<()> {
        self.map
            .lock()
            .await
            .insert(state.id.clone(), state.clone());
        Ok(())
    }
    async fn load(&self, id: &SessionId) -> anyhow::Result<Option<SessionState>> {
        Ok(self.map.lock().await.get(id).cloned())
    }
}

/// 会话规则（纯函数簇 + 状态）
pub struct SessionLifecycle {
    store: Box<dyn SessionStore>,
    sessions: Arc<Mutex<HashMap<String, SessionState>>>, // key: channel_id
}

impl std::fmt::Debug for SessionLifecycle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionLifecycle")
            .field("store", &"<dyn SessionStore>")
            .field("sessions", &self.sessions)
            .finish()
    }
}

impl SessionLifecycle {
    pub fn new(store: Box<dyn SessionStore>) -> Self {
        Self {
            store,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn in_memory() -> Self {
        Self::new(Box::new(MemorySessionStore::default()))
    }

    /// 按 channel 取会话（无则建）
    pub async fn for_channel(&self, channel_id: &str) -> SessionState {
        let mut map = self.sessions.lock().await;
        match map.get(channel_id) {
            Some(s) => s.clone(),
            None => {
                let s = SessionState::new(SessionId::random(), channel_id);
                map.insert(channel_id.to_string(), s.clone());
                s
            }
        }
    }

    /// append 一条消息 + 落盘（channel 不存在则自动建会话）
    pub async fn append(&self, channel_id: &str, msg: SessionMessage) -> anyhow::Result<()> {
        let mut map = self.sessions.lock().await;
        match map.get_mut(channel_id) {
            Some(s) => {
                s.messages.push(msg);
                s.updated_at = chrono::Utc::now();
                let snap = s.clone();
                self.store.save(&snap).await?;
            }
            None => {
                let mut s = SessionState::new(SessionId::random(), channel_id);
                s.messages.push(msg);
                s.updated_at = chrono::Utc::now();
                let snap = s.clone();
                self.store.save(&snap).await?;
                map.insert(channel_id.to_string(), s);
            }
        }
        Ok(())
    }

    /// 过滤水合：去掉 internal 标记的消息（reply-hygiene）
    pub fn hydrate_filtered(&self, state: &SessionState) -> Vec<SessionMessage> {
        state
            .messages
            .iter()
            .filter(|m| !m.internal)
            .cloned()
            .collect()
    }

    /// composeRunSeed：把历史尾部 + 运行种子合并成新 run 的初始上下文
    /// 规则：取最近 N 条（默认 20），与 run_seed 合并
    pub fn compose_run_seed(&self, state: &SessionState, tail: usize) -> serde_json::Value {
        let history: Vec<SessionMessage> = state.messages.iter().rev().take(tail).rev().cloned().collect();
        serde_json::json!({
            "history": history,
            "seed": state.run_seed,
            "composed_at": chrono::Utc::now(),
        })
    }

    pub async fn set_run_seed(
        &self,
        channel_id: &str,
        seed: serde_json::Value,
    ) -> anyhow::Result<()> {
        let mut map = self.sessions.lock().await;
        match map.get_mut(channel_id) {
            Some(s) => {
                s.run_seed = Some(seed);
                s.updated_at = chrono::Utc::now();
                let snap = s.clone();
                self.store.save(&snap).await?;
            }
            None => {
                let mut s = SessionState::new(SessionId::random(), channel_id);
                s.run_seed = Some(seed);
                s.updated_at = chrono::Utc::now();
                let snap = s.clone();
                self.store.save(&snap).await?;
                map.insert(channel_id.to_string(), s);
            }
        }
        Ok(())
    }
}

/// 内部消息判据（reply-hygiene 的纯函数）
/// 按行首模块标签锚定 —— 与 TS 版 log-gate 判据同口径：
/// `[pi-ai timing]` / `[identity]` / `[session-note]` / `[react-harness]` / `[kv-server]` / `[loadSkills]` 等
pub fn is_internal_chatter(line: &str) -> bool {
    let trimmed = line.trim_start();
    // 允许标签前有一个严重度字形（⚠ / ✗ 等）；去掉字形后可能带前导空格，再 trim
    let body = trimmed
        .strip_prefix('⚠')
        .or_else(|| trimmed.strip_prefix('✗'))
        .or_else(|| trimmed.strip_prefix('!'))
        .or_else(|| trimmed.strip_prefix('⛔'))
        .unwrap_or(trimmed)
        .trim_start();

    const TAGS: &[&str] = &[
        "[pi-ai timing]",
        "[identity]",
        "[session-note]",
        "[react-harness]",
        "[kv-server]",
        "[loadSkills]",
        "[DocumentStore]",
        "[v3-",
        "[supervisor-host]",
        "[PiAgent] reviewFinal",
        "📚 复盘:",
    ];
    TAGS.iter().any(|t| body.starts_with(t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn channel_session_created_and_appended() {
        let lc = SessionLifecycle::in_memory();
        let s = lc.for_channel("ch-1").await;
        assert!(s.messages.is_empty());

        lc.append(
            "ch-1",
            SessionMessage {
                role: "user".into(),
                content: "你好".into(),
                tool_call_id: None,
                internal: false,
                timestamp: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();

        let s2 = lc.for_channel("ch-1").await;
        assert_eq!(s2.messages.len(), 1);
    }

    #[tokio::test]
    async fn hydrate_filters_internal() {
        let lc = SessionLifecycle::in_memory();
        lc.append(
            "ch-2",
            SessionMessage {
                role: "assistant".into(),
                content: "这是真实回复".into(),
                tool_call_id: None,
                internal: false,
                timestamp: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();
        lc.append(
            "ch-2",
            SessionMessage {
                role: "assistant".into(),
                content: "[pi-ai timing] 调用耗时 123ms".into(),
                tool_call_id: None,
                internal: true,
                timestamp: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();

        let s = lc.for_channel("ch-2").await;
        let filtered = lc.hydrate_filtered(&s);
        assert_eq!(filtered.len(), 1, "内部遥测消息应被过滤");
        assert_eq!(filtered[0].content, "这是真实回复");
    }

    #[test]
    fn internal_chatter_judgement() {
        assert!(is_internal_chatter("[identity] 身份已复用"));
        assert!(is_internal_chatter("⚠ [identity] 身份已复用"));
        assert!(is_internal_chatter("📚 复盘: 本轮总结"));
        assert!(!is_internal_chatter("用户正文内容"));
        assert!(!is_internal_chatter("[未知标签] 不是内部"));
        assert!(!is_internal_chatter(""));
    }

    #[tokio::test]
    async fn run_seed_merged() {
        let lc = SessionLifecycle::in_memory();
        lc.append(
            "ch-3",
            SessionMessage {
                role: "user".into(),
                content: "任务：写报告".into(),
                tool_call_id: None,
                internal: false,
                timestamp: chrono::Utc::now(),
            },
        )
        .await
        .unwrap();
        lc.set_run_seed("ch-3", serde_json::json!({"goal": "报告"}))
            .await
            .unwrap();

        let s = lc.for_channel("ch-3").await;
        let seed = lc.compose_run_seed(&s, 20);
        assert_eq!(seed["history"].as_array().unwrap().len(), 1);
        assert_eq!(seed["seed"]["goal"], "报告");
    }
}