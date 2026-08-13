package com.bolloon.agent.rokid

import android.content.Context
import android.content.Intent
import rikka.shizuku.Shizuku
import rikka.shizuku.ShizukuProvider
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * ShizukuManager — Shizuku 系统级工具管理 (Phase 2)
 *
 * 让 Agent 能访问 Android 系统 API (shell / package manager / 设备信息),
 * 通过 Shizuku 借 adb/root 身份 (Android 11+ 可用 Wireless Debugging 启动).
 *
 * 工具:
 *   - shell(command)          — 白名单 shell 命令 (拒绝危险操作)
 *   - get_device_info()       — 设备信息 (Build)
 *   - list_packages(filter)   — 已安装应用包列表
 */
object ShizukuManager {

    /** Shizuku 是否可用 */
    fun isAvailable(): Boolean = Shizuku.pingBinder()

    /** 请求 Shizuku 权限 (adb/root). 返回是否授权 */
    fun requestPermission(context: Context): Boolean {
        return try {
            if (Shizuku.isPreV11() || Shizuku.checkSelfPermission() == 0) {
                true // 已授权
            } else if (Shizuku.shouldShowRequestPermissionRationale()) {
                false // 需要用户先在 Shizuku 应用授权
            } else {
                Shizuku.requestPermission(REQUEST_CODE)
                true
            }
        } catch (e: Exception) {
            false
        }
    }

    private const val REQUEST_CODE = 1000

    /**
     * 执行 shell 命令.
     * Shizuku-API 13.x 无公开 newProcess (private) — shell 走普通 ProcessBuilder (可跑只读/管理命令);
     * 高特权命令 (需 root/adb) 待 UserService 模式扩展 (Phase 2 后续).
     * 白名单: 只放行安全的只读/管理命令, 拒绝破坏性命令.
     */
    fun shell(command: String): String {
        val check = checkCommand(command)
        if (!check.first) return "[shell-guard] ${check.second}"

        return try {
            val process = ProcessBuilder("sh", "-c", command).start()
            val stdout = BufferedReader(InputStreamReader(process.inputStream)).readText()
            val stderr = BufferedReader(InputStreamReader(process.errorStream)).readText()
            process.waitFor()
            (stdout + (if (stderr.isNotBlank()) "\n[stderr]\n$stderr" else "")).trim().take(8000)
        } catch (e: Exception) {
            "[shell 失败] ${e.message}"
        }
    }

    /** 设备信息 */
    fun deviceInfo(): String {
        return try {
            "model=${android.os.Build.MODEL}\n" +
                "manufacturer=${android.os.Build.MANUFACTURER}\n" +
                "android=${android.os.Build.VERSION.RELEASE} (api ${android.os.Build.VERSION.SDK_INT})\n" +
                "device=${android.os.Build.DEVICE}"
        } catch (e: Exception) {
            "[device_info 失败] ${e.message}"
        }
    }

    /** 已安装包列表 (白名单 pm) */
    fun listPackages(filter: String): String {
        val cmd = if (filter.isBlank()) "pm list packages" else "pm list packages | grep -i '$filter'"
        return shell(cmd)
    }

    /**
     * shell 命令白名单检查 — 拒绝破坏性/提权操作 (Hermes lifecycle_guard 模式).
     * 返回 (allowed, reason?)
     */
    private fun checkCommand(cmd: String): Pair<Boolean, String> {
        val lower = cmd.trim().lowercase()
        val denied = listOf(
            "rm -rf /", "rm -rf ~", "mkfs", "dd if=", "shred", "chmod 777 /",
            "reboot", "shutdown", "factory reset", "format", "wipe",
            "kill -9 1", "pm uninstall --user 0", "pm clear", "pm disable",
            "settings put global", "settings put secure", "iptables",
        )
        for (d in denied) {
            if (lower.contains(d)) return false to "shell 命令被拒 (危险模式: $d)"
        }
        return true to ""
    }
}
