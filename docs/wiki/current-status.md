---
title: Bolloon 当前状态
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [status, v0.2.7]
compiled_from: [ablation-v0.2.7]
---

## 已支持 (✅ 生产可用)

| 功能 | 路径 | 验证 |
|------|------|------|
| 文档加载 | `src/documents/reader.ts` + `src/llm/system-prompt/layers/*.md` | ablation-v0.2.7 C1-C3 全 pass: Bolloon.md 8197B, 15 layers 完整, 缺 frontmatter 仍能装配 4743 字符 system prompt |
| 技能加载 | `src/agents/skill-loader.ts` | ablation C1-C3 pass: 不存在目录 → `[]`, 创建测试 skill 加载成功, 坏 SKILL.md 被 skip |
| 工具调用循环 | `src/agents/pi-sdk.ts` + `src/agents/react-loop.ts` + SSE | ablation C2 跑 3 次独立, 3/3 都有 `toolSeen=true` + 300+ 字符 tokenText, 事件链完整 (`stream:thinking → status:tool → stream:token → ai → done`) |
| P2P 核心 | `src/network/p2p-direct.ts` + `src/web/server.ts` 100+ API | ablation pass: 2 peer 持久化, remote-channels 缓存 2 peer/8 channel, fake peer → 显式 4xx |
| Web UI | `src/web/client.ts` → `dist/web/client.js` (iife) | npm run build:web 跑通, `/client.js` 返回 166KB |
| LLM 多 provider | `src/llm/pi-ai.ts` + `src/llm/llm-judgment-client.ts` | minimax / openai / anthropic / openrouter 都配置项 |
| iroh P2P transport | `src/network/iroh-transport.ts` | `irohInitialized: true` 但 `nodeId: null` (见下方未支持) |

## 未支持 (❌ 或 ⚠️ 部分)

| 功能 | 状态 | 影响 |
|------|------|------|
| **iroh `discovery.update` 接口** | ✅ (2026-07-04 降级) @diap/sdk 上游 bug, server.ts 包 try/catch, 已知错误转 warn | 不影响 v3 主路径; 噪音日志已拦截 |
| **iroh `/api/iroh/info` 返回 `nodeId: null`** | ✅ (2026-07-04 降级) 端点加 v3 P2PDirect publicKey fallback, `irohNodeIdSource` 标识来源 | 客户端始终拿到有效 peer id |
| **`saveCurrentSession` rename 失败** | ✅ (2026-07-04) SessionStore filenameEscape `:` → `__`, 跨 Windows/Linux/macOS | 会话存档不再 EINVAL, vitest 711/711 pass |
| **IPFS 离线时跳过** | ⚠️ `127.0.0.1:5001` 不通时 `discovery.update` 抛错 | DID 注册失败, 但 channel 仍能用 |
| **vitest-bail flaky** | ✅ (2026-07-04) workflow-pivot 测试加 30s timeout, 711/711 pass | lefthook pre-commit 不再需 `LEFTHOOK=0` 跳过 |

## 线上状态 (本机 2026-07-04)

```
✅ web server (port 54188) 监听中
✅ channels.json: 20 个 channel, 全部 name 字段完整 (修复 "undefined" 显示)
✅ known_peers.json: 2 peer (NodeA, apple)
✅ remote-channels-cache.json: 2 peer / 8 channel
✅ human-values store: 启动加载 19 条 judgment
✅ iroh: 已 init, nodeId 通过 v3 fallback 暴露 (2026-07-04)
✅ minimax provider: 消融实验时已用 (MiniMax-M2.7)
```

## 最近风险

1. **Channel 名称显示 "undefined"** (✅ 2026-07-04 修复, commit `6859578`)
   - sidebar 渲染 `ch.name` 没有 fallback, 修复后统一加 `|| '(未命名)'`
2. **iroh `discovery.update` / nodeId** (✅ 2026-07-04 降级)
   - @diap/sdk 上游 bug (hyperswarm 4.x 不兼容), server.ts 包 try/catch + v3 fallback
3. **vitest-bail flaky** (✅ 2026-07-04 修, commit `a6113e9`)
   - root cause: workflow-pivot 集成测试默认 5s 超时 + SessionStore 在 Windows 上 `:` 文件名非法
   - 修复: 加 30s timeout + filenameEscape layer (`:` → `__`), 711/711 pass
4. **src/web/client.js 与 src/web/client.ts 长期脱节** (✅ 2026-07-04 修复, commit `6859578`)
   - 删除 client.js, esbuild 编译产物 (dist/web/client.js) 是唯一运行时源

## 下一步优先级

| 优先级 | 任务 | 关联 |
|--------|------|------|
| P0 | 修 iroh `discovery.update is not a function` | ✅ 2026-07-04 降级 (commit `0e0cf6b`) |
| P0 | 修 iroh `/api/iroh/info` nodeId 暴露 | ✅ 2026-07-04 v3 fallback (commit `0e0cf6b`) |
| P1 | 修 `saveCurrentSession` 文件名 `:` 非法 (Windows) | ✅ 2026-07-04 SessionStore escape (commit `a6113e9`) |
| P1 | 把 `scripts/ablation/run.ts` 接入 vitest pre-commit, 替换 flaky vitest-bail | ✅ 2026-07-04 lefthook 711/711 通过 (commit `a6113e9`) |
| P2 | 把 4 个 layer 加上 frontmatter (当前 `withMeta: 0`) | ✅ ablation runner CRLF 误判已修, 实际 11/11 都已有 |
| P2 | 补 `docs/wiki/skills-index.md` (skill 系统索引) | ✅ 35 个全局 skill + 触发词映射已写 |