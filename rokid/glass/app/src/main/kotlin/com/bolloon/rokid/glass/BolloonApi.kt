package com.bolloon.rokid.glass

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64

/**
 * Bolloon 本机节点 HTTP 客户端。
 *
 * 眼镜端裸机开发（YodaOS-Sprite / AOSP）没有 Rokid 系统服务可用，
 * 所以眼镜只负责「看 + 说 + 按键」，所有智能/网络能力走本机 bolloon 节点：
 *   - 节点跑在眼镜上     → BASE = http://127.0.0.1:54188
 *   - 节点跑在开发机     → 先 `adb reverse tcp:54188 tcp:54188`，地址同上
 *
 * 只走明文回环（network_security_config.xml 只对 127.0.0.1 / localhost 放开）。
 */
object BolloonApi {
    const val BASE = "http://127.0.0.1:54188"

    data class Opportunity(val title: String, val summary: String, val score: Double)
    data class Agent(val id: String, val name: String)
    data class Wallet(
        val ok: Boolean,
        val address: String,
        val network: String,
        val eth: Double,
        val usdc: Double,
        val error: String,
    )
    data class Task(val id: String, val capability: String, val claimed: Boolean, val claimer: String)
    data class Message(val role: String, val content: String)

    private fun open(path: String, method: String = "GET", body: ByteArray? = null, contentType: String? = null): HttpURLConnection {
        val conn = URL("$BASE$path").openConnection() as HttpURLConnection
        conn.requestMethod = method
        conn.connectTimeout = 4000
        conn.readTimeout = 30000
        if (body != null) {
            conn.doOutput = true
            contentType?.let { conn.setRequestProperty("Content-Type", it) }
            conn.outputStream.use { it.write(body) }
        }
        return conn
    }

    private fun readText(conn: HttpURLConnection): String {
        val code = conn.responseCode
        val stream = if (code in 200..299) conn.inputStream else conn.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) error("HTTP $code $text".trim())
        return text
    }

    /** GET /api/opportunities → 世界机会列表 */
    fun opportunities(limit: Int = 8): List<Opportunity> {
        val body = readText(open("/api/opportunities?min-score=0.2&limit=$limit"))
        val arr = JSONObject(body).optJSONArray("opportunities") ?: return emptyList()
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Opportunity(
                title = o.optString("title", "世界变化"),
                summary = o.optString("summary", ""),
                score = o.optDouble("score", 0.0),
            )
        }
    }

    /** GET /api/contacts → 可对话的智能体（好友 + 目录联系人） */
    fun agents(): List<Agent> {
        val body = readText(open("/api/contacts"))
        val items = JSONObject(body).optJSONArray("items") ?: return emptyList()
        val out = ArrayList<Agent>()
        for (i in 0 until items.length()) {
            val o = items.getJSONObject(i)
            val did = o.optString("did", o.optString("id", ""))
            val name = o.optString("name", did.take(12))
            if (did.isNotEmpty()) out.add(Agent(did, name))
        }
        return out
    }

    /** GET /api/wallet → 链上地址 + 余额（节点侧真实 RPC） */
    fun wallet(): Wallet = try {
        val j = JSONObject(readText(open("/api/wallet")))
        Wallet(
            ok = j.optBoolean("ok", false),
            address = j.optString("address", ""),
            network = j.optString("network", ""),
            eth = j.optDouble("eth", 0.0),
            usdc = j.optDouble("usdc", 0.0),
            error = j.optString("error", ""),
        )
    } catch (e: Exception) {
        Wallet(false, "", "", 0.0, 0.0, e.message ?: "钱包不可用")
    }

    /** GET /api/tasks → 执行工作（任务板） */
    fun tasks(): List<Task> = try {
        val j = JSONObject(readText(open("/api/tasks")))
        val arr = j.optJSONArray("tasks") ?: j.optJSONArray("items") ?: return emptyList()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Task(
                id = o.optString("id", ""),
                capability = o.optString("capability", ""),
                claimed = o.optBoolean("claimed", false),
                claimer = o.optString("claimer", ""),
            )
        }
    } catch (e: Exception) {
        emptyList()
    }

    /** GET /api/bootstrap → 最近交流（运行期消息流，取最新 limit 条） */
    fun messages(limit: Int = 5): List<Message> = try {
        val j = JSONObject(readText(open("/api/bootstrap")))
        val arr = j.optJSONObject("state")?.optJSONArray("messages")
            ?: j.optJSONArray("messages")
        if (arr == null) emptyList() else {
            val all = (0 until arr.length()).map { i ->
                val o = arr.getJSONObject(i)
                Message(o.optString("role", "?"), o.optString("content", ""))
            }
            all.takeLast(limit).reversed()
        }
    } catch (e: Exception) {
        emptyList()
    }

    /** GET /api/auth/requests → 需要人点头的授权/支付确认 */
    fun pendingAuth(): Int = try {
        val j = JSONObject(readText(open("/api/auth/requests")))
        j.optJSONArray("requests")?.length() ?: 0
    } catch (e: Exception) {
        0
    }

    /** POST /api/chat {message, agent_id} → 回复文本 */
    fun chat(message: String, agentId: String?): String {
        val payload = JSONObject().apply {
            put("message", message)
            if (!agentId.isNullOrEmpty()) put("agent_id", agentId)
        }.toString().toByteArray()
        val reply = readText(open("/api/chat", "POST", payload, "application/json"))
        return JSONObject(reply).optString("reply", "").ifBlank { "(空回复)" }
    }

    /** POST /api/asr 原始 WAV 字节 → 识别文本 */
    fun asr(wav: ByteArray): String {
        val body = readText(open("/api/asr", "POST", wav, "audio/wav"))
        return JSONObject(body).optString("text", "").trim()
    }

    /** POST /api/vision {image_base64} → {ok,text,intent,hint} */
    fun vision(jpeg: ByteArray): JSONObject {
        val b64 = Base64.getEncoder().encodeToString(jpeg)
        val payload = JSONObject().apply { put("image_base64", b64) }.toString().toByteArray()
        return JSONObject(readText(open("/api/vision", "POST", payload, "application/json")))
    }

    /** GET /api/bootstrap → 本机「我的智能体」 */
    fun myAgents(): List<Agent> = try {
        val j = JSONObject(readText(open("/api/bootstrap")))
        val arr = j.optJSONObject("state")?.optJSONArray("agents") ?: j.optJSONArray("agents")
        if (arr == null) emptyList() else (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Agent(o.optString("id", ""), o.optString("name", "智能体"))
        }.filter { it.id.isNotEmpty() }
    } catch (e: Exception) {
        emptyList()
    }

    data class Group(val id: String, val name: String, val acl: String)

    /** GET /api/groups → 本地群 + 含外部智能体的群 */
    fun groups(): List<Group> = try {
        val j = JSONObject(readText(open("/api/groups")))
        val arr = j.optJSONArray("groups") ?: return emptyList()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Group(o.optString("id", ""), o.optString("name", "群组"), o.optString("acl", ""))
        }.filter { it.id.isNotEmpty() }
    } catch (e: Exception) {
        emptyList()
    }

    /** GET /api/groups/{id}/messages → 群消息（最新 limit 条） */
    fun groupMessages(id: String, limit: Int = 8): List<Message> = try {
        val j = JSONObject(readText(open("/api/groups/$id/messages?limit=$limit")))
        val arr = j.optJSONArray("messages") ?: j.optJSONArray("items") ?: return emptyList()
        (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            Message(o.optString("from", o.optString("sender", "?")), o.optString("content", ""))
        }
    } catch (e: Exception) {
        emptyList()
    }

    /** POST /api/groups/{id}/say {text} → 群里发一句 */
    fun groupSay(id: String, text: String): Boolean = try {
        val payload = JSONObject().apply { put("text", text) }.toString().toByteArray()
        readText(open("/api/groups/$id/say", "POST", payload, "application/json"))
        true
    } catch (e: Exception) {
        false
    }

    /** POST /api/agents/ping {id, seconds} → 固定 ping */
    fun setPing(agentId: String, seconds: Int): Boolean = try {
        val payload = JSONObject().apply {
            put("id", agentId)
            put("seconds", seconds)
        }.toString().toByteArray()
        val body = readText(open("/api/agents/ping", "POST", payload, "application/json"))
        !JSONObject(body).has("error")
    } catch (e: Exception) {
        false
    }

    data class Profile(
        val id: String,
        val name: String,
        val did: String,
        val didShort: String,
        val soul: String,
        val soulSet: Boolean,
        val agentDoc: String,
        val agentDocSet: Boolean,
    )

    /** GET /api/agents/{id}/profile → DID 缩写 + soul 介绍 + 功能简介 */
    fun agentProfile(id: String): Profile? = try {
        val j = JSONObject(readText(open("/api/agents/$id/profile")))
        if (!j.optBoolean("ok", false)) null
        else Profile(
            id = j.optString("id", id),
            name = j.optString("name", ""),
            did = j.optString("did", ""),
            didShort = j.optString("did_short", ""),
            soul = j.optString("soul", ""),
            soulSet = j.optBoolean("soul_set", false),
            agentDoc = j.optString("agent_doc", ""),
            agentDocSet = j.optBoolean("agent_doc_set", false),
        )
    } catch (e: Exception) {
        null
    }


    data class Phone(val bound: Boolean, val phone: String, val identityMatch: Boolean)

    /** GET /api/phone → 手机号绑定状态（绑定是 DID 签名，不是短信） */
    fun phone(): Phone = try {
        val j = JSONObject(readText(open("/api/phone")))
        Phone(
            bound = j.optBoolean("bound", false),
            phone = j.optString("phone", ""),
            identityMatch = j.optBoolean("identity_match", false),
        )
    } catch (e: Exception) {
        Phone(false, "", false)
    }


    /** 打开即探测桌面节点：HTTP 是否通 + QUIC 直连端点是否在 */
    fun probe(): String {
        return try {
            val h = JSONObject(readText(open("/api/health")))
            val ver = h.optString("version", "?")
            val q = runCatching { JSONObject(readText(open("/api/quic/addr"))) }.getOrNull()
            val addr = q?.optString("addr", "").orEmpty()
            if (q?.optBoolean("ok", false) == true && addr.isNotEmpty())
                "已连桌面 · HTTP v$ver · QUIC $addr"
            else
                "已连桌面 · HTTP v$ver"
        } catch (e: Exception) {
            "未连桌面 · 检查 adb reverse 54188 / 同一网络"
        }
    }

    fun health(): String = try {
        val json = JSONObject(readText(open("/api/friends")))
        "节点在线 · 好友 ${json.optJSONArray("friends")?.length() ?: 0}"
    } catch (e: Exception) {
        "节点离线：${e.message ?: e.javaClass.simpleName}"
    }
}
