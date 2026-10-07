package com.hibs.bolloon

/**
 * K5: Channel Actor Runtime (手机原生版)
 *
 * 核心目标 (对齐桌面计划, 不是多线程而是隔离状态):
 *   Channel A 可以并发执行
 *   Channel B 可以并发执行
 *   Channel A 内部消息不能交错 (同一 Channel 串行)
 *
 * 每个 Channel 具备: mailbox / session context / model binding / cancellation /
 *   outbound queue / heartbeat / backpressure / close-restart.
 */
class KernelChannelActor(
    val channelId: String,
    private val mailbox: KernelChannelMailbox,
    private val context: KernelChannelContext,
    private val loopFactory: (KernelChannelContext, KernelEvent) -> KernelLoopExecutor,
) {
    @Volatile private var running = false
    @Volatile private var closed = false
    private var thread: Thread? = null

    val isRunning: Boolean get() = running

    /** 启动 actor (每个 Channel 一个线程; 内部消息串行处理) */
    fun start() {
        if (running || closed) return
        running = true
        thread = Thread { runLoop() }.apply { isDaemon = true; name = "channel-${channelId}" }
        thread?.start()
    }

    private fun runLoop() {
        while (!closed && !context.signal.isCancelled) {
            val ev = mailbox.take(context.signal) ?: break
            try {
                val executor = loopFactory(context, ev)
                executor.execute()
            } catch (e: Throwable) {
                // 单事件失败不拖死通道 (隔离); 记错误继续
                context.enqueueOutbound("{\"error\":\"channel-${channelId}: ${e.message}\"}")
            }
        }
        running = false
    }

    /** 关闭 (停循环, 不丢 mailbox — 调用方先 drain) */
    fun close() {
        closed = true
        context.signal.cancel()
        thread?.interrupt()
    }

    /** 重启 (close 后复用同一 mailbox/context) */
    fun restart() {
        if (running) return
        closed = false
        context.signal.cancel()  // 旧信号已取消, 换新的
        start()
    }
}

/** 事件执行器 (由 loopFactory 创建; 实际跑 KernelAgentLoop / 其他策略) */
interface KernelLoopExecutor {
    fun execute(): String
}

/** Actor 注册表: 全通道管理 (K5: 一通道一线程, 互不拖死) */
object KernelActorRegistry {
    private val actors = HashMap<String, KernelChannelActor>()
    private val lock = Object()

    fun register(actor: KernelChannelActor): KernelChannelActor = synchronized(lock) {
        actors[actor.channelId] = actor
        actor
    }

    fun get(channelId: String): KernelChannelActor? = synchronized(lock) { actors[channelId] }

    fun startAll() { synchronized(lock) { actors.values.forEach { it.start() } } }

    fun closeAll() { synchronized(lock) { actors.values.forEach { it.close() } } }

    fun activeChannels(): Int = synchronized(lock) { actors.values.count { it.isRunning } }
}
