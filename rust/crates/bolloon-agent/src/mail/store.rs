//! 本地邮件索引 + 正文加密库。
//!
//! 落盘(`<home>/mail/`, 全部 0600/0700):
//! - `index.sqlite`  元数据索引(WAL + busy_timeout, 支持 CLI 与 Web 双进程)
//! - `bodies/*.enc`  正文 AES-256-GCM(nonce 前置, 与 `bolloon-llm::secret_file` 同格式)
//! - `master.key`    32B 主密钥(单独文件, 删除即等于删库)
//!
//! 纪律: 明文正文**只**存在于解密后的内存与返回值; 索引里只有 snippet(截断)。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::ports::{MailId, MailMeta, MailQuery};

fn set_0600(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
}

fn set_0700(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
    }
}

/// 正文加解密。主密钥在 mail 目录内, 与 LLM 凭据的 master.key 分离。
struct ContentCipher {
    key: [u8; 32],
}

impl ContentCipher {
    fn load_or_create(dir: &Path) -> Result<Self, String> {
        let p = dir.join("master.key");
        if let Ok(raw) = std::fs::read(&p) {
            if raw.len() == 32 {
                let mut k = [0u8; 32];
                k.copy_from_slice(&raw);
                return Ok(Self { key: k });
            }
            return Err("mail 主密钥文件损坏(长度不是 32B) — 拒绝解密, 请人工处理".into());
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("建 mail 目录失败: {e}"))?;
        set_0700(dir);
        let mut k = [0u8; 32];
        SystemRandom::new()
            .fill(&mut k)
            .map_err(|e| format!("生成 mail 主密钥失败: {e}"))?;
        let tmp = dir.join("master.key.tmp");
        std::fs::write(&tmp, k).map_err(|e| e.to_string())?;
        set_0600(&tmp);
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        set_0600(&p);
        Ok(Self { key: k })
    }

    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        let ub = UnboundKey::new(&aead::AES_256_GCM, &self.key)
            .map_err(|_| "构造 AES-256-GCM 密钥失败".to_string())?;
        let key = LessSafeKey::new(ub);
        let mut nonce = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|e| format!("生成 nonce 失败: {e}"))?;
        let mut buf = plain.to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce),
            Aad::empty(),
            &mut buf,
        )
        .map_err(|e| format!("加密正文失败: {e}"))?;
        let mut out = nonce.to_vec();
        out.extend_from_slice(&buf);
        Ok(out)
    }

    fn open(&self, raw: &[u8]) -> Result<Vec<u8>, String> {
        if raw.len() < 13 {
            return Err("正文密文过短(可能被截断)".into());
        }
        let ub = UnboundKey::new(&aead::AES_256_GCM, &self.key)
            .map_err(|_| "构造 AES-256-GCM 密钥失败".to_string())?;
        let key = LessSafeKey::new(ub);
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&raw[..12]);
        let mut buf = raw[12..].to_vec();
        let plain = key
            .open_in_place(Nonce::assume_unique_for_key(nonce), Aad::empty(), &mut buf)
            .map_err(|_| "正文解密失败(GCM tag 不符, 可能被篡改)".to_string())?;
        Ok(plain.to_vec())
    }
}

fn body_path(dir: &Path, id: &MailId) -> PathBuf {
    let d = Sha256::digest(id.as_str().as_bytes());
    dir.join("bodies").join(format!("{}.enc", hex::encode(&d[..16])))
}

/// 本地邮件索引。先 `open`, 再读写; 打开失败即 `store_unreadable`(fail-closed)。
pub struct MailStore {
    dir: PathBuf,
    conn: Mutex<Connection>,
    cipher: ContentCipher,
}

impl MailStore {
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self, String> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir).map_err(|e| format!("建 mail 目录失败: {e}"))?;
        set_0700(&dir);
        std::fs::create_dir_all(dir.join("bodies"))
            .map_err(|e| format!("建 bodies 目录失败: {e}"))?;
        std::fs::create_dir_all(dir.join("outbox"))
            .map_err(|e| format!("建 outbox 目录失败: {e}"))?;

        let conn = Connection::open(dir.join("index.sqlite"))
            .map_err(|e| format!("store_unreadable: 打开邮件索引失败: {e}"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| format!("store_unreadable: busy_timeout 失败: {e}"))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("store_unreadable: 开 WAL/外键失败: {e}"))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS mail_meta (
                id TEXT PRIMARY KEY,
                account TEXT NOT NULL,
                mailbox TEXT NOT NULL,
                uid INTEGER NOT NULL,
                subject TEXT NOT NULL,
                from_addr TEXT NOT NULL,
                to_addrs TEXT NOT NULL,
                date_ms INTEGER NOT NULL,
                flags TEXT NOT NULL,
                snippet TEXT NOT NULL,
                has_attachments INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_mail_account_date
                ON mail_meta(account, date_ms DESC);
            CREATE TABLE IF NOT EXISTS mail_cursor (
                account TEXT NOT NULL,
                mailbox TEXT NOT NULL,
                uidvalidity INTEGER NOT NULL,
                last_uid INTEGER NOT NULL,
                PRIMARY KEY (account, mailbox)
            );",
        )
        .map_err(|e| format!("store_unreadable: 建表失败: {e}"))?;

        let cipher = ContentCipher::load_or_create(&dir)?;
        Ok(Self { dir, conn: Mutex::new(conn), cipher })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "store_unreadable: 索引锁中毒".to_string())
    }

    pub fn upsert_meta(&self, m: &MailMeta) -> Result<(), String> {
        let to_addrs = serde_json::to_string(&m.to).map_err(|e| e.to_string())?;
        let flags = serde_json::to_string(&m.flags).map_err(|e| e.to_string())?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO mail_meta
                (id, account, mailbox, uid, subject, from_addr, to_addrs, date_ms, flags, snippet, has_attachments)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
                subject=excluded.subject,
                from_addr=excluded.from_addr,
                to_addrs=excluded.to_addrs,
                date_ms=excluded.date_ms,
                flags=excluded.flags,
                snippet=excluded.snippet,
                has_attachments=excluded.has_attachments",
            params![
                m.id.as_str(),
                m.account,
                m.mailbox,
                m.uid as i64,
                m.subject,
                m.from,
                to_addrs,
                m.date_ms,
                flags,
                m.snippet,
                if m.has_attachments { 1i64 } else { 0i64 },
            ],
        )
        .map_err(|e| format!("写索引失败: {e}"))?;
        Ok(())
    }

    pub fn list(&self, q: &MailQuery) -> Result<Vec<MailMeta>, String> {
        let mut sql = String::from(
            "SELECT id, account, mailbox, uid, subject, from_addr, to_addrs, date_ms, flags, snippet, has_attachments
             FROM mail_meta WHERE 1=1",
        );
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        if let Some(a) = &q.account {
            sql.push_str(" AND account = ?");
            args.push(rusqlite::types::Value::Text(a.clone()));
        }
        if let Some(mb) = &q.mailbox {
            sql.push_str(" AND mailbox = ?");
            args.push(rusqlite::types::Value::Text(mb.clone()));
        }
        if q.unread_only {
            sql.push_str(" AND flags NOT LIKE '%Seen%'");
        }
        if let Some(k) = &q.keyword {
            let like = format!("%{k}%");
            sql.push_str(" AND (subject LIKE ? OR from_addr LIKE ? OR snippet LIKE ?)");
            args.push(rusqlite::types::Value::Text(like.clone()));
            args.push(rusqlite::types::Value::Text(like.clone()));
            args.push(rusqlite::types::Value::Text(like));
        }
        sql.push_str(" ORDER BY date_ms DESC");
        if let Some(n) = q.limit {
            sql.push_str(" LIMIT ?");
            args.push(rusqlite::types::Value::Integer(n as i64));
        }

        let conn = self.lock()?;
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("查索引失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(args.iter()), row_to_meta)
            .map_err(|e| format!("查索引失败: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("读索引行失败: {e}"))?);
        }
        Ok(out)
    }

    pub fn get_meta(&self, id: &MailId) -> Result<Option<MailMeta>, String> {
        let conn = self.lock()?;
        conn.query_row(
            "SELECT id, account, mailbox, uid, subject, from_addr, to_addrs, date_ms, flags, snippet, has_attachments
             FROM mail_meta WHERE id = ?1",
            params![id.as_str()],
            row_to_meta,
        )
        .optional()
        .map_err(|e| format!("读索引失败: {e}"))
    }

    pub fn put_body(&self, id: &MailId, text: &str) -> Result<(), String> {
        let enc = self.cipher.seal(text.as_bytes())?;
        let p = body_path(&self.dir, id);
        let tmp = p.with_extension("enc.tmp");
        std::fs::write(&tmp, &enc).map_err(|e| format!("写正文失败: {e}"))?;
        set_0600(&tmp);
        std::fs::rename(&tmp, &p).map_err(|e| format!("写正文失败: {e}"))?;
        set_0600(&p);
        Ok(())
    }

    pub fn get_body(&self, id: &MailId) -> Result<Option<String>, String> {
        let p = body_path(&self.dir, id);
        let raw = match std::fs::read(&p) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(format!("读正文失败: {e}")),
        };
        let plain = self.cipher.open(&raw)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| "正文不是合法 UTF-8".to_string())
    }

    pub fn delete(&self, ids: &[MailId]) -> Result<usize, String> {
        let mut n = 0usize;
        {
            let conn = self.lock()?;
            for id in ids {
                n += conn
                    .execute("DELETE FROM mail_meta WHERE id = ?1", params![id.as_str()])
                    .map_err(|e| format!("删索引失败: {e}"))?;
            }
            drop(conn);
        }
        for id in ids {
            let p = body_path(&self.dir, id);
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(n)
    }

    pub fn set_flags(&self, id: &MailId, flags: &[String]) -> Result<(), String> {
        let flags = serde_json::to_string(flags).map_err(|e| e.to_string())?;
        let conn = self.lock()?;
        conn.execute(
            "UPDATE mail_meta SET flags = ?2 WHERE id = ?1",
            params![id.as_str(), flags],
        )
        .map_err(|e| format!("改 flags 失败: {e}"))?;
        Ok(())
    }

    pub fn set_cursor(
        &self,
        account: &str,
        mailbox: &str,
        uidvalidity: u32,
        last_uid: u32,
    ) -> Result<(), String> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO mail_cursor (account, mailbox, uidvalidity, last_uid)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(account, mailbox) DO UPDATE SET
                uidvalidity=excluded.uidvalidity,
                last_uid=excluded.last_uid",
            params![account, mailbox, uidvalidity as i64, last_uid as i64],
        )
        .map_err(|e| format!("写同步游标失败: {e}"))?;
        Ok(())
    }

    pub fn get_cursor(&self, account: &str, mailbox: &str) -> Result<Option<(u32, u32)>, String> {
        let conn = self.lock()?;
        let row: Option<(i64, i64)> = conn
            .query_row(
                "SELECT uidvalidity, last_uid FROM mail_cursor WHERE account = ?1 AND mailbox = ?2",
                params![account, mailbox],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("读同步游标失败: {e}"))?;
        Ok(row.map(|(v, u)| (v as u32, u as u32)))
    }

    pub fn count(&self) -> Result<usize, String> {
        let conn = self.lock()?;
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM mail_meta", [], |r| r.get(0))
            .map_err(|e| format!("统计失败: {e}"))?;
        Ok(n as usize)
    }
}

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<MailMeta> {
    let to_json: String = row.get(6)?;
    let flags_json: String = row.get(8)?;
    Ok(MailMeta {
        id: MailId(row.get(0)?),
        account: row.get(1)?,
        mailbox: row.get(2)?,
        uid: row.get::<_, i64>(3)? as u32,
        subject: row.get(4)?,
        from: row.get(5)?,
        to: serde_json::from_str(&to_json).unwrap_or_default(),
        date_ms: row.get(7)?,
        flags: serde_json::from_str(&flags_json).unwrap_or_default(),
        snippet: row.get(9)?,
        has_attachments: row.get::<_, i64>(10)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_mail_store_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn meta(account: &str, mailbox: &str, uid: u32, subject: &str) -> MailMeta {
        MailMeta {
            id: MailId::new(account, mailbox, uid),
            account: account.into(),
            mailbox: mailbox.into(),
            uid,
            subject: subject.into(),
            from: "a@example.com".into(),
            to: vec!["b@example.com".into()],
            date_ms: 1_700_000_000_000 + uid as i64,
            flags: vec![],
            snippet: "snippet".into(),
            has_attachments: false,
        }
    }

    #[test]
    fn roundtrip_list_and_search() {
        let dir = tmp_dir("roundtrip");
        let s = MailStore::open(&dir).unwrap();
        s.upsert_meta(&meta("me@x.com", "INBOX", 1, "报价单")).unwrap();
        s.upsert_meta(&meta("me@x.com", "INBOX", 2, "会议纪要")).unwrap();
        s.put_body(&MailId::new("me@x.com", "INBOX", 1), "正文 A").unwrap();

        assert_eq!(s.count().unwrap(), 2);

        let all = s.list(&MailQuery::default()).unwrap();
        assert_eq!(all.len(), 2);

        let hit = s
            .list(&MailQuery { keyword: Some("报价".into()), ..Default::default() })
            .unwrap();
        assert_eq!(hit.len(), 1);
        assert_eq!(hit[0].subject, "报价单");

        let body = s.get_body(&MailId::new("me@x.com", "INBOX", 1)).unwrap();
        assert_eq!(body.as_deref(), Some("正文 A"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn upsert_is_idempotent_and_updates_flags() {
        let dir = tmp_dir("upsert");
        let s = MailStore::open(&dir).unwrap();
        let mut m = meta("me@x.com", "INBOX", 7, "主题");
        s.upsert_meta(&m).unwrap();
        m.flags = vec!["\\Seen".into()];
        m.subject = "改过".into();
        s.upsert_meta(&m).unwrap();

        assert_eq!(s.count().unwrap(), 1, "同 id 不重复插入");
        let got = s.get_meta(&m.id).unwrap().unwrap();
        assert_eq!(got.subject, "改过");
        assert!(got.flags.iter().any(|f| f.contains("Seen")));

        let unread = s.list(&MailQuery { unread_only: true, ..Default::default() }).unwrap();
        assert!(unread.is_empty(), "已读邮件不该出现在未读查询里");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn body_is_encrypted_on_disk() {
        let dir = tmp_dir("enc");
        let s = MailStore::open(&dir).unwrap();
        let id = MailId::new("me@x.com", "INBOX", 1);
        s.upsert_meta(&meta("me@x.com", "INBOX", 1, "s")).unwrap();
        s.put_body(&id, "银行卡密码是 hunter2").unwrap();

        let p = body_path(&dir, &id);
        let raw = std::fs::read(&p).unwrap();
        assert!(
            !String::from_utf8_lossy(&raw).contains("hunter2"),
            "磁盘上不允许出现正文明文"
        );
        assert!(p.exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_body_is_refused() {
        let dir = tmp_dir("tamper");
        let s = MailStore::open(&dir).unwrap();
        let id = MailId::new("me@x.com", "INBOX", 1);
        s.put_body(&id, "原始正文").unwrap();

        let p = body_path(&dir, &id);
        let mut raw = std::fs::read(&p).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        std::fs::write(&p, raw).unwrap();

        let err = s.get_body(&id).unwrap_err();
        assert!(err.contains("篡改") || err.contains("解密"), "篡改必须被 GCM tag 拒: {err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_removes_meta_and_body() {
        let dir = tmp_dir("delete");
        let s = MailStore::open(&dir).unwrap();
        let id = MailId::new("me@x.com", "INBOX", 1);
        s.upsert_meta(&meta("me@x.com", "INBOX", 1, "s")).unwrap();
        s.put_body(&id, "x").unwrap();

        assert_eq!(s.delete(&[id.clone()]).unwrap(), 1);
        assert_eq!(s.count().unwrap(), 0);
        assert!(s.get_body(&id).unwrap().is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_roundtrip() {
        let dir = tmp_dir("cursor");
        let s = MailStore::open(&dir).unwrap();
        assert!(s.get_cursor("me@x.com", "INBOX").unwrap().is_none());
        s.set_cursor("me@x.com", "INBOX", 99, 42).unwrap();
        assert_eq!(s.get_cursor("me@x.com", "INBOX").unwrap(), Some((99, 42)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cursor_survives_reopen() {
        let dir = tmp_dir("reopen");
        {
            let s = MailStore::open(&dir).unwrap();
            s.set_cursor("me@x.com", "INBOX", 1, 10).unwrap();
            s.upsert_meta(&meta("me@x.com", "INBOX", 10, "重启前")).unwrap();
        }
        let s2 = MailStore::open(&dir).unwrap();
        assert_eq!(s2.get_cursor("me@x.com", "INBOX").unwrap(), Some((1, 10)));
        assert_eq!(s2.count().unwrap(), 1, "重启后索引仍在");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
