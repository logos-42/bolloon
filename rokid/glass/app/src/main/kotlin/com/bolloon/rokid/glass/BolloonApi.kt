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
    data class Message(val role: String, val content: String, val name: String? = null)

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
                Message(
                    o.optString("role", "?"),
                    o.optString("content", ""),
                    if (o.isNull("name")) null else o.optString("name", "").ifBlank { null },
                )
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


    /** POST /api/intent/observe → 意图落 OrbitDB(intent-stream)，给群聊内部智能体当输入 */
    fun observeIntent(intent: String, confidence: Double, reason: String, text: String): Boolean = try {
        val payload = JSONObject()
            .put("intent", intent)
            .put("confidence", confidence)
            .put("reason", reason)
            .put("text", text.take(200))
            .put("source", "glass-widget")
            .toString().toByteArray()
        val body = readText(open("/api/intent/observe", "POST", payload, "application/json"))
        JSONObject(body).optBoolean("ok", false)
    } catch (e: Exception) {
        false
    }


    data class Llm(val provider: String, val model: String, val keyOk: Boolean)

    /** GET /api/models → 当前 provider/model（与 CLI/桌面同一份配置） */
    fun models(): Llm = try {
        val j = JSONObject(readText(open("/api/models")))
        val active = j.optString("active", "")
        val model = j.optString("active_model", "")
        var keyOk = false
        j.optJSONArray("providers")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                if (o.optString("name") == active) keyOk = o.optBoolean("has_key", false)
            }
        }
        Llm(active, model, keyOk)
    } catch (e: Exception) {
        Llm("", "", false)
    }

    /**
     * 手机号登录 = 先取挑战再验签（nonce 一次性，不能复用）。
     * POST /api/phone/challenge → POST /api/phone/login（节点用 DID 私钥签名）
     */
    fun login(): Pair<Boolean, String> = try {
        // ① 取新挑战（旧挑战用过就废，必须每次新取）
        readText(open("/api/phone/challenge", "POST", "{}".toByteArray(), "application/json"))
        // ② 拿挑战去登录
        val body = readText(open("/api/phone/login", "POST", "{}".toByteArray(), "application/json"))
        val j = JSONObject(body)
        j.optBoolean("ok", false) to j.optString("reason", j.optString("error", ""))
    } catch (e: Exception) {
        false to (e.message ?: "网络错误")
    }


    data class Turn(val role: String, val name: String?, val content: String)

    /** GET /api/turns?since=N → (新总数, 增量轮次) —— 桌面/CLI 的对话流 */
    fun turns(since: Int): Pair<Int, List<Turn>> = try {
        val j = JSONObject(readText(open("/api/turns?since=$since")))
        val total = j.optInt("total", since)
        val out = ArrayList<Turn>()
        j.optJSONArray("turns")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                out.add(
                    Turn(
                        o.optString("role", ""),
                        if (o.isNull("name") || o.optString("name", "").isBlank()) null else o.optString("name", ""),
                        o.optString("content", ""),
                    )
                )
            }
        }
        total to out
    } catch (e: Exception) {
        0 to emptyList<Turn>()
    }


    /** 全部历史（/api/turns?since=0）—— bootstrap 只给最近几条，看老记录要靠这个 */
    fun history(): List<Message> = try {
        val j = JSONObject(readText(open("/api/turns?since=0")))
        val out = ArrayList<Message>()
        j.optJSONArray("turns")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                out.add(
                    Message(
                        o.optString("role", ""),
                        o.optString("content", ""),
                        if (o.isNull("name") || o.optString("name", "").isBlank()) null else o.optString("name", ""),
                    )
                )
            }
        }
        out
    } catch (e: Exception) {
        emptyList()
    }

    fun health(): String = try {
        val json = JSONObject(readText(open("/api/friends")))
        "节点在线 · 好友 ${json.optJSONArray("friends")?.length() ?: 0}"
    } catch (e: Exception) {
        "节点离线：${e.message ?: e.javaClass.simpleName}"
    }

    // ───────────────── 登录（/api/auth/**）─────────────────
    // 两条路：① 眼镜扫电脑/手机屏幕上的二维码；② 眼镜出 6 位码，手机/电脑输入授权。
    // 令牌是本机节点 DID 签的，会话校验放节点侧（眼镜只存字符串）。

    data class DeviceCode(val code: String, val expiresInMs: Long)

    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8")

    /** 眼镜自己出一张码（显示在镜片上，等手机/电脑输入授权） */
    fun deviceCode(): DeviceCode? = try {
        val j = JSONObject(readText(open("/api/auth/device-code")))
        if (!j.optBoolean("ok", false)) null
        else DeviceCode(j.optString("code", ""), j.optLong("expires_in_ms", 0L))
    } catch (e: Exception) {
        null
    }

    /** 那张码被授权/被用掉了吗 → (approved, used, 剩余毫秒) */
    fun loginStatus(code: String): Triple<Boolean, Boolean, Long> = try {
        val j = JSONObject(readText(open("/api/auth/qr/status?code=${enc(code)}")))
        if (!j.optBoolean("ok", false)) Triple(false, false, 0L)
        else Triple(
            j.optBoolean("approved", false),
            j.optBoolean("used", false),
            j.optLong("expires_in_ms", 0L),
        )
    } catch (e: Exception) {
        Triple(false, false, 0L)
    }

    /** 用码换令牌 → (token, 错误) */
    fun claim(code: String): Pair<String, String> = try {
        val body = JSONObject().put("code", code).toString().toByteArray()
        val j = JSONObject(readText(open("/api/auth/qr/claim", "POST", body, "application/json")))
        if (j.optBoolean("ok", false)) j.optString("token", "") to ""
        else "" to j.optString("error", "兑换失败")
    } catch (e: Exception) {
        "" to (e.message ?: "网络错误")
    }

    /** 拍到的画面交给节点解二维码 → (码, 错误) */
    fun scanQr(jpeg: ByteArray): Pair<String, String> = try {
        val b64 = Base64.getEncoder().encodeToString(jpeg)
        val body = JSONObject().put("image_base64", b64).toString().toByteArray()
        val j = JSONObject(readText(open("/api/auth/qr/scan", "POST", body, "application/json")))
        if (j.optBoolean("ok", false)) j.optString("code", "") to ""
        else "" to j.optString("error", "没扫到码")
    } catch (e: Exception) {
        "" to (e.message ?: "网络错误")
    }

    /** 令牌还有效吗（节点用自己的公钥验签） */
    fun sessionOk(token: String): Boolean = try {
        val j = JSONObject(readText(open("/api/auth/session?token=${enc(token)}")))
        j.optBoolean("ok", false)
    } catch (e: Exception) {
        false
    }
}
