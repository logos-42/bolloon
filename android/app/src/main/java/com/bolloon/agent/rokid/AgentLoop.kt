package com.bolloon.agent.rokid

/**
 * AgentLoop — Android Agent 的 ReAct 循环 (2026-08-15, 复刻桌面核心 harness)
 *
 * while (!done) {
 *   observation = observe()            // AndroidAgentTools.build_llm_context
 *   context = build_context(goal, observation, memory, history)
 *   decision = llm(context)            // 远程 LLM
 *   action = decide(decision)          // react-loop 决策表 (复刻桌面)
 *   result = execute(action)           // AndroidAgentTools
 *   memory.append(observation, decision, result)
 * }
 *
 * 决策表 (复刻 src/agents/react-loop.ts decideNext):
 *   1. LLM 失败哨兵 ([AI 服务调用失败]/[LLM 调用失败]/[错误:]) → continue (push 反思)
 *   2. 可解析工具调用 (多格式, ToolCallParser) → execute-tool
 *   3. 含 <final gen> 且无工具 → final (LLM 显式终止)
 *   4. 工具名不在已知集合 → continue (提示换工具, LLM 反思)
 *   5. 默认 → continue (LLM 可能再想想)
 *
 * LLM 决策格式 (JSON, 复刻桌面解析, 支持多格式):
 *   {"tool":"tap","args":{"x":530,"y":1140}}
 *   <invoke name="type"><parameter name="text">你好</parameter></invoke>
 *   任务完成 <final gen> 给你答案
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

    /** 上下文溢出保护: 估算 token 超过阈值 → 截断历史 (复刻 decideContextOverflow) */
    var maxHistoryTokens = 60000

    /** 同一工具连续失败上限 (复刻 shouldHintToStopSameTool) */
    var sameToolFailThreshold = 3

    /** 累计错误上限 (复刻 shouldForceExit) */
    var maxTotalErrors = 6

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
        var totalErrors = 0
        var lastTool: String? = null
        var consecutiveFails = 0

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

            // 1. observe (借鉴 Ghost build_llm_context: all-in-one 快照)
            val observation = tools.execute("build_llm_context", emptyMap())
            onStep?.invoke("观察完成 (${observation.take(80)}...)")

            // 2. build context (最近历史 + 观察, 截断到上下文上限)
            val promptHistory = compactHistory()
            val decision = llm.chat(system, promptHistory + ("user" to observation))

            // 3. 失败哨兵 (复刻 decideNext case 1): push 错误进 history, 让 LLM 反思
            if (ToolCallParser.isAiFailureSentinel(decision)) {
                totalErrors++
                log.append("Step $stepCount: LLM 失败哨兵: ${decision.take(120)}\n")
                history.add("assistant" to decision)
                history.add("user" to "LLM 服务调用失败 (哨兵). 请重试, 或检查网络/配置。")
                if (shouldForceExit(totalErrors, maxTotalErrors)) {
                    val reason = "累计错误达到上限 ($totalErrors)"
                    onStep?.invoke(reason)
                    lifecycle?.fail(reason)
                    audit?.append(agentId, stepCount, "force-exit", reason)
                    return "FAILED: $reason (steps=$stepCount)"
                }
                continue
            }

            // 4. 解析决策 (多格式, 复刻桌面 parseToolCall)
            val toolCall = ToolCallParser.parse(decision)
            if (toolCall == null) {
                // 5. <final gen> 终止 (复刻 decideNext case 3)
                if (ToolCallParser.isFinalResponse(decision)) {
                    val answer = ToolCallParser.extractFinalAnswer(decision)
                    val summary = answer.ifBlank { "任务完成" }
                    history.add("assistant" to decision)
                    onStep?.invoke("任务完成: $summary")
                    lifecycle?.succeed(summary)
                    audit?.append(agentId, stepCount, "final", summary)
                    return "DONE: $summary (steps=$stepCount)"
                }
                // 6. 解析失败 → 让 LLM 反思 (不能继续空转)
                log.append("Step $stepCount: LLM 决策无法解析: ${decision.take(200)}\n")
                history.add("assistant" to decision)
                history.add("user" to "你的上一条输出无法解析为工具调用. 请严格按 {\"tool\":\"...\",\"args\":{...}} 或 <invoke name=\"...\"> 格式, 或输出 <final gen> 结束任务。")
                continue
            }

            // 7. 未知工具 → 反思 (复刻 decideNext case 4: 不在 known set)
            if (!ToolCallParser.TOOL_NAMES.contains(toolCall.name)) {
                log.append("Step $stepCount: 未知工具 ${toolCall.name}\n")
                history.add("assistant" to decision)
                history.add("user" to "工具 \"${toolCall.name}\" 不存在. 可用工具: ${ToolCallParser.TOOL_NAMES.joinToString(", ")}. 请换一个已知工具。")
                continue
            }

            // 8. done 工具 (兼容旧格式) — 与 <final gen> 等价
            if (toolCall.name == "done") {
                val summary = toolCall.args["summary"] ?: toolCall.args["reason"] ?: "任务完成"
                history.add("assistant" to decision)
                onStep?.invoke("任务完成: $summary")
                lifecycle?.succeed(summary)
                audit?.append(agentId, stepCount, "done", summary)
                return "DONE: $summary (steps=$stepCount)"
            }

            // 9. execute tool (args 转 Map<String, Any>)
            val args: Map<String, Any> = toolCall.args
            onStep?.invoke("执行工具: ${toolCall.name} $args")
            val result = tools.execute(toolCall.name, args)
            val success = !result.contains("\"success\":false")
            log.append("Step $stepCount: ${toolCall.name} → ${result.take(200)}\n")
            // Phase 4: 审计每条工具动作
            audit?.append(agentId, stepCount, toolCall.name, args.toString(), result.take(150))

            // 10. 同工具连续失败计数 (复刻 shouldHintToStopSameTool)
            if (toolCall.name == lastTool) {
                consecutiveFails = if (success) 0 else consecutiveFails + 1
            } else {
                lastTool = toolCall.name
                consecutiveFails = if (success) 0 else 1
            }
            if (!success && shouldHintToStopSameTool(consecutiveFails, sameToolFailThreshold)) {
                onStep?.invoke("⚠ 工具 ${toolCall.name} 连续失败 $consecutiveFails 次, 建议换方案")
                history.add("assistant" to decision)
                history.add("user" to "工具 ${toolCall.name} 已连续失败 $consecutiveFails 次, 不要再用同一个工具. 请换一个工具或策略。")
                consecutiveFails = 0 // 提示一次后重置, 避免每步都提示
                continue
            }

            // 11. memory append
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

    /** 上下文溢出保护 (复刻 decideContextOverflow + shouldCompactBeforeIteration): 估算 token 超阈值时截断最早历史 */
    private fun compactHistory(): List<Pair<String, String>> {
        val estimated = history.sumOf { (it.first.length + it.second.length) / 4 }
        if (estimated <= maxHistoryTokens) return history
        // 保留最近的 ~60% (按条数粗算)
        val keep = (history.size * 0.6).toInt().coerceAtLeast(4)
        val tail = history.takeLast(keep)
        val note = "user" to "[上下文已截断: 历史过长 (估算 $estimated tokens > $maxHistoryTokens), 保留最近 $keep 条。继续任务。]"
        val out = mutableListOf(note)
        out.addAll(tail)
        return out
    }

    /** 累计错误达到上限 (复刻 shouldForceExit) */
    private fun shouldForceExit(totalErrors: Int, maxTotalErrors: Int): Boolean {
        return totalErrors >= maxTotalErrors
    }

    /** 同一工具连续失败达到阈值 (复刻 shouldHintToStopSameTool) */
    private fun shouldHintToStopSameTool(consecutiveFails: Int, threshold: Int): Boolean {
        return consecutiveFails >= threshold
    }

    /** 系统提示: 描述工具集 + 决策格式 (对齐桌面 react-loop: <final gen> 显式终止) */
    private fun buildSystemPrompt(): String {
        return """
            你是运行在 Android 手机上的 Agent。你通过无障碍服务控制手机完成用户任务。
            可用工具 (每次输出一个工具调用, 支持 JSON 或 <invoke> XML 格式):
            - build_llm_context: 获取当前屏幕快照 (分类+文本+可交互元素+树) — 每步先用它观察
            - get_interactive_elements: 只取可交互元素 (点击目标)
            - get_screen_tree: LLM 友好 UI 树
            - classify_screen: 屏幕类型 (home/search/dialog/error/loading)
            - tap: {"x":530,"y":1140} 点击坐标
            - swipe: {"x1":..,"y1":..,"x2":..,"y2":..,"duration":200} 滑动
            - type: {"text":"..."} 输入文本 (需先 tap 聚焦输入框)
            - back: 返回
            - home: 回主页
            - launch_app: {"package":"com.tencent.mm"} 打开应用
            - shell: {"command":"pm list packages"} 系统 shell (只读/管理, 危险命令被拒)
            - get_device_info: 设备信息
            - list_packages: {"filter":"wechat"} 已安装应用列表
            
            输出格式 (任选其一, 不要输出其他文字):
            {"tool":"<工具名>","args":{...}}
            <invoke name="<工具名>"><parameter name="<参数>">值</parameter></invoke>
            
            任务完成时: 输出 "<final gen> 你的最终回答" (不要再调用工具)。
            
            规则:
            1. 先 observe 观察屏幕, 再决定动作
            2. 每次只输出一个工具调用
            3. 任务完成时输出 <final gen>
        """.trimIndent()
    }
}
