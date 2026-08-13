package com.bolloon.agent.rokid

/**
 * LifecycleGuard — 防自杀命令拒绝 (Phase 4, 参考 Hermes cron/lifecycle_guard.py)
 *
 * Hermes 模式: 拒绝任务里含"重启自身服务"形状的命令 (launchctl kickstart / systemctl restart / pkill),
 * 防 "agent 自己安排自杀 → supervisor 复活 → 自动 resume → 再自杀" 的 SIGTERM 循环.
 *
 * 命令形状锚定: 只匹配真实命令标识符, 不匹配散文 (误报率低).
 * Android 场景: 拒绝 shell 里 kill/杀 Bolloon 自身进程 / 停无障碍服务.
 */
object LifecycleGuard {

    /** 自生命周期命令形状 (denylist) — 命中即拒 */
    private val SELF_LIFECYCLE_PATTERNS = listOf(
        // 杀自身进程
        Regex("""(^|\s)(kill|killall|pkill|taskkill)[\s-].*(bolloon|com\.bolloon)""", RegexOption.IGNORE_CASE),
        Regex("""(^|\s)(am force-stop|am kill)[\s-]+(com\.bolloon[^\s]*)""", RegexOption.IGNORE_CASE),
        // 停/禁用无障碍服务
        Regex("""(^|\s)(settings put secured accessibility_enabled|pm disable)[\s-]""", RegexOption.IGNORE_CASE),
        // 卸载自身
        Regex("""(^|\s)pm uninstall[\s-]+com\.bolloon""", RegexOption.IGNORE_CASE),
        // 重启系统 (会导致服务全断)
        Regex("""(^|\s)(reboot|shutdown|svc power reboot)[\s-]?""", RegexOption.IGNORE_CASE),
    )

    /**
     * 检查一条命令是否含"自生命周期"形状.
     * @return null = 放行; 非 null = 拒绝原因
     */
    fun check(command: String): String? {
        val cmd = command.trim()
        if (cmd.isEmpty()) return null
        for (pattern in SELF_LIFECYCLE_PATTERNS) {
            if (pattern.containsMatchIn(cmd)) {
                return "命令被 LifecycleGuard 拒绝 (含自生命周期形状: $pattern)"
            }
        }
        return null
    }
}
