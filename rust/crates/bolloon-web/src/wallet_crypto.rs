//! 钱包私钥本地加密（口令 PBKDF2-HMAC-SHA256 → AES-256-GCM）2026-11-15
//!
//! 目标（leo）：
//! - 私钥**本地加密**落盘：磁盘上只有密文（0600 只是额外一层文件权限，不是加密）。
//! - 口令不落盘、不进日志；忘口令即不可恢复（如实报错，不做后门）。
//! - 加密后的"备份串"可在另一台设备用同一口令恢复 ⇒ 跨设备共享同一钱包，
//!   **明文私钥永不出本机、永不走网络**。
//!
//! 格式：
//!   `EncWallet { v=1, kdf="pbkdf2-sha256", iters, salt(b64,16B), nonce(b64,12B), ct(b64) }`
//!   备份串 = base64( JSON{ v, address, enc } )（address 不是秘密，留作解密后校验）
//!
//! 安全边界（诚实）：PBKDF2 迭代 600k + AES-256-GCM + 随机 salt/nonce；
//! 这能防"直接翻文件读明文"，但不能防本机被完全控制（恶意进程可键盘记录口令）。
//! 真正的密钥托管不做——私钥不落服务端、不上云。

use aes_gcm::aead::Aead;
use base64::Engine;
use serde::{Deserialize, Serialize};

/// GCM 附加认证数据：把密文绑定到本协议，换用途即解密失败。
const AAD: &[u8] = b"bolloon-personal-wallet/1";
const KDF_ITERS: u32 = 600_000;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const MIN_PASSPHRASE: usize = 8;

fn b64e(b: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(b)
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 解码失败: {e}"))
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    use k256::elliptic_curve::rand_core::{OsRng, RngCore};
    let mut buf = [0u8; N];
    OsRng.fill_bytes(&mut buf);
    buf
}

fn derive_key(passphrase: &str, salt: &[u8], iters: u32) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<sha2::Sha256>(passphrase.as_bytes(), salt, iters, &mut key);
    key
}

/// 落盘的加密私钥信封（只含密文，绝不含明文）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EncWallet {
    pub v: u32,
    pub kdf: String,
    pub iters: u32,
    pub salt: String,
    pub nonce: String,
    pub ct: String,
}

impl EncWallet {
    pub fn is_supported(&self) -> bool {
        self.v == 1 && self.kdf == "pbkdf2-sha256"
    }
}

/// 用口令加密私钥 hex，返回密文信封。
pub fn encrypt_secret(passphrase: &str, secret_hex: &str) -> Result<EncWallet, String> {
    if passphrase.chars().count() < MIN_PASSPHRASE {
        return Err(format!("钱包口令至少 {MIN_PASSPHRASE} 位"));
    }
    if secret_hex.trim().is_empty() {
        return Err("私钥为空".into());
    }
    let salt = rand_bytes::<SALT_LEN>();
    let nonce = rand_bytes::<NONCE_LEN>();
    let key = derive_key(passphrase, &salt, KDF_ITERS);
    let cipher = new_cipher(&key)?;
    let ct = cipher
        .encrypt(
            aes_gcm::Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload { msg: secret_hex.trim().as_bytes(), aad: AAD },
        )
        .map_err(|e| format!("加密失败: {e}"))?;
    Ok(EncWallet {
        v: 1,
        kdf: "pbkdf2-sha256".into(),
        iters: KDF_ITERS,
        salt: b64e(&salt),
        nonce: b64e(&nonce),
        ct: b64e(&ct),
    })
}

/// 用口令解密信封，返回私钥 hex。口令错误会返回明确错误（GCM 校验失败）。
pub fn decrypt_secret(passphrase: &str, enc: &EncWallet) -> Result<String, String> {
    if !enc.is_supported() {
        return Err(format!(
            "不支持的钱包密文格式 v={} kdf={}",
            enc.v, enc.kdf
        ));
    }
    let salt = b64d(&enc.salt)?;
    let nonce = b64d(&enc.nonce)?;
    let ct = b64d(&enc.ct)?;
    if nonce.len() != NONCE_LEN {
        return Err("nonce 长度异常".into());
    }
    if salt.len() < 8 {
        return Err("salt 长度异常".into());
    }
    let key = derive_key(passphrase, &salt, enc.iters);
    let cipher = new_cipher(&key)?;
    let pt = cipher
        .decrypt(
            aes_gcm::Nonce::from_slice(&nonce),
            aes_gcm::aead::Payload { msg: &ct, aad: AAD },
        )
        .map_err(|_| "口令错误或密文损坏".to_string())?;
    String::from_utf8(pt).map_err(|e| format!("明文非 UTF-8: {e}"))
}

fn new_cipher(key: &[u8; 32]) -> Result<aes_gcm::Aes256Gcm, String> {
    use aes_gcm::KeyInit;
    aes_gcm::Aes256Gcm::new_from_slice(key).map_err(|e| format!("密钥初始化失败: {e}"))
}

/// 跨设备分享的备份串（只含密文）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WalletBlob {
    pub v: u32,
    pub address: String,
    pub enc: EncWallet,
}

/// 导出备份串（可复制到另一台设备，用同一口令恢复）。
pub fn export_blob(address: &str, enc: &EncWallet) -> Result<String, String> {
    let blob = WalletBlob {
        v: 1,
        address: address.to_string(),
        enc: enc.clone(),
    };
    let json = serde_json::to_vec(&blob).map_err(|e| e.to_string())?;
    Ok(b64e(&json))
}

/// 解析备份串。
pub fn parse_blob(blob: &str) -> Result<WalletBlob, String> {
    let raw = b64d(blob)?;
    let b: WalletBlob = serde_json::from_slice(&raw).map_err(|e| format!("备份串格式错误: {e}"))?;
    if b.v != 1 {
        return Err(format!("备份串版本不支持 v={}", b.v));
    }
    Ok(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SK: &str = "4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let enc = encrypt_secret("correct horse battery", SK).unwrap();
        assert_eq!(enc.v, 1);
        assert!(enc.ct != SK); // 密文不等于明文
        let out = decrypt_secret("correct horse battery", &enc).unwrap();
        assert_eq!(out, SK);
    }

    #[test]
    fn wrong_passphrase_fails() {
        let enc = encrypt_secret("password-123456", SK).unwrap();
        let e = decrypt_secret("password-654321", &enc).unwrap_err();
        assert!(e.contains("口令错误") || e.contains("损坏"));
    }

    #[test]
    fn short_passphrase_rejected() {
        assert!(encrypt_secret("short", SK).is_err());
    }

    #[test]
    fn blob_roundtrip_carries_ciphertext_only() {
        let enc = encrypt_secret("share-me-please", SK).unwrap();
        let blob = export_blob("0xabc", &enc).unwrap();
        let parsed = parse_blob(&blob).unwrap();
        assert_eq!(parsed.address, "0xabc");
        assert_eq!(decrypt_secret("share-me-please", &parsed.enc).unwrap(), SK);
        // 备份串里不应出现明文私钥
        let raw = String::from_utf8(b64d(&blob).unwrap()).unwrap();
        assert!(!raw.contains(SK));
    }

    #[test]
    fn salt_nonce_are_random() {
        let a = encrypt_secret("same-passphrase-1", SK).unwrap();
        let b = encrypt_secret("same-passphrase-1", SK).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ct, b.ct);
    }
}
