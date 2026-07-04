---
title: Bolloon 项目概览
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [overview, ai-agent, p2p]
compiled_from: [ablation-v0.2.7, ablation-runner]
---

## 一句话定义

**Bolloon** 是一个本地优先的 P2P AI 智能体网络 — 每台机器跑一个 bolloon 实例,自动积累人类判断力,跨机器互联互通,无需中心服务器。

## 主线目标

让个人 AI 助手从"会话即忘"升级到"持续学习 + 跨设备同步"。核心机制:
- **System Prompt Layers** (灵魂/性格/Agent 文档): `src/llm/system-prompt/layers/*.md` 按 priority + appliesTo 装配
- **Skills 协议**: Anthropic Agent Skills 标准 + bollharness frontmatter 双兼容, body 作为 Markdown 注入 LLM context
- **ReAct Loop + SSE**: `/message` 异步返回 202, 通过 SSE 推流 `stream:token` + `status:tool` + `ai:final`
- **P2P via iroh**: relay URL + 64-char hex publicKey = peer identity, agent.meta.list 同步 channel 列表

## 交付边界

- ✅ **Local-first**: `~/.bolloon/sessions/channels.json` + `cache/*.json` 全部本机持久化
- ✅ **iOS/Android/web 三端**: web 用 esbuild iife 编译, electron 包壳
- ✅ **Multi-LLM**: openai / anthropic / openrouter / minimax provider 可切
- ⚠️ **IPFS 依赖**: DID 注册走 `127.0.0.1:5001`, 离线时跳过
- ❌ **中心化账号**: 故意不做, 设计上走 P2P + DID 自管

## 技术栈

- **Runtime**: Node.js v22+ (开发 v24), TypeScript ESM
- **Build**: tsc + esbuild (web) + electron-builder (electron)
- **P2P**: @rayhanadev/iroh (Rust FFI)
- **Storage**: JSON 文件 + 内存缓存 + sessions/channels.json
- **Web**: 原生 HTML + ESM (无 framework), 服务端 Express
- **LLM**: openai-compatible + Anthropic native

## 关键代码入口

| 路径 | 职责 |
|------|------|
| `src/index.ts` | CLI 入口, 分流到 web/electron |
| `src/web/server.ts` | Web server (port 54188) + 100+ REST API |
| `src/web/client.ts` | 浏览器侧, esbuild → dist/web/client.js (iife) |
| `src/agents/pi-sdk.ts` | PiAgent 主类 / ReAct 循环 / 工具注册 |
| `src/agents/skill-loader.ts` | 双 frontmatter 兼容的 SKILL.md 加载器 |
| `src/llm/system-prompt/registry.ts` | 25 个 layer 的注册 + 装配器 |
| `src/network/p2p-direct.ts` | iroh transport 封装 |
| `src/documents/reader.ts` | PDF/DOCX/源码 reader (P2P 文档接收) |

## v0.2.7 状态

详细见 [current-status.md](./current-status.md)。简版: 消融实验 15/15 pass (2026-07-04), 4 个核心功能端到端可工作.