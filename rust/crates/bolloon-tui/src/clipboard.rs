//! clipboard.rs — Alt+V 贴图: 从系统剪贴板取**图片**, 落成 PNG
//!
//! 纪律:
//!   · **只要图片** —— 剪贴板里是文字就如实报"没有图片", 不猜、不拿文字凑数;
//!   · **落在自己的目录** `~/.bolloon/rust/paste/paste-<ms>.png` (不塞系统临时目录,
//!     会话结束/重启后还找得到; 与 `history/` 同一口径, 都在 `BolloonHome::root()` 下);
//!   · **平台差异只在这一处** —— macOS `pngpaste` / AppleScript, Linux `wl-paste` / `xclip`,
//!     Windows PowerShell; 都失败就报出"试过哪些", 不冒充成功;
//!   · `BOLLOON_PASTE_CMD` 可整条接管 (该命令把 PNG 字节写到 stdout) —— 测试与自定义复用同一条路径。
//!
//! 边界 (如实): 本模块只负责"图片到手 + 落盘 + 给出路径", **不做视觉编码**。
//!   `bolloon_llm::ChatMessage.content` 是单模态 `String`, 图片要真进模型得先改 LLM 层,
//!   记在 `docs/wiki/rust-rewrite.md` 欠账里; 这里把 `@<路径>` 插进输入, 让 agent 自己决定怎么用。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// 贴图落盘目录: `~/.bolloon/rust/paste` (与 history 同级, 走同一个 BolloonHome)
pub fn paste_dir() -> PathBuf {
    bolloon_agent::home::BolloonHome::resolve().root().join("paste")
}

/// 一次贴图: 剪贴板 → 新 PNG 文件。失败给**人话**原因 (没有任何图片 / 命令都不可用)
pub fn paste_image() -> Result<PathBuf, String> {
    let dir = paste_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录 {} 失败: {e}", dir.display()))?;
    let dest = dir.join(format!("paste-{}.png", now_ms()));
    let bytes = write_png(&dest)?;
    if bytes == 0 {
        let _ = std::fs::remove_file(&dest);
        return Err("剪贴板里没有图片".to_string());
    }
    Ok(dest)
}

/**
 * 把剪贴板里的图片写成 PNG; 返回写入字节数 (**0 = 剪贴板里没有图片**)。
 *
 * 顺序: `BOLLOON_PASTE_CMD` → 平台读 stdout 的命令 → 平台"直接写文件"的命令。
 * 每一档失败都记下"试过什么", 最后一条错误一次性说清。
 */
pub fn write_png(dest: &Path) -> Result<u64, String> {
    let mut tried: Vec<String> = Vec::new();

    if let Ok(cmd) = std::env::var("BOLLOON_PASTE_CMD") {
        let cmd = cmd.trim().to_string();
        if !cmd.is_empty() {
            match run_shell_to_png(&cmd, dest) {
                Ok(n) => return Ok(n),
                Err(e) => tried.push(format!("BOLLOON_PASTE_CMD ({cmd}): {e}")),
            }
        }
    }

    for argv in stdout_cmds() {
        match run_stdout_to_file(&argv, dest) {
            Ok(n) if n > 0 => return Ok(n),
            Ok(_) => tried.push(format!("{} (无输出)", argv.join(" "))),
            Err(e) => tried.push(format!("{} ({e})", argv.join(" "))),
        }
    }

    if cfg!(target_os = "macos") {
        match osascript_to_file(dest) {
            Ok(n) if n > 0 => return Ok(n),
            Ok(_) => tried.push("osascript (剪贴板无 PNGf)".to_string()),
            Err(e) => tried.push(format!("osascript ({e})")),
        }
    }

    if cfg!(target_os = "windows") {
        match powershell_to_file(dest) {
            Ok(n) if n > 0 => return Ok(n),
            Ok(_) => tried.push("powershell GetImage (剪贴板无图片)".to_string()),
            Err(e) => tried.push(format!("powershell ({e})")),
        }
    }

    // 全失败: **不留下 0 字节假图** (下次 Alt+V 会误以为贴到了)
    let _ = std::fs::remove_file(dest);
    if tried.is_empty() {
        return Err("这个平台上没有可用的贴图命令".to_string());
    }
    Err(format!("剪贴板里没有图片 (试过: {})", tried.join(" · ")))
}

/// 跑一条自定义命令 (stdout 必须是 PNG 字节); 空输出算失败, 并把空文件删掉
fn run_shell_to_png(cmd: &str, dest: &Path) -> Result<u64, String> {
    let n = run_stdout_to_file(&["sh", "-c", cmd], dest)?;
    if n == 0 {
        let _ = std::fs::remove_file(dest);
        return Err("命令没有输出".to_string());
    }
    Ok(n)
}

/// 各平台"把 PNG 写到 stdout"的命令 (按优先级)
fn stdout_cmds() -> Vec<Vec<&'static str>> {
    if cfg!(target_os = "macos") {
        // pngpaste 是最省事的 (brew install pngpaste); 没装就走下面的 osascript
        vec![vec!["pngpaste", "-"]]
    } else if cfg!(target_os = "windows") {
        // Windows 只能"直接写文件", 见 powershell_to_file
        vec![]
    } else {
        vec![
            vec!["wl-paste", "--no-newline", "--type", "image/png"],
            vec!["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
        ]
    }
}

fn run_stdout_to_file(argv: &[&str], dest: &Path) -> Result<u64, String> {
    let out = Command::new(argv[0])
        .args(&argv[1..])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("起不动: {e}"))?;
    if !out.status.success() {
        return Err(format!("退出码 {:?}", out.status.code()));
    }
    std::fs::write(dest, &out.stdout).map_err(|e| format!("写文件失败: {e}"))?;
    Ok(out.stdout.len() as u64)
}

/// macOS: AppleScript 把剪贴板的 `PNGf` 直接写进文件 (没装 pngpaste 时的兜底)
fn osascript_to_file(dest: &Path) -> Result<u64, String> {
    let p = dest
        .display()
        .to_string()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "try
  set pngData to the clipboard as «class PNGf»
on error
  return
end try
set outFile to POSIX file \"{p}\"
set fh to open for access outFile with write permission
set eof fh to 0
write pngData to fh
close access fh"
    );
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("起不动: {e}"))?;
    if !out.status.success() {
        return Err(format!("退出码 {:?}", out.status.code()));
    }
    Ok(file_size(dest))
}

/// Windows: PowerShell 读剪贴板图片并保存 (必须 `-STA`)
fn powershell_to_file(dest: &Path) -> Result<u64, String> {
    let p = dest.display().to_string().replace('\'', "''");
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms; \
         Add-Type -AssemblyName System.Drawing; \
         $img = [System.Windows.Forms.Clipboard]::GetImage(); \
         if ($null -eq $img) {{ exit 1 }}; \
         $img.Save('{p}', [System.Drawing.Imaging.ImageFormat]::Png)"
    );
    let out = Command::new("powershell")
        .args(["-NoProfile", "-STA", "-Command", &script])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|e| format!("起不动: {e}"))?;
    if !out.status.success() {
        return Err(format!("退出码 {:?}", out.status.code()));
    }
    Ok(file_size(dest))
}

/**
 * 把**文本**送进系统剪贴板 (`/copy` 用)。返回 Err 时调用方如实报错。
 *
 * 与贴图同一条纪律: 平台差异只在这一处, `BOLLOON_COPY_CMD` 可整条接管 (写进 stdin)。
 */
pub fn copy_text(text: &str) -> Result<(), String> {
    let mut tried: Vec<String> = Vec::new();

    // 自定义命令优先 (sh -c, 文本走 stdin)
    if let Ok(cmd) = std::env::var("BOLLOON_COPY_CMD") {
        let cmd = cmd.trim().to_string();
        if !cmd.is_empty() {
            match pipe_stdin("sh", &["-c", &cmd], text) {
                Ok(()) => return Ok(()),
                Err(e) => tried.push(format!("BOLLOON_COPY_CMD ({e})")),
            }
        }
    }

    let cmds: Vec<(&str, Vec<&str>)> = if cfg!(target_os = "macos") {
        vec![("pbcopy", vec![])]
    } else if cfg!(target_os = "windows") {
        vec![("clip", vec![])]
    } else {
        vec![
            ("wl-copy", vec![]),
            ("xclip", vec!["-selection", "clipboard"]),
        ]
    };

    for (bin, args) in cmds {
        match pipe_stdin(bin, &args, text) {
            Ok(()) => return Ok(()),
            Err(e) => tried.push(format!("{bin} ({e})")),
        }
    }
    Err(format!("没有可用的剪贴板命令 (试过: {})", tried.join(" · ")))
}

fn pipe_stdin(bin: &str, args: &[&str], text: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut child = Command::new(bin)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("起不动: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        si.write_all(text.as_bytes()).map_err(|e| format!("写 stdin 失败: {e}"))?;
    }
    let st = child.wait().map_err(|e| format!("等待失败: {e}"))?;
    if !st.success() {
        return Err(format!("退出码 {:?}", st.code()));
    }
    Ok(())
}

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp_dest(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("bolloon-paste-test-{}-{tag}.png", std::process::id()))
    }

    /// 真跑一次"命令 → 文件"这条链: 命令把 PNG 字节写到 stdout
    /// (与线上同一条路径, 只是把"系统剪贴板"换成了 printf)
    #[test]
    fn shell_to_png_writes_real_bytes() {
        let dest = tmp_dest("override");
        let _ = std::fs::remove_file(&dest);

        let n = run_shell_to_png("printf '\\x89PNG\\r\\n\\x1a'", &dest).unwrap();

        assert_eq!(n, 7, "写的必须是命令的真实输出 (PNG 签名 7 字节)");
        let got = std::fs::read(&dest).unwrap();
        assert_eq!(got, vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a]);
        let _ = std::fs::remove_file(&dest);
    }

    /// 命令没有输出 ⇒ 如实返回 Err, **不许**留下一个 0 字节的假图
    #[test]
    fn empty_cmd_output_is_an_error_and_cleans_up() {
        let dest = tmp_dest("empty");
        std::fs::write(&dest, b"stale").unwrap();

        let r = run_shell_to_png("true", &dest);

        assert!(r.is_err(), "没有图片不能算成功: {r:?}");
        assert!(!dest.exists(), "失败的贴图不许留文件 (否则下轮会误用)");
    }

    /// 命令失败 (非 0 退出) 也是 Err —— 不把错误信息当图片写进文件
    #[test]
    fn failing_cmd_is_an_error() {
        let dest = tmp_dest("fail");
        let _ = std::fs::remove_file(&dest);
        let r = run_shell_to_png("exit 3", &dest);
        assert!(r.is_err());
        assert!(!dest.exists());
    }

    /// 贴图目录与 history 同级, 都在 BolloonHome 的 root 下 (落盘位置是约定)
    #[test]
    fn paste_dir_lives_under_bolloon_home() {
        let _g = crate::width::test_lock().lock().unwrap();
        let root = bolloon_agent::home::BolloonHome::resolve().root().to_path_buf();
        assert_eq!(paste_dir(), root.join("paste"));
    }

    /// stdout 命令表按平台给: unix 至少一条 (**别在 mac 上偷偷跑 xclip**)
    #[test]
    fn stdout_cmds_match_platform() {
        let v = stdout_cmds();
        if cfg!(target_os = "macos") {
            assert_eq!(v, vec![vec!["pngpaste", "-"]]);
        } else if cfg!(target_os = "windows") {
            assert!(v.is_empty());
        } else {
            assert!(v.iter().any(|c| c[0] == "wl-paste"));
            assert!(v.iter().any(|c| c[0] == "xclip"));
        }
    }

    /// `/copy` 的落点: 文本真的进了剪贴板命令的 stdin
    #[test]
    fn copy_text_pipes_to_command() {
        let _g = crate::width::test_lock().lock().unwrap();
        let dest = std::env::temp_dir().join(format!("bolloon-copy-test-{}.txt", std::process::id()));
        let _ = std::fs::remove_file(&dest);

        unsafe {
            std::env::set_var("BOLLOON_COPY_CMD", format!("cat > {}", dest.display()));
        }
        let r = copy_text("复制我 ✓");
        unsafe { std::env::remove_var("BOLLOON_COPY_CMD") };

        assert!(r.is_ok(), "{r:?}");
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "复制我 ✓");
        let _ = std::fs::remove_file(&dest);
    }

    /// 写一个真文件再读大小 (幂等, 不影响其它用例)
    #[test]
    fn file_size_reads_real_bytes() {
        let p = tmp_dest("size");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(b"12345").unwrap();
        drop(f);
        assert_eq!(file_size(&p), 5);
        let _ = std::fs::remove_file(&p);
    }
}
