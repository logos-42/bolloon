//! 多智能体群聊 — 参与决策 + 消息模型
//!
//! 对应 TS 版 group-autopilot.ts 的核心判据：
//! - 只在被 @ 或有人提问/请人做事时开口（闲聊一律静默）
//! - 冷却：每小时上限
//! - seen 幂等：已见过的消息不重复响应

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// 群组 ID
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct GroupId(pub String);

impl GroupId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }
}

/// 群成员（agent 或人）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupMember {
    pub id: String,
    pub name: String,
    pub did: Option<String>,
    pub is_agent: bool,
}

/// 群消息
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GroupMessage {
    pub id: String,
    pub group_id: GroupId,
    pub sender: String,
    pub content: String,
    /// @ 的成员 id 列表
    pub mentions: Vec<String>,
    /// 回复锚点（消息 id）
    pub reply_to: Option<String>,
    pub timestamp: chrono::DateTime<chrono::Utc>,
}

/// 开口决策（纯函数簇）
#[derive(Debug)]
pub struct Autopilot {
    /// 已见消息 id（幂等）
    seen: Arc<Mutex<HashSet<String>>>,
    /// 本小时发言计数
    hourly_count: Arc<Mutex<(u64, u32)>>, // (epoch_hour, count)
    /// 每小时上限
    hourly_limit: u32,
    /// 连续冷却（每条触发后的静默时长）
    cooldown: Duration,
    last_spoke: Arc<Mutex<Option<Instant>>>,
}

impl Default for Autopilot {
    fn default() -> Self {
        Self::new(4, Duration::from_secs(15))
    }
}

impl Autopilot {
    pub fn new(hourly_limit: u32, cooldown: Duration) -> Self {
        Self {
            seen: Arc::new(Mutex::new(HashSet::new())),
            hourly_count: Arc::new(Mutex::new((0, 0))),
            hourly_limit,
            cooldown,
            last_spoke: Arc::new(Mutex::new(None)),
        }
    }

    /// should_speak 的核心判据：
    /// 1. 消息没见过（幂等）
    /// 2. 被 @ 或含提问/请人做事信号
    /// 3. 未超每小时上限
    /// 4. 未在冷却期
    pub async fn should_speak(
        &self,
        msg: &GroupMessage,
        self_id: &str,
    ) -> SpeakDecision {
        // 1. 幂等
        let mut seen = self.seen.lock().await;
        if seen.contains(&msg.id) {
            return SpeakDecision::Skip(SkipReason::AlreadySeen);
        }
        seen.insert(msg.id.clone());
        drop(seen);

        // 2. 直接要求
        let mentioned = msg.mentions.iter().any(|m| m == self_id);
        let addressed = msg.reply_to.is_none() && mentioned;
        let asks_anyone = is_asking(msg);
        if !addressed && !asks_anyone {
            return SpeakDecision::Skip(SkipReason::NotAddressed);
        }

        // 3. 每小时上限
        let epoch_hour = now_epoch_hour();
        {
            let mut hc = self.hourly_count.lock().await;
            if hc.0 != epoch_hour {
                hc.0 = epoch_hour;
                hc.1 = 0;
            }
            if hc.1 >= self.hourly_limit {
                return SpeakDecision::Skip(SkipReason::HourlyLimit);
            }
        }

        // 4. 冷却
        if let Some(last) = *self.last_spoke.lock().await {
            if last.elapsed() < self.cooldown {
                return SpeakDecision::Skip(SkipReason::Cooldown);
            }
        }

        SpeakDecision::Speak
    }

    /// 发言后登记（更新冷却与计数）
    pub async fn note_spoke(&self) {
        *self.last_spoke.lock().await = Some(Instant::now());
        let epoch_hour = now_epoch_hour();
        let mut hc = self.hourly_count.lock().await;
        if hc.0 != epoch_hour {
            hc.0 = epoch_hour;
            hc.1 = 0;
        }
        hc.1 += 1;
    }

    /// 重置 seen（测试/新会话）
    pub async fn reset(&self) {
        self.seen.lock().await.clear();
    }
}

fn now_epoch_hour() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 3600)
        .unwrap_or(0)
}

/// 开口决策
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeakDecision {
    Speak,
    Skip(SkipReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkipReason {
    AlreadySeen,
    NotAddressed,
    HourlyLimit,
    Cooldown,
}

/// 提问/请人做事信号（纯函数，无 I/O）
/// 命中: 问句(？/?/吗/怎么/如何/谁) 或 祈使(请/帮我/你能不能/做一下)
pub fn is_asking(msg: &GroupMessage) -> bool {
    let c = msg.content.trim();
    if c.is_empty() {
        return false;
    }
    c.contains('？')
        || c.contains('?')
        || c.contains('吗')
        || c.contains("怎么")
        || c.contains("如何")
        || c.contains("谁")
        || c.contains("请")
        || c.contains("帮我")
        || c.contains("你能不能")
        || c.contains("做一下")
        || c.contains("可以")
}

/// 发言裁剪：超长消息截断（保留头尾，总长 ≤ max 字符）
pub fn trim_for_speak(content: &str, max: usize) -> String {
    let chars: Vec<char> = content.chars().collect();
    if chars.len() <= max {
        return content.to_string();
    }
    let max = max.max(4);
    let head_chars = max / 2 - 1; // 留给 … 1 字符
    let tail_chars = max - head_chars - 1;
    let head: String = chars[..head_chars].iter().collect();
    let tail: String = chars[chars.len() - tail_chars..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(id: &str, content: &str, mentions: Vec<String>) -> GroupMessage {
        GroupMessage {
            id: id.to_string(),
            group_id: GroupId::new("g1"),
            sender: "alice".into(),
            content: content.to_string(),
            mentions,
            reply_to: None,
            timestamp: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn silent_on_chitchat() {
        let ap = Autopilot::default();
        let d = ap
            .should_speak(&msg("m1", "今天天气不错", vec![]), "agent-1")
            .await;
        assert_eq!(d, SpeakDecision::Skip(SkipReason::NotAddressed));
    }

    #[tokio::test]
    async fn speaks_when_mentioned() {
        let ap = Autopilot::default();
        let d = ap
            .should_speak(&msg("m2", "你好", vec!["agent-1".into()]), "agent-1")
            .await;
        assert_eq!(d, SpeakDecision::Speak);
    }

    #[tokio::test]
    async fn speaks_on_question() {
        let ap = Autopilot::default();
        let d = ap
            .should_speak(&msg("m3", "谁能帮忙查一下数据？", vec![]), "agent-1")
            .await;
        assert_eq!(d, SpeakDecision::Speak, "提问应触发");
    }

    #[tokio::test]
    async fn idempotent_seen() {
        let ap = Autopilot::default();
        let m = msg("m4", "帮我一下", vec![]);
        assert_eq!(
            ap.should_speak(&m, "agent-1").await,
            SpeakDecision::Speak
        );
        // 同一消息再来 → skip
        let d2 = ap.should_speak(&m, "agent-1").await;
        assert!(matches!(d2, SpeakDecision::Skip(SkipReason::AlreadySeen)));
    }

    #[tokio::test]
    async fn hourly_limit_enforced() {
        let ap = Autopilot::new(2, Duration::from_millis(0));
        for i in 0..3 {
            let d = ap
                .should_speak(&msg(&format!("m{i}"), "请帮我", vec![]), "agent-1")
                .await;
            ap.note_spoke().await;
            if i < 2 {
                assert_eq!(d, SpeakDecision::Speak, "前两条应开口");
            } else {
                assert!(matches!(d, SpeakDecision::Skip(SkipReason::HourlyLimit)));
            }
        }
    }

    #[test]
    fn asking_detection() {
        assert!(is_asking(&msg("a", "你能帮我做一下吗", vec![])));
        assert!(is_asking(&msg("b", "如何解决？", vec![])));
        assert!(!is_asking(&msg("c", "好的", vec![])));
    }

    #[test]
    fn trim_keeps_head_tail() {
        let long = "x".repeat(2000);
        let t = trim_for_speak(&long, 100);
        // 100 字符 = 49 头 + … + 50 尾（len() 是字节, '…' 占 3 字节 → 按字符数断言）
        assert!(t.chars().count() <= 100, "裁剪后不应超上限, 实际 {}", t.chars().count());
        assert!(t.starts_with(&"x".repeat(49)), "应保留头部");
        assert!(t.ends_with(&"x".repeat(50)), "应保留尾部");
        assert!(t.contains('…'), "应有省略号");
    }
}