//! 一条龙更新 (服务端): **下载 → 解包 → 原子替换 → 原地重启**。
//!
//! 为什么需要它: 网页端 / 裸进程没有 Tauri updater 插件兜底, 点「更新」如果只是
//! 打开发布页, 用户还得自己下载、拖进 Applications、再手动重开 —— 那不叫更新,
//! 那叫"给你个链接"。这里把整条链在本地服务端干完 (leo 2026-10-30 明确要求)。
//!
//! 安全边界 (诚实地写在这里, 不假装):
//! * 只替换**自己所在的 .app 包**; 裸二进制 (target/debug/…) 不动 —— 那不是发行产物。
//! * 走 HTTPS + 自有域名的发布清单; 清单里若带 Tauri 签名, 交给 Tauri 那条通道验,
//!   本模块**不做** minisign 验签 (没有引入签名依赖), 所以只用清单里我们自己发布过的地址。
//! * 替换是原子的: 旧包先改名 `.old` 备份, 新包就位失败立刻回滚; 成功后才删备份。
//! * 重启用 `exec` 原地换进程 (保留 PID 与已监听端口), 不做"退出再拉起"的两段式。
//!
//! 单元测试覆盖 `bundle_of` / `extract_app` / `swap_dir` 的回滚语义 (不用网络)。

use std::path::{Path, PathBuf};

/// 清单里的平台键 (与 Tauri `latest.json` 的 `platforms` 键一致)
pub fn platform_key() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    // Tauri 用 `x86_64` / `aarch64`, 与 std 的 ARCH 常量一致
    format!("{os}-{}", std::env::consts::ARCH)
}

/// 从可执行文件反推 `.app` 包目录: `…/X.app/Contents/MacOS/bin` → `…/X.app`
///
/// 非 macOS 包结构 (裸二进制) 返回 None —— 调用方据此如实回退, 不瞎替换。
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?; // …/Contents/MacOS
    if macos.file_name()? != "MacOS" {
        return None;
    }
    let contents = macos.parent()?; // …/Contents
    if contents.file_name()? != "Contents" {
        return None;
    }
    contents.parent().map(|p| p.to_path_buf())
}

/// 下载 `url` 到 `dest`; 返回字节数
pub fn download(url: &str, dest: &Path) -> Result<u64, String> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(300))
        .set("User-Agent", "bolloon-updater")
        .call()
        .map_err(|e| format!("下载失败: {e}"))?;
    let mut reader = resp.into_reader();
    let mut f = std::fs::File::create(dest).map_err(|e| format!("写入 {}: {e}", dest.display()))?;
    std::io::copy(&mut reader, &mut f).map_err(|e| format!("下载中断: {e}"))
}

/// 解开 tar.gz, 返回解出来的 `.app` 目录
///
/// 用系统 `tar` (macOS bsdtar / Linux GNU tar): 零依赖, 与 Tauri 打包产物同语义。
pub fn extract_app(tarball: &Path, workdir: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(workdir).map_err(|e| format!("建临时目录: {e}"))?;
    let status = std::process::Command::new("tar")
        .arg("-xzf")
        .arg(tarball)
        .arg("-C")
        .arg(workdir)
        .status()
        .map_err(|e| format!("解包失败 (没有 tar?): {e}"))?;
    if !status.success() {
        return Err(format!("解包失败: tar 退出码 {:?}", status.code()));
    }
    // 顶层找 .app (发布包固定是 Bolloon.app)
    let mut found: Option<PathBuf> = None;
    for ent in std::fs::read_dir(workdir).map_err(|e| e.to_string())? {
        let p = ent.map_err(|e| e.to_string())?.path();
        if p.extension().map(|e| e == "app").unwrap_or(false) {
            found = Some(p);
            break;
        }
    }
    found.ok_or_else(|| "发布包里没有 .app 目录".to_string())
}

/// 原子替换目录: 旧目录改名 `.old` 备份 → 新目录就位; 失败立刻回滚。
///
/// 返回备份路径 (调用方决定何时删 —— 重启成功前先留着, 出问题还能人工救回)。
pub fn swap_dir(new_dir: &Path, target: &Path) -> Result<PathBuf, String> {
    let backup = backup_path(target);
    if backup.exists() {
        std::fs::remove_dir_all(&backup).map_err(|e| format!("清理旧备份: {e}"))?;
    }
    std::fs::rename(target, &backup).map_err(|e| format!("备份现有包失败: {e}"))?;
    match std::fs::rename(new_dir, target) {
        Ok(()) => Ok(backup),
        Err(e) => {
            // 回滚: 把备份挪回原位, 保证"最坏等于没更新", 不是"更新到一半没了"
            let _ = std::fs::rename(&backup, target);
            Err(format!("新包就位失败 (已回滚): {e}"))
        }
    }
}

fn backup_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Bolloon".to_string());
    target.with_file_name(format!("{name}.old"))
}

/// 整条安装链: 下载 → 解包 → 替换。返回到位后的包路径。
pub fn install_from_url(url: &str, bundle: &Path) -> Result<PathBuf, String> {
    let workdir = std::env::temp_dir().join(format!("bolloon-update-{}", std::process::id()));
    let tarball = workdir.join("Bolloon.app.tar.gz");
    std::fs::create_dir_all(&workdir).map_err(|e| format!("建临时目录: {e}"))?;
    let bytes = download(url, &tarball)?;
    if bytes < 1024 * 256 {
        // 发布包不可能这么小 —— 多半是 404 页面
        return Err(format!("下载内容异常 (仅 {bytes} 字节, 疑似 404 页面)"));
    }
    let new_app = extract_app(&tarball, &workdir.join("x"))?;
    let backup = swap_dir(&new_app, bundle)?;
    tracing::info!(backup = %backup.display(), bytes, "新版本已就位");
    Ok(bundle.to_path_buf())
}

/// 原地重启: `exec` 换进程 (保留 PID 与已监听端口)。
///
/// 只在 unix 上可用; Windows 需要另行设计 (现成路径交回前端提示手动重启)。
#[cfg(unix)]
pub fn exec_restart(exe: &Path) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe).exec();
    Err(format!("重启失败: {err}"))
}

#[cfg(not(unix))]
pub fn exec_restart(_exe: &Path) -> Result<(), String> {
    Err("当前平台不支持原地重启, 请手动重开应用".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_of_reads_app_layout_only() {
        let inside = PathBuf::from("/Applications/Bolloon.app/Contents/MacOS/Bolloon");
        assert_eq!(
            bundle_of(&inside).map(|p| p.to_string_lossy().to_string()),
            Some("/Applications/Bolloon.app".to_string())
        );
        // 裸二进制 / 非包结构: 一律 None (不做任何替换)
        assert!(bundle_of(&PathBuf::from("/tmp/build/bolloon")).is_none());
        assert!(bundle_of(&PathBuf::from("/Applications/Bolloon.app/Resources/x")).is_none());
    }

    #[test]
    fn platform_key_is_tauri_shaped() {
        let k = platform_key();
        assert!(k.starts_with("darwin-") || k.starts_with("linux-") || k.starts_with("windows-"));
        assert!(k.ends_with("-x86_64") || k.ends_with("-aarch64"));
    }

    fn make_fake_app(root: &Path, marker: &str) -> PathBuf {
        let app = root.join("Bolloon.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(macos.join("Bolloon"), marker).unwrap();
        app
    }

    #[test]
    fn extract_and_swap_round_trip() {
        let root = std::env::temp_dir().join(format!("bolloon-upd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // 现役包: 内容 "old"
        let installed = make_fake_app(&root.join("installed"), "old");
        // 新包 (已经解出来的形状): 内容 "new"
        let staging = make_fake_app(&root.join("staging"), "new");

        let backup = swap_dir(&staging, &installed).unwrap();
        let got = std::fs::read_to_string(installed.join("Contents/MacOS/Bolloon")).unwrap();
        assert_eq!(got, "new", "新包必须就位");
        assert_eq!(
            std::fs::read_to_string(backup.join("Contents/MacOS/Bolloon")).unwrap(),
            "old",
            "旧包必须留成 .old 备份"
        );
        // 第二次替换应清掉旧备份, 不叠 .old.old
        let staging2 = make_fake_app(&root.join("staging2"), "newer");
        swap_dir(&staging2, &installed).unwrap();
        let got2 = std::fs::read_to_string(installed.join("Contents/MacOS/Bolloon")).unwrap();
        assert_eq!(got2, "newer");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn swap_dir_rolls_back_when_new_dir_missing() {
        let root = std::env::temp_dir().join(format!("bolloon-upd-rb-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let installed = make_fake_app(&root.join("installed"), "old");
        let missing = root.join("nope");
        let err = swap_dir(&missing, &installed).unwrap_err();
        assert!(err.contains("回滚"), "错误要说明回滚: {err}");
        // 回滚后现役包必须还在且内容未变
        assert_eq!(
            std::fs::read_to_string(installed.join("Contents/MacOS/Bolloon")).unwrap(),
            "old"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_app_reads_tar_gz() {
        let root = std::env::temp_dir().join(format!("bolloon-upd-tar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let src = make_fake_app(&root.join("src"), "payload");
        let tarball = root.join("Bolloon.app.tar.gz");
        let st = std::process::Command::new("tar")
            .arg("-czf")
            .arg(&tarball)
            .arg("-C")
            .arg(root.join("src"))
            .arg("Bolloon.app")
            .status()
            .unwrap();
        assert!(st.success(), "夹具打包失败");
        let app = extract_app(&tarball, &root.join("out")).unwrap();
        assert_eq!(
            std::fs::read_to_string(app.join("Contents/MacOS/Bolloon")).unwrap(),
            "payload"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = src;
    }
}
