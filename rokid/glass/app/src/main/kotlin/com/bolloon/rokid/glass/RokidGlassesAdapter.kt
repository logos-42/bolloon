package com.bolloon.rokid.glass

data class GlassMessage(
    val text: String,
    val channelId: String? = null,
    val timestamp: String = java.time.Instant.now().toString(),
)

data class GlassDeviceState(
    val batteryPercent: Int? = null,
    val wearing: Boolean? = null,
    val microphoneMuted: Boolean? = null,
)

/** 眼镜端看到的世界机会 (来自 World API /api/opportunities 或观察日志) */
data class GlassOpportunity(
    val title: String,
    val summary: String = "",
    val matchPercent: Int = 0,
    val sourceId: String = "",
)

interface RokidGlassesAdapter {
    val mode: String
    fun connect(onConnected: (String) -> Unit, onError: (Throwable) -> Unit)
    fun disconnect()
    fun sendMessage(message: GlassMessage)
    fun speak(text: String)
    /** 2026-10-05 (P9): 世界机会进眼镜视野 —— 1 秒瞬时提示 (用完即消失) */
    fun showOpportunity(opportunity: GlassOpportunity)
    fun onMessage(listener: (GlassMessage) -> Unit)
    fun onSpeech(listener: (String) -> Unit)
    fun currentState(): GlassDeviceState
}
