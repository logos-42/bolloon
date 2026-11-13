//! `/api/call/*` —— AI 外呼的 HTTP 面。
//!
//! 当前只有 **Mock 服务商**：能验证合规门、状态机与审计，**不能真拨号**。
//! 响应里始终带 `provider: "mock"`，不许让调用方以为已经接通运营商。

use std::sync::Arc;
use std::time::Duration;

use axum::{extract::State, Json};
use serde_json::{json, Value};

use bolloon_agent::call::service::{calls_dir, CallService, MockCallPort};
use bolloon_agent::call::{CallEvent, CallTarget};
use bolloon_agent::home::BolloonHome;

use crate::server::AppState;

type Reply = Json<Value>;

fn ok(data: Value) -> Reply {
    Json(json!({ "ok": true, "data": data }))
}

fn fail(kind: &str, msg: impl Into<String>) -> Reply {
    Json(json!({ "ok": false, "error": kind, "message": msg.into() }))
}

fn mock_service() -> CallService {
    let home = BolloonHome::resolve();
    CallService::new(
        calls_dir(home.root()),
        Arc::new(MockCallPort::new(vec![
            CallEvent::Ringing,
            CallEvent::Answered,
            CallEvent::Hangup { by: "peer".into() },
        ])),
    )
}

pub async fn records(State(_st): State<AppState>) -> Reply {
    let svc = mock_service();
    let recs = svc.records();
    ok(json!({ "records": recs, "count": recs.len(), "provider": svc.provider() }))
}

pub async fn dial(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let Some(e164) = req.get("e164").and_then(|v| v.as_str()) else {
        return fail("bad_number", "缺少 e164");
    };
    let reason = req.get("reason").and_then(|v| v.as_str()).unwrap_or_default();
    let target = CallTarget {
        e164: e164.to_string(),
        contact_id: req.get("contact_id").and_then(|v| v.as_str()).map(String::from),
        reason: reason.to_string(),
    };

    let svc = mock_service();
    let id = match svc.dial(&target).await {
        Ok(id) => id,
        Err(e) => return fail(e.kind(), e.message()),
    };
    let (state, timeline) = svc.run(&id, &target, Duration::from_secs(2)).await;
    ok(json!({
        "id": id.to_string(),
        "state": state,
        "timeline": timeline,
        // 关键: 不让调用方误以为真打通了运营商
        "provider": "mock",
        "really_connected": false,
        "note": "Mock 服务商: 未连接运营商, 无真实音频"
    }))
}
