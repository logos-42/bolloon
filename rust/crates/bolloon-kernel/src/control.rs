//! 命令式控制面（pause / resume / abort / recover）
//!
//! 纯机制：不判业务，只维护三态状态机，供 ChannelActor / Agent 轮询。

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

/// 控制状态机
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
    Running = 0,
    Paused = 1,
    Aborted = 2,
}

impl ControlState {
    fn from_u8(v: u8) -> Self {
        match v {
            0 => Self::Running,
            1 => Self::Paused,
            _ => Self::Aborted,
        }
    }
}

/// 控制命令（发给 Actor 的命令通道）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum ControlCommand {
    Pause,
    Resume,
    Abort,
    Recover,
}

/// K-control：进程内共享的控制面。
/// Actor 每轮轮询 is_paused/is_aborted；命令是瞬时写、轮询读的廉价设计。
#[derive(Debug, Default)]
pub struct Control {
    state: AtomicU8,
}

impl Control {
    pub fn new() -> Self {
        Self {
            state: AtomicU8::new(ControlState::Running as u8),
        }
    }

    pub fn state(&self) -> ControlState {
        ControlState::from_u8(self.state.load(Ordering::Acquire))
    }

    pub fn is_paused(&self) -> bool {
        self.state() == ControlState::Paused
    }

    pub fn is_aborted(&self) -> bool {
        self.state() == ControlState::Aborted
    }

    pub fn is_running(&self) -> bool {
        self.state() == ControlState::Running
    }

    pub fn pause(&self) {
        self.state.store(ControlState::Paused as u8, Ordering::Release);
        tracing::debug!("control: paused");
    }

    pub fn resume(&self) {
        self.state.store(ControlState::Running as u8, Ordering::Release);
        tracing::debug!("control: resumed");
    }

    pub fn abort(&self) {
        self.state.store(ControlState::Aborted as u8, Ordering::Release);
        tracing::debug!("control: aborted");
    }

    /// recover = 回到 Running（Aborted 态不可 recover，需先新建）
    pub fn recover(&self) -> Result<(), ControlError> {
        if self.state() == ControlState::Aborted {
            return Err(ControlError::CannotRecoverAborted);
        }
        self.resume();
        Ok(())
    }

    pub fn apply(&self, cmd: &ControlCommand) {
        match cmd {
            ControlCommand::Pause => self.pause(),
            ControlCommand::Resume => self.resume(),
            ControlCommand::Abort => self.abort(),
            ControlCommand::Recover => {
                let _ = self.recover();
            }
        }
    }
}

/// 控制面句柄（注入给外部调用方——CLI/Web/supervisor 用）
#[derive(Debug, Clone)]
pub struct ControlHandle {
    inner: Arc<Control>,
}

impl ControlHandle {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Control::new()),
        }
    }

    pub fn inner(&self) -> &Arc<Control> {
        &self.inner
    }

    pub fn pause(&self) {
        self.inner.pause();
    }
    pub fn resume(&self) {
        self.inner.resume();
    }
    pub fn abort(&self) {
        self.inner.abort();
    }
    pub fn recover(&self) -> Result<(), ControlError> {
        self.inner.recover()
    }
    pub fn state(&self) -> ControlState {
        self.inner.state()
    }
}

impl Default for ControlHandle {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("已 abort 的控制面不可 recover（需新建）")]
    CannotRecoverAborted,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_machine_transitions() {
        let c = Control::new();
        assert!(c.is_running());

        c.pause();
        assert!(c.is_paused());
        assert!(!c.is_running());

        c.resume();
        assert!(c.is_running());

        c.abort();
        assert!(c.is_aborted());
        assert!(c.recover().is_err(), "aborted 不可 recover");
    }

    #[test]
    fn handle_roundtrip() {
        let h = ControlHandle::new();
        h.pause();
        assert_eq!(h.state(), ControlState::Paused);
        h.resume();
        assert_eq!(h.state(), ControlState::Running);
    }

    #[tokio::test]
    async fn actor_halts_when_paused() {
        use crate::channel_actor::{ChannelActor, ChannelEvent, ChannelId};
        use crate::channel_actor::EventKind::UserMessage;

        let ctrl = Arc::new(Control::new());
        let cnt = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let cnt2 = cnt.clone();
        let channel = ChannelId::new("pause-test");

        let actor = ChannelActor::new(
            channel.clone(),
            8,
            move |ev: ChannelEvent| {
                let cnt = cnt2.clone();
                async move {
                    cnt.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = ev;
                }
            },
            ctrl.clone(),
        );
        let mb = actor.mailbox();
        let run = tokio::spawn(actor.run());

        ctrl.pause();
        // 暂停期间投递：堆积不处理
        for _ in 0..3 {
            let _ = mb
                .enqueue(ChannelEvent::new(channel.clone(), UserMessage, None))
                .await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        assert_eq!(
            cnt.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "paused 期间不消费"
        );

        ctrl.resume();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(
            cnt.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "resume 后堆积的事件被消费"
        );
        run.abort();
    }
}