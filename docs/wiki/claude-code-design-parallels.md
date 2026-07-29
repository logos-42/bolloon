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
>
> 最新更新：2026-07-29 — 实现 Phases 1-4 (Tool pre-filter, Snip, Context Collapse, Hook)

## 核心结论：1.6% vs 98.4%

Claude Code 只有 **1.6% 是真正的 AI 决策逻辑**，剩下 **98.4% 是确定性基础设施**——权限门、上下文管理、工具路由、恢复逻辑。

Bolloon 核心发现一致：ReAct loop 只是 `while` 循环，**真正难的是 loop 之外那一圈 harness**。

## Bolloon 与 Claude Code 对照

| 维度 | Claude Code | Bolloon | 状态 |
|------|-------------|---------|------|
| Agent loop | `queryLoop` (AsyncGenerator) | `runReActLoop` / `promptWithPivotLoop` | ✅ 已有 |
| 上下文管理 | 5 层渐进压缩 (Budget→Snip→Microcompact→Collapse→Auto-Compact) | session-window L0-L4 + snip-collapse + exhaust-scrubber | ✅ **完整实现** |
| 安全姿态 | deny-first (7 层防御) | DenyPipeline (deny-list → permission → hooks → judgment) | ✅ **统一管道** |
| 工具注入 | 5 步装配 (枚举→mode→deny→MCP→去重) | `registerBuiltinTools` + DenyPipeline 过滤 + MCP 发现 | ✅ **统一过滤** |
| 存储 | append-only JSONL | session JSON + **JSONL append dual-write** | ✅ **JSONL 新增** |
| Subagent | 6 类型 (SkillTool/AgentTool) | delegate_to_engine + **sidechain transcript** | ✅ **Sidechain 新增** |
| 扩展 | Hooks(零成本) → Skills → Plugins → MCP(高成本) | Hook + skills + external-engines | ✅ **Hook 新增** |
| 记忆 | LLM 扫描 memory 文件头，无向量库 | LLM 摘要 → summary.md | ✅ 已有 |
| 权限恢复 | resume 时**永不恢复权限** | 同 (每 session 重建) | ✅ 已有 |

## 7 层安全防御对照

| 层 | Claude Code | Bolloon 对应 | 状态 |
|----|-------------|-------------|------|
| 1 | **Tool pre-filter** (deny 工具从模型视野删除) | `denyTool()` 过滤 getToolDefinitions + native API tools | ✅ 2026-07-29 实现 |
| 2 | **Deny-first 统一管道** | `DenyPipeline` (deny-list → permission → hooks) + judgment | ✅ 2026-07-29 统一 |
| 3 | Permission mode 约束 (3 种模式) | permission-mode 路由 | ✅ 已有 |
| 4 | Auto-mode ML 分类器 | (无) | ❌ 未实现 |
| 5 | Shell 沙箱 | (无) | ❌ 未实现 |
| 6 | Resume 时不恢复权限 | session 重建重新认证 | ✅ 已有 |
| 7 | **Hook 拦截** (PreToolUse 可拒绝) | `HooksEngine.fire('preToolUse')` 返回 deny | ✅ 2026-07-29 实现 |

> **注意**：Claude Code 共享 token 预算导致纵深退化的教训——Bolloon 的 judgment+exhaust-scrubber 也共享 token 预算，有同样风险。

## 5 层上下文压缩对照

| 阶段 | Claude Code | Bolloon | 状态 |
|------|-------------|--------|------|
| **Budget Reduction** | 单条消息大小限制 | snip-collapse.ts maxMessageChars=2000 | ✅ 2026-07-29 实现 |
| **Snip** | 裁掉老历史 | snip-collapse.ts 超 60 条从老裁切，保护工具链 | ✅ 2026-07-29 实现 |
| Microcompact | cache-aware 细粒度压缩 | memory-compressor (≥4 条触发) | ✅ 已有 |
| **Context Collapse** | 读时虚拟投影，原始不破坏 | snip-collapse.ts applyPreModelPipeline 返回投影 | ✅ 2026-07-29 实现 |
| Auto-Compact | 模型生成完整摘要 | compressSessionToMemory (LLM 摘要) | ✅ 已有 |

## 新实现文件索引 (2026-07-29)

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/bootstrap/snip-collapse.ts` | ~180 | Phase 2+3: Budget Reduction → Snip → Context Collapse 管道 |
| `src/hooks/hooks-engine.ts` | ~400 | Phase 4: 8 种事件, 2 种执行模式 (shell/LLM), YAML 配置, preToolUse deny |
| `src/hooks/hooks.example.yaml` | 45 | Hook 配置示例 (pre-commit / backup / safety-check / log / error) |
| `src/agents/deny-pipeline.ts` | ~140 | Unified DenyPipeline (deny-list + permission + hooks) |
| `src/agents/session-store.ts` | +80 | JSONL appendMessageJsonl + loadFromJsonl + dual-write |

pi-sdk.ts 改动：~120 行增量 (deny 列表 + Hooks + DenyPipeline + Snip/Collapse + env 开关)

## 仍缺失的功能

| 特性 | 关键度 | 说明 |
|------|--------|------|
| Auto-mode ML 分类器 | 低 | Claude Code 用独立 LLM 调用判断权限，token 成本高，优先级低 |
| Shell 沙箱 | 低 | 当前用 shell-guard 做路径白名单，完整沙箱需要大量基础设施 |
| Claude Code 式 27 事件 Hook | 低 | 当前 8 事件，后续可逐步对齐 |
## Bolloon 七阶段实现对比 Claude Code 原型

| Claude Code 原型 | Bolloon 实现 | 差异评估 |
|-----------------|-------------|---------|
| `queryLoop` 9 步管道 | `runReActLoop` while 循环 | Claude Code 多 streaming pipeline 和 stop condition 的显式化，Bolloon 更简单但功能等价 |
| 5 层压缩 (Budget→Snip→Microcompact→Collapse→Auto) | 5 层 (Budget→Snip→Compactor→Collapse→Summary) | Bolloon Memory Compressor ≈ Microcompact，但 Claude Code 的 Microcompact 是 cache-aware 的 |
| 7 层 deny-first 防御 | DenyPipeline (deny-list + permission + hooks) + judgment | Bolloon 现在也是统一管道了，组件级直接对齐 |
| Hook (27 事件 × 4 模式) | 8 事件 × 2 模式 (shell/LLM) | Claude Code 的事件粒度更细 (27 vs 8)；执行模式多了 webhook 和 subagent |
| append-only JSONL | JSONL dual-write + append | Bolloon 现在是双写：旧 JSON 兼容 + 新 JSONL 追加，过渡期安全 |
| Subagent sidechain | delegate.ts sidechain JSONL | Bolloon 记录每次委派的完整 stdout/stderr/exit 到 ~/.bolloon/sidechains/ |
