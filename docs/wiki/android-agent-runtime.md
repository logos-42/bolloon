---
title: Android Agent Runtime 架构 (Phase 1-4 路线图)
source: session + AOHP arXiv 调研
created: 2026-08-13
last_confirmed: 2026-08-13
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [android-agent, accessibility, shizuku, llamacpp, aohp, agent-os, phase-1, phase-2, phase-3, phase-4]
---

# Android Agent Runtime 架构 (Phase 1-4)

> 目标: 把 Bolloon 手机端升级为真正的 **On-device Android Agent** — 手机输入任务 → Agent 自己打开 App/点击/输入/返回。
> 参考: AOHP (arXiv:2606.23449) — Agent 作为 Android OS 一等参与者; AutoDroid (arXiv:2308.15272) — on-device 自动化。

## 总体架构

```text
手机上的聊天入口 → 本地/远程 LLM → Agent Loop → Android Tools → 手机自身
```

## Phase 1: 手机 Agent (✅ 已落地)

Agent 在手机, LLM 远程 (OpenAI 兼容 API)。无 root, 用 AccessibilityService。

- `BolloonAccessibilityService.kt` — UI 树读取 (getUiTree/getScreenText) + 全局操作 (tap/back/home, dispatchGesture)
- `AndroidAgentTools.kt` — 8 工具: observe_screen/get_ui_tree/tap/swipe/type/back/home/launch_app (返回 JSON)
- `AgentLoop.kt` — Observe→Think→Act→Observe 循环 (20 步上限, LLM 决策 JSON 解析)
- `RemoteLlm.kt` — 远程 LLM 客户端 (OpenAI 兼容)
- `AgentRuntimeHolder.kt` + Capacitor bridge (runAgent/agentStatus/agentConfigure) — webview UI 集成

**验证**: APK 打包成功; 需真机开启"Bolloon 无障碍服务"后测试闭环。

## Phase 2: Shizuku 系统级工具 (✅ 已落地)

- `ShizukuManager.kt` — Shizuku 连接/权限 + shell 白名单 (拒绝 rm -rf / mkfs 等破坏性命令)
- 工具扩展: shell(command) / get_device_info / list_packages
- manifest 注册 `ShizukuProvider`
- 注: Shizuku-API 13.x 无公开 newProcess → shell 走普通 ProcessBuilder (只读命令可跑);
  高特权命令需 UserService 模式 (后续)

**验证**: 编译 + APK 打包通过; 需真机 Shizuku 授权测试。

## Phase 3: 本地 LLM (✅ 架构落地, llama.cpp 推理后接)

- `LlmBackend` 接口 (isAvailable/chat/name) — RemoteLlmBackend / LocalLlm
- `ModelRuntime` — 本地/远程切换 (preferLocal)
- `LocalLlm` 骨架 — GGUF 模型路径管理; 真实推理需集成 llama.cpp android 源码 (examples/llama.android, JNI)

**下一步**: 集成 llama.cpp android 源码 + 下载 GGUF 模型 (真机验证)。

## Phase 4: Agent OS (✅ App 层落地, AOSP 后续)

AOHP 路线: Agent 成为 OS-level actor。当前在 App 层落地 OS 级服务 (参考 Hermes 设计), AOSP 系统服务后续。

### 已落地 (参考 Hermes)

| 组件 | 文件 | Hermes 参考 | 说明 |
|------|------|------------|------|
| 生命周期状态机 | `AgentLifecycleManager.kt` | subagent_lifecycle.py | PENDING→STARTING→RUNNING→SUCCEEDED/FAILED/INTERRUPTED; 两段式取消 CANCEL_REQUESTED→CANCELLED; 终态保留 10 条 |
| 防自杀 guard | `LifecycleGuard.kt` | cron/lifecycle_guard.py | 拒绝 shell 含杀自身/停无障碍/卸载/重启形状; 命令形状锚定 (接入 ShizukuManager.shell) |
| 动作审计 | `AgentAuditLog.kt` | Hermes audit 设计 | append-only JSONL 落盘 filesDir/audit/, 每步工具调用/取消/完成记录 |
| 集成 | AgentLoop/AgentRuntimeHolder | — | 每步检查取消; 审计每动作; bridge 加 cancelAgent/agentStatus(lifecycle) |

### 关键设计点 (AOSP 前置调研)

```text
AOSP
 ├── Agent Service (System Server)
 ├── Android Agent API
 └── Agent 生命周期 / 权限 / 审计
```

### 关键设计点 (前置调研)

| 方面 | 设计 |
|------|------|
| 系统服务 | 新增 `AgentManagerService` (SystemServer 注册), 提供 Agent 生命周期 (create/run/stop) |
| 权限 | Agent 权限模型: 工具级 permission (UI 操作/系统 API), 用户可见 + 可撤销 |
| 审计 | Agent 动作审计日志 (AuditLog), 所有 UI/系统操作可回溯 |
| 安全 | 提示注入防护: UI 文本不作为未经验证的指令; 用户 Goal → Policy → Tool Permission → Verification 链 |
| 降级路径 | AOSP 未就绪时: 当前 App + Shizuku 已覆盖大部分能力 |

### 安全提醒 (arXiv:2608.08939)

Android Agent 通过 Accessibility Tree / 屏幕文字获取环境时, 恶意 App 可注入提示诱导 Agent 偏离目标。
架构必须: **User Goal → Policy → Tool Permission → Agent → Tool → Verification**,
而非 LLM 随意执行。

## 验证矩阵

| 项 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|----|---------|---------|---------|---------|
| 编译 | ✅ | ✅ | ✅ | ✅ |
| APK | ✅ 16MB | ✅ | ✅ 25.4MB | 🔲 |
| 真机 | 待测 | 待测 | 待测 | 🔲 |

## Ghost 借鉴 (2026-08-13, D:\AI\Agent-andriod = Ghost in the Droid)

Ghost (io.github.ghost-in-the-droid/android-agent): Android+iOS Agent 框架, 62 MCP 工具, cloud/on-device 推理。
借鉴落地:

| Ghost 设计 | Bolloon 落地 | 文件 |
|-----------|-------------|------|
| get_interactive_elements (只提取可交互元素+center, 省token) | getInteractiveElements() | BolloonAccessibilityService.kt |
| get_screen_tree (LLM 友好缩进树, 跳纯容器) | getScreenTree() | 同上 |
| classify_screen (home/search/dialog/error/loading) | classifyScreen() | 同上 |
| build_llm_context (all-in-one 观察快照) | build_llm_context 工具, AgentLoop 每步用它 | AndroidAgentTools.kt |
| MacroRecorder (录 tap/swipe/type 序列 + 相对时间戳 + 倍速重放 + JSON) | MacroRecorder.kt + bridge macro() | MacroRecorder.kt |

未借鉴 (后续候选): OCR (RapidOCR), 调度器 (per-phone job queue + 超时 SIGTERM→SIGKILL), skill 系统, WebRTC 串流。

## 关联

- 代码: `android/app/src/main/java/com/bolloon/agent/rokid/` (BolloonAccessibilityService / AndroidAgentTools / AgentLoop / RemoteLlm / ShizukuManager / LlmBackend / AgentRuntimeHolder)
- 参考: https://a2ui.org/specification/v1.0-a2ui/ (UI 渲染) + AOHP/AutoDroid (arXiv)
