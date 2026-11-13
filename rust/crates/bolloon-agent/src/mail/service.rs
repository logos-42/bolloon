//! 邮件能力装配层: 硬拒判断 + Store + Adapter 组合。
//!
//! Web handler 与 CLI 都调这里同一个实现(两个入口, 一份业务), 不产生第二条执行路径。
//!
//! 硬拒(不可通过任何配置绕过):
//! 1. 多收件人 / 群发
//! 2. 空收件人 / 空正文
//! 3. 正文携带凭据类字段真值(密码 / OTP / 私钥 / 助记词 / 卡号)

use std::sync::Arc;

use super::ports::{
    MailBody, MailDraft, MailId, MailMeta, MailPort, MailPortError, MailQuery, SyncReport,
};
use super::store::MailStore;

/// 硬拒原因(机器可读 kind)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GuardError {
    BatchForbidden,
    MissingRecipient,
    EmptyContent,
    ForbiddenContent(String),
    NoAdapter(String),
}

impl GuardError {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::BatchForbidden => "batch_forbidden",
            Self::MissingRecipient => "missing_recipient",
            Self::EmptyContent => "empty_content",
            Self::ForbiddenContent(_) => "forbidden_content",
            Self::NoAdapter(_) => "provider_not_configured",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::BatchForbidden => "批量/多收件人外发永远禁止(只允许单收件人)".into(),
            Self::MissingRecipient => "缺少收件人".into(),
            Self::EmptyContent => "正文为空".into(),
            Self::ForbiddenContent(cat) => {
                format!("正文被判定为凭据类内容({cat}), 拒绝外发")
            }
            Self::NoAdapter(a) => format!("账号 {a} 没有可用 Adapter, 拒绝假装发送"),
        }
    }
}

/// 只看「字段名 + 紧邻值」, 不因为正文里出现「密码」二字就拒。
/// 保守但不过度: 「请修改密码」放行, 「密码: hunter2」拒绝。
fn looks_like_secret(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    const LABELS: &[(&str, &str)] = &[
        ("password", "password_field"),
        ("passwd", "password_field"),
        ("pwd", "password_field"),
        ("密码", "password_field"),
        ("验证码", "otp_code"),
        ("otp", "otp_code"),
        ("private key", "private_key"),
        ("私钥", "private_key"),
        ("助记词", "seed_phrase"),
        ("cvv", "card_security_code"),
        ("银行卡号", "bank_account"),
        ("身份证号", "id_number"),
    ];
    for (label, cat) in LABELS {
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(label) {
            let pos = from + rel;
            let rest = &lower[pos + label.len()..];
            let rest = rest.trim_start_matches(&[':', '：', ' ', '\t', '=', '是'][..]);
            // 紧邻 8 个字符内出现 4+ 个字母数字 ⇒ 视为带了真值
            let has_value = rest.chars().take(8).filter(|c| c.is_alphanumeric()).count() >= 4;
            if has_value {
                return Some(cat);
            }
            from = pos + label.len();
            if from >= lower.len() {
                break;
            }
        }
    }
    None
}

/// 外发前唯一硬拒入口(纯函数, 可单测)
pub fn check_send_guard(draft: &MailDraft) -> Result<(), GuardError> {
    let recipients: Vec<&String> = draft.to.iter().filter(|s| !s.trim().is_empty()).collect();
    if recipients.is_empty() {
        return Err(GuardError::MissingRecipient);
    }
    if recipients.len() > 1 {
        return Err(GuardError::BatchForbidden);
    }
    if draft.text.trim().is_empty() {
        return Err(GuardError::EmptyContent);
    }
    if let Some(cat) = looks_like_secret(&draft.text) {
        return Err(GuardError::ForbiddenContent(cat.to_string()));
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub enum MailServiceError {
    Guard(GuardError),
    Port(MailPortError),
    Store(String),
}

impl MailServiceError {
    pub fn kind(&self) -> &str {
        match self {
            Self::Guard(g) => g.kind(),
            Self::Port(p) => &p.kind,
            Self::Store(_) => "store_unreadable",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Guard(g) => g.message(),
            Self::Port(p) => p.message.clone(),
            Self::Store(m) => m.clone(),
        }
    }
}

impl From<GuardError> for MailServiceError {
    fn from(g: GuardError) -> Self {
        Self::Guard(g)
    }
}

impl From<MailPortError> for MailServiceError {
    fn from(p: MailPortError) -> Self {
        Self::Port(p)
    }
}

impl From<String> for MailServiceError {
    fn from(s: String) -> Self {
        Self::Store(s)
    }
}

/// 邮件能力装配体。Web / CLI / Tauri 三端共用。
pub struct MailService {
    store: Arc<MailStore>,
    adapters: Vec<Arc<dyn MailPort>>,
}

impl MailService {
    pub fn new(store: Arc<MailStore>, adapters: Vec<Arc<dyn MailPort>>) -> Self {
        Self { store, adapters }
    }

    pub fn store(&self) -> &Arc<MailStore> {
        &self.store
    }

    /// 已配置账号（按 Adapter 注册顺序）
    pub fn accounts(&self) -> Vec<&str> {
        self.adapters.iter().map(|a| a.account_id()).collect()
    }

    pub fn adapter(&self, account: &str) -> Result<Arc<dyn MailPort>, GuardError> {
        self.adapters
            .iter()
            .find(|a| a.account_id() == account)
            .cloned()
            .ok_or_else(|| GuardError::NoAdapter(account.to_string()))
    }

    /// 遍历所有账号同步。单个账号失败不影响其它, 错误进各自 `SyncReport.error`。
    pub async fn sync_all(&self) -> Vec<SyncReport> {
        let mut out = Vec::with_capacity(self.adapters.len());
        for a in &self.adapters {
            match a.sync().await {
                Ok(mut r) => {
                    // 把同步到的元数据落索引
                    if let Ok(list) = a.list(MailQuery { limit: Some(500), ..Default::default() }).await {
                        for m in &list {
                            let _ = self.store.upsert_meta(m);
                        }
                        r.new = r.new.max(list.len());
                    }
                    out.push(r);
                }
                Err(e) => out.push(SyncReport {
                    account: a.account_id().to_string(),
                    stale: true,
                    error: Some(format!("{}: {}", e.kind, e.message)),
                    ..Default::default()
                }),
            }
        }
        out
    }

    pub fn list(&self, q: &MailQuery) -> Result<Vec<MailMeta>, MailServiceError> {
        Ok(self.store.list(q)?)
    }

    /// 读正文: 本地已有(发件箱 / 已缓存)就直接给, 不依赖 Adapter; 没有才拉一次并缓存。
    pub async fn read(&self, id: &MailId) -> Result<MailBody, MailServiceError> {
        let meta = self
            .store
            .get_meta(id)?
            .ok_or_else(|| MailServiceError::Store(format!("mail_not_found: {id}")))?;
        if let Some(text) = self.store.get_body(id)? {
            return Ok(MailBody { meta, text, html: None, attachments: Vec::new() });
        }
        let adapter = self.adapter(&meta.account)?;
        let body = adapter.read(id).await?;
        self.store.put_body(id, &body.text)?;
        Ok(body)
    }

    /// 受约束发送。硬拒先于 Adapter, 任何配置都不能绕过。
    pub async fn send(&self, draft: &MailDraft) -> Result<MailId, MailServiceError> {
        check_send_guard(draft)?;
        let adapter = self.adapter(&draft.account)?;
        let id = adapter.send(draft.clone()).await?;

        // 发送成功即落本地「发件箱」索引: 否则 Agent 自己都搜不到刚发的东西。
        // 真实 IMAP 的 Sent 副本会在下次 sync 以各自 uid 再出现, id 不同, 不互相覆盖。
        let meta = MailMeta {
            id: id.clone(),
            account: draft.account.clone(),
            mailbox: "outbox".into(),
            uid: 0,
            subject: draft.subject.clone(),
            from: draft.account.clone(),
            to: draft.to.clone(),
            date_ms: chrono::Utc::now().timestamp_millis(),
            flags: vec!["\\Sent".into()],
            snippet: draft.text.chars().take(200).collect(),
            has_attachments: false,
        };
        self.store.upsert_meta(&meta)?;
        self.store.put_body(&id, &draft.text)?;
        Ok(id)
    }

    pub async fn delete(&self, ids: &[MailId]) -> Result<usize, MailServiceError> {
        if ids.is_empty() {
            return Ok(0);
        }
        // 先向 Adapter 删, 成功后再删本地(避免本地删了远端还在)
        let accounts: Vec<String> = {
            let mut v = Vec::new();
            for id in ids {
                if let Some(m) = self.store.get_meta(id)? {
                    if !v.contains(&m.account) {
                        v.push(m.account);
                    }
                }
            }
            v
        };
        for account in accounts {
            if let Ok(a) = self.adapter(&account) {
                let owned: Vec<MailId> = ids
                    .iter()
                    .filter(|id| {
                        self.store
                            .get_meta(id)
                            .ok()
                            .flatten()
                            .map(|m| m.account == account)
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect();
                a.delete(&owned).await?;
            }
        }
        Ok(self.store.delete(ids)?)
    }

    pub async fn archive(&self, ids: &[MailId]) -> Result<(), MailServiceError> {
        if ids.is_empty() {
            return Ok(());
        }
        let mut by_account: std::collections::HashMap<String, Vec<MailId>> = Default::default();
        for id in ids {
            if let Some(m) = self.store.get_meta(id)? {
                by_account.entry(m.account).or_default().push(id.clone());
            }
        }
        for (account, batch) in by_account {
            let a = self.adapter(&account)?;
            a.archive(&batch).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(to: &[&str], text: &str) -> MailDraft {
        MailDraft {
            account: "me@x.com".into(),
            to: to.iter().map(|s| s.to_string()).collect(),
            subject: "主题".into(),
            text: text.into(),
            in_reply_to: None,
        }
    }

    #[test]
    fn single_recipient_plain_text_passes() {
        assert!(check_send_guard(&draft(&["a@b.com"], "明天下午三点开会")).is_ok());
    }

    #[test]
    fn multiple_recipients_are_refused() {
        let e = check_send_guard(&draft(&["a@b.com", "c@d.com"], "hi")).unwrap_err();
        assert_eq!(e.kind(), "batch_forbidden");
    }

    #[test]
    fn empty_recipient_is_refused() {
        assert_eq!(
            check_send_guard(&draft(&["  "], "hi")).unwrap_err().kind(),
            "missing_recipient"
        );
    }

    #[test]
    fn empty_body_is_refused() {
        assert_eq!(
            check_send_guard(&draft(&["a@b.com"], "   ")).unwrap_err().kind(),
            "empty_content"
        );
    }

    #[test]
    fn credential_with_value_is_refused() {
        assert_eq!(
            check_send_guard(&draft(&["a@b.com"], "密码: hunter2")).unwrap_err().kind(),
            "forbidden_content"
        );
        assert_eq!(
            check_send_guard(&draft(&["a@b.com"], "验证码：123456")).unwrap_err().kind(),
            "forbidden_content"
        );
        assert_eq!(
            check_send_guard(&draft(&["a@b.com"], "private key = 0xdeadbeef")).unwrap_err().kind(),
            "forbidden_content"
        );
    }

    #[test]
    fn mentioning_password_without_value_passes() {
        // 正常沟通不该被误杀
        assert!(check_send_guard(&draft(&["a@b.com"], "请尽快修改密码, 谢谢")).is_ok());
    }

    #[test]
    fn no_adapter_is_reported_not_faked() {
        let dir = std::env::temp_dir().join(format!(
            "bolloon_mail_svc_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Arc::new(MailStore::open(&dir).unwrap());
        let svc = MailService::new(store, vec![]);
        let err = match svc.adapter("nobody@x.com") {
            Ok(_) => panic!("没有 Adapter 时必须报错, 不能假装可用"),
            Err(e) => e,
        };
        assert_eq!(err.kind(), "provider_not_configured");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
