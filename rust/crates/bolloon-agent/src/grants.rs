//! 一次性授权（grant）—— 工具 / 命令 / 二进制 / 路径，**三平台同一套**，落盘记住，不再追问。
//!
//! 2026-11-04 (leo: 「Windows 和 Linux 也适配这样的命令允许，一次性的；工具、命令、文件、目录都是」)
//!
//! 为什么要这一层：
//! - macOS 上「允许访问下载文件夹」靠代码签名 + TCC 记住；Windows / Linux 没有等价系统弹窗，
//!   所以**"允许一次就永久生效"必须由应用自己实现**，否则每台机器、每次重建都重新问一遍。
//! - 现有 harness 只有两种状态：默认授予清单 / 完全访问。介于两者之间的"这一个工具/这一条命令/
//!   这一个目录我允许"没有存储位置 —— 这个模块就是那个存储位置。
//!
//! 分四类（互不越权）：
//! - `tools`    工具名（harness permission 门用）
//! - `bins`     命令的**可执行文件名**（`python3`、`brew` …）—— 白名单外的 bin 被允许一次后记住
//! - `commands` 具体命令前缀（如 `git push` / `npm run deploy`）—— 允许一条就只放这一条
//! - `paths`    目录前缀（受保护路径/工作区外路径允许一次后记住）
//!
//! 硬边界（**永不进这个库**）：`guard_shell` 的 denylist（`rm -rf /`、`sudo`、写块设备…）、
//! 凭据路径（`~/.ssh`、id_rsa、`.env`…）。它们即使在"完全访问"下也各自有独立闸门，
//! 不允许被一条 grant 打开。
//!
//! 落盘：`${BOLLOON_HOME:-$HOME/.bolloon}/grants.json`（0600，tmp+rename 原子写）。

use std::collections::BTreeSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// 一次性授权库（四类独立集合，序列化后直接落盘）
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GrantStore {
    #[serde(default)]
    pub tools: BTreeSet<String>,
    #[serde(default)]
    pub bins: BTreeSet<String>,
    #[serde(default)]
    pub commands: BTreeSet<String>,
    #[serde(default)]
    pub paths: BTreeSet<String>,
}

/// 落盘位置（`BOLLOON_HOME` 优先；Windows 用 `USERPROFILE`）
pub fn grants_path() -> PathBuf {
    let base = std::env::var("BOLLOON_HOME")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("HOME").ok())
        .or_else(|| std::env::var("USERPROFILE").ok())
        .unwrap_or_else(|| ".".to_string());
    PathBuf::from(base).join(".bolloon").join("grants.json")
}

impl GrantStore {
    /// 读盘。文件不存在 ⇒ 空库；解析失败 ⇒ 空库 + 告警（绝不冒充"有授权"）
    pub fn load() -> Self {
        let p = grants_path();
        let Ok(raw) = std::fs::read_to_string(&p) else {
            return Self::default();
        };
        match serde_json::from_str::<Self>(&raw) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(path = %p.display(), error = %e, "grants.json 解析失败, 按空库处理");
                Self::default()
            }
        }
    }

    /// 原子写（tmp + rename；0600 —— 里面有本机路径，不该被别人读）
    pub fn save(&self) -> std::io::Result<()> {
        let p = grants_path();
        if let Some(dir) = p.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let body = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let tmp = p.with_extension(format!("json.tmp{}", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(body.as_bytes())?;
            f.sync_all()?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &p)
    }

    /// 记一条授权。`kind` ∈ tools|bins|commands|paths
    pub fn grant(&mut self, kind: &str, value: &str) -> Result<(), String> {
        let v = value.trim();
        if v.is_empty() {
            return Err("授权内容不能为空".into());
        }
        let set = self.set_mut(kind)?;
        set.insert(normalize(kind, v));
        Ok(())
    }

    /// 收回一条授权（返回是否真的删掉了）
    pub fn revoke(&mut self, kind: &str, value: &str) -> Result<bool, String> {
        let v = normalize(kind, value.trim());
        let set = self.set_mut(kind)?;
        Ok(set.remove(&v))
    }

    fn set_mut(&mut self, kind: &str) -> Result<&mut BTreeSet<String>, String> {
        match kind {
            "tools" | "tool" => Ok(&mut self.tools),
            "bins" | "bin" => Ok(&mut self.bins),
            "commands" | "command" => Ok(&mut self.commands),
            "paths" | "path" => Ok(&mut self.paths),
            other => Err(format!("未知授权类型: {other}（tools|bins|commands|paths）")),
        }
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.contains(name)
    }

    /// 这条命令的可执行文件是否被一次性允许过
    pub fn allows_bin(&self, bin: &str) -> bool {
        self.bins.contains(bin)
    }

    /// 整条命令是否被允许过：完全相等，或 `前缀 *`（`git push *` 匹配 `git push origin main`）
    pub fn allows_command(&self, cmd: &str) -> bool {
        let c = cmd.trim();
        self.commands.iter().any(|pat| {
            if let Some(prefix) = pat.strip_suffix('*') {
                // `git push *` ⇒ 只匹配 `git push` 本身或 `git push …`，
                // 不能命中 `git pushy`（按空格收敛成词边界，不按裸前缀）
                let p = prefix.trim_end();
                c == p || c.starts_with(&format!("{p} "))
            } else {
                pat == c
            }
        })
    }

    /// 路径是否被允许过（**目录前缀**判定，按路径分隔符收敛，避免 `/a/bc` 命中 `/a/b`）
    pub fn allows_path(&self, path: &str) -> bool {
        let p = normalize_path(path);
        self.paths.iter().any(|allowed| {
            let a = normalize_path(allowed);
            p == a || p.starts_with(&format!("{a}/"))
        })
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty() && self.bins.is_empty() && self.commands.is_empty() && self.paths.is_empty()
    }
}

/// 写盘前的规范化：命令/路径去尾空格、`\` 统一成 `/`（Windows 上同一份语义）
fn normalize(kind: &str, v: &str) -> String {
    match kind {
        "paths" | "path" => normalize_path(v),
        _ => v.trim().to_string(),
    }
}

fn normalize_path(p: &str) -> String {
    let mut s = p.trim().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// 进程内单例（读一次盘，之后读内存；写操作同步落盘）
static SHARED: OnceLock<Mutex<GrantStore>> = OnceLock::new();

fn shared() -> &'static Mutex<GrantStore> {
    SHARED.get_or_init(|| Mutex::new(GrantStore::load()))
}

/// 当前快照（harness / 门控每轮读它 —— 改了立刻生效，不用重启）
pub fn snapshot() -> GrantStore {
    shared().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 记一条并落盘（失败返回原因，**不静默**）
pub fn grant(kind: &str, value: &str) -> Result<GrantStore, String> {
    let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
    g.grant(kind, value)?;
    g.save().map_err(|e| format!("授权落盘失败: {e}"))?;
    Ok(g.clone())
}

/// 收回一条并落盘（返回是否真的删掉了）
pub fn revoke(kind: &str, value: &str) -> Result<(bool, GrantStore), String> {
    let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
    let removed = g.revoke(kind, value)?;
    g.save().map_err(|e| format!("授权落盘失败: {e}"))?;
    Ok((removed, g.clone()))
}

/// 测试/运维用：重载磁盘内容覆盖内存
pub fn reload() -> GrantStore {
    let fresh = GrantStore::load();
    let mut g = shared().lock().unwrap_or_else(|e| e.into_inner());
    *g = fresh.clone();
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_tmp_home<T>(f: impl FnOnce() -> T) -> T {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        let _g = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!(
            "bolloon-grants-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::env::var("BOLLOON_HOME").ok();
        // 测试里改进程级 env（edition 2024 要求 unsafe；外层有锁，单线程跑）
        unsafe { std::env::set_var("BOLLOON_HOME", &dir) };
        let out = f();
        unsafe {
            match old {
                Some(v) => std::env::set_var("BOLLOON_HOME", v),
                None => std::env::remove_var("BOLLOON_HOME"),
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn grant_and_revoke_roundtrip_persists() {
        with_tmp_home(|| {
            let mut g = GrantStore::default();
            g.grant("tools", "shell").unwrap();
            g.grant("bins", "python3").unwrap();
            g.grant("commands", "git push *").unwrap();
            g.grant("paths", "/tmp/workspace/").unwrap();
            assert!(g.save().is_ok());

            let back = GrantStore::load();
            assert!(back.has_tool("shell"));
            assert!(back.allows_bin("python3"));
            assert!(back.allows_command("git push origin main"), "前缀通配必须命中");
            assert!(!back.allows_command("git pushy"), "前缀不能误伤");
            assert!(back.allows_path("/tmp/workspace/sub/dir"));
            assert!(!back.allows_path("/tmp/workspace2"), "目录前缀不能跨名字命中");

            assert!(g.revoke("bins", "python3").unwrap());
            assert!(!g.allows_bin("python3"));
        });
    }

    #[test]
    fn empty_and_unknown_kind_are_rejected() {
        let mut g = GrantStore::default();
        assert!(g.grant("tools", "   ").is_err());
        assert!(g.grant("nope", "x").is_err());
        assert!(g.is_empty());
    }

    #[test]
    fn windows_style_paths_are_normalized() {
        let mut g = GrantStore::default();
        g.grant("paths", "C:\\Users\\leo\\proj").unwrap();
        assert!(g.allows_path("C:/Users/leo/proj/src"));
        assert!(!g.allows_path("C:/Users/leo/proj2"));
    }
}
