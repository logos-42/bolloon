---
title: 供应商目录驱动 (公开目录 223 家) + `bolloon model` 交互面口径
source: session (leo 2026-09-27 口径 + 代码实测 + 真 pty 验收 + 本机真跑门禁)
created: 2026-09-27
last_confirmed: 2026-09-27
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, provider, catalog, models-dev, provider-catalog, cli, interactive, pty, acceptance, mutation, builtin-priority, stale, honest-boundary]
---

# 供应商目录驱动 (公开目录 223 家) + `bolloon model` 交互面口径

> 承接 [provider-registry.md](./provider-registry.md) (P3: 13 家内置**一家一家手写** + 兼容协议)]
> 与 [model-discovery.md](./model-discovery.md) (P5: 上游发现与缓存)。
> 本轮把"供应商从哪来"这件事从**手写**换成**目录驱动**: 公开目录里 223 家供应商
> 变成**可列、可筛、可切**的一等数据, 而**内置 13 家的行为一字不改**。
> 同一轮落定 leo 亲测报的 CLI 交互缺陷: **真终端里裸敲 `bolloon model` 直接就是选择界面**。

**代码/产物**:
`src/llm/provider-catalog.ts`(新, 目录层: 形状校验/族推断/诚实边界/刷新/陈旧) ·
`scripts/gen-provider-catalog.ts`(新, 构建期生成脚本) ·
`src/llm/data/provider-catalog.json`(新, 烘焙目录) + `src/llm/data/provider-catalog-baked.ts`(新, TS 包装) ·
`src/llm/provider-registry.ts`(**分类闸**: 内置优先) · `src/llm/model-catalog.ts` · `src/llm/model-discovery.ts` ·
`src/llm/model-selection.ts` · `src/llm/config-store.ts`(激活识别改注册表) ·
`src/cli/model-selector.ts` + `src/cli/setup-wizard.ts` + `src/cli-entry.ts`(**交互面**) ·
`src/test/provider-catalog.test.ts`(新, 26 条) ·
`scripts/verify-provider-catalog.ts`(新, 自有门) ·
`scripts/verify-model-ux.ts`(新, **真 pty** 交互门) + `scripts/lib/pty-drive.py`(新, pty 驱动)。

## 1. 公开源与烘焙数据 (来源、字节数、sha256、时间)

| 项 | 值 |
|---|---|
| 公开源 | `https://models.dev/api.json` |
| 源字节数 | `4924682` |
| 源 sha256 | `d01edbc7b83be1d60b6192f02ae700f7971ce95addf6fd243f67eb5d14b3715c` |
| 取回时间 (`fetchedAt`) | `2026-09-27T03:15:32.627Z` |
| 源自报家数 (`sourceProviderCount`) | `223` |
| 烘焙产物 | `src/llm/data/provider-catalog.json` — `958702` 字节 · sha256 `e98ad40cf42d36bd49ce4705c4f5a7214c035ce973ada3954683665bdc4f037e` |
| 生成 (`generatedBy`/`generatedAt`) | `scripts/gen-provider-catalog.ts` · `2026-09-27T03:15:32.627Z` |

**这些数字都要能在盘上核对**: 门 S1 断言"烘焙目录家数 ≥ 200 且 = 源自报家数 (没漏没多)",
并把 `provenance` 里的 `sourceUrl/sourceBytes/sourceSha256/fetchedAt/sourceProviderCount` 当**来源凭据**读
(不是"我们说是从那儿来的")。运行期状态行也带源与日期: `目录数据: 2026-09-27 (刚刚刷新) · 223 家 · … · 源 <url>`。

**没有网络也能用**: 目录层只读烘焙文件; `refresh` 才是唯一出网的入口 (见 §5)。
离线/无网时选择器与切换全部照常, 只是数据停在烘焙那天 (状态行如实写"构建期烘焙数据")。

## 2. 家数与族分布 (223 家 / 8174 模型 · 四族 + 无基址正交标注)

| 口径 | 数 |
|---|---|
| 家数 | **223** (与公开源自报一致) |
| 模型总数 | **8174** (各家 `models` 键求和) |
| 有 api 基址 | **197** |
| **无 api 基址** | **26** (不许编, 见 §3) |

族分布 (由 `familyOfProvider()` 按 `npm` 包名 + 环境变量形状 + `api` 形状推断, 规则**各带信号文案**):

| 族 | 家数 | 含义 |
|---|---|---|
| `openai-compatible` | **200** | 走 OpenAI 兼容形状 (Bearer + `/chat/completions`) |
| `anthropic` | **8** | npm 指名 Anthropic 客户端形状 (`x-api-key`) |
| `gemini` | **1** | npm 指名 Google Generative AI 形状 (`x-goog-api-key`) |
| `special` (需专用鉴权) | **14** | AWS Bedrock / Azure / Google Vertex / SAP / watsonx / GitLab 等 —— **本运行时不支持这种鉴权形状** |
| (正交标注) 无 api 基址 | **26** | 目录里没给 `api`: 必须用户自己 `--base-url` |

判定顺序写死在代码里 (① npm 包名最明确 → ② 环境变量里的"云凭证味道" → ③ 默认 openai-compatible);
`special` **不是"猜不到"**, 而是"本运行时不支持这种鉴权形状", 界面上如实标出来 (见 §3)。

## 3. 诚实边界 (本轮最要紧的一条: 不会的事不许装会)

1. **无 api 基址的 26 家不许编地址**。目录里没有 `api` ⇒ `defaultBaseUrl` 留空(**绝不**
   `'https://api.' + id + '.example/v1'` 这种凭空造), 界面标 `⚠ 无 api 基址 (需自定义 baseUrl)`,
   切换时必须由用户显式给 `--base-url`, 否则如实拒。门里 **M1** 就是专门"给没基址的家编一个假基址"
   → **必须判红**。
2. **`special` 14 家如实标"不支持"** (`supported: false` + `note` 写清命中哪条信号), 不进可用候选、
   不当"可用"。门里 **M4**(让 special 家 `supported` 恒 true) → **必须判红**。
3. **能力字段只填目录里字面声明过的** (`tool_call` / `reasoning` / 上下文长度): 没写就是"未知",
   **不许从族或名字推断出 yes**。门里 **M2**(把没声明的能力填成"支持") → **必须判红**。
4. **陈旧不许装新** (§5): 盘上那份比烘焙数据旧 ⇒ **不采用**, 并在 warnings 里说清为什么。

## 4. 内置 13 家零变化 —— **怎么证的**, 不是"我们说没动"

门 S3 (六条都在同一份运行里真读出来):

1. 在册名单仍是 **13 家内置**, 且每条 `kind === 'builtin' && origin === 'builtin'`;
2. 目录刷新**之后**再读一次注册表: 13 家条目 JSON **逐字节相同** (打印 sha256[:16]);
3. 目录层**不回答**内置 13 家的模型能力 (`catalogAnswersProvider(id) === false`) ——
   内置家的能力只有"内置目录 + 真发现"两条真来源, 目录层不许插嘴;
4. **同名目录项不顶掉内置**: 目录里确实有与内置同 id 的家 (打印点名), 取到的仍是 `builtin` 那条;
5. 在册 + 目录的**合并读口**家数变多、**没有重复 id**、内置那 13 家仍排在**前面**;
6. **文本格式没变**: `formatProviderLine()` 输出仍是 `● deepseek · N models …` 那套, 没混进目录标注。

配套的**两道"内置优先"的闸**(刻意的纵深防御, 分别在两层):
**分类闸** `provider-registry.ts` 里 `isBuiltinProvider(id) → 'builtin'`,
**回答闸** `provider-catalog.ts` 里 `fillScope.builtinIds.includes(id) → false`。
⇒ 变异 **M3(让目录层盖掉内置 13 家)必须**把**两道闸同时拆掉**才判红 —— **单拆一道门不红**,
这是**故意**的 (一道闸是"分类", 一道闸是"回答", 少一层另一个人也还能兜住), 写在这里免得后人
把它当"变异随便改改就红"。

## 5. 运行期刷新链 + 陈旧标记

```
/model catalog refresh [--url <url>]        (或 provider-catalog.refreshProviderCatalog())
  → 真 HTTP GET 公开源
  → 形状校验 (家数/字段/类型; 形状不对 → 拒)
  → 写临时文件 (0600) → chmod 0600 → 原子 rename 到 ~/.bolloon/provider-catalog.json
  → provenance 记 sourceUrl / sourceBytes / sourceSha256 / fetchedAt / sourceProviderCount
  → 失败: 如实报失败 + "没有改动" (不留半成品, 不动盘上那一份)
```

- **陈旧**: 生成时间超过 `CATALOG_STALE_AFTER_DAYS = 30` 天 ⇒ 状态行带 `⚠ 陈旧 (超过 30 天)`
  + 日期 + "用 `/model catalog refresh` 拉最新"。
- **盘上那份比烘焙数据旧 ⇒ 不采用**, 并在 `warnings` 里说明 (不静默拿旧的当新的)。
- **无码加家 (真跑演示)**: 往假源里凭空多一家 → 刷新 → 列表/选择器/切换**当场**就能用它 ——
  证明这套不是"给 223 个固定 id 写死的表"。

命令面 (全只读, 唯一出网的是 `refresh`): `/model catalog` (是几号的/新鲜度/族分布) ·
`/model catalog list [筛选词] [--family <族>] [--all]` (逐家看; `--all` 连 special/无基址的也看) ·
`/model catalog refresh`。

## 6. 交互面: 真终端裸敲 `bolloon model` **就是**切换启动命令

leo 2026-09-27 两次确认的口径 (第一次: 要能选; 第二次: **别先刷清单再进选择器**):

| 场景 | 行为 |
|---|---|
| **真 TTY** + `bolloon model` (裸敲) | **直接进选择器**, 第一屏 = 带序号的供应商列表 (不是清单+用法) |
| **真 TTY** + `bolloon model pick` | 同上 (显式写法, 保留; 用户不必知道 `pick` 这个词) |
| 管道 / 非 TTY (脚本) | 退回**清单 + 用法** (可读, **不卡在等待输入**) |
| `bolloon model list [家]` | 保留, **只读**列表 (不写配置) |

七步 (供应商→凭证→模型→reasoning/temperature→作用域→测试→确认) 的**每一步**都:

1. **先把选项印出来再问**: `标题` → `1) ● 家 · N models · ← 当前 — …` (每条带 `●`可用/`○`未配置凭据
   状态与 `← 当前` 标记, 分组标题 `── 当前生效 / ── 可用 (有凭证) / ── 未配置凭据` 只在换组时印一次)
   → `共 N 项 · 回空 = 第 1 项` → 才问 `选择 (序号/值, 回车=1)`。序号右对齐, 全局连续。
2. **非法输入说清为什么再重问**: `✗ 序号 99 超出范围 (这里只有 1~13 项) — 重问`; 前缀没命中报实际命中数;
   连试 3 次才取消。
3. **EOF / Ctrl-D = 干净取消**: 印 `· 输入已结束 (Ctrl-D / EOF) → 取消本次切换, 一个字节都没写`
   + `已取消, 未改动任何配置`。**EOF 不等于"回车 = 取默认"** —— 这两件事必须分开
   (readline 在输入流结束时不一定回调 `question`, 所以另挂 `close` 兜底并显式判 EOF)。
4. **每一步当场打到终端** (`io.live`): 非交互调用方 (会话内 Ink / 验收脚本) 仍拿"整段文本",
   真终端才逐行实时印。**修的就是这条**: 原先每步只收进缓冲、整轮结束才一次性回显 ⇒
   用户全程只看到一句光秃秃的 `选择 (序号/值, 回车=1)`, **一个选项都没印**。

真 pty 证据 (门 `scripts/verify-model-ux.ts` 摘的真渲染, 去 ANSI):

```
步骤 1/7 供应商 (3 家可用 / 13 家登记):
  目录数据: 2026-09-27 (刚刚刷新) · 223 家 · 有基址 197 / 无基址 26 · 模型 8174 · 源 https://models.dev/api.json
选择供应商 (序号 / 供应商 id):
  ── 当前生效
   1) ● deepseek · 本地 · 2 models · ← 当前 — DeepSeek · 登记支持 reasoning · 配置里 model=legacy-model-x
  ── 未配置凭据 (选了会先要 key)
   4) ○ openai · 6 models · 未配置 key (OPENAI_API_KEY) — OpenAI · 登记支持 reasoning
  共 13 项 · 回空 = 第 1 项
选择 (序号/值, 回车=1) 99
  ✗ 序号 99 超出范围 (这里只有 1~13 项) — 重问
选择 (序号/值, 回车=1) deepseek
```

## 7. 门禁与变异

| 门 | 结果 (2026-09-27 本机真跑) |
|---|---|
| `npx tsc --noEmit` | **0 错** |
| `scripts/verify-provider-catalog.ts` (自有门) | **70 passed / 0 failed** · 变异 **5/5 判红** (M1 编假基址 / M2 编能力 / M3 目录盖内置(双闸) / M4 special 装可用 / M5 陈旧装新) |
| `src/test/provider-catalog.test.ts` | 26 条 |
| `scripts/verify-model-ux.ts` (**真 pty**) | **27 passed / 0 failed** · 变异 **2/2 判红** (M1 拿掉"印选项" / M2 拿掉"裸敲直接进选择器"), 且恢复后**逐字节回原文** |
| 八道 `verify-model-*` | **八道全绿**: `selection` 55/0 · `selector` 51/0 · `entrypoints` 59/0 (171s) · `wiring` 89/0 · `acceptance` 16/16 条目 / **106/106** 断言 · `policy` 36/0 · `discovery` 81/0 · `provider-registry` 44/0 |
| `scripts/verify-cli-quiet.ts` | **11 passed / 0 failed / 1 skipped** —— 空载单跑; 唯一的 skip 是 A5「环境真降级」: 本机基线窗口里没有降级行 ⇒ **判不了, 不计入通过** (环境依赖项, 不是绿也不是红); A6 的定向注入判据成立: 那行 `[PiAIModel] Error reading apiKey from config: SyntaxError…` 空载 **t≈6.8s** 就出现 (窗口 20s) |
| `scripts/verify-mobile-model-sync.ts` | **53 passed / 1 failed** —— 红项是**陈旧打包产物**, **不是本轮回归**: `check-native-artifacts.mjs` 拿 `build/ipa/Bolloon-unsigned.ipa` (09-26 09:36 打的) 里的 `0.5.0` 比 `package.json` (09-26 17:00 的 bump, 仍在暂存区没提交) 的 `0.5.1`。要 Xcode 重打 IPA 才对齐; 那 4 个版本号文件不在本轮交付面内, 也没动 |
| 冻结门 (`goal-flywheel-wiring-freeze`) | **34/34** |
| 全量 `npx vitest run` | **246 文件 / 4009 测试 全绿** (128s —— 收尾最后一次跑, 在代码冻结后; 无 20s 超时) |
| `npm run build:main` | exit 0 —— `dist/llm/data/provider-catalog-baked.js` **1,062,405 字节** 真进了构建产物; 全局 `bolloon` (`~/.npm-global/lib/node_modules/@bolloon/bolloon-agent` **符号链接到本仓**) 的 `dist/llm/provider-catalog.js` 与仓内 **sha256 相同** ⇒ leo 手上那个 `bolloon` 真带上目录能力 (实测 `bolloon model catalog` 打出 223/197/26/8174) |
| 单测断言按新事实改指向 (**不是放宽**) | `model-selector.test.ts`: 两处标题改名 (原标题没写"接受什么输入") + **新增 3 条**文本回退路径断言 (① 每一步先印选项再问, 逐块检查 print/ask 真实先后 ② 非法输入报范围/报"可用值见上表"再重问 ③ EOF 干净取消且配置**逐字节不变**); `provider-registry.test.ts`: "reset 之后不偷偷加回来" 改为如实钉住**两个**自动填充点各自每进程只自动接线一次 (注册表那一个**没**回来, 目录最多一份, 再 init 结果逐项不变) |
| 计数自洽 | 烘焙 **197/26** · 目录视图 **197/26** · CLI 状态行 **无基址 26** —— **三处同一个数** (S8 演示家只动"有基址") |

**真 pty 门为什么不能用管道跑**: 被测行为里有一条硬分支 `process.stdin.isTTY` ——
`printf '1\n' | bolloon model` 测到的是**非终端**那条路。门的驱动
`scripts/lib/pty-drive.py` 开真伪终端, 并且**等渲染真的出现再喂下一步** (等待本身就是断言),
始终持续 read (不读会让对端写满缓冲, 量到的是缓冲假象), 结束时让进程**自然退出**再收集输出
(kill 会丢缓冲输出)。假上游必须**异步** spawn —— `spawnSync` 会堵住父进程事件循环, 上游没人应答 ⇒
量到"上游连不上"的假红 (兄弟门踩过同一个坑)。

## 8. 如实留下 (没做到 / 有保留)

- **26 家无 api 基址**只能靠用户显式 `--base-url`; 目录里没给就是没给, 本轮**不补**任何地址。
- **14 家 `special`** 仍**不支持** (需云签名/多变量凭证), 界面上如实标, 切换会被拒。
- 运行期刷新要**真网络**; 离线只有烘焙那天的数据 (状态行会写"构建期烘焙数据")。
- 真 pty 门覆盖的是**命令行交互面**; 会话内 `/model` 走 Ink 选择器 (`io.choose`, 由它自己渲染选项),
  不在本门扫描面里 —— 同一套七步与"先印选项"的结构来自同一份 `model-selector.ts`, 但**没有**为
  Ink 那侧单独跑 pty 断言。
- 门只钉了"家族级"行为 (223/197/26/四族), **没有**逐家核对 8174 个模型 id 与公开源的一致性;
  逐字节一致性由 `gen-provider-catalog.ts` 的构建期生成 + 源 sha256 记录承担。
- 启动时 Ink 进度帧可能残留一个 spinner 字符在终端最后一行 (既有现象, 与本轮无关, 未修)。
- `verify-cli-quiet` 的 **A5** 在本机**判不了** ("基线窗口里没有降级行" ⇒ 不计入通过): 这是**环境依赖**项,
  换台有降级/错误行的机器才有意义; 同一门的 **A6** (定向注入坏配置) 是有判据的, 空载 t≈6.8s 命中。
  并行跑多道门时 A6 曾判红一次 —— **负载假红** (20s 窗口被拉长), 空载单跑绿, 那行错误本身一点没吞。
- `verify-mobile-model-sync` 的 1 条红是**陈旧 IPA** (见 §7), 需要 Xcode 重打才对齐, 本轮**没修也没动**版本号文件。
- 目录帮助文案里两处 `${'{'}…{'}'}` **转义写坏** (终端上真打成一个 `{'}'}`), 已改成纯文本
  (`只要你有该家声明的环境变量, …`) —— 修的是文案, 不是能力; 顺手把"注意: 只有…的家能真发请求"那一行同样改干净。
