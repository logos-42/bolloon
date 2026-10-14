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

## 5. Bolloon 工程约定 (2026-07-04 补充)

### 5.1 路径 / 文件

- `src/web/client.ts` 是**唯一前端源**, `npm run build:web` 编译到 `dist/web/client.js`
- 禁止手改 `dist/` (会被 build 覆盖)
- Windows 文件名禁 `:` — `SessionStore` 已 escape `:` → `__` (2026-07-04)
- 私钥 / API key 走 `~/.bolloon/llm-config.json`, 永不入 git

### 5.2 验证命令 (改完代码后必跑)

```bash
# 1. 类型检查
npx tsc --noEmit

# 2. 测试 (Windows 775 个测试, 2026-07-07 实测)
npx vitest run --bail=1

# 3. Wiki schema 校验
python scripts/wiki_check.py
python scripts/raw_manifest_check.py
python scripts/wiki_lint.py --strict=v2
python scripts/supersede_check.py

# 4. 功能消融实验 (60s+, 启动 web server + 跑 16 项端到端验证)
npx tsx scripts/ablation/run.ts

# 5. Web 编译 (client.ts → dist/web/client.js)
npm run build:web
```

### 5.2.1 跑测试的纪律 (2026-09-25)

- **改一处只跑聚焦测试** (`npx vitest run src/test/<相关文件>`) —— 全量套件在这台机器上要 ~10 分钟,
  "每改一处就跑全量" 会把时间全烧在等待上; 并行时还会把 20s 默认超时打爆, 产出**假红**。
- **pre-commit 现在按这条规矩跑聚焦** (2026-10-01 改 `scripts/lefthook-helper.sh`): 只跑「与本次暂存文件相关」的测试
  (同名测试 + 任何提到过这个文件名的测试); 相关测试 >120 个时自动退回全量。要强制全量: `LEFTHOOK_FULL=1 git commit …`
- **全量只在收尾跑一次**: `npx vitest run`, terminal 超时给到 1800s, **前台**跑 ——
  不要 `后台跑 + sleep 60/240 轮询`(那是纯墙钟浪费, 且看不到进度)。
- 全量里出现 `Test timed out in 20000ms` 先当**负载假红**: 空载单跑那个文件; 单跑绿就不是回归。
- 报红必须分三类说清: **断言失败**(真) · **20s 超时**(多半假, 需空载复跑) · **环境/夹具缺失**(要说明为什么)。
- 任何新增的门/验收脚本同理: 定点跑, 不要在循环里跑全量。

### 5.3 提交前 checklist

- [ ] 改了代码 → 跑 §5.2 全部
- [ ] 改了 wiki → 更新 `log.md` (表格 + 详细) + 检查 wiki 引用
- [ ] 改了 manifest → 跑 `raw_manifest_check.py`
- [ ] 改了 system-prompt layer → 检查 frontmatter (当前 `withMeta: 0`)
- [ ] lefthook pre-commit 现在会自动跑 vitest-bail + tsc-check, 不需 `LEFTHOOK=0` 跳过

### 5.4 Commit message 风格

```
feat(scope): 中文一句话
fix(scope): 中文一句话 (v0.2.X)
refactor(scope): 中文一句话
docs(scope): 中文一句话
test(scope): 中文一句话
chore(scope): 中文一句话
```

参考 `git log --oneline -10`。

### 5.5 已知容忍噪音

- `@diap/sdk 0.1.10` + `hyperswarm 4.x` → `discovery.update is not a function` (上游 bug, 已降级到 warn)
- `saveCurrentSession rename` 在 Windows 上偶发 EINVAL (session-store 已 escape `:`)

## 6. 当 user 说 "wiki" / "维基 llm" 时

直接用 skill 库里的 `维基 llm` skill 的工作流 (v2 schema, 18 列 manifest, 知识图谱, 混合检索, 晶化)。不要走 Obsidian / RAG / 中心化笔记。

## 7. 当 user 说 "消融实验" 时

直接用 skill 库里的 `消融实验技能` + `写实验报告技能` 的方法论 (C1 baseline / C2 enabled / C3 abnormal + 3 项假阳性检查 + 归因矩阵 + 3 维收益)。

## 8. 架构分层原则 (2026-10-13 leo 定稿, 后续设计必守)

### 原则 1：不要把 Kernel 变成第二个 Agent

Kernel 只做机制：队列、租约、取消、端口、生命周期、资源管理。
所有业务判断交给：reducer · policy · Agent · domain module。

### 原则 2：不要把 Harness 变成第二个 Kernel

Harness 只做：允许 / 拒绝 / 记录 / fail-closed。
禁止在 Harness 里加：长期调度 · Goal reducer · 模型选择 · 通信管理 · 复杂业务流程。

### 原则 3：所有新增能力先问 "它属于哪一层"

以支付能力为例：支付判断 → Policy；支付执行 → Tool Capability；支付状态 → Transaction Store；
支付证据 → Run/Goal Bridge；支付恢复 → Supervisor；支付门禁 → Harness。**不能直接把逻辑塞进 Pi。**

### 原则 4：优先新增端口，不优先新增核心状态

如果需求需要新增：新的全局 Map / 新的 currentXxx / 新的独立队列 / 新的 session singleton →
先怀疑设计是否破坏了 Kernel 的方向。

### 五个筛选问题 (任何新设计过一遍)

1. 这是机制，还是业务判断？
2. 它的事实来源是哪一个？
3. 它是否会产生第二条执行路径？
4. 它是否需要进入 Run/Goal 证据链？
5. 它能否作为 Adapter、Port 或 Capability 接入，而不修改 Pi 主体？

一个功能只能通过大改 pi-sdk.ts 内部逻辑才能实现 ⇒ 边界有问题。
一个功能能变成 Kernel Port + Adapter + Harness Gate + Run Evidence ⇒ 符合架构方向。

一句话概括：Pi 负责「想和说」，Harness 负责「准不准做」，Kernel 负责「怎么运行」，
Supervisor 负责「什么时候继续」，Goal/Run 负责「到底发生了什么」。