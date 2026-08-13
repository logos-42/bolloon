package com.bolloon.agent.rokid

/**
 * LlmBackend — LLM 后端抽象 (Phase 3)
 *
 * Agent 的 LLM 可来自:
 *   - RemoteLlm: 远程 API (Phase 1, 已实现)
 *   - LocalLlm:  手机本地 GGUF (Phase 3, llama.cpp android 源码集成 — 骨架)
 */
interface LlmBackend {
    /** 是否可用 */
    fun isAvailable(): Boolean

    /** 聊天: messages = [{role, content}] → reply text */
    fun chat(system: String, messages: List<Pair<String, String>>): String

    /** 后端名称 */
    fun name(): String
}

/** RemoteLlm 适配为 LlmBackend */
class RemoteLlmBackend(private val config: AgentLlmConfig) : LlmBackend {
    private val llm = RemoteLlm(config)
    override fun isAvailable() = config.apiKey.isNotBlank()
    override fun chat(system: String, messages: List<Pair<String, String>>) = llm.chat(system, messages)
    override fun name() = "remote:${config.model}"
}

/**
 * LocalLlm — 本地 GGUF 推理 (Phase 3 骨架)
 *
 * 真实推理依赖 llama.cpp android 源码集成 (examples/llama.android) + GGUF 模型文件.
 * 此骨架提供接口与模型路径管理; llama.cpp JNI 调用由后续独立工程接入.
 *
 * 模型约定: 放入 app 内部存储 /models/ (agent 首次使用时提示下载).
 */
class LocalLlm(
    private val modelPath: String = "",
    private val contextSize: Int = 2048,
) : LlmBackend {

    override fun isAvailable(): Boolean {
        // 骨架: 模型文件存在且非空才算可用 (llama.cpp JNI 集成后加载)
        return modelPath.isNotBlank()
    }

    override fun chat(system: String, messages: List<Pair<String, String>>): String {
        if (!isAvailable()) return "[本地 LLM 不可用] 未加载 GGUF 模型 (需要 llama.cpp android 集成 + 模型文件)"
        // TODO(Phase 3): llama.cpp JNI 推理 (LlmChatSession / LlmModel)
        return "[本地 LLM 推理] 骨架未接入 llama.cpp JNI — system=${system.take(60)}..., messages=${messages.size}"
    }

    override fun name() = "local:${modelPath.substringAfterLast('/')}"
}

/** ModelRuntime — 后端选择器 (远程/本地切换) */
class ModelRuntime(
    private val remote: LlmBackend,
    private val local: LlmBackend,
) : LlmBackend {
    @Volatile
    var preferLocal = false

    override fun isAvailable(): Boolean = current().isAvailable()
    override fun chat(system: String, messages: List<Pair<String, String>>): String =
        current().chat(system, messages)
    override fun name(): String = current().name()

    fun current(): LlmBackend = if (preferLocal && local.isAvailable()) local else remote
}
