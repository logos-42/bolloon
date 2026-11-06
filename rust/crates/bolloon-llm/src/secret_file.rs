//! 加密文件凭据后端 + 链式后端 (2026-11-06 leo: "key 要能保存, 下次直接用, 前端不能明文")
//!
//! 为什么要有它: Tauri App 首次写系统钥匙串常被拒(权限/沙盒), 旧行为是"key 只活内存,
//! 重启就丢"。现在 `ChainBackend` 先试系统凭据库, 失败就落到**本机加密文件**:
//! - 用户 API key 用 `AES-256-GCM` 加密后才落盘 (nonce 每次随机, 附带认证 tag)
//! - 主密钥是 32 字节随机串, 单独 0600 文件; 目录与所有文件都 0600/0700
//! - **任何 API 响应都不含 key**, UI 只拿 `has_key` 布尔
//!
//! 诚实边界: 这是"本机文件保护"而非硬件级保险库 —— 能读到该用户主密钥文件的人可解密。
//! 系统钥匙串可用时优先用它; 加密文件只是让 App 在钥匙串不可用时仍能持久化。

use ring::aead::{self, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::digest;
use ring::rand::{SecureRandom, SystemRandom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};

/// 上次实际存/取成功的路径 (0=未知 1=系统凭据库 2=加密文件)
static LAST_KIND: AtomicU8 = AtomicU8::new(0);

pub fn last_kind() -> &'static str {
    match LAST_KIND.load(Ordering::SeqCst) {
        1 => "system_keychain",
        2 => "encrypted_file",
        _ => "unknown",
    }
}

use crate::secret_store::SecretBackend;

fn default_dir() -> PathBuf {
    if let Ok(h) = std::env::var("BOLLOON_HOME") {
        if !h.trim().is_empty() {
            return PathBuf::from(h).join("secrets");
        }
    }
    let base = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base).join(".bolloon").join("secrets")
}

fn set_0600(p: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
    }
}

fn file_for(dir: &Path, account: &str) -> PathBuf {
    // account 可能含 ':' / 空格; 用哈希做安全文件名, 不拼原串
    let hash = digest::digest(&digest::SHA256, account.as_bytes());
    let mut name = String::new();
    for b in hash.as_ref().iter().take(16) {
        name.push_str(&format!("{b:02x}"));
    }
    dir.join(format!("{name}.enc"))
}

fn master_key(dir: &Path) -> Result<[u8; 32], String> {
    let p = dir.join("master.key");
    if let Ok(raw) = std::fs::read(&p) {
        if raw.len() == 32 {
            let mut k = [0u8; 32];
            k.copy_from_slice(&raw);
            return Ok(k);
        }
        return Err("本机主密钥文件损坏(长度不是 32B) — 请删除后重填 key".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("建凭据目录失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let mut k = [0u8; 32];
    SystemRandom::new()
        .fill(&mut k)
        .map_err(|e| format!("生成主密钥失败: {e}"))?;
    let tmp = dir.join("master.key.tmp");
    std::fs::write(&tmp, k).map_err(|e| e.to_string())?;
    set_0600(&tmp);
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
    set_0600(&p);
    Ok(k)
}

fn cipher(dir: &Path) -> Result<LessSafeKey, String> {
    let k = master_key(dir)?;
    let ub = UnboundKey::new(&aead::AES_256_GCM, &k)
        .map_err(|_| "构造 AES-256-GCM 密钥失败".to_string())?;
    Ok(LessSafeKey::new(ub))
}

/// 加密文件后端 (可注入目录, 单测不碰真机)
pub struct FileEncryptedBackend {
    dir: PathBuf,
}

impl FileEncryptedBackend {
    pub fn new() -> Self {
        Self { dir: default_dir() }
    }
    pub fn with_dir(dir: PathBuf) -> Self {
        Self { dir }
    }
}

impl SecretBackend for FileEncryptedBackend {
    fn put(&self, account: &str, secret: &str) -> Result<(), String> {
        if secret.trim().is_empty() {
            return Err("空 key 不存".into());
        }
        let key = cipher(&self.dir)?;
        let mut nonce_bytes = [0u8; 12];
        SystemRandom::new()
            .fill(&mut nonce_bytes)
            .map_err(|e| format!("生成 nonce 失败: {e}"))?;
        let mut buf = secret.as_bytes().to_vec();
        key.seal_in_place_append_tag(
            Nonce::assume_unique_for_key(nonce_bytes),
            Aad::empty(),
            &mut buf,
        )
        .map_err(|e| format!("加密 key 失败: {e}"))?;
        let mut out = nonce_bytes.to_vec();
        out.extend_from_slice(&buf);
        let p = file_for(&self.dir, account);
        let tmp = p.with_extension("enc.tmp");
        std::fs::write(&tmp, &out).map_err(|e| e.to_string())?;
        set_0600(&tmp);
        std::fs::rename(&tmp, &p).map_err(|e| e.to_string())?;
        set_0600(&p);
        Ok(())
    }

    fn get(&self, account: &str) -> Option<String> {
        let raw = std::fs::read(file_for(&self.dir, account)).ok()?;
        if raw.len() < 13 {
            return None;
        }
        let key = cipher(&self.dir).ok()?;
        let mut nonce_bytes = [0u8; 12];
        nonce_bytes.copy_from_slice(&raw[..12]);
        let mut buf = raw[12..].to_vec();
        let plain = key
            .open_in_place(Nonce::assume_unique_for_key(nonce_bytes), Aad::empty(), &mut buf)
            .ok()?;
        String::from_utf8(plain.to_vec()).ok()
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let p = file_for(&self.dir, account);
        if p.exists() {
            std::fs::remove_file(&p).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn available(&self) -> bool {
        std::fs::create_dir_all(&self.dir).is_ok()
    }
}

/// 先系统凭据库, 失败落加密文件; 读时两边都找
pub struct ChainBackend<P: SecretBackend> {
    primary: P,
    fallback: FileEncryptedBackend,
}

impl<P: SecretBackend> ChainBackend<P> {
    pub fn new(primary: P, fallback: FileEncryptedBackend) -> Self {
        Self { primary, fallback }
    }
}

impl<P: SecretBackend> SecretBackend for ChainBackend<P> {
    fn put(&self, account: &str, secret: &str) -> Result<(), String> {
        match self.primary.put(account, secret) {
            Ok(()) => {
                LAST_KIND.store(1, Ordering::SeqCst);
                Ok(())
            }
            Err(primary_err) => {
                let r = self.fallback.put(account, secret).map_err(|file_err| {
                    format!("系统凭据库({primary_err})与加密文件({file_err})都写不进去")
                });
                if r.is_ok() {
                    LAST_KIND.store(2, Ordering::SeqCst);
                }
                r
            }
        }
    }

    fn get(&self, account: &str) -> Option<String> {
        if let Some(v) = self.primary.get(account) {
            LAST_KIND.store(1, Ordering::SeqCst);
            return Some(v);
        }
        let v = self.fallback.get(account)?;
        LAST_KIND.store(2, Ordering::SeqCst);
        Some(v)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let a = self.primary.delete(account);
        let b = self.fallback.delete(account);
        a.and(b)
    }

    fn available(&self) -> bool {
        self.primary.available() || self.fallback.available()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "bolloon_secret_file_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    struct AlwaysFail;
    impl SecretBackend for AlwaysFail {
        fn put(&self, _: &str, _: &str) -> Result<(), String> {
            Err("钥匙串被拒(模拟)".into())
        }
        fn get(&self, _: &str) -> Option<String> {
            None
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
        fn available(&self) -> bool {
            false
        }
    }

    #[test]
    fn roundtrip_and_no_plaintext_anywhere_on_disk() {
        let dir = tmp();
        let chain = ChainBackend::new(AlwaysFail, FileEncryptedBackend::with_dir(dir.clone()));
        chain.put("custom:ollama-cloud", "sk-super-secret").unwrap();
        assert_eq!(
            chain.get("custom:ollama-cloud").as_deref(),
            Some("sk-super-secret"),
            "下次必须直接可用"
        );
        // 目录里任何文件都不许含明文 key
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let raw = std::fs::read(e.path()).unwrap_or_default();
            assert!(
                !String::from_utf8_lossy(&raw).contains("sk-super-secret"),
                "磁盘出现明文: {}",
                e.path().display()
            );
        }
        chain.delete("custom:ollama-cloud").unwrap();
        assert!(chain.get("custom:ollama-cloud").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_ciphertext_is_refused() {
        let dir = tmp();
        let b = FileEncryptedBackend::with_dir(dir.clone());
        b.put("a", "key").unwrap();
        let p = file_for(&dir, "a");
        let mut raw = std::fs::read(&p).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        std::fs::write(&p, raw).unwrap();
        assert!(b.get("a").is_none(), "篡改必须被 GCM tag 拒掉");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
