package com.bolloon.agent.rokid

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * AndroidAgentTools — Android Agent 的 Tool Layer (Phase 1)
 *
 * 8 个工具, 通过 AccessibilityService 执行 (无 root):
 *   observe_screen / get_ui_tree / tap / swipe / type / back / home / launch_app
 *
 * 工具返回 JSON (Agent Loop 消费):
 *   { success, output, error? }
 */
class AndroidAgentTools(private val service: BolloonAccessibilityService, private val context: Context) {

    /** 分发一个工具调用, 返回 JSON 字符串 (Agent Loop 解析) */
    fun execute(tool: String, args: Map<String, Any>): String {
        return try {
            when (tool) {
                "observe_screen" -> observeScreen()
                "get_ui_tree" -> getUiTree()
                "tap" -> tap(args)
                "swipe" -> swipe(args)
                "type" -> type(args)
                "back" -> back()
                "home" -> home()
                "launch_app" -> launchApp(args)
                // Phase 2: Shizuku 系统级工具
                "shell" -> shell(args)
                "get_device_info" -> deviceInfo()
                "list_packages" -> listPackages(args)
                // 2026-08-13 (借鉴 Ghost): 增强 observe
                "get_interactive_elements" -> getInteractiveElements()
                "get_screen_tree" -> getScreenTree()
                "classify_screen" -> classifyScreen()
                "build_llm_context" -> buildLlmContext()
                else -> err("未知工具: $tool (可用: observe_screen/get_ui_tree/tap/swipe/type/back/home/launch_app/shell/get_device_info/list_packages/get_interactive_elements/get_screen_tree/classify_screen/build_llm_context)")
            }
        } catch (e: Exception) {
            err("工具 $tool 执行异常: ${e.message}")
        }
    }

    // ============ observe ============

    private fun observeScreen(): String {
        val text = service.getScreenText()
        val tree = service.getUiTree()
        val out = JSONObject()
        out.put("screen_text", text)
        out.put("node_count", tree.length())
        return ok(out)
    }

    private fun getUiTree(): String {
        return ok(service.getUiTree())
    }

    // ============ interact ============

    private fun tap(args: Map<String, Any>): String {
        val x = argInt(args["x"]) ?: return err("tap 需要 x 坐标 (数字)")
        val y = argInt(args["y"]) ?: return err("tap 需要 y 坐标 (数字)")
        val ok = service.performGlobalTap(x, y)
        return if (ok) ok(JSONObject().put("tapped", "$x,$y")) else err("tap 失败 (无障碍手势未执行)")
    }

    private fun swipe(args: Map<String, Any>): String {
        val x1 = argInt(args["x1"]) ?: return err("swipe 需要 x1")
        val y1 = argInt(args["y1"]) ?: return err("swipe 需要 y1")
        val x2 = argInt(args["x2"]) ?: return err("swipe 需要 x2")
        val y2 = argInt(args["y2"]) ?: return err("swipe 需要 y2")
        val duration = argLong(args["duration"]) ?: 200L
        val ok = service.performGlobalSwipe(x1, y1, x2, y2, duration)
        return if (ok) ok(JSONObject().put("swiped", "$x1,$y1 -> $x2,$y2")) else err("swipe 失败")
    }

    private fun type(args: Map<String, Any>): String {
        val text = args["text"] as? String ?: return err("type 需要 text")
        val root = service.rootNode() ?: return err("type 失败: 无活动窗口")
        return service.runOnMainThread {
            // 找到聚焦或可编辑节点, 用 ACTION_SET_TEXT 输入 (节点操作须在主线程)
            val editable = findEditableNode(root)
            if (editable == null) {
                // 无可编辑节点 → 尝试全局粘贴 (Phase 1 简化: 报告需要聚焦输入框)
                return@runOnMainThread err("未找到可输入节点, 请先 tap 聚焦输入框")
            }
            val bundle = android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
            val ok = editable.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
            if (ok) ok(JSONObject().put("typed", text)) else err("type 失败 (ACTION_SET_TEXT 未执行)")
        }
    }

    private fun findEditableNode(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isEditable || node.className?.toString()?.contains("EditText") == true) return node
        val count = node.childCount
        for (i in 0 until count) {
            val child = node.getChild(i) ?: continue
            val found = findEditableNode(child)
            if (found != null) return found
        }
        return null
    }

    // ============ navigation ============

    private fun back(): String {
        val ok = service.performGlobalBack()
        return if (ok) ok(JSONObject().put("action", "back")) else err("back 失败")
    }

    private fun home(): String {
        val ok = service.performGlobalHome()
        return if (ok) ok(JSONObject().put("action", "home")) else err("home 失败")
    }

    private fun launchApp(args: Map<String, Any>): String {
        val pkg = args["package"] as? String ?: return err("launch_app 需要 package (如 com.tencent.mm)")
        try {
            val intent = context.packageManager.getLaunchIntentForPackage(pkg)
                ?: return err("未找到应用: $pkg")
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            return ok(JSONObject().put("launched", pkg))
        } catch (e: Exception) {
            return err("launch_app 失败: ${e.message}")
        }
    }

    // ============ Phase 2: Shizuku 系统级工具 ============

    private fun shell(args: Map<String, Any>): String {
        val command = args["command"] as? String ?: return err("shell 需要 command")
        val out = ShizukuManager.shell(command)
        return ok(JSONObject().put("output", out))
    }

    private fun deviceInfo(): String {
        return ok(ShizukuManager.deviceInfo())
    }

    private fun listPackages(args: Map<String, Any>): String {
        val filter = args["filter"] as? String ?: ""
        val out = ShizukuManager.listPackages(filter)
        return ok(JSONObject().put("packages", out))
    }

    // ============ 2026-08-13 (借鉴 Ghost): 增强 observe ============

    /** 只提取可交互元素 (省 token) */
    private fun getInteractiveElements(): String {
        val arr = service.getInteractiveElements()
        val obj = JSONObject().put("count", arr.length()).put("elements", arr)
        return ok(obj)
    }

    /** LLM 友好缩进树 */
    private fun getScreenTree(): String {
        return ok(JSONObject().put("tree", service.getScreenTree(60)))
    }

    /** 屏幕分类 */
    private fun classifyScreen(): String {
        return ok(JSONObject().put("screen_type", service.classifyScreen()))
    }

    /** all-in-one 观察快照 (Ghost build_llm_context) — AgentLoop 每步用 */
    private fun buildLlmContext(): String {
        val obj = JSONObject()
        obj.put("screen_type", service.classifyScreen())
        obj.put("screen_text", service.getScreenText().take(1500))
        obj.put("interactive_elements", service.getInteractiveElements())
        obj.put("tree", service.getScreenTree(50))
        return ok(obj)
    }

    // ============ helpers ============

    private fun ok(data: Any): String {
        val obj = if (data is JSONObject) data else JSONObject().put("output", data)
        obj.put("success", true)
        return obj.toString()
    }

    private fun err(message: String): String {
        return JSONObject().apply {
            put("success", false)
            put("error", message)
        }.toString()
    }

    /**
     * 从参数取整数。ToolCallParser 把所有值序列化成 String (如 "530"),
     * 需兼容 Number 与数字字符串两种形态。
     */
    private fun argInt(v: Any?): Int? = when (v) {
        is Number -> v.toInt()
        is String -> v.trim().toIntOrNull()
        else -> null
    }

    /** 从参数取 Long, 兼容 Number 与数字字符串. 失败返 null. */
    private fun argLong(v: Any?): Long? = when (v) {
        is Number -> v.toLong()
        is String -> v.trim().toLongOrNull()
        else -> null
    }
}
