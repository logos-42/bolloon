package com.bolloon.rokid.glass

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity() {
    private val adapter: RokidGlassesAdapter = MockRokidGlassesAdapter()
    private lateinit var status: TextView
    private lateinit var message: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.decorView.systemUiVisibility = 5894
        setContentView(buildView())
        adapter.onMessage { incoming -> runOnUiThread { showMessage(incoming.text) } }
        adapter.onSpeech { spoken -> runOnUiThread { showMessage("语音：$spoken") } }
        adapter.connect(
            onConnected = { id -> runOnUiThread { status.text = "已连接 · $id · ${adapter.mode}" } },
            onError = { error -> runOnUiThread { status.text = "连接失败：${error.message}" } },
        )
    }

    override fun onDestroy() {
        adapter.disconnect()
        super.onDestroy()
    }

    /** 2026-10-05 (P9): 从本机 World API 拉一条机会 → 眼镜 1 秒瞬时提示 */
    private fun fetchWorldOpportunity() {
        Thread {
            try {
                val url = URL("http://127.0.0.1:54188/api/opportunities?min-score=0.2&limit=1")
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                val body = conn.inputStream.bufferedReader().use { it.readText() }
                val root = JSONObject(body)
                val list = root.optJSONArray("opportunities")
                if (list != null && list.length() > 0) {
                    val first = list.getJSONObject(0)
                    val opp = GlassOpportunity(
                        title = first.optString("title", "世界变化"),
                        summary = first.optString("summary", ""),
                        matchPercent = (first.optDouble("score", 0.0) * 100).toInt(),
                        sourceId = first.optString("id", ""),
                    )
                    runOnUiThread {
                        showMessage("✦ ${opp.title} · ${opp.matchPercent}%")
                        status.text = "眼镜看见机会: ${opp.sourceId}"
                    }
                    adapter.showOpportunity(opp)
                } else {
                    runOnUiThread { status.text = "世界暂时没有机会 (服务未启动?)" }
                }
            } catch (e: Exception) {
                runOnUiThread { status.text = "拉机会失败: ${e.message ?: e.javaClass.simpleName}" }
            }
        }.start()
    }

    private fun buildView(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(56, 32, 56, 32)
            setBackgroundColor(Color.BLACK)
        }
        status = TextView(this).apply {
            text = "正在连接 Rokid…"
            textSize = 18f
            setTextColor(Color.LTGRAY)
            gravity = Gravity.CENTER
        }
        message = TextView(this).apply {
            text = "等待 Bolloon 消息"
            textSize = 34f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(0, 24, 0, 24)
        }
        val speakButton = Button(this).apply {
            text = "播报测试"
            setOnClickListener { adapter.speak("这是 Bolloon 的 Rokid 测试消息") }
        }
        val worldButton = Button(this).apply {
            text = "世界机会"
            setOnClickListener { fetchWorldOpportunity() }
        }
        root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(speakButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(worldButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return root
    }

    private fun showMessage(text: String) {
        message.text = text
    }
}
