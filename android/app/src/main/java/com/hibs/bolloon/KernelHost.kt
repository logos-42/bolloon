package com.hibs.bolloon

/**
 * K9: 第二个非 Pi Adapter (手机原生版)
 *
 * 目标: 证明 Kernel 真正独立 — NativeAdapter 与旧 AgentLoop 走完全相同的验收
 *   (model call / tool call / stream / cancellation / checkpoint / finish).
 * 两个 Adapter 都通过 → Kernel 独立成立 → 才允许 K10 删除旧路径。
 */
interface KernelAdapter {
    val name: String
    fun modelCall(messages: List<Pair<String, String>>, snapshot: KernelModelSnapshot): KernelModelResult
    fun toolCall(tool: String, args: Map<String, Any>, ctx: KernelRunContext): KernelToolResult
    fun stream(text: String, ctx: KernelRunContext)
    fun cancel(signal: CancellationSignal)
    fun checkpoint(ctx: KernelRunContext): KernelCheckpoint
    fun finish(result: String): String
}

/** Native Adapter: 直接实现 KernelAdapter (K9: 证明不依赖任何 Pi/旧循环状态) */
class NativeAdapter(
    private val runtime: KernelModelRuntime,
    private val harness: KernelHarness,
) : KernelAdapter {
    override val name = "native"

    override fun modelCall(messages: List<Pair<String, String>>, snapshot: KernelModelSnapshot): KernelModelResult {
        return runtime.call(snapshot, KernelModelRequest(messages, 2048, 0.2), null)
    }

    override fun toolCall(tool: String, args: Map<String, Any>, ctx: KernelRunContext): KernelToolResult {
        return harness.invoke(tool, args, ctx)
    }

    override fun stream(text: String, ctx: KernelRunContext) {
        ctx.streamCallback?.invoke(text)
    }

    override fun cancel(signal: CancellationSignal) { signal.cancel() }

    override fun checkpoint(ctx: KernelRunContext): KernelCheckpoint {
        return KernelCheckpoint(completedActions = ctx.stepCount).also { ctx.checkpoint = it }
    }

    override fun finish(result: String): String = result
}

/**
 * K10: 删除 Pi 旧职责 — 入口收敛到 Kernel.
 * 手机原生版: 所有事件入口 → KernelMailboxRegistry → KernelChannelActor → KernelLoop (NativeAdapter).
 * 旧 AgentLoop 不再作为主路径 (runAgent 已切内核; 旧 loop 删除由桌面侧同样推进).
 */
object KernelHost {
    /** 全局唯一 KernelHost (手机版编排) */
    @Volatile private var runtime: KernelModelRuntime? = null
    @Volatile private var harness: KernelHarness? = null
    @Volatile private var adapter: NativeAdapter? = null

    /** 初始化 (app 启动; 与 AgentRuntimeHolder.init 对接) */
    fun init(apiKey: String, baseUrl: String, model: String) {
        if (runtime == null) {
            runtime = KernelModelRuntime(
                connectionFactory = { snap -> KernelRemoteLlmConnection(snap, apiKey) },
            )
        }
        if (harness == null) {
            // Harness 需 tools — 由调用方在 service 可用后 build (见 buildHarness)
        }
    }

    fun buildHarness(rawTools: AndroidAgentTools, budget: KernelBudget): KernelHarness {
        val tools = KernelToolAdapter(rawTools).buildTools()
        return KernelHarness(tools, budget).also { harness = it }
    }

    fun currentRuntime(): KernelModelRuntime? = runtime
    fun currentHarness(): KernelHarness? = harness

    /** 把一次用户输入投递进 Kernel (K3 门: 只投递, 不直接调) */
    fun deliverUserMessage(channelId: String, text: String, source: String): Boolean {
        return KernelCommRuntime.deliverUserMessage(channelId, text, source)
    }

    /** 启动通道 actor (K5) — 事件进来就由 actor 串行执行 */
    fun ensureChannelActor(channelId: String): KernelChannelActor {
        val existing = KernelActorRegistry.get(channelId)
        if (existing != null) return existing
        val mailbox = KernelMailboxRegistry.mailboxFor(channelId)
        val chCtx = KernelChannelContext(channelId)
        val rt = runtime ?: throw IllegalStateException("KernelHost 未 init")
        val actor = KernelChannelActor(channelId, mailbox, chCtx) { chCtx, ev ->
            val runCtx = KernelRunContext()
            val h = harness ?: throw IllegalStateException("Harness 未 build")
            val loop = KernelLoop(rt, chCtx.modelSnapshot ?: KernelModelSnapshot("glm", "glm-5.3", baseUrl = "https://api.bolloon.cn/v1"), h, runCtx)
            object : KernelLoopExecutor {
                override fun execute(): String {
                    val result = loop.executeEvent(ev)
                    chCtx.enqueueOutbound(result)
                    return result
                }
            }
        }
        return KernelActorRegistry.register(actor)
    }

    /** 启停 */
    fun startAllChannels() = KernelActorRegistry.startAll()
    fun closeAllChannels() = KernelActorRegistry.closeAll()
    fun activeChannels(): Int = KernelActorRegistry.activeChannels()

    /** K0 审计: 三道门 */
    fun audit(): List<String> = KernelModuleRegistry.audit(java.io.File("/dev/null"))  // 实际路径由调用方传
}
