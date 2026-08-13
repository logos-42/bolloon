package com.bolloon.agent.rokid

import org.json.JSONArray
import org.json.JSONObject

/**
 * MacroRecorder — 宏录制/重放 (2026-08-13, 借鉴 Ghost MacroRecorder)
 *
 * 录制 tap/swipe/type/back/home/wait 动作序列 (带相对时间戳), JSON 保存/加载, 倍速重放.
 * 用途: 录一次重复 N 次 (如自动签到/自动刷任务).
 *
 * MacroStep: {action, ts(相对录制开始 ms), params{...}}
 * Macro: {steps, duration, recordedAt}
 */
class MacroRecorder(private val tools: AndroidAgentTools) {

    data class MacroStep(
        val action: String,   // tap/swipe/type/back/home/wait
        val ts: Long,         // 相对录制开始
        val params: Map<String, Any> = emptyMap(),
    )

    data class Macro(
        val steps: List<MacroStep>,
        val duration: Long,
        val recordedAt: Long,
    )

    @Volatile
    private var recording = false
    private val steps = mutableListOf<MacroStep>()
    private var startTime = 0L

    // ============ 录制 ============

    fun start() {
        recording = true
        steps.clear()
        startTime = System.currentTimeMillis()
    }

    fun isRecording(): Boolean = recording

    fun tap(x: Int, y: Int) {
        if (!recording) return
        steps.add(MacroStep("tap", now(), mapOf("x" to x, "y" to y)))
        tools.execute("tap", mapOf("x" to x, "y" to y))
    }

    fun swipe(x1: Int, y1: Int, x2: Int, y2: Int, duration: Int = 200) {
        if (!recording) return
        steps.add(MacroStep("swipe", now(), mapOf("x1" to x1, "y1" to y1, "x2" to x2, "y2" to y2, "duration" to duration)))
        tools.execute("swipe", mapOf("x1" to x1, "y1" to y1, "x2" to x2, "y2" to y2, "duration" to duration))
    }

    fun type(text: String) {
        if (!recording) return
        steps.add(MacroStep("type", now(), mapOf("text" to text)))
        tools.execute("type", mapOf("text" to text))
    }

    fun back() {
        if (!recording) return
        steps.add(MacroStep("back", now(), emptyMap()))
        tools.execute("back", emptyMap())
    }

    fun home() {
        if (!recording) return
        steps.add(MacroStep("home", now(), emptyMap()))
        tools.execute("home", emptyMap())
    }

    fun waitStep(ms: Long) {
        if (!recording) return
        steps.add(MacroStep("wait", now(), mapOf("ms" to ms)))
    }

    /** 停止录制 → Macro */
    fun stop(): Macro {
        recording = false
        val m = Macro(steps.toList(), System.currentTimeMillis() - startTime, System.currentTimeMillis())
        steps.clear()
        return m
    }

    private fun now(): Long = System.currentTimeMillis() - startTime

    // ============ 序列化 ============

    fun toJson(macro: Macro): String {
        val arr = JSONArray()
        for (s in macro.steps) {
            val o = JSONObject()
                .put("action", s.action)
                .put("ts", s.ts)
            if (s.params.isNotEmpty()) {
                o.put("params", JSONObject(s.params))
            }
            arr.put(o)
        }
        return JSONObject()
            .put("steps", arr)
            .put("duration", macro.duration)
            .put("recordedAt", macro.recordedAt)
            .toString()
    }

    fun fromJson(json: String): Macro {
        val o = JSONObject(json)
        val arr = o.optJSONArray("steps") ?: JSONArray()
        val steps = mutableListOf<MacroStep>()
        for (i in 0 until arr.length()) {
            val s = arr.optJSONObject(i) ?: continue
            val params = mutableMapOf<String, Any>()
            s.optJSONObject("params")?.let { p ->
                p.keys().forEach { k -> params[k] = p.get(k) }
            }
            steps.add(MacroStep(s.optString("action", "wait"), s.optLong("ts", 0), params))
        }
        return Macro(steps, o.optLong("duration", 0), o.optLong("recordedAt", 0))
    }

    // ============ 重放 ============

    /** 重放宏 (speed: 1.0 正常, 2.0 两倍速). 返回执行结果日志. */
    fun replay(macro: Macro, speed: Float = 1.0f): String {
        val log = StringBuilder()
        var prevTs = 0L
        var prevReal = System.currentTimeMillis()
        for ((i, s) in macro.steps.withIndex()) {
            // 相对时间等待 (按 speed 缩放)
            val delta = s.ts - prevTs
            if (delta > 0 && i > 0) {
                val waitMs = (delta / speed).toLong()
                Thread.sleep(waitMs)
            }
            prevTs = s.ts
            val result = when (s.action) {
                "tap" -> tools.execute("tap", s.params)
                "swipe" -> tools.execute("swipe", s.params)
                "type" -> tools.execute("type", s.params)
                "back" -> tools.execute("back", emptyMap())
                "home" -> tools.execute("home", emptyMap())
                "wait" -> { Thread.sleep((s.params["ms"] as? Number)?.toLong() ?: 500); "waited" }
                else -> "unknown action ${s.action}"
            }
            log.append("step ${i + 1}/${macro.steps.size}: ${s.action} → ${result.take(80)}\n")
            prevReal = System.currentTimeMillis()
        }
        return log.toString().trim()
    }
}
