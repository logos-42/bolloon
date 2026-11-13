//! 本地落盘 Adapter(不发网)。
//!
//! 用途:
//! 1. 测试与无配置时的兜底 —— 发送成功也**必须**标 `really_sent: false`;
//! 2. 语义对齐旧栈 `local-sink` 通道(`outbox/<requestId>.json`)。
//!
//! 诚实边界: 它不连任何邮件服务器, `sync` 恒为空。

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde_json::json;

use crate::mail::ports::{
    AttachmentMeta, MailBody, MailDraft, MailId, MailMeta, MailPort, MailPortError, MailQuery,
    MailResult, SyncReport,
};

fn set_0600(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
}

pub struct LocalSinkMailPort {
    account: String,
    outbox: PathBuf,
}

impl LocalSinkMailPort {
    /// `mail_dir` 是 `<home>/mail`, outbox 固定在其下。
    pub fn new(account: impl Into<String>, mail_dir: impl Into<PathBuf>) -> Self {
        let outbox = mail_dir.into().join("outbox");
        let _ = std::fs::create_dir_all(&outbox);
        Self { account: account.into(), outbox }
    }

    fn record_path(&self, id: &MailId) -> PathBuf {
        // id 里有 `/`, 用哈希做安全文件名
        use sha2::{Digest, Sha256};
        let d = Sha256::digest(id.as_str().as_bytes());
        self.outbox.join(format!("{}.json", hex::encode(&d[..16])))
    }

    fn read_record(&self, id: &MailId) -> MailResult<serde_json::Value> {
        let p = self.record_path(id);
        let raw = std::fs::read_to_string(&p)
            .map_err(|e| MailPortError::new("not_found", format!("本地发件箱无此记录: {e}")))?;
        serde_json::from_str(&raw)
            .map_err(|e| MailPortError::new("parse_failed", format!("发件记录损坏: {e}")))
    }
}

#[async_trait]
impl MailPort for LocalSinkMailPort {
    fn account_id(&self) -> &str {
        &self.account
    }

    async fn sync(&self) -> MailResult<SyncReport> {
        Ok(SyncReport { account: self.account.clone(), ..Default::default() })
    }

    async fn list(&self, q: MailQuery) -> MailResult<Vec<MailMeta>> {
        let rd = match std::fs::read_dir(&self.outbox) {
            Ok(r) => r,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(MailPortError::new("io", e.to_string())),
        };
        let mut out: Vec<MailMeta> = Vec::new();
        for e in rd.flatten() {
            if e.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            let id = v.get("id").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let subject = v.get("subject").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            let to: Vec<String> = v
                .get("to")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let ts = v.get("ts_ms").and_then(|x| x.as_i64()).unwrap_or(0);
            if q.unread_only {
                continue;
            }
            if let Some(k) = &q.keyword {
                if !subject.contains(k.as_str()) {
                    continue;
                }
            }
            out.push(MailMeta {
                id: MailId(id),
                account: self.account.clone(),
                mailbox: "outbox".into(),
                uid: 0,
                subject,
                from: self.account.clone(),
                to,
                date_ms: ts,
                flags: vec!["\\Sent".into()],
                // outbox 不存正文本体(明文不落第二处), 摘要留空
                snippet: String::new(),
                has_attachments: false,
            });
        }
        out.sort_by(|a, b| b.date_ms.cmp(&a.date_ms));
        if let Some(n) = q.limit {
            out.truncate(n);
        }
        Ok(out)
    }

    async fn read(&self, id: &MailId) -> MailResult<MailBody> {
        let v = self.read_record(id)?;
        // outbox 不存正文; 正文由 MailService 从加密 bodies/ 读缓存给
        let text = String::new();
        let subject = v.get("subject").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        let to: Vec<String> = v
            .get("to")
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let ts = v.get("ts_ms").and_then(|x| x.as_i64()).unwrap_or(0);
        Ok(MailBody {
            meta: MailMeta {
                id: id.clone(),
                account: self.account.clone(),
                mailbox: "outbox".into(),
                uid: 0,
                subject,
                from: self.account.clone(),
                to,
                date_ms: ts,
                flags: vec!["\\Sent".into()],
                snippet: text.chars().take(200).collect(),
                has_attachments: false,
            },
            text,
            html: None,
            attachments: Vec::<AttachmentMeta>::new(),
        })
    }

    async fn send(&self, draft: MailDraft) -> MailResult<MailId> {
        let id = MailId(format!("local/{}/{}", self.account, uuid::Uuid::new_v4()));
        // 正文**不进 outbox**(明文不落第二处); 这里只放元数据 + 正文指纹,
        // 正文本体由 service 写进加密的 bodies/<hash>.enc。
        use sha2::{Digest, Sha256};
        let text_sha256 = hex::encode(Sha256::digest(draft.text.as_bytes()));
        let rec = json!({
            "id": id.0,
            "account": self.account,
            "to": draft.to,
            "subject": draft.subject,
            "in_reply_to": draft.in_reply_to,
            "text_sha256": text_sha256,
            // 关键: 绝不谎称已外发
            "really_sent": false,
            "note": "本地落盘(未真实外发)",
            "ts_ms": chrono::Utc::now().timestamp_millis(),
        });
        let p = self.record_path(&id);
        let tmp = p.with_extension("json.tmp");
        std::fs::write(
            &tmp,
            serde_json::to_vec_pretty(&rec).map_err(|e| MailPortError::new("io", e.to_string()))?,
        )
        .map_err(|e| MailPortError::new("io", format!("写本地发件箱失败: {e}")))?;
        set_0600(&tmp);
        std::fs::rename(&tmp, &p).map_err(|e| MailPortError::new("io", e.to_string()))?;
        set_0600(&p);
        Ok(id)
    }

    async fn archive(&self, _ids: &[MailId]) -> MailResult<()> {
        Ok(())
    }

    async fn delete(&self, ids: &[MailId]) -> MailResult<()> {
        for id in ids {
            let p = self.record_path(id);
            if p.exists() {
                std::fs::remove_file(&p)
                    .map_err(|e| MailPortError::new("io", format!("删本地发件失败: {e}")))?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_local_sink_{}_{}_{}",
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

    #[tokio::test]
    async fn send_writes_outbox_and_marks_not_really_sent() {
        let dir = tmp("send");
        let p = LocalSinkMailPort::new("me@x.com", &dir);
        let id = p
            .send(MailDraft {
                account: "me@x.com".into(),
                to: vec!["a@b.com".into()],
                subject: "hi".into(),
                text: "正文".into(),
                in_reply_to: None,
            })
            .await
            .unwrap();

        let raw = std::fs::read_to_string(p.record_path(&id)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["really_sent"], false, "本地落盘不得谎称已外发");
        assert!(v["note"].as_str().unwrap().contains("未真实外发"));

        let listed = p.list(MailQuery::default()).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].subject, "hi");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn sync_is_empty_and_honest() {
        let dir = tmp("sync");
        let p = LocalSinkMailPort::new("me@x.com", &dir);
        let r = p.sync().await.unwrap();
        assert_eq!(r.fetched, 0);
        assert!(r.error.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn delete_removes_record() {
        let dir = tmp("delete");
        let p = LocalSinkMailPort::new("me@x.com", &dir);
        let id = p
            .send(MailDraft {
                account: "me@x.com".into(),
                to: vec!["a@b.com".into()],
                subject: "s".into(),
                text: "t".into(),
                in_reply_to: None,
            })
            .await
            .unwrap();
        assert!(p.record_path(&id).exists());
        p.delete(&[id.clone()]).await.unwrap();
        assert!(!p.record_path(&id).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
