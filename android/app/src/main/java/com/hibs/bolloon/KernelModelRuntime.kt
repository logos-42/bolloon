package com.hibs.bolloon

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.abs
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * KernelModelRuntime — 桌面 kernel `model-runtime.ts` 的 Android 原生移植 (2026-10-07)
 *
 * 核心语义 (忠实复刻桌面 K6/K10, 不缩水):
 *   ① 连接池复用 (按 provider::model::baseUrl 池化, 同一 key 只开一次连接)
 *   ② 超时 / 取消 (超时即中止底层调用; 外部取消透传)
 *   ③ 限流退避 (429/rate-limit → 指数退避: base 200ms ×2^n, max 5s, ±25% 抖动, 3 次重试)
 *   ④ 熔断 (连续 3 失败 → 开路 30s → 半开放 1 个探测 → 成功闭合/失败重开; 429/取消不计入熔断)
 *   ⑤ 逐 key 并发槽 (默认 4; 排队可取消)
 *   ⑥ provider 回退链 (snapshot 自带 fallbackProviders, 主失败按序试备)
 *
 * 线程模型: 全部异步调用经 Executor; 状态用锁/原子保护。零协程依赖 (与项目一致)。
 */
data class KernelModelSnapshot(
    val provider: String,
    val model: String,
    val baseUrl: String? = null,
    val timeoutMs: Long? = null,
    val capabilities: Set<String>? = null,
    val fallbackProviders: List<String> = emptyList(),
)

class KernelModelAbortError : Exception("模型调用被取消")
class KernelModelTimeoutError(val budgetMs: Long) : Exception("模型调用超时 ($budgetMs ms)")
class KernelModelCircuitOpenError(val retryAtMs: Long) : Exception("熔断中 (冷却至 $retryAtMs)")
class KernelModelCapabilityError(missing: List<String>) : Exception("缺能力: $missing")

/** 一次模型调用请求 (运行时只看透传, 不看内容) */
data class KernelModelRequest(
    val messages: List<Pair<String, String>>,
    val maxTokens: Int = 4096,
    val temperature: Double = 0.2,
)

/** 一次模型调用结果 */
data class KernelModelResult(
    val ok: Boolean,
    val provider: String? = null,
    val fallback: Boolean = false,
    val content: String = "",
    val error: String? = null,
    val reused: Boolean = false,
    val ms: Long = 0,
    val status: Int? = null,
    /** 供应商 Retry-After (ms) — 限流时可能给 */
    val retryAfterMs: Long? = null,
)

/** 底层连接抽象 (远程 LLM / 本地 LLM 各自实现) */
interface KernelModelConnection {
    val id: String
    /** 发一次请求; 超时/取消由运行时管理 */
    fun call(req: KernelModelRequest, timeoutMs: Long): KernelModelResult
    fun close()
}

/** 退避策略 (与桌面 BACKOFF_POLICY 一致) */
object KernelBackoffPolicy {
    const val BASE_MS = 200L
    const val FACTOR = 2
    const val MAX_MS = 5_000L
    const val JITTER = 0.25
    const val MAX_RETRIES = 3
}

/** 熔断策略 (与桌面 BREAKER_POLICY 一致) */
object KernelBreakerPolicy {
    const val FAILURE_THRESHOLD = 3
    const val COOLDOWN_MS = 30_000L
    const val HALF_OPEN_PROBES = 1
}

/** 是否限流 (429 / rate-limit) */
fun kernelIsRateLimited(r: KernelModelResult): Boolean {
    if (r.status == 429) return true
    val e = r.error?.lowercase() ?: return false
    return e.contains("429") || e.contains("rate limit")
}

/** 第 n 次重试的等待时长 (n 从 0 起) — 复刻 backoffDelayMs */
fun kernelBackoffDelayMs(n: Int, retryAfterMs: Long? = null, random: () -> Double = { Math.random() }): Long {
    val exp = minOf(KernelBackoffPolicy.BASE_MS * KernelBackoffPolicy.FACTOR.toDouble().pow(n), KernelBackoffPolicy.MAX_MS.toDouble())
    val jittered = exp * (1 + KernelBackoffPolicy.JITTER * (2 * random() - 1))
    return maxOf(0L, maxOf(jittered, (retryAfterMs ?: 0L).toDouble()).roundToLong())
}

/** 这次失败是否计入熔断 (取消不算; 429 不算; 超时算) */
fun kernelCountsTowardBreaker(e: Throwable): Boolean {
    if (e is KernelModelAbortError) return false
    if (e is KernelModelTimeoutError) return true
    // 429 (返回型限流) 由调用方按结果处理, 抛出来的不在这里判断
    return true
}

internal class KernelPooledConnection(
    val conn: KernelModelConnection,
    @Volatile var leases: Int = 0,
)

/**
 * ModelRuntime — 连接池 + 超时/取消 + 退避 + 熔断 + 并发槽 + 回退链。
 * 用法: acquire(snapshot) → lease.call(req) → lease.release()
 */
class KernelModelRuntime(
    /** 打开连接的回调 (调用方提供实现, 如 RemoteLlmConnection) */
    private val connectionFactory: (KernelModelSnapshot) -> KernelModelConnection,
    private val defaultTimeoutMs: Long = 30_000,
    private val maxConcurrency: Int = 4,
) {
    private val pool = HashMap<String, KernelPooledConnection>()
    private val breakers = HashMap<String, BreakerState>()
    private val active = HashMap<String, Int>()
    private val waiters = HashMap<String, MutableList<Waiter>>()
    private val lock = Object()

    // 统计
    private val statReused = AtomicLong(0); private val statOpened = AtomicLong(0)
    private val statTimeouts = AtomicLong(0); private val statAborts = AtomicLong(0)
    private val statRateLimited = AtomicLong(0); private val statRetries = AtomicLong(0)
    private val statCircuitOpened = AtomicLong(0); private val statFailFast = AtomicLong(0)
    private val statFallbacks = AtomicLong(0); private val statHalfOpenProbes = AtomicLong(0)
    private val statBreakerClosed = AtomicLong(0); private val statConcurrencyWaits = AtomicLong(0)
    private val lastBackoffMs = AtomicLong(0)
    private val maxObservedConcurrency = AtomicInteger(0)

    private class BreakerState(
        var failures: Int = 0,
        var state: String = "closed",  // closed | open | half-open
        var openUntil: Long = 0,
        var probes: Int = 0,
    )

    private class Waiter(
        val signal: CancellationSignal? = null,
        @Volatile var granted: Boolean = false,
    )

    /** 取一个租约 (同一 pool key 复用连接) */
    fun acquire(snapshot: KernelModelSnapshot): KernelModelLease {
        if (snapshot.provider.isBlank() || snapshot.model.isBlank()) throw IllegalArgumentException("acquire 需要 provider + model")
        val key = poolKey(snapshot)
        val slot = ensureConnection(snapshot, key)
        val lease = KernelModelLease(snapshot)
        lease.bind(slot, this, key)
        return lease
    }

    /** 连接池 key */
    fun poolKey(s: KernelModelSnapshot): String = "${s.provider}::${s.model}::${s.baseUrl ?: ""}"

    private fun ensureConnection(snapshot: KernelModelSnapshot, key: String): KernelPooledConnection {
        synchronized(lock) {
            val existing = pool[key]
            if (existing != null) {
                statReused.incrementAndGet()
                existing.leases++
                return existing
            }
            val conn = connectionFactory(snapshot)
            statOpened.incrementAndGet()
            val slot = KernelPooledConnection(conn, leases = 1)
            pool[key] = slot
            return slot
        }
    }

    // ── 熔断 ──────────────────────────────────────────────────────────────
    /** 熔断门: open 且未到冷却 ⇒ 返回可再试时间 (快速失败); 已过冷却 ⇒ 转半开放一个探测 */
    private fun breakerGate(key: String): Long? {
        synchronized(lock) {
            val b = breakers[key] ?: return null
            if (b.state == "closed") return null
            val now = System.currentTimeMillis()
            if (b.state == "open" && now >= b.openUntil) {
                b.state = "half-open"
                b.probes = 0
            }
            if (b.state == "open") return b.openUntil
            if (b.probes >= KernelBreakerPolicy.HALF_OPEN_PROBES) return b.openUntil
            b.probes++
            statHalfOpenProbes.incrementAndGet()
            return null
        }
    }

    private fun onSuccess(key: String) {
        synchronized(lock) {
            val b = breakers[key] ?: return
            if (b.state == "half-open") {
                b.state = "closed"; b.failures = 0; b.probes = 0
                statBreakerClosed.incrementAndGet()
            } else {
                b.failures = 0
            }
        }
    }

    private fun onFailure(key: String) {
        synchronized(lock) {
            val b = breakers[key] ?: BreakerState().also { breakers[key] = it }
            b.failures++
            val halfOpenFail = b.state == "half-open"
            if (halfOpenFail || b.failures >= KernelBreakerPolicy.FAILURE_THRESHOLD) {
                b.state = "open"
                b.openUntil = System.currentTimeMillis() + KernelBreakerPolicy.COOLDOWN_MS
                b.probes = 0
                statCircuitOpened.incrementAndGet()
            }
        }
    }

    // ── 并发槽 ────────────────────────────────────────────────────────────
    private fun acquireSlot(key: String, signal: CancellationSignal?) {
        synchronized(lock) {
            val cur = active[key] ?: 0
            if (cur < maxConcurrency) {
                active[key] = cur + 1
                maxObservedConcurrency.set(maxOf(maxObservedConcurrency.get(), cur + 1))
                return
            }
            if (signal?.isCancelled == true) { statAborts.incrementAndGet(); throw KernelModelAbortError() }
            statConcurrencyWaits.incrementAndGet()
            val w = Waiter(signal)
            val list = waiters.getOrPut(key) { mutableListOf() }
            list.add(w)
            // 阻塞等槽 (转让)
            while (true) {
                if (w.granted) break
                if (signal?.isCancelled == true) {
                    list.remove(w)
                    if (list.isEmpty()) waiters.remove(key)
                    statAborts.incrementAndGet()
                    throw KernelModelAbortError()
                }
                try { (lock as java.lang.Object).wait(50) } catch (e: InterruptedException) {
                    list.remove(w); if (list.isEmpty()) waiters.remove(key); Thread.currentThread().interrupt(); throw KernelModelAbortError()
                }
            }
        }
    }

    private fun releaseSlot(key: String) {
        synchronized(lock) {
            val list = waiters[key]
            val next = list?.firstOrNull()
            if (next != null) {
                list.removeAt(0)
                if (list.isEmpty()) waiters.remove(key)
                next.granted = true
                (lock as java.lang.Object).notifyAll()
                return
            }
            val cur = active[key] ?: 0
            if (cur <= 1) active.remove(key) else active[key] = cur - 1
        }
    }

    // ── 一次调用 (主 provider + 回退链) ──────────────────────────────────
    fun call(snapshot: KernelModelSnapshot, req: KernelModelRequest, signal: CancellationSignal? = null): KernelModelResult {
        val key = poolKey(snapshot)
        val slot = ensureConnection(snapshot, key)
        return callWith(snapshot, req, signal, slot, key)
    }

    /** call 的实际实现 (租约复用同一连接) — 供 KernelModelLease.call 调用 */
    internal fun callWith(snapshot: KernelModelSnapshot, req: KernelModelRequest, signal: CancellationSignal?, slot: KernelPooledConnection, key: String): KernelModelResult {
        val started = System.currentTimeMillis()
        val candidates: List<KernelModelSnapshot> = buildList {
            add(snapshot)
            for (p in snapshot.fallbackProviders) {
                if (p.isNotBlank() && p != snapshot.provider) add(snapshot.copy(provider = p))
            }
        }
        var last: KernelModelResult = KernelModelResult(ok = false, error = "没有可用的 provider")
        var totalAttempts = 0

        for ((ci, snapI) in candidates.withIndex()) {
            val keyI = if (ci == 0) key else poolKey(snapI)
            val isFallback = ci > 0
            if (isFallback) statFallbacks.incrementAndGet()
            try {
                val gate = breakerGate(keyI)
                if (gate != null) {
                    statFailFast.incrementAndGet()
                    if (ci + 1 < candidates.size) {
                        last = KernelModelResult(ok = false, provider = snapI.provider, fallback = isFallback, error = "熔断中 (冷却至 $gate)")
                        continue
                    }
                    throw KernelModelCircuitOpenError(gate)
                }
                val connI: KernelModelConnection = if (keyI == key) slot.conn else ensureConnection(snapI, keyI).conn
                acquireSlot(keyI, signal)
                try {
                    var attempt = 0
                    while (true) {
                        totalAttempts++
                        val budget = snapI.timeoutMs ?: defaultTimeoutMs
                        val result = try {
                            callOnce(connI, req, budget)
                        } catch (e: Throwable) {
                            if (kernelCountsTowardBreaker(e)) onFailure(keyI) else onSuccess(keyI)
                            throw e
                        }
                        if (result.ok) {
                            onSuccess(keyI)
                            return result.copy(
                                provider = snapI.provider,
                                fallback = isFallback,
                                reused = slot.leases > 1,
                                ms = System.currentTimeMillis() - started,
                            )
                        }
                        if (!kernelIsRateLimited(result)) {
                            if (kernelCountsTowardBreaker(RuntimeException(result.error))) onFailure(keyI) else onSuccess(keyI)
                            last = result.copy(provider = snapI.provider, fallback = isFallback, reused = slot.leases > 1, ms = System.currentTimeMillis() - started)
                            break
                        }
                        statRateLimited.incrementAndGet()
                        if (attempt >= KernelBackoffPolicy.MAX_RETRIES) {
                            last = result.copy(provider = snapI.provider, fallback = isFallback, ms = System.currentTimeMillis() - started, error = "限流重试用尽 (${attempt + 1} 次): ${result.error}")
                            break
                        }
                        val wait = kernelBackoffDelayMs(attempt, result.retryAfterMs)
                        statRetries.incrementAndGet()
                        lastBackoffMs.set(wait)
                        sleepOrAbort(wait, signal)
                        attempt++
                    }
                } finally {
                    releaseSlot(keyI)
                }
            } catch (e: KernelModelAbortError) {
                throw e
            } catch (e: KernelModelTimeoutError) {
                if (ci + 1 < candidates.size) {
                    last = KernelModelResult(ok = false, provider = snapI.provider, fallback = isFallback, error = e.message)
                    continue
                }
                throw e
            }
        }
        val tried = candidates.joinToString(" → ") { it.provider }
        last = last.copy(ms = System.currentTimeMillis() - started, error = "全部候选失败 ($tried): ${last.error}")
        return last
    }

    /** 单次尝试: 超时走受控中断 (复刻 callOnce) */
    private fun callOnce(conn: KernelModelConnection, req: KernelModelRequest, budget: Long): KernelModelResult {
        val done = java.util.concurrent.CountDownLatch(1)
        val resultHolder = arrayOfNulls<KernelModelResult>(1)
        val errorHolder = arrayOfNulls<Throwable>(1)
        val worker = Thread {
            try {
                resultHolder[0] = conn.call(req, budget)
            } catch (e: Throwable) {
                errorHolder[0] = e
            } finally {
                done.countDown()
            }
        }
        worker.isDaemon = true
        worker.start()
        if (done.await(budget, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            errorHolder[0]?.let { throw it }
            return resultHolder[0]!!
        }
        statTimeouts.incrementAndGet()
        worker.interrupt()
        throw KernelModelTimeoutError(budget)
    }

    /** 退避睡眠 (可取消) */
    private fun sleepOrAbort(ms: Long, signal: CancellationSignal?) {
        if (signal?.isCancelled == true) { statAborts.incrementAndGet(); throw KernelModelAbortError() }
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < ms) {
            if (signal?.isCancelled == true) { statAborts.incrementAndGet(); throw KernelModelAbortError() }
            Thread.sleep(minOf(50, ms - (System.currentTimeMillis() - start)))
        }
    }

    /** 只读统计 */
    fun snapshotStats(): Map<String, Long> = mapOf(
        "connections" to pool.size.toLong(),
        "reused" to statReused.get(), "opened" to statOpened.get(),
        "timeouts" to statTimeouts.get(), "aborts" to statAborts.get(),
        "rateLimited" to statRateLimited.get(), "retries" to statRetries.get(),
        "circuitOpened" to statCircuitOpened.get(), "failFast" to statFailFast.get(),
        "fallbacks" to statFallbacks.get(), "halfOpenProbes" to statHalfOpenProbes.get(),
        "breakerClosed" to statBreakerClosed.get(), "concurrencyWaits" to statConcurrencyWaits.get(),
        "maxObservedConcurrency" to maxObservedConcurrency.get().toLong(),
    )

    fun closeAll() { synchronized(lock) { for (s in pool.values) { try { s.conn.close() } catch (_: Throwable) {} }; pool.clear() } }

    /** 租约归还: 递减连接引用 (由 releaseLease 调用, 锁内执行) */
    internal fun decLeases(key: String) {
        synchronized(lock) {
            val cur = pool[key]
            if (cur != null) cur.leases = maxOf(0, cur.leases - 1)
        }
    }
}

/** 租约: 同一 snapshot 的多次调用共用一个连接 */
class KernelModelLease internal constructor(
    val snapshot: KernelModelSnapshot,
) {
    internal var slot: KernelPooledConnection? = null
        private set
    internal var runtime: KernelModelRuntime? = null
        private set
    internal var key: String = ""
        private set

    internal fun bind(s: KernelPooledConnection, r: KernelModelRuntime, k: String) {
        slot = s; runtime = r; key = k
    }

    @Volatile private var released = false

    fun call(req: KernelModelRequest, signal: CancellationSignal? = null): KernelModelResult {
        if (released) return KernelModelResult(ok = false, error = "租约已归还")
        val rt = runtime ?: return KernelModelResult(ok = false, error = "租约未绑定")
        val sk = slot ?: return KernelModelResult(ok = false, error = "租约未绑定")
        return rt.callWith(snapshot, req, signal, sk, key)
    }

    fun release() {
        if (released) return
        released = true
        val rt = runtime ?: return
        val k = key
        rt.decLeases(k)
    }
}

/** 可取消信号 (等价 AbortSignal; 无协程依赖) */
class CancellationSignal {
    @Volatile var isCancelled: Boolean = false
        private set
    fun cancel() { isCancelled = true }
}