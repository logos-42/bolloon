//! 邮件 / 通讯录 / 短信能力(三端共用)。
//!
//! 分层(AGENTS.md §8):
//! - `ports`   : 能力形状(trait), 不含判断
//! - `store`   : 本地索引 + 正文加密库
//! - `service` : 硬拒判断 + 装配(Web / CLI 共用同一份)
//! - `adapters`: 与真实数据源说话(IMAP/SMTP、ContactsContract、content://sms …)
//!
//! 一句话: Adapter 管「怎么说」, Service 管「准不准」, Store 管「记在哪」。

pub mod adapters;
pub mod config;
pub mod ports;
pub mod service;
pub mod store;

pub use adapters::local_sink::LocalSinkMailPort;
pub use config::{
    accounts_path, build_service, delete_mail_password, load_accounts, mail_dir, save_accounts,
    set_mail_password, AccountConfig, AccountsFile,
};
pub use ports::{
    AttachmentMeta, ContactMeta, ContactQuery, ContactsPort, ImportReport, MailBody, MailDraft,
    MailId, MailMeta, MailPort, MailPortError, MailQuery, MailResult, SmsId, SmsMeta, SmsPort,
    SmsQuery, SyncReport,
};
pub use service::{check_send_guard, GuardError, MailService, MailServiceError};
pub use store::MailStore;
