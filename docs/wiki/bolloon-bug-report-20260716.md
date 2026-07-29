---
title: Bolloon Bug Report Summary 2026-07-16
source: bolloon-bug-report-2026-07-16
created: 2026-07-29
last_confirmed: 2026-07-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
source_hash: 5b0d6145037c174c
compiled_from: [bolloon-bug-report-2026-07-16]
---

# Bolloon Bug Report Summary 2026-07-16

> 来源：用户整理的 10 个 Bolloon v0.2.15 bug 及修复尝试 (`bolloon-bug-report-20260716.md`)

## Bug 状态总览

| # | Bug | 严重度 | 状态 | 修复版本 |
|---|-----|--------|------|---------|
| 1 | 会话记忆缺失（AI 不记得历史） | P0 | ✅ 已修 | 已有 session-window L0 架构 |
| 2 | deepseek-chat 模型停用迁移 | P0 | ⚠️ 待检查 | `~/.bolloon/llm-config.json` 用户侧 |
| 3 | 无原生 Tool Calling | P1 | ✅ 已修 | v0.3.18-0.3.19 (parseToolCall 改进) |
| 4 | usePivotLoop 绕过 runReActLoop | P1 | ✅ 已修 | v0.3.18 |
| 5 | Native Tool Calls 被读取后丢弃 | P1 | ✅ 已修 | v0.3.19 |
| 6 | Tool Role 被 buildMessages 转为 User Role | P1 | ⚠️ 待确认 | `buildMessages()` 需检查 |
| 7 | 空 Content + Tool Calls 误判为 API 错误 | P1 | ✅ 已修 | v0.3.18-0.3.19 |
| 8 | Session 存储多路径脏数据 | P2 | ✅ 已有机制 | 三层会话缓存架构 (v0.2.12) |
| 9 | 僵尸进程端口耗尽 | P2 | ⚠️ 待做 | 未加自动清理 |
| 10 | deepseek-v4-flash Thinking 与 tool_choice 冲突 | P2 | ✅ 已修 | tool_choice 已改为 'auto' |

## 关键待修项

### Bug 2: deepseek-chat 迁移
- `deepseek-chat` 已于 2026-07-24 停用
- 用户 `~/.bolloon/llm-config.json` 中的模型名需改为 `deepseek-v4-flash`
- Bolloon 代码中已无硬编码 `deepseek-chat` (v0.3.19+)

### Bug 6: Tool Role 保留
- `buildMessages()` 中 tool 消息可能被转成 user role (为兼容 MiniMax)
- DeepSeek API 要求 tool role 配对
- 修复方案：`lastHadToolCalls` 追踪，保留 `role: 'tool'`

### Bug 9: 僵尸进程管理
- 启动时增加端口健康检查 + 旧进程清理逻辑
- 当前靠用户手动 `taskkill` 或 `kill`

## 修改文件历史

原始报告指向 `dist/`（编译产物），根据 AGENTS.md §5.1：

> `dist/` 禁止手改（会被 build 覆盖）

所有修复应改 `src/` 源文件后重新 build。实际修复已符合此规则。
