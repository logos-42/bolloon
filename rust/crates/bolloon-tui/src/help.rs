//! help.rs — `bolloon chat` 的键位文案 (**唯一事实源**)
//!
//! 纪律: 文案与键位映射**不许分叉**。`HELP_ITEMS` 里的每一条都在测试里对着
//! `compose::resolve_action` 逐条核 (见 `help_matches_keymap`), 谁改了键位却没改文案,
//! 或者写了文案却没实现, 测试立刻红。
//!
//! 落在哪个终端: 只落 **`bolloon chat` 这个 Rust 终端界面** —— 完整帮助页走 `Screen` 正文
//! (`/help` 触发), 一行摘要走 `Screen` 最底那条固定提示行 (`rows-1`)。
//! Web 终端 / TUI 选择器 (`bolloon model`) / TS 版 CLI 都不吃这份文案。

/// 一条帮助: 键位 + 干什么 (文案即契约)
pub struct HelpItem {
    pub keys: &'static str,
    pub what: &'static str,
}

/// 完整键位表 (顺序 = 优先级: 先发送, 再换行/草稿/贴图, 最后退出类)
pub const HELP_ITEMS: &[HelpItem] = &[
    HelpItem { keys: "Enter", what: "发送 (多行时整段一起发)" },
    HelpItem { keys: "Ctrl+J / Alt+Enter", what: "换行 (接着写下一段, 不发送)" },
    HelpItem { keys: "Ctrl+G", what: "用 $VISUAL/$EDITOR 写草稿, 存盘返回即成输入" },
    HelpItem { keys: "Alt+V", what: "贴剪贴板图片: 存成 PNG 并插入 @路径" },
    HelpItem { keys: "↑ / ↓", what: "翻本渠道的输入历史 (落盘, 重启还在)" },
    HelpItem { keys: "Esc", what: "取消当前输入 (不发送, 会话不退)" },
    HelpItem { keys: "Ctrl+C", what: "空闲时退出会话 (运行中 = 中断这一回合)" },
    HelpItem { keys: "Ctrl+D", what: "退出会话" },
    HelpItem { keys: "/help", what: "这份帮助 · /exit 或 /quit 退出" },
];

/// 输入行下方那条**恒常提示** (`Screen` 的 `rows-1` 固定行, 窄屏会被截断)
pub const HINT: &str = "Enter 发送 · Ctrl+J 换行 · Ctrl+G 草稿 · Alt+V 贴图 · ↑↓ 历史 · Ctrl+C 退出 · /help";

/// 帮助页 (纯文本行, 交给 `Screen::push_many` 或非 TTY 的 `println!`)
pub fn help_lines() -> Vec<String> {
    let mut out = Vec::with_capacity(HELP_ITEMS.len() + 3);
    out.push("Bolloon chat · 键位".to_string());
    let w = HELP_ITEMS.iter().map(|i| i.keys.chars().count()).max().unwrap_or(0);
    for it in HELP_ITEMS {
        out.push(format!("  {:<w$}  {}", it.keys, it.what, w = w));
    }
    out.push(String::new());
    out.push("多行输入: Ctrl+J 或 Alt+Enter 加一行; Enter 始终是发送。".to_string());
    out.push("草稿: Ctrl+G 会打开 $VISUAL/$EDITOR (建议设成 code --wait 这类会等待的编辑器)。".to_string());
    out
}

pub fn help_page() -> String {
    help_lines().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compose::{resolve_action, EditAction};
    use crate::select::Key;

    /// 文案里写的每个键位都**真的**映射到那个动作 (防"写了没做")
    #[test]
    fn help_matches_keymap() {
        assert_eq!(resolve_action(&Key::Enter), EditAction::Submit);
        assert_eq!(resolve_action(&Key::Newline), EditAction::Newline);
        assert_eq!(resolve_action(&Key::AltEnter), EditAction::Newline);
        assert_eq!(resolve_action(&Key::CtrlG), EditAction::OpenDraft);
        assert_eq!(resolve_action(&Key::AltV), EditAction::PasteImage);
        assert_eq!(resolve_action(&Key::Up), EditAction::HistoryPrev);
        assert_eq!(resolve_action(&Key::Down), EditAction::HistoryNext);
        assert_eq!(resolve_action(&Key::Esc), EditAction::Cancel);
        assert_eq!(resolve_action(&Key::Cancel), EditAction::Quit);
        assert_eq!(resolve_action(&Key::Eof), EditAction::Eof);
    }

    /// 帮助页里**必须**出现这四个新快捷键 + 两个命令 (少一个就是文案落后于实现)
    #[test]
    fn help_page_documents_every_new_shortcut() {
        let page = help_page();
        for k in [
            "Ctrl+J", "Alt+Enter", "Ctrl+G", "Alt+V", "↑ / ↓", "Ctrl+C", "Ctrl+D", "/help", "/exit",
        ] {
            assert!(page.contains(k), "帮助页漏了 {k}: {page}");
        }
    }

    /// 提示行同时写清"怎么发"和"怎么换行" —— 只写 Enter 发送会让人以为不能多行
    #[test]
    fn hint_mentions_send_and_newline() {
        assert!(HINT.contains("Enter 发送"));
        assert!(HINT.contains("Ctrl+J 换行"));
        assert!(HINT.contains("/help"));
    }

    /// 帮助页宽度有界 (窄屏由 Screen 截断, 但不该自己写出超长行)
    #[test]
    fn help_lines_are_bounded() {
        for l in help_lines() {
            assert!(crate::width::disp_width(&l) <= 100, "帮助行过长: {l:?}");
        }
    }
}
