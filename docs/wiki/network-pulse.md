---
title: 网络脉冲 (Network Pulse) — 匿名可验证的公开观察投影
source: session (leo 2026-09-18 计划 + 真实实现与真跑结论)
created: 2026-09-21
last_confirmed: 2026-09-22
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [network-pulse, public-projection, privacy, gateway, bolloon-ui, observed, verified, stale, confirmed-activity, chain-index]
---

# 网络脉冲 (Network Pulse) — 2026-09-21

> **一句话**:把已有 P2P 生命周期投影成**匿名、可验证、可降级**的公开统计,
> 供 bolloon-UI 网关页动态展示; 单节点看到的数据**不许说成全网精确总量**。

借鉴点来自 EigenFlux(只借产品与工程思想: 时间窗统计 · 服务端生成匿名活动文本 · `live/stale/unavailable` ·
短缓存与时间边界 · 隐私阈值 · 前端轮询/超时/退避 · 白名单投影),**不借**其 Go/Postgres/API/身份体系,
也不把 Bolloon 变成它的客户端。

## 1. 事件模型 (只记公开统计)

`src/agents/network-pulse.ts`

```ts
type NetworkEventType = 'node_joined' | 'manifest_published' | 'capability_announced'
                      | 'peer_connected' | 'delegation_completed'
                      | 'task_posted' | 'task_accepted' | 'task_completed'
                      | 'trade_settled' | 'trade_verified' | 'wallet_signed';   // 白名单, 其它一律拒

interface NetworkPulseEvent {
  type: NetworkEventType;
  bucket: string;              // epoch 小时
  capabilityGroup?: string;    // **粗类别** (原始能力名不落盘)
  occurredAt: number;
  sourceProof: string;         // sha256('bolloon-pulse|'+DID) 前 16 位 —— 不可逆
  agentProof?: string;         // sha256(node:agentId) 前 16 位
  signed?: boolean;            // 决定 scope 能否升到 verified
  integrity?: string;          // 本地完整性标记
}
```

挂点(fire-and-forget, **统计失败绝不影响主路径**):

| 生命周期 | 位置 | 记什么 |
| --- | --- | --- |
| 本机发布/更新 manifest | `agent-manifest-protocol.ts:setLocalManifest` | `manifest_published` + 每个 capability 一条 `capability_announced`(signed) |
| 收到远端 manifest | `agent-manifest-protocol.ts:cacheRemoteManifest` | `peer_connected` + 对方 capability |
| 入网成功 | `gateway-network.ts:joinNetwork` | `node_joined`(signed) |
| 委派成功 | `agent-gateway.ts:gatewayCallAgent` | `delegation_completed`(失败不进公开统计) |

## 2. 快照 (对外唯一的投影)

```json
{ "status": "live", "generated_at": 0, "fresh_until": 0,
  "scope": "observed", "scope_label": { "zh": "当前节点观察到", "en": "Observed by this node" },
  "totals": { "nodes": 0, "agents": 0, "active_agents": 0, "seen_last_24h": 0,
              "tasks": 0, "tasks_completed": 0, "tasks_verified": null, "signatures": 0, "tasks_settled": 0 },
  "totals_scope": { "source": "mixed", "window_ms": 86400000, "differs_from_activity": false,
                    "fields": { "tasks": { "source": "chain-index", "window": "full", "short": { "zh": "链上索引·全量" } },
                                "signatures": { "source": "signature-audit", "window": "window-24h", "short": { "zh": "24h 签名审计" } },
                                "tasks_verified": { "source": "none", "window": "unknown", "unavailable": true, "short": { "zh": "未接入" } } } },
  "capabilities": [ { "key": "research", "count": 3 } ],
  "recent_activity": [ { "kind": "node_joined", "at": 0, "text": { "zh": "有新节点加入网络", "en": "A node joined the network" } } ],
  "activity_totals": { "source": "chain-index", "rows": 25, "tasks": 12, "tasks_completed": 7, "tasks_settled": 6,
                       "by_finality": { "observed": 0, "confirmed": 4, "finalized": 21 }, "gates": { "confirmed": 1, "finalized": 12 } },
  "chain_id_scope": { "chain_ids": [31337], "activity_chain_id": 31337, "is_public_network": false,
                      "public_network_rows": 0, "public_network": { "chain_id": 84532 } },
  "notes": [ "单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量" ] }
```

硬规则(全部有断言):

- **两套口径不许打架**(2026-09-22 修 · **2026-09-24 改口径**): 见 §2.2 —— 现在**逐字段**钉来源,
  `totals.tasks/tasks_completed/tasks_settled` 直接取**链上索引同源值**(与同屏活动表恒等),
  `signatures` 取**本机签名审计账**; 没有源的字段 = `null`(页面写「未接入」, **不许拿 0 冒充「没发生过」**)。
- **去重**: 同节点同小时重复 `node_joined` 只记一次(不虚增节点数); capability 计数 = **不同 Agent 数**(同一 Agent 重复声明不虚增)。
- **隐私阈值** `privacyThreshold=3`: 少于 3 个 Agent 的类别**不单独暴露**, 合并进 `other`。小网络的正确表现就是"只有一个 other"。
- **上限**: 事件 5000 条 / 窗口 24h / 桶 1h / capability 最多 12 类 / 活动流最多 8 条; 超出丢最旧。
- **匿名**: 原始 DID、能力名、peerId、IP、钱包、任务正文**都不落盘、不出网**(事件文件里连 `did:key` 子串都没有)。
- **状态**: 新鲜期(30s)内 `live`; 过期 `stale`(**不伪装实时**); 观察层不可用 `unavailable`, 并明确写"这**不是**网络为空"。
- **scope 可信边界**: 单来源 → `observed`; **≥2 个签名来源** → `verified`(文案 `Verified network snapshot`)。两种都不等于"全网精确总量"。
- **malformed 安全**: 坏 events.json / 空数组里的 null / 缺字段的垃圾对象一律丢弃, 快照返回全 0 而不是崩。

## 2.1 冻结形状 `confirmed_activity` (2026-09-22 新增)

公开页面此前**只有数字**(节点数/Agent 数/任务数)。这一块把「**哪个任务 · 什么状态 · 哪个块 · 多少确认**」
落成可渲染的行 —— 形状**冻结**(字段名与顺序不许改), 内容一律**匿名短写**。

```json
"confirmed_activity_source": "chain-index",      // chain-index | pulse-events | none
"confirmed_activity": [
  { "task": "sha256:45a399ea", "kind": "task_created", "state": "active",
    "chain_id": 31337, "block": 676, "tx": "sha256:b25aa949",
    "confirmations": 1, "finality": "confirmed", "at": "2026-09-22T06:36:19Z" }
]
```

| 规则 | 口径 (有断言) |
| --- | --- |
| 数据源优先级 | ① **P5 链上索引**(`readIndexFile` = `~/.bolloon/chain/index.json`, 只读、**不发 RPC**) → ② 索引不可用/无可用行 → **退回脉冲事件** → ③ 两边都没有 → `none`。来源**如实写进快照** `confirmed_activity_source` |
| 任务/交易标识 | `task` = `sha256:` + `sha256('bolloon-pulse\|task\|' + taskKey)` 前 8 位十六进制; `tx` 同法。**绝不落 taskKey / taskId / txHash 原文**(验收断言: 快照 JSON 里连 `0x` 长 hex 都 0 次) |
| 事件 → (kind, state) | 唯一映射表 `CHAIN_EVENT_ACTIVITY`: `EscrowCreatedV2`→`task_created`/`active` · `ProofSubmittedV2`→`task_completed`/`active` · `ReleasedV2`→`trade_settled`/`released` · `RefundedV2`→`trade_settled`/`refunded` · `ExpiredV2`→`trade_settled`/`expired` · `DisputedV2`→`trade_settled`/`disputed`。kind 只能取冻结的 5 个值, 故按「任务生命周期 / 托管资金路径」归并;**真信号看 `state`**; 不认识的事件名 → 该条**不成行**(不猜) |
| 确认数门槛 | 取 chain-config 口径(默认 `confirmed=1` / `finalized=12`; 索引文件里记的门槛优先)。`confirmations` 用索引快照的 `headBlock` 复算 = `head - block + 1`; finality **只按确认数复算** —— 不够门槛/非法/被回退过 → `observed`, **绝不冒充** confirmed/finalized |
| 回退记录 | `suspect`(被重组回退 / 链上已消失)的记录**不成行** —— 不在规范链上的日志不该当活动列出 |
| 上限与排序 | 最新在前(`blockNumber` desc, 同块 `logIndex` desc), **上限 25 行** |
| 降级行 | 没有链上事实: `chain_id`/`block`/`confirmations` = 0, `finality` = `observed`, `state` = `unknown`(脉冲事件不带 escrow 结局, 不推); `tx` 填**事件摘要短写**(不是交易哈希 —— 字段名冻结只能这样填, 已在代码注释里写明) |
| 时间 `at` | ISO8601 UTC 秒级。链上索引行 = 本节点**首次观察到该事件**的时间(索引不存区块时间戳, **不臆造**); 降级行 = 事件发生时间 |
| 兼容 | 既有字段(`totals`/`recent_activity`/`capabilities`/`scope`/`agent_sites`)一个没动 —— 老客户端不炋 |

## 2.2 逐字段计数口径 + 链归属 (2026-09-22 立 · **2026-09-24 改口径**: 顶部数改取权威源)

**问题(真事, 两轮)**:
① 2026-09-22: 真跑导出的快照里 `totals.tasks / tasks_completed / tasks_verified / signatures` 全是 **0**,
   而同一份快照 `confirmed_activity` 有 **25 行真实任务** —— 同屏展示 = 读者只能读成"这个站在撒谎"。
② 2026-09-24 (leo 复看 bolloon.cn): 顶部 **任务 0 / 已完成 0 / 已验证 0 / 钱包签名 0** 而表里 **15 行 / 5 个不同任务**,
   且本机 `~/.bolloon/wallet-signatures.jsonl` 里 24h 内**确实有 8 条签名**。根因: `totals` 只数
   **本节点 24h 脉冲事件流**(那条流里可能一条经济事件都没有), 而表来自**链上索引全量** —— 一句话总口径解释不了
   一行里并排的 9 个数字。

**修法 (2026-09-24): 让每个数各自认领自己的源 + 让"没有源"可见**:

| 顶部字段 | 现在的事实源 | 窗口 | 无源时 |
| --- | --- | --- | --- |
| `totals.nodes / agents / active_agents / seen_last_24h` | `~/.bolloon/network-pulse/events.json` (本节点自己上报的脉冲事件) | 24h 滚动 | — |
| `totals.tasks / tasks_completed / tasks_settled` | **`activity_totals` 同源值** = P5 链上只读索引 `~/.bolloon/chain/index.json` | **全量索引** (不是 24h) | 索引不可用 → **降级**为脉冲口径并在 `fields[*].source` 如实标出 |
| `totals.tasks_verified` | **没有这个源** —— `CHAIN_EVENT_ACTIVITY` 里没有"验真"类链上事件 | — | `null` + `fields.tasks_verified.source='none'` → 页面写「未接入」 |
| `totals.signatures` | **本机签名审计账** `~/.bolloon/wallet-signatures.jsonl` (由 `task-contract.recordSignatureAudit` 落盘; 只数条数, 内容(金额/requestId/指纹)一律不进快照) | 24h 滚动 | 没账本 → 退回脉冲上报数; 两边都没有 → `null` + 「未接入」 |

**`null` 的语义 = "没有可用源"(未接入), 不是"没发生过"** —— 页面必须写「未接入」, 不许拿 `0` 冒充
(把 8 条真签名报成 0 就是这条规则要挡的事)。老快照(没有 `totals_scope.fields`)走老行为: 字段缺失整行隐藏。

**(2026-09-24) `notes` 里不再出现「未接入」这个词**: 公开页可见文字里这个词只留在**开发者说明卡片**里描述表格区降级的那一句(示例文案, 不是行情数据)。`notes` 改用等价说法 —— 「已验证」写「该口径无对应事件源, 不下发该字段 (不是 0)」, `signatures` 无源写「无可用源 (本节点既没有签名审计账, 也没有签名脉冲事件), 不下发该字段」。**语义一个字没变** (`null` = 没有可用源 ≠ 没发生过), **字段契约也没动**: `totals_scope.fields[*].short/label` 照旧(含 `unavailable:true`), 门 `UNAVAILABLE_WORDS` 只查逐字段口径 —— 所以「无源必须显式说明, 不许裸 0」这条纪律一位没松。

新增/变更的字段(老字段名一个没动, `tasks_settled` 只追加在最后 —— 老客户端读法不变):

| 字段 | 内容 (有断言) |
| --- | --- |
| `totals_scope` | `source`(= `pulse-events` / `chain-index` / `mixed`) · `window_ms` = 86400000 · `label{zh,en}` · `differs_from_activity` (bool) · **`fields[<9 个字段>]` = `{source, window, short{zh,en}, label{zh,en}, unavailable?}`**(逐字段口径: 页面就地贴在数字旁, 不只靠 notes) |
| `activity_totals` | **与 `confirmed_activity` 同源同刻算出**: `source`(= `confirmed_activity_source`) · `rows`(= 行数, 恒等) · `tasks` · `tasks_completed` · `tasks_settled` · `by_finality{observed,confirmed,finalized}`(三档之和 = 行数) · `gates` |
| `chain_id_scope` | `chain_ids`(升序去重) · `activity_chain_id`(行数最多的链; 并列取小) · `activity_chain_label`(展示名; 认不出的 chain id → `null`, **不编名字**) · `is_public_network` · `public_network_rows` · `public_network`(归属对照) · `note{zh,en}` |

**链归属(关键, 防误读)**: 行来自哪条链由 `chain_id_scope` 如实写; `is_public_network=false` /
`public_network_rows=0` 时页面必须点明「本机隔离开发链」, 是真公网链才允许写公网/主网/测试网措辞
(首页样例里的 chain id 只是展示归属, 不代表本快照观察到了那些链的事件)。

**导出前自检** `snapshotConsistencyIssues(snap)` → 问题清单(空 = 通过)(★ = 2026-09-24 新增):

1. `activity_totals` 必须在(与行同源的计数不能缺);
2. `activity_totals.rows === confirmed_activity.length`;
3. `by_finality` 三档之和 === 行数(没有第四条腿);
4. `activity_totals.source === confirmed_activity_source`;
5. 行里有任务而 `totals.tasks === 0` 时, notes 里**必须**有口径说明(同时出现「脉冲事件」「链上索引」与行数);
6. ★ `totals_scope.fields` **九键齐**(每个顶部数都要有自己的口径, 缺一个就报);
7. ★ **同一概念两个数不许并排矛盾**: `tasks/tasks_completed/tasks_settled` 声明 `chain-index` 时必须
   `=== activity_totals.*`(同源恒等); 与表冲突而 `differs_from_activity=true` 时必须有口径说明;
   表里一行都没有而顶部报了数 → 反向矛盾;
8. ★ **无源不许裸 0**: `source='none'` 的字段值必须是 `null`(配 `unavailable:true`), 写 0 就报;
   声明了源就必须真有值(值 `null` 而 `source≠'none'` 也报);
9. ★ 声明 `source='chain-index'` 但索引不可用(`activity_totals.source='none'`) → 报"声明与能力不符"。

`scripts/export-network-pulse.ts` 在写文件前跑这套自检, **不过就 `exit 3` 拒绝导出**(不把打架的快照发上线)。

## 3. 公开只读接口

```text
GET /api/public/network/progress
```

- **无认证**; `Cache-Control: public, max-age=15, stale-while-revalidate=15`; 带 `ETag`, 支持 `If-None-Match` → **304**。
- 空网络安全返回(全 0 且 `live`); 观察层不可用 → `unavailable`。
- **不暴露** Registry 原始数据; 本地接口(`/api/agent/*`、`/api/gateway/*`)保持原样, 继续只服务本地 Agent 与节点控制, **不给网站用**。

## 4. 真跑证据 (2026-09-21 建; 2026-09-22 复跑 + confirmed_activity)

- 单测 `src/test/network-pulse.test.ts` → **22/22**(白名单 · 去重 · 时间窗 · 隐私阈值 · 私有字段清理 · live/stale/unavailable · 空网络 · malformed · canonicalize · 活动文本模板); **2026-09-24 更新**: 空网络断言改成「有数就是数 / 无源就是 `null` + `signatures` 口径标 `none`」(不再是全 0 一坨)。
- 单测 `src/test/network-pulse-confirmed-activity.test.ts` → **25/25**(冻结字段与顺序 · task/tx 只出 sha256 短写 · 上限 25 · 最新在前 · state/kind 映射 · 1/12 门槛不冒充 · 索引不可用降级与 source 标注 · 老缓存缺字段→过期形状重算 · 无非匿名字段)。
- 单测 `src/test/network-pulse-consistency.test.ts` → **16/16**(公开页数字不许打架 · **2026-09-24 加 4 条**): 真索引 30 条 → 25 行时
  `activity_totals.rows === 行数`、`tasks`/`by_finality` 与**独立复算**(不复用被测代码)逐行一致、三档之和 = 行数;
  **顶部任务类计数 === `activity_totals` 同源值**(当年与 25 行并排打架的 0 已经不可能出现)、
  `tasks_verified` 在链上口径下 = `null` + 口径标「未接入」、`tasks_scope.fields` 九键齐、老 8 字段逐字不变;
  **钱包签名接真源**: 审计账 3 条(窗口内 2 条) → 顶部 = **2**(口径 `signature-audit`)、没账本 → 退回脉冲上报数、
  两边都没有 → `null` + 「未接入」(绝不拿 0 冒充)、快照里不出现审计账内容与绝对路径;
  **反向验证**自检抓得住**十二条**矛盾(rows 对不上 / 三档之和不对 / source 不一致 / 缺口径说明 / 同源计数整块缺失 /
  **缺 `totals_scope.fields`** / **字段缺键** / **有值却标无源(裸 0)** / **无值却标了源** / **同一概念两个数** /
  **反向矛盾(报了数却没行)** / **声明与能力不符**);
  `chain_id_scope` 本机 31337 → 非公网 + 公网 0 行、全公网 84532 → `is_public_network=true`、认不出的 chain id 不编名字;
  老缓存缺三块新字段 → 重算; **真跑导出脚本**(`npx tsx scripts/export-network-pulse.ts --home <tmp> --out ... --no-sign`)产出的 JSON 再独立验一遍。
- 双节点集成 `scripts/verify-network-pulse.ts` → **49 passed / 0 failed / EXIT=0**:
  ① A 发布 manifest → B 缓存 → 观察层看到 2 节点 2 Agent · 原始 DID 与原始能力名**都没落盘**;
  ② 小网络类别全进 `other`; 达阈值后 `research` 计数 = 4 个不同 Agent, 重复声明不虚增;
  ③ 缓存命中 / `stale` / `unavailable` 三态;
  ④ 坏数据不崩;
  ⑤ 真 HTTP: 无凭据 200 · Cache-Control · ETag · **304** · 响应无私有字段 · 本地接口仍在;
  ⑥ 前端消费契约(字段齐全 · 双语 scope_label · 无任务正文字段);
  ⑦ `confirmed_activity` 冻结形状: 无索引 → 空数组 + `none` · **真索引 30 条夹具 → 25 行且最新在前、逐字冻结、门槛复算、零 `0x` 长 hex** · 索引坏 → 降级 `pulse-events` 且不冒充链上。
- 真快照 (`scripts/export-network-pulse.ts` 真跑, 本机索引 chainId 31337 / head 676 / 328 条事件, 2026-09-22 复跑):
  `status=live scope=verified nodes=3 agents=4 active=3 24h=4 ... signed=true`; 快照里 25 行, 前两行 = block 676 `task_created/active/confirmed` 与 block 675 `trade_settled/expired/confirmed`;
  **两套口径同屏可核**(导出脚本 stderr 逐条打印):
  `totals(24h 脉冲事件口径)=tasks:0/tasks_completed:0/tasks_verified:0/signatures:0` ·
  `activity_totals(chain-index 同源)=rows:25/tasks:12/tasks_completed:7/tasks_settled:6/finality:{"observed":0,"confirmed":4,"finalized":21}` ·
  `differs_from_activity=true` · `chain_ids=[31337] activity_chain_id=31337(非公网) public_network_rows=0` · `consistency=OK`。
  与行数的关系(机器可核): `activity_totals.rows(25) === len(confirmed_activity)(25)` 且 `by_finality 之和(25) === 行数(25)`,
  所以 notes 写的是**真分布**`observed=0 / confirmed=4 / finalized=21`(以前只写门槛 `confirmed=1 · finalized=12`, 读者会误当分布)。
- 已独立核验: 25 行的 `task`/`tx` 摘要、块号、确认数与 `index.json` 的 `released/created` 事件**逐行一致**(用同一 sha256 公式复算, 独立脚本算出 25 行 / 12 个不同任务, 与快照的 `activity_totals` 相同), 且全文无 taskKey/txHash 原文、无任何 `0x` 长 hex。
- **2026-09-24 复跑 (leo:「数量怎么对不上, 尤其是后面的任务和钱包」)**: 本机链上索引 15 行 / 5 个不同任务
  (chainId 8453 = Base 主网, `public_network_rows=15`); 导出脚本 stderr 逐条打印:
  `顶部计数 (逐字段口径 {"tasks":"chain-index","tasks_completed":"chain-index","tasks_settled":"chain-index","tasks_verified":"none","signatures":"signature-audit"})=tasks:5/tasks_completed:3/tasks_settled:5/tasks_verified:未接入(null)/signatures:8` ·
  `activity_totals(chain-index 同源)=rows:15/tasks:5/tasks_completed:3/tasks_settled:5` · `differs_from_activity=false` ·
  顶部 `tasks===at.tasks` **OK** · `consistency=OK`。
  改前 (`totals` 取窄脉冲流): `tasks:1/tasks_completed:0/tasks_verified:0/signatures:0` 而表里 15 行 / 5 个任务 ——
  **改了 4 个数, 其中 `signatures` 从假 0 变真 8** (本机 `wallet-signatures.jsonl` 24h 内 8 条, 一直存在但没被读过)。
  页面侧 (bolloon-UI `scripts/verify-site.mjs` 真跑 + 真 DOM 拔值): 顶部 任务 **5** / 已完成 **3** / 已结算 **5** /
  已验证 **「未接入」** / 钱包签名 **8**, 每个数就近带口径短标记 (链上索引·全量 ×3 / 24h 脉冲 / 未接入 / 24h 签名审计),
  表格 15 行 / 5 个不同任务 / 3 完成 / 5 结算 → **顶部与表格同概念同数**。

## 5. 前端 (bolloon-UI 网关页)

网关页新增「全球网络脉冲 / Network pulse」区: 三到四个大数值 · capability 分布 · 匿名活动流 · 快照时间 ·
`live/stale/unavailable` 标签 · `Observed` / `Verified snapshot` 范围说明 · notes 里那句"不是全网精确总量"可见。

取数策略(诚实优先, **绝不编造数字**): ① `?pulse=<url>` 显式指定节点 → ② 同源 `network-pulse.json` 静态签名快照(过期就显示 `stale`)→ ③ 都拿不到 → `unavailable` + 说明如何用 `?pulse=` 指向本机节点。

**活动行数据契约(2026-09-22)**: 快照里的 `confirmed_activity` + `confirmed_activity_source` 是页面列
「任务 / 状态 / 区块 / 确认数」的唯一数据源 —— 字段名与取值域冻结, 前端**不要**自己推 state/finality,
按行渲染即可; `source=pulse-events` 或 `finality=observed` 的行必须显示成"未确认/非链上", 不得显示成已结算。

**口径行契约(2026-09-22 加)**: 表格下方除「数据源」外必须再渲染一行**口径行**(钩子 `data-pulse-activity-totals`),
内容从 `activity_totals` + `chain_id_scope` + `totals_scope` 原样取:

1. 同源计数: `24 行` 之类 —— 数字必须等于**实际渲染出来的行数**(`activity_totals.rows`, 与快照行数组同源);
2. 链归属: 用 `chain_id_scope.activity_chain_label` 把上表的 chain id 说明白(本机 31337 = 本机隔离开发链), 并标出
   `public_network_rows=0 → 这不是公网活动`; 认不出的 chain id 只显示数字, **不替它编网络名**;
3. 口径说明: `totals_scope.differs_from_activity=true` 时, 必须写出「上方任务/已完成/已验证/签名 = 24h 脉冲事件口径, 与本表 N 行(链上索引口径)不同, 不是数据丢失」——
   **页面不许出现「0 个任务」与「N 行任务」并存而不解释**; 快照没给这三块(老快照)就整行隐藏, 不猜。
4. (**2026-09-24**) 逐字段口径标记: 顶部每个计数旁必须挂 `data-pulse-scope-tag="<钩子名>"`,
   文本取 `totals_scope.fields[<字段>].short`(如「链上索引·全量」「24h 脉冲」「未接入」「24h 签名审计」),
   明细进 `title`; 快照没给 `fields`(老快照) → **一个标记都不写**(页面绝不替快照编口径)。
   同源字段(任务/已完成/已结算)在最严断言下必须与表格逐个相等 —— 见 `scripts/verify-site.mjs` 的
   `contradictionFindings`「同一概念不变量门」(变异验证: 把真快照改成 0 任务 → 门当场判红)。
   「未接入」也是**显示态**(不是隐藏): 快照给 `null` + `unavailable:true` 时页面写「未接入」+ 说明,
   写 0 会被读成「没发生过」—— 本机真事: 8 条真签名曾被报成 0。

前端行为: 首屏 loading · 成功 live · 快照过期 stale · 失败 unavailable · 30s 轮询 · 请求超时(AbortController)·
失败指数退避 · **任何失败不得影响页面其它区域** · 活动文本只用 `textContent`(禁 innerHTML) · 双语走 `data-zh/data-en` ·
相对时间只改文字节点 · 尊重 `prefers-reduced-motion` · `aria-live="polite"` · 移动端纵向堆叠。

## 6. 本批未做 (如实)

- 真正的**全球**公共观察入口(需要长期在线的观察者节点/Explorer); v1 只做"节点本地观察 + 可指定端点 + 静态签名快照"。
- 链上强绑定 · 世界地图 · Agent 头像/主页 · 公开 DID 列表 · 任务内容流 · WebSocket/SSE。
