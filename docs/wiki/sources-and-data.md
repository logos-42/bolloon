---
title: Bolloon 数据与原始资料
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [sources, data]
compiled_from: [ablation-v0.2.7, ablation-results-v0.2.7, ablation-runner]
---

## 数据分层

| 层级 | 路径 | git | 说明 |
|------|------|-----|------|
| **wiki** | `docs/wiki/*.md` | ✅ commit | 编译后的当前共识 (8 标准页) |
| **manifest** | `manifests/raw_sources.csv` + `meta.json` | ✅ commit | v2 schema 18 列, 每条 raw 的 provenance |
| **代码产物** | `dist/` | ❌ gitignore | `npm run build:web` 输出, web server 实际服务 |
| **本机配置** | `~/.bolloon/*.json` | ❌ 不进 git | channels.json / known_peers.json / sessions/ |
| **LLM 私钥** | `~/.bolloon/llm-config.json` | ❌ 不进 git | provider API key 配置 |

## Raw 来源清单 (manifest 已注册 3 条)

| source_id | 类型 | 大小 | content_hash (SHA-256) | lifecycle |
|-----------|------|------|------------------------|-----------|
| `ablation-v0.2.7` | report | 10953 B | `5E54A100B97EAB9C8523AAB6A71CB83290A4153F632B6F1D50AC9BC7FE0BFEC0` | stable |
| `ablation-results-v0.2.7` | dataset | 11404 B | `9F7B5441D66E54E2F7DF3FAF1CCE140B0C2035CAC40D8CE28F43624B431E9E44` | active |
| `ablation-runner` | script | 38320 B | `EA8BE91291D9A5939AF1B720847E1200038877CDC2A3DB9C504AF55E96423AE8` | stable |

注册命令:
```bash
python3 scripts/raw_manifest_check.py     # 校验 schema + hash
python3 scripts/ingest_raw.py <path>     # 单文件摄入 (含 hash + size)
```

## 隐私脱敏

```bash
python3 scripts/intake_filter.py --dry-run   # 预览 PII 检测
python3 scripts/intake_filter.py             # 实际脱敏 + 摄入
```

默认 raw root: `bolloon_raw/` (在项目根, 已 gitignore).

## 备份策略

- `~/.bolloon/sessions/channels.json` — 用户数据, 手动 rsync
- `~/.bolloon/human-values/` — 判断力积累, 是 AI 的 "学习数据"
- `dist/` — 每次 build 重新生成, 不需要备份
- wiki + manifest — 在 git 里, GitHub 自动备份

## 数据流图

```
用户交互 (CLI / web / electron)
  ↓
src/agents/pi-sdk.ts (ReAct loop + tool dispatch)
  ↓
[context] system-prompt layers (registry.ts) + human-values (distill) + skills (loader)
  ↓
LLM provider (openai / anthropic / minimax / openrouter)
  ↓
[response] SSE stream → web client / electron renderer / CLI stdout
  ↓
[persist] sessions/cache/{channel}:{session}.json (per-channel per-session)
```