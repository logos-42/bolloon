//! 通话装配层 + Mock 服务商。
//!
//! `CallService` 负责：合规检查 → 调 `CallPort` → 驱动状态机 → 执行副作用 → 落审计。
//! `MockCallPort` 是**唯一可本机真跑**的实现：它按脚本产出对方事件，
//! 不连任何运营商，也**不产生真音频**。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;

use super::state::{check_dial, reduce, CallGuardError};
use super::{
    CallEffect, CallEvent, CallId, CallPort, CallPortError, CallRecord, CallResult, CallState,
    CallTarget,
};

/// AI 身份声明（必填；空字符串 = 不许外呼）
pub fn disclosure_for(reason: &str) -> String {
    format!(
        "你好，我是 Bolloon 的 AI 助手，这次联系是为：{}。需要人工请按 0，不需要请按 2。",
        reason.trim()
    )
}

/// 对方说话后的回复注入点。真接 LLM 时替换这里；Mock 阶段用固定文案并如实标注。
pub type ReplyFn = Arc<dyn Fn(&str, u32) -> String + Send + Sync>;

fn default_reply(_peer: &str, turn: u32) -> String {
    format!("我记下了（第 {turn} 轮）。这件事我会转给人工跟进，感谢你的时间。")
}

pub struct CallService {
    adapter: Arc<dyn CallPort>,
    records_path: PathBuf,
    reply: ReplyFn,
}

impl CallService {
    pub fn new(
        store_dir: impl Into<PathBuf>,
        adapter: Arc<dyn CallPort>,
    ) -> Self {
        let dir = store_dir.into();
        let _ = std::fs::create_dir_all(&dir);
        Self {
            adapter,
            records_path: dir.join("records.jsonl"),
            reply: Arc::new(default_reply),
        }
    }

    /// 注入真实回复生成器（接 LLM 时用）
    pub fn with_reply(mut self, f: ReplyFn) -> Self {
        self.reply = f;
        self
    }

    pub fn provider(&self) -> &str {
        self.adapter.provider()
    }

    pub fn records(&self) -> Vec<CallRecord> {
        let Ok(text) = std::fs::read_to_string(&self.records_path) else {
            return vec![];
        };
        text.lines()
            .filter_map(|l| serde_json::from_str::<CallRecord>(l).ok())
            .collect()
    }

    fn append_record(&self, r: &CallRecord) -> Result<(), String> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.records_path)
            .map_err(|e| format!("打开通话台账失败: {e}"))?;
        let line = serde_json::to_string(r).map_err(|e| e.to_string())?;
        f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        f.write_all(b"\n").map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 发起外呼（合规检查先于 Adapter）
    pub async fn dial(&self, target: &CallTarget) -> Result<CallId, CallGuardError> {
        let disclosure = disclosure_for(&target.reason);
        let history = self.records();
        check_dial(target, &history, &disclosure)?;

        let id = self
            .adapter
            .dial(target, &disclosure)
            .await
            .map_err(|e| CallGuardError::ProviderUnavailable(e.message))?;

        let rec = CallRecord {
            id: id.clone(),
            target_e164: target.e164.clone(),
            contact_id: target.contact_id.clone(),
            reason: target.reason.clone(),
            state: CallState::Dialing,
            timeline: vec!["dial_requested".into()],
            started_ms: chrono::Utc::now().timestamp_millis(),
            ended_ms: None,
        };
        let _ = self.append_record(&rec);
        Ok(id)
    }

    /// 驱动一次通话直到终态（Mock 阶段用于端到端验收）。
    ///
    /// 返回最终状态与完整时间线。超时被视为 `Timeout`，**不伪造接听**。
    pub async fn run(
        &self,
        id: &CallId,
        target: &CallTarget,
        per_event_timeout: Duration,
    ) -> (CallState, Vec<String>) {
        let disclosure = disclosure_for(&target.reason);
        let mut state = CallState::Dialing;
        let mut timeline: Vec<String> = vec!["dial_requested".into()];

        for _ in 0..32 {
            if state.is_terminal() {
                break;
            }
            let ev = match self.adapter.next_event(id, per_event_timeout).await {
                Ok(e) => e,
                Err(e) if e.kind == "timeout" => {
                    state = CallState::Failed { error: "timeout".into() };
                    timeline.push("timeout".into());
                    break;
                }
                Err(e) => {
                    state = CallState::Failed { error: e.kind.clone() };
                    timeline.push(format!("error:{}", e.kind));
                    break;
                }
            };

            let (next, effects) = reduce(&state, &ev, &disclosure);
            timeline.push(format!("{ev:?}"));
            state = next;

            // 对方说完一句 ⇒ 由 reply 生成回复（真 LLM 的注入点）
            if let CallEvent::PeerUtterance(text) = &ev {
                if let CallState::InProgress { turns } = &state {
                    let reply = (self.reply)(text, *turns);
                    if !reply.trim().is_empty() {
                        let _ = self.adapter.speak(id, &reply).await;
                        timeline.push("speak:reply".into());
                    }
                }
            }

            for eff in effects {
                match eff {
                    CallEffect::Speak(t) => {
                        let _ = self.adapter.speak(id, &t).await;
                        timeline.push("speak".into());
                    }
                    CallEffect::Hangup => {
                        let _ = self.adapter.hangup(id).await;
                        timeline.push("hangup".into());
                    }
                    CallEffect::Listen => timeline.push("listen".into()),
                    CallEffect::Log(l) => timeline.push(l),
                }
            }
        }

        let rec = CallRecord {
            id: id.clone(),
            target_e164: target.e164.clone(),
            contact_id: target.contact_id.clone(),
            reason: target.reason.clone(),
            state: state.clone(),
            timeline: timeline.clone(),
            started_ms: chrono::Utc::now().timestamp_millis(),
            ended_ms: Some(chrono::Utc::now().timestamp_millis()),
        };
        let _ = self.append_record(&rec);
        (state, timeline)
    }
}

/// Mock 服务商：按脚本产出事件，**不连运营商、不产生真音频**。
pub struct MockCallPort {
    /// 对方接下来会发生的件（顺序执行）；耗尽 ⇒ 挂断
    script: Vec<CallEvent>,
    sessions: Mutex<HashMap<String, usize>>,
    spoken: Mutex<Vec<(String, String)>>,
}

impl MockCallPort {
    pub fn new(script: Vec<CallEvent>) -> Self {
        Self {
            script,
            sessions: Mutex::new(HashMap::new()),
            spoken: Mutex::new(Vec::new()),
        }
    }

    /// 测试/验收用：取出 Mock 侧记录的全部播报
    pub fn spoken(&self) -> Vec<(String, String)> {
        self.spoken.lock().map(|v| v.clone()).unwrap_or_default()
    }
}

#[async_trait]
impl CallPort for MockCallPort {
    fn provider(&self) -> &str {
        "mock"
    }

    async fn dial(&self, _target: &CallTarget, _disclosure: &str) -> CallResult<CallId> {
        let id = CallId(format!("mock-{}", uuid::Uuid::new_v4()));
        if let Ok(mut s) = self.sessions.lock() {
            s.insert(id.0.clone(), 0);
        }
        Ok(id)
    }

    async fn next_event(&self, id: &CallId, _timeout: Duration) -> CallResult<CallEvent> {
        let mut s = self
            .sessions
            .lock()
            .map_err(|_| CallPortError::new("io", "mock 会话锁中毒"))?;
        let cursor = s.get_mut(&id.0).ok_or_else(|| {
            CallPortError::new("unknown_call", format!("没有这个通话: {id}"))
        })?;
        if *cursor < self.script.len() {
            let ev = self.script[*cursor].clone();
            *cursor += 1;
            Ok(ev)
        } else {
            Ok(CallEvent::Hangup { by: "peer".into() })
        }
    }

    async fn speak(&self, id: &CallId, text: &str) -> CallResult<()> {
        if let Ok(mut v) = self.spoken.lock() {
            v.push((id.0.clone(), text.to_string()));
        }
        Ok(())
    }

    async fn hangup(&self, id: &CallId) -> CallResult<()> {
        if let Ok(mut s) = self.sessions.lock() {
            s.remove(&id.0);
        }
        Ok(())
    }
}

/// 台账目录（`<home>/calls`）
pub fn calls_dir(home_root: &Path) -> PathBuf {
    home_root.join("calls")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_call_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn target(reason: &str) -> CallTarget {
        CallTarget {
            e164: "+8613800138000".into(),
            contact_id: None,
            reason: reason.into(),
        }
    }

    #[tokio::test]
    async fn mock_call_discloses_ai_then_completes() {
        let dir = tmp("e2e");
        let port = Arc::new(MockCallPort::new(vec![
            CallEvent::Ringing,
            CallEvent::Answered,
            CallEvent::PeerUtterance("你好，什么事？".into()),
            CallEvent::Hangup { by: "peer".into() },
        ]));
        let svc = CallService::new(&dir, port.clone());

        let id = svc.dial(&target("确认收货")).await.unwrap();
        let (state, timeline) = svc.run(&id, &target("确认收货"), Duration::from_millis(100)).await;

        assert!(matches!(state, CallState::Completed { .. }), "{state:?} {timeline:?}");

        let spoken = port.spoken();
        assert!(!spoken.is_empty(), "必须真的播报过");
        assert!(
            spoken[0].1.contains("AI 助手"),
            "第一条播报必须是 AI 身份声明: {:?}",
            spoken[0].1
        );
        assert!(
            timeline.iter().any(|t| t.contains("peer_turn:1")),
            "应记录对方轮次: {timeline:?}"
        );

        let recs = svc.records();
        assert_eq!(recs.len(), 2, "dial + run 各一条审计");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn decline_blocks_redial() {
        let dir = tmp("decline");
        let port = Arc::new(MockCallPort::new(vec![
            CallEvent::Ringing,
            CallEvent::Answered,
            CallEvent::PeerDtmf("2".into()),
        ]));
        let svc = CallService::new(&dir, port);

        let id = svc.dial(&target("推销")).await.unwrap();
        let (state, _) = svc.run(&id, &target("推销"), Duration::from_millis(100)).await;
        assert!(matches!(state, CallState::Completed { reason } if reason == "declined"));

        let e = svc.dial(&target("再推销")).await.unwrap_err();
        assert_eq!(e.kind(), "do_not_call", "拒绝过的号码不许重拨");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn missing_reason_is_refused_before_dialing() {
        let dir = tmp("noreason");
        let port = Arc::new(MockCallPort::new(vec![]));
        let svc = CallService::new(&dir, port);
        let e = svc.dial(&target("   ")).await.unwrap_err();
        assert_eq!(e.kind(), "missing_reason");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn transfer_to_human() {
        let dir = tmp("transfer");
        let port = Arc::new(MockCallPort::new(vec![
            CallEvent::Answered,
            CallEvent::PeerDtmf("0".into()),
        ]));
        let svc = CallService::new(&dir, port.clone());
        let id = svc.dial(&target("售后")).await.unwrap();
        let (state, _) = svc.run(&id, &target("售后"), Duration::from_millis(100)).await;
        assert!(matches!(state, CallState::Completed { reason } if reason.contains("human")));
        assert!(port.spoken().iter().any(|(_, t)| t.contains("转接人工")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
