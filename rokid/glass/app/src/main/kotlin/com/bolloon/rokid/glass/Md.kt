package com.bolloon.rokid.glass

import android.graphics.Color
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan

/**
 * 极简 Markdown 渲染：眼镜小屏只处理"读起来会碍眼"的几种标记。
 *
 * 支持：粗体、斜体、行内代码、# 标题、短横线列表、有序列表、> 引用、[文字](链接)
 * 不做：表格、嵌套、HTML、脚注 —— 小屏渲染了也不好读，保留原文更诚实。
 *
 * 实现是"逐段拼装"而不是"先替换再定位 span"：先删标记再算偏移，
 * 多个标记连写时偏移会错位（之前那版就是这么错的），拼装法不会。
 */
object Md {

    private val TOKEN = Regex("""\*\*([^*\n]+)\*\*|`([^`\n]+)`|(?<!\*)\*([^*\n]+)\*(?!\*)""")
    private val LINK = Regex("""\[([^\]]+)\]\(([^)]+)\)""")
    private val HEAD = Regex("""(?m)^(#{1,6})\s*""")
    private val BULLET = Regex("""(?m)^\s*[-*+]\s+""")
    private val QUOTE = Regex("""(?m)^\s*>\s?""")

    private const val C_CODE_BG = "#262626"
    private const val C_CODE_FG = "#9BE39B"

    fun render(src: String): CharSequence {
        var s = src.replace("\r\n", "\n")

        // 链接 → 文字 ⟨主机⟩（窄屏放不下整条 URL）
        s = LINK.replace(s) { m ->
            val text = m.groupValues[1].trim()
            val url = m.groupValues[2].trim()
            val host = url.substringAfter("://", url).substringBefore('/').take(22)
            if (text.isEmpty() || text == url) "⟨$host⟩" else "$text ⟨$host⟩"
        }
        s = HEAD.replace(s, "")
        s = BULLET.replace(s, "• ")
        s = QUOTE.replace(s, "▏")

        val out = SpannableStringBuilder()
        var cursor = 0
        for (m in TOKEN.findAll(s)) {
            if (m.range.first > cursor) out.append(s.substring(cursor, m.range.first))
            val bold = m.groupValues[1]
            val code = m.groupValues[2]
            val italic = m.groupValues[3]
            val start = out.length
            when {
                bold.isNotEmpty() -> {
                    out.append(bold)
                    out.setSpan(StyleSpan(Typeface.BOLD), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(Color.WHITE), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                code.isNotEmpty() -> {
                    out.append(code)
                    out.setSpan(TypefaceSpan("monospace"), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(BackgroundColorSpan(Color.parseColor(C_CODE_BG)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    out.setSpan(ForegroundColorSpan(Color.parseColor(C_CODE_FG)), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                italic.isNotEmpty() -> {
                    out.append(italic)
                    out.setSpan(StyleSpan(Typeface.ITALIC), start, out.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
                else -> out.append(m.value)
            }
            cursor = m.range.last + 1
        }
        if (cursor < s.length) out.append(s.substring(cursor))
        return out
    }

    /** 单行预览：去标记、压空白（弹窗/计数用） */
    fun plain(src: String, max: Int = 60): String {
        var s = LINK.replace(src) { it.groupValues[1] }
        s = s.replace(Regex("""[*`#>]"""), "")
        s = s.replace(Regex("""\s+"""), " ").trim()
        return if (s.length > max) s.take(max) + "…" else s
    }
}
