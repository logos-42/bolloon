package com.bolloon.agent.rokid

import android.content.Context

/**
 * AgentRuntimeHolder — Android Agent Runtime 单例持有器 (Phase 1)
 *
 * 组装: AccessibilityService (眼睛/手) + AndroidAgentTools + RemoteLlm + AgentLoop。
 * 供 UI (Capacitor bridge / 原生入口) 调用 runAgent(goal)。
 */
object AgentRuntimeHolder {

    @Volatile
    private var tools: AndroidAgentTools? = null

    @Volatile
    private var loop: AgentLoop? = null

    @Volatile
    var llmConfig: AgentLlmConfig = AgentLlmConfig()
        private set

    /** 无障碍服务是否已连接 */
    val isAccessibilityReady: Boolean
        get() = BolloonAccessibilityService.instance != null

    /** 初始化 (app 启动时调用, 注入 context) */
    fun init(context: Context) {
        // 懒构建, service 连接后 tools 才能工作
    }

    /** 配置 LLM (从手机端 UI / 默认) */
    fun configureLlm(config: AgentLlmConfig) {
        llmConfig = config
    }

    /** 运行 Agent 任务 (后台线程). onStep 每步回调. */
    fun runAgent(goal: String, onStep: (String) -> Unit, onDone: (String) -> Unit) {
        Thread {
            try {
                val service = BolloonAccessibilityService.instance
                    ?: run { onStep("[错误] 无障碍服务未连接, 请先在系统设置中开启 Bolloon 无障碍服务"); return@Thread }
                val t = tools ?: AndroidAgentTools(service, service.applicationContext).also { tools = it }
                val l = loop ?: AgentLoop(t, RemoteLlm(llmConfig)).also { loop = it }
                l.onStep = { onStep(it) }
                val result = l.run(goal)
                onDone(result)
            } catch (e: Exception) {
                onDone("[Agent 异常] ${e.message}")
            }
        }.start()
    }

    /** 重置 (配置变化时) */
    fun reset() {
        loop = null
    }
}
