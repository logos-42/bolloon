use std::process::Command;

fn main() {
    ensure_codesign_identity();
    tauri_build::build()
}

/// 2026-11-04 (leo: 「弹窗的本地签名不只是真的我的电脑，其他电脑也会遇到，要以前解决」)
///
/// 任何一台机器打包前先把**稳定的自签身份**准备好：
/// - 没有身份 ⇒ `tauri.conf.json` 的 `bundle.macOS.signingIdentity` 会让 tauri build 直接失败
///   (以前只在本机手工建过，换台机器就断)；
/// - 退化成 ad-hoc (`codesign -s -`) 也不行 —— 它的 designated requirement 是 cdhash，
///   每次重建都变，macOS 的 TCC 就会每次重新问「是否允许访问下载文件夹」。
///
/// 身份由 `scripts/macos-codesign-local.sh identity` 创建 (幂等)：自签证书 + 导入登录钥匙串
/// + 本机信任，requirement = `identifier + 证书根哈希`，跨重建稳定。
/// 只在 macOS 上做，失败不致命 (只 warn) —— 签名门在 `scripts/tauri-release.sh` 里兜底。
fn ensure_codesign_identity() {
    println!("cargo:rerun-if-changed=../../../scripts/macos-codesign-local.sh");
    if !cfg!(target_os = "macos") {
        return;
    }
    let name = std::env::var("BOLLOON_CODESIGN_IDENTITY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Bolloon Local Code Signing".to_string());
    let present = Command::new("security")
        .args(["find-identity", "-v", "-p", "codesigning"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&name))
        .unwrap_or(false);
    if present {
        return;
    }
    let manifest = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let script = manifest.join("../../../scripts/macos-codesign-local.sh");
    if !script.is_file() {
        println!("cargo:warning=找不到 {script:?}, 跳过代码签名身份准备");
        return;
    }
    println!("cargo:warning=缺代码签名身份「{name}」, 正在创建 (首次构建会弹一次钥匙串授权, 允许即可)");
    let st = Command::new("bash")
        .arg(&script)
        .arg("identity")
        .env("BOLLOON_CODESIGN_IDENTITY", &name)
        .status();
    match st {
        Ok(s) if s.success() => println!("cargo:warning=代码签名身份已就绪: {name}"),
        _ => println!(
            "cargo:warning=代码签名身份创建失败 —— 打包会因 signingIdentity 不存在而失败; \
             手动跑 `bash scripts/macos-codesign-local.sh identity` 看具体原因"
        ),
    }
}
