package com.hibs.bolloon

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL

/**
 * KernelRemoteLlmConnection — 远程 LLM 连接 (适配 KernelModelConnection 接口)
 *
 * 供 KernelModelRuntime 使用: 连接池按 snapshot (provider::model::baseUrl) 复用。
 * 内部复用 RemoteLlm 的 HTTP 调用 (OpenAI 兼容 /v1/chat/completions)。
 */
class KernelRemoteLlmConnection(
    private val snapshot: KernelModelSnapshot,
    private val apiKey: String,
) : KernelModelConnection {

    override val id: String = "conn-${snapshot.provider}-${snapshot.model}-${System.currentTimeMillis()}-${counter++}"

    override fun call(req: KernelModelRequest, timeoutMs: Long): KernelModelResult {
        val base = snapshot.baseUrl ?: return KernelModelResult(ok = false, error = "baseUrl 缺失", provider = snapshot.provider)
        val url = URL(base.trimEnd('/') + "/chat/completions")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $apiKey")
            conn.doOutput = true
            conn.connectTimeout = 15_000
            conn.readTimeout = timeoutMs.coerceAtLeast(5_000).coerceAtMost(60_000).toInt()

            val msgs = JSONArray()
            for ((role, content) in req.messages) {
                msgs.put(JSONObject().put("role", role).put("content", content))
            }
            val body = JSONObject()
                .put("model", snapshot.model)
                .put("messages", msgs)
                .put("max_tokens", req.maxTokens)
                .put("temperature", req.temperature)

            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = BufferedReader(InputStreamReader(stream)).use { it.readText() }
            if (code !in 200..299) {
                return KernelModelResult(ok = false, provider = snapshot.provider, error = "HTTP $code: ${text.take(300)}", status = code)
            }
            val resp = JSONObject(text)
            val reply = resp.optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content", "")
                ?: ""
            return KernelModelResult(ok = true, provider = snapshot.provider, content = reply.trim(), status = code)
        } catch (e: Exception) {
            val isTimeout = e is java.net.SocketTimeoutException || (e.message ?: "").contains("timeout")
            return if (isTimeout) {
                KernelModelResult(ok = false, provider = snapshot.provider, error = "连接超时: ${e.message}", status = null)
            } else {
                KernelModelResult(ok = false, provider = snapshot.provider, error = "连接失败: ${e.message}", status = null)
            }
        } finally {
            conn.disconnect()
        }
    }

    override fun close() { /* HttpURLConnection 无持久资源; 无操作 */ }

    companion object { private var counter = 0L }
}
