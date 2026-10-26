//! permission_mode.rs — 权限模式（对齐 TS `src/agents/permission-mode.ts`）
//!
//! **完全访问 = 所有权限都开放**（用户 2026-10-26 拍板 B 真·全开）:
//!   `bypass` 模式下不再拦截任何工具 —— shell 的 denylist / 命令白名单 / 路径保护
//!   **全部跳过**，非 shell 工具同样不再逐次授权。这是用户按"完全访问"按钮时
//!   明确期望的语义（不被反复打断），属于**用户显式选择**。
//!
//! **不随之撤掉的三件事**（它们是运行控制，不是权限门）:
//!   · 超时 / 取消（Ctrl+C）—— 撤掉会让 agent 跑飞且无法中断（决策 3）
//!   · 预算上限 —— 防止无限调用
//!   · 审计记录 —— 全开更要能追溯（带 `mode` 字段）
//!
//! 环境变量 `BOLLOON_PERM_MODE`（与 TS 同名同值）:
//!   `default` | `bypassPermissions`（也接受 `bypass` / `full`）; 非法值 → 回落 `default`。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionMode {
    /// 默认：按风险分级（只读默认允许 / 高风险需授权 / 各安全门生效）
    Default,
    /// 完全访问：**所有权限开放**（denylist / 白名单 / 路径 / 逐次授权 全跳过）
    Bypass,
}

impl PermissionMode {
    pub fn is_bypass(&self) -> bool {
        matches!(self, PermissionMode::Bypass)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            PermissionMode::Default => "default",
            PermissionMode::Bypass => "bypass",
        }
    }

    /// 展示名（给用户看的警告文案用）
    pub fn label(&self) -> &'static str {
        match self {
            PermissionMode::Default => "默认（分级授权）",
            PermissionMode::Bypass => "完全访问（所有权限开放）",
        }
    }
}

/// 解析模式字符串（对齐 TS: `bypassPermissions`；兼容 `bypass` / `full`）
pub fn parse_mode(s: Option<&str>) -> PermissionMode {
    match s.map(|v| v.trim().to_lowercase()).as_deref() {
        Some("bypasspermissions") | Some("bypass") | Some("full") => PermissionMode::Bypass,
        _ => PermissionMode::Default, // 非法/缺省 → 默认（不猜、不放宽）
    }
}

/// 从环境变量读（`BOLLOON_PERM_MODE`）
pub fn mode_from_env() -> PermissionMode {
    parse_mode(std::env::var("BOLLOON_PERM_MODE").ok().as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ts_alias_and_defaults() {
        assert_eq!(parse_mode(Some("bypassPermissions")), PermissionMode::Bypass);
        assert_eq!(parse_mode(Some("bypass")), PermissionMode::Bypass);
        assert_eq!(parse_mode(Some("full")), PermissionMode::Bypass);
        assert_eq!(parse_mode(Some("default")), PermissionMode::Default);
        assert_eq!(parse_mode(None), PermissionMode::Default);
        // 非法值回落默认（不猜、不放宽）
        assert_eq!(parse_mode(Some("yolo")), PermissionMode::Default);
    }

    #[test]
    fn bypass_flag_is_visible() {
        assert!(PermissionMode::Bypass.is_bypass());
        assert!(!PermissionMode::Default.is_bypass());
        assert!(PermissionMode::Bypass.label().contains("所有权限开放"));
    }
}
