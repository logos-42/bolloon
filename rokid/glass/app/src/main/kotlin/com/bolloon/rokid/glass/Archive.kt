package com.bolloon.rokid.glass

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 判断力决策 / 意图 的自动存档。
 *
 * 两份，缺一不可（leo 2026-10-28：手机和电脑各一个专门目录）：
 * 1. **手机（眼镜）目录**：`/sdcard/Android/data/com.bolloon.rokid.glass/files/archive/<kind>/YYYY-MM-DD.jsonl`
 *    （`getExternalFilesDir`，adb / 文件管理器可直接看，卸载即清）
 * 2. **电脑目录**：POST `/api/archive` → 节点写 `~/.bolloon/rust/archive/<kind>/YYYY-MM-DD.jsonl`；
 *    带 `agent_id` 时节点还会同时落一份到 `~/.bolloon/rust/agents/<id>/archive/...`（= 交给智能体存档）
 *
 * 只追加不改写；网络失败不影响本地那份（先写本地，再尽力上报）。
 */
object Archive {
    const val KIND_JUDGMENT = "judgment"
    const val KIND_INTENT = "intent"

    fun localDir(ctx: Context, kind: String): File {
        val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
        return File(base, "archive/${if (kind == KIND_INTENT) "intents" else "judgment"}").apply { mkdirs() }
    }

    private fun day(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    /** 本地追加一行；返回写到的文件（失败返回 null） */
    fun appendLocal(ctx: Context, kind: String, payload: JSONObject): File? {
        return try {
            val f = File(localDir(ctx, kind), "${day()}.jsonl")
            val line = JSONObject()
                .put("ts", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US).format(Date()))
                .put("ts_ms", System.currentTimeMillis())
                .put("kind", kind)
                .put("device", "rokid-glasses")
                .apply {
                    val it = payload.keys()
                    while (it.hasNext()) {
                        val k = it.next()
                        put(k, payload.get(k))
                    }
                }
                .toString()
            f.appendText(line + "\n")
            f
        } catch (e: Exception) {
            null
        }
    }

    /**
     * 存档一条：先写本机目录，再尽力上报节点（后台线程调用）。
     * @return 本机文件路径（便于界面上如实显示存到哪了）
     */
    fun record(ctx: Context, kind: String, source: String, agentId: String?, payload: JSONObject): String? {
        val local = appendLocal(ctx, kind, payload)
        // 上报必须离开主线程：Android 主线程发 HTTP 会 NetworkOnMainThreadException
        Thread {
            try {
                val body = JSONObject()
                    .put("kind", kind)
                    .put("source", source)
                    .put("agent_id", agentId ?: "")
                    .put("payload", payload)
                    .toString().toByteArray()
                val conn = java.net.URL("${BolloonApi.BASE}/api/archive").openConnection() as java.net.HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 3000
                conn.readTimeout = 5000
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.outputStream.use { it.write(body) }
                conn.responseCode
            } catch (_: Exception) {
                // 节点不在也照样留了本机那份
            }
        }.start()
        return local?.absolutePath
    }
}
