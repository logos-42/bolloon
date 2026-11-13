//! 邮件链路端到端验收门（真文件、真 SQLite、真加密；不联网）。
//!
//! 对应设计文档 `docs/plans/2026-11-13-mail-contacts-sms-design.md` §11：
//! 1. 账号配置可读、坏配置报错
//! 2. 发送落 outbox 且 `really_sent: false`（不谎称外发）
//! 3. 发件箱进本地索引, `mail_search` 命中
//! 4. 多收件人 / 凭据正文被硬拒
//! 5. 磁盘无明文正文、无密码
//! 6. 重开 store 数据仍在
//! 7. 索引损坏 → fail-closed
//! 8. 没有「全文同步给好友节点」的入口（Port 只有单账号读写信箱的能力）

use std::path::PathBuf;

use bolloon_agent::home::BolloonHome;
use bolloon_agent::mail::{
    build_service, save_accounts, AccountConfig, AccountsFile, MailDraft, MailQuery, MailStore,
};

fn tmp_home(tag: &str) -> BolloonHome {
    let d = std::env::temp_dir().join(format!(
        "bolloon_mail_chain_{}_{}_{}",
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

fn account(name: &str) -> AccountConfig {
    AccountConfig {
        account: name.into(),
        mode: "local_sink".into(),
        ..Default::default()
    }
}

fn draft(to: &[&str], text: &str) -> MailDraft {
    MailDraft {
        account: "me@x.com".into(),
        to: to.iter().map(|s| s.to_string()).collect(),
        subject: "季度报价".into(),
        text: text.into(),
        in_reply_to: None,
    }
}

/// 长正文: 尾部标记只可能出现在全文里, 不会出现在 200 字摘要里
fn long_body() -> String {
    format!("{}{}", "正文内容 ".repeat(60), "TAIL_MARKER_9f3a")
}

fn walk_files(p: &PathBuf, out: &mut Vec<PathBuf>) {
    if p.is_file() {
        out.push(p.clone());
        return;
    }
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            walk_files(&e.path(), out);
        }
    }
}

#[tokio::test]
async fn mail_chain_end_to_end() {
    let home = tmp_home("e2e");
    save_accounts(
        &home,
        &AccountsFile { accounts: vec![account("me@x.com")] },
    )
    .unwrap();

    let svc = build_service(&home).unwrap();
    assert_eq!(svc.accounts(), vec!["me@x.com"], "账号应被装配");

    // 1) 正常单收件人发送
    let body = long_body();
    let id = svc.send(&draft(&["a@b.com"], &body)).await.unwrap();
    assert!(id.as_str().starts_with("local/me@x.com/"), "{}", id);

    // 2) outbox 真落盘, 且不谎称已外发
    let mut files = Vec::new();
    walk_files(&home.root().join("mail").to_path_buf(), &mut files);
    let outbox: Vec<_> = files
        .iter()
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .filter(|p| p.to_string_lossy().contains("outbox"))
        .collect();
    assert!(!outbox.is_empty(), "outbox 应有记录");
    let raw = std::fs::read_to_string(outbox[0]).unwrap();
    assert!(raw.contains("\"really_sent\": false"), "不得谎称已外发: {raw}");
    assert!(raw.contains("未真实外发"), "必须带人读说明: {raw}");

    // 3) 发件箱进索引, 可被搜到
    let hit = svc
        .list(&MailQuery { keyword: Some("报价".into()), ..Default::default() })
        .unwrap();
    assert_eq!(hit.len(), 1, "刚发的邮件应可检索");

    // 4) 硬拒: 多收件人 / 凭据正文
    let e = svc.send(&draft(&["a@b.com", "c@d.com"], "hi")).await.unwrap_err();
    assert_eq!(e.kind(), "batch_forbidden");
    let e = svc.send(&draft(&["a@b.com"], "密码: hunter2")).await.unwrap_err();
    assert_eq!(e.kind(), "forbidden_content");

    // 5) 磁盘无明文正文、无密码
    let mut all = Vec::new();
    walk_files(&home.root().join("mail").to_path_buf(), &mut all);
    for f in &all {
        let bytes = std::fs::read(f).unwrap_or_default();
        let text = String::from_utf8_lossy(&bytes);
        // 全文标记只可能在正文本体里 ⇒ 任何文件都不许出现
        assert!(!text.contains("TAIL_MARKER_9f3a"), "磁盘出现正文明文: {}", f.display());
        assert!(!text.contains("hunter2"), "磁盘出现密码明文: {}", f.display());
    }

    // 6) 重开 store 数据仍在
    drop(svc);
    let store = MailStore::open(home.root().join("mail")).unwrap();
    assert_eq!(store.count().unwrap(), 1, "重启后索引仍在");
    assert!(
        store
            .get_body(&id)
            .unwrap()
            .as_deref()
            .unwrap_or_default()
            .contains("TAIL_MARKER_9f3a"),
        "重启后正文仍可解密"
    );
    let _ = &body;

    let _ = std::fs::remove_dir_all(home.root().parent().unwrap());
}

#[tokio::test]
async fn broken_accounts_file_fails_closed() {
    let home = tmp_home("broken");
    std::fs::create_dir_all(home.root().join("mail")).unwrap();
    std::fs::write(home.root().join("mail").join("accounts.json"), "{ not json").unwrap();

    let e = match build_service(&home) {
        Ok(_) => panic!("坏配置不该装配成功"),
        Err(e) => e,
    };
    assert!(e.contains("解析失败"), "坏配置必须报错而不是静默空集: {e}");

    let _ = std::fs::remove_dir_all(home.root().parent().unwrap());
}

#[tokio::test]
async fn no_adapter_never_fakes_success() {
    let home = tmp_home("noadapter");
    save_accounts(
        &home,
        &AccountsFile { accounts: vec![account("me@x.com")] },
    )
    .unwrap();
    let svc = build_service(&home).unwrap();

    // 发给一个没配置的账号 ⇒ provider_not_configured, 不是「已发送」
    let mut d = draft(&["a@b.com"], "hi");
    d.account = "nobody@x.com".into();
    let e = svc.send(&d).await.unwrap_err();
    assert_eq!(e.kind(), "provider_not_configured");

    let _ = std::fs::remove_dir_all(home.root().parent().unwrap());
}
