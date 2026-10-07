package com.hibs.bolloon

/**
 * K7: Harness — 唯一系统调用门 (手机原生版)
 *
 * 所有工具调用统一经过:
 *   discover → permission → policy → budget → idempotency → execute → verify → evidence → event
 *
 * 任何绕过 Harness 的工具调用都视为架构缺陷 (K7 门).
 */
interface KernelTool {
    val name: String
    val requiredCapabilities: List<String>
    /** 是否高风险 (支付/写文件/外部通信等 → 需 permission) */
    val risky: Boolean
    fun execute(args: Map<String, Any>, ctx: KernelRunContext): KernelToolResult
}

data class KernelToolResult(
    val ok: Boolean,
    val output: String = "",
    val evidence: String = "",      // 完成证据 (桌面: 命令退出码/测试/读回文件)
    val error: String? = null,
)

/** Harness 门结果 */
data class KernelGateResult(
    val allow: Boolean,
    val stage: String,               // permission / budget / idempotency / policy ...
    val reason: String = "",
    val deduped: Boolean = false,
    val cachedOutput: String = "",
)

/**
 * KernelHarness — 工具调用唯一入口.
 * 每个工具执行都走: discover → permission → policy → budget → idempotency → execute → verify.
 */
class KernelHarness(
    private val tools: Map<String, KernelTool>,
    private val budget: KernelBudget,
    private val idempotency: KernelIdempotency = KernelIdempotency(),
    private val permissionPolicy: (String, Map<String, Any>) -> KernelPermission = { _, _ -> KernelPermission(true) },
) {
    /** 工具调用总入口 (任何调用方都只能走这里) */
    fun invoke(toolName: String, args: Map<String, Any>, ctx: KernelRunContext): KernelToolResult {
        // 1. discover
        val tool = tools[toolName]
            ?: return KernelToolResult(false, error = "工具 \"$toolName\" 不存在. 可用: ${tools.keys.joinToString(", ")}")

        // 2. permission (高风险动作 + 用户策略)
        if (tool.risky) {
            val p = permissionPolicy(toolName, args)
            if (!p.allow) return KernelToolResult(false, error = "权限拒绝: ${p.reason}")
        }

        // 3. policy (能力检查)
        val cap = KernelCapability.check(tool.requiredCapabilities, ctx.checkpoint?.let { setOf("basic") })
        if (!cap.allow && tool.requiredCapabilities.isNotEmpty()) {
            // checkpoint 无能力声明 → 视为未验证 (桌面: 未知 = 拒在开连接之前)
            return KernelToolResult(false, error = cap.reason)
        }

        // 4. budget
        if (!budget.canStep()) return KernelToolResult(false, error = "预算耗尽 (steps=${budget.stepsUsed}/${budget.maxSteps})")

        // 5. idempotency (同一 Run 内重复调用去重)
        val deduped = idempotency.tryDedupe(toolName, args)
        if (deduped != null) return KernelToolResult(true, output = deduped, evidence = "(幂等命中)")

        // 6. execute
        val result = tool.execute(args, ctx)
        budget.markStep()
        ctx.stepCount = budget.stepsUsed

        // 7. verify + evidence (成功必须带证据)
        if (result.ok && result.evidence.isBlank() && tool.risky) {
            // 高风险动作缺证据 → 不算完成 (桌面: 模型说完成 ≠ 系统确认完成)
            return KernelToolResult(false, error = "缺少完成证据 (risky 工具必须带 evidence)", evidence = result.evidence)
        }

        // 8. event (审计留痕到 run context)
        ctx.addMessage("tool", "${toolName} → ${result.output.take(120)}")
        idempotency.record(toolName, args, result.output)
        return result
    }

    fun snapshotGates(): Map<String, Any> = mapOf(
        "budget" to budget.snapshot(),
        "idempotencySize" to idempotency.snapshotSize(),
    )
}

/** 手机原生工具集 → KernelTool 适配 (把 AndroidAgentTools 包成 KernelTool) */
class KernelToolAdapter(
    private val raw: AndroidAgentTools,
) {
    /** 构建工具表: AndroidAgentTools 的每个能力 → KernelTool (低风险, 无副作用性判断) */
    fun buildTools(): Map<String, KernelTool> {
        val names = setOf(
            "build_llm_context", "get_interactive_elements", "get_screen_tree", "classify_screen",
            "tap", "swipe", "type", "back", "home", "launch_app", "shell", "get_device_info",
            "list_packages", "done",
        )
        val risky = setOf("launch_app", "shell", "type")
        return names.associateWith { name ->
            object : KernelTool {
                override val name = name
                override val requiredCapabilities = emptyList<String>()
                override val risky = risky.contains(name)
                override fun execute(args: Map<String, Any>, ctx: KernelRunContext): KernelToolResult {
                    val out = raw.execute(name, args)
                    val ok = !out.contains("\"success\":false")
                    return KernelToolResult(ok = ok, output = out, evidence = if (ok) "tool-returned" else "")
                }
            }
        }
    }
}

/** KernelIdempotency 快照 (真实: 已去重条目数) */
fun KernelIdempotency.snapshotSize(): Int = this.size()
