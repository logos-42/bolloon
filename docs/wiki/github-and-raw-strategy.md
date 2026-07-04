---
title: Bolloon GitHub 与 raw 仓分工策略
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [github, raw-strategy]
---

## 核心原则

- **代码 + 编译后 wiki 都在 GitHub repo** (logos-42/bolloon)
- **本机 raw 资产 (channels.json / known_peers.json / sessions/) 在 `~/.bolloon/`**, 不进 git
- **构建产物 `dist/` gitignore**, 每次 build 重新生成
- **隐私数据走 intake_filter.py** 脱敏后入库

## GitHub Repo 现状

```
logos-42/bolloon.git
├── src/                          # TypeScript 源
├── scripts/                      # 工具脚本 + ablation runner
├── docs/wiki/                    # 编译后 wiki (8 标准页)
├── docs/ablation/                # 消融实验报告
├── manifests/                    # raw 来源清单 (v2 schema)
├── Bolloon.md / CLAUDE.md / AGENTS.md   # 项目入口文档
└── .github/workflows/            # CI (wiki-lint 等)
```

## Git Ignore 关键条目

```
node_modules/          # npm
dist/                  # build 产物
.env                   # 私钥
.bolloon-logs/         # runtime log
.comm/_state/          # chat transport 状态
# wiki 系统
.obsidian/
raw/  raw_local/  raw_vault/  bolloon_raw/   # raw 本体
.wiki-scratch/                                # scratch 目录
```

## Workflow

### 新增 raw 资料 (PDF / 截图 / 文档)

```bash
# 1. 拷贝到 raw 目录
cp ~/Downloads/foo.pdf bolloon_raw/

# 2. 摄入 (脱敏 + 算 hash)
python3 scripts/intake_filter.py bolloon_raw/foo.pdf --ingest

# 3. 校验
python3 scripts/raw_manifest_check.py
python3 scripts/wiki_lint.py --strict=v2
```

### 写新结论到 wiki

```bash
# 1. 编辑 docs/wiki/*.md (v2 frontmatter 必填 6 字段)
# 2. 更新 log.md (在 ## [日期] 下追加一行)
# 3. 提交
git add docs/wiki/ manifests/
git commit -m "wiki: <一句话>"
```

### 备份本机数据

```bash
# ~/.bolloon 是 SQLite-like JSON 存储, 直接 rsync 即可
rsync -avz ~/.bolloon/ ~/backup/bolloon-$(date +%Y%m%d)/
```

## 不进 GitHub 的内容

- `~/.bolloon/llm-config.json` (含 provider API key)
- `~/.bolloon/sessions/cache/` (会话历史, 可能含 PII)
- `~/.bolloon/human-values/` (判断力, 是 AI 的"学习数据", 私域)
- `bolloon_raw/` (用户原始资料)

## 备份 vs 同步

- **GitHub 是真源 (source of truth)**: code + wiki + manifest + ablation reports
- **`~/.bolloon/` 是 state**: 用户的本机资产, 通过 rsync 或自建 sync 备份
- **`dist/` 是 ephemeral**: 每次 `npm run build:web` 重新生成, 不备份