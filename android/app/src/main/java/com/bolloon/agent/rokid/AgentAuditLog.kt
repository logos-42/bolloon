package com.bolloon.agent.rokid

import android.content.Context
import java.io.File

/**
 * AgentAuditLog — Agent 动作审计日志 (Phase 4)
 *
 * append-only 审计: 每个 Agent 动作 (工具调用/状态迁移/取消) 记录一条,
 * 落盘 app 内部存储 audit/ 目录. 供审计/回溯 (Hermes audit 设计).
 *
 * 格式: 每行 JSON: {ts, agentId, step, action, detail, result}
 */
class AgentAuditLog(context: Context, maxEntries: Int = 2000) {

    private val dir = File(context.filesDir, "audit").apply { mkdirs() }
    private val file = File(dir, "agent-audit.jsonl")
    private val maxEntries = maxEntries

    @Synchronized
    fun append(agentId: String, step: Int, action: String, detail: String, result: String = "") {
        try {
            val line = buildString {
                append("{\"ts\":").append(System.currentTimeMillis())
                append(",\"agent\":\"").append(escape(agentId))
                append("\",\"step\":").append(step)
                append(",\"action\":\"").append(escape(action))
                append("\",\"detail\":\"").append(escape(detail.take(500)))
                append("\",\"result\":\"").append(escape(result.take(300)))
                append("\"}\n")
            }
            // 截断: 超 maxEntries 时重写只保留后半
            if (file.length() > maxEntries * 300L) {
                val tail = file.readLines().takeLast(maxEntries / 2).joinToString("\n") + "\n"
                file.writeText(tail)
            }
            file.appendText(line)
        } catch (e: Exception) {
            // 审计失败静默 (不阻塞 Agent)
        }
    }

    /** 读取最近 N 条审计 */
    fun recent(n: Int = 20): List<String> {
        return try {
            file.readLines().takeLast(n)
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun escape(s: String): String {
        return s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ")
    }
}
