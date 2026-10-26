//! completion.rs — 输入前缀驱动的命令补全控制器 (**纯函数**, 不碰终端)
//!
//! 三种交互模式, 由当前编辑行的**前缀**决定 (与 Hermes 一致):
//!   · `/` → 斜杠命令补全 (数据源由调用方注入, 通常来自 `slash::specs`)
//!   · `@` → 文件 / 路径补全 (调用方按 cwd 列目录)
//!   · `!` → Shell 命令模式提示 (调用方给一组 shell 动词或提示)
//!
//! 纯粹性: 本模块只做"缓冲 → 该不该补全 → 候选怎么筛 → 接受后怎么改缓冲",
//! 完全不知道终端怎么画、候选从哪来 —— 那些由 `input.rs` 的 IO 层负责。
//! 这样补全的语义能在单测里逐条钉住 (见底部 tests)。

/// 补全模式
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComplKind {
    Slash,
    At,
    Bang,
}

impl ComplKind {
    /// 触发字符 (`/` `@` `!`)
    pub fn trigger(self) -> char {
        match self {
            ComplKind::Slash => '/',
            ComplKind::At => '@',
            ComplKind::Bang => '!',
        }
    }
}

/// 一条候选 (已含符号与说明, 渲染层只管画)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComplItem {
    /// 展示名 (含触发符, 如 `/retry`)
    pub label: String,
    /// 接受时插入的**值** (不含触发符, 如 `retry`)
    pub value: String,
    /// 右侧说明 (命令摘要 / 文件类型)
    pub hint: Option<String>,
}

/// 在缓冲里探一下: 当前编辑行是不是处在某个补全模式里。
///
/// 返回 `(模式, 触发符在缓冲里的字节下标, 触发符之后的查询串)`。
/// 只认**当前行**(最后一个 `\n` 之后): 多行缓冲里历史行不参与补全。
pub fn detect(buf: &str) -> Option<(ComplKind, usize, String)> {
    let line_start = buf.rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line = &buf[line_start..];

    if line.starts_with('/') {
        return Some((ComplKind::Slash, line_start, line[1..].to_string()));
    }
    if line.starts_with('!') {
        return Some((ComplKind::Bang, line_start, line[1..].to_string()));
    }
    // `@` 补全: 取最后一个 `@`, 其后不能有空白, 且 `@` 前必须是行首或空白 (整词起点)
    if let Some(at) = line.rfind('@') {
        let after = &line[at + 1..];
        if !after.is_empty() && !after.contains(char::is_whitespace) {
            let prev = line[..at].chars().last();
            if prev.is_none() || prev.unwrap().is_whitespace() {
                return Some((ComplKind::At, line_start + at, after.to_string()));
            }
        }
    }
    None
}

/// 按查询串筛候选 (大小写不敏感, 匹配 label)。
/// 调用方给的候选可能已经预筛过, 这里再筛一遍是双保险 (查询随每次按键变化)。
pub fn filter_items(items: &[ComplItem], query: &str) -> Vec<ComplItem> {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() {
        return items.to_vec();
    }
    items
        .iter()
        .filter(|it| it.label.to_ascii_lowercase().contains(&q))
        .cloned()
        .collect()
}

/// 接受一条候选: 把触发符+查询串那段替换成 `触发符 + 值 + 空格`, 其余缓冲原样保留。
///
/// `start` 是触发符字节下标, `query_len` 是查询串**字节**长度 (不含触发符)。
pub fn apply(buf: &str, kind: ComplKind, start: usize, query_len: usize, value: &str) -> String {
    let end = start + 1 + query_len; // 触发符 1 字节 + 查询串
    let end = end.min(buf.len());
    let mut s = String::with_capacity(buf.len() + value.len() + 2);
    s.push_str(&buf[..start]);
    s.push(kind.trigger());
    s.push_str(value);
    s.push(' ');
    s.push_str(&buf[end..]);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(name: &str, value: &str, hint: &str) -> ComplItem {
        ComplItem { label: name.into(), value: value.into(), hint: Some(hint.into()) }
    }

    /// `/` 行 → Slash 模式, 查询串是 `/` 之后全部
    #[test]
    fn detect_slash() {
        let (k, start, q) = detect("/ret").unwrap();
        assert_eq!(k, ComplKind::Slash);
        assert_eq!(start, 0);
        assert_eq!(q, "ret");
    }

    /// `!` 行 → Bang 模式
    #[test]
    fn detect_bang() {
        let (k, _, q) = detect("!ls").unwrap();
        assert_eq!(k, ComplKind::Bang);
        assert_eq!(q, "ls");
    }

    /// `@` 词 → At 模式, 查询是 `@` 之后到空白前
    #[test]
    fn detect_at_mid_line() {
        let (k, start, q) = detect("看 @src/mai").unwrap();
        assert_eq!(k, ComplKind::At);
        assert_eq!(&buf_at(buf_of("看 @src/mai"), start), "@");
        assert_eq!(q, "src/mai");
    }

    /// `@` 不在词首 (前面不是空白) 不触发, 避免误伤邮箱之类
    #[test]
    fn detect_at_requires_word_boundary() {
        assert!(detect("a@b").is_none(), "前面是字母, 不该触发");
        assert!(detect("x@y z").is_none(), "查询里有空格, 不该触发");
    }

    /// 普通文本不触发任何补全
    #[test]
    fn detect_plain_text_is_none() {
        assert!(detect("hello world").is_none());
        assert!(detect("写个报告").is_none());
    }

    /// 多行缓冲: 只认当前行 (最后一行)
    #[test]
    fn detect_only_current_line() {
        assert!(detect("第一行 /cmd\n第二行").is_none());
        let (k, _, q) = detect("第一行\n/ret").unwrap();
        assert_eq!(k, ComplKind::Slash);
        assert_eq!(q, "ret");
    }

    /// 筛候选: 大小写不敏感, 匹配 label (contains 语义)
    #[test]
    fn filter_is_case_insensitive() {
        let items = vec![item("/Retry", "retry", "重试"), item("/Reset", "reset", "重置")];
        // "re" 同时命中 /retry 与 /reset
        let got = filter_items(&items, "re");
        assert_eq!(got.len(), 2);
        // "ret" 只命中 /retry (contains 不是前缀匹配)
        let got = filter_items(&items, "ret");
        assert_eq!(got.len(), 1);
        // 大小写不敏感
        let got = filter_items(&items, "RETRY");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].value, "retry");
    }

    /// 接受 `/ret` + 选 `/retry` ⇒ 缓冲变成 `/retry ` (带尾空格)
    #[test]
    fn apply_slash_inserts_value_with_space() {
        let buf = "/ret";
        let new = apply(buf, ComplKind::Slash, 0, 3, "retry");
        assert_eq!(new, "/retry ");
    }

    /// 接受 `@src` + 选 `src/main.rs` ⇒ 缓冲里那段被替换, tail 保留
    #[test]
    fn apply_at_replaces_token() {
        let buf = "看 @src 这里";
        // 不走 detect (@ 模式要求 @ 后无空白, 带 tail 场景直接测 apply):
        // "看"=3字节 + 空格 ⇒ @ 在字节下标 4, 查询 "src" 字节长 3
        let new = apply(buf, ComplKind::At, 4, 3, "src/main.rs");
        assert_eq!(new, "看 @src/main.rs  这里");
    }

    /// 接受后光标后内容保留 (slash 模式要求行首 `/`)
    #[test]
    fn apply_keeps_tail() {
        let buf = "/hel 后缀";
        // 不走 detect: query 是已输入的 3 字节, 之后 " 后缀" 是保留的 tail
        let new = apply(buf, ComplKind::Slash, 0, 3, "help");
        assert_eq!(new, "/help  后缀");
    }

    // 小工具: 把 &str 转 String 再取字节下标处的字符 (仅测试用)
    fn buf_of(s: &str) -> String {
        s.to_string()
    }
    fn buf_at(buf: String, start: usize) -> String {
        buf[start..].chars().next().map(|c| c.to_string()).unwrap_or_default()
    }
}
