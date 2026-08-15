---
title: Android Agent Runtime 架构 (Phase 1-4 路线图)
source: session + AOHP arXiv 调研
created: 2026-08-13
last_confirmed: 2026-08-15
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [android-agent, accessibility, shizuku, llamacpp, aohp, agent-os, phase-1, phase-2, phase-3, phase-4, on-device-verified, ghost, hermes, phone-control, harness-replication]
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

## 链路验证结论 (2026-08-15, 对照主流 on-device 方案)

**结论: on-device 执行链路已全通并接线, 对照 Open-AutoGLM/AppAgent 主流路径确认是正确路线。**

完整链路 (JS → Kotlin → 设备操作):

```text
mobile-agent.ts runLocalAgent(goal)
 → Capacitor RokidBridge.runAgent({goal})           # RokidBridgePlugin.java:477
 → AgentRuntimeHolder.runAgent (后台线程)            # AgentRuntimeHolder.kt:74
 → AgentLoop.run — ReAct 循环 (observe→think→act)   # AgentLoop.kt:45
     ├─ 观察: AndroidAgentTools.build_llm_context     # 无障碍读 UI 树/交互元素/屏幕分类
     ├─ 决策: LlmBackend → RemoteLlm                  # OpenAI 兼容 API (默认 DeepSeek)
     └─ 执行: tap/swipe/type/back/home/launch_app      # AccessibilityService dispatchGesture / ACTION_SET_TEXT
              shell/get_device_info/list_packages      # ShizukuManager + LifecycleGuard
```

路径对照 (2026-08-15 websearch):

| 主流方案 | 设备控制路径 | Bolloon 对应 |
|---------|-------------|-------------|
| AutoGLM/Open-AutoGLM | AccessibilityService (UI 树 + dispatchGesture 注入) | ✅ 同路径 (BolloonAccessibilityService) |
| AppAgent/Mobile-Agent | ADB `shell input` 注入触摸事件 | 部分 (Shizuku shell 兜底) |
| GPT-4o phone / 厂商助手 | 云端截图 + VLM 规划 + 回传指令 | 无 (走本地 ReAct, 不依赖云端规划) |
| 安全研究 (arXiv:2608.08939) | Accessibility 树可被恶意 App 提示注入劫持 | 已内建防护: 用户 Goal → Policy → 工具白名单 → Verification (Phase 4) |

**关键 caveat (2026-08-15 确认):**
1. **无障碍服务需用户手动开启** (`isAccessibilityReady` 是 runAgent 前置, 否则返回 "[错误] 无障碍服务未连接")
2. **LLM apiKey 不在代码里** — 运行时通过 bridge `agentConfigure` 注入 (JS 可调用); 桌面 `~/.bolloon/llm-config.json` 是桌面侧
3. **LocalLlm (GGUF) 是骨架** — on-device 推理未接 llama.cpp JNI (Phase 3 后接)
4. **需 arm64 真机** — x86_64 模拟器 CXR native 库加载失败 (但 Agent 部分不依赖 CXR, 只看无障碍服务)
5. Shizuku-API 13.x 无公开 newProcess → shell 走普通 ProcessBuilder (高特权命令需 UserService 模式)

## 计划 (2026-08-15)

1. **手机端 LLM 配置从桌面同步** ✅ 2026-08-15: `data.*` 同步协议新增 `data.llm-config` 类型 — 桌面 P2PNetwork `registerDataProvider('data.llm-config')` 返回 `~/.bolloon/llm-config.json` 内容, 手机 IndexedDB 保存 → `onLlmConfig` 注入 agent 层 (`setLlmConfig`) → runAgent 前 `agentConfigure`; 未同步默认手机端本机配置。已验证 (p2p-mobile-desktop-bridge.ts PASS)。
2. **Phone API→AgentRuntime 端到端验证** ✅ 2026-08-15: 手机自治控制双面已实现并验证 — P2P 控制面 (`phone.*` 协议) + 本地 HTTP API (`mobile-http-api.ts`, /api/phone/agent/run) 均可触发手机独立 AgentLoop 执行, 手机**不需要经过电脑同意** (verify-phone-agent-api.ts PASS, fallback 模式; 真机 Kotlin AgentRuntime 待 arm64 设备)。
3. **Hermes + Ghost harness 组合** ✅ 2026-08-15: Hermes (生命周期/工具循环/审计) + Ghost (观察/宏/屏幕分类) + **bolloon 核心 harness 复刻进手机 AgentLoop** — 见下节。

## Bolloon 核心 harness 复刻 (2026-08-15, 手机 AgentLoop 对齐桌面)

手机 `AgentLoop.kt` 原来只支持单一 JSON `{"tool":"...","args":{...}}` 解析, 与桌面核心 harness (react-loop.ts 决策表 + parse-tool-call.ts 多格式解析) 能力不对齐。本次复刻:

| 桌面 harness | 手机复刻 | 说明 |
|-------------|---------|------|
| `parse-tool-call.ts` (多格式: JSON/XML/TOOL_CALL/自闭合/中文/对象字面量) | 新 `ToolCallParser.kt` | JSON(name/tool+arguments/args/input)、`<invoke>`/`<function_calls>` XML、`[TOOL_CALL]`、自闭合标签、`调用工具：x(...)`、`tool => "x"`、`tool_name {json}`、think 块剥离 |
| `parse-tool-call.ts` autoSplitCommand | `ToolCallParser.autoSplitCommand` | `command:"pm list packages"` → `command=pm, args="list packages"` |
| `parse-tool-call.ts` alias resolve | `ToolCallParser.ALIASES` | bash→shell, click→tap, input→type, open_app→launch_app 等手机别名表 |
| `react-loop.ts` decideNext case 1 (AI failure sentinel → continue) | `AgentLoop.run` 哨兵分支 | `[AI 服务调用失败]`/`[LLM 调用失败]`/`[错误:` → push 错误进 history 让 LLM 反思; 累计错误达上限 force-exit |
| `react-loop.ts` decideNext case 3 (`<final gen>` → final) | `AgentLoop.run` final 分支 | 含 `<final gen>` 且无可解析工具 → 提取最终答案终止 (替代硬编码 done) |
| `react-loop.ts` decideNext case 4 (unknown tool → continue) | `AgentLoop.run` 未知工具分支 | 提示可用工具集, 让 LLM 换工具 (不再硬 execute 报错) |
| `react-loop.ts` shouldHintToStopSameTool | `AgentLoop.run` 同工具连续失败 | 连续失败 ≥3 次提示换方案 (提示后重置计数) |
| `react-loop.ts` decideContextOverflow / shouldCompactBeforeIteration | `AgentLoop.compactHistory` | 估算 token 超阈值 (maxHistoryTokens=60000) 截断早期历史 |
| `react-loop.ts` shouldForceExit | `AgentLoop.shouldForceExit` | 累计错误 ≥ maxTotalErrors 强制终止 |

兼容性: 旧 `{"tool":"done","summary":...}` 格式仍支持 (`done` 工具与 `<final gen>` 等价)。

验证:
- Kotlin 编译: `gradlew :app:compileDebugKotlin` PASS
- 决策语义镜像测试: `src/test/tool-call-parser-mirror.test.ts` (12 条, 以桌面 parseToolCall 为参考锚点, 对齐手机工具集解析边界) PASS
- 全量: tsc 0 错, vitest 1428/1428, build:web OK

## 自治控制面 (2026-08-15, 手机是独立 Agent 节点)

手机端拥有自己的控制 API, 与桌面 AgentLoop 不同; 信息可以同步 (data.*), 但执行循环是独立的。

```text
P2P 控制面 (phone.* 协议)                    本地 HTTP API (mobile-http-api.ts)
桌面 sendMessage(peer, 'phone.agent.run')   POST /api/phone/agent/run {goal}
    ↓ 经 P2PNetwork /agent/message              ↓ localhost server (Node/真机原生)
mobile-core 路由 phone.* → mobile-agent    core.phone.run(goal)
    ↓                                       ↓
runPhoneAgent(goal): 手机自治执行, 不经电脑
    ├─ native (Capacitor + arm64): bridge.runAgent → Kotlin AgentLoop + AndroidAgentTools
    └─ fallback: runLocalAgent 内置规则 (无 LLM/无障碍也自治可用)
    ↓ 回执
phone.agent.result → 请求方; HTTP 200 {ok,result,mode}
```

协议消息:
- `phone.agent.run` `{goal, requestId?}` → `phone.agent.result` `{ok, goal, result, mode: 'native'|'fallback', did, agentId?, stepCount?}`
- `phone.agent.status` → `phone.agent.status.reply` `{ok, did, mode, llm?, capabilities}`
- `phone.agent.cancel` `{reason?}` → `phone.agent.cancel.reply` `{ok, cancelRequested}`

设计要点:
- **执行循环独立**: 手机端 AgentLoop (Kotlin) / runLocalAgent (fallback) 是手机自己的, 桌面/其他节点只能触发, 不能代执行
- **信息同步**: LLM 配置/会话经 data.* 同步, 与控制执行分离
- **默认自治**: 未同步 LLM 配置时手机用本机默认 (deepseek), 无依赖也可用 fallback 规则

验证: `npx tsx src/test/verify-phone-agent-api.ts` (P2P + HTTP 双面) + `npx tsx src/test/p2p-mobile-desktop-bridge.ts` (LLM 配置同步)。真机 (arm64 + 无障碍) 待验。

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
