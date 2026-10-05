package com.bolloon.rokid.glass

class MockRokidGlassesAdapter : RokidGlassesAdapter {
    override val mode: String = "mock"
    private var connected = false
    private var messageListener: ((GlassMessage) -> Unit)? = null
    private var speechListener: ((String) -> Unit)? = null
    /** 2026-10-05 (P9): 最近一次让眼镜「看见」的世界机会 —— 测试/演示可读 */
    var lastOpportunity: GlassOpportunity? = null
        private set

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

    override fun showOpportunity(opportunity: GlassOpportunity) {
        lastOpportunity = opportunity
        // 1 秒瞬时提示: 记录 + 语音简述 (用完即消失, 不常驻)
        if (connected) {
            speechListener?.invoke("世界机会: ${opportunity.title} 匹配 ${opportunity.matchPercent}%")
        }
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
