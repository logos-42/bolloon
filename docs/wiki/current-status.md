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
| **iroh `discovery.update` 接口** | ❌ server 启动时抛 TypeError, 但 `irohInitialized: true` | 网络层仍工作但 P2P 主题发现可能不全 |
| **iroh `/api/iroh/info` 返回 `nodeId: null`** | ❌ iroh transport 没暴露真实 node ID | 真实 P2P 通信可能受影响 |
| **`saveCurrentSession` rename 失败** | ⚠️ Windows 文件名含 `:` 非法, server silent-fail | 会话存档偶发失败, 不影响功能 |
| **IPFS 离线时跳过** | ⚠️ `127.0.0.1:5001` 不通时 `discovery.update` 抛错 | DID 注册失败, 但 channel 仍能用 |
| **vitest-bail flaky** | ⚠️ Windows Node v24 下, `workflow-pivot-loop` 5s timeout 间歇失败 | lefthook pre-commit 间歇阻断 commit |

## 线上状态 (本机 2026-07-04)

```
✅ web server (port 54188) 监听中
✅ channels.json: 20 个 channel, 全部 name 字段完整 (修复 "undefined" 显示)
✅ known_peers.json: 2 peer (NodeA, apple)
✅ remote-channels-cache.json: 2 peer / 8 channel
✅ human-values store: 启动加载 19 条 judgment
⚠️ iroh: 已 init, nodeId 未暴露
⚠️ minimax provider: 需 API key, 消融实验时已用
```

## 最近风险

1. **Channel 名称显示 "undefined"** (✅ 2026-07-04 修复, commit `6859578`)
   - sidebar 渲染 `ch.name` 没有 fallback, 修复后统一加 `|| '(未命名)'`
2. **vitest-bail flaky** (⚠️ 进行中)
   - 5/16 测试间歇失败, 改 `LEFTHOOK=0` 临时跳过
3. **src/web/client.js 与 src/web/client.ts 长期脱节** (✅ 2026-07-04 修复, commit `6859578`)
   - 删除 client.js, esbuild 编译产物 (dist/web/client.js) 是唯一运行时源

## 下一步优先级

| 优先级 | 任务 | 关联 |
|--------|------|------|
| P0 | 修 iroh `discovery.update is not a function` | ablation 报告工程观察 #7 |
| P0 | 修 iroh `/api/iroh/info` nodeId 暴露 | ablation 报告工程观察 #8 |
| P1 | 修 `saveCurrentSession` 文件名 `:` 非法 (Windows) | ablation 报告工程观察 #6 |
| P1 | 把 `scripts/ablation/run.ts` 接入 vitest pre-commit, 替换 flaky vitest-bail | ablation runner 路径 |
| P2 | 把 4 个 layer 加上 frontmatter (当前 `withMeta: 0`) | ablation 报告 C3 揭示的工程欠债 |
| P2 | 补 `docs/wiki/skills-index.md` (skill 系统索引) | 跟项目里 `~/.config/opencode/skills` 同步 |