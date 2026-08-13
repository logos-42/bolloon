package com.bolloon.agent.rokid

import org.json.JSONArray
import org.json.JSONObject

/**
 * AgentLoop — Android Agent 的 ReAct 循环 (Phase 1)
 *
 * while (!done) {
 *   observation = observe()            // AndroidAgentTools.observe_screen
 *   context = build_context(goal, observation, memory, history)
 *   decision = llm(context)            // 远程 LLM
 *   result = execute(decision.tool)    // AndroidAgentTools
 *   memory.append(observation, decision, result)
 * }
 *
 * LLM 决策格式 (JSON):
 *   {"tool":"tap","args":{"x":530,"y":1140}}
 *   {"tool":"done","summary":"..."}
 */
class AgentLoop(
    private val tools: AndroidAgentTools,
    private val llm: LlmBackend,
) {
    /** 循环历史 (发给 LLM 的对话) */
    private val history = mutableListOf<Pair<String, String>>()
    private var stepCount = 0

    /** 最大步数 (防无限循环) */
    var maxSteps = 20

    /** 回调: 每步通知 UI (status 文本) */
    var onStep: ((String) -> Unit)? = null

    /** Phase 4: 生命周期管理器 (每步检查取消请求) */
    var lifecycle: AgentLifecycleManager? = null

    /** Phase 4: 审计日志 (每步记录) */
    var audit: AgentAuditLog? = null

    /** Phase 4: 当前 agentId (审计用) */
    var agentId: String = "agent"

    /** 执行一个目标 (在后台线程调用) */
    fun run(goal: String): String {
        stepCount = 0
        history.clear()
        history.add("user" to goal)

        val system = buildSystemPrompt()
        val log = StringBuilder()

        while (stepCount < maxSteps) {
            // Phase 4: 两段式取消检查 — CANCEL_REQUESTED 时停止
            if (lifecycle?.isCancelRequested() == true) {
                lifecycle?.confirmCancelled()
                onStep?.invoke("已取消")
                audit?.append(agentId, stepCount, "cancel", "user requested cancel")
                return "CANCELLED"
            }
            stepCount++
            onStep?.invoke("Step $stepCount: observe...")

            // 1. observe
            val observation = tools.execute("observe_screen", emptyMap())
            onStep?.invoke("观察完成 (${observation.take(80)}...)")

            // 2. build context (最近历史 + 观察)
            val decision = llm.chat(system, history + ("user" to observation))

            // 3. parse decision
            val parsed = parseDecision(decision)
            if (parsed == null) {
                log.append("Step $stepCount: LLM 决策无法解析: ${decision.take(200)}\n")
                history.add("user" to "你的上一条输出无法解析为 JSON 工具调用, 请严格按 {\"tool\":\"...\",\"args\":{...}} 格式输出")
                continue
            }

            // 4. done?
            val toolName = parsed.optString("tool", "")
            if (toolName == "done") {
                val summary = parsed.optString("summary", "任务完成")
                history.add("assistant" to decision)
                onStep?.invoke("任务完成: $summary")
                lifecycle?.succeed(summary)
                audit?.append(agentId, stepCount, "done", summary)
                return "DONE: $summary (steps=$stepCount)"
            }

            // 5. execute tool
            val args = parsed.optJSONObject("args")?.let { a ->
                a.keys().asSequence().associateWith { a.get(it) as Any }
            } ?: emptyMap()
            onStep?.invoke("执行工具: $toolName ${args}")
            val result = tools.execute(toolName, args)
            log.append("Step $stepCount: $toolName → ${result.take(200)}\n")
            // Phase 4: 审计每条工具动作
            audit?.append(agentId, stepCount, toolName, args.toString(), result.take(150))

            // 6. memory append
            history.add("assistant" to decision)
            history.add("user" to "工具结果: $result")

            if (stepCount >= maxSteps) {
                onStep?.invoke("达到最大步数 ($maxSteps), 停止")
                lifecycle?.interrupt("max steps")
                return "MAX_STEPS: $log"
            }
        }
        lifecycle?.interrupt("stopped")
        return "STOPPED: $log"
    }

    /** 系统提示: 描述工具集 + 决策格式 */
    private fun buildSystemPrompt(): String {
        return """
            你是运行在 Android 手机上的 Agent。你通过无障碍服务控制手机完成用户任务。
            可用工具 (每次输出一个 JSON 工具调用):
            - observe_screen: 读取当前屏幕文本 (观察)
            - get_ui_tree: 读取 UI 树 JSON
            - tap: {"x":530,"y":1140} 点击坐标
            - swipe: {"x1":..,"y1":..,"x2":..,"y2":..,"duration":200} 滑动
            - type: {"text":"..."} 输入文本 (需先 tap 聚焦输入框)
            - back: 返回
            - home: 回主页
            - launch_app: {"package":"com.tencent.mm"} 打开应用
            - shell: {"command":"pm list packages"} 系统 shell (只读/管理, 危险命令被拒)
            - get_device_info: 设备信息
            - list_packages: {"filter":"wechat"} 已安装应用列表
            - done: {"summary":"..."} 任务完成
            
            输出格式 (严格 JSON, 不要输出其他文字):
            {"tool":"<工具名>","args":{...}}
            
            规则:
            1. 先 observe 观察屏幕, 再决定动作
            2. 每次只输出一个工具调用
            3. 任务完成时输出 done
        """.trimIndent()
    }

    /** 解析 LLM 决策 (提取 JSON 工具调用) */
    private fun parseDecision(text: String): JSONObject? {
        val t = text.trim()
        // 直接 JSON
        if (t.startsWith("{")) {
            return try { JSONObject(t) } catch (_: Exception) { null }
        }
        // 提取 ```json ... ``` 或第一个 {...}
        val fence = Regex("```(?:json)?\\s*([\\s\\S]*?)```").find(t)
        val candidate = fence?.groupValues?.get(1)?.trim() ?: t
        val braceStart = candidate.indexOf('{')
        if (braceStart >= 0) {
            return try { JSONObject(candidate.substring(braceStart)) } catch (_: Exception) { null }
        }
        return null
    }
}
