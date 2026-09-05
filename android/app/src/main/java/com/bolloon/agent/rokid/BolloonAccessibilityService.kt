package com.bolloon.agent.rokid

import android.accessibilityservice.AccessibilityService
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch

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

    /** 主线程 Handler: 无障碍手势/UI 树读取必须在主线程执行 (Android 限制) */
    @Volatile
    private var mainHandler: Handler? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        mainHandler = Handler(Looper.getMainLooper())
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

    /**
     * 在主线程同步执行 [block]。
     * Android 无障碍规定: dispatchGesture / rootInActiveWindow / performAction
     * 必须在 AccessibilityService 所在的主线程(Looper)调用, 从后台线程调用会失败或抛异常。
     * AgentLoop 在后台 Thread 中运行, 所有无障碍读写必须经此包装。
     * @return block 的返回值; block 在主线程抛异常时此方法原样重抛。
     */
    fun <T> runOnMainThread(block: () -> T): T {
        val h = mainHandler ?: Handler(Looper.getMainLooper()).also { mainHandler = it }
        // 已在主线程 → 直接执行
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return block()
        }
        var result: T? = null
        var error: Throwable? = null
        val latch = CountDownLatch(1)
        h.post {
            try {
                result = block()
            } catch (t: Throwable) {
                error = t
            } finally {
                latch.countDown()
            }
        }
        try {
            latch.await()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        error?.let { throw (it as? RuntimeException) ?: RuntimeException(it) }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    // ============ observe: UI 树 ============

    /**
     * 读取当前窗口 UI 树 (递归), 返回 JSON 数组。
     * 节点: {type, text, bounds, clickable, scrollable, children}
     */
    fun getUiTree(): JSONArray = runOnMainThread { getUiTree0() }

    private fun getUiTree0(): JSONArray {
        val root = rootInActiveWindow ?: return JSONArray()
        val arr = JSONArray()
        walkNode(root, arr, 0)
        return arr
    }

    /** 当前窗口可见文本 (简化 observe) */
    fun getScreenText(): String = runOnMainThread { getScreenText0() }

    private fun getScreenText0(): String {
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
    fun getInteractiveElements(): JSONArray = runOnMainThread { getInteractiveElements0() }

    private fun getInteractiveElements0(): JSONArray {
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
    fun getScreenTree(maxNodes: Int = 60): String = runOnMainThread {
        val root = rootInActiveWindow ?: return@runOnMainThread "(empty screen)"
        val lines = mutableListOf<String>()
        walkTree(root, lines, 0, 0, maxNodes)
        lines.joinToString("\n")
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

    /** 全局点击坐标 (x, y) — 必须在主线程调用 dispatchGesture, 阻塞到手势完成 */
    fun performGlobalTap(x: Int, y: Int): Boolean {
        val done = CountDownLatch(1)
        val result = runOnMainThread {
            val gesture = android.accessibilityservice.GestureDescription.Builder()
                .addStroke(android.accessibilityservice.GestureDescription.StrokeDescription(
                    android.graphics.Path().apply { moveTo(x.toFloat(), y.toFloat()) }, 0, 80))
                .build()
            val ok = dispatchGesture(
                gesture,
                object : android.accessibilityservice.AccessibilityService.GestureResultCallback() {
                    override fun onCompleted(gesture: android.accessibilityservice.GestureDescription?) {
                        done.countDown()
                    }

                    override fun onCancelled(gesture: android.accessibilityservice.GestureDescription?) {
                        done.countDown()
                    }
                },
                null
            )
            if (!ok) done.countDown()
            ok
        }
        // 等待手势真正完成 (异步), 让 Agent 下一步 observe 读到新屏幕
        try {
            done.await(2, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        return result
    }

    /** 全局滑动 (供 Tools 层调用) — 必须在主线程调用 dispatchGesture, 阻塞到手势完成 */
    fun performGlobalSwipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Long): Boolean {
        val done = CountDownLatch(1)
        val result = runOnMainThread {
            val path = android.graphics.Path().apply { moveTo(x1.toFloat(), y1.toFloat()); lineTo(x2.toFloat(), y2.toFloat()) }
            val gesture = android.accessibilityservice.GestureDescription.Builder()
                .addStroke(android.accessibilityservice.GestureDescription.StrokeDescription(path, 0, duration))
                .build()
            val ok = dispatchGesture(
                gesture,
                object : android.accessibilityservice.AccessibilityService.GestureResultCallback() {
                    override fun onCompleted(gesture: android.accessibilityservice.GestureDescription?) {
                        done.countDown()
                    }

                    override fun onCancelled(gesture: android.accessibilityservice.GestureDescription?) {
                        done.countDown()
                    }
                },
                null
            )
            if (!ok) done.countDown()
            ok
        }
        try {
            done.await(2, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        return result
    }

    /** 当前活动窗口根节点 (供 Tools 层访问) — rootInActiveWindow 须在主线程 */
    fun rootNode(): AccessibilityNodeInfo? = runOnMainThread { rootInActiveWindow }

    /** 全局返回 — performGlobalAction 须在主线程 */
    fun performGlobalBack(): Boolean = runOnMainThread { performGlobalAction(GLOBAL_ACTION_BACK) }

    /** 全局主页 — performGlobalAction 须在主线程 */
    fun performGlobalHome(): Boolean = runOnMainThread { performGlobalAction(GLOBAL_ACTION_HOME) }
}
