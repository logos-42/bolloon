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
