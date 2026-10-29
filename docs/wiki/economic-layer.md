---
title: 旁路经济层 (bolloon-econ)
source: session
created: 2026-10-29
last_confirmed: 2026-10-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [economics, cost-metering, intent-budget, settlement, shadow-mode, provider-registry, contributions]
---

# 旁路经济层 (bolloon-econ)

一句话：**在模型调用 / 工具执行 / 委托这三个既有边界上记账，先测真实成本，再谈分摊与交易；默认关闭，打开也默认只观察不干预。**

代码：`rust/crates/bolloon-econ/`（新 crate）。配置：`bolloon-config` 的 `economic`（F 类）。接线：`bolloon-agent` 的 `econ_shadow::EconomyObserver` + `KernelLoop::ObserverChain`。

## 1. 审计：接在哪、为什么不改核心

| 环节 | 真实位置 | 经济层怎么接 |
|---|---|---|
| 意图 | `bolloon-agent/src/world.rs` `Intent{id,text,tags,active}` | 意图 id 作为 `CallCtx.intent_id`（可选，缺了如实记空） |
| 模型调用 | `bolloon-llm::LlmRuntime::generate/generate_streaming` ← 各 `LoopStrategy::call` | **不碰 llm 层**：由 `KernelLoop` 的每轮 `GenerateResult.usage` 记账 |
| 工具执行 | `bolloon-harness::Harness::gate` → `ToolResult{ok,elapsed_ms,evidence}` | **不碰 harness**：由观察者 `on_tool_result` 记账 |
| 委托 | `bolloon-agent/src/subagents.rs`（`AgentWorkContract`） | 提供 `on_delegation(ctx, child, depth)`；本期未在派遣处强制调用 |
| 任务/运行 id | `bolloon-kernel::run_lifecycle::RunId`、配置证据链 `task_id` | 复用 `task_id`（CLI `cli-<ts>-<pid>`、Web `web-<ts>-<pid>`） |
| 配置 | `bolloon-config` (A–E 分类 + 原子快照) | 新增 F 类 `economic`，默认全关 |

为什么能"不改核心"：`KernelLoop` 已经暴露 `LoopObserver`（为 TUI 与配置证据链加的），经济层只是**再挂一个观察者**。它在循环之外，拿不到执行权，只能看。

## 2. 架构

```
KernelLoop ──(事实)──► ObserverChain ──► EconomyObserver ──► ShadowEconomy
                                   └────► CliObserver（渲染/工具行）

ShadowEconomy
 ├─ UsageMeter          消耗账本: 每次模型/工具/委托一条 JSONL (幂等 event_id)
 ├─ PriceTable          价格表: 版本化, 从文件加载; 没价格就不编金额
 ├─ BudgetGuard(每意图)  预算: 现金/调用次数/委托深度/隐私/provider 白名单 → 只回答"本该拦吗"
 ├─ ProviderRegistry    供给登记: 外部API/自有API/本地/社区/Agent服务/赞助; 登记≠授权
 ├─ StandardRouter      路由策略: Baseline/LocalFirst/LowestCost/QualityFirst/CommunityFirst (本期影子)
 ├─ ContributionLedger  贡献账本: Pledged→Executed→Verified→Confirmed (自证无效)
 └─ SettlementLedger    结算账本: 多方分摊, 守恒, 幂等, 公共池现金闸
```

## 3. 三个账本（不合并成一种积分，更不发币）

| 账本 | 记什么 | 关键约束 |
|---|---|---|
| **消耗** `econ-meter.jsonl` | event_id/schema_version/时间/意图/任务/父任务/发起方/执行方/provider/model/token in-out-cache/耗时/状态/价格版本/估算 vs 确认成本/结算状态/证据 | 幂等；缺数据就 `None`；`confirmed` 只能来自账单核对 |
| **贡献** `econ-contributions.json` | 现金(API 额度/赞助) / 本地推理 / 工具 / 任务执行 / 知识，状态四段 | 只有 `Confirmed` 的现金进公共池；非现金不折算成钱；不能自己验收自己 |
| **结算** `econ-settlements.json` | 每笔成本由谁承担、各承担多少、依据、状态 | `Σ分摊 ≤ 成本`；未授权 payer 直接拒；同一笔成本只能结算一次；公共池只有已到账现金能花 |

`RU`（资源额度）本期**不做**：没有真实供需数据前，任何兑换比例都是编的。接口留了扩展位（`CostShare`/`Payer`/`PublicPool`）。

## 4. 配置（F 类，默认全关）

```json
{
  "economic": {
    "enabled": false,
    "mode": "shadow",
    "metering_enabled": true,
    "budget_enforcement_enabled": false,
    "community_routing_enabled": false,
    "contribution_settlement_enabled": false,
    "pool_cash_available_usd": 0.0,
    "default_intent_budget_usd": null,
    "default_max_model_calls": null,
    "default_max_delegation_depth": 3,
    "price_table_file": null
  }
}
```

校验 (拒绝非法组合)：
- `budget_enforcement_enabled` / `community_routing_enabled` 只能在 `mode=enforce` 下为 true —— **shadow 里开强制 = 偷偷改行为**，直接拒。
- 池子现金必须非负有限；委托深度 ≤ 8。
- 授权级别：只改计量/影子参数 = Operator；打开**强制预算 / 社区路由 / 贡献结算** = System（AI 永远够不到）。

## 5. Shadow Mode 怎么跑

```bash
# 1) 打开经济层（只计量）
curl -X POST localhost:54188/api/config/apply -H 'content-type: application/json' -d '{
  "config": {"economic": {"enabled": true, "price_table_file": "prices.json"}},
  "operator": "leo", "reason": "开启影子计量"
}'
# 2) 价格表放 <BOLLOON_HOME>/econ/prices.json（必须带 version）
# 3) 正常用；然后看账：
curl localhost:54188/api/econ/report | python3 -m json.tool
```

CLI 侧：每轮结束会打一行摘要

```
经济层(shadow) 模型 2 次 · token in/out 22/14 · 估算 $0.000050 · 未定价 1 · 本该拦 0
```

`本该拦 N` 就是"如果开强制，这一轮会被拦几次"——影子模式只记不拦。

## 6. 逐步启用顺序（不可跳）

1. **只计量**（当前）：`enabled=true, mode=shadow`。目标：拿到每个意图的真实成本分布。
2. **开预算强制**：`mode=enforce` + `budget_enforcement_enabled=true`（System 授权）。先只设宽松上限，观察"被拦率"。
3. **登记社区供给**：`ProviderRegistry` 写入本地模型/社区模型（`owner_authorized` 必须由所有者自己置 true），先只看 `selectable()`，不开路由。
4. **开社区路由**：`community_routing_enabled=true`（System）。当前实现是**影子路由**（只记录本会选谁），真实切换是下一步。
5. **开贡献结算**：等真实供需稳定、有反作弊规则后再说。现在开只会产生不可兑现的承诺。

## 7. 关键指标（`/api/econ/report`）

- 每个意图的估算成本 / 每个成功任务的现金成本（`by_intent`）
- 免费任务占比（`free_task_completion_rate`，按零现金成本的意图算）
- 失败/重试额外成本（`meter.failures` / `meter.retries`）
- 计量缺口（`meter.unpriced_events` 没价格表 / 没 usage 的条数；`meter.duplicates` 幂等命中）
- 影子结论（`would_block[]`：规则 + 说明 + 是否放行；`shadow_routing[]`）
- 公共池：可用 / 承诺 / 已支出；结算按 payer 汇总
- 贡献：确认现金（才是钱）/ 承诺现金（不是钱）/ 非现金维度

## 8. 测试（36 条验收，`cargo test -p bolloon-econ`）

A 关闭即零行为 · 旧配置缺 `economic` 仍可解析 · shadow 不许开强制 · 开结算需 System
B 意图/任务/provider 关联 · token 与耗时 · 估算 ≠ 确认 · 缺价格/缺 usage 记 `None` · 幂等 · 失败/重试分列 · 价格表无版本拒用
C 调用次数/现金上限 · 委托深度与数量 · 隐私禁外部 · 未授权 payer 不结算 · 默认耗尽策略=Stop
D 登记/更新/退役/撤销授权即时生效 · 落盘可恢复 · 四种路由策略各自选对 · 隐私与质量门槛 · 影子路由不改真实调用
E 守恒 · 未授权拒 · 重复结算拒 · 池子不能花没到账的钱 · 承诺≠现金 · 回滚释放承诺且可审计
F 账本无 api_key/Bearer/sk- · 无 prompt 原文 · report JSON 无密钥材料

真实端到端（本机，假上游）：CLI 一轮两次模型调用 + 一次工具调用 → `econ-meter.jsonl` 两条带 `price_version=2026-10-29.e2e`、`cost_usd_estimated=0.000025`（11·1e-6 + 7·2e-6 ✓），工具事件带失败证据且 `unpriced` 如实计数。

## 9. 尚不具备 / 不能保证

- **不是分布式账本**：三个账本都是本机文件（JSONL/JSON）。跨节点共享成本、跨节点结算、防篡改，都没有。
- **委托计量未强制**：`on_delegation` 接口在，但 `subagents.rs` 的派遣路径还没调用它 → 现有的委托不会自动出现在账本里。
- **路由只到"影子"**：`StandardRouter` 会算出"本会选谁"，但不会真的换 provider。
- **缓存/批次计费**：`LlmRuntime::Usage` 只有 input/output 两个数，没有缓存命中 token，所以 `tokens_cache` 恒空、缓存放大的成本会被高估。
- **未确认成本**：`cost_usd_confirmed` 字段存在，但没有接供应商账单核对；现在全是"估算"。
- **RU / 代币 / 可转让凭证**：刻意不做。没有真实供需就发行，只能制造不可兑现的承诺。
- **免费承诺**：本层不承诺任何东西免费；它只让"谁花了多少、本该谁付"变得可见可查。

## 10. 回滚

`economic.enabled=false`（或删掉整个 `economic` 字段）→ 观察者根本不挂 → 零记录、零行为差异；已产生的账本文件保留（审计用），也可以直接删 `econ/` 目录。

## 11. 群聊计量（2026-10-29 补）

**为什么必须单独接**：此前 `on_model_call` 只在 CLI 的 `econ_shadow` 里被调用，web 侧 `call_model` 里 econ 出现 **0 次** ⇒ 群聊/私聊的每一次模型调用都进不了账本，"集体分摊群聊成本"根本无从谈起。

**接法（旁路，不改任何调用语义）**：

| 项 | 落点 |
|---|---|
| 唯一咽喉 | `native::call_model_metered(st, system, msgs, Option<EconCtx>)`；`call_model` 保留为 `None` 包装，旧调用方零改动 |
| 归属 | `EconCtx { intent_id, group_id, agent_id, surface }` |
| 记录 | 成功：`tokens_in/out` 取自 `GenerateResult.usage`；失败：`status=failed` 且 token **留空不编**；`evidence` 带 `group_id/agent_id/surface` |
| 根意图 | 一条群消息 = 一个 `group_intent(gid, ts_ms)`；被推举的 N 个 agent 的调用**共用它** |
| 私聊 | 每条消息一个 `chat:<ts>` 意图（`surface=web-chat`） |

判据（`bolloon-web` 25/25 里的 `group_calls_share_one_root_intent_in_meter`，走真咽喉不直接调 econ）：
三个 agent 各调一次 ⇒ 账本 **3 条事件**，`intent_id` 全同、`agent_id` 各异、`group_id` 同一个；
失败也记、token 不编 0；经济层没挂 ⇒ 一条都不记。
变异验证：把 `c.intent_id = Some(...)` 改成 `None` ⇒ 该用例必红，恢复即绿。

## 12. 群聊成本随「接话的 agent 数」线性放大（上限 1000）

群聊智能体上限由 leo 定为 **1000**（`room_bus::MAX_ELECTED_AGENTS`，原先是 `take(3)`）。一次调用按实测
**in 6.5k / out 150** 计（群里带人设 + 群史，比私聊 5.5k 略高）。

| 接话 agent 数 N | A 廉价(0.5/1) | B 国产(2/8) | C 旗舰(15/60) | 吃缓存前缀后 B |
|---|---|---|---|---|
| 1 | ¥0.003 | ¥0.014 | ¥0.106 | ¥0.014 |
| 3 | ¥0.010 | ¥0.043 | ¥0.319 | ¥0.022 |
| 10 | ¥0.034 | ¥0.142 | ¥1.065 | ¥0.048 |
| 100 | ¥0.34 | ¥1.42 | ¥10.65 | ¥0.39 |
| **1000（上限）** | **¥3.40** | **¥14.20** | **¥106.50** | **¥3.81** |

- 1000 条群消息 @N=1000：A ¥3,400 · B ¥14,200 · C ¥106,500
- 一天 100 条 @N=1000：A ¥340 · B ¥1,420 · C ¥10,650
- 每个 agent 单次：A ¥0.0034 · B ¥0.0142 · C ¥0.1065

**延迟是真瓶颈（并发闸 `LlmRuntime::from_config(cfg, 2)` = 同 provider 最多 2 个在途）**：
一条消息推举 N 个 agent 就是 N 次调用排队 —— N=100 时 17–66 分钟，**N=1000 时 2.8–11 小时**。
所以"上限 1000"目前是**产品上的允许值**，不是可用的运行时；要真跑起来必须同时抬高并发
（受供应商限流约束）并把"一条消息全员开口"改成异步分批/回执。

三条结论：
1. **群聊不是"摊薄"，是"复制"**：除非共享推理结果或吃缓存前缀，一条消息成本 = N × 单次；N 无上限 ⇒ 成本无上限。
2. **成本闸只能设在意图预算上**：`default_max_model_calls = 20` 时，一条消息的现金上限是
   A ¥0.068 · B ¥0.284 · C ¥2.13 —— 这才是把 1000 上限变得可控的那个旋钮。
3. 缓存前缀能把 N 倍压到 ~1.4 倍（N=1000 时 ¥14.20 → ¥3.81），但**省不掉排队**。

## 13. 闸口：从"只记账"变成"真能拦"（2026-10-29）

之前 `call_model_metered` 拿到 `BudgetDecision` 就丢掉了 —— 意图预算只是算了个判定。现在三层：

| 层 | 实现 | 生效条件 |
|---|---|---|
| 原子预留 | `BudgetGuard::try_reserve_model_call` 在 `reserve_lock` 内做「判定 + 计数」 | 总是（并发扇出下上限才准） |
| 节点日闸 | `ShadowEconomy::begin_model_call` 的 `daily_model_calls` / `daily_cash_usd`，跨意图计数、跨天自动清零 | 配了日上限 |
| 意图闸 | `guard_for_ctx(ctx)` 的 `max_model_calls` / `max_cash_usd` / 委托深度 | 配了意图预算 |
| 拦截动作 | `call_model_metered` 在 `decision.is_block() && enforcement()` 时**直接返回错误**，不发起调用 | `enabled && mode==Enforce && budget_enforcement_enabled` |

**为什么必须原子**：`check` 读计数、`record` 在响应回来后才 `fetch_add`。1000 个 agent 并发时它们
会在同一瞬间都读到 `calls=0`，全部判允许 ⇒ `max_model_calls=20` 实际能跑出 1000 次。
`reservation_is_atomic_under_fanout`（1000 线程抢 20 名额 ⇒ 恰好 20 通过）钉住这条；把预扣去掉，
该用例立刻红（已做变异验证）。

**金额怎么预扣**：`estimate_cost(provider, model)` = 该 provider|model **最近一次真实成本**；没有历史
就 `None`（只占调用次数，不用拍脑袋的常数把用户挡在门外）。响应回来用 `reconcile_model_call` 按实际补/退差额。

**不许假装有现金闸**：没有价格表时 `report.cash_gate_enabled=false`，`daily_cash_usd`/`max_cash_usd`
都是装饰字段 —— 报告如实说，而不是显示一个永远不会触发的 0。

## 14. 接话预算：大群默认 5 个小组长（leo 2026-10-29 定）

| 参数 | 值 | 位置 |
|---|---|---|
| 群聊智能体产品上限 | 1000 | `room_bus::MAX_ELECTED_AGENTS` |
| 大群阈值 | >10 人 | `room_bus::GROUP_LARGE_THRESHOLD` |
| 大群每轮接话数 | 5 | `room_bus::DEFAULT_REPLIES_WHEN_LARGE` |
| 警长设定 | `POST /api/groups/{id}/reply-limit {n, by}` | 夹到 1..=1000，持久化在 `ForgeState.room_reply_limit` |
| 只读 | `GET /api/groups/{id}/reply-limit` | 回 `reply_limit` / `source`(sheriff\|default) / `members` |

规则：`reply_limit_for(members, sheriff)` —— 警长显式值优先；否则 ≤10 人按命中数，>10 人只放 5 个。
**只限"被推举接话"**：警长派发的 `[[task:id:desc]]` 与其余成员的异步干活不受限，重要结论才回群。

效果：12 人全员被 @ 时只推 5 个（`reply_limit_follows_size_and_sheriff`），一条消息成本从 12× 降到 5×。

## 15. 共享资源池接口（真 HTTP，2026-10-29 接上）

| 端点 | 作用 |
|---|---|
| `GET /api/econ/probe` | 只读探针：可选用供给 / 公共池 / 日账 / 接话规则（给 agent 与前端看） |
| `POST /api/econ/providers` | 登记或更新供给（**登记 ≠ 授权**：`owner_authorized=false` 只能被看见） |
| `POST /api/econ/providers/{id}/revoke` | 所有者撤销授权，立即退出可选用集合 |
| `POST /api/econ/contributions` | 认捐（`cash_sponsor` / `api_credit` / `local_inference` / `tool_service` …） |
| `POST /api/econ/contributions/{id}/confirm` | 独立验收确认（`by == contributor` 一律拒） |
| `POST /api/econ/pool/topup` | 补**已到账**现金进公共池（记 Confirmed 贡献） |
| `POST /api/econ/intent/{id}/budget` | 给意图挂 `max_model_calls` / `max_cash_usd` |

`econ_shared_pool_endpoints_e2e` 真 HTTP 跑通：未授权供给 `selectable=false` → 授权后 `true` →
认捐后池子仍 0.0（承诺 ≠ 到账）→ 独立确认后 5.0 → 自己验收自己 `ok=false` → 意图预算回读一致。

**已知缺口（诚实）**：
1. `reply-limit` 端点**没有校验 caller 是不是警长**（警长选举结果未按群持久化）—— 现在谁调谁生效，只在响应里记 `set_by`。
2. 公共池跨节点不可见：`econ-*.json/jsonl` 是本机文件，没有 P2P 同步；"互相共享"目前 = 同一节点内的多方供给。
3. 没有 agent 侧工具（`econ_probe` 只在 HTTP 层）—— 智能体自己还不能申领共享额度。

## 16. 诚信额度与双层档案（可上链 + 链下详细）

| 层 | 内容 | 为什么 |
|---|---|---|
| `OnChainAttestation` | schema/主体/窗口/档位/额度/成功意图/已验收贡献/到账现金/被拦次数/是否限流/**detail_digest**/digest | 最少必要事实，跨节点可验证；**不含**理由与正文 |
| `OffChainProfile` | 历史明细、额度增减逐条理由、限流解释、加群额度、`goodwill_path`（怎么赚额度） | 详细、可读、留本地/自托管 |

- 确定性：canonical JSON（键排序 + 浮点 6 位）⇒ 同档案同 digest；改一个字段 `verify()` 立刻 false（已测）。
- 永不封号：`flags` 只可能出现 `throttled`；地板额度 `floor_calls=5` 恒 >0。

`GET /api/econ/reputation/{principal}` 同时返回 `onchain` 与 `offchain`。

## 17. 加群额度（账号年龄 + 违规）

| 条件 | 额度 |
|---|---|
| 新面孔（第 1 天） | **10/天** |
| 第 5 天起 | **100/天** |
| 满 30 天且无违规 | **500/天** |
| 任一违规操作 | **5/天**（不清零、不封号） |

依据 leo 2026-10-29 口径：`JOIN_QUOTA_NEW_DAY=10` · `DAY5=100` · `MATURED=500` · `PENALTY=5`，
`join_quota_by_age(age_days, violations)`。超限只拒"新加群"，**已有群发言/干活/接任务不受影响**，
响应里 `quota_exhausted=true` + 明确原因 + 明天恢复。

## 18. 群内诚信标识：智能体可见，人类不可见

- 低信任（Throttled）发言写入 payload 的 `trust`（`low_trust`），新面孔写 `watch`；经 `say_flagged` 落块留痕。
- `GET /api/groups/{id}/messages`：**默认剥掉** `trust`，并回 `trust_visible=false`；
  带 `?role=agent`（agent 工具 `group_read` 自动带）才返回 `trust`，`trust_visible=true`。
- 理由：标识是给智能体设防用的协作信号，不是给人类做公开标签。

## 19. 免疫系统：菌群 quorum sensing，但同轮生效

| 机制 | 生物菌群 | BOLLOON |
|---|---|---|
| 信号 | 分子扩散 | `ImmuneSystem::raise()` 入库即评估 |
| 阈值 | quorum 达成才切换表型 | ≥3 报告者 + 浓度 3.0 ⇒ `restricted`；≥5 + 6.0 ⇒ `quarantined` |
| 稀释 | 扩散/降解 | 半衰期 6h 指数衰减，隔离 2h 到期**自动**解除 |
| 反武器化 | — | **单点不定罪**：一个 agent 再刷也只能到 `watch` |

权重：spam 0.5 · failed_verification 1.0 · budget_abuse 1.5 · prompt_injection 2.0 ·
impersonation 2.5 · data_exfiltration 3.0。

落地：`POST /api/econ/immune/report`（任何 agent 可报）、`GET /api/econ/immune/{subject}`；
`quarantined` 的成员**本轮不进推举名单**（`elect_from_roster` 后过滤），但不禁言、不封号。
agent 工具：`immune_report` / `immune_status`。

## 20. 群聊组织：1 + 5 + 12 = 18 可直接回复

`roster_from_ranked()`：评分第 1 名警长、其后 5 小组长、再 12 领班（`DIRECT_REPLY_MAX=18`）；
`elect_from_roster()` 只从名单内选接话者，**名单外被 @ 也不刷群**（只接任务）。
名单与警长同任期 **3 天一轮换**（`SHERIFF_TERM_DAYS=3`，`term_expired()` 纯函数）。
`reply-limit` 端点现在**只有现任警长能设**（`set_room_reply_limit` 校验），无警长则 fail-closed。

## 21. 邀请与加入

- `GET /api/groups/{id}/invite` → `link`（`bolloon://join/…`）+ `abs_link`（`https://bolloon.cn/?join=…`）
- UI：侧边栏底部 **结束 | 邀请** 并排，点「邀请」复制链接（`sidebarInvite`）
- agent 工具：`group_invite` / `group_join` / `group_members` / `group_read`（走 `BOLLOON_LOCAL_API`，web 启动时自注入）
- 经济工具：`econ_probe` / `econ_claim`（只读探针 + 申领判定，含"不封号"出口）

**仍未做**：公共池跨节点同步（还是本机账本）；agent 间 @ 转下一轮接话；Windows/Linux 包。

## 22. 意识成长档案（人类不可见指标）

| 项 | 内容 |
|---|---|
| 输入 | **只有可核验行为**：帮人且被确认 / 承诺兑现 / 分享被确认 / 主动更正 / 深层追问 / 冲突降温 / 不烧钱成事 / 连续复盘 |
| 结构约束 | 输入结构里**没有**信仰·民族·国籍·政治·性别字段（单测断言 JSON 不含这些键） |
| 打分 | 0..100 指数，饱和曲线（刷量 1000 倍只差 ≤7 分）；阶段 Seed<Sprout<Steady<Deep<Luminous |
| 权限 | 只加不减：额度倍率 1.0–2.0（并入 `allowance_for`）、加群加成 0–120、`can_mentor`、排队优先级 |
| 人类侧 | `GET /api/econ/consciousness/{id}` 默认返回 `human_view`：**无 index/阶段/分数**（`quantified:false`），只给 `needs`+`growth_path` |
| 智能体侧 | `?role=agent` 返回完整档案，据此调整帮助方式 |
| 底线 | 地板额度不受影响 —— 指标决定"多给什么帮助"，永不决定"能不能说话" |

德性原型（佛陀/慧能/老子/苏格拉底/孔子/穆罕默德）仅作为"什么行为算善"的命名引用，
**不参与身份判定**。

## 23. 公共池跨节点（拉取式 + 验签）

| 端点 | 作用 |
|---|---|
| `GET /api/econ/pool/view` | 本节点快照（ed25519 签名，`schema=bolloon.pool-view/v1`）+ 已验证对端 + `network` 汇总 |
| `POST /api/econ/pool/peers {url}` | 拉取对端快照并验签后入缓存（同节点只留最新） |
| `POST /api/econ/pool/peers {peer}` | 直接接收别人推来的快照，同样验签 |

- 验签：用 `node` 的 DID 反解公钥（`did:pi:<b58 pubkey>`），对**去掉 sig/schema** 的规范化 JSON（键排序）验 ed25519。
- 不计钱规则：`network.cash_available_sum_usd` **只求和验签通过**的对端；伪造的留在列表里标 `verified:false`，不参与求和。
- 传输是**拉取式**（不是 gossip）：`serve_on` 注入 `BOLLOON_LOCAL_API`；节点互相 POST url 即可同步。
- 证据：`pool_view_crosses_nodes_only_when_signature_holds`（两节点不同身份 → A 充 5 美元 → B 拉取验签通过 → 全网 5.0；篡改一个数字 ⇒ `verified:false` 且求和回到 0）。

