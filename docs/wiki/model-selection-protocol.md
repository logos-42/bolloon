---
title: 模型选择协议 (统一入口 + 有效模型配置 + 每 Run 快照)
source: session (leo 2026-09-26 计划 P0/P1 + 代码实测)
created: 2026-09-26
last_confirmed: 2026-09-26
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
tags: [model, llm, config, cli, web, run-store, snapshot, selection, priority, acceptance]
---

# 模型选择协议 (P0 + P1)

> 目标: 让「切换模型」只有一个入口, 并且在**配置落盘 · 模型运行时 · 会话作用域 · Run 快照**
> 四个环节保持同一件事; 每次 Run 记下当时**真实生效**的模型配置, 长任务中途换默认模型时
> 历史执行链仍可解释。
>
> 代码: `src/llm/model-selection.ts` (唯一入口) · `src/llm/config-store.ts` (配置读写与迁移) ·
> `src/agents/run-store.ts` (Run 快照字段)。

## 1. 三个文件, 三种作用域

| 文件 | 内容 | 作用域 |
| --- | --- | --- |
| `~/.bolloon/bolloon-config.json` | `activeProvider` + 每个 provider 的 `enabled/model/baseUrl/apiKey` | **全局** (新会话 + 未绑定模型的任务) |
| `~/.bolloon/model-sessions.json` (`0600`) | `{ sessions: { <sessionKey>: {provider, model, baseUrl, scope:'session', updatedAt} } }` | **只影响当前会话** |
| `~/.bolloon/bolloon-config.lock` | 跨进程切换锁 (抢占式 `O_EXCL` + 15s 视为陈旧可夺) | 进程间串行 |

- **旧配置可迁移**: `~/.bolloon/llm-config.json` 存在而 `bolloon-config.json` 不存在时, 内容被复制过去
  (迁移一次, 原文件保留)。老用户升级后无需任何手工动作。
- **会话绑定文件里没有 key**: 凭证只存在全局配置文件 (或其环境变量), 会话绑定只记"用哪家/哪个模型/哪个 URL"。
- `sessionKey` 取自 `BOLLOON_SESSION_KEY`, 缺省 `cli-default`; 空串/纯空白**拒绝**写绑定
  (不生成匿名绑定)。

## 2. 有效模型配置 (EffectiveModelConfig)

「有效模型配置」= 把五层来源按固定优先级压成一份**可读、可回显、可入快照**的东西:

```
provider · model · baseUrl · protocol · authRef · reasoning · scope · source · updatedAt · configHash
```

| 字段 | 说明 |
| --- | --- |
| `protocol` | `openai-compatible` / `anthropic` / `gemini` / `ollama` —— 决定 URL 形状与鉴权头 |
| `authRef` | **凭证来源引用, 不是凭证**: `provider:<id>` / `env:<VAR>` / `none` |
| `scope` / `source` | 这一份配置来自哪一层 (两者同值, 分开写是为了读的人不必猜) |
| `configHash` | `provider\|model\|baseUrl\|protocol` 的稳定摘要 —— Run 快照靠它判断"这次执行用的是哪一份" |

**来源优先级 (固定, `SELECTION_PRIORITY` 常量, 调用方不许打乱)**:

```
Run/Goal 显式绑定  >  当前 Session  >  用户 Global  >  provider 默认  >  环境变量
```

- **Global** 影响新会话 + 未绑模型的任务; **Session** 只影响当前 CLI 会话。
- **空层被跳过**: 某一层只有 provider 没有 model/baseUrl 时不算数 (不会压出一份空配置)。
- **Global 不可用** (未启用 / 需要 key 但没有) → 落到 `provider` 默认并**如实标 `source: 'provider'`**,
  不假装是用户选的。

## 3. 唯一入口的数据流

```
validateSelection → 写配置 (仅 global) → 更新 scope → 重建模型运行时 → 更新 session → 返回 effective config
```

`selectModel(req)` 是**唯一**入口。CLI `/model`、Web `/api/llm-provider`, 初始化向导、会话内选择器
全部只能调它 —— 此前三条路各做一部分 (CLI 只改配置文件**不重建运行时** ⇒ "切了但没生效";
Web 自己 `setActiveProvider + initMinimax`), 同一个动作两种结果。

**三条硬性质 (都能被验收判红)**:

1. **进行中的请求继续用旧配置** —— 切换只换"下一次"用的实例, 不打断在飞的请求。
2. **失败时配置与运行时都保持原样** —— 严禁"文件已改但实例仍旧"的半成功。校验/探测任一关不过,
   直接返回失败分类, **盘上的字节不变**(验收按 sha 逐字节比对)。
3. **凭证是全局概念** —— 会话级切换只做"路由", 不带 `apiKey` (`credential_scope_conflict`);
   这类请求在**探测之前**就被拒 (试一次就等于拿一个不打算落盘的 key 打了一次上游)。

**跨进程串行**: 写配置在 `withConfigLock` 里做, 拿到锁后**重读**文件再改
(`initialize()` 自己按文件签名判断是否重读, `invalidate()` 是补刀 —— mtime+size 都撞上时签名不变)。
否则两个进程同时切不同 provider 时, 后写的会用陈旧快照覆盖先写的。

## 4. 命令面

| 命令 | 行为 |
| --- | --- |
| `/model` · `/model status` · `/model list` | 打印**当前真实生效**的 provider/model/base URL/scope/凭证来源/hash |
| `/model <provider>` | 切到该 provider (用它已配置的 model/URL/凭证) |
| `/model <provider> <model>` | 同 provider 换模型 |
| `/model <provider> <model> --base-url <url>` | 指定地址 (本地/自建/网关); URL 规范化后落盘 |
| `/model test [provider]` | 只探测连通性/鉴权/模型目录, **不写任何配置** |
| `/model reset` | 回到 provider 默认并重建运行时 |
| `/model key <provider> [key]` | 写凭证 (仅全局); 缺参时交互式隐藏输入 |

修饰符: `--session` / `--scope session` / `--global` (默认 global) · `--no-verify` (跳过探测) ·
`--json` (机器可读, `status` 也支持)。未知选项与非法 `--base-url` 在**解析期**就报错。

**失败分类** (`SelectionFailureClass`, 全部有中文人话映射, 不许只回"切换成功了/失败了"):

`invalid_provider` · `invalid_model` · `invalid_url` · `missing_api_key` ·
`credential_scope_conflict` · `auth_failed` · `provider_unreachable` · `model_not_found` ·
`protocol_mismatch` · `timeout`

**URL 规范化**: 去尾斜杠 · 合并重复斜杠 (不碰协议后的 `//`) · **折叠重复的 `/v1/v1`**
(否则拼出来是 `/v1/v1/models`)。畸形 URL 与非 http/https 在形状校验阶段就拒。

## 5. 每 Run 快照

`RunRecord.modelConfig?: RunModelConfig` = `{ provider, model, baseUrl, configHash, selectionScope, capturedAt }`。

- **加成字段**: 老 Run 记录没有它照样读, 记录层 (run-store) **不做解析** —— 快照由调用方
  (`captureRunModelConfig()` / `pi-sdk.runModelSnapshot()`) 算好传进来。
- 落点在两条真执行链: `pi-sdk` 的两处 `startRun` 与 `agents/task/task-runner` 的 `startRun`。
- **语义**: 长任务中途切默认模型 → 旧 Run 保留原快照, 新 Run 用新模型; `configHash` 能回答
  "这两段执行是不是同一份模型配置"。

## 6. 验收矩阵 (真跑)

脚本 `scripts/verify-model-selection.ts` (真起本地假模型服务器 + 真子进程), 单测
`src/test/model-selection.test.ts` (49 条)。

| # | 判据 | 手段 |
| --- | --- | --- |
| 1 | 切 provider → 下一次请求真命中 | 本地 HTTP server 记请求, 切到 A 后请求计数 A+1/B+0 |
| 2 | 同 provider 切 model → 请求体里的 model 真变 | 读请求体 JSON 的 `model` 字段 |
| 3 | 自定义 base URL → 请求命中该地址 | 命中路径逐字比对 `/alt/v1/chat/completions` |
| 4 | 错 key / 错 URL / 错 model → 都不能切换成功 | 四类失败逐条判分类 + 配置字节 sha 不变 |
| 5 | CLI 与 Web 读到同一份配置 | `runModelCommand('status --json')` vs 真 express 路由 |
| 6 | 重启 CLI 后仍生效 | **真新进程** 读回同一份 |
| 7 | Session 切换不改变 Global | 全局文件字节不变 + 绑定落在 `model-sessions.json` |
| 8 | Global 切换影响新 Session | 全新 sessionKey 读到新全局默认 |
| 9 | 长任务中途切默认 → 旧 Run 保留原快照 | 真 `startRun` + 真读回 |
| 10 | 下一 Run 用新模型 | 两个 Run 的 `configHash` 不同 |
| 12 | 两进程同时切配置 → 不互相覆盖 | 真并发子进程 + 持锁进程陈旧快照负控制 |
| 13 | 旧配置可迁移 | 隔离 HOME 只放旧文件名 → 新文件出现且有效配置正确 |
| 16 | 切换失败后旧模型仍可用 | 失败后**真发一次**请求, 命中旧端点 |

**变异验证** (改坏必须判红, 按词界改名并先确认盘上 hash 真变了):

| 变异 | 判红 |
| --- | --- |
| M1 切换后不重建运行时 | **8 条红** (正是"切了不生效") |
| M2 会话级也写全局配置文件 | 4 条红 |
| M3 拿到锁后不重读 | **0 条红** —— 如实记录: `initialize()` 的文件签名检查已覆盖, `invalidate()` 是补刀 |
| M4 去掉跨进程锁 | 5 条红 (并发子进程互相覆盖) |
| M5 materialize 把 key 写进 authRef | 1 条红 (凭证不进有效配置) |
| M6 调换优先级顺序 | 3 条红 |
| M7 Run 记录不落快照 | 4 条红 |

## 7. 如实留下

> **2026-09-26 P2 更新**: 本节第 1/2/5 条已在 [model-selector-p2.md](./model-selector-p2.md) §5 结清 ——
> ① `invalidate()` 现在**有门钉住** (用 mtime+size 撞车构造, 变异判红; 见该页 §5①);
> ② 真启动验收**已跑通** (`scripts/ablation/run.ts` 15/16), 启动停滞的根因是**夹具探错了端口**
>    (`--port` 从来不被解析, 端口契约是 `PORT` 环境变量) + 启动序列串行 (冷启动实测 ~143s);
> ③ `configHash` 反向校验**已补** (`detectRunConfigDrift` + `resumeRun` 接线, 逐字段点名漂移)。
> 以下原文保留, 作为当时的口径。

- `withConfigLock` 里那句 `invalidate()` 在当前实现下**不是承重的** (文件签名检查已经能触发重读);
  它的价值只在"mtime 与 size 同时撞上"的边角。变异 M3 因此**没判红**。
- 并发验收 (条 12) 的判别力来自"持锁进程故意拉开窗口"的负控制 + 去掉锁的变异, 不来自
  两个子进程自然撞车 —— 自然撞车的窗口只有毫秒级。
- Web 侧验收用的是**同进程挂载真路由 + 真 HTTP 请求**, 不是完整启动的 Web 服务
  (本机启动被 DID/IPNS 发布拖到 2.5min+ 仍停在启动第 2 步, 属环境噪音)。


---

## 8. 追记: 接线收口 (2026-09-26) —— 探测原语接进入口 · 映射表 7→15 类

§1 说的「一次切换失败必须落到一个类上」在本轮**从入口自己判**升级成「**探测原语是唯一探测者**」:

- `selectModel` 的探测段改成调 `connection-probe.ts` 的 `probe(...)`; 原语报的 **7 类**经
  `PROBE_TO_SELECTION` **逐类映射** (1:1, 不合并/不丢), 入口类目 **11 → 15**:
  `+tool_call_unsupported` · `+persist_failed` · `+runtime_rebuild_failed` · `+probe_failure_unmapped`。
- **未映射不许退化成无信息文案**: 兜底类 `probe_failure_unmapped` 照实报原语给的原类名与逐步事实
  (真跑里用「将来 P4 加了新类」的方式钉住这条)。
- 逐类真出处由 `SELECTION_FAILURE_CLASS_ORIGIN` 标 (7 `probe` / 8 `entry`), `selectionFailureClassTable()`
  是报告/CLI/门禁共用的**同一张**给人看的表。
- 口径变化 (照实记): 主机名拼错 → `provider_unreachable` (原语按 undici `UND_ERR_SOCKET` 归), 旧入口叫 `invalid_url`。

**事件落点的一条硬规矩 (接线时真跑逼出来的)**: 决定函数的缺省落点是上一条 Run, 但**已经收尾的 Run 是历史** ——
往它上面追加事件会撞飞轮规则 ⑦「已发生的 Run 记录不被改写」(逐字节比对)。所以调用侧分两种:
上一条 Run 还活着 → 事件写它; 已收尾 → 决定"只算不写", 等新 Run 起来后记到**新 Run 自己**的账本上
(与本节「它不回头改老 Run」一致)。新门把「旧 Run 整条记录逐字节没变」也钉上了。

真跑: `scripts/verify-model-wiring.ts` **89/0** (7 类各一枚真探 + 真 `Supervisor.tickOnce()` 且旧 Run 逐字节不动 + 真服务器收鉴权头) ·
变异 `scripts/verify-model-wiring-mutations.py` **5/5 判红** (丢类 7 红 / 退化 1 红 / 在跑 Run 被改写 2 红 / 鉴权头不看注册表 2 红 / 往已收尾 Run 追加事件 4 红) ·
既有门 55/0 · 51/0 · 36/0 · 50/0 · 44/0 · 冻结门 34/34 全绿。P7 的四处钩子接法与保留项见 [log.md 2026-09-26 详细段](./log.md)。

---

## 9. 追记: 入口收敛 (2026-09-26) —— 五端点 · 命令面挂 P5 · 自定义供应商进得来

此前「切模型」这件事有**六套入口**: CLI 命令面 · 会话内 `/model` · Web 路由 · Agent 配置工具 ·
安装向导 · 长任务恢复 —— 各自读一点配置、写一点配置、可能各自重建运行时 (Web 那条路当年就是
自己 `setActiveProvider + initMinimax`, 这正是「CLI 切了不生效」的来源)。本轮全部收敛到
**只走 `selectModel`**: 谁都不许自己写 activeProvider、自己重建运行时。

### 9.1 五个端点 (Web 侧对外只有这一套语义)

| 端点 | 方法 | 干什么 | 靠谁 |
| --- | --- | --- | --- |
| `/api/models/providers` | GET | 在册供应商 + 注册表事实 (protocol/requiresApiKey) + 当前有效配置 | 注册表 + `effectiveModelConfig` |
| `/api/models/options` | GET | 某家 (或不指定) 的模型清单 (上游真目录 / 声明 / 手输, 标 `origin`) | P5 `listModelCatalog` |
| `/api/models/test` | POST | 连通 + 工具调用能力探测, **不写任何配置** | P4 `probeSelection` |
| `/api/models/select` | POST | 切换 (= 唯一写口 `runModelSelect`) | `selectModel` |
| `/api/models/discover` | POST | 发现/刷新一家或全量 (`action: refresh\|clear\|admit`) | P5 |

**旧接口保留形状、内部转发**(不许两套写配置逻辑): `POST /api/llm-config`(旧 UI 的
`{provider, config:{…}}` 形状) · `POST /api/llm-provider` · `POST /api/llm-test` —— 有凭证就**转到
同一个 `runModelSelect`**, 无凭证的旧写法仍只存字段 (不激活, 保持旧行为); 探测没过 → **409 且盘上
配置字节不变**。源码级门钉两条: 整个路由文件里 `selectModel(` **只出现 1 处** (就在唯一写口里),
旧 `/api/llm-provider` 段里**不许出现** `setActiveProvider(`/`updateProvider(`。

### 9.2 命令面挂上 P5 的发现能力 (P5 自己没碰命令面)

`/model refresh [provider]` → `refreshModelDiscovery` · `/model refresh --clear` → `clearDiscoveryCache`
(报清了几条) · `/model list` / `/model list <provider>` → `listModelCatalog` (复用 P5 的格式化行) ·
**手输模型** → `admitManualModel` (选择器的「自己输一个」那条路也改走它, 不再自己写)。门同时钉
「源码级真的调这些函数」与「真跑上游目录端点命中数真的涨」。

### 9.3 自定义供应商进得来 (上一轮如实留下的缺口㈡)

`validateSelection` 的「这家存在吗」判据从**内置表**改成**注册表** (`registryEntryOf`), 于是从列表里
点一个**自定义供应商**能落成全局默认; **内置那条路一字未改** (P0 的 55 条 + 选择器 51 条不变红)。
事实读法沿用上轮定的规矩: **自定义问注册表, 内置问内置表**。`config-store.setActiveProvider` 同步
改成按注册表判存在 (否则自定义 id 连激活都进不去)。

### 9.4 Agent 工具 / 向导 / 恢复 也走同一入口

- `bolloon_config_set` (Agent 工具) 改走 `selectModel`, 不再自己写配置; 未知 id 报错时用
  `listRegisteredProviderIds()` 列**在册的** (不是把内置表抄一遍)。
- 安装向导: `bolloon model --provider …` 与 `setup/onboard.ts` 的 `stepProvider`/`stepConnectivity`/
  `stepRuntime` 不再自己 `setActiveProvider` 或本地 `initMinimax` —— **装配只有 `installRuntime` 一处**。
- 长任务恢复: 用**该 Run 自己那份快照**走 `applyRunModelConfigToRuntime` (**不动全局**, P7 的「在跑的
  Run 不许漂移」), `resumeRun` 把 `modelApplied` 回给调用方, CLI 恢复处打印 `modelApplied`/`modelDrift`。

### 9.5 真跑证据 + 变异

`scripts/verify-model-entrypoints.ts` **59/0**, Web 侧是**真起 `createWebServer`**
(`scripts/lib/model-web-boot.ts`; 端口契约是 **`PORT` 环境变量** —— `--port` 从来不被解析, 冷启动本机
实测 **~114s**), 模型上游是 `scripts/lib/model-stub-server.ts` 的**假上游** (真 HTTP + 真 `/v1/models`,
所以「探测/发现真发生了」有上游命中数作证)。核心一条: **CLI 命令面 (真 argv 子进程) · 会话内 `/model`
(同一函数的会话形状) · 真 Web 路由** 三者都切到**同一家自定义供应商**, 各自在**独立进程**里读回
`EffectiveModelConfig` —— **11 个字段逐字段相同**, `configHash` 三者相同。三个入口分处三个进程、读回
也是另外起的进程 (同进程连调三次共享内存缓存, 那样的"绿"什么都不证明)。

变异 `scripts/verify-model-entrypoints-mutations.py` **3/3 判红**: 旧接口自己写 activeProvider **3 红**
(含「盘上配置被改了!」) · 自定义 provider 退回内置表 **11 红** · `/model refresh` 空转 **2 红**。

**顺手修掉一个被本轮接线逼出来的真缺口**: `model-discovery` 在**全新进程**里对自定义供应商会报
「未配置凭据 + 发现失败原因未明」—— 根因是注册表快照要 `config-store.initialize()` 才推, 内置那条路
顺手 initialize 了、自定义那条没做; 已补 `ensureConfigSnapshot()`。

### 9.6 如实留下

- Web 侧验收起的是**同一个 `createWebServer` 工厂**(路由是真的、HTTP 是真的、前端真能打), 但**不是**
  完整 `src/index.ts --web` 引导 (身份/kubo/IPNS 那一层没跑: 本机冷启动 ~114s 已是这套工厂, 完整引导更长)。
- 「会话内 `/model`」这条入口在门里用的是**同一个 `runModelCommand` 的会话形状调用**; 真 REPL 里那一步
  还会经过 ink 选择器 (要人按键), 门不会替你按键 —— 差别只在「谁来给选择」, 切换路径是同一条。
- 假上游只覆盖 OpenAI 兼容的 `/v1/models` + `/v1/chat/completions`; Anthropic 原生 / Gemini 原生那两条
  协议形状没被这道门覆盖 (既有 url-chain/registry 门覆盖它们的 URL 与鉴权形状)。
