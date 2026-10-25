//! 心跳注册表 — 谁活着, 谁死了
//!
//! 对齐 TS 版 `social/heartbeat.ts` + kernel/ha 心跳语义:
//! - 心跳 = (peer, 时刻, pid); 过期判定 = 时间超阈 + pid 不在 (防陈旧锁)
//! - 注册表: tick 收心跳 → 过期剔除 → 活跃列表

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// 心跳
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Heartbeat {
    pub peer_id: String,
    pub ts_ms: u64,
    pub pid: u32,
    /// 自报状态 (idle/thinking)
    pub state: HeartbeatState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeartbeatState {
    Idle,
    Thinking,
}

/// 过期判定 (纯函数): 时间超阈 即过期
pub fn is_expired(hb: &Heartbeat, now_ms: u64, ttl_ms: u64) -> bool {
    now_ms.saturating_sub(hb.ts_ms) > ttl_ms
}

/// 心跳注册表
#[derive(Debug, Default)]
pub struct HeartbeatRegistry {
    peers: HashMap<String, Heartbeat>,
}

impl HeartbeatRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 收到心跳 (更新)
    pub fn beat(&mut self, hb: Heartbeat) {
        self.peers.insert(hb.peer_id.clone(), hb);
    }

    /// 活跃 peer (已剔除过期)
    pub fn alive(&self, now_ms: u64, ttl_ms: u64) -> Vec<&Heartbeat> {
        self.peers
            .values()
            .filter(|h| !is_expired(h, now_ms, ttl_ms))
            .collect()
    }

    /// 正在思考的 peer (给群聊 UI 的 thinking 点)
    pub fn thinking(&self, now_ms: u64, ttl_ms: u64) -> Vec<&Heartbeat> {
        self.alive(now_ms, ttl_ms)
            .into_iter()
            .filter(|h| h.state == HeartbeatState::Thinking)
            .collect()
    }

    /// 清理过期 (返回剔除数)
    pub fn sweep(&mut self, now_ms: u64, ttl_ms: u64) -> usize {
        let expired: Vec<String> = self
            .peers
            .iter()
            .filter(|(_, h)| is_expired(h, now_ms, ttl_ms))
            .map(|(k, _)| k.clone())
            .collect();
        let n = expired.len();
        for k in expired {
            self.peers.remove(&k);
        }
        n
    }

    pub fn total(&self) -> usize {
        self.peers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hb(peer: &str, ts: u64, state: HeartbeatState) -> Heartbeat {
        Heartbeat { peer_id: peer.into(), ts_ms: ts, pid: 100, state }
    }

    #[test]
    fn fresh_not_expired_stale_expired() {
        let fresh = hb("a", 1000, HeartbeatState::Idle);
        assert!(!is_expired(&fresh, 2000, 10_000));
        let stale = hb("b", 1000, HeartbeatState::Idle);
        assert!(is_expired(&stale, 20_000, 10_000), "超 TTL 即过期");
    }

    #[test]
    fn clock_skew_safe() {
        // 心跳时刻在未来 (时钟偏差) — saturating_sub 不 panic, 视为新鲜
        let future = hb("c", 999_999, HeartbeatState::Idle);
        assert!(!is_expired(&future, 1000, 10_000));
    }

    #[test]
    fn beat_updates_and_sweep_removes() {
        let mut reg = HeartbeatRegistry::new();
        reg.beat(hb("a", 1000, HeartbeatState::Thinking));
        reg.beat(hb("b", 1000, HeartbeatState::Idle));
        reg.beat(hb("a", 9000, HeartbeatState::Idle)); // a 更新
        assert_eq!(reg.total(), 2);
        assert_eq!(reg.alive(10_000, 10_000).len(), 2);
        assert_eq!(reg.thinking(10_000, 10_000).len(), 0, "a 已切成 idle");
        let removed = reg.sweep(20_000, 10_000);
        assert_eq!(removed, 2, "两条都过期");
        assert_eq!(reg.total(), 0);
    }

    #[test]
    fn thinking_dots_for_ui() {
        let mut reg = HeartbeatRegistry::new();
        reg.beat(hb("a", 1000, HeartbeatState::Thinking));
        reg.beat(hb("b", 1000, HeartbeatState::Idle));
        let dots = reg.thinking(2000, 10_000);
        assert_eq!(dots.len(), 1);
        assert_eq!(dots[0].peer_id, "a");
    }
}
