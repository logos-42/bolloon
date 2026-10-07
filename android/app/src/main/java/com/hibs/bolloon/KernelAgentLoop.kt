package com.hibs.bolloon

/**
 * KernelAgentLoop — 桌面 kernel 完整 harness 循环的 Android 原生移植 (2026-10-07)
 *
 * 与桌面 `WorkflowPivotLoop` / `react-loop` 对齐的核心机制:
 *   ① LLM 经 KernelModelRuntime (连接池复用 + 超时/取消 + 限流退避 + 熔断 + 回退链)
 *   ② Run 生命周期状态机 (queued→running→done/failed/aborted/needs_human...)
 *   ③ 失败哨兵 → 反思重试 (AI 服务失败时 push 错误进历史, 让 LLM 换个说法)
 *   ④ 未知工具 → 提示可用集 (不静默空转)
 *   ⑤ 同工具连续失败 → 提示换策略 (shouldHintToStopSameTool)
 *   ⑥ 上下文溢出 → 截断历史 (compactHistory)
 *   ⑦ 错误分类 → 恢复动作 (transient 重试 / auth 交人 / repeat 熔断)
 *   ⑧ 预算闸门: maxSteps 到点如实结束 (failed, 不假装完成)
 *
 * 线程: 调用方应在后台线程执行 (run() 会阻塞直到完成或取消)。
 */
class KernelAgentLoop(
    private val tools: AndroidAgentTools,
    private val runtime: KernelModelRuntime,
    private val snapshot: KernelModelSnapshot,
) {
    private val history = mutableListOf<Pair<String, String>>()
    private var stepCount = 0

    /** 最大步数 (预算闸门) */
    var maxSteps = 20
    /** 上下文溢出阈值 (粗估 tokens) */
    var maxHistoryTokens = 24000
    /** 同工具连续失败阈值 */
    var sameToolFailThreshold = 3
    /** Run 状态机 (可注入; 每步记录) */
    var runState: KernelRunStateMachine? = null
    /** 取消信号 */
    var signal: CancellationSignal? = null
    /** 每步通知 UI */
    var onStep: ((String) -> Unit)? = null

    /** 执行一个目标 (阻塞; 应在后台线程调用) */
    fun run(goal: String): String {
        stepCount = 0
        history.clear()
        history.add("user" to goal)
        val system = buildSystemPrompt()
        val log = StringBuilder()
        var totalErrors = 0
        var lastTool: String? = null
        var consecutiveFails = 0
        val lease = runtime.acquire(snapshot)

        try {
            // Run 状态机: queued → running
            runState?.let { st ->
                st.transition("running")
                onStep?.invoke("[run] ${st.record?.runId ?: ""} running")
            }

            while (stepCount < maxSteps) {
                // 取消检查
                if (signal?.isCancelled == true) {
                    runState?.transition("aborted")
                    onStep?.invoke("已取消")
                    return "ABORTED (用户取消)"
                }
                stepCount++

                // 1. observe
                runState?.recordStep("observe", true)
                onStep?.invoke("Step $stepCount: observe...")
                val observation = tools.execute("build_llm_context", emptyMap())

                // 2. LLM 决策 (经 KernelModelRuntime: 连接池/超时/退避/熔断/回退)
                val promptHistory = compactHistory()
                val decision = llmChat(system, promptHistory, observation, log)

                // 3. 失败哨兵 (AI 服务调用失败 → 反思重试)
                if (ToolCallParser.isAiFailureSentinel(decision) || decision.startsWith("[LLM")) {
                    totalErrors++
                    log.append("Step $stepCount: LLM 失败哨兵: ${decision.take(120)}\n")
                    history.add("assistant" to decision)
                    history.add("user" to "LLM 服务调用失败 (哨兵). 请重试, 或检查网络/配置。")
                    // 错误分类 → 恢复动作: auth 交人 / transient 重试
                    val cls = KernelErrorClassify.classify(decision)
                    if (cls == KernelErrorClass.AUTH) {
                        runState?.let { st -> st.fail(decision, 401); st.transition("needs_human") }
                        onStep?.invoke("⚠ API 鉴权失败 — 需人工配置 key")
                        return "NEEDS_HUMAN (API 鉴权失败: ${decision.take(80)})"
                    }
                    if (totalErrors >= 4) {
                        runState?.fail(decision)
                        onStep?.invoke("累计错误达到上限 (${totalErrors})")
                        return "FAILED: 累计错误达到上限 (steps=$stepCount)"
                    }
                    continue
                }

                // 4. 解析决策 (多格式)
                val toolCall = ToolCallParser.parse(decision)
                if (toolCall == null) {
                    runState?.recordStep("noop", true, "无法解析")
                    // 5. <final gen> 终止
                    if (ToolCallParser.isFinalResponse(decision)) {
                        val answer = ToolCallParser.extractFinalAnswer(decision)
                        val summary = answer.ifBlank { "任务完成" }
                        runState?.let { st -> st.record?.stepCount = stepCount; st.done(summary) }
                        onStep?.invoke("任务完成: $summary")
                        return "DONE: $summary (steps=$stepCount)"
                    }
                    // 6. 解析失败 → 反思
                    log.append("Step $stepCount: 决策无法解析: ${decision.take(200)}\n")
                    history.add("assistant" to decision)
                    history.add("user" to "你的上一条输出无法解析为工具调用. 请严格按 {\"tool\":\"...\",\"args\":{...}} 或 <invoke name=\"...\"> 格式, 或输出 <final gen> 结束任务。")
                    continue
                }

                // 7. 未知工具 → 提示可用集
                if (!ToolCallParser.TOOL_NAMES.contains(toolCall.name)) {
                    runState?.recordStep(toolCall.name, false, "未知工具")
                    log.append("Step $stepCount: 未知工具 ${toolCall.name}\n")
                    history.add("assistant" to decision)
                    history.add("user" to "工具 \"${toolCall.name}\" 不存在. 可用: ${ToolCallParser.TOOL_NAMES.joinToString(", ")}. 请换一个已知工具。")
                    continue
                }

                // 8. done 工具 (= <final gen>)
                if (toolCall.name == "done") {
                    val summary = toolCall.args["summary"] ?: toolCall.args["reason"] ?: "任务完成"
                    runState?.let { st -> st.record?.stepCount = stepCount; st.done(summary) }
                    onStep?.invoke("任务完成: $summary")
                    return "DONE: $summary (steps=$stepCount)"
                }

                // 9. 执行工具
                val args: Map<String, Any> = toolCall.args
                onStep?.invoke("执行工具: ${toolCall.name}")
                val result = tools.execute(toolCall.name, args)
                val success = !result.contains("\"success\":false")
                runState?.recordStep(toolCall.name, success, result.take(80))
                log.append("Step $stepCount: ${toolCall.name} → ${result.take(200)}\n")

                // 10. 同工具连续失败 → 提示换策略
                if (toolCall.name == lastTool) {
                    consecutiveFails = if (success) 0 else consecutiveFails + 1
                } else {
                    lastTool = toolCall.name
                    consecutiveFails = if (success) 0 else 1
                }
                if (!success && consecutiveFails >= sameToolFailThreshold) {
                    onStep?.invoke("⚠ 工具 ${toolCall.name} 连续失败 $consecutiveFails 次, 建议换方案")
                    history.add("assistant" to decision)
                    history.add("user" to "工具 ${toolCall.name} 已连续失败 $consecutiveFails 次, 不要再用同一个工具. 请换一个工具或策略。")
                    consecutiveFails = 0
                    continue
                }

                // 11. memory append
                history.add("assistant" to decision)
                history.add("user" to "工具结果: $result")

                runState?.checkDeadline()
            }

            // 预算闸门: 到步数上限如实结束
            runState?.let { st -> st.transition("failed"); st.record?.result = "达到最大步数 ($maxSteps), 已停止" }
            onStep?.invoke("达到最大步数 ($maxSteps), 停止")
            return "MAX_STEPS: $log"
        } catch (e: KernelModelAbortError) {
            runState?.transition("aborted")
            onStep?.invoke("已取消")
            return "ABORTED (${e.message})"
        } catch (e: KernelModelTimeoutError) {
            runState?.fail("超时", null)
            onStep?.invoke("模型调用超时")
            return "FAILED (超时: ${e.message})"
        } catch (e: KernelModelCircuitOpenError) {
            runState?.fail("熔断", null)
            return "FAILED (熔断: ${e.message})"
        } catch (e: KernelModelCapabilityError) {
            runState?.fail("缺能力", null)
            return "FAILED (缺能力: ${e.message})"
        } catch (e: Exception) {
            runState?.fail(e.message ?: "unknown")
            onStep?.invoke("Agent 异常: ${e.message}")
            return "[Agent 异常] ${e.message}"
        } finally {
            lease.release()
        }
    }

    /** LLM 调用 (经 KernelModelRuntime 的单次调用; 失败返回哨兵文本而不是抛) */
    private fun llmChat(system: String, messages: List<Pair<String, String>>, observation: String, log: StringBuilder): String {
        // 消息顺序: system 在首位, 其余按 history 顺序, 最后接观察
        val ordered = mutableListOf<Pair<String, String>>()
        ordered.add("system" to system)
        for ((role, content) in messages) ordered.add(role to content)
        ordered.add("user" to observation)
        val result = runtime.call(snapshot, KernelModelRequest(ordered, 2048, 0.2), signal)
        if (!result.ok) {
            val err = result.error ?: "unknown"
            log.append("LLM 调用失败: $err\n")
            return "[LLM 调用失败] $err"
        }
        return result.content
    }

    /** 上下文溢出保护: 超阈值截断最早历史 */
    private fun compactHistory(): List<Pair<String, String>> {
        val estimated = history.sumOf { (it.first.length + it.second.length) / 4 }
        if (estimated <= maxHistoryTokens) return history
        val keep = (history.size * 0.6).toInt().coerceAtLeast(4)
        val tail = history.takeLast(keep)
        val out = mutableListOf<Pair<String, String>>()
        out.add("user" to "[上下文已截断: 历史过长 (估算 $estimated tokens > $maxHistoryTokens), 保留最近 $keep 条。继续任务。]")
        out.addAll(tail)
        return out
    }

    /** 系统提示: 描述工具集 + 决策格式 (对齐桌面 react-loop) */
    private fun buildSystemPrompt(): String {
        return """
            你是运行在 Android 手机上的 Agent (内核版, 复刻桌面 harness)。你通过无障碍服务控制手机完成用户任务。
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
            - done: {"summary":"任务总结"} 完成任务

            输出格式 (任选其一, 不要输出其他文字):
            {"tool":"<工具名>","args":{...}}
            <invoke name="<工具名>"><parameter name="<参数>">值</parameter></invoke>

            任务完成时: 输出 "<final gen> 你的最终回答" 或 {"tool":"done","args":{"summary":"..."}} (不要再调用工具)。

            规则:
            1. 先 observe 观察屏幕, 再决定动作
            2. 每次只输出一个工具调用
            3. 工具失败换策略, 不要重复同一个失败工具
            4. 任务完成时必须显式结束 (final gen / done), 不许无理由空转
        """.trimIndent()
    }
}