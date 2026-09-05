package com.bolloon.agent.rokid

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * RemoteLlm — 远程 LLM 客户端 (Phase 1: Agent 在手机, LLM 远程)
 *
 * OpenAI 兼容 API (baseUrl + apiKey + model):
 *   - chat(messages) → reply
 *   - 配置: AgentLlmConfig (手机端 UI 配置, 默认走 bolloon 的 provider)
 */
data class AgentLlmConfig(
    val baseUrl: String = "https://api.deepseek.com/v1",
    val apiKey: String = "",
    val model: String = "deepseek-chat",
    val maxTokens: Int = 4096,
)

class RemoteLlm(private val config: AgentLlmConfig) {

    /** 聊天: messages = [{role, content}] → reply text */
    fun chat(system: String, messages: List<Pair<String, String>>, maxTokens: Int = config.maxTokens): String {
        val url = URL(config.baseUrl.trimEnd('/') + "/chat/completions")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer ${config.apiKey}")
            conn.doOutput = true
            conn.connectTimeout = 15000
            conn.readTimeout = 40000

            val msgs = JSONArray()
            msgs.put(JSONObject().put("role", "system").put("content", system))
            for ((role, content) in messages) {
                msgs.put(JSONObject().put("role", role).put("content", content))
            }
            val body = JSONObject()
                .put("model", config.model)
                .put("messages", msgs)
                .put("max_tokens", maxTokens)
                .put("temperature", 0.2)

            conn.outputStream.use { it.write(body.toString().toByteArray()) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = BufferedReader(InputStreamReader(stream)).use { it.readText() }

            if (code !in 200..299) {
                return "[LLM 错误 $code] ${text.take(300)}"
            }
            val resp = JSONObject(text)
            val reply = resp.optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content", "")
                ?: ""
            return reply.trim()
        } catch (e: Exception) {
            return "[LLM 调用失败] ${e.message}"
        } finally {
            conn.disconnect()
        }
    }
}
