package com.hibs.bolloon

import java.util.concurrent.CopyOnWriteArrayList

/**
 * K2: Pi 可变状态外置 → RunContext / ChannelContext (手机原生版)
 *
 * 原则 (对齐桌面计划): PiAdapter = 无事实所有权的执行器.
 *   RunContext    = 当前执行事实 (history/stream/signal/failed tool/checkpoint)
 *   ChannelContext= 通道事实 (session/model binding/cancellation/outbound)
 *   GoalStore/RunStore = 持久事实 (手机版: 内存 + 可选落盘)
 */

/** 当前一次执行的全部可变状态 (取代散落在 AgentLoop/PiSession 的字段) */
class KernelRunContext(
    val runId: String = "run-${System.currentTimeMillis()}",
) {
    val history = CopyOnWriteArrayList<Pair<String, String>>()   // (role, content)
    var goal: String = ""
        private set
    var stepCount: Int = 0
    var failedTool: String? = null
    var lastError: String = ""
    var checkpoint: KernelCheckpoint? = null
    val signal = CancellationSignal()
    var streamCallback: ((String) -> Unit)? = null

    fun setGoal(g: String) { goal = g }
    fun addMessage(role: String, content: String) { history.add(role to content) }
    fun messages(): List<Pair<String, String>> = history.toList()

    /** 上下文溢出保护: 超阈值截断最早历史 (保留最近 ~60%) */
    fun compactIfNeeded(maxTokens: Int): List<Pair<String, String>> {
        val estimated = history.sumOf { (it.first.length + it.second.length) / 4 }
        if (estimated <= maxTokens) return messages()
        val keep = (history.size * 0.6).toInt().coerceAtLeast(4)
        val tail = history.takeLast(keep)
        val out = CopyOnWriteArrayList<Pair<String, String>>()
        out.add("user" to "[上下文已截断: 估算 $estimated tokens > $maxTokens, 保留最近 $keep 条。继续任务。]")
        out.addAll(tail)
        history.clear(); history.addAll(out)
        return messages()
    }
}

/** 检查点 (恢复入口) */
data class KernelCheckpoint(
    val completedActions: Int,
    val pendingAction: String? = null,
    val nextAction: String? = null,
    val contextRef: String? = null,
    val ts: Long = System.currentTimeMillis(),
)

/** 通道事实 (每个 Channel 一份; 同一 Channel 内串行, 不同 Channel 并行) */
class KernelChannelContext(
    val channelId: String,
    var modelSnapshot: KernelModelSnapshot? = null,
    var sessionRef: String = "default",
) {
    var outboundQueue = ArrayDeque<String>()
    var closed = false
    /** 通道级取消 (页面关闭/用户切换时) */
    val signal = CancellationSignal()
    /** 背压: 出站队列上限 */
    var outboundMax = 100

    fun canEnqueueOutbound(): Boolean = outboundQueue.size < outboundMax
    fun enqueueOutbound(msg: String): Boolean {
        if (!canEnqueueOutbound()) return false
        outboundQueue.addLast(msg)
        return true
    }
    fun drainOutbound(): List<String> {
        val out = outboundQueue.toList()
        outboundQueue.clear()
        return out
    }
}

// ──────────────────────────────────────────────────────────────────────────
// K3: 统一入口队列 — 所有入口只能 enqueue 事件, 不能直接调用循环
// ──────────────────────────────────────────────────────────────────────────

/** 入口事件 (External Event → ChannelMailbox.enqueue → ChannelActor → Kernel Loop) */
data class KernelEvent(
    val kind: String,           // 'user-message' | 'p2p' | 'cron' | 'supervisor' | 'followup' | 'social' | 'phone'
    val channelId: String,
    val payload: String = "",
    val source: String = "unknown",  // cli / web / mobile / p2p / cron ...
    val ts: Long = System.currentTimeMillis(),
)

/**
 * ChannelMailbox — 单通道事件队列 (FIFO; 同通道串行由 ChannelActor 保证)
 * 背压: 队列超上限 → 拒绝入队 (调用方必须重试/丢弃, 不许无限堆积)
 */
class KernelChannelMailbox(
    val channelId: String,
    private val maxPending: Int = 64,
) {
    private val queue = ArrayDeque<KernelEvent>()
    private val lock = Object()

    /** 入队 (背压: 满则拒绝返回 false) */
    fun enqueue(ev: KernelEvent): Boolean = synchronized(lock) {
        if (queue.size >= maxPending) false
        else { queue.addLast(ev); (lock as java.lang.Object).notifyAll(); true }
    }

    /** 阻塞取一条 (无事件则等, 可取消) */
    fun take(signal: CancellationSignal? = null): KernelEvent? = synchronized(lock) {
        while (queue.isEmpty()) {
            if (signal?.isCancelled == true) return null
            (lock as java.lang.Object).wait(50)
        }
        queue.removeFirst()
    }

    fun pending(): Int = synchronized(lock) { queue.size }
}

/** 入口注册表: 所有入口的入站统一走这里 (K3 门: 没有任何直接调 loop 的旁路) */
object KernelMailboxRegistry {
    private val mailboxes = HashMap<String, KernelChannelMailbox>()
    private val lock = Object()

    fun mailboxFor(channelId: String): KernelChannelMailbox = synchronized(lock) {
        mailboxes.getOrPut(channelId) { KernelChannelMailbox(channelId) }
    }

    fun enqueue(ev: KernelEvent): Boolean = mailboxFor(ev.channelId).enqueue(ev)

    fun pendingCounts(): Map<String, Int> = synchronized(lock) {
        mailboxes.mapValues { it.value.pending() }
    }
}
