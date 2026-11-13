//! IMAP 收信 + SMTP 发信 Adapter（真协议、真 socket）。
//!
//! 诚实边界（这一版刻意不做）：
//! - 不做完整 MIME 解析：多部分邮件只取 `TEXT` 段原文，附件不下载（`has_attachments`
//!   由头部 `multipart/*` 粗判）。
//! - 头部 encoded-word 只解 `B` / `Q` 两种常见形态；其它保持原文。
//! - 每次操作重新连接（不持长连接）；IMAP IDLE 增量推送留到后续批次。
//!
//! 密码只从 `bolloon-llm` 凭据后端按 `mail:<email>` 取，**不进 accounts.json、不落日志**。

use std::collections::HashSet;

use async_trait::async_trait;
use base64::Engine as _;

use crate::mail::config::AccountConfig;
use crate::mail::ports::{
    AttachmentMeta, MailBody, MailDraft, MailId, MailMeta, MailPort, MailPortError, MailQuery,
    MailResult, SyncReport,
};

#[derive(Clone)]
pub struct ImapSmtpAdapter {
    account: String,
    imap_host: String,
    imap_port: u16,
    smtp_host: String,
    smtp_port: u16,
    user: String,
    from: String,
}

impl ImapSmtpAdapter {
    pub fn from_config(cfg: &AccountConfig) -> Result<Self, String> {
        let account = cfg.account.trim().to_string();
        if account.is_empty() {
            return Err("账号为空".into());
        }
        let imap_host = cfg.host.trim().to_string();
        if imap_host.is_empty() {
            return Err(format!("{account} 缺少 IMAP 主机(host)"));
        }
        let imap_port = if cfg.port == 0 { 993 } else { cfg.port };
        let smtp_host = cfg
            .smtp_host
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(&imap_host)
            .to_string();
        // 465 = 隐式 TLS(SMTPS)；其余按 STARTTLS(常见 587)
        let smtp_port = cfg.smtp_port.unwrap_or(587);
        let user = if cfg.user.trim().is_empty() {
            account.clone()
        } else {
            cfg.user.trim().to_string()
        };
        let from = if cfg.from.trim().is_empty() {
            account.clone()
        } else {
            cfg.from.trim().to_string()
        };
        Ok(Self { account, imap_host, imap_port, smtp_host, smtp_port, user, from })
    }

    fn password(&self) -> MailResult<String> {
        let key = bolloon_llm::secret_store::account_for_mail(&self.account);
        bolloon_llm::secret_store::default_backend()
            .get(&key)
            .ok_or_else(|| {
                MailPortError::new(
                    "provider_not_configured",
                    format!("账号 {} 的密码不在凭据库（先写入 mail:<email> 再同步）", self.account),
                )
            })
    }

    fn imap_connect(
        &self,
        pass: &str,
    ) -> MailResult<imap::Session<native_tls::TlsStream<std::net::TcpStream>>> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| MailPortError::new("provider_unreachable", format!("TLS 初始化失败: {e}")))?;
        let client = imap::connect(
            (self.imap_host.as_str(), self.imap_port),
            &self.imap_host,
            &tls,
        )
        .map_err(|e| {
            MailPortError::new(
                "provider_unreachable",
                format!("IMAP 连接 {}:{} 失败: {e}", self.imap_host, self.imap_port),
            )
        })?;
        let session = client.login(&self.user, pass).map_err(|(e, _)| {
            MailPortError::new("auth_failed", format!("IMAP 登录失败: {e}"))
        })?;
        Ok(session)
    }

    fn list_blocking(&self, q: &MailQuery) -> MailResult<Vec<MailMeta>> {
        let pass = self.password()?;
        let mut session = self.imap_connect(&pass)?;
        let mailbox = q.mailbox.clone().unwrap_or_else(|| "INBOX".into());

        session.select(&mailbox).map_err(|e| {
            MailPortError::new("mailbox_unavailable", format!("选择邮箱夹 {mailbox} 失败: {e}"))
        })?;

        let uids: HashSet<u32> = session
            .uid_search("ALL")
            .map_err(|e| MailPortError::new("fetch_failed", format!("UID SEARCH 失败: {e}")))?;

        // 只取最近的 N 封，避免一次拉全量
        let mut sorted: Vec<u32> = uids.into_iter().collect();
        sorted.sort_unstable();
        let take = q.limit.unwrap_or(50).max(1);
        let recent: Vec<u32> = sorted.iter().rev().take(take).copied().collect();

        let mut out = Vec::new();
        for chunk in recent.chunks(50) {
            let seq = chunk
                .iter()
                .map(|u| u.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let fetches = session
                .uid_fetch(
                    &seq,
                    "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE CONTENT-TYPE)])",
                )
                .map_err(|e| MailPortError::new("fetch_failed", format!("UID FETCH 失败: {e}")))?;
            for f in fetches.iter() {
                let Some(uid) = f.uid else { continue };
                let header = f.header().unwrap_or_default();
                let subject = header_value(header, "Subject")
                    .map(|s| decode_encoded_words(&s))
                    .unwrap_or_else(|| "(无主题)".into());
                let from = header_value(header, "From")
                    .map(|s| decode_encoded_words(&s))
                    .unwrap_or_default();
                let to = header_value(header, "To")
                    .map(|s| decode_encoded_words(&s))
                    .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
                    .unwrap_or_default();
                let ctype = header_value(header, "Content-Type").unwrap_or_default();
                let date_ms = f.internal_date().map(|d| d.timestamp_millis()).unwrap_or(0);
                let flags: Vec<String> =
                    f.flags().iter().map(|x| format!("{x:?}")).collect();
                out.push(MailMeta {
                    id: MailId::new(&self.account, &mailbox, uid),
                    account: self.account.clone(),
                    mailbox: mailbox.clone(),
                    uid,
                    subject,
                    from,
                    to,
                    date_ms,
                    flags,
                    snippet: String::new(),
                    has_attachments: ctype.to_lowercase().contains("multipart/"),
                });
            }
        }
        let _ = session.logout();
        out.sort_by(|a, b| b.date_ms.cmp(&a.date_ms));
        Ok(out)
    }

    fn read_blocking(&self, id: &MailId) -> MailResult<MailBody> {
        let (mailbox, uid) = split_id(id, &self.account)?;
        let pass = self.password()?;
        let mut session = self.imap_connect(&pass)?;
        session.select(&mailbox).map_err(|e| {
            MailPortError::new("mailbox_unavailable", format!("选择邮箱夹 {mailbox} 失败: {e}"))
        })?;
        let fetches = session
            .uid_fetch(
                uid.to_string(),
                "(UID FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (SUBJECT FROM TO DATE CONTENT-TYPE)] BODY.PEEK[TEXT])",
            )
            .map_err(|e| MailPortError::new("fetch_failed", format!("UID FETCH 失败: {e}")))?;
        let f = fetches
            .iter()
            .next()
            .ok_or_else(|| MailPortError::new("not_found", format!("邮件不存在: {id}")))?;

        let header = f.header().unwrap_or_default();
        let subject = header_value(header, "Subject")
            .map(|s| decode_encoded_words(&s))
            .unwrap_or_else(|| "(无主题)".into());
        let from = header_value(header, "From")
            .map(|s| decode_encoded_words(&s))
            .unwrap_or_default();
        let to = header_value(header, "To")
            .map(|s| decode_encoded_words(&s))
            .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
            .unwrap_or_default();
        let date_ms = f.internal_date().map(|d| d.timestamp_millis()).unwrap_or(0);
        let flags: Vec<String> = f.flags().iter().map(|x| format!("{x:?}")).collect();
        let text = f
            .text()
            .map(|b| String::from_utf8_lossy(b).to_string())
            .unwrap_or_default();
        let snippet: String = text.chars().take(200).collect();
        let _ = session.logout();

        Ok(MailBody {
            meta: MailMeta {
                id: id.clone(),
                account: self.account.clone(),
                mailbox,
                uid,
                subject,
                from,
                to,
                date_ms,
                flags,
                snippet,
                has_attachments: false,
            },
            text,
            html: None,
            attachments: Vec::<AttachmentMeta>::new(),
        })
    }

    fn send_blocking(&self, draft: &MailDraft) -> MailResult<MailId> {
        use lettre::Transport;
        use lettre::message::Mailbox;
        use lettre::transport::smtp::authentication::Credentials;

        let pass = self.password()?;
        let from: Mailbox = self
            .from
            .parse()
            .map_err(|e| MailPortError::new("invalid_from", format!("发件地址不合法: {e}")))?;
        let to: Mailbox = draft.to[0]
            .parse()
            .map_err(|e| MailPortError::new("invalid_recipient", format!("收件地址不合法: {e}")))?;

        let email = lettre::Message::builder()
            .from(from)
            .to(to)
            .subject(&draft.subject)
            .body(draft.text.clone())
            .map_err(|e| MailPortError::new("build_failed", format!("构造邮件失败: {e}")))?;

        let transport = if self.smtp_port == 465 {
            lettre::SmtpTransport::relay(&self.smtp_host)
        } else {
            lettre::SmtpTransport::starttls_relay(&self.smtp_host)
        }
        .map_err(|e| {
            MailPortError::new("provider_unreachable", format!("SMTP 初始化失败: {e}"))
        })?;

        let mailer = transport
            .port(self.smtp_port)
            .credentials(Credentials::new(self.user.clone(), pass))
            .build();
        mailer
            .send(&email)
            .map_err(|e| MailPortError::new("send_failed", format!("SMTP 发送失败: {e}")))?;

        Ok(MailId(format!(
            "{}/outbox/{}",
            self.account,
            uuid::Uuid::new_v4()
        )))
    }

    fn delete_blocking(&self, ids: &[MailId]) -> MailResult<()> {
        let pass = self.password()?;
        let mut session = self.imap_connect(&pass)?;
        for id in ids {
            let (mailbox, uid) = split_id(id, &self.account)?;
            session.select(&mailbox).map_err(|e| {
                MailPortError::new("mailbox_unavailable", format!("选择邮箱夹 {mailbox} 失败: {e}"))
            })?;
            session
                .uid_store(uid.to_string(), "+FLAGS (\\Deleted)")
                .map_err(|e| MailPortError::new("delete_failed", format!("标记删除失败: {e}")))?;
            session
                .expunge()
                .map_err(|e| MailPortError::new("delete_failed", format!("EXPUNGE 失败: {e}")))?;
        }
        let _ = session.logout();
        Ok(())
    }

    fn archive_blocking(&self, ids: &[MailId]) -> MailResult<()> {
        let pass = self.password()?;
        let mut session = self.imap_connect(&pass)?;
        for id in ids {
            let (mailbox, uid) = split_id(id, &self.account)?;
            session.select(&mailbox).map_err(|e| {
                MailPortError::new("mailbox_unavailable", format!("选择邮箱夹 {mailbox} 失败: {e}"))
            })?;
            session
                .uid_store(uid.to_string(), "+FLAGS (\\Seen)")
                .map_err(|e| MailPortError::new("archive_failed", format!("归档失败: {e}")))?;
        }
        let _ = session.logout();
        Ok(())
    }
}

fn split_id(id: &MailId, account: &str) -> MailResult<(String, u32)> {
    let mut it = id.as_str().rsplitn(3, '/');
    let uid = it
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .ok_or_else(|| MailPortError::new("bad_id", format!("邮件 id 不合法: {id}")))?;
    let mailbox = it
        .next()
        .ok_or_else(|| MailPortError::new("bad_id", format!("邮件 id 缺邮箱夹: {id}")))?
        .to_string();
    let acc = it.next().unwrap_or_default();
    if !acc.eq_ignore_ascii_case(account) {
        return Err(MailPortError::new(
            "bad_id",
            format!("邮件 id 属于 {acc}，不是本账号 {account}"),
        ));
    }
    Ok((mailbox, uid))
}

fn header_value(header: &[u8], name: &str) -> Option<String> {
    let text = String::from_utf8_lossy(header);
    let mut lines: Vec<String> = Vec::new();
    for l in text.lines() {
        if l.starts_with(' ') || l.starts_with('\t') {
            if let Some(last) = lines.last_mut() {
                last.push(' ');
                last.push_str(l.trim());
            }
        } else {
            lines.push(l.to_string());
        }
    }
    let prefix = format!("{}:", name.to_lowercase());
    lines
        .into_iter()
        .find(|l| l.to_lowercase().starts_with(&prefix))
        .map(|l| l[prefix.len()..].trim().to_string())
}

fn decode_encoded_words(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("?=") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &after[..end];
        let parts: Vec<&str> = token.splitn(3, '?').collect();
        let decoded = if parts.len() == 3 {
            let enc = parts[1].to_uppercase();
            if enc == "B" {
                base64::engine::general_purpose::STANDARD
                    .decode(parts[2])
                    .ok()
            } else if enc == "Q" {
                Some(q_decode(parts[2]))
            } else {
                None
            }
        } else {
            None
        };
        match decoded {
            Some(bytes) => out.push_str(&String::from_utf8_lossy(&bytes)),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

fn q_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'_' => {
                out.push(b' ');
                i += 1;
            }
            b'=' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
                match u8::from_str_radix(hex, 16) {
                    Ok(b) => {
                        out.push(b);
                        i += 3;
                    }
                    Err(_) => {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}



#[async_trait]
impl MailPort for ImapSmtpAdapter {
    fn account_id(&self) -> &str {
        &self.account
    }

    async fn sync(&self) -> MailResult<SyncReport> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            let pass = me.password()?;
            let mut session = me.imap_connect(&pass)?;
            let mb = session.select("INBOX").map_err(|e| {
                MailPortError::new("mailbox_unavailable", format!("选择 INBOX 失败: {e}"))
            })?;
            let exists = mb.exists as usize;
            let _ = session.logout();
            Ok(SyncReport {
                account: me.account.clone(),
                fetched: exists,
                ..Default::default()
            })
        })
        .await
        .map_err(|e| MailPortError::new("io", format!("IMAP 线程失败: {e}")))?
    }

    async fn list(&self, q: MailQuery) -> MailResult<Vec<MailMeta>> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.list_blocking(&q))
            .await
            .map_err(|e| MailPortError::new("io", format!("IMAP 线程失败: {e}")))?
    }

    async fn read(&self, id: &MailId) -> MailResult<MailBody> {
        let me = self.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || me.read_blocking(&id))
            .await
            .map_err(|e| MailPortError::new("io", format!("IMAP 线程失败: {e}")))?
    }

    async fn send(&self, draft: MailDraft) -> MailResult<MailId> {
        let me = self.clone();
        tokio::task::spawn_blocking(move || me.send_blocking(&draft))
            .await
            .map_err(|e| MailPortError::new("io", format!("SMTP 线程失败: {e}")))?
    }

    async fn archive(&self, ids: &[MailId]) -> MailResult<()> {
        let me = self.clone();
        let ids = ids.to_vec();
        tokio::task::spawn_blocking(move || me.archive_blocking(&ids))
            .await
            .map_err(|e| MailPortError::new("io", format!("IMAP 线程失败: {e}")))?
    }

    async fn delete(&self, ids: &[MailId]) -> MailResult<()> {
        let me = self.clone();
        let ids = ids.to_vec();
        tokio::task::spawn_blocking(move || me.delete_blocking(&ids))
            .await
            .map_err(|e| MailPortError::new("io", format!("IMAP 线程失败: {e}")))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> AccountConfig {
        AccountConfig {
            account: "me@x.com".into(),
            mode: "imap_smtp".into(),
            host: "imap.x.com".into(),
            port: 993,
            user: "me".into(),
            from: "me@x.com".into(),
            ..Default::default()
        }
    }

    #[test]
    fn from_config_fills_defaults() {
        let a = ImapSmtpAdapter::from_config(&cfg()).unwrap();
        assert_eq!(a.imap_port, 993);
        assert_eq!(a.smtp_port, 587);
        assert_eq!(a.smtp_host, "imap.x.com");
        assert_eq!(a.account, "me@x.com");
    }

    #[test]
    fn missing_host_is_error_not_guess() {
        let mut c = cfg();
        c.host = String::new();
        assert!(ImapSmtpAdapter::from_config(&c).is_err(), "不许猜主机");
    }

    #[test]
    fn id_roundtrip_and_account_guard() {
        let id = MailId::new("me@x.com", "INBOX", 42);
        assert_eq!(split_id(&id, "me@x.com").unwrap(), ("INBOX".to_string(), 42));
        assert!(split_id(&id, "other@x.com").is_err(), "跨账号 id 必须拒");
    }

    #[test]
    fn header_and_encoded_word_decode() {
        let raw = b"Subject: =?UTF-8?B?5oql5Lu35Y2V?=\r\nFrom: a@b.com\r\n";
        let s = header_value(raw, "Subject").unwrap();
        assert_eq!(decode_encoded_words(&s), "报价单");
        assert_eq!(header_value(raw, "From").unwrap(), "a@b.com");
    }

    #[test]
    fn q_encoding_decodes() {
        assert_eq!(
            String::from_utf8_lossy(&q_decode("hello_world=21")),
            "hello world!"
        );
    }
}
