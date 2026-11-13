//! 通讯录导入 Adapter: vCard(.vcf) / CSV。
//!
//! 桌面 / CLI / 手机通用(手机原生 `CNContactStore` / `ContactsContract` 另走平台 Adapter)。
//!
//! 诚实边界:
//! - vCard 只取 `FN` / `N` / `TEL` / `EMAIL` / `ORG` / `UID`; 不处理 PHOTO、分组、vCard 4.0 的
//!   全部扩展字段。
//! - CSV 只按表头 `name,phone,email,org` 读, **不处理带引号转义的逗号**(解析失败的行 skip 并计数)。
//! - 导入结果写 `<home>/mail/../contacts-import.json`(0600), 明文电话/邮箱只在本机。

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::mail::ports::{ContactMeta, ContactQuery, ContactsPort, ImportReport, MailPortError, MailResult};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ContactFile {
    #[serde(default)]
    contacts: Vec<ContactMeta>,
}

pub struct VcardCsvAdapter {
    source: String,
    input: PathBuf,
    store: PathBuf,
}

impl VcardCsvAdapter {
    /// `input` = .vcf / .csv 文件; `store_dir` = 落 `contacts-import.json` 的目录。
    pub fn new(input: impl Into<PathBuf>, store_dir: impl Into<PathBuf>) -> Self {
        let input = input.into();
        let source = input
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("contacts")
            .to_string();
        Self { source, input, store: store_dir.into().join("contacts-import.json") }
    }

    fn read_store(&self) -> Result<ContactFile, String> {
        match std::fs::read_to_string(&self.store) {
            Ok(s) => serde_json::from_str(&s)
                .map_err(|e| format!("{} 解析失败: {e}", self.store.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ContactFile::default()),
            Err(e) => Err(format!("读 {} 失败: {e}", self.store.display())),
        }
    }

    fn write_store(&self, f: &ContactFile) -> Result<(), String> {
        let tmp = self.store.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(f).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| format!("写通讯录失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &self.store).map_err(|e| format!("写通讯录失败: {e}"))?;
        Ok(())
    }
}

fn contact_id(name: &str, phones: &[String], emails: &[String], uid: Option<&str>) -> String {
    if let Some(u) = uid.filter(|u| !u.trim().is_empty()) {
        return format!("uid:{}", u.trim());
    }
    let mut h = Sha256::new();
    h.update(name.as_bytes());
    for p in phones {
        h.update(b"|p:");
        h.update(p.as_bytes());
    }
    for e in emails {
        h.update(b"|e:");
        h.update(e.as_bytes());
    }
    format!("h:{}", hex::encode(&h.finalize()[..12]))
}

fn split_kv(line: &str) -> Option<(String, String)> {
    let idx = line.find(':')?;
    Some((line[..idx].to_string(), line[idx + 1..].to_string()))
}

fn clean_tel(v: &str) -> String {
    v.trim()
        .trim_start_matches("tel:")
        .trim()
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '+' || *c == '-' || *c == ' ')
        .collect::<String>()
        .trim()
        .to_string()
}

pub fn parse_vcard(text: &str) -> Vec<ContactMeta> {
    let mut out = Vec::new();
    let mut name = String::new();
    let mut phones: Vec<String> = Vec::new();
    let mut emails: Vec<String> = Vec::new();
    let mut org: Option<String> = None;
    let mut uid: Option<String> = None;
    let mut in_card = false;

    for raw in text.lines() {
        let line = raw.trim();
        if line.eq_ignore_ascii_case("BEGIN:VCARD") {
            in_card = true;
            name.clear();
            phones.clear();
            emails.clear();
            org = None;
            uid = None;
            continue;
        }
        if line.eq_ignore_ascii_case("END:VCARD") {
            if in_card {
                let id = contact_id(&name, &phones, &emails, uid.as_deref());
                if !name.trim().is_empty() || !phones.is_empty() || !emails.is_empty() {
                    out.push(ContactMeta {
                        id,
                        name: if name.trim().is_empty() { "(未命名)".into() } else { name.trim().to_string() },
                        phones: phones.clone(),
                        emails: emails.clone(),
                        org: org.clone(),
                        updated_ms: 0,
                    });
                }
            }
            in_card = false;
            continue;
        }
        if !in_card {
            continue;
        }
        let Some((k, v)) = split_kv(line) else { continue };
        let ku = k.to_uppercase();
        if ku.starts_with("FN") || ku.starts_with("N") && !ku.starts_with("NOTE") {
            if name.trim().is_empty() {
                // N 是 `姓;名;...`, 转成「名 姓」
                let parts: Vec<&str> = v.split(';').collect();
                if parts.len() >= 2 {
                    name = format!("{} {}", parts[1].trim(), parts[0].trim()).trim().to_string();
                } else {
                    name = v.replace(';', " ").trim().to_string();
                }
            }
            if ku.starts_with("FN") {
                name = v.trim().to_string();
            }
        } else if ku.starts_with("TEL") {
            let t = clean_tel(&v);
            if !t.is_empty() && !phones.contains(&t) {
                phones.push(t);
            }
        } else if ku.starts_with("EMAIL") {
            let e = v.trim().to_string();
            if !e.is_empty() && !emails.contains(&e) {
                emails.push(e);
            }
        } else if ku.starts_with("ORG") {
            org = Some(v.replace(';', " ").trim().to_string());
        } else if ku.starts_with("UID") {
            uid = Some(v.trim().to_string());
        }
    }
    out
}

pub fn parse_csv(text: &str) -> (Vec<ContactMeta>, usize) {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let Some(header) = lines.next() else { return (vec![], 0) };
    let cols: Vec<String> = header.split(',').map(|s| s.trim().to_lowercase()).collect();
    let idx = |name: &str| cols.iter().position(|c| c == name);
    let (Some(ni), pi, ei, oi) = (idx("name"), idx("phone"), idx("email"), idx("org")) else {
        return (vec![], 0);
    };

    let mut out = Vec::new();
    let mut skipped = 0usize;
    for l in lines {
        let f: Vec<&str> = l.split(',').map(|s| s.trim()).collect();
        let Some(name) = f.get(ni).map(|s| s.to_string()) else {
            skipped += 1;
            continue;
        };
        if name.is_empty() {
            skipped += 1;
            continue;
        }
        let phones: Vec<String> = pi
            .and_then(|i| f.get(i))
            .map(|v| clean_tel(v))
            .filter(|v| !v.is_empty())
            .into_iter()
            .collect();
        let emails: Vec<String> = ei
            .and_then(|i| f.get(i))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .into_iter()
            .collect();
        let org = oi.and_then(|i| f.get(i)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        out.push(ContactMeta {
            id: contact_id(&name, &phones, &emails, None),
            name,
            phones,
            emails,
            org,
            updated_ms: 0,
        });
    }
    (out, skipped)
}

#[async_trait]
impl ContactsPort for VcardCsvAdapter {
    fn source_id(&self) -> &str {
        &self.source
    }

    async fn import_all(&self) -> MailResult<ImportReport> {
        let text = std::fs::read_to_string(&self.input).map_err(|e| {
            MailPortError::new("io", format!("读 {} 失败: {e}", self.input.display()))
        })?;
        let ext = self
            .input
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let (parsed, skipped) = match ext.as_str() {
            "vcf" | "vcard" => (parse_vcard(&text), 0usize),
            "csv" => parse_csv(&text),
            other => {
                return Err(MailPortError::new(
                    "unsupported_format",
                    format!("不支持的通讯录格式: .{other} (只认 .vcf / .csv)"),
                ))
            }
        };

        let mut existing = self.read_store().map_err(|e| MailPortError::new("io", e))?;
        let mut imported = 0usize;
        let mut updated = 0usize;
        for mut c in parsed {
            c.updated_ms = chrono::Utc::now().timestamp_millis();
            match existing.contacts.iter_mut().find(|x| x.id == c.id) {
                Some(old) => {
                    *old = c;
                    updated += 1;
                }
                None => {
                    existing.contacts.push(c);
                    imported += 1;
                }
            }
        }
        self.write_store(&existing)
            .map_err(|e| MailPortError::new("io", e))?;

        Ok(ImportReport {
            source: self.source.clone(),
            imported,
            updated,
            skipped,
        })
    }

    async fn list(&self, q: ContactQuery) -> MailResult<Vec<ContactMeta>> {
        let f = self.read_store().map_err(|e| MailPortError::new("io", e))?;
        let kw = q.keyword.as_deref().map(|s| s.to_lowercase());
        let mut out: Vec<ContactMeta> = f
            .contacts
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
        if let Some(n) = q.limit {
            out.truncate(n);
        }
        Ok(out)
    }
}

/// 读已导入的通讯录(给 Web/CLI 列表用; 文件不存在 = 空集, 坏了 = 报错)
pub fn load_imported(store_dir: &Path) -> Result<Vec<ContactMeta>, String> {
    let p = store_dir.join("contacts-import.json");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(serde_json::from_str::<ContactFile>(&s)
            .map_err(|e| format!("{} 解析失败: {e}", p.display()))?
            .contacts),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(format!("读 {} 失败: {e}", p.display())),
    }
}

/// 判断一个路径像不像通讯录文件(给 CLI / UI 做前置提示, 不猜内容)
pub fn looks_like_contacts_file(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).as_deref(),
        Some("vcf") | Some("vcard") | Some("csv")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_vcard_{}_{}_{}",
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

    #[test]
    fn vcard_parses_fn_tel_email_org() {
        let text = "BEGIN:VCARD\nVERSION:3.0\nFN:张三\nTEL;TYPE=CELL:+86 138-0013-8000\nEMAIL:z@x.com\nORG:某公司\nEND:VCARD\n";
        let v = parse_vcard(text);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "张三");
        assert_eq!(v[0].phones, vec!["+86 138-0013-8000"]);
        assert_eq!(v[0].emails, vec!["z@x.com"]);
        assert_eq!(v[0].org.as_deref(), Some("某公司"));
    }

    #[test]
    fn vcard_n_field_becomes_name() {
        let text = "BEGIN:VCARD\nN:李;四;;;\nTEL:13900000000\nEND:VCARD\n";
        let v = parse_vcard(text);
        assert_eq!(v[0].name, "四 李");
    }

    #[test]
    fn csv_parses_and_counts_skipped() {
        let text = "name,phone,email,org\n王五,13700000000,w@x.com,A\n,,,\n";
        let (v, skipped) = parse_csv(text);
        assert_eq!(v.len(), 1);
        assert_eq!(skipped, 1);
        assert_eq!(v[0].name, "王五");
    }

    #[tokio::test]
    async fn import_is_idempotent_and_searchable() {
        let dir = tmp("import");
        let f = dir.join("c.vcf");
        std::fs::write(&f, "BEGIN:VCARD\nFN:赵六\nTEL:13600000000\nEND:VCARD\n").unwrap();
        let a = VcardCsvAdapter::new(&f, &dir);

        let r1 = a.import_all().await.unwrap();
        assert_eq!((r1.imported, r1.updated), (1, 0));
        let r2 = a.import_all().await.unwrap();
        assert_eq!((r2.imported, r2.updated), (0, 1), "重复导入应更新不是新增");

        let hit = a
            .list(ContactQuery { keyword: Some("赵".into()), limit: None })
            .await
            .unwrap();
        assert_eq!(hit.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn unknown_extension_is_refused() {
        let dir = tmp("ext");
        let f = dir.join("c.txt");
        std::fs::write(&f, "whatever").unwrap();
        let a = VcardCsvAdapter::new(&f, &dir);
        let e = a.import_all().await.unwrap_err();
        assert_eq!(e.kind, "unsupported_format");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
