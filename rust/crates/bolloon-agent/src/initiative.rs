//! 主动性 — 心跳驱动的"用户不在时也往前推"
//!
//! 精神层承诺的「空闲时主动做事」以前**没有执行链**: `heartbeat.rs` 只管谁活着 /
//! UI 的 thinking 点, `/heartbeat` 自报 "chat 没有调度器"。这里补的是**判定那一层**:
//!
//! - 输入只有三个数: 现在 / 用户最近一次说话 / 上一次主动出手
//! - 输出一个 `Verdict`: 出手, 还是"用户还在忙"/"刚出手过"
//! - 纯函数, 无 IO, 时钟偏差不 panic (`saturating_sub`)
//!
//! 真正的执行(补技能/推进待办)由调用方接 —— 判定与执行分开, 才好测、好解释。

/// 空闲窗口: 多久算用户走开 + 两次主动出手的最小间隔
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdleWindow {
    /// 用户无动静超过这个时长 = 可以主动出手
    pub idle_after_ms: u64,
    /// 两次主动出手之间的最小间隔 (防刷屏: 主动性不许变打扰)
    pub min_gap_ms: u64,
}

impl Default for IdleWindow {
    fn default() -> Self {
        // 10 分钟没人说话 + 半小时内不重复出手
        Self { idle_after_ms: 10 * 60_000, min_gap_ms: 30 * 60_000 }
    }
}

/// 判定结果 (带理由, 便于在 /api/stats 里如实说明为什么没动)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// 用户不在, 且够久没出手过 → 可以主动做事
    Act,
    /// 用户刚说过话 → 不打扰
    UserActive,
    /// 刚主动出手过 → 等下一次窗口
    TooSoon,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Act => "act",
            Verdict::UserActive => "user_active",
            Verdict::TooSoon => "too_soon",
        }
    }
}

/// 是否该主动出手 (纯函数)
///
/// `last_user_ms == 0` 表示还没记录过用户活动 (刚启动) —— 此时按"刚活跃"处理,
/// 不因为"没数据"就抢着动。
pub fn decide(now_ms: u64, last_user_ms: u64, last_action_ms: u64, w: IdleWindow) -> Verdict {
    if last_user_ms == 0 {
        return Verdict::UserActive;
    }
    if now_ms.saturating_sub(last_user_ms) < w.idle_after_ms {
        return Verdict::UserActive;
    }
    if last_action_ms != 0 && now_ms.saturating_sub(last_action_ms) < w.min_gap_ms {
        return Verdict::TooSoon;
    }
    Verdict::Act
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: u64 = 60_000;

    #[test]
    fn silent_while_user_present() {
        let w = IdleWindow::default();
        // 用户 1 分钟前说过话
        assert_eq!(decide(10 * M, 9 * M, 0, w), Verdict::UserActive);
        // 恰好到窗口边界 = 可以动 (>=)
        assert_eq!(decide(1 + 10 * M, 1, 0, w), Verdict::Act);
        // 差 1ms 到窗口 → 还不动
        assert_eq!(decide(10 * M, 1, 0, w), Verdict::UserActive);
    }

    #[test]
    fn acts_after_idle_threshold() {
        let w = IdleWindow::default();
        assert_eq!(decide(20 * M, 5 * M, 0, w), Verdict::Act);
    }

    #[test]
    fn respects_min_gap_between_actions() {
        let w = IdleWindow::default();
        // 用户离开 20 分钟, 但 5 分钟前刚主动过
        assert_eq!(decide(20 * M, 0 * M + 1, 15 * M, w), Verdict::TooSoon);
        // 超过最小间隔 → 可再出手
        assert_eq!(decide(50 * M, 1 * M, 15 * M, w), Verdict::Act);
    }

    #[test]
    fn no_history_means_do_not_act() {
        let w = IdleWindow::default();
        assert_eq!(decide(100 * M, 0, 0, w), Verdict::UserActive, "没记录用户活动 ⇒ 不抢着动");
    }

    #[test]
    fn clock_skew_is_safe() {
        let w = IdleWindow::default();
        // 时间戳在未来 (时钟偏差) —— saturating_sub 归零, 不 panic
        assert_eq!(decide(1 * M, 99 * M, 0, w), Verdict::UserActive);
    }
}