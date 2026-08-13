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
