---
title: Claude Code Architecture — Bolloon 对照参考
source: anal-claude-2026-07-17
created: 2026-07-29
last_confirmed: 2026-07-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
source_hash: 3c9fa0547004d6a2
compiled_from: [anal-claude-2026-07-17]
---

# Claude Code Architecture — Bolloon 对照参考

> 来源：Claude Code 源码和 Dive-into 论文架构分析 (`anal-claude.md`)

## 核心结论：1.6% vs 98.4%

Claude Code 只有 **1.6% 是真正的 AI 决策逻辑**，剩下 **98.4% 是确定性基础设施**——权限门、上下文管理、工具路由、恢复逻辑。

Bolloon 核心发现一致：ReAct loop 只是 `while` 循环，**真正难的是 loop 之外那一圈 harness**。

## Bolloon 与 Claude Code 对照

| 维度 | Claude Code | Bolloon |
|------|-------------|---------|
| Agent loop | `queryLoop` (AsyncGenerator) | `runReActLoop` / `promptWithPivotLoop` |
| 上下文管理 | 5 层渐进压缩 (Budget→Snip→Microcompact→Collapse→Auto-Compact) | session-window L0-L4 + exhaust-scrubber 背压 |
| 安全姿态 | deny-first (7 层防御) | judgment 正负向门 + permission-mode |
| 工具注入 | 5 步装配 (枚举→mode→deny→MCP→去重) | `registerBuiltinTools` + MCP 发现 |
| 存储 | append-only JSONL | session JSON + chat-archive monthly |
| Subagent | 6 类型 (SkillTool/AgentTool) | delegate_to_engine (外部编码工具) |
| 扩展 | Hooks(零成本) → Skills → Plugins → MCP(高成本) | skills + external-engines |
| 记忆 | LLM 扫描 memory 文件头，无向量库 | LLM 摘要 → summary.md |
| 权限恢复 | resume 时**永不恢复权限** | 同 (每 session 重建) |

## 7 层安全防御对照

| 层 | Claude Code | Bolloon 对应 |
|----|-------------|-------------|
| 1 | Tool pre-filter (deny 工具从模型视野删除) | tool 注册时筛选 |
| 2 | Deny-first 规则评估 | judgment injectNegativeGuard |
| 3 | Permission mode 约束 (7 种模式) | permission-mode 路由 |
| 4 | Auto-mode ML 分类器 | (无) |
| 5 | Shell 沙箱 | (无) |
| 6 | Resume 时不恢复权限 | session 重建重新认证 |
| 7 | Hook 拦截 | (无) |

> **注意**：Claude Code 共享 token 预算导致纵深退化的教训——Bolloon 的 judgment+exhaust-scrubber 也共享 token 预算，有同样风险。

## 5 层上下文压缩对照

| 阶段 | Claude Code | Bolloon |
|------|-------------|---------|
| Budget Reduction | 单条消息大小限制 | message-renderer truncation |
| Snip | 裁掉老历史 | session-window LRU |
| Microcompact | cache-aware 细粒度压缩 | memory-compressor (≥4 条触发) |
| Context Collapse | 读时虚拟投影 | (无) |
| Auto-Compact | 模型生成完整摘要 | compressSessionToMemory (LLM 摘要) |

## Bolloon 可借鉴的方向

1. **零成本 Hook** — 目前 Bolloon 没有 hook 机制，全靠 sse + judgment
2. **append-only JSONL** — 当前 session JSON 是破坏性写入，可改为 append-only
3. **Subagent context 隔离** — `delegate_to_engine` 已隔离，但子 agent sidechain 机制待补
4. **Deny-first 统一层** — 当前 permission 分散在 judgment/sse/server 三处，可抽成统一管道
