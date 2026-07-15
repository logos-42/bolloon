---
title: Judgeness · Id-Sorted Hearth
source: session
created: 2026-07-15
last_confirmed: 2026-07-15
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [judgeness, p2p, identity, privacy, manifest, hearth, persistence-war, dual-mode]
---

# Judgeness · Id-Sorted Hearth

> Bolloon never makes you decide the same thing twice.
> A P2P, ID-sorted, human-overridable judgment hearth for agents and humans.

## 1. Context

### 1.1 三 skill 的总体姿态

| Skill | 给出的判断 | 落到本 plan 的方式 |
|:------|:----------|:-----------------|
| **传播裂变** | 真老虎 = LLM 限流 + judgments API 暴露；R₀ ≤ 1 时不推传播 | 防御期不暴露 HTTP 写 API；先把 fallback 路径 + 内部 schema 做稳 |
| **乔布斯** | A 方向（判断力资产化）保留；marketplace / vertical SaaS / wiki-first 协议化砍掉 | judgeness 唯一焦点 = 判断力资产化；不做 marketplace、不进 vertical |
| **毛泽东** | 持久战三阶段（防御 6 月 → 相持 6-18 月 → 反攻 18+ 月）；先团结 JavaScript 开发者社区 | 实施严格按三阶段，本文档先把整体设计落定 |

### 1.2 用户的两个反转（决定设计形态）

| 反转点 | 通常做法（被纠正） | 本设计最终形态 |
|:------|:---------------|:--------------|
| 用户原话："用户的判断力、品味、创新力和想象力都在 judgeness 里面" | 给 `HumanJudgment` 加 5 个新字段 | **不改 schema**；建独立 `JudgenessDescription` 通过 `judgmentRef` 外键引用 `HumanJudgment.id`，零迁移 |
| 用户原话："未来注册的网站" | 把 bolloon 现有 54188 web 当成 judgeness 主站 | **独立 `judgeness.bolloon.com` 域名** + 反向代理 + Let's Encrypt；本地 54188 仅作回环冒烟 |

### 1.3 核心范式转换

Bolloon v0.3.x 的身份模型是 `device × role → ed25519 publicKey`，身份和设备/角色绑死。
judgeness 的第一步是**把"我"从设备上拆出来**——成为一张可分享、可隐藏、可授权的 JudgenessCard。卡片承载用户的判断力、品味、创新力和想象力（用户 8 需求第 1 条），通过三层 ID 可见性（`human-name` / `id-public` / `id-allowlist` / `id-private`）解决隐私（第 7 条）。

### 1.4 一句话价值（再确认一次）

> **Bolloon never makes you decide the same thing twice.**
>
> judgeness = 用户把判断力外化成资产，跨设备、跨 agent、跨人去复用；人类保留 override。

---

## 2. 核心概念（用户 8 需求 → 9 个工程概念）

| # | 用户原话 | 概念名 | 复用/新建 | 文件锚点 |
|:-:|:---------|:-------|:----------|:---------|
| 1 | 判断力+品味+创新+想象都在 judgeness | `JudgenessDescription` (5 facets + 3 basis) | **新建** `src/judgeness/types.ts` | D1 反转：不改 HumanJudgment |
| 2 | 去中心化交流过程 | `P2P Hearth` (4 新 kind) | **新建** `src/judgeness/protocol.ts` | 复用 `judgment-protocol.ts:174-194` listener 模式 |
| 3 | 网站找人排名 | `Hearth Index` + `/api/hearth/discover` | **新建** `src/web/routes-hearth.ts` + 排名算法 `src/judgeness/rank.ts` | O2 反攻期 |
| 4 | 人类看人 | `Human View` | **新建** `src/web/util/dual-mode.ts` | Accept 协商 |
| 5 | 网站适配 agent，合作构建 | `Dual-Mode API` + 4 类资源 HTTP 写 API | **新建** 全部 | 缺口已确认 |
| 6 | 按频道自动加 id | `Channel-based Auto-add` | **新建** `src/judgeness/auto-add.ts` | 反攻期 O3 |
| 7 | id 有隐私 | `Id Visibility Layer` (4 层) | **新建** `src/judgeness/visibility.ts` | 复用 `sanitizeChannelForPeer` 模式 |
| 8 | 人类权限更高 | `Human Override Layer` (状态机) | **新建** `src/judgeness/visibility.ts` | 闸 3 强制优先 |
| 9 | 网站本体 | `judgeness.bolloon.com` 独立部署 | **新建** `infra/judgeness-bolloon-com/` | O1 反攻期 |

### 2.1 三层架构骨架

1. **Storage 层** — `~/.bolloon/judgeness/` 落盘：`descriptions/`、`visibility.yaml`、`allowlist.yaml`、`hearth-cache/`。
2. **Protocol 层** — P2P 消息（4 新 kind）、channel topic、reflection（链 ↔ description 互转）。
3. **Discovery 层** — web Hearth Index、Dual-Mode API（`text/html` ↔ `application/ld+json`）。

### 2.2 三道授权闸（每条 P2P / HTTP 出站必经）

- **闸 1：id-visibility scrubber** — 出站前按 audience 类型剥字段（`public` / `allowlist` / `peers` / `private` 四级）。
- **闸 2：channel-allowlist gate** — `joinPeer` / `joinTopic` 之前必须过 `allowlist.yaml`；未登记 channel = 默认 allowlist 模式（fail-closed）。
- **闸 3：human-override handler** — 任何写入由人类 override 优先；`visibility.yaml.humanOverride=true` 强制覆盖 agent `openState=open`。

---

## 3. 架构

```
+----------------------------------------------------+
|          Discovery Layer (web)                     |
|   /api/hearth/discover      |   Dual-Mode (LD-J)  |
|   /api/hearth/cards/:id     |   (Accept 协商)     |
+----------------------------------------------------+
        ^                       ^
   (闸 1 scrubber)      (闸 2 allowlist gate)
        |                       |
+----------------------------------------------------+
|           Protocol Layer (P2P)                      |
|    4 new kinds:                                     |
|    hearth_description_publish | hearth_description_query |
|    hearth_autoadd_invite      | hearth_block               |
|    transport: iroh (复用 IrohTransport.sendMessage)   |
+----------------------------------------------------+
        |
   (闸 3 human-override handler)
        |
+----------------------------------------------------+
|           Storage Layer (~/.bolloon)                 |
|  ~/.bolloon/judgeness/                              |
|    descriptions/<jd-id>.md                         |
|    visibility.yaml                                  |
|    allowlist.yaml                                   |
|    hearth-cache/<remote-pk>/...                     |
|  ~/.bolloon/peers/<peerDirName>/                    |
|    groups / function / exportment / science/...    |
+----------------------------------------------------+
```

### 3.1 关键模块映射

| Bolloon v0.3.x 现有 | judgeness 怎么用 | 引用 |
|:--------------------|:-----------------|:-----|
| `HumanJudgment`     | **不扩展 schema**，judgeness = 独立 description 通过 `judgmentRef` 外键引用 | `src/pi-ecosystem-judgment/human-value-store.ts:28-90` |
| `judgment-protocol` 4 帧 | 新增 4 个 kind，复用 listener 安装模式 | `src/agents/judgment-protocol.ts:174-194` |
| `agent-manifest-protocol` v2 | Hearth Index 聚合时直接读 manifest 的 4 类资源 | `src/agents/agent-manifest-protocol.ts:65-76` |
| `sanitizeChannelForPeer` | scrubber 借用其白名单 + `shared_with_peers[]` 模式 | `src/web/server-v3-p2p.ts:54` |
| `p2p-direct.joinTopic` | Channel-based Auto-add 直接调 | `src/network/p2p-direct.ts` |
| `peer-fs.ts` 4 类资源落盘 | 不替代；judgeness 在 Hearth Index 聚合时**读** peer-fs 写的 manifest | `src/network/peer-fs.ts:36-40` |

### 3.2 数据流

**写一张 description 全程**：
1. 用户输入 → POST `/api/hearth/cards`
2. 闸 3 检查 `role`：agent 创建默认 `openState='locked'`；human 创建默认 `openState='open'`
3. schema 校验 + 落 `~/.bolloon/judgeness/descriptions/<jd-id>.md`
4. 缓存更新；可选 P2P 通知（仅 `openState='open'`）
5. 写入 audit log

**读一张 description 全程（含隐私）**：
1. 来源 = browser / agent / P2P
2. 闸 1 scrubber 按 audience 类型剥字段
3. 闸 2 allowlist gate 校验
4. Dual-Mode 渲染
5. 打 audit log

---

## 4. Schema（JudgenessDescription）

> **关键设计决策 (user rev)**: judgeness 不组块；不扩展 `HumanJudgment` 主表。下面是独立 description 表，外键引用。

```typescript
// src/judgeness/types.ts (已实现)
export interface JudgenessDescription {
  descriptionId: string;             // jd-<ts>-<rand6>
  judgmentRef: string;               // 外键 → HumanJudgment.id
  description_version: 1;

  facets: {
    judgment?: number;               // 0..1
    taste_aesthetic?: number;
    novelty_score?: number;
    imaginative_score?: number;
    curiosity_vector?: number;
  };
  basis: {
    taste_basis?: string;
    novelty_basis?: string;
    imagination_basis?: string;
  };
  scope: { domains?: string[]; topics?: string[] };

  visibility: 'public' | 'allowlist' | 'peers' | 'private';
  openState: 'open' | 'locked' | 'human-only';

  by: 'human' | 'agent';
  byAgentId?: string;

  createdAt: string;                 // ISO
  updatedAt: string;
  lastTransitionAt?: string;
}
```

### 4.1 schema 兼容矩阵

| 字段 | 老 HumanJudgment (v0) | v1 judgeness | 迁移策略 |
|:------|:---------------------|:-------------|:---------|
| `id`, `decision`, `reasons` | 必填 | 不变 | 不动 |
| `description_version` | 不存在 | 必填 = 1 | 新字段，缺省视为 v0 |
| `facets.*`, `basis.*`, `scope.*` | 不存在 | 可选 | 老数据 `null` |
| `visibility`, `openState`, `by` | 不存在 | 可选 | 老数据 `'private' / 'locked' / 'human'` |
| `judgmentRef` | 不存在 | 必填 | 新字段，老数据可空 |

**向后兼容断言**：description 表是独立文件；HumanJudgment 主表**零修改**，0 迁移成本。

---

## 5. 持久化布局

```
~/.bolloon/judgeness/
├── descriptions/
│   └── <jd-id>.md              # 单 description 可读版 (frontmatter v2 + body)
├── tags.yaml                   # 全局 tags 聚合
├── visibility.yaml             # 隐私策略 (per-channel × per-id)
├── allowlist.yaml              # 允许看我的 pubkey 列表
└── hearth-cache/
    └── <remote-publickey>/     # 远端 judgeness.bolloon.com 用户的缓存
        ├── manifest.json
        ├── descriptions/<jd-id>.md
        └── last-seen.txt
```

### 5.1 `descriptions/<jd-id>.md` 模板

```markdown
---
descriptionId: jd-1234567890-abcd12
judgmentRef: hv-abc-def
description_version: 1
facets: { judgment: 0.85, taste_aesthetic: 0.7, novelty_score: 0.6, imaginative_score: 0.8, curiosity_vector: 0.5 }
basis: { taste_basis: '冷调极简', novelty_basis: '跨域隐喻', imagination_basis: '高 variance 假设' }
scope: { domains: [architecture], topics: [architecture, type-system] }
visibility: allowlist
openState: locked
by: human
createdAt: '2026-07-15T00:00:00.000Z'
updatedAt: '2026-07-15T00:00:00.000Z'
schema_version: 2
audience: self
stage: current
status: current
entity_type: concept
tags: [judgeness, judgment-ref=hv-abc-def, visibility=allowlist, state=locked]
---

# Judgeness Description jd-1234567890-abcd12

## Judgment Reference
- judgmentRef: hv-abc-def

## Facets
- judgment: 0.85
- taste_aesthetic: 0.7 — 冷调极简
- novelty_score: 0.6 — 跨域隐喻
- imaginative_score: 0.8 — 高 variance 假设
- curiosity_vector: 0.5

## Scope
- domains: architecture
- topics: architecture, type-system

## Privacy
- visibility: allowlist
- openState: locked
- by: human
```

### 5.2 `visibility.yaml` 模板

```yaml
version: 1
defaults:
  visibility: private
  openState: locked

channels:
  - channelId: general
    visibility: allowlist
    openState: locked
    humanOverride: false
  - channelId: public-stage
    visibility: public
    openState: open
    humanOverride: false
  - channelId: private-hands
    visibility: private
    openState: human-only
    humanOverride: true

cards: []
```

### 5.3 `allowlist.yaml` 模板

```yaml
version: 1
peers:
  - pubkey: '64-hex-string-of-peer-A'
    alias: 'alice (self)'
    note: 'self device'
    addedAt: '2026-07-15T00:00:00.000Z'
  - pubkey: '64-hex-string-of-peer-B'
    alias: 'bob'
    note: 'added 2026-07-15 via hearth_invite'
    addedAt: '2026-07-15T00:00:00.000Z'
```

---

## 6. 路由清单（共 12 个 + 4 peer 写 API）

所有路径前缀 `/api/hearth`。

| # | 方法 + 路径 | 用途 | 权限 | 防御期状态 |
|:-:|:------------|:-----|:-----|:----------|
| 1 | `GET /api/hearth` | 健康 + 摘要 | self | **开** |
| 2 | `GET /api/hearth/discover` | 伙伴搜索 | self | **开**（无排名，仅 list） |
| 3 | `GET /api/hearth/cards/:id` | 单 description 读 | self / allowlist | **开** |
| 4 | `POST /api/hearth/cards` | 创建 description | human-only | 405 |
| 5 | `PATCH /api/hearth/cards/:id` | 修改 description | human-only | 405 |
| 6 | `GET /api/hearth/visibility` | 隐私策略 | self | **开** |
| 7 | `PUT /api/hearth/visibility` | 改隐私 | human-only | 405 |
| 8 | `GET /api/hearth/allowlist` | 白名单 | self | **开** |
| 9 | `POST /api/hearth/allowlist` | 加/减 | human-only | 405 |
| 10 | `GET /api/hearth/peers` | peer 节点列表 | self | **开** |
| 11 | `POST /api/hearth/channel-autoadd` | 频道触发 auto-add | self + 闸 2 | 405（进 audit log） |
| 12 | `GET /api/hearth/{dual-mode}` | Accept 协商 | self | **开** |
| P1-P4 | `POST /api/peer-resources/{groups,functions,exportments,sciences}` | 写 4 类资源 | human-only | 405（进 audit log） |

**所有 405 在防御期通过 `DEFENSE_MODE=true` 标志位返回，相持期改 false 即可打开**。

---

## 7. 前端（`src/web/client-hearth.ts`）

### 7.1 三段视图

| 视图 | URL | 主要功能 |
|:-----|:----|:---------|
| My Hearth | `#/hearth` | 看自己的 counts / 状态 |
| Discover | `#/hearth/discover` | 搜远端 peers |
| Visit | `#/hearth/visit/:pk` | 访客视角某个 peer |

### 7.2 Agent-friendly 默认

- 默认渲染 `application/ld+json`
- 人类显式 `?view=human` 才返回 HTML
- 这是 `Dual-Mode API` 在前端的体现

---

## 8. P2P 协议扩展（4 新 kind）

### 8.1 帧定义（`src/judgeness/protocol.ts`）

| kind | 用途 | 硬约束 |
|:-----|:-----|:-------|
| `hearth_description_publish` | A 告知 B "我公开了 jd <id>" | descriptionId + visibility 必填 |
| `hearth_description_query` | A 向 B 询问 jd <id> 正文 | descriptionId 必填 |
| `hearth_autoadd_invite` | A 邀请 B 加入 channel | channelTopic 非空；visibility ≠ private |
| `hearth_block` | A 屏蔽 B / channel | targetNodeId ≠ fromNodeId |

### 8.2 listener 安装模式

复用 `judgment-protocol.ts:174-194` 的 `ensureListeners(transport)`：

```typescript
function ensureHearthListeners(transport: IrohTransport): void {
  transport.onMessage('hearth_description_publish', async (msg) => { ... });
  transport.onMessage('hearth_description_query', async (msg) => { ... });
  transport.onMessage('hearth_autoadd_invite', async (msg) => { ... });
  transport.onMessage('hearth_block', async (msg) => { ... });
}
```

### 8.3 隐私约束（闸 1+2+3 全开）

- **所有 4 kind 入站**先进 `input-scanner`（P2P 默认 log；`BOLLOON_INPUT_SCAN=block` 才硬拦）
- **闸 1**：`hearth_description_publish` 出站前 scrub：若 description 的 `visibility='private'`，scrubber 把 descriptionId 替换为 `[redacted]`
- **闸 2**：`hearth_autoadd_invite` 入站后查 `allowlist.yaml`：若对方 pubkey 不在 allowlist 且 channel 是 `private`，自动回 `hearth_block`
- **闸 3**：`hearth_description_publish` 出站前检查 `openState`：若 `'locked'` 或 `'human-only'`，agent 自动 publish 一律拒（人类显式 unlock 后才放行）

---

## 9. 三阶段持久战（防御 / 相持 / 反攻）

> 来源：毛泽东 skill "持久战三阶段"。

### 9.1 战略防御期（现在 → 6 月）— **本设计第一阶段**

**目标**：基础设施打稳，不对外暴露。

| 顺序 | 模块 | 状态 |
|:-----|:-----|:-----|
| F-1 | LLM fallback（如未做完） | (前置, 非本计划) |
| F-2 | `src/judgeness/types.ts` schema | ✓ 完成 |
| F-3 | `src/judgeness/store.ts` 落盘 layout | ✓ 完成 |
| F-4 | `src/judgeness/visibility.ts` 三闸 | ✓ 完成 |
| F-5 | `src/judgeness/reflect.ts` description ↔ judgment | ✓ 完成 |
| F-6 | `src/judgeness/protocol.ts` 4 新 kind（仅 enum） | ✓ 完成 |
| F-7 | `GET /api/hearth` 健康端点 | ✓ 完成（DEFENSE_MODE=true） |
| F-8 | 单测 `src/test/judgeness/*.test.ts` | ✓ 完成（9 个文件） |
| F-9 | `src/judgeness/rank.ts` 排名算法 stub | ✓ 完成（不上线路由） |
| F-10 | `src/judgeness/auto-add.ts` stub | ✓ 完成（仅 audit log） |

**防御期明确不做**：
- HTTP 写 API（POST/PATCH/PUT/PATCH `/api/hearth/*` 全部 405）
- 真实 `judgeness.bolloon.com` DNS / HTTPS（部署骨架已写，未真实部署）
- 4 新 P2P kind 发帧（仅 enum 占位）
- Channel-based Auto-add 全自动 joinTopic

### 9.2 战略相持期（6 → 18 月）

| 顺序 | 模块 |
|:-----|:-----|
| C-1 | 12 路由全部打开（DEFENSE_MODE=false） |
| C-2 | 前端 My Hearth / Discover / Visit 段 |
| C-3 | Peer 4 类资源 HTTP 写 API 打通到 `peer-fs.ts` 的 addLocalGroup/Function/... |
| C-4 | 4 P2P kind 真正发帧 + listener 接 store |
| C-5 | Champion 5-10 个试用 |

### 9.3 战略反攻期（18+ 月）

| 顺序 | 模块 |
|:-----|:-----|
| O-1 | `judgeness.bolloon.com` 真实 DNS + Caddy + Let's Encrypt 上线 |
| O-2 | Discover 排名算法上线 + UI 显示 why |
| O-3 | Channel-based Auto-add 全自动 + 频次限制 |
| O-4 | 多语言（先 en/zh） |

**反攻期明确不做**：marketplace / vertical SaaS / 黑盒排名 / 强制人类 onboarding。

---

## 10. Critical files（新建 / 修改）

### 10.1 新建（已全部完成）

| 文件 | 行数 | 用途 |
|:-----|:-----|:-----|
| `docs/judgeness-id-sorted-hearth.md` | (本文) | 设计文档 |
| `src/judgeness/types.ts` | ~150 | JudgenessDescription schema |
| `src/judgeness/store.ts` | ~340 | cards / visibility / allowlist 落盘 |
| `src/judgeness/visibility.ts` | ~180 | scrubber + allowlist gate + human override |
| `src/judgeness/reflect.ts` | ~100 | description ↔ judgment 互转 |
| `src/judgeness/protocol.ts` | ~280 | 4 新 P2P kind + listener |
| `src/judgeness/rank.ts` | ~110 | Discover 排名算法 (反攻期) |
| `src/judgeness/auto-add.ts` | ~150 | Channel-based Auto-add (反攻期) |
| `src/web/util/dual-mode.ts` | ~130 | Accept 协商 + JSON-LD |
| `src/web/routes-hearth.ts` | ~280 | 12 路由 + 4 peer 写 API |
| `src/web/client-hearth.ts` | ~80 | 前端模块 stub |
| `infra/judgeness-bolloon-com/Caddyfile` | ~70 | 反向代理配置 |
| `infra/judgeness-bolloon-com/Dockerfile` | ~40 | 容器镜像 |
| `infra/judgeness-bolloon-com/systemd/bolloon-hearth.service` | ~30 | systemd unit |
| `infra/judgeness-bolloon-com/scripts/health-check.sh` | ~25 | 活体检 |
| `infra/judgeness-bolloon-com/scripts/RUNBOOK.md` | ~100 | 部署 runbook |
| `infra/judgeness-bolloon-com/scripts/DISCOVER-RANKING.md` | ~50 | 排名算法说明 |
| `src/test/judgeness/{types,store,visibility,rank,auto-add,protocol,reflect,dual-mode,routes-hearth}.test.ts` | ~300 each | 单测 |

### 10.2 修改（防御期未做；标 "推荐路径"）

| 文件 | 改什么 | 触发条件 |
|:-----|:-------|:---------|
| `src/index.ts` | 主入口加 `registerHearthRoutes(app)` | 相持期打开 DEFENSE_MODE=false 时 |
| `src/web/server.ts` | `createWebServer` 闭包内注册 | 同上 |
| `src/web/client.ts` | 在启动时调 `registerHearthRoutes(router, getRoot)` | 同上 |
| `src/agents/judgment-protocol.ts` | `Kind` 枚举追加 4 新 Hearth kinds | 反攻期 O3 上线时 |

### 10.3 参考模块（必须复用）

1. `src/pi-ecosystem-judgment/human-value-store.ts:28-90` — `HumanJudgment` schema
2. `src/agents/judgment-protocol.ts:174-194` — listener 安装模式
3. `src/agents/agent-manifest-protocol.ts:65-76` — v2 manifest
4. `src/web/server-v3-p2p.ts:54` — `sanitizeChannelForPeer`
5. `src/network/p2p-direct.ts` `joinTopic` — Channel-based Auto-add
6. `src/web/util/safe-name.ts` — UI 兜底防 undefined/null/NaN

---

## 11. Verification

### 11.1 单元

```bash
npx vitest run src/test/judgeness/
npx vitest run src/pi-ecosystem-judgment/    # 老 schema 不挂
npx tsx src/test/protocol-kind-extension.test.ts
```

### 11.2 文档 lint

```bash
python3 scripts/wiki_lint.py --strict=v2 docs/judgeness-id-sorted-hearth.md
```

### 11.3 端到端（相持期）

```bash
npx tsx scripts/ablation/run.ts
```

用例（参考 plan §V1.2，已落单测 stub）：
1. A 创建 `JudgenessDescription` → GET `/api/hearth/cards/:id` 通过
2. B 改 allowlist 把 A 移出 → scrubber 拒绝
3. A 触发 `hearth_autoadd_invite` → 闸 2 校验 → 自动 `hearth_block` 回发
4. A 设 `openState='locked'` → agent 自动 publish 被闸 3 拒绝
5. Channel-based Auto-add 第 6 次请求返回 `frequencyLimited=true`
6. Fuzz scrubber 1 万次无字段泄漏

### 11.4 回归

```bash
npx tsc --noEmit
npm run build:web
```

---

## 12. 不做清单（持久战原则）

### 12.1 绝对不做（乔布斯 skill 砍掉的 B/C/D/E）

- **Marketplace** — Hearth Index 不做商品交易 / 付费排名 / 不抽佣
- **Vertical SaaS** — 不做 "for 律师 / 医生 / 教师" 的包装
- **Wiki-first 协议化** — 不把 wiki 当主 UI 入口
- **Agent 黑盒排名** — Discover 排名算法可解释
- **强制人类授权才用** — 默认闸 3 override；不强制 onboarding

### 12.2 阶段锁（毛泽东 skill 时序）

- **防御期不做对外 HTTP 写 API** — `POST/PATCH/PUT/DELETE /api/hearth/*` 在防御期 405
- **防御期不发 4 P2P kind** — 4 kind 仅 enum 占位
- **相持期不做 Discover 公开排名** — 排名是反攻期
- **反攻期不做 vertical SaaS**

### 12.3 工程约束

- **不破坏 HumanJudgment 向后兼容** — description 是独立表
- **不假设 LLM 已稳** — fallback 路径必须保留
- **不做中心化 id 注册** — id 仍然是 per-role ed25519 publicKey
- **不默认 visibility=public** — 默认 `visibility=private, openState=locked`
- **不做 silent auto-add** — 必须进 `counterfactual-audit.jsonl`

### 12.4 优先级（如冲突）

1. 乔布斯 skill（A 方向判断力资产化）> 其他
2. 毛泽东 skill（持久战时序）> 加速
3. 传播裂变 skill（先修主要矛盾）> 推传播

---

## 13. 附录 A：与 Bolloon v0.3.x 现状的对照表

| Bolloon v0.3.x | judgeness 接进来 | 缺口 |
|:---------------|:-----------------|:-----|
| 身份 = per-role ed25519 publicKey | id 来源仍然是它；judgeness 不另起 id | ✓ 无缺口 |
| `HumanJudgment` (v0.x) | judgeness = 独立 description 外键引用 | ✓ 0 迁移 |
| `judgment-protocol` 4 帧 | judgeness 加 4 新 kind | ✓ 复用 listener |
| `agent-manifest-protocol` v2 | Hearth Index 聚合读 | ✗ 无 HTTP 写 API（P1-P4 部分补） |
| `sanitizeChannelForPeer` | scrubber 复用其模式 | ✓ |
| `p2p-direct.joinTopic` | auto-add 直接调 | ✓ |
| `peer-fs.ts` 落盘 `~/.bolloon/peers/` | judgeness 不替代；仅读 | 部分补 |
| `input-scanner` (PII) | 4 新 kind 入站先过 | ✓ |
| web `/api/judgments` 18 路由 | hearth 12 路由独立前缀 | ✓ |

---

## 14. 附录 B：与三 skill 的引用关系

| Skill | 在本文中体现 |
|:------|:-----------|
| 传播裂变 | R₀ ≤ 1 不推；阶段锁；优先提升 visibility |
| 乔布斯 | 一句话价值；砍 marketplace/vertical/wiki-first |
| 毛泽东 | 持久战三阶段；统一战线（allowlist） |

---

## 15. 参考（Explore 已确认）

1. `src/pi-ecosystem-judgment/human-value-store.ts:28-90` — HumanJudgment 接口
2. `src/agents/judgment-protocol.ts:174-194` — listener 安装模式
3. `src/agents/judgment-protocol.ts:463-537` — reflect 闭环
4. `src/agents/agent-manifest-protocol.ts:65-76` — v2 manifest
5. `src/network/peer-fs.ts:36-40` — `peerDirName` 命名
6. `src/web/server-v3-p2p.ts:54` — `sanitizeChannelForPeer`
7. `src/web/server.ts:3668-3688` — `GET /api/p2p-publickey` 身份端点
8. `src/index.ts:2142` / `src/electron/config.ts:6-19` / `src/cli-entry.ts:73` — 端口契约 54188
9. `src/web/routes-judgments.ts:794` — 18 个 judgment 路由注册风格
10. `scripts/wiki_lint.py --strict=v2` — frontmatter v2 校验
11. `scripts/ablation/run.ts` — 端到端 ablation

---

**End of plan.** 设计落定：reverse 决策（不组块 + 独立域名）已在文档里固定，三阶段（防御 / 相持 / 反攻）按持久战原则严格落地，防御期实际产出代码 + 单测 + 部署骨架，反攻期只留 stub。
