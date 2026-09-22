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
              "tasks": 0, "tasks_completed": 0, "tasks_verified": 0, "signatures": 0 },
  "totals_scope": { "source": "pulse-events", "window_ms": 86400000, "differs_from_activity": false },
  "capabilities": [ { "key": "research", "count": 3 } ],
  "recent_activity": [ { "kind": "node_joined", "at": 0, "text": { "zh": "有新节点加入网络", "en": "A node joined the network" } } ],
  "activity_totals": { "source": "chain-index", "rows": 25, "tasks": 12, "tasks_completed": 7, "tasks_settled": 6,
                       "by_finality": { "observed": 0, "confirmed": 4, "finalized": 21 }, "gates": { "confirmed": 1, "finalized": 12 } },
  "chain_id_scope": { "chain_ids": [31337], "activity_chain_id": 31337, "is_public_network": false,
                      "public_network_rows": 0, "public_network": { "chain_id": 84532 } },
  "notes": [ "单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量" ] }
```

硬规则(全部有断言):

- **两套口径不许打架**(2026-09-22 修): `totals.*` 的口径 = **本节点 24h 窗口内的脉冲事件**; `confirmed_activity` 的口径 = **链上索引全量**。两者同屏出现时数字本来就不同 → 快照必须同时给 `activity_totals`(与行同源)、`totals_scope`(口径说明 + `differs_from_activity`)和 notes 里的口径说明; 行里有任务而 `totals.tasks=0` 时,**没有口径说明就是不一致**(`snapshotConsistencyIssues` 会报, 导出脚本直接 `exit 3` 拒绝导出)。见 §2.2。
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

## 2.2 两套计数口径 + 链归属 (2026-09-22 leo 拍板: 公开页不许自相矛盾)

**问题(真事)**: 真跑导出的快照里 `totals.tasks / tasks_completed / tasks_verified / signatures` 全是 **0**,
而同一份快照的 `confirmed_activity` 有 **25 行真实任务** —— 公开页把这两个数字**同屏**展示, 读者只会读成
"自相矛盾 / 这个站在撒谎"。两块本来就来自**两套事实源**, 所以修法不是把数字改漂亮, 而是让口径**可见可核**:

| 块 | 口径 | 事实源 | 窗口 |
| --- | --- | --- | --- |
| `totals.*` | 本节点观察到的**脉冲事件**计数 | `~/.bolloon/network-pulse/events.json` (本节点自己上报的) | **24h** 滚动窗口 |
| `activity_totals.*` / `confirmed_activity` | **链上事实**计数 / 逐行 | P5 链上**只读索引** `~/.bolloon/chain/index.json` | **全量索引** (不是 24h) |

新增三块(老字段一个没动 —— 老客户端不受影响):

| 字段 | 内容 (有断言) |
| --- | --- |
| `totals_scope` | `source` = `pulse-events` · `window_ms` = 86400000 · `label{zh,en}` 写明"只数本节点 24h 内收到的脉冲事件" · `differs_from_activity` (bool) |
| `activity_totals` | **与 `confirmed_activity` 同源同刻算出**: `source`(= `confirmed_activity_source`) · `rows`(= 行数, 恒等) · `tasks` · `tasks_completed` · `tasks_settled` · `by_finality{observed,confirmed,finalized}`(三档之和 = 行数) · `gates` |
| `chain_id_scope` | `chain_ids`(升序去重) · `activity_chain_id`(行数最多的链; 并列取小) · `activity_chain_label`(展示名; 认不出的 chain id → `null`, **不编名字**) · `is_public_network` · `public_network_rows` · `public_network`(归属对照) · `note{zh,en}` |

**链归属(关键, 防误读)**: 那 25 行的 `chain_id` = **31337(本机隔离开发链)**, 一条公网事件都没有 ——
`chain_id_scope.is_public_network=false` / `public_network_rows=0`, note 逐字写
「上表 25 行来自 chainId 31337（本机隔离开发链） · 公网链（Base Sepolia 测试网 84532）0 行 —— 这不是公网活动」。
首页样例里出现的 `84532` 是**公网测试网(Base Sepolia)的展示归属**, 不代表本快照观察到了公网事件
(本机只读索引覆盖的是 31337; 公网那条只读同步路径见 `scripts/verify-base-sepolia-readonly.ts`, 与本快照无关)。

**导出前自检** `snapshotConsistencyIssues(snap)` → 问题清单(空 = 通过), 五条:

1. `activity_totals` 必须在(与行同源的计数不能缺);
2. `activity_totals.rows === confirmed_activity.length`;
3. `by_finality` 三档之和 === 行数(没有第四条腿);
4. `activity_totals.source === confirmed_activity_source`;
5. 行里有任务而 `totals.tasks === 0` 时, notes 里**必须**有口径说明(同时出现「脉冲事件」「链上索引」与行数)。

`scripts/export-network-pulse.ts` 在写文件前跑这套自检, **不过就 `exit 3` 拒绝导出**(不把打架的快照发上线)。

## 3. 公开只读接口

```text
GET /api/public/network/progress
```

- **无认证**; `Cache-Control: public, max-age=15, stale-while-revalidate=15`; 带 `ETag`, 支持 `If-None-Match` → **304**。
- 空网络安全返回(全 0 且 `live`); 观察层不可用 → `unavailable`。
- **不暴露** Registry 原始数据; 本地接口(`/api/agent/*`、`/api/gateway/*`)保持原样, 继续只服务本地 Agent 与节点控制, **不给网站用**。

## 4. 真跑证据 (2026-09-21 建; 2026-09-22 复跑 + confirmed_activity)

- 单测 `src/test/network-pulse.test.ts` → **22/22**(白名单 · 去重 · 时间窗 · 隐私阈值 · 私有字段清理 · live/stale/unavailable · 空网络 · malformed · canonicalize · 活动文本模板)。
- 单测 `src/test/network-pulse-confirmed-activity.test.ts` → **25/25**(冻结字段与顺序 · task/tx 只出 sha256 短写 · 上限 25 · 最新在前 · state/kind 映射 · 1/12 门槛不冒充 · 索引不可用降级与 source 标注 · 老缓存缺字段→过期形状重算 · 无非匿名字段)。
- 单测 `src/test/network-pulse-consistency.test.ts` → **12/12**(公开页数字不许打架): 真索引 30 条 → 25 行时
  `activity_totals.rows === 行数`、`tasks`/`by_finality` 与**独立复算**(不复用被测代码)逐行一致、三档之和 = 行数;
  `totals.tasks=0` 与 25 行并存 → `totals_scope.differs_from_activity=true` 且 notes 里口径说明在;
  **反向验证**自检抓得住五种矛盾(rows 对不上 / 三档之和不对 / source 不一致 / 缺口径说明 / 同源计数整块缺失);
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

前端行为: 首屏 loading · 成功 live · 快照过期 stale · 失败 unavailable · 30s 轮询 · 请求超时(AbortController)·
失败指数退避 · **任何失败不得影响页面其它区域** · 活动文本只用 `textContent`(禁 innerHTML) · 双语走 `data-zh/data-en` ·
相对时间只改文字节点 · 尊重 `prefers-reduced-motion` · `aria-live="polite"` · 移动端纵向堆叠。

## 6. 本批未做 (如实)

- 真正的**全球**公共观察入口(需要长期在线的观察者节点/Explorer); v1 只做"节点本地观察 + 可指定端点 + 静态签名快照"。
- 链上强绑定 · 世界地图 · Agent 头像/主页 · 公开 DID 列表 · 任务内容流 · WebSocket/SSE。
