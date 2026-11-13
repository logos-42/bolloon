//! 邮件账号配置 + 装配工厂。
//!
//! `<home>/mail/accounts.json`(0600) 只存**元数据**, 不含任何密码:
//! ```json
//! { "accounts": [ { "account": "me@example.com", "mode": "local_sink" } ] }
//! ```
//! IMAP/SMTP 账号的密码走 `bolloon-llm` 的凭据后端, 由 Adapter 自己取, 不进这个文件。
//!
//! 未实现的 mode **不静默当成可用**: 记 warn 并跳过, 让 `/api/mail/accounts` 与日志都能看见。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::home::BolloonHome;

use super::adapters::LocalSinkMailPort;
use super::ports::MailPort;
use super::service::MailService;
use super::store::MailStore;

fn default_mode() -> String {
    "local_sink".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountConfig {
    pub account: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    /// IMAP 主机
    #[serde(default)]
    pub host: String,
    /// IMAP 端口 (缺省 993)
    #[serde(default)]
    pub port: u16,
    /// SMTP 主机 (缺省与 IMAP 同主机)
    #[serde(default)]
    pub smtp_host: Option<String>,
    /// SMTP 端口 (缺省 465 隐式 TLS / 587 STARTTLS)
    #[serde(default)]
    pub smtp_port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AccountsFile {
    #[serde(default)]
    pub accounts: Vec<AccountConfig>,
}

pub fn mail_dir(home: &BolloonHome) -> PathBuf {
    home.root().join("mail")
}

pub fn accounts_path(home: &BolloonHome) -> PathBuf {
    mail_dir(home).join("accounts.json")
}

/// 读配置。文件不存在 = 没配账号(合法空集); 文件坏了 = **报错**, 不当成空集。
pub fn load_accounts(home: &BolloonHome) -> Result<AccountsFile, String> {
    let p = accounts_path(home);
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s)
            .map_err(|e| format!("{p:?} 解析失败(不是合法 JSON): {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AccountsFile::default()),
        Err(e) => Err(format!("读 {p:?} 失败: {e}")),
    }
}

/// 原子写配置(0600)
pub fn save_accounts(home: &BolloonHome, cfg: &AccountsFile) -> Result<(), String> {
    let dir = mail_dir(home);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建 mail 目录失败: {e}"))?;
    let p = accounts_path(home);
    let tmp = Path::new(&dir).join("accounts.json.tmp");
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("写 accounts.json 失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &p).map_err(|e| format!("写 accounts.json 失败: {e}"))?;
    Ok(())
}

/// 从 home 装配一份 MailService。Web / CLI / Tauri 三端调同一个函数。
pub fn build_service(home: &BolloonHome) -> Result<MailService, String> {
    let dir = mail_dir(home);
    let store = Arc::new(MailStore::open(&dir)?);
    let cfg = load_accounts(home)?;
    let mut adapters: Vec<Arc<dyn MailPort>> = Vec::new();
    for a in cfg.accounts {
        let account = a.account.trim().to_string();
        if account.is_empty() {
            continue;
        }
        match a.mode.as_str() {
            "local_sink" => {
                adapters.push(Arc::new(LocalSinkMailPort::new(account, &dir)));
            }
            "imap_smtp" => match super::adapters::ImapSmtpAdapter::from_config(&a) {
                Ok(ad) => adapters.push(Arc::new(ad)),
                Err(e) => {
                    // 配置坏了要能看见, 不静默当成"没这个账号"
                    tracing::warn!(account = %account, error = %e, "IMAP/SMTP 账号配置无效, 已跳过");
                }
            },
            other => {
                // 明确告知, 不静默丢弃
                tracing::warn!(
                    account = %account,
                    mode = %other,
                    "邮件账号模式尚未实现, 已跳过 (不会出现在可用账号列表)"
                );
            }
        }
    }
    Ok(MailService::new(store, adapters))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> BolloonHome {
        let d = std::env::temp_dir().join(format!(
            "bolloon_mail_cfg_{}_{}_{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&d);
        BolloonHome::at(&d)
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let h = tmp_home("missing");
        assert!(load_accounts(&h).unwrap().accounts.is_empty());
    }

    #[test]
    fn broken_json_is_error_not_silent_empty() {
        let h = tmp_home("broken");
        std::fs::create_dir_all(mail_dir(&h)).unwrap();
        std::fs::write(accounts_path(&h), "{ this is not json").unwrap();
        let e = load_accounts(&h).unwrap_err();
        assert!(e.contains("解析失败"), "坏配置必须报错: {e}");
    }

    #[test]
    fn save_then_load_roundtrip() {
        let h = tmp_home("roundtrip");
        let cfg = AccountsFile {
            accounts: vec![AccountConfig {
                account: "me@x.com".into(),
                mode: "local_sink".into(),
                ..Default::default()
            }],
        };
        save_accounts(&h, &cfg).unwrap();
        let back = load_accounts(&h).unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].account, "me@x.com");
    }

    #[test]
    fn build_service_skips_unknown_mode_but_keeps_local_sink() {
        let h = tmp_home("build");
        save_accounts(
            &h,
            &AccountsFile {
                accounts: vec![
                    AccountConfig {
                        account: "me@x.com".into(),
                        mode: "local_sink".into(),
                        ..Default::default()
                    },
                    AccountConfig {
                        account: "later@x.com".into(),
                        mode: "pop3".into(),
                        host: "imap.x.com".into(),
                        port: 993,
                        user: "later".into(),
                        from: "later@x.com".into(),
                        ..Default::default()
                    },
                ],
            },
        )
        .unwrap();
        let svc = build_service(&h).unwrap();
        assert_eq!(svc.accounts(), vec!["me@x.com"], "未实现模式不得冒充可用");
    }

    #[test]
    fn build_service_accepts_imap_smtp_mode() {
        let h = tmp_home("imap");
        save_accounts(
            &h,
            &AccountsFile {
                accounts: vec![AccountConfig {
                    account: "me@x.com".into(),
                    mode: "imap_smtp".into(),
                    host: "imap.x.com".into(),
                    port: 993,
                    user: "me".into(),
                    from: "me@x.com".into(),
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        let svc = build_service(&h).unwrap();
        assert_eq!(svc.accounts(), vec!["me@x.com"], "IMAP/SMTP 账号应被接受");
    }
}
