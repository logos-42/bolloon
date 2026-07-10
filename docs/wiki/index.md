# Wiki 索引

> Bolloon 项目的持久化共识存储。每个 session 启动时读 `current-status.md` 即可恢复上下文,详细规则看 SCHEMA.md.

## 8 个标准页

| 页 | frontmatter | 用途 |
|----|-------------|------|
| [README.md](./README.md) | (none) | 范式 + 自检命令 |
| [SCHEMA.md](./SCHEMA.md) | (none) | v1/v2 双 schema 完整文档 |
| [project-overview.md](./project-overview.md) | v2 | 一句话定义 + 主线目标 + 交付边界 + 技术栈 |
| [current-status.md](./current-status.md) | v2 | 已支持 / 未支持 / 线上状态 / 风险 / 优先级 |
| [sources-and-data.md](./sources-and-data.md) | v2 | 数据分层 + raw 清单 + 隐私脱敏 + 数据流图 |
| [github-and-raw-strategy.md](./github-and-raw-strategy.md) | v2 | GitHub / 本机 / dist 三层分工 + workflow |
| [runtime-profile.md](./runtime-profile.md) | v2 meta | 校验脚本 CI/dev-only 矩阵 + ablation runner 状态 |
| [skills-index.md](./skills-index.md) | v2 meta | 35 个全局 skill 索引 + 触发词映射 |
| [crystallized-claims.md](./crystallized-claims.md) | v2 claim | 4 条从 ablation 蒸馏的稳定断言 |
| [bolloon-md-template.md](./bolloon-md-template.md) | v2 | 4 级 Bolloon.md 模板 (双栖 agent 网络对外协作偏好) |
| [log.md](./log.md) | (none) | session-by-session 变更日志 |

## v2 schema 必填字段 (所有内容页)

```yaml
---
title: <一句话>
source: session
created: YYYY-MM-DD
last_confirmed: YYYY-MM-DD
schema_version: 2
audience: self  # self / internal / reader / public
stage: current   # draft / current / stale / archived / crystallized
status: current
confidence: high  # high / medium / low / unverified
entity_type: chapter  # concept / person / protocol / chapter / claim / meta
---
```

详见 [SCHEMA.md](./SCHEMA.md).

## 自检命令

```bash
# wiki schema 校验 (v1 兼容)
python3 scripts/wiki_check.py

# manifest schema 校验 (v1/v2 自动)
python3 scripts/raw_manifest_check.py

# v2 严格 lint (需要所有内容页 schema_version: 2)
python3 scripts/wiki_lint.py --strict=v2

# supersede 链 + contradicts 对 校验
python3 scripts/supersede_check.py

# 知识图谱导出
python3 scripts/graph_export.py

# 晶化断言
python3 scripts/crystallize.py --min-occurrences 2

# 混合检索 (BM25 + 图遍历 + RRF)
python3 scripts/hybrid_search.py "我的查询" --depth 2

# 草拟 draft stub (新 raw 触发)
python3 scripts/delta_compile.py --write-drafts

# stale 报告 (6 类 fresh/stale)
python3 scripts/stale_report.py
```

## 关联资产 (非 wiki)

- [消融实验报告](../ablation/report.md) — 4 功能 × 15 项端到端验证
- [Q1-Q5 报告 2026-07-07](./q1-q5-report-2026-07-07.md) — 远程交流链路 + 五层记忆架构 + H2 修复
- [Bolloon.md](../../Bolloon.md) — 项目入口文档
- [CLAUDE.md](../../CLAUDE.md) — Claude Code 上下文 (root)
- [AGENTS.md](../../AGENTS.md) — 通用 agent 规则