package com.bolloon.agent.rokid

/**
 * AgentLifecycleManager — Agent 生命周期状态机 (Phase 4, 参考 Hermes subagent_lifecycle.py)
 *
 * Hermes 9 态:
 *   PENDING → STARTING → RUNNING → SUCCEEDED / FAILED / INTERRUPTED
 *             RUNNING → CANCEL_REQUESTED (已受理) → CANCELLED (落地)
 *   UNKNOWN (异常)
 *
 * 两段式取消: CANCEL_REQUESTED 表示"已请求但还在停", CANCELLED 是最终落地。
 * 终态保留: 最近 N 个终态快照保留, 供审计/查询。
 */
class AgentLifecycleManager(private val maxTerminalRetention: Int = 10) {

    enum class State {
        PENDING, STARTING, RUNNING, SUCCEEDED, FAILED, INTERRUPTED,
        CANCEL_REQUESTED, CANCELLED, UNKNOWN;

        val isTerminal: Boolean
            get() = this == SUCCEEDED || this == FAILED || this == INTERRUPTED || this == CANCELLED || this == UNKNOWN
    }

    data class LifecycleRecord(
        val id: String,
        val goal: String,
        val state: State,
        val startedAt: Long,
        val updatedAt: Long,
        val result: String = "",
        /** 取消请求原因 (CANCEL_REQUESTED/CANCELLED 时) */
        val cancelReason: String = "",
    )

    @Volatile
    private var current: LifecycleRecord? = null

    /** 终态历史 (最近 maxTerminalRetention 条) */
    private val terminalHistory = ArrayDeque<LifecycleRecord>()

    @Volatile
    private var seq = 0

    /** 当前运行记录 (无则 null) */
    fun currentRecord(): LifecycleRecord? = current

    /** 当前状态 */
    fun state(): State = current?.state ?: State.UNKNOWN

    /** 创建新 Agent 运行 (PENDING → STARTING) */
    fun start(goal: String): String {
        val id = "agent-${System.currentTimeMillis()}-${++seq}"
        val now = System.currentTimeMillis()
        current = LifecycleRecord(id, goal, State.STARTING, now, now)
        return id
    }

    /** 运行中 (STARTING → RUNNING) */
    fun markRunning(): Boolean {
        val c = current ?: return false
        if (c.state != State.STARTING) return false
        current = c.copy(state = State.RUNNING, updatedAt = System.currentTimeMillis())
        return true
    }

    /** 成功完成 (→ SUCCEEDED, 终态) */
    fun succeed(result: String) {
        transition { it.copy(state = State.SUCCEEDED, result = result, updatedAt = System.currentTimeMillis()) }
    }

    /** 失败 (→ FAILED, 终态) */
    fun fail(reason: String) {
        transition { it.copy(state = State.FAILED, result = reason, updatedAt = System.currentTimeMillis()) }
    }

    /** 中断 (→ INTERRUPTED, 终态) */
    fun interrupt(reason: String) {
        transition { it.copy(state = State.INTERRUPTED, result = reason, updatedAt = System.currentTimeMillis()) }
    }

    /** 请求取消 (RUNNING → CANCEL_REQUESTED, 两段式第一段) */
    fun requestCancel(reason: String = "用户取消"): Boolean {
        val c = current ?: return false
        if (c.state != State.RUNNING) return false
        current = c.copy(state = State.CANCEL_REQUESTED, cancelReason = reason, updatedAt = System.currentTimeMillis())
        return true
    }

    /** 取消落地 (CANCEL_REQUESTED → CANCELLED, 终态) */
    fun confirmCancelled() {
        transition { it.copy(state = State.CANCELLED, updatedAt = System.currentTimeMillis()) }
    }

    /** 是否已请求取消 (AgentLoop 每步检查) */
    fun isCancelRequested(): Boolean = current?.state == State.CANCEL_REQUESTED

    /** 终态历史 */
    fun history(): List<LifecycleRecord> = terminalHistory.toList()

    private fun transition(fn: (LifecycleRecord) -> LifecycleRecord) {
        val c = current ?: return
        val next = fn(c)
        current = next
        if (next.state.isTerminal) {
            terminalHistory.addLast(next)
            while (terminalHistory.size > maxTerminalRetention) terminalHistory.removeFirst()
            current = null
        }
    }
}
