//! 手机原生拨号指令生成（纯函数，不依赖 Tauri / mobile 工程）。
//!
//! 诚实边界：
//! - 这里只生成**拨号意图**（Android Intent / iOS `tel:` URL），不真拨号。
//! - 真拨需要在手机壳里执行并申请权限；当前工程 `rust/app-tauri/src-tauri/gen/`
//!   不存在，无法编译验证，也无法在桌面真拨（桌面没有蜂窝）。
//! - iOS 只能 `tel:` 调起系统拨号器（用户手点确认），不能自动拨、不能拿通话音频。
//! - Android `ACTION_CALL` 可自动拨号（用户授权 `CALL_PHONE` 后），但 Android 10+
//!   禁止第三方 App 录通话。

use crate::call::state::is_e164;

/// 一条原生拨号意图
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDialIntent {
    pub platform: &'static str,
    /// Android: "android.intent.action.CALL" / iOS: ""（直接是 URL）
    pub action: String,
    /// `tel:+8613800138000`
    pub data_uri: String,
    /// 执行所需权限（iOS 无）
    pub required_permission: Option<String>,
}

/// 把 E.164 转成 `tel:` URI（只认合法号码）
fn tel_uri(e164: &str) -> Result<String, String> {
    if !is_e164(e164) {
        return Err(format!("原生拨号只接受 E.164: {e164}"));
    }
    Ok(format!("tel:{e164}"))
}

/// Android：构造 `ACTION_CALL` 自动拨号意图
pub fn android_call_intent(e164: &str) -> Result<NativeDialIntent, String> {
    let uri = tel_uri(e164)?;
    Ok(NativeDialIntent {
        platform: "android",
        action: "android.intent.action.CALL".into(),
        data_uri: uri,
        required_permission: Some("android.permission.CALL_PHONE".into()),
    })
}

/// iOS：构造 `tel:` URL（只能调起系统拨号器，用户手点确认）
pub fn ios_tel_url(e164: &str) -> Result<String, String> {
    tel_uri(e164)
}

/// 当前工程能否真拨（用于运行时自检，避免假装可用）
pub fn can_dial_natively() -> bool {
    // gen/ 不存在 ⇒ 没有手机壳 ⇒ 不能真拨
    let gen_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|p| p.join("app-tauri/src-tauri/gen"))
        .filter(|p| p.exists());
    gen_dir.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn android_intent_shape() {
        let i = android_call_intent("+8613800138000").unwrap();
        assert_eq!(i.platform, "android");
        assert_eq!(i.action, "android.intent.action.CALL");
        assert_eq!(i.data_uri, "tel:+8613800138000");
        assert_eq!(i.required_permission.as_deref(), Some("android.permission.CALL_PHONE"));
    }

    #[test]
    fn ios_url_shape() {
        assert_eq!(ios_tel_url("+8613800138000").unwrap(), "tel:+8613800138000");
    }

    #[test]
    fn rejects_non_e164() {
        assert!(android_call_intent("13800138000").is_err(), "缺 + 不合法");
        assert!(ios_tel_url("+86abc").is_err());
    }

    #[test]
    fn desktop_cannot_dial_natively() {
        // 本机是桌面工程, gen/ 不存在 ⇒ 如实报告不能真拨
        assert!(!can_dial_natively(), "本机工程没有手机壳, 不应谎称能真拨");
    }
}
