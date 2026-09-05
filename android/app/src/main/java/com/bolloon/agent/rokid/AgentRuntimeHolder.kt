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

    /** Phase 4: Agent 生命周期管理 (Hermes subagent_lifecycle 模式) */
    val lifecycle = AgentLifecycleManager()

    /** Phase 4: 审计日志 */
    @Volatile
    var audit: AgentAuditLog? = null

    /** 2026-08-13 (借鉴 Ghost): 宏录制/重放 */
    @Volatile
    var macro: MacroRecorder? = null
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
        if (audit == null) {
            audit = AgentAuditLog(context)
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
                    ?: run {
                        val m = "[错误] 无障碍服务未连接, 请先在系统设置中开启 Bolloon 无障碍服务"
                        onStep(m); onDone(m)  // 必须调用 onDone, 否则 JS runAgent 的 promise 永不 resolve → 一直转圈
                        return@Thread
                    }
                // 2026-09-05: 未配置 LLM API → 提示, 不空转 (否则 RemoteLlm 发空 Bearer → 401 → 哨兵未命中 → 死循环)
                if (llmConfig.apiKey.isBlank() || llmConfig.baseUrl.isBlank()) {
                    onStep("[提示] 未配置 LLM API, 无法执行 Agent")
                    onDone("[未配置 LLM API] 请到「我 → 设置 → API 配置」填入供应商 baseUrl/apiKey, 或从桌面同步 LLM 配置后重试。")
                    return@Thread
                }
                val t = tools ?: AndroidAgentTools(service, service.applicationContext).also { tools = it }
                val backend = modelRuntime ?: ModelRuntime(RemoteLlmBackend(llmConfig), LocalLlm()).also { modelRuntime = it }
                // Phase 4: 生命周期开始 (STARTING → RUNNING)
                val agentId = lifecycle.start(goal)
                lifecycle.markRunning()
                // 每次新建 AgentLoop (history 隔离, 不跨任务串)
                val l = AgentLoop(t, backend)
                loop = l
                l.lifecycle = lifecycle
                l.audit = audit
                l.agentId = agentId
                l.onStep = { onStep(it) }
                val result = l.run(goal)
                onDone(result)
            } catch (e: Exception) {
                lifecycle.fail(e.message ?: "unknown")
                onDone("[Agent 异常] ${e.message}")
            }
        }.start()
    }

    /** 请求取消当前 Agent 任务 (两段式: CANCEL_REQUESTED) */
    fun cancelAgent(reason: String = "用户取消"): Boolean = lifecycle.requestCancel(reason)

    /** Agent 状态 (供 UI) */
    fun agentStatusJson(): String {
        val rec = lifecycle.currentRecord()
        return "{\"state\":\"${lifecycle.state()}\",\"agentId\":\"${rec?.id ?: ""}\",\"goal\":\"${rec?.goal ?: ""}\",\"terminal\":${lifecycle.state().isTerminal}}"
    }

    /** 重置 (配置变化时) */
    fun reset() {
        loop = null
    }

    /** 获取宏录制器 (service 连接后可用; 懒建) */
    fun macroRecorder(): MacroRecorder? {
        val service = BolloonAccessibilityService.instance ?: return null
        if (macro == null) {
            macro = MacroRecorder(AndroidAgentTools(service, service.applicationContext))
        }
        return macro
    }
}
