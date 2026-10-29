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
