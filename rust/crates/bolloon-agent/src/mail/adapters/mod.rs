//! 平台 / 协议 Adapter 集合。
//!
//! 每个 Adapter 只回答「怎么与这个数据源说话」, 不回答「准不准做」。
//! 真协议 Adapter(IMAP/SMTP、Android ContactsContract、content://sms)在后续批次接入;
//! 本批先落 `LocalSinkMailPort`, 让 Store / 硬拒 / 装配层能先跑通并单测。

pub mod imap_smtp;
pub mod local_sink;
pub mod vcard;

pub use imap_smtp::ImapSmtpAdapter;
pub use local_sink::LocalSinkMailPort;
pub use vcard::VcardCsvAdapter;
