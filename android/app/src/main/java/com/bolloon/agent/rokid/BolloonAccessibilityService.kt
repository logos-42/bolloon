package com.bolloon.agent.rokid

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * BolloonAccessibilityService — Android Agent Runtime 的"眼睛和手" (Phase 1)
 *
 * 通过 AccessibilityService:
 *   - observe: 读取当前窗口 UI 树 (getUiTree / getScreenText)
 *   - interact: 全局点击 (tap) / 返回 (back) / 主页 (home) — 手势与全局操作
 *
 * Agent Tool Layer 通过单例 (instance) 访问本 service。
 * 无 root 依赖 — AccessibilityService 官方能力 (API 28+)。
 */
class BolloonAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: BolloonAccessibilityService? = null
            private set

        /** UI 树最大节点数 (防超大窗口 OOM) */
        const val MAX_NODES = 800
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Phase 1: 不主动响应事件, 由 Agent Loop 主动 observe.
    }

    override fun onInterrupt() {
        // 服务被系统中断 (如权限变化)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    // ============ observe: UI 树 ============

    /**
     * 读取当前窗口 UI 树 (递归), 返回 JSON 数组。
     * 节点: {type, text, bounds, clickable, scrollable, children}
     */
    fun getUiTree(): JSONArray {
        val root = rootInActiveWindow ?: return JSONArray()
        val arr = JSONArray()
        walkNode(root, arr, 0)
        return arr
    }

    /** 当前窗口可见文本 (简化 observe) */
    fun getScreenText(): String {
        val root = rootInActiveWindow ?: return ""
        val texts = mutableListOf<String>()
        collectTexts(root, texts)
        return texts.joinToString(" ")
    }

    /**
     * 2026-08-13 (借鉴 Ghost get_interactive_elements):
     * 只提取"可交互/有标签"的元素 (点击/滚动/文本/描述), 带 center 坐标.
     * 比全树更省 token, LLM 直接拿到可点目标.
     * 返回 JSON 数组: [{text, desc, center:{x,y}, clickable, scrollable}]
     */
    fun getInteractiveElements(): JSONArray {
        val root = rootInActiveWindow ?: return JSONArray()
        val out = JSONArray()
        walkInteractive(root, out)
        return out
    }

    private fun walkInteractive(node: AccessibilityNodeInfo, out: JSONArray) {
        if (out.length() >= MAX_NODES) return
        val text = node.text?.toString() ?: ""
        val desc = node.contentDescription?.toString() ?: ""
        val clickable = node.isClickable
        val scrollable = node.isScrollable
        // 只保留可交互或有标签的元素 (Ghost: interactive_only)
        if (!clickable && !scrollable && text.isBlank() && desc.isBlank()) {
            // 仍遍历子节点 (有用节点可能在容器内)
            val count = node.childCount
            for (i in 0 until count) node.getChild(i)?.let { walkInteractive(it, out) }
            return
        }
        val b = Rect()
        node.getBoundsInScreen(b)
        if (b.isEmpty) return
        val obj = JSONObject()
        if (text.isNotBlank()) obj.put("text", text)
        if (desc.isNotBlank()) obj.put("desc", desc)
        if (clickable) obj.put("clickable", true)
        if (scrollable) obj.put("scrollable", true)
        obj.put("center", JSONArray().apply {
            put((b.left + b.right) / 2)
            put((b.top + b.bottom) / 2)
        })
        out.put(obj)
        // 继续遍历 (子节点可能有独立可交互元素)
        val count = node.childCount
        for (i in 0 until count) node.getChild(i)?.let { walkInteractive(it, out) }
    }

    private fun walkNode(node: AccessibilityNodeInfo, out: JSONArray, depth: Int) {
        if (depth > 30 || out.length() >= MAX_NODES) return
        val obj = JSONObject()
        obj.put("type", node.className?.toString()?.substringAfterLast('.') ?: "unknown")
        node.text?.let { obj.put("text", it.toString()) }
        node.contentDescription?.let { obj.put("desc", it.toString()) }
        if (node.isClickable) obj.put("clickable", true)
        if (node.isScrollable) obj.put("scrollable", true)
        if (node.isChecked) obj.put("checked", node.isChecked)
        val b = Rect()
        node.getBoundsInScreen(b)
        if (!b.isEmpty) {
            obj.put("bounds", JSONArray().apply { put(b.left); put(b.top); put(b.right); put(b.bottom) })
        }
        val childCount = node.childCount
        if (childCount > 0) {
            val arr = JSONArray()
            for (i in 0 until childCount) {
                if (out.length() >= MAX_NODES) break
                val child = node.getChild(i) ?: continue
                walkNode(child, arr, depth + 1)
            }
            obj.put("children", arr)
        }
        out.put(obj)
    }

    private fun collectTexts(node: AccessibilityNodeInfo, out: MutableList<String>) {
        node.text?.let { if (it.isNotBlank()) out.add(it.toString()) }
        node.contentDescription?.let { if (it.isNotBlank()) out.add(it.toString()) }
        val childCount = node.childCount
        for (i in 0 until childCount) {
            node.getChild(i)?.let { collectTexts(it, out) }
        }
    }

    /**
     * 2026-08-13 (借鉴 Ghost get_screen_tree):
     * LLM 友好的缩进 UI 树: [idx] Class "label" [clickable,scrollable] [x1,y1][x2,y2]
     * 跳过纯布局容器 (无标签不可交互). 返回字符串.
     */
    fun getScreenTree(maxNodes: Int = 60): String {
        val root = rootInActiveWindow ?: return "(empty screen)"
        val lines = mutableListOf<String>()
        walkTree(root, lines, 0, 0, maxNodes)
        return lines.joinToString("\n")
    }

    private fun walkTree(node: AccessibilityNodeInfo, out: MutableList<String>, depth: Int, idxRef: Int, max: Int): Int {
        var idx = idxRef
        if (out.size >= max) return idx
        val text = node.text?.toString() ?: ""
        val desc = node.contentDescription?.toString() ?: ""
        val cls = node.className?.toString()?.substringAfterLast('.') ?: "Node"
        val clickable = node.isClickable
        val scrollable = node.isScrollable
        val b = Rect()
        node.getBoundsInScreen(b)
        val label = text.ifBlank { desc }
        val isUseful = label.isNotBlank() || clickable || scrollable
        if (!isUseful) {
            // 跳容器但仍遍历子节点
            val c = node.childCount
            for (i in 0 until c) node.getChild(i)?.let { idx = walkTree(it, out, depth, idx, max) }
            return idx
        }
        idx++
        val indent = "  ".repeat(minOf(depth, 6))
        val flags = buildList {
            if (clickable) add("clickable")
            if (scrollable) add("scrollable")
        }
        val flagStr = if (flags.isEmpty()) "" else " [${flags.joinToString(",")}]"
        val labelStr = if (label.isNotBlank()) " \"${label.take(60)}\"" else ""
        val boundsStr = if (!b.isEmpty) " [${b.left},${b.top}][${b.right},${b.bottom}]" else ""
        out.add("$indent[$idx] $cls$labelStr$flagStr$boundsStr")
        val c = node.childCount
        for (i in 0 until c) node.getChild(i)?.let { idx = walkTree(it, out, depth + 1, idx, max) }
        return idx
    }

    /**
     * 2026-08-13 (借鉴 Ghost classify_screen):
     * 启发式识别屏幕类型: home / search / dialog / error / loading / other
     */
    fun classifyScreen(): String {
        val text = getScreenText().lowercase()
        val tree = getScreenTree(40)
        val hasEdit = tree.contains("EditText")
        val hasDialog = tree.contains("Dialog") || text.contains("dialog")
        val hasLoading = text.contains("loading") || text.contains("加载") || tree.contains("ProgressBar")
        val hasError = text.contains("error") || text.contains("错误") || text.contains("失败") || text.contains("not found")
        val isHome = tree.lines().count() <= 3 && text.isBlank()
        return when {
            hasError -> "error"
            hasDialog -> "dialog"
            hasLoading -> "loading"
            hasEdit -> "search"
            isHome -> "home"
            else -> "other"
        }
    }

    // ============ interact: 全局操作 ============

    /** 全局点击坐标 (x, y) */
    fun performGlobalTap(x: Int, y: Int): Boolean {
        return dispatchGesture(
            android.accessibilityservice.GestureDescription.Builder()
                .addStroke(android.accessibilityservice.GestureDescription.StrokeDescription(
                    android.graphics.Path().apply { moveTo(x.toFloat(), y.toFloat()) }, 0, 80))
                .build(),
            null,
            null
        )
    }

    /** 全局滑动 (供 Tools 层调用) */
    fun performGlobalSwipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long): Boolean {
        val path = android.graphics.Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
        return dispatchGesture(
            android.accessibilityservice.GestureDescription.Builder()
                .addStroke(android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, duration))
                .build(),
            null,
            null
        )
    }

    /** 当前活动窗口根节点 (供 Tools 层访问) */
    fun rootNode(): AccessibilityNodeInfo? = rootInActiveWindow

    /** 全局返回 */
    fun performGlobalBack(): Boolean = performGlobalAction(GLOBAL_ACTION_BACK)

    /** 全局主页 */
    fun performGlobalHome(): Boolean = performGlobalAction(GLOBAL_ACTION_HOME)
}
