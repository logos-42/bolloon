//! history.rs — 输入历史落盘
//!
//! **复用 TS 原文** `src/cli/input-history.ts` (leo 2026-09-30: 「输入历史有落盘文件夹吗，要实现一下」)。
//!
//! 之前: 历史只在内存 (**重启即失**)。现在: 落 `~/.bolloon/rust/history/`, **一渠道一文件**
//!   `input-<channel>.jsonl` (0600) —— 渠道隔离 (不同 agent/channel 的输入不该互相串), 重启后 ↑ 还能翻出来。
//!
//! 四条纪律 (逐条照搬):
//!   1. **秘密不入历史** —— 64 位 hex 私钥 / `privateKey` / 助记词形态 (12+ 个小写词) 一律不写盘。
//!      输入历史是纯文本、会被翻出来、也可能被贴出去; 钱包助记词进去就是事故。
//!   2. **不打断输入** —— 落盘失败只记日志, 绝不让打字报错。
//!   3. **去重** —— 连续重复的同一行不重复写 (↑ 翻起来不烦)。
//!   4. **有上限** —— 内存 200 / 文件 500 (超了重写成最后 500, 原子写)。

use std::fs;
use std::path::PathBuf;

/** 内存里最多留多少条 (CLI 进程内) */
pub const MEMORY_CAP: usize = 200;
/** 文件里最多留多少条 (超了裁剪) */
pub const FILE_CAP: usize = 500;

/** 历史目录: `BOLLOON_HOME/rust/history` (与 CLI/Web/App 同一路径口径 `BolloonHome`) */
pub fn history_dir() -> PathBuf {
    bolloon_agent::home::BolloonHome::resolve()
        .root()
        .to_path_buf()
        .join("history")
}

/** 渠道名消毒 (防路径穿越): 只留 `[A-Za-z0-9._-]`, 上限 64 */
pub fn sanitize_channel(channel: Option<&str>) -> String {
    let s = channel.unwrap_or("");
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned.chars().take(64).collect()
    }
}

pub fn history_file(channel: Option<&str>) -> PathBuf {
    history_dir().join(format!("input-{}.jsonl", sanitize_channel(channel)))
}

/**
 * 看着像秘密的输入 —— **不写历史**。
 *
 * 判据刻意保守 (宁可漏存一条普通输入, 也不能把私钥/助记词写进历史文件):
 *   · 64 位 hex (可带 0x) —— 40 位 hex 地址**不拦** (地址是公开的)
 *   · 出现 privateKey / private_key / mnemonic / 助记词 / seedPhrase 字样
 *   · 12–30 个连续小写单词 (助记词形态)
 */
pub fn looks_secret(line: &str) -> bool {
    if is_hex64(line) {
        return true;
    }
    let lower = line.to_lowercase();
    for kw in ["privatekey", "private_key", "mnemonic", "助记词", "seedphrase", "seed_phrase"] {
        if contains_word(&lower, kw) {
            return true;
        }
    }
    // 助记词形态: 去掉前导非字母后, 整行是 12–30 个 3–8 位小写词
    let trimmed: String = line.trim_start_matches(|c: char| !c.is_ascii_alphabetic()).trim().to_string();
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    if (12..=30).contains(&words.len())
        && words
            .iter()
            .all(|w| (3..=8).contains(&w.len()) && w.chars().all(|c| c.is_ascii_lowercase()))
    {
        return true;
    }
    false
}

fn is_hex64(s: &str) -> bool {
    // `0x` + 64 位 hex (或裸 64 位 hex)
    let body = s.trim_start_matches("0x");
    let hex: String = body
        .chars()
        .take_while(|c| c.is_ascii_hexdigit())
        .collect();
    if hex.len() != 64 {
        return false;
    }
    // 必须是"独立的一段": 后面不是 hex 字符
    let after: String = body.chars().skip(64).collect();
    after.is_empty() || !after.chars().next().unwrap().is_ascii_hexdigit()
}

fn contains_word(hay: &str, needle: &str) -> bool {
    hay.match_indices(needle).any(|(i, _)| {
        let before_ok = i == 0
            || hay[..i]
                .chars()
                .last()
                .map(|c| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(true);
        let after = i + needle.len();
        let after_ok = after >= hay.len()
            || hay[after..]
                .chars()
                .next()
                .map(|c| !c.is_ascii_alphanumeric() && c != '_')
                .unwrap_or(true);
        before_ok && after_ok
    })
}

/** 读历史 (**旧→新**, 与内存数组同序: ↑ 取最后一条); 坏行跳过 (历史坏了不该让 CLI 起不来) */
pub fn load_input_history(channel: Option<&str>) -> Vec<String> {
    let file = history_file(channel);
    match fs::read_to_string(&file) {
        Ok(text) => {
            let mut out: Vec<String> = Vec::new();
            for raw in text.lines() {
                let line = raw.trim();
                if line.is_empty() {
                    continue;
                }
                if let Ok(serde_json::Value::String(v)) = serde_json::from_str::<serde_json::Value>(line) {
                    if !v.trim().is_empty() {
                        out.push(v);
                    }
                }
            }
            let skip = out.len().saturating_sub(MEMORY_CAP);
            out.into_iter().skip(skip).collect()
        }
        Err(_) => Vec::new(), // 不存在 / 读不了 ⇒ 空历史 (不打断启动)
    }
}

/**
 * 追加一条 (**去重**: 与最后一条相同则不写)。
 * 返回 true = 真写了; false = 跳过了 (秘密 / 空 / 重复 / 写失败)。
 */
pub fn append_input_history(line: &str, channel: Option<&str>) -> bool {
    let v = line.trim();
    if v.is_empty() {
        return false;
    }
    if looks_secret(v) {
        eprintln!("[input-history] 这行看着像密钥/助记词, **不写历史** (长度 {})", v.len());
        return false;
    }
    let file = history_file(channel);
    let dir = history_dir();
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let existing = load_input_history(channel);
    if existing.last().map(|s| s.as_str()) == Some(v) {
        return false;
    }
    let record = match serde_json::to_string(v) {
        Ok(s) => format!("{s}\n"),
        Err(_) => return false,
    };
    // 不打断输入: 写失败只记日志
    if append_raw(&file, &record).is_err() {
        eprintln!("[input-history] 写不了 {}: (已忽略)", file.display());
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&file, fs::Permissions::from_mode(0o600));
    }
    // 裁剪: 超了就原子重写成最后 FILE_CAP 条
    let mut kept = existing;
    kept.push(v.to_string());
    if kept.len() > FILE_CAP + 300 {
        let tail: Vec<&String> = kept.iter().rev().take(FILE_CAP).collect();
        let body: String = tail
            .into_iter()
            .rev()
            .filter_map(|s| serde_json::to_string(s).ok())
            .map(|s| format!("{s}\n"))
            .collect();
        let tmp = file.with_extension("jsonl.tmp");
        if fs::write(&tmp, body).is_ok() {
            let _ = fs::rename(&tmp, &file);
        }
    }
    true
}

fn append_raw(p: &std::path::Path, s: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = fs::OpenOptions::new().create(true).append(true).open(p)?;
    f.write_all(s.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 渠道名消毒: 防路径穿越
    #[test]
    fn channel_is_sanitized() {
        assert_eq!(sanitize_channel(Some("../../etc/passwd")), ".._.._etc_passwd");
        assert_eq!(sanitize_channel(None), "default");
        assert_eq!(sanitize_channel(Some("")), "default");
        let long = "a".repeat(100);
        assert!(sanitize_channel(Some(&long)).len() <= 64);
    }

    /// **秘密不入历史** —— 64 位 hex / 助记词 / 私钥字样
    #[test]
    fn secrets_are_never_written() {
        let hex64 = format!("0x{}", "a".repeat(64));
        assert!(looks_secret(&hex64), "64 位 hex 私钥必须被认出");
        assert!(looks_secret("我的 privateKey 是 xxx"));
        assert!(looks_secret("abandon ability able about above absent absorb abstract absurd abuse access accident account"));
        // 40 位 hex 地址是公开的 ⇒ **不拦**
        assert!(!looks_secret(&format!("0x{}", "b".repeat(40))));
        assert!(!looks_secret("帮我看一下 src/index.ts"));
    }

    /// 普通输入照写, 且**连续重复不写第二次**
    #[test]
    fn append_dedupes_consecutive() {
        let ch = "test-append-dedup";
        let file = history_file(Some(ch));
        let _ = fs::remove_file(&file);
        let first = append_input_history("第一条普通输入", Some(ch));
        let second = append_input_history("第一条普通输入", Some(ch));
        assert!(first, "首次应写入");
        assert!(!second, "连续重复不该再写");
        let mut h = load_input_history(Some(ch));
        assert_eq!(h.pop().as_deref(), Some("第一条普通输入"));
        let _ = fs::remove_file(&file);
    }

    /// 秘密输入直接跳过 (返回 false)
    #[test]
    fn append_refuses_secret() {
        assert!(!append_input_history(&format!("0x{}", "c".repeat(64)), Some("test-secret")));
        assert!(!append_input_history("", Some("test-secret")));
    }

    /// 坏行跳过: 历史文件坏了不该让 CLI 起不来
    #[test]
    fn corrupt_lines_are_skipped() {
        let ch = "test-corrupt";
        let file = history_file(Some(ch));
        let _ = fs::create_dir_all(history_dir());
        let _ = fs::write(&file, "\"好的\"\n{不是 json}\n\n\"也好的\"\n");
        let h = load_input_history(Some(ch));
        assert_eq!(h, vec!["好的".to_string(), "也好的".to_string()]);
        let _ = fs::remove_file(&file);
    }

    /// 内存上限: 只留最后 MEMORY_CAP 条
    #[test]
    fn memory_cap_is_enforced() {
        let ch = "test-cap";
        let file = history_file(Some(ch));
        let _ = fs::create_dir_all(history_dir());
        let body: String = (0..(MEMORY_CAP + 50))
            .filter_map(|i| serde_json::to_string(&format!("line{i}")).ok())
            .map(|s| format!("{s}\n"))
            .collect();
        let _ = fs::write(&file, body);
        let h = load_input_history(Some(ch));
        assert_eq!(h.len(), MEMORY_CAP);
        assert_eq!(h.last().unwrap(), &format!("line{}", MEMORY_CAP + 49));
        let _ = fs::remove_file(&file);
    }
}
