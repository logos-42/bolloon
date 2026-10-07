package com.hibs.bolloon

/**
 * K8: Communication Runtime 收口 (手机原生版)
 *
 * 统一处理所有入站消息 → 一律投递到 ChannelMailbox (不直接调用 loop):
 *   Web 消息 / CLI 输入 / P2P / 手机端 / 联系人回复 / 外部唤醒 / cron / Supervisor 事件
 *
 * 删除目标: 各通道自己的重试/任务恢复/outbound 状态 (全部收敛到 Kernel).
 */
object KernelCommRuntime {

    /** 消息类型常量 */
    const val MSG_USER = "user-message"
    const val MSG_P2P = "p2p"
    const val MSG_CRON = "cron"
    const val MSG_SUPERVISOR = "supervisor"
    const val MSG_FOLLOWUP = "followup"
    const val MSG_SOCIAL = "social"
    const val MSG_PHONE = "phone"
    const val MSG_CONTACT_REPLY = "contact-reply"

    /**
     * 统一入站入口: 任何通道的消息都走这里 → mailbox.
     * 返回 false = 背压拒绝 (调用方负责重试/丢弃, 不许无限堆积).
     */
    fun deliver(kind: String, channelId: String, payload: String, source: String): Boolean {
        val ev = KernelEvent(
            kind = kind,
            channelId = channelId,
            payload = payload,
            source = source,
        )
        return KernelMailboxRegistry.enqueue(ev)
    }

    /** 快捷: 用户消息 (web/cli/phone 共用) */
    fun deliverUserMessage(channelId: String, text: String, source: String): Boolean =
        deliver(MSG_USER, channelId, text, source)

    /** 快捷: P2P 入站 (对端消息) */
    fun deliverP2P(channelId: String, payload: String, source: String = "p2p"): Boolean =
        deliver(MSG_P2P, channelId, payload, source)

    /** 快捷: cron / supervisor 事件 */
    fun deliverSystem(kind: String, channelId: String, payload: String): Boolean =
        deliver(kind, channelId, payload, "system")

    /** 统计: 每通道 pending 数 (背压/健康检查用) */
    fun pending(): Map<String, Int> = KernelMailboxRegistry.pendingCounts()
}

/**
 * K4: 唯一 Agent Loop 收敛 (手机原生版)
 *
 * KernelLoop = 唯一事实来源. 旧 AgentLoop / react-loop 只作为策略或 Adapter.
 * 这里把 KernelAgentLoop 升级为"以 KernelContext + KernelHarness 为骨架"的正式循环。
 */
class KernelLoop(
    private val runtime: KernelModelRuntime,
    private val snapshot: KernelModelSnapshot,
    private val harness: KernelHarness,
    private val ctx: KernelRunContext,
) {
    /** 取消信号 (来自 RunContext) */
    private val signal get() = ctx.signal

    /** 执行一个事件 (由 ChannelActor 调用; 同通道串行保证) */
    fun executeEvent(ev: KernelEvent): String {
        if (signal.isCancelled) return "CANCELLED"
        ctx.setGoal(ev.payload.ifBlank { "(空事件)" })
        ctx.addMessage("user", ctx.goal)
        val maxIter = 8
        var iter = 0

        while (iter < maxIter && !signal.isCancelled) {
            iter++
            // model call (经 KernelModelRuntime)
            val prompt = ctx.compactIfNeeded(16000)
            val ordered = mutableListOf<Pair<String, String>>()
            ordered.add("system" to SYSTEM_PROMPT)
            ordered.addAll(prompt)
            val result = runtime.call(snapshot, KernelModelRequest(ordered, 2048, 0.2), signal)
            if (!result.ok) {
                val err = result.error ?: "unknown"
                ctx.lastError = err
                // 错误分类: auth → needs_human (返回标记, 不空转)
                val cls = KernelErrorClassify.classify(err, result.status)
                if (cls == KernelErrorClass.AUTH) return "NEEDS_HUMAN: $err"
                continue
            }
            val decision = result.content
            ctx.streamCallback?.invoke(decision)

            // 工具调用解析
            val toolCall = ToolCallParser.parse(decision)
            if (toolCall == null) {
                if (ToolCallParser.isFinalResponse(decision)) {
                    val answer = ToolCallParser.extractFinalAnswer(decision)
                    ctx.addMessage("assistant", decision)
                    return "DONE: ${answer.ifBlank { "任务完成" }}"
                }
                ctx.addMessage("assistant", decision)
                ctx.addMessage("user", "无法解析为工具调用. 请严格按 {\"tool\":\"...\",\"args\":{...}} 或 <invoke> 格式, 或 <final gen> 结束。")
                continue
            }
            if (toolCall.name == "done") {
                val summary = toolCall.args["summary"] ?: toolCall.args["reason"] ?: "任务完成"
                return "DONE: $summary"
            }
            // 经 Harness 唯一工具门
            val toolResult = harness.invoke(toolCall.name, toolCall.args, ctx)
            if (!toolResult.ok) {
                ctx.addMessage("assistant", decision)
                ctx.addMessage("user", "工具 ${toolCall.name} 失败: ${toolResult.error}. 请换一个工具或策略。")
                continue
            }
            ctx.addMessage("assistant", decision)
            ctx.addMessage("user", "工具结果: ${toolResult.output.take(500)}")
        }
        return "MAX_STEPS (${ctx.stepCount} steps)"
    }

    companion object {
        const val SYSTEM_PROMPT = """你是运行在 Android 手机上的 Agent (Kernel 版, 桌面 harness 唯一循环).
可用工具: build_llm_context / get_interactive_elements / get_screen_tree / classify_screen / tap / swipe / type / back / home / launch_app / shell / get_device_info / list_packages / done.
输出格式: {"tool":"<工具名>","args":{...}} 或 <invoke name="...">...</invoke>; 任务完成输出 <final gen> 或 {"tool":"done","args":{"summary":"..."}}。
规则: 1) 先 observe 再动作 2) 每次一个工具 3) 失败换策略 4) 完成必须显式结束。"""
    }
}
