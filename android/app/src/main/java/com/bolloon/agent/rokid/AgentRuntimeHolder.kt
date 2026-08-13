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

    /** ModelRuntime: 远程 LLM (默认) + 本地 LLM (Phase 3, llama.cpp 后接) */
    @Volatile
    var modelRuntime: ModelRuntime? = null
        private set

    /** 无障碍服务是否已连接 */
    val isAccessibilityReady: Boolean
        get() = BolloonAccessibilityService.instance != null

    /** 初始化 (app 启动时调用, 注入 context) */
    fun init(context: Context) {
        if (modelRuntime == null) {
            modelRuntime = ModelRuntime(
                RemoteLlmBackend(llmConfig),
                LocalLlm(), // Phase 3: 模型路径后接
            )
        }
    }

    /** 配置 LLM (从手机端 UI / 默认) */
    fun configureLlm(config: AgentLlmConfig) {
        llmConfig = config
        // 重建 ModelRuntime (远程后端用新配置)
        modelRuntime = ModelRuntime(
            RemoteLlmBackend(config),
            LocalLlm(),
        )
        reset()
    }

    /** 切换本地/远程后端 */
    fun setPreferLocal(prefer: Boolean) {
        modelRuntime?.preferLocal = prefer
    }

    /** 运行 Agent 任务 (后台线程). onStep 每步回调. */
    fun runAgent(goal: String, onStep: (String) -> Unit, onDone: (String) -> Unit) {
        Thread {
            try {
                val service = BolloonAccessibilityService.instance
                    ?: run { onStep("[错误] 无障碍服务未连接, 请先在系统设置中开启 Bolloon 无障碍服务"); return@Thread }
                val t = tools ?: AndroidAgentTools(service, service.applicationContext).also { tools = it }
                val backend = modelRuntime ?: ModelRuntime(RemoteLlmBackend(llmConfig), LocalLlm()).also { modelRuntime = it }
                val l = loop ?: AgentLoop(t, backend).also { loop = it }
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
