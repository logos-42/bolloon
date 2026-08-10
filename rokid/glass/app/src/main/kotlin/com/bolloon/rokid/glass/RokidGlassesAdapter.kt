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

interface RokidGlassesAdapter {
    val mode: String
    fun connect(onConnected: (String) -> Unit, onError: (Throwable) -> Unit)
    fun disconnect()
    fun sendMessage(message: GlassMessage)
    fun speak(text: String)
    fun onMessage(listener: (GlassMessage) -> Unit)
    fun onSpeech(listener: (String) -> Unit)
    fun currentState(): GlassDeviceState
}
