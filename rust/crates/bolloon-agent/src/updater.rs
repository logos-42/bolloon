//! 自动更新 — 检查 / 提示 / 内部安装一条龙 (无弹窗)
//!
//! 纪律:
//! - **未检测到更新之前不显示**: check 失败/无网络/同版本 → `update_available=false`,
//!   UI 与 CLI tip 栏都不出现更新入口
//! - **安装 = 内部一条龙**: 下载新二进制 → 原子替换自身 (tmp+rename, 运行中可换) →
//!   重启 (spawn 新进程 + 旧进程退出) — 全程无弹窗, 状态走按钮文字/CLI 输出
//! - 来源注入 (`UpdateSource`): 真实现接 GitHub Release / 内部源; 测试用 fake
//! - 替换失败自动回滚 (备份旧二进制), 不把自己装残

use serde::{Deserialize, Serialize};
use std::path::Path;

/// 当前版本 —— 直接取 crate 版本 (workspace 统一), 不再手写数字。
///
/// 以前这里硬编码 "0.6.13", 升到 0.7.x 之后智能体仍自称 0.6.13 (leo 看到的就是这个)。
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 更新错误
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum UpdateError {
    #[error("无可用更新 (当前 {0})")]
    NoneAvailable(String),
    #[error("下载失败: {0}")]
    Download(String),
    #[error("下载内容校验失败 (空或过小)")]
    BadPayload,
    #[error("替换失败: {0}")]
    Replace(String),
    #[error("版本解析失败: {0}")]
    BadVersion(String),
}

/// 更新信息
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub update_available: bool,
    /// 检查状态: ok | unknown (无网络/源不可达)
    pub status: String,
    pub notes: Option<String>,
}

/// semver 三段比较 (0.6.10 vs 0.6.11); 解析不出 → None
pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().trim_start_matches('v').split('-').next()?;
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    Some((major, minor, patch))
}

/// 是否有更新 (latest > current)
pub fn update_available(current: &str, latest: &str) -> Result<bool, UpdateError> {
    let c = parse_version(current).ok_or_else(|| UpdateError::BadVersion(current.into()))?;
    let l = parse_version(latest).ok_or_else(|| UpdateError::BadVersion(latest.into()))?;
    Ok(l > c)
}

/// 版本源端口 (真实现接 GitHub Release; 测试用 fake)
pub trait UpdateSource {
    /// 返回远端最新版本号 (拿不到 = Err, 如实)
    fn latest_version(&self) -> Result<String, String>;
    /// 下载新二进制字节 (调用方负责写盘替换)
    fn download(&self) -> Result<Vec<u8>, String>;
    /// 版本说明 (可选)
    fn notes(&self) -> Option<String> {
        None
    }
}

/// 检查更新 (check 失败 → status=unknown, update_available=false — **不显示提示的前置**)
pub fn check(source: &dyn UpdateSource) -> UpdateInfo {
    check_with(source, CURRENT_VERSION)
}

/// 检查更新 (运行时版本可注入 — 服务端/CLI 的版本可能与编译期常量不同, 比错版本会误报)
pub fn check_with(source: &dyn UpdateSource, current: &str) -> UpdateInfo {
    match source.latest_version() {
        Ok(latest) => {
            let avail = update_available(current, &latest).unwrap_or(false);
            UpdateInfo {
                current: current.into(),
                latest,
                update_available: avail,
                status: "ok".into(),
                notes: source.notes(),
            }
        }
        Err(e) => UpdateInfo {
            current: current.into(),
            latest: String::new(),
            update_available: false,
            status: format!("unknown ({e})"),
            notes: None,
        },
    }
}

/// 安排结果
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct InstallReport {
    pub downloaded_bytes: usize,
    pub replaced: bool,
    pub backup_path: Option<String>,
    pub restart_requested: bool,
}

/// 内部安装一条龙: 下载 → 校验 → 备份 → 原子替换 → 请求重启
///
/// - `self_path`: 当前可执行文件路径 (`std::env::current_exe`)
/// - 原子替换: 写 `<self>.new` → 旧文件备份 `<self>.bak` → rename 盖过去
///   (Unix 上对运行中的二进制 rename 替换是安全的)
/// - 失败自动回滚备份
pub fn install(source: &dyn UpdateSource, self_path: &Path) -> Result<InstallReport, UpdateError> {
    let bytes = source.download().map_err(UpdateError::Download)?;
    if bytes.len() < 1024 {
        return Err(UpdateError::BadPayload);
    }
    let new_path = self_path.with_extension("new");
    let bak_path = self_path.with_extension("bak");
    std::fs::write(&new_path, &bytes).map_err(|e| UpdateError::Replace(e.to_string()))?;

    // 备份旧二进制
    let mut backup = None;
    if self_path.exists() {
        std::fs::copy(self_path, &bak_path).map_err(|e| UpdateError::Replace(e.to_string()))?;
        backup = Some(bak_path.display().to_string());
    }

    // 原子替换
    if let Err(e) = std::fs::rename(&new_path, self_path) {
        // 回滚
        if bak_path.exists() {
            let _ = std::fs::copy(&bak_path, self_path);
        }
        let _ = std::fs::remove_file(&new_path);
        return Err(UpdateError::Replace(e.to_string()));
    }
    // 可执行位 (unix)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(self_path, std::fs::Permissions::from_mode(0o755));
    }
    let _ = std::fs::remove_file(&bak_path);

    Ok(InstallReport {
        downloaded_bytes: bytes.len(),
        replaced: true,
        backup_path: backup,
        restart_requested: true,
    })
}

/// 重启: spawn 新二进制 (同参数) + 旧进程退出
///
/// 返回新进程 pid (spawn 失败如实报 — 调用方保留旧进程继续服务)
pub fn restart(self_path: &Path, args: &[String]) -> Result<u32, String> {
    #[cfg(target_os = "macos")]
    {
        // macOS: 若自身位于 .app bundle 内, 用 `open -a` 拉起 GUI
        // (直接 spawn 裸二进制不会激活窗口, 表现为"更新后不重启")
        let p = self_path.to_string_lossy();
        if let Some(idx) = p.find(".app/Contents/MacOS") {
            let bundle = &p[..idx + 4]; // 含 ".app"
            return std::process::Command::new("open")
                .args(["-a", bundle])
                .spawn()
                .map(|c| c.id())
                .map_err(|e| e.to_string());
        }
    }
    std::process::Command::new(self_path)
        .args(args)
        .spawn()
        .map(|c| c.id())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct FakeSource {
        version: Result<String, String>,
        payload: Vec<u8>,
    }
    impl UpdateSource for FakeSource {
        fn latest_version(&self) -> Result<String, String> {
            self.version.clone()
        }
        fn download(&self) -> Result<Vec<u8>, String> {
            Ok(self.payload.clone())
        }
        fn notes(&self) -> Option<String> {
            Some("修复群聊邀请".into())
        }
    }

    #[test]
    fn semver_compare() {
        assert!(update_available("0.6.10", "0.6.11").unwrap());
        assert!(update_available("0.6.10", "0.7.0").unwrap());
        assert!(update_available("0.6.10", "1.0.0").unwrap());
        assert!(!update_available("0.6.10", "0.6.10").unwrap(), "同版本无更新");
        assert!(!update_available("0.6.10", "0.6.9").unwrap());
        assert!(matches!(
            update_available("0.6.10", "banana"),
            Err(UpdateError::BadVersion(_))
        ));
        // v 前缀容忍 (GitHub release tag 常见 v0.6.11)
        assert!(update_available("0.6.10", "v0.6.11").unwrap());
    }

    #[test]
    fn check_no_update_means_hidden() {
        // 同版本 → update_available=false ⇒ **UI/CLI 不显示提示的前置**
        let src = FakeSource { version: Ok(CURRENT_VERSION.into()), payload: vec![] };
        let info = check(&src);
        assert!(!info.update_available);
        assert_eq!(info.status, "ok");
        assert_eq!(info.current, CURRENT_VERSION);
    }

    /// CURRENT_VERSION 的 patch + 1 (测试里"比当前新一版")
    fn next_patch() -> String {
        let mut p: Vec<u32> = CURRENT_VERSION.split('.').filter_map(|x| x.parse().ok()).collect();
        while p.len() < 3 {
            p.push(0);
        }
        p[2] += 1;
        format!("{}.{}.{}", p[0], p[1], p[2])
    }

    #[test]
    fn check_source_unreachable_is_unknown_not_available() {
        // 无网络/源不可达 → unknown, **绝不误报有更新**
        let src = FakeSource { version: Err("network down".into()), payload: vec![] };
        let info = check(&src);
        assert!(!info.update_available);
        assert!(info.status.starts_with("unknown"), "{}", info.status);
        assert!(info.latest.is_empty());
    }

    #[test]
    fn check_with_runtime_version() {
        // 运行时版本 (服务端 st.version / CLI 实际跑的版本) 参与比较, 不看成编译期常量
        let src = FakeSource { version: Ok("0.6.11".into()), payload: vec![] };
        let info = check_with(&src, "0.6.10");
        assert!(info.update_available);
        assert_eq!(info.current, "0.6.10");
        // 运行时已是新版 → 不误报
        let info = check_with(&src, "0.6.11");
        assert!(!info.update_available);
        assert_eq!(info.current, "0.6.11");
        // 源不可达时, 注入的版本仍如实回显
        let src = FakeSource { version: Err("network down".into()), payload: vec![] };
        let info = check_with(&src, "0.6.12");
        assert_eq!(info.current, "0.6.12");
        assert!(!info.update_available);
    }

    #[test]
    fn check_update_available_with_notes() {
        // 不写死版本号: 拿 CURRENT_VERSION 的 patch+1 当"新版本" (写死会在每次发版时假红)
        let newer = next_patch();
        let src = FakeSource { version: Ok(newer.clone()), payload: vec![] };
        let info = check(&src);
        assert!(info.update_available);
        assert_eq!(info.latest, newer);
        assert_eq!(info.notes.as_deref(), Some("修复群聊邀请"));
    }

    #[test]
    fn install_one_stop_atomic() {
        let dir = std::env::temp_dir().join(format!("bolloon-upd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("bolloon");
        std::fs::write(&exe, b"OLD-BINARY-V1").unwrap();
        let src = FakeSource { version: Ok("0.6.11".into()), payload: vec![b'N'; 4096] };

        let report = install(&src, &exe).unwrap();
        assert!(report.replaced && report.restart_requested);
        assert_eq!(report.downloaded_bytes, 4096);
        // 新二进制就位
        assert_eq!(std::fs::read(&exe).unwrap(), vec![b'N'; 4096].as_slice());
        // 原子替换后 tmp/bak 清理干净
        assert!(!exe.with_extension("new").exists());
        assert!(!exe.with_extension("bak").exists());
        // 可执行位
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&exe).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "替换后保持可执行");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_failure_rolls_back() {
        let dir = std::env::temp_dir().join(format!("bolloon-upd-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("bolloon");
        std::fs::write(&exe, b"OLD-GOOD").unwrap();
        // 太小的 payload → 校验失败, 旧二进制完好
        let bad = FakeSource { version: Ok("0.6.11".into()), payload: b"tiny".to_vec() };
        assert!(matches!(install(&bad, &exe), Err(UpdateError::BadPayload)));
        assert_eq!(std::fs::read(&exe).unwrap(), b"OLD-GOOD", "失败自动回滚, 不把自己装残");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restart_spawns_new_process() {
        let dir = std::env::temp_dir().join(format!("bolloon-upd-re-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 用 /bin/echo 当"新二进制" (跨平台最小)
        let echo = if cfg!(target_os = "windows") { PathBuf::from("cmd") } else { PathBuf::from("/bin/echo") };
        let pid = restart(&echo, &["hi".to_string()]).unwrap();
        assert!(pid > 0, "新进程 pid > 0");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
