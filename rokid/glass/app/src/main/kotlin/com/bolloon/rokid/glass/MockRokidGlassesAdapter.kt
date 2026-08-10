package com.bolloon.rokid.glass

class MockRokidGlassesAdapter : RokidGlassesAdapter {
    override val mode: String = "mock"
    private var connected = false
    private var messageListener: ((GlassMessage) -> Unit)? = null
    private var speechListener: ((String) -> Unit)? = null

    override fun connect(onConnected: (String) -> Unit, onError: (Throwable) -> Unit) {
        connected = true
        onConnected("mock-rokid-glasses")
    }

    override fun disconnect() {
        connected = false
    }

    override fun sendMessage(message: GlassMessage) {
        if (connected) messageListener?.invoke(message)
    }

    override fun speak(text: String) {
        if (connected) speechListener?.invoke(text)
    }

    override fun onMessage(listener: (GlassMessage) -> Unit) {
        messageListener = listener
    }

    override fun onSpeech(listener: (String) -> Unit) {
        speechListener = listener
    }

    override fun currentState(): GlassDeviceState = GlassDeviceState(
        batteryPercent = 87,
        wearing = true,
        microphoneMuted = false,
    )
}
