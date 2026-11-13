//! 邮件 / 通讯录 / 短信三类能力的 Port 契约。
//!
//! 纪律 (AGENTS.md §8): Port 只声明能力形状, 不含业务判断。
//! 批量拒绝、凭据外发拒绝等判断在 `service.rs`, 不在 Adapter 实现里。
//! Adapter 只负责「怎么与某个真实数据源说话」, 不负责「准不准做」。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// 邮件标识:`<account>/<mailbox>/<uid>`(跨账号唯一)
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MailId(pub String);

impl MailId {
    pub fn new(account: &str, mailbox: &str, uid: u32) -> Self {
        Self(format!("{account}/{mailbox}/{uid}"))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for MailId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MailQuery {
    pub account: Option<String>,
    pub mailbox: Option<String>,
    pub unread_only: bool,
    pub keyword: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailMeta {
    pub id: MailId,
    pub account: String,
    pub mailbox: String,
    pub uid: u32,
    pub subject: String,
    pub from: String,
    pub to: Vec<String>,
    pub date_ms: i64,
    /// IMAP flags, 例如 `["\\Seen"]`
    pub flags: Vec<String>,
    pub snippet: String,
    pub has_attachments: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttachmentMeta {
    pub filename: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailBody {
    pub meta: MailMeta,
    pub text: String,
    pub html: Option<String>,
    pub attachments: Vec<AttachmentMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailDraft {
    pub account: String,
    pub to: Vec<String>,
    pub subject: String,
    pub text: String,
    pub in_reply_to: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncReport {
    pub account: String,
    pub fetched: usize,
    pub new: usize,
    pub updated: usize,
    pub cursor: Option<String>,
    /// 上次成功结果被沿用(网络不可用)时为 true, 不冒充最新
    pub stale: bool,
    pub error: Option<String>,
}

/// Adapter 层错误(机器可读 kind + 人读 message)
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailPortError {
    pub kind: String,
    pub message: String,
}

impl MailPortError {
    pub fn new(kind: &str, msg: impl Into<String>) -> Self {
        Self { kind: kind.into(), message: msg.into() }
    }
}

impl std::fmt::Display for MailPortError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

pub type MailResult<T> = Result<T, MailPortError>;

#[async_trait]
pub trait MailPort: Send + Sync {
    /// 账号标识(与 `MailDraft.account` / 凭据命名空间一致)
    fn account_id(&self) -> &str;

    async fn sync(&self) -> MailResult<SyncReport>;

    async fn list(&self, q: MailQuery) -> MailResult<Vec<MailMeta>>;

    async fn read(&self, id: &MailId) -> MailResult<MailBody>;

    /// 发送。**Port 不判批量**, 由 `service::check_send_guard` 先拦。
    async fn send(&self, draft: MailDraft) -> MailResult<MailId>;

    async fn archive(&self, ids: &[MailId]) -> MailResult<()>;

    async fn delete(&self, ids: &[MailId]) -> MailResult<()>;
}

// ---------------------------------------------------------------------------
// 通讯录
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactMeta {
    /// 源内稳定 id(Android `_ID` / iOS identifier / vCard UID)
    pub id: String,
    pub name: String,
    pub phones: Vec<String>,
    pub emails: Vec<String>,
    pub org: Option<String>,
    pub updated_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContactQuery {
    pub keyword: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportReport {
    pub source: String,
    pub imported: usize,
    pub updated: usize,
    pub skipped: usize,
}

#[async_trait]
pub trait ContactsPort: Send + Sync {
    fn source_id(&self) -> &str;

    async fn import_all(&self) -> MailResult<ImportReport>;

    async fn list(&self, q: ContactQuery) -> MailResult<Vec<ContactMeta>>;
}

// ---------------------------------------------------------------------------
// 短信
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SmsId(pub String);

impl std::fmt::Display for SmsId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SmsMeta {
    pub id: SmsId,
    /// 对端号码
    pub address: String,
    pub snippet: String,
    pub date_ms: i64,
    pub read: bool,
    /// inbox / sent / draft / outbox …
    pub kind: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SmsQuery {
    pub keyword: Option<String>,
    pub since_ms: Option<i64>,
    pub limit: Option<usize>,
}

#[async_trait]
pub trait SmsPort: Send + Sync {
    async fn sync(&self) -> MailResult<SyncReport>;

    async fn list(&self, q: SmsQuery) -> MailResult<Vec<SmsMeta>>;

    async fn send(&self, to: &str, body: &str) -> MailResult<SmsId>;
}
