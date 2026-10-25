//! markdown.rs — 内联 Markdown 分词渲染
//!
//! **复用 TS 原文** `src/cli/markdown.ts` (`mdInline`):
//!   把正文里的 `` `code` `` / `**bold**` / `_italic_`… 不对, 是 `__underline__` / `*italic*`
//!   转成 ANSI 高亮, 供 `renderUserMessage` / `renderAgentMessage` 在出框前套用
//!   (字节变长, `disp_width` 剥 ANSI 不计宽)。
//!
//! 仅内联分段 — 多行代码块折叠 / Thinking / ToolTrail 折叠**未移植** (TS 侧也标注"仍待续")。

const R: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const UNDER: &str = "\x1b[4m";
const CYAN: &str = "\x1b[36m";
const GREEN: &str = "\x1b[32m";

pub fn md_inline(s: &str) -> String {
    let a = replace_pair(s, "`", CYAN, R);
    let b = replace_pair(&a, "**", BOLD, R);
    let c = replace_pair(&b, "__", UNDER, R);
    replace_italic(&c)
}

/**
 * 成对的定界符替换 (等价 JS `s.replace(new RegExp(delim + '([^x]+)' + delim, 'g'), …)`)。
 *
 * 三条与 TS 同一口径: ① 内容里**不许出现**定界符那个字符 (`` [^`]+ `` / `[^*]+` / `[^_]+`);
 * ② 从左到右非重叠扫描; ③ 配不上就把开头那个字符**原样吐出** (不吞字)。
 */
fn replace_pair(s: &str, delim: &str, open: &str, close: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let d: Vec<char> = delim.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if starts_with(&chars, i, &d) {
            let mut j = i + d.len();
            let mut content_end: Option<usize> = None;
            while j + d.len() <= chars.len() {
                if starts_with(&chars, j, &d) {
                    content_end = Some(j);
                    break;
                }
                if chars[j] == d[0] {
                    break; // 内容里出现定界符字符 → 这一段配不上
                }
                j += 1;
            }
            if let Some(e) = content_end {
                let content: String = chars[i + d.len()..e].iter().collect();
                out.push_str(open);
                out.push_str(&content);
                out.push_str(close);
                i = e + d.len();
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/**
 * 斜体: 等价 JS `/(^|[^*\w])\*([^*\s][^*]*)\*/g`。
 *
 * 前缀必须是**行首**或"非 `*` 且非 `\w`"的字符 —— 这样 `` a*b*c `` 里的 `b` 不会被误当斜体,
 * 而 `  *要强调*` 前面那个空格会被当作前缀**原样保留** (`${p}${GREEN}${c}${R}`)。
 */
fn replace_italic(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '*' {
            let ok_prefix = if i == 0 {
                true // `^`
            } else {
                let p = chars[i - 1];
                p != '*' && !is_word_char(p)
            };
            if ok_prefix {
                let mut end: Option<usize> = None;
                let mut j = i + 1;
                // 首字符: 非 `*` 且非空白 (`[^*\s]`)
                if j < chars.len() && chars[j] != '*' && !chars[j].is_whitespace() {
                    j += 1;
                    while j < chars.len() {
                        if chars[j] == '*' {
                            end = Some(j);
                            break;
                        }
                        j += 1;
                    }
                }
                if let Some(e) = end {
                    let content: String = chars[i + 1..e].iter().collect();
                    out.push_str(GREEN);
                    out.push_str(&content);
                    out.push_str(R);
                    i = e + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn starts_with(chars: &[char], at: usize, pat: &[char]) -> bool {
    at + pat.len() <= chars.len() && &chars[at..at + pat.len()] == pat
}

/** JS `\w` = `[A-Za-z0-9_]` */
fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_becomes_cyan() {
        assert_eq!(md_inline("用 `bolloon` 跑"), "用 \x1b[36mbolloon\x1b[0m 跑");
    }

    #[test]
    fn bold_becomes_bold() {
        assert_eq!(md_inline("**重要**"), "\x1b[1m重要\x1b[0m");
    }

    #[test]
    fn underline_and_italic() {
        assert_eq!(md_inline("__下划线__"), "\x1b[4m下划线\x1b[0m");
        assert_eq!(md_inline("这是 *斜体* 词"), "这是 \x1b[32m斜体\x1b[0m 词");
    }

    /// 前缀必须是行首或非词字符: `a*b*c` 不该被当斜体
    #[test]
    fn italic_needs_non_word_prefix() {
        assert_eq!(md_inline("a*b*c"), "a*b*c");
    }

    /// 内容里出现定界符 → 配不上, 原样吐出 (不吞字)
    #[test]
    fn unmatched_delimiter_is_verbatim() {
        assert_eq!(md_inline("`没闭合"), "`没闭合");
        assert_eq!(md_inline("**没闭合"), "**没闭合");
    }

    /// 顺序: 反引号先于 `**` (与 TS 的四次 replace 顺序一致)
    #[test]
    fn passes_run_in_ts_order() {
        let s = md_inline("`a` **b** __c__");
        assert!(s.contains("\x1b[36ma\x1b[0m"));
        assert!(s.contains("\x1b[1mb\x1b[0m"));
        assert!(s.contains("\x1b[4mc\x1b[0m"));
        assert!(s.find("\x1b[36m").unwrap() < s.find("\x1b[1m").unwrap());
    }
}
