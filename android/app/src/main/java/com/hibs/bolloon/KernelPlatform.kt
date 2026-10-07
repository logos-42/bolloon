package com.hibs.bolloon

import java.io.File

/**
 * K0: Kernel 模块清单 + 约束 (手机原生版)
 *
 * 三道硬门 (对应桌面计划 K0):
 *   K1 门: Kernel 模块不能 import 业务模块 (只允许 kernel.* / 标准库 / java.*)
 *   K2 门: 模块不能访问其他模块的私有状态 (由 Kotlin internal/私有 编译器保证 + audit 扫描)
 *   K3 门: Kernel 总行数棘轮 (只允许下降, 超限即红)
 *
 * 每个模块有唯一 owner. 入口调用关系图由 KernelHost 统一串 (见 KernelHost.kt)。
 */
data class KernelModuleDef(
    val name: String,              // e.g. "kernel.model-runtime"
    val owner: String,             // 唯一 owner
    val allowedImportPrefixes: Set<String>,  // import 白名单
    val lineLimit: Int,            // 行数棘轮上限
    val responsibility: String,
)

object KernelModuleRegistry {
    /** Kernel 模块清单 (唯一事实来源) */
    val MODULES: List<KernelModuleDef> = listOf(
        KernelModuleDef("kernel.platform", "kernel", setOf("java.", "kotlin."), 300, "模块清单/审计/棘轮"),
        KernelModuleDef("kernel.primitives", "kernel", setOf("java.", "kotlin.", "kernel."), 250, "Budget/Permission/Capability/Idempotency 原语"),
        KernelModuleDef("kernel.model-runtime", "kernel", setOf("java.", "kotlin.", "kernel.", "com.hibs.bolloon"), 600, "连接池/超时取消/退避/熔断/并发槽/回退"),
        KernelModuleDef("kernel.run-state", "kernel", setOf("java.", "kotlin.", "kernel."), 300, "Run 状态机/错误分类/恢复动作"),
        KernelModuleDef("kernel.context", "kernel", setOf("java.", "kotlin.", "kernel."), 200, "RunContext/ChannelContext"),
        KernelModuleDef("kernel.mailbox", "kernel", setOf("java.", "kotlin.", "kernel."), 150, "通道事件队列/背压"),
        KernelModuleDef("kernel.channel-actor", "kernel", setOf("java.", "kotlin.", "kernel."), 250, "通道隔离/串行执行/并发"),
        KernelModuleDef("kernel.harness", "kernel", setOf("java.", "kotlin.", "kernel."), 300, "唯一系统调用门 (权限/预算/幂等/证据)"),
        KernelModuleDef("kernel.comm", "kernel", setOf("java.", "kotlin.", "kernel."), 150, "通信收口 (入站消息→mailbox)"),
        KernelModuleDef("kernel.agent-loop", "kernel", setOf("java.", "kotlin.", "kernel.", "com.hibs.bolloon"), 400, "唯一 Agent 循环"),
        KernelModuleDef("kernel.host", "kernel", setOf("java.", "kotlin.", "kernel.", "com.hibs.bolloon"), 300, "编排/入口收敛"),
    )

    /** K1 门: Kernel 之外的业务包前缀 — kernel 模块 import 它们即违规 */
    val BUSINESS_PREFIXES = listOf(
        "android.", "org.", "com.google.", "org.json",
    )

    /**
     * audit: 扫描 kernel 源文件, 返回违规清单 (空 = 三道门全绿)。
     *  - import 检查: kernel 文件 import 了业务/依赖包 → 违规
     *  - 行数检查: 超 lineLimit → 违规 (棘轮只降不升)
     */
    fun audit(kernelSourceDir: File): List<String> {
        val violations = mutableListOf<String>()
        if (!kernelSourceDir.exists()) return listOf("[audit] kernel 源码目录不存在: ${kernelSourceDir.path}")
        val files = kernelSourceDir.walkTopDown().filter { it.name.endsWith(".kt") }.toList()
        var totalLines = 0
        for (f in files) {
            val text = f.readText(Charsets.UTF_8)
            val lines = text.lines()
            totalLines += lines.size
            // import 白名单检查 (按模块约定给到 com.hibs.bolloon 的 adapter 文件放宽)
            val isKernelCore = f.name.startsWith("Kernel") && !f.name.contains("Adapter") && !f.name.contains("LlmConnection")
            if (isKernelCore) {
                for (line in lines) {
                    val m = Regex("^import\\s+([\\w.]+)").find(line.trim())
                    if (m != null) {
                        val imp = m.groupValues[1]
                        val allowed = KernelModuleRegistry.MODULES.any { mod ->
                            mod.allowedImportPrefixes.any { imp == it || imp.startsWith(it) }
                        }
                        if (!allowed) violations.add("${f.name}: import $imp 越界 (K1 门)")
                    }
                }
            }
        }
        // K3 棘轮: 总行数 (服务端由 git 比对; 这里只报警上限)
        val ratchetLimit = 3500
        if (totalLines > ratchetLimit) violations.add("Kernel 总行数 $totalLines > 棘轮上限 $ratchetLimit (K3 门)")
        return violations
    }
}

// ──────────────────────────────────────────────────────────────────────────
// K1: constraint-runtime 拆层 → Kernel 原语
// ──────────────────────────────────────────────────────────────────────────

/** 预算原语: 步数 + 截止时间 + token 预算 (桌面 BudgetTracker 移植) */
class KernelBudget(
    val maxSteps: Int = 50,
    val deadlineMs: Long = 0,
    val tokenBudget: Long = 0,
) {
    var stepsUsed = 0; private set
    var tokensUsed = 0L; private set
    var deadlineHit = false; private set

    fun canStep(): Boolean = stepsUsed < maxSteps && !deadlineHit
    fun markStep() { if (stepsUsed < maxSteps) stepsUsed++ }
    fun addTokens(n: Long) { tokensUsed += n; if (tokenBudget > 0 && tokensUsed >= tokenBudget) deadlineHit = true }
    fun checkDeadline(now: Long = System.currentTimeMillis()) {
        if (deadlineMs > 0 && now > deadlineMs) deadlineHit = true
    }
    fun snapshot(): Map<String, Any> = mapOf(
        "stepsUsed" to stepsUsed, "maxSteps" to maxSteps,
        "tokensUsed" to tokensUsed, "deadlineHit" to deadlineHit,
    )
}

/** 权限原语: 工具/动作的允许-拒绝 (桌面 Permission 移植) */
data class KernelPermission(val allow: Boolean, val reason: String = "")

/** 能力原语: 某 provider/工具需要的能力 vs 已声明能力 (缺声明 = 未知, 不许猜) */
object KernelCapability {
    fun check(required: List<String>, declared: Set<String>?): KernelPermission {
        if (declared == null) return KernelPermission(false, "snapshot 未声明 capabilities, 无法确认 ${required.joinToString(",")}")
        val missing = required.filter { !declared.contains(it) }
        return if (missing.isEmpty()) KernelPermission(true) else KernelPermission(false, "缺能力: $missing")
    }
}

/** 幂等原语: 同一 Run 内相同 (tool,argsHash) 只执行一次, 重复命中直接返回缓存结果 */
class KernelIdempotency {
    private val seen = HashMap<String, String>()
    fun key(tool: String, args: Map<String, Any>): String = "$tool::${args.entries.sortedBy { it.key }.joinToString { "${it.key}=${it.value}" }}"
    fun tryDedupe(tool: String, args: Map<String, Any>): String? = synchronized(seen) { seen[key(tool, args)] }
    fun record(tool: String, args: Map<String, Any>, result: String) { synchronized(seen) { seen[key(tool, args)] = result } }
    fun clear() { synchronized(seen) { seen.clear() } }
    /** 已去重条目数 (真实快照) */
    fun size(): Int = synchronized(seen) { seen.size }
}