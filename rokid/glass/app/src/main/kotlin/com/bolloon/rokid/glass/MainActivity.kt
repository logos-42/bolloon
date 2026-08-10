package com.bolloon.rokid.glass

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

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
        root.addView(status, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(message, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(speakButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return root
    }

    private fun showMessage(text: String) {
        message.text = text
    }
}
