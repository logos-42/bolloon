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
  "totals": { "nodes": 0, "agents": 0, "active_agents": 0, "seen_last_24h": 0 },
  "capabilities": [ { "key": "research", "count": 3 } ],
  "recent_activity": [ { "kind": "node_joined", "at": 0, "text": { "zh": "有新节点加入网络", "en": "A node joined the network" } } ],
  "notes": [ "单节点观察: 这是本节点能看到的部分网络, 不是全网精确总量" ] }
```

硬规则(全部有断言):

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
- 双节点集成 `scripts/verify-network-pulse.ts` → **49 passed / 0 failed / EXIT=0**:
  ① A 发布 manifest → B 缓存 → 观察层看到 2 节点 2 Agent · 原始 DID 与原始能力名**都没落盘**;
  ② 小网络类别全进 `other`; 达阈值后 `research` 计数 = 4 个不同 Agent, 重复声明不虚增;
  ③ 缓存命中 / `stale` / `unavailable` 三态;
  ④ 坏数据不崩;
  ⑤ 真 HTTP: 无凭据 200 · Cache-Control · ETag · **304** · 响应无私有字段 · 本地接口仍在;
  ⑥ 前端消费契约(字段齐全 · 双语 scope_label · 无任务正文字段);
  ⑦ `confirmed_activity` 冻结形状: 无索引 → 空数组 + `none` · **真索引 30 条夹具 → 25 行且最新在前、逐字冻结、门槛复算、零 `0x` 长 hex** · 索引坏 → 降级 `pulse-events` 且不冒充链上。
- 真快照 (`scripts/export-network-pulse.ts` 真跑, 本机索引 chainId 31337 / head 676 / 328 条事件):
  `status=live scope=verified nodes=2 agents=3 ... confirmed_activity=25(chain-index) signed=true`; 快照里 25 行, 前两行 = block 676 `task_created/active/confirmed` 与 block 675 `trade_settled/expired/confirmed`;
  已独立核验: 25 行的 `task`/`tx` 摘要、块号、确认数与 `index.json` 的 `released/created` 事件**逐行一致**(用同一 sha256 公式复算), 且全文无 taskKey/txHash 原文、无任何 `0x` 长 hex。

## 5. 前端 (bolloon-UI 网关页)

网关页新增「全球网络脉冲 / Network pulse」区: 三到四个大数值 · capability 分布 · 匿名活动流 · 快照时间 ·
`live/stale/unavailable` 标签 · `Observed` / `Verified snapshot` 范围说明 · notes 里那句"不是全网精确总量"可见。

取数策略(诚实优先, **绝不编造数字**): ① `?pulse=<url>` 显式指定节点 → ② 同源 `network-pulse.json` 静态签名快照(过期就显示 `stale`)→ ③ 都拿不到 → `unavailable` + 说明如何用 `?pulse=` 指向本机节点。

**活动行数据契约(2026-09-22)**: 快照里的 `confirmed_activity` + `confirmed_activity_source` 是页面列
「任务 / 状态 / 区块 / 确认数」的唯一数据源 —— 字段名与取值域冻结, 前端**不要**自己推 state/finality,
按行渲染即可; `source=pulse-events` 或 `finality=observed` 的行必须显示成"未确认/非链上", 不得显示成已结算。

前端行为: 首屏 loading · 成功 live · 快照过期 stale · 失败 unavailable · 30s 轮询 · 请求超时(AbortController)·
失败指数退避 · **任何失败不得影响页面其它区域** · 活动文本只用 `textContent`(禁 innerHTML) · 双语走 `data-zh/data-en` ·
相对时间只改文字节点 · 尊重 `prefers-reduced-motion` · `aria-live="polite"` · 移动端纵向堆叠。

## 6. 本批未做 (如实)

- 真正的**全球**公共观察入口(需要长期在线的观察者节点/Explorer); v1 只做"节点本地观察 + 可指定端点 + 静态签名快照"。
- 链上强绑定 · 世界地图 · Agent 头像/主页 · 公开 DID 列表 · 任务内容流 · WebSocket/SSE。
