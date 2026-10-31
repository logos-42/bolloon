//! 本地凭据库 — **API key 不再以明文躺在 JSON 里**。
//!
//! 2026-10-31 (leo): `~/.bolloon/bolloon-config.json` 里两个 provider 的 apiKey 是明文,
//! 而 `read_file` 又没拦这类路径 ⇒ 一条工具调用就能把 key 读进模型上下文。两处一起收：
//!   1) 落盘: key 进**系统凭据库**, JSON 里只留空串;
//!   2) 读取: 旧文件里的明文 key 在 load 时**迁移**出去并把文件清干净 (含 .bak)。
//!
//! 三平台后端（都只用 std + 系统自带命令, 不引额外依赖）:
//! - **macOS**: 钥匙串 (`security -i`, 值走 stdin)
//! - **Windows**: DPAPI(CurrentUser) + 每账号一个密文文件 (`%USERPROFILE%\.bolloon\secrets\`)
//!   —— DPAPI 的密钥由用户登录凭据派生, 别的账户/换机拷走都解不开。
//! - **Linux**: Secret Service (`secret-tool`, 即 libsecret/GNOME Keyring);
//!   没装 `secret-tool` 时 `put` 如实报错并提示装 libsecret 或用环境变量 —— **绝不退回明文**。
//!
//! 三个实现都无条件编译（只靠 `default_backend()` 按平台选），这样任何平台上的
//! `cargo check` 都能发现语法/类型错误，不会出现「只有 Windows 才编译的坏代码」。

use std::io::Write;
use std::process::{Command, Stdio};

/// 凭据库 service 名 (同一 service 下每个 provider 一个 account)
pub const SERVICE: &str = "bolloon.llm";

/// 凭据后端。`get` 找不到返回 None; `put/delete` 失败给出人话原因。
pub trait SecretBackend: Send + Sync {
    fn put(&self, account: &str, secret: &str) -> Result<(), String>;
    fn get(&self, account: &str) -> Option<String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    /// 这台机器上到底能不能用（给 UI/CLI 如实提示, 不猜）
    fn available(&self) -> bool;
}

/// 跑一条命令, 把 `input` 喂进 stdin, 返回 (stdout, 是否成功, stderr)
fn run_with_stdin(prog: &str, args: &[&str], input: &str) -> Result<String, String> {
    let mut child = Command::new(prog)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("调不起 {prog}: {e}"))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("写 {prog} stdin 失败: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 {prog} 失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("{prog} 退出码 {:?}", out.status.code())
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn which(prog: &str) -> bool {
    Command::new(prog)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ───────────────────────── macOS: 钥匙串 ─────────────────────────

/// macOS 钥匙串后端 (`security -i`, 命令与值都走 stdin —— key 不出现在 argv/ps 里)
pub struct KeychainBackend;

impl KeychainBackend {
    fn run(&self, line: &str) -> Result<String, String> {
        run_with_stdin("security", &["-i"], &format!("{line}\n"))
    }
}

impl SecretBackend for KeychainBackend {
    fn put(&self, account: &str, secret: &str) -> Result<(), String> {
        let clean = secret.replace('"', "");
        self.run(&format!(
            "add-generic-password -a \"{account}\" -s \"{SERVICE}\" -w \"{clean}\" -U"
        ))
        .map(|_| ())
    }

    fn get(&self, account: &str) -> Option<String> {
        let out = self
            .run(&format!(
                "find-generic-password -a \"{account}\" -s \"{SERVICE}\" -w"
            ))
            .ok()?;
        let v = out.lines().next()?.trim().to_string();
        if v.is_empty() || v.starts_with("security:") {
            None
        } else {
            Some(v)
        }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.run(&format!(
            "delete-generic-password -a \"{account}\" -s \"{SERVICE}\""
        ))
        .map(|_| ())
    }

    fn available(&self) -> bool {
        cfg!(target_os = "macos") && which("security")
    }
}

// ─────────────────────── Windows: DPAPI + 密文文件 ───────────────────────

/// Windows 后端: 用 DPAPI(CurrentUser) 加密每个 key, 密文落 `%USERPROFILE%\.bolloon\secrets\`。
///
/// 为什么不用 cmdkey: 它只能写不能读（`/pass` 只写），拿不回明文；DPAPI 才有
/// 「同用户可解、别人/换机解不开」的语义，且 Windows 自带 PowerShell 即可调用，不用加依赖。
pub struct DpapiBackend;

impl DpapiBackend {
    fn dir() -> std::path::PathBuf {
        let base = std::env::var("BOLLOON_HOME")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| std::env::var("USERPROFILE").ok())
            .unwrap_or_else(|| ".".to_string());
        std::path::PathBuf::from(base)
            .join(".bolloon")
            .join("secrets")
    }

    /// 账号名里的 `:` 在 Windows 文件名里非法 ⇒ 换成 `_`
    fn file_for(account: &str) -> std::path::PathBuf {
        let safe: String = account
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        Self::dir().join(format!("{safe}.bin"))
    }

    fn powershell(script: &str, input: &str) -> Result<String, String> {
        run_with_stdin(
            "powershell",
            &["-NoProfile", "-NonInteractive", "-Command", script],
            input,
        )
    }
}

const DPAPI_PROTECT: &str = "$ErrorActionPreference='Stop';\
Add-Type -AssemblyName System.Security;\
$s=[Console]::In.ReadToEnd();\
$b=[Text.Encoding]::UTF8.GetBytes($s);\
$e=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');\
[Convert]::ToBase64String($e)";

const DPAPI_UNPROTECT: &str = "$ErrorActionPreference='Stop';\
Add-Type -AssemblyName System.Security;\
$t=[Console]::In.ReadToEnd();\
$b=[Convert]::FromBase64String($t);\
$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');\
[Text.Encoding]::UTF8.GetString($p)";

impl SecretBackend for DpapiBackend {
    fn put(&self, account: &str, secret: &str) -> Result<(), String> {
        let b64 = Self::powershell(DPAPI_PROTECT, secret)?;
        let b64 = b64.trim().to_string();
        if b64.is_empty() {
            return Err("DPAPI 加密返回空结果".into());
        }
        let path = Self::file_for(account);
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p).map_err(|e| format!("建凭据目录失败: {e}"))?;
        }
        std::fs::write(&path, b64).map_err(|e| format!("写密文失败: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    fn get(&self, account: &str) -> Option<String> {
        let path = Self::file_for(account);
        let b64 = std::fs::read_to_string(path).ok()?;
        let plain = Self::powershell(DPAPI_UNPROTECT, b64.trim()).ok()?;
        let v = plain.trim_end_matches(['\r', '\n']).to_string();
        if v.is_empty() { None } else { Some(v) }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let path = Self::file_for(account);
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("删密文失败: {e}")),
        }
    }

    fn available(&self) -> bool {
        cfg!(target_os = "windows") && which("powershell")
    }
}

// ─────────────────── Linux: Secret Service (secret-tool) ───────────────────

/// Linux 后端: libsecret 的 `secret-tool`（GNOME Keyring / KWallet 的 Secret Service 桥）。
/// 没装就**如实报错**, 让用户装 libsecret 或用环境变量 —— 不退回明文。
pub struct SecretServiceBackend;

impl SecretBackend for SecretServiceBackend {
    fn put(&self, account: &str, secret: &str) -> Result<(), String> {
        run_with_stdin(
            "secret-tool",
            &[
                "store",
                "--label",
                "Bolloon LLM",
                "service",
                SERVICE,
                "account",
                account,
            ],
            secret,
        )
        .map(|_| ())
    }

    fn get(&self, account: &str) -> Option<String> {
        let out = run_with_stdin(
            "secret-tool",
            &["lookup", "service", SERVICE, "account", account],
            "",
        )
        .ok()?;
        let v = out.trim_end_matches(['\r', '\n']).to_string();
        if v.is_empty() { None } else { Some(v) }
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        run_with_stdin(
            "secret-tool",
            &["clear", "service", SERVICE, "account", account],
            "",
        )
        .map(|_| ())
    }

    fn available(&self) -> bool {
        cfg!(target_os = "linux") && which("secret-tool")
    }
}

// ───────────────────────── 选择与命名 ─────────────────────────

/// 进程默认后端（按平台选；三个实现都参与编译，坏代码在任何平台 check 时都会暴露）
pub fn default_backend() -> &'static dyn SecretBackend {
    #[cfg(target_os = "macos")]
    static B: KeychainBackend = KeychainBackend;
    #[cfg(target_os = "windows")]
    static B: DpapiBackend = DpapiBackend;
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    static B: SecretServiceBackend = SecretServiceBackend;
    &B
}

/// 本机是否真的能存 key（macOS 钥匙串 / Windows DPAPI / Linux secret-tool）
pub fn backend_available() -> bool {
    default_backend().available()
}

/// 当前平台的凭据库名字（提示信息里用）
pub fn backend_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macOS 钥匙串"
    } else if cfg!(target_os = "windows") {
        "Windows DPAPI"
    } else {
        "Secret Service (secret-tool)"
    }
}

/// 账号命名: 内置 provider 与自定义 provider 分开命名空间, 避免撞名
pub fn account_for_provider(id: &str) -> String {
    format!("provider:{id}")
}
pub fn account_for_custom(id: &str) -> String {
    format!("custom:{id}")
}
