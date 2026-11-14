//! `/api/mail/*` —— 邮件能力的 HTTP 面。
//!
//! Web / App 走这里; CLI 按设计**直连 crate**, 不依赖本文件。
//! 纪律: 只做「解析请求 → 调 `bolloon_agent::mail::MailService` → 统一 JSON 形状」,
//! 批量/凭据硬拒全在 service 层, 这里不许放行。

use axum::{extract::State, Json};
use serde_json::{json, Value};

use bolloon_agent::home::BolloonHome;
use bolloon_agent::mail::adapters::vcard::{load_imported, VcardCsvAdapter};
use bolloon_agent::mail::{
    build_service, delete_mail_password, ContactsPort, MailDraft, MailId, MailQuery, MailService,
    set_mail_password,
};

use crate::server::AppState;

type Reply = Json<Value>;

fn ok(data: Value) -> Reply {
    Json(json!({ "ok": true, "data": data }))
}

fn fail(kind: &str, msg: impl Into<String>) -> Reply {
    Json(json!({ "ok": false, "error": kind, "message": msg.into() }))
}

fn open() -> Result<MailService, (String, String)> {
    build_service(&BolloonHome::resolve())
        .map_err(|e| ("store_unreadable".to_string(), e))
}

fn ids_from(v: &Value) -> Vec<MailId> {
    match v.get("ids") {
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| x.as_str().map(|s| MailId(s.to_string())))
            .collect(),
        Some(Value::String(s)) => vec![MailId(s.clone())],
        _ => vec![],
    }
}

pub async fn accounts(State(_st): State<AppState>) -> Reply {
    match open() {
        Ok(svc) => ok(json!({ "accounts": svc.accounts() })),
        Err((k, m)) => fail(&k, &m),
    }
}

pub async fn list(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let svc = match open() {
        Ok(s) => s,
        Err((k, m)) => return fail(&k, &m),
    };
    let q = MailQuery {
        account: req.get("account").and_then(|v| v.as_str()).map(String::from),
        mailbox: req.get("mailbox").and_then(|v| v.as_str()).map(String::from),
        unread_only: req.get("unread_only").and_then(|v| v.as_bool()).unwrap_or(false),
        keyword: req.get("keyword").and_then(|v| v.as_str()).map(String::from),
        limit: Some(req.get("limit").and_then(|v| v.as_u64()).unwrap_or(50).min(500) as usize),
    };
    match svc.list(&q) {
        Ok(mails) => ok(json!({ "mails": mails, "count": mails.len() })),
        Err(e) => fail(e.kind(), e.message()),
    }
}

pub async fn read(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let svc = match open() {
        Ok(s) => s,
        Err((k, m)) => return fail(&k, &m),
    };
    let Some(id) = req.get("id").and_then(|v| v.as_str()) else {
        return fail("missing_id", "缺少 id");
    };
    match svc.read(&MailId(id.to_string())).await {
        Ok(body) => ok(json!(body)),
        Err(e) => fail(e.kind(), e.message()),
    }
}

pub async fn send(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let svc = match open() {
        Ok(s) => s,
        Err((k, m)) => return fail(&k, &m),
    };
    let to: Vec<String> = match req.get("to") {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => vec![],
    };
    let draft = MailDraft {
        account: req.get("account").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        to,
        subject: req.get("subject").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        text: req.get("text").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        in_reply_to: req.get("in_reply_to").and_then(|v| v.as_str()).map(String::from),
    };
    match svc.send(&draft).await {
        Ok(id) => ok(json!({ "id": id.to_string() })),
        Err(e) => fail(e.kind(), e.message()),
    }
}

pub async fn sync(State(_st): State<AppState>) -> Reply {
    let svc = match open() {
        Ok(s) => s,
        Err((k, m)) => return fail(&k, &m),
    };
    let reports = svc.sync_all().await;
    let failed = reports.iter().filter(|r| r.error.is_some()).count();
    ok(json!({ "reports": reports, "failed": failed }))
}

/// 导入通讯录(vCard / CSV)。只支持本机已有文件路径, 不做网络拉取。
pub async fn contacts_import(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let Some(path) = req.get("path").and_then(|v| v.as_str()) else {
        return fail("missing_path", "缺少 path");
    };
    let home = BolloonHome::resolve();
    let ad = VcardCsvAdapter::new(path, home.root());
    match ad.import_all().await {
        Ok(r) => ok(json!(r)),
        Err(e) => fail(&e.kind, e.message),
    }
}

/// 列已导入的通讯录(本地文件, 不联网)
pub async fn contacts_imported(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let home = BolloonHome::resolve();
    let kw = req.get("keyword").and_then(|v| v.as_str()).map(|s| s.to_lowercase());
    match load_imported(home.root()) {
        Ok(list) => {
            let items: Vec<_> = list
                .into_iter()
                .filter(|c| match &kw {
                    None => true,
                    Some(k) => {
                        c.name.to_lowercase().contains(k)
                            || c.phones.iter().any(|p| p.contains(k))
                            || c.emails.iter().any(|e| e.to_lowercase().contains(k))
                    }
                })
                .collect();
            ok(json!({ "contacts": items, "count": items.len() }))
        }
        Err(e) => fail("store_unreadable", e),
    }
}

pub async fn delete(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let svc = match open() {
        Ok(s) => s,
        Err((k, m)) => return fail(&k, &m),
    };
    let ids = ids_from(&req);
    if ids.is_empty() {
        return fail("missing_id", "没有要删除的 id");
    }
    match svc.delete(&ids).await {
        Ok(n) => ok(json!({ "deleted": n })),
        Err(e) => fail(e.kind(), e.message()),
    }
}

/// 写 / 删某邮箱的 SMTP 密码 (存进本机凭据后端, 键 `mail:<email>`, 不进 accounts.json)。
/// 密码只经本接口一次性写入, 永不回显; 删除用 `{"email":..,"delete":true}`。
pub async fn password(State(_st): State<AppState>, Json(req): Json<Value>) -> Reply {
    let Some(email) = req.get("email").and_then(|v| v.as_str()) else {
        return fail("missing_email", "缺少 email");
    };
    if req.get("delete").and_then(|v| v.as_bool()).unwrap_or(false) {
        return match delete_mail_password(email) {
            Ok(()) => ok(json!({ "email": email })),
            Err(e) => fail("delete_failed", e),
        };
    }
    let Some(pwd) = req.get("password").and_then(|v| v.as_str()) else {
        return fail("missing_password", "缺少 password");
    };
    match set_mail_password(email, pwd) {
        Ok(()) => ok(json!({ "email": email })),
        Err(e) => fail("save_failed", e),
    }
}
