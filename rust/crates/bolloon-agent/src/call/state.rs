//! 通话状态机 + 合规门（纯函数，无 IO）。
//!
//! 两条**不可绕过**的合规约束：
//! 1. 接通后第一条 `Speak` 必须是 AI 身份声明；声明为空 ⇒ 直接 `Failed`。
//! 2. 同一号码被对方拒接 / 标记勿扰后，不再外呼。

use serde::{Deserialize, Serialize};

use super::{CallEffect, CallEvent, CallRecord, CallState, CallTarget};

/// 合规拒因（机器可读）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallGuardError {
    /// 没有说明打电话的目的
    MissingReason,
    /// 号码格式不对（只认 E.164）
    BadNumber,
    /// 对方此前拒接 / 明确拒绝 ⇒ 不再外呼
    DoNotCall,
    /// 一次性只能打一个（明确禁止名单轮呼）
    BatchForbidden,
    /// 没有 AI 声明文案
    MissingDisclosure,
    /// 服务商不可用（没配账号 / 连不上 / 鉴权失败）
    ProviderUnavailable(String),
}

impl CallGuardError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::MissingReason => "missing_reason",
            Self::BadNumber => "bad_number",
            Self::DoNotCall => "do_not_call",
            Self::BatchForbidden => "batch_forbidden",
            Self::MissingDisclosure => "missing_disclosure",
            Self::ProviderUnavailable(_) => "provider_unavailable",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::MissingReason => "没有说明打电话的目的 — 拒呼(防名单轮呼)".into(),
            Self::BadNumber => "号码必须是 E.164(以 + 开头、只含数字)".into(),
            Self::DoNotCall => "对方此前拒接或明确拒绝 — 不再外呼".into(),
            Self::BatchForbidden => "一次只能打一个号码(批量外呼永久禁止)".into(),
            Self::MissingDisclosure => "缺少 AI 身份声明 — 不许在未声明的情况下外呼".into(),
            Self::ProviderUnavailable(m) => format!("外呼通道不可用: {m}"),
        }
    }
}

/// 只认 E.164：`+` + 8..15 位数字
pub fn is_e164(s: &str) -> bool {
    let t = s.trim();
    let Some(rest) = t.strip_prefix('+') else {
        return false;
    };
    (8..=15).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_digit())
}

/// 外呼前合规检查（`history` = 本机既有通话记录）
pub fn check_dial(
    target: &CallTarget,
    history: &[CallRecord],
    disclosure: &str,
) -> Result<(), CallGuardError> {
    if disclosure.trim().is_empty() {
        return Err(CallGuardError::MissingDisclosure);
    }
    if target.reason.trim().is_empty() {
        return Err(CallGuardError::MissingReason);
    }
    if !is_e164(&target.e164) {
        return Err(CallGuardError::BadNumber);
    }
    // 对方拒接 / 拒绝 ⇒ 不再打
    let blocked = history.iter().any(|r| {
        r.target_e164 == target.e164
            && matches!(&r.state, CallState::Completed { reason } if reason.contains("declined") || reason.contains("do_not_call"))
    });
    if blocked {
        return Err(CallGuardError::DoNotCall);
    }
    Ok(())
}

/// 状态机一次迁移：`(新状态, 副作用列表)`
///
/// 纯函数：不做 IO、不看时间、不读盘。
pub fn reduce(
    state: &CallState,
    event: &CallEvent,
    disclosure: &str,
) -> (CallState, Vec<CallEffect>) {
    match (state, event) {
        (CallState::Idle, CallEvent::DialRequested) => {
            (CallState::Dialing, vec![CallEffect::Log("dial_requested".into())])
        }
        (CallState::Dialing, CallEvent::Ringing) => {
            (CallState::Ringing, vec![CallEffect::Log("ringing".into())])
        }
        (CallState::Dialing, CallEvent::Answered) => {
            // 跳过 Ringing 也要在接通时立刻声明身份
            if disclosure.trim().is_empty() {
                return (
                    CallState::Failed { error: "missing_disclosure".into() },
                    vec![CallEffect::Hangup],
                );
            }
            (
                CallState::InProgress { turns: 0 },
                vec![
                    CallEffect::Speak(disclosure.to_string()),
                    CallEffect::Listen,
                    CallEffect::Log("answered:ai_disclosed".into()),
                ],
            )
        }
        (CallState::Ringing, CallEvent::Answered) => {
            if disclosure.trim().is_empty() {
                return (
                    CallState::Failed { error: "missing_disclosure".into() },
                    vec![CallEffect::Hangup],
                );
            }
            (
                CallState::InProgress { turns: 0 },
                vec![
                    CallEffect::Speak(disclosure.to_string()),
                    CallEffect::Listen,
                    CallEffect::Log("answered:ai_disclosed".into()),
                ],
            )
        }
        (CallState::InProgress { turns }, CallEvent::PeerUtterance(_)) => {
            let next = turns.saturating_add(1);
            // 对方说了话 ⇒ 交给上层(LLM)决定回复；状态机只保证「说一句 + 继续听」
            (
                CallState::InProgress { turns: next },
                vec![CallEffect::Log(format!("peer_turn:{next}"))],
            )
        }
        (CallState::InProgress { turns }, CallEvent::PeerDtmf(k)) => {
            if k == "0" {
                // 0 = 转人工
                (
                    CallState::Completed { reason: "transferred_to_human".into() },
                    vec![
                        CallEffect::Speak("正在为你转接人工，请稍候。".into()),
                        CallEffect::Hangup,
                        CallEffect::Log("transfer".into()),
                    ],
                )
            } else if k == "2" {
                // 2 = 拒绝
                (
                    CallState::Completed { reason: "declined".into() },
                    vec![
                        CallEffect::Speak("好的，不再打扰。".into()),
                        CallEffect::Hangup,
                        CallEffect::Log("declined".into()),
                    ],
                )
            } else {
                (
                    CallState::InProgress { turns: turns.saturating_add(1) },
                    vec![CallEffect::Log(format!("dtmf:{k}")), CallEffect::Listen],
                )
            }
        }
        (CallState::InProgress { .. }, CallEvent::Hangup { by }) => (
            CallState::Completed { reason: format!("hangup_by_{by}") },
            vec![CallEffect::Log("hangup".into())],
        ),
        (CallState::Dialing | CallState::Ringing, CallEvent::Hangup { by }) => (
            CallState::Completed { reason: format!("hangup_before_answer_by_{by}") },
            vec![CallEffect::Log("hangup_before_answer".into())],
        ),
        (_, CallEvent::Error(e)) => (
            CallState::Failed { error: e.clone() },
            vec![CallEffect::Log(format!("error:{e}"))],
        ),
        // 终态不再迁移
        (s, _) if s.is_terminal() => (s.clone(), vec![]),
        // 未定义组合：保持不变（不猜）
        (s, _) => (s.clone(), vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::call::CallId;

    fn target(e164: &str, reason: &str) -> CallTarget {
        CallTarget { e164: e164.into(), contact_id: None, reason: reason.into() }
    }

    fn rec(e164: &str, reason: &str) -> CallRecord {
        CallRecord {
            id: CallId("c1".into()),
            target_e164: e164.into(),
            contact_id: None,
            reason: "x".into(),
            state: CallState::Completed { reason: reason.into() },
            timeline: vec![],
            started_ms: 0,
            ended_ms: None,
        }
    }

    #[test]
    fn e164_is_strict() {
        assert!(is_e164("+8613800138000"));
        assert!(!is_e164("13800138000"), "缺 + 不算 E.164");
        assert!(!is_e164("+123"), "太短");
        assert!(!is_e164("+86abc"), "含字母");
    }

    #[test]
    fn dial_requires_reason_number_and_disclosure() {
        let d = "你好，我是 AI 助手。";
        assert_eq!(
            check_dial(&target("+8613800138000", ""), &[], d).unwrap_err().kind(),
            "missing_reason"
        );
        assert_eq!(
            check_dial(&target("13800138000", "确认收货"), &[], d).unwrap_err().kind(),
            "bad_number"
        );
        assert_eq!(
            check_dial(&target("+8613800138000", "确认收货"), &[], "").unwrap_err().kind(),
            "missing_disclosure"
        );
        assert!(check_dial(&target("+8613800138000", "确认收货"), &[], d).is_ok());
    }

    #[test]
    fn declined_number_is_never_redialed() {
        let hist = vec![rec("+8613800138000", "declined")];
        let e = check_dial(&target("+8613800138000", "再确认"), &hist, "AI 助手").unwrap_err();
        assert_eq!(e.kind(), "do_not_call");

        let hist2 = vec![rec("+8613800138000", "do_not_call")];
        assert_eq!(
            check_dial(&target("+8613800138000", "再确认"), &hist2, "AI 助手")
                .unwrap_err()
                .kind(),
            "do_not_call"
        );
    }

    #[test]
    fn answered_must_speak_disclosure_first() {
        let d = "你好，我是 AI 助手，这通电话是为确认收货。";
        let (s, eff) = reduce(&CallState::Dialing, &CallEvent::Answered, d);
        assert_eq!(s, CallState::InProgress { turns: 0 });
        assert_eq!(eff[0], CallEffect::Speak(d.to_string()), "第一条必须播报 AI 身份");
        assert!(eff.iter().any(|e| matches!(e, CallEffect::Listen)));
    }

    #[test]
    fn empty_disclosure_fails_and_hangs_up() {
        let (s, eff) = reduce(&CallState::Dialing, &CallEvent::Answered, "  ");
        assert!(matches!(s, CallState::Failed { .. }));
        assert_eq!(eff, vec![CallEffect::Hangup], "没声明就不许继续通话");
    }

    #[test]
    fn dtmf_two_declines_and_zero_transfers() {
        let (s, eff) = reduce(&CallState::InProgress { turns: 1 }, &CallEvent::PeerDtmf("2".into()), "d");
        assert!(matches!(s, CallState::Completed { .. }));
        assert!(eff.iter().any(|e| matches!(e, CallEffect::Hangup)));

        let (s2, eff2) = reduce(&CallState::InProgress { turns: 1 }, &CallEvent::PeerDtmf("0".into()), "d");
        assert!(matches!(s2, CallState::Completed { reason } if reason.contains("human")));
        assert!(eff2.iter().any(|e| matches!(e, CallEffect::Hangup)));
    }

    #[test]
    fn peer_turns_increment_and_do_not_hangup() {
        let (s, _) = reduce(
            &CallState::InProgress { turns: 2 },
            &CallEvent::PeerUtterance("我现在不方便".into()),
            "d",
        );
        assert_eq!(s, CallState::InProgress { turns: 3 });
    }

    #[test]
    fn terminal_state_is_sticky() {
        let done = CallState::Completed { reason: "declined".into() };
        let (s, eff) = reduce(&done, &CallEvent::Answered, "d");
        assert_eq!(s, done);
        assert!(eff.is_empty(), "终态不应再产生副作用");
    }

    #[test]
    fn error_moves_to_failed() {
        let (s, _) = reduce(&CallState::Dialing, &CallEvent::Error("carrier_unreachable".into()), "d");
        assert_eq!(s, CallState::Failed { error: "carrier_unreachable".into() });
    }
}
