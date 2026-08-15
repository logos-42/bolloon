package com.bolloon.agent.rokid

import org.json.JSONObject

/**
 * ToolCallParser — LLM 决策解析器 (2026-08-15, 复刻桌面 parse-tool-call.ts)
 *
 * 桌面核心 harness 把"LLM 输出 → 工具调用"抽成 parseToolCall 纯函数 (多格式解析),
 * 手机 AgentLoop 原来只支持单一 JSON 格式. 这里复刻桌面解析语义:
 *
 * 支持格式 (按优先级):
 *   1. JSON 工具调用: {"name":"X","arguments":{...}} / {"name":"X","args":{...}} (含 ```json fence)
 *   2. 标签包裹 JSON: [TOOL_CALL]{...}[/TOOL_CALL] / <tool_call>{...}</tool_call>
 *   3. XML: <invoke name="X">...</invoke> / <function_calls><invoke ...> / <function_calls><tool name="X"><param name="Y">v</param></tool></function_calls>
 *   4. 自闭合 XML: <toolName a="1" b="2" />
 *   5. 中文: 调用工具：x(...) / 使用工具：x(...) / tool: x(...)
 *   6. 对象字面量: {tool => "x", args => {...}} / tool => "x"
 *   7. tool_name {json_args}
 *   8. XML 通用 <tool_name><command>...</command></tool_name> → shell 推断
 *
 * 别名: Claude Code / 通用叫法 → bolloon 手机工具名 (bash→shell, click→tap 等).
 * think 块剥离: <think>...</think> 先移除 (避免思考文本干扰解析).
 */
object ToolCallParser {

    /** 手机端已知工具集 */
    val TOOL_NAMES: Set<String> = setOf(
        "build_llm_context", "get_interactive_elements", "get_screen_tree", "classify_screen",
        "tap", "swipe", "type", "back", "home", "launch_app",
        "shell", "get_device_info", "list_packages", "done",
        "observe_screen", "get_ui_tree",
    )

    /** 别名表 (通用/Claude Code 叫法 → 手机工具名) */
    private val ALIASES: Map<String, String> = mapOf(
        "bash" to "shell", "shell_exec" to "shell", "sh" to "shell", "run_shell" to "shell", "execute" to "shell",
        "click" to "tap", "press" to "tap", "tap_at" to "tap",
        "input" to "type", "set_text" to "type", "text" to "type", "type_text" to "type",
        "open_app" to "launch_app", "open" to "launch_app", "start_app" to "launch_app", "launch" to "launch_app",
        "observe" to "build_llm_context", "screenshot" to "observe_screen", "look" to "build_llm_context",
        "ui_tree" to "get_ui_tree", "tree" to "get_screen_tree", "screen_tree" to "get_screen_tree",
        "elements" to "get_interactive_elements", "interactive_elements" to "get_interactive_elements",
        "classify" to "classify_screen", "classify_screen_type" to "classify_screen",
        "go_back" to "back", "press_back" to "back", "back_button" to "back",
        "go_home" to "home", "press_home" to "home", "home_button" to "home",
        "device" to "get_device_info", "device_info" to "get_device_info", "get_device" to "get_device_info",
        "packages" to "list_packages", "list_pkg" to "list_packages", "list_packages_filter" to "list_packages",
        "finish" to "done", "complete" to "done", "end" to "done", "agent_done" to "done", "final" to "done",
    )

    /** 识别为 shell 命令首词的关键字 (XML shell 推断用) */
    private val SHELL_KEYWORDS = setOf(
        "git", "pm", "am", "settings", "dumpsys", "input", "cmd", "service", "getprop", "setprop", "ps", "top",
        "ls", "cat", "head", "tail", "wc", "echo", "date", "whoami", "df", "du", "pm", "dumpsys",
    )

    data class ToolCall(
        val name: String,
        val args: Map<String, String>,
    )

    /** 解析 LLM 输出 → 工具调用 (多格式), 解析失败返 null */
    fun parse(content: String): ToolCall? {
        if (content.isBlank()) return null
        val stripped = stripThink(content)

        // 1. JSON 工具调用 (fence + OpenAI arguments/args + 手机 tool/args)
        jsonCall(stripped)?.let { return it }

        // 2. [TOOL_CALL] / <tool_call> 包裹 JSON
        tagJsonCall(stripped)?.let { return it }

        // 3. XML invoke / function_calls / tool tag
        xmlCall(stripped)?.let { return it }

        // 4. 自闭合 XML <toolName a="1" b="2"/>
        selfCloseCall(stripped)?.let { return it }

        // 5. 中文 调用工具：x(...)
        cnCall(stripped)?.let { return it }

        // 6. 对象字面量 {tool => "x", args => {...}} / tool => "x"
        objLiteralCall(stripped)?.let { return it }

        // 7. tool_name {json_args}
        nameJsonArgs(stripped)?.let { return it }

        // 8. XML 通用 <tag><command>...</command></tag> → shell 推断
        xmlShellInfer(stripped)?.let { return it }

        return null
    }

    /** 是否含 <final gen> 且无可解析工具 (工具优先, 与桌面 isFinalResponse 语义一致) */
    fun isFinalResponse(content: String): Boolean {
        if (content.isBlank()) return false
        val stripped = stripThink(content)
        if (!stripped.contains("<final gen>")) return false
        // 若还能解析出工具调用 → 不是 final (工具优先)
        return parse(stripped) == null
    }

    /** 提取最终答案 (去 <final gen> 标记) */
    fun extractFinalAnswer(content: String): String {
        var c = content
        val marker = "<final gen>"
        val idx = c.indexOf(marker)
        if (idx != -1) {
            val after = c.substring(idx + marker.length).trim()
            c = if (after.isNotEmpty()) after else c.substring(0, idx).trim()
        }
        // 清理工具调用噪声
        return c
            .replace(Regex("""调用工具[：:]\s*\w+\s*\([^)]*\)"""), "")
            .replace(Regex("""使用工具[：:]\s*\w+\s*\([^)]*\)"""), "")
            .trim()
    }

    /** 是否 LLM 失败哨兵 (桌面 [AI 服务调用失败]/[AI 调用失败]/[错误:]) */
    fun isAiFailureSentinel(reply: String): Boolean {
        val t = reply.trim()
        return t.startsWith("[AI 服务调用失败]") ||
            t.startsWith("[AI 调用失败]") ||
            t.startsWith("[LLM 调用失败]") ||
            t.startsWith("[LLM 错误") ||
            t.startsWith("[错误:")
    }

    // ============ 解析实现 ============

    /** 剥离 think 块 */
    private fun stripThink(content: String): String {
        return content.replace(Regex("""<think[\s\S]*?</think"""), "")
    }

    /** JSON 工具调用: {"name":"X","arguments":{...}} / {"name":"X","args":{...}} / {"tool":"X","args":{...}} (含 fence) */
    private fun jsonCall(stripped: String): ToolCall? {
        val m = Regex("""(?:```(?:json|json5)?\s*\n?)?\{[\s\S]*?"(?:name|tool)"\s*:\s*["'](\w+)["']\s*,\s*["']?(?:arguments|args|input)["']?\s*:\s*(\{[\s\S]*?\})\s*\}""")
            .find(stripped) ?: return null
        val name = m.groupValues[1]
        val argsRaw = m.groupValues[2]
        val args = parseJsonArgs(argsRaw)
        return buildToolCall(name, args)
    }

    /** [TOOL_CALL]{...}[/TOOL_CALL] / <tool_call>{...}</tool_call> */
    private fun tagJsonCall(stripped: String): ToolCall? {
        val m = Regex("""\[TOOL_CALL\][\s\S]*?\{\s*"name"\s*:\s*"(\w+)"\s*,\s*"args"\s*:\s*(\{[\s\S]*?\})""")
            .find(stripped)
        if (m != null) {
            return buildToolCall(m.groupValues[1], parseJsonArgs(m.groupValues[2]))
        }
        val m2 = Regex("""<tool_call>([\s\S]*?)</tool_call>""").find(stripped)
        if (m2 != null) {
            val inner = m2.groupValues[1].trim()
            return try {
                val o = JSONObject(inner)
                val name = o.optString("name", "")
                if (name.isNotEmpty()) {
                    val argsObj = o.optJSONObject("args") ?: o.optJSONObject("arguments")
                    buildToolCall(name, argsObj?.let { jsonObjToMap(it) } ?: emptyMap())
                } else null
            } catch (_: Exception) { null }
        }
        return null
    }

    /** XML: <invoke name="X">...</invoke> / <function_calls><invoke ...> / <function_calls><tool name="X"><param name="Y">v</param></tool></function_calls> */
    private fun xmlCall(stripped: String): ToolCall? {
        // <function_calls><tool name="X"><param name="Y">value</param></tool></function_calls>
        val toolTag = Regex("""<function_calls>[\s\S]*?<tool\s+name=["'](\w+)["']>([\s\S]*?)</tool>[\s\S]*?</function_calls>""").find(stripped)
        if (toolTag != null) {
            val name = toolTag.groupValues[1]
            val args = parseXmlArgs(toolTag.groupValues[2])
            return buildToolCall(name, args)
        }
        // <invoke name="X">...</invoke> (含 function_calls 包裹)
        val invoke = Regex("""<invoke\s+name=["']([\w]+)["']>([\s\S]*?)</invoke>""").find(stripped)
        if (invoke != null) {
            val name = invoke.groupValues[1]
            val args = parseXmlArgs(invoke.groupValues[2])
            return buildToolCall(name, args)
        }
        return null
    }

    /** 自闭合 XML: <toolName a="1" b="2" /> */
    private fun selfCloseCall(stripped: String): ToolCall? {
        val m = Regex("""<(\w+)((?:\s+\w+\s*=\s*["'][^"']*["'])*)\s*/\s*>""").find(stripped) ?: return null
        val name = m.groupValues[1]
        val attrStr = m.groupValues[2]
        val args = mutableMapOf<String, String>()
        val attrRe = Regex("""(\w+)\s*=\s*["']([^"']*)["']""")
        for (am in attrRe.findAll(attrStr)) {
            args[am.groupValues[1]] = am.groupValues[2].trim()
        }
        return buildToolCall(name, args)
    }

    /** 中文: 调用工具：x(...) / 使用工具：x(...) / tool: x(...) / x(...) */
    private fun cnCall(stripped: String): ToolCall? {
        val patterns = listOf(
            Regex("""调用工具[：:]\s*(\w+)\s*\(([^)]*)\)"""),
            Regex("""使用工具[：:]\s*(\w+)\s*\(([^)]*)\)"""),
            Regex("""tool[_\w]*[：:]\s*(\w+)\s*\(([^)]*)\)""", RegexOption.IGNORE_CASE),
        )
        for (p in patterns) {
            val m = p.find(stripped) ?: continue
            val name = m.groupValues[1]
            val rawArgs = m.groupValues[2]
            if (name.isBlank()) continue
            return buildToolCall(name, parseKeyValueArgs(rawArgs))
        }
        return null
    }

    /** 对象字面量: {tool => "x", args => {...}} / tool => "x" */
    private fun objLiteralCall(stripped: String): ToolCall? {
        val full = Regex("""\{\s*tool\s*=>\s*["'](\w+)["']\s*(?:,\s*args\s*=>\s*(\{[\s\S]*?\}))?\s*\}""").find(stripped)
        if (full != null) {
            val name = full.groupValues[1]
            val argsRaw = full.groupValues[2]
            return buildToolCall(name, if (argsRaw.isNotEmpty()) parseJsonArgs(argsRaw) else emptyMap())
        }
        val bare = Regex("""\btool\s*=>\s*["'](\w+)["']""").find(stripped)
        if (bare != null) {
            return buildToolCall(bare.groupValues[1], emptyMap())
        }
        return null
    }

    /** tool_name {json_args} */
    private fun nameJsonArgs(stripped: String): ToolCall? {
        val m = Regex("""(?:^|\n)(\w+)\s+(\{[\s\S]*?\})(?=\n|$)""").find(stripped) ?: return null
        val name = m.groupValues[1]
        val argsRaw = m.groupValues[2]
        val args = try {
            val o = JSONObject(argsRaw)
            jsonObjToMap(o)
        } catch (_: Exception) { emptyMap() }
        return buildToolCall(name, args)
    }

    /** XML 通用 <tag><command>...</command></tag> → shell 推断 */
    private fun xmlShellInfer(stripped: String): ToolCall? {
        val m = Regex("""<(\w+)>([\s\S]*?)</\1>""").find(stripped) ?: return null
        val outerTag = m.groupValues[1]
        val inner = m.groupValues[2]
        // 外层 tag 解析不到 (不是已知工具) 且内部含 <command> → 推断 shell
        val resolvedOuter = resolveName(outerTag)
        if (resolvedOuter == null) {
            val cmdM = Regex("""<command>([\s\S]*?)</command>""").find(inner)
            if (cmdM != null) {
                val cmd = cmdM.groupValues[1].trim()
                val cmdFirst = cmd.split(Regex("""\s+""")).first()
                if (SHELL_KEYWORDS.contains(cmdFirst)) {
                    val args = mutableMapOf<String, String>()
                    val remaining = cmd.removePrefix(cmdFirst).trim()
                    if (remaining.isNotEmpty()) {
                        args["command"] = cmdFirst
                        args["args"] = remaining
                    } else {
                        args["command"] = cmd
                    }
                    return buildToolCall("shell", args)
                }
            }
        }
        return null
    }

    /** XML 子标签参数: <parameter name="X">v</parameter> / <param name="X">v</param> / <tag>v</tag> */
    private fun parseXmlArgs(rawArgs: String): Map<String, String> {
        val args = mutableMapOf<String, String>()
        val paramRe = Regex("""<parameter\s+name=["'](\w+)["'][^>]*>([\s\S]*?)</parameter>""")
        for (m in paramRe.findAll(rawArgs)) {
            args[m.groupValues[1]] = m.groupValues[2].trim()
        }
        if (args.isNotEmpty()) return args
        val pRe = Regex("""<param\s+name=["'](\w+)["'][^>]*>([\s\S]*?)</param>""")
        for (m in pRe.findAll(rawArgs)) {
            args[m.groupValues[1]] = m.groupValues[2].trim().trim('"', '\'')
        }
        if (args.isNotEmpty()) return args
        val xmlArg = Regex("""<(\w+)>([\s\S]*?)</\1>""")
        for (m in xmlArg.findAll(rawArgs)) {
            args[m.groupValues[1]] = m.groupValues[2].trim()
        }
        return args
    }

    /** key:value 形参串 (中文调用格式) */
    private fun parseKeyValueArgs(rawArgs: String): Map<String, String> {
        val args = mutableMapOf<String, String>()
        val pairs = rawArgs.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        for (pair in pairs) {
            val parts = pair.split(":")
            if (parts.size < 2) continue
            val key = parts[0].trim().trim('"', '\'', ' ', '=')
            if (key.isEmpty()) continue
            val value = parts.drop(1).joinToString(":").trim().trim('"', '\'')
            args[key] = value
        }
        return args
    }

    /** 解析 JSON 参数对象 */
    private fun parseJsonArgs(raw: String): Map<String, String> {
        return try {
            val o = JSONObject(raw)
            jsonObjToMap(o)
        } catch (_: Exception) {
            emptyMap()
        }
    }

    private fun jsonObjToMap(o: JSONObject): Map<String, String> {
        val map = mutableMapOf<String, String>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            val v = o.get(k)
            map[k] = if (v == null) "" else v.toString()
        }
        return map
    }

    /** 工具名解析: 已知 → 原名; 别名 → 标准名; 否则 null */
    private fun resolveName(name: String): String? {
        if (TOOL_NAMES.contains(name)) return name
        val lower = name.lowercase()
        return ALIASES[lower]
    }

    /** 构造 ToolCall (带别名解析) */
    private fun buildToolCall(name: String, args: Map<String, String>): ToolCall? {
        val resolved = resolveName(name) ?: return null
        return ToolCall(resolved, autoSplitCommand(args))
    }

    /** 复刻桌面 autoSplitCommand: command 含空格且无 args → 拆成 command + args */
    private fun autoSplitCommand(args: Map<String, String>): Map<String, String> {
        val command = args["command"] ?: return args
        if (!command.contains(" ") || args.containsKey("args")) return args
        val parts = command.split(Regex("""\s+"""))
        val out = mutableMapOf<String, String>()
        out.putAll(args)
        out["command"] = parts[0]
        out["args"] = parts.drop(1).joinToString(" ")
        return out
    }
}