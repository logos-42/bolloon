# Bolloon 智能体规则

这仓库默认走 `wiki-first`，不是 `chat-first`。

## 1. 每个新 session 默认先干嘛

只要任务不是纯闲聊，默认先：

0. `python3 scripts/version_check.py` — 检查更新（有新版才提示，没有就静默）
1. 读 `docs/wiki/index.md`
2. 读 `docs/wiki/current-status.md`
3. 读 `docs/wiki/log.md`

别一上来就靠 session 硬猜。

## 1.5 文档文件自动归档

凡是提到、收到、引用、保存的任何非代码文件 → 第一件事查 `manifests/raw_sources.csv`。
包括但不限于：PDF、Excel、截图、客户发来的附件、聊天图片、CAD图纸、压缩包。
不在里面 → 先登记再用。这步最容易漏。

少量文件可以手填 manifest，大量新文件直接跑：

```bash
python3 scripts/ingest_raw.py
```

定期跑：

```bash
python3 scripts/untracked_raw_check.py
python3 scripts/stale_report.py
python3 scripts/delta_compile.py --write-drafts
```

前者找漏登 raw，第二个找已经过期的 wiki 页面，第三个只起草重编译草稿，不会乱改现有页面。

## 2. 默认范式

- `compile-first`
- `writeback` 必做
- 中等规模先 `wiki`，不先上重 `RAG`
- Obsidian 可替换，范式不可替换
- `Idea / Intent` 优先于 `Code`

## 3. 知识分层

- raw：原始资料
- wiki：编译后的当前共识
- code：执行层

只改代码不回写 wiki，算没做完。

## 4. 一致性规则

- `current-status.md` 和其他 wiki 页面冲突时 → 以更具体的页面为准，然后修正 `current-status.md`
- `log.md` 缺少之前 session 的记录 → 不猜，只追加自己的
- 两个 wiki 页面矛盾 → 标记给用户，解决后再继续
