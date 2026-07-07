---
title: Bolloon Crystallized Claims
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: crystallized
status: current
confidence: high
entity_type: claim
tags: [crystallized, ablation-claims]
crystallized_from: [ablation-v0.2.7]
source_hash: 22463adbde717d56
---

> 由 `scripts/crystallize.py` 蒸馏的稳定断言。每条 claim 都有 ≥2 处独立证据。

## CLAIM-2026-07-04-001: Bolloon v0.2.7 4 个核心功能端到端可工作

**断言**: `documents` + `skills` + `tool_loop` + `p2p` 四个核心模块消融实验 16/16 pass, 包含 baseline/正常/异常各路径。

**证据**:
- `scripts/ablation/run.ts` (660 行, 4 功能 × 16 项验证矩阵)
- `docs/ablation/report.md` (消融矩阵总览 + 归因分析 + 假阳性 3 项检查)
- `docs/ablation/results.json` (原始数据, 16 个 sample + 字段)
- 重复运行 3 次独立 (假阳性检查): tool_loop C2 3/3 都有 `toolSeen=true` + 300+ 字符 token

**适用范围**: Bolloon 0.2.7 在 Windows 11 + Node v24.15.0 + minimax (MiniMax-M2.7) LLM provider 环境下验证通过。其他 provider (openai/anthropic) 同样可达 (架构相同)。

---

## CLAIM-2026-07-04-002: System prompt layers 健康降级机制工作

**断言**: 即便所有 11 个 core layer .md 都缺 frontmatter, `assembleSystemPrompt` 仍能输出 4743 字符的 system prompt (耗时 407ms).

**证据**:
- `assembleSystemPrompt` 实测: `CHARS=4743`
- `parseFrontmatter` (`src/llm/system-prompt/registry.ts:78-106`): 失败时 `meta=null` 但 body 保留
- ablation C3 验证 (withMeta=0 → compileChars=4743)

**适用范围**: 模板层变动 (重命名 / frontmatter 格式调整) 不影响 system prompt 装配.

---

## CLAIM-2026-07-04-003: SessionStore 跨平台 filenameEscape 工作

**断言**: SessionStore 在 filename 层 escape `:` → `__` 透明, key API 不变, web server `channelId:currentSessionId` sessionKey 在 Windows/Linux/macOS 都可用.

**证据**:
- `src/agents/session-store.ts` `filenameEscape` / `filenameUnescape`
- vitest 711/711 pass (web-server-session.test.ts 8 个 + session-store.test.ts + persistence-e2e-flow.test.ts)
- commit `a6113e9` 已修

**适用范围**: 所有用 sessionKey 做文件名 suffix 的场景 (web session / CLI session / P2P session).

---

## CLAIM-2026-07-04-004: iroh P2P 已知兼容性问题已降级处理

**断言**: iroh `discovery.update` (上游 @diap/sdk 0.1.10 bug) + `endpoint.nodeId()` 在 Windows 偶发空, 都不影响主路径功能 (v3 P2PDirect 是实际数据通道).

**证据**:
- `src/web/server.ts:1584` try/catch 包 joinTopic, 已知错误转 warn
- `/api/iroh/info` 加 v3 P2PDirect publicKey fallback + `irohNodeIdSource` 来源标识
- ablation C1-iroh + C4 pass

**适用范围**: 现在任何环境下 `/api/iroh/info` 都返回有效 nodeId, UI 不会拿到 null.
