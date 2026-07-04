---
title: Bolloon 校验脚本运行时配置
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: meta
tags: [meta, ci, validation]
compiled_from: [ablation-v0.2.7]
---

`scripts/` 下的每个脚本都在 `# runtime: ...` 头里声明自己的运行时。
用这个矩阵决定哪些跑 CI、哪些只跑在开发机。

## ci-safe — 无需 raw 文件即可运行

| Script | What it checks | Notes |
|--------|----------------|-------|
| `wiki_check.py` | v1 schema 兼容校验 | 必跑 pre-commit |
| `raw_manifest_check.py` | manifest schema v1/v2 校验 | 必跑 pre-commit, 自动读 `raw_sources.meta.json` |
| `wiki_lint.py --strict=v2` | v2 严格 lint | 必跑 pre-commit (v2 schema 启用后) |
| `supersede_check.py` | supersede 关系链 + contradicts 对 | v2 启用后必跑 |
| `delta_compile.py` | 起草 draft stub (不写主页面) | 可选 |
| `wiki_size_report.py` | 4 档 token 桶统计 | 可选 |
| `version_check.py` | bootstrap 版本自检 | 可选 |
| `stale_report.py` | 6 类 fresh/stale 报告 | 可选 |
| `export_memory_repo.py` | 导 memory repo (离线) | 手工触发 |

## dev-only — 需要 raw 资产,CI 跳过

| Script | Why dev-only |
|--------|--------------|
| `intake_filter.py` | 写 raw root, 需 `PROJECT_RAW_ROOT` 环境变量 |
| `ingest_raw.py` | 同上, 会改 manifest |
| `untracked_raw_check.py` | 比对 raw dir 和 manifest, 找漏登 raw |
| `provenance_check.py` | 重新算 SHA-256 比对, 慢 |
| `crystallize.py` | 蒸馏 wiki 断言, 需 LLM 调用 (可选) |
| `hybrid_search.py` | BM25 + 图遍历 + RRF 融合, 纯 stdlib 但要在生产数据上跑 |
| `graph_export.py` | 知识图谱导出 → `manifests/knowledge_graph.json` |
| `init_raw_root.py` | 一键初始化 raw 目录 |

## Ablation 实验 runner (本项目新增)

| Script | Runtime | Notes |
|--------|---------|-------|
| `scripts/ablation/run.ts` | dev-only | 启动 web server, 4 功能 × 15 项验证, 60s+ 跑完, 写 `docs/ablation/report.md` + `results.json` |

## 接入 CI

`.github/workflows/wiki-lint.yml` 由 bootstrap 自动创建, 跑:
- `python3 scripts/wiki_check.py`
- `python3 scripts/raw_manifest_check.py`
- `python3 scripts/wiki_lint.py --strict=v2`

**不接 ablation runner** — 因为 dev-only, 启动 web server 会让 CI 卡住。如果要接, 需要 mock server.