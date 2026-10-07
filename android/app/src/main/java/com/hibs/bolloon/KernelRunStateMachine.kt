package com.hibs.bolloon

/**
 * KernelRunStateMachine — 桌面 kernel `run-store.ts` Run 状态机的 Android 原生移植 (2026-10-07)
 *
 * 核心语义 (忠实复刻, 不缩水):
 *   ① 10 态: queued / running / recovering / paused / awaiting_external / done / failed /
 *      aborted / interrupted / stalled / needs_human
 *   ② 合法迁移表 (RUN_TRANSITIONS): 非法迁移一律拒绝 — 防止"偷偷回到 running"假状态
 *   ③ 错误分类 (ErrorClass) → 默认恢复动作 (Phase 3 协议表)
 *   ④ 预算闸门: maxSteps / deadlineMs 到点必须如实结束 (failed/aborted), 不许静默算完成
 *   ⑤ 失速巡检: 长时间没更新 → stalled
 */
object KernelRunStates {
    val RUN_STATUSES = listOf(
        "queued", "running", "recovering", "paused", "awaiting_external",
        "done", "failed", "aborted", "interrupted", "stalled", "needs_human",
    )

    /** 合法状态迁移 (协议的一部分) */
    val RUN_TRANSITIONS: Map<String, List<String>> = mapOf(
        "queued" to listOf("running", "aborted", "interrupted"),
        "running" to listOf("recovering", "paused", "awaiting_external", "done", "failed", "aborted", "interrupted", "stalled", "needs_human"),
        "recovering" to listOf("running", "failed", "aborted", "needs_human", "interrupted", "stalled"),
        "paused" to listOf("running", "aborted", "interrupted", "recovering"),
        "awaiting_external" to listOf("running", "failed", "aborted", "interrupted", "stalled", "recovering"),
        "done" to emptyList(),
        "failed" to emptyList(),
        "aborted" to emptyList(),
        "interrupted" to listOf("recovering", "aborted"),   // 允许"从 checkpoint 恢复"
        "stalled" to listOf("recovering", "aborted", "needs_human"),
        "needs_human" to listOf("running", "aborted", "recovering"),
    )

    fun canTransition(from: String, to: String): Boolean {
        if (from == to) return true
        return (RUN_TRANSITIONS[from] ?: emptyList()).contains(to)
    }
}

/** 错误分类 (→ 默认恢复动作) */
enum class KernelErrorClass {
    TRANSIENT,        // 网络抖动 / 429 / 5xx → 指数退避重试
    AUTH,             // 鉴权失败 → 不重试, 交人 (needs_human)
    BAD_ARGS,         // 工具参数错 → 修正重试一次
    NO_SUCH_TOOL,     // 工具不存在/能力不匹配 → 换工具或重规划
    POLICY_DENIED,    // 权限/安全 gate 拒绝 → 不重试, 走策略分支
    EXTERNAL_NO_REPLY,// 外部节点无响应 → awaiting_external
    UNPARSABLE,       // 模型输出不可解析 → 重提示一次再暂停
    REPEAT_FAILURE,   // 重复失败 → 熔断 needs_human
    CRASH,            // 进程崩溃 → 从最近 checkpoint 恢复
    CORRUPT_STATE,    // 状态文件损坏 → 用最后有效 checkpoint
    PERSIST_FAILED,   // 核心运行状态写不进去 → 停, 不许无记录继续执行
    UNKNOWN,
}

/** 错误分类 → 默认恢复动作 (Phase 3 协议表; 决策记录) */
enum class KernelRecoveryAction { RETRY, BACKOFF, RESUME, FALLBACK, PAUSE, ESCALATE, FAIL, NONE }

object KernelErrorClassify {
    /** 从错误消息/状态分类错误 (复刻 run-store classifyError 的语义) */
    fun classify(err: String?, status: Int? = null): KernelErrorClass {
        val raw = (err ?: "").lowercase()
        if (status == 429 || raw.contains("429") || raw.contains("rate limit")) return KernelErrorClass.TRANSIENT
        if (status == 401 || status == 403 || raw.contains("401") || raw.contains("403") || raw.contains("auth") || raw.contains("鉴权") || raw.contains("key")) return KernelErrorClass.AUTH
        if (status in 500..599) return KernelErrorClass.TRANSIENT
        if (raw.contains("timeout") || raw.contains("超时") || raw.contains("econnrefused") || raw.contains("network") || raw.contains("fetch failed")) return KernelErrorClass.TRANSIENT
        if (raw.contains("no such tool") || raw.contains("tool.*not") || raw.contains("未知工具")) return KernelErrorClass.NO_SUCH_TOOL
        if (raw.contains("unparsable") || raw.contains("无法解析") || raw.contains("parse")) return KernelErrorClass.UNPARSABLE
        if (raw.contains("policy") || raw.contains("denied") || raw.contains("拒绝")) return KernelErrorClass.POLICY_DENIED
        if (raw.contains("persist") || raw.contains("写不进")) return KernelErrorClass.PERSIST_FAILED
        return KernelErrorClass.UNKNOWN
    }

    /** 错误分类 → 默认恢复动作 */
    fun defaultAction(cls: KernelErrorClass): KernelRecoveryAction = when (cls) {
        KernelErrorClass.TRANSIENT -> KernelRecoveryAction.BACKOFF
        KernelErrorClass.AUTH -> KernelRecoveryAction.ESCALATE
        KernelErrorClass.BAD_ARGS -> KernelRecoveryAction.RETRY
        KernelErrorClass.NO_SUCH_TOOL -> KernelRecoveryAction.FALLBACK
        KernelErrorClass.POLICY_DENIED -> KernelRecoveryAction.PAUSE
        KernelErrorClass.EXTERNAL_NO_REPLY -> KernelRecoveryAction.RESUME
        KernelErrorClass.UNPARSABLE -> KernelRecoveryAction.RETRY
        KernelErrorClass.REPEAT_FAILURE -> KernelRecoveryAction.ESCALATE
        KernelErrorClass.CRASH -> KernelRecoveryAction.RESUME
        KernelErrorClass.CORRUPT_STATE -> KernelRecoveryAction.RESUME
        KernelErrorClass.PERSIST_FAILED -> KernelRecoveryAction.FAIL
        KernelErrorClass.UNKNOWN -> KernelRecoveryAction.PAUSE
    }
}

/** 一次恢复尝试的记录 (每次恢复必须留痕) */
data class KernelRecoveryAttempt(
    val ts: Long,
    val errorClass: KernelErrorClass,
    val message: String,
    val action: KernelRecoveryAction,
    val attempt: Int,
    val recovered: Boolean = false,
)

/** Run 记录 (手机端精简版: 桌面 RunRecord 的核心字段) */
data class KernelRunRecord(
    val runId: String,
    val goalId: String = "",
    var status: String = "queued",
    val startedAt: Long = System.currentTimeMillis(),
    var updatedAt: Long = System.currentTimeMillis(),
    var stepCount: Int = 0,
    var maxSteps: Int = 50,
    var deadlineMs: Long = 0,
    var lastError: String = "",
    var errorClass: KernelErrorClass = KernelErrorClass.UNKNOWN,
    val recoveryAttempts: MutableList<KernelRecoveryAttempt> = mutableListOf(),
    var result: String = "",
)

/**
 * Run 状态机 (内存版; 与桌面 run-store 同语义)
 *   - 非法迁移拒绝 (返回 false, 不抛)
 *   - 预算闸门: maxSteps / deadline 到点如实结束
 *   - 失速判定: 超过 stallThresholdMs 未更新 → stalled (可由巡检调用)
 */
class KernelRunStateMachine(
    private val stallThresholdMs: Long = 30 * 60 * 1000L,  // 30 分钟无更新 → 失速
) {
    @Volatile var record: KernelRunRecord? = null
        private set

    /** 新建 Run (queued) */
    fun startRun(goalId: String, maxSteps: Int = 50, deadlineMs: Long = 0): KernelRunRecord {
        val r = KernelRunRecord(
            runId = "run-${System.currentTimeMillis()}",
            goalId = goalId,
            status = "queued",
            maxSteps = maxSteps,
            deadlineMs = deadlineMs,
        )
        record = r
        return r
    }

    /** 状态迁移: 非法拒绝 (返回 false); 终态不可再动 (done/failed/aborted 是死终点) */
    fun transition(to: String): Boolean {
        val r = record ?: return false
        if (!KernelRunStates.canTransition(r.status, to)) return false
        r.status = to
        r.updatedAt = System.currentTimeMillis()
        return true
    }

    /** 记一步 (running 中; 预算闸门检查) */
    fun recordStep(tool: String, ok: Boolean, summary: String = ""): Boolean {
        val r = record ?: return false
        if (r.status != "running") return false
        r.stepCount++
        r.updatedAt = System.currentTimeMillis()
        // 预算闸门: maxSteps 到点必须如实结束
        if (r.stepCount >= r.maxSteps) {
            transition("failed")
            r.result = "达到最大步数 (${r.maxSteps}), 已停止"
            return false
        }
        return true
    }

    /** 失败: 分类 + 记恢复尝试 + 迁移 (按协议) */
    fun fail(error: String, status: Int? = null, attempt: Int = 1): Boolean {
        val r = record ?: return false
        r.lastError = error
        r.errorClass = KernelErrorClassify.classify(error, status)
        val action = KernelErrorClassify.defaultAction(r.errorClass)
        r.recoveryAttempts.add(KernelRecoveryAttempt(System.currentTimeMillis(), r.errorClass, error, action, attempt))
        return when (action) {
            KernelRecoveryAction.ESCALATE -> transition("needs_human")
            KernelRecoveryAction.PAUSE -> transition("paused")
            KernelRecoveryAction.BACKOFF, KernelRecoveryAction.RETRY -> transition("recovering")
            KernelRecoveryAction.FAIL -> transition("failed")
            else -> transition("recovering")
        }
    }

    /** 预算闸门检查 (deadline 到点 → aborted) */
    fun checkDeadline(): Boolean {
        val r = record ?: return true
        if (r.deadlineMs > 0 && System.currentTimeMillis() > r.deadlineMs && r.status == "running") {
            transition("aborted")
            r.result = "超过截止时间, 已中止"
            return false
        }
        return true
    }

    /** 失速巡检: 长时间未更新 → stalled (给 UI 诚实的说法) */
    fun markStalledIfNeeded(): Boolean {
        val r = record ?: return false
        if (r.status != "running") return false
        if (System.currentTimeMillis() - r.updatedAt > stallThresholdMs) {
            return transition("stalled")
        }
        return false
    }

    /** 成功完成 (→ done, 终态) */
    fun done(result: String): Boolean {
        val r = record ?: return false
        r.result = result
        return transition("done")
    }

    fun snapshot(): Map<String, Any> = record?.let {
        mapOf(
            "runId" to it.runId, "goalId" to it.goalId, "status" to it.status,
            "stepCount" to it.stepCount, "maxSteps" to it.maxSteps,
            "errorClass" to it.errorClass.name, "result" to it.result,
        )
    } ?: emptyMap()
}