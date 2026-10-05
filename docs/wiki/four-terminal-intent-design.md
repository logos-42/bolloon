---
title: 四端 Agent 分发网络 —— bolloon 逻辑设计 (v0.1)
source: session (leo 2026-10-05: 「把上面的逻辑落实一下, 从 web pc 端, cli 端, 到手机端, 眼镜端的逻辑设计一下, 按照这个设计原则完成」)
created: 2026-10-05
last_confirmed: 2026-10-05
schema_version: 2
audience: self
stage: draft
status: draft
tags: [intent-network, four-terminal, pc, cli, mobile, glass, design, world, intent-console, opportunity, action, memory]
---

# 四端 Agent 分发网络 —— bolloon 逻辑设计

> 状态: **v0.1 设计** (2026-10-05)
> 上游: intent-network-vision.md (定位) + three-terminal-product-vision.md (产品形态)。
> 本文 = **分端逻辑设计 + 数据流 + 落地顺序**。设计原则三句: **PC creates. Mobile discovers. Glass acts.** CLI 是 PC 的延伸 (深度工作的最强形态)。

---

## 0. 全局: 一个本体, 四种接口

```text
                     ┌─────────────────────────────┐
                     │         WORLD 本体            │
                     │  Intent → Opportunity → Action│
                     │  → Memory → (回环)           │
                     └─────────────┬───────────────┘
          ┌──────────────┬──────────┴───────┬───────────────┐
          ▼              ▼                  ▼               ▼
   [PC] 工作台      [CLI] 操作台       [Mobile] 发现场     [Glass] 现实层
   创造/管理         脚本/管道            碎片探索          瞬时介入
   Create           Automate            Discover         Assist
```

数据流 (单一真相):
```text
用户意图 ──► Intent Store ──► 匹配引擎 ──► Opportunity 候选
                                        │
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
              [PC] 工作台确认     [CLI] 命令执行      [Mobile] 卡片滑过
                                                        │
              ──► Action 执行 ──► 结果写回 ──► Memory 累积
              ──► 下一轮 Intent 更聪明
```

**关键原则**: 四端共享同一份 Intent/Opportunity/Action/Memory 数据。端只是渲染和输入的不同形态, **不复制逻辑**。

---

## 1. [PC] Web 工作台 —— Create

**形态**: Agent Operating Environment (浏览器, 三栏布局)。

**职责** (按优先级):
1. **Intent Console**: 声明「我现在正在做 X」→ 持久化到 Intent Store → 触发匹配
2. **Opportunity 面板**: 匹配结果卡片流 (可确认/忽略/深挖)
3. **World 管理**: 我的 Agent / 我的 Network / 我的 Memoory / 交易历史
4. **Agent 协作视图**: 任务进行中的实时状态

**数据流**:
```text
[Intent 表单] → POST /api/intents → Intent Store
                 ↓ (匹配引擎, 带变更通知)
[Opportunity 面板] ← GET /api/opportunities?intent=xxx
```

**与代码的映射**:
- Intent Store = `~/.bolloon/intents.json` (新增)
- 匹配引擎 = `src/agents/opportunity-match.ts` (新增, 先用关键词/标签匹配, 不假装 ML)
- Opportunity 源 = `task-board.ts` (board 公告) + 群公告 (announce) + x402 商品
- Web 面板 = 新页面挂在现有 web server (routes 加 `/api/intents` `/api/opportunities`)
- Auth = 复用现有 setup 门禁 (allow.agent)

---

## 2. [CLI] 操作台 —— Automate

**形态**: 现有 `bolloon` CLI, 新增三个命令族:

```text
bolloon intent set "建立聚变公司" --priority 5 --budget 100k --deadline 90d
       # 声明意图 → Intent Store (这是 Intent Console 的 CLI 形态)
bolloon intent list                    # 看当前意图 (含匹配数)
bolloon intent rm <id>
bolloon opportunity scan               # 手工触发匹配 → 打印卡片列表
bolloon opportunity list [--intent x]  # 看现有候选
bolloon opportunity accept <id>        # 确认 → 变成 Action (任务)
bolloon opportunity ignore <id>        # 忽略 → 进 Memory (不匹配回调)
```

**CLI 的独特价值**: 可脚本化/管道化/进 cron —— 这是「Agent 主动为你找机会」最便宜的落地 (定时 `bolloon opportunity scan` → 通知)。

**数据流**:
```text
bolloon intent set "..."  →  Intent Store (JSON, 0600)
bolloon opportunity scan  →  读 Intent Store + 匹配引擎 + 写 Opportunity Store
bolloon opportunity list  →  打印卡片 (纯文本/JSON)
bolloon opportunity accept →  转成 task publish/claim → Action
```

**文件**:
- `src/cli/intent-command.ts` (新)
- `src/cli/opportunity-command.ts` (新)
- `src/agents/intent-store.ts` (新)
- `src/agents/opportunity-match.ts` (新)

---

## 3. [Mobile] 发现场 —— Discover

**形态**: Opportunity Card 滑动流 (不是 Feed 复制 PC)。

**逻辑**:
- 首页 = World (3 things changed)
- 卡片 = 一次匹配 (来源: Opportunity Store 的增量)
- 动作只有 3 个: **[Explore] / [Ignore] / [Ask Agent]**
- 免费用户看到的是「世界在给我送东西」—— 不是「使用 AI」

**数据流**:
```text
App 启动 → GET /api/opportunities/new?since=xxx (增量)
滑卡片 → [Explore] 打开详情 / [Ignore] POST /api/opportunities/:id/ignore
        (ignore 写回 Memory, 下次匹配降权)
→ 消费后的意图由 Agent 持续执行 (后台)
```

**现状差距**: 手机壳资源逐字节复用 PC web (mobile-parity 门) —— 这恰恰是愿景要否定的「三个 UI 拷贝」。Mobile 独立卡片流 = 后续阶段 (先做 CLI, 逻辑在 Opportunity Store 层, 手机只是另一渲染面)。

---

## 4. [Glass] 现实层 —— Assist

**形态**: 瞬时信息 (1 秒理解), 不是 Feed。

**逻辑**:
- 触发 = World Context × User Intent (你在展会 → 你的 Intent 是找 GPU 合作 → 相关度 81%)
- 输出 = 一行耳语 + 最多一个动作 (Find/Ask/Later)
- 用完即消失, 永不常驻

**数据流**:
```text
Glass 感知 (位置/视觉/对话) → Context 层 → 匹配引擎 (复用)
  → 相关度 > 阈值 → 瞬时提示 → 用户 1 词决策 → Action
```

**现状差距**: rokid/ 只有通信桥, 无视觉/语音/Context。Glass 是**最远地平线**, 只做设计原则, 不进近期排期 (见 three-terminal-product-vision.md §10)。

---

## 5. 数据层设计 (四端共享)

### 5.1 Intent Store (`~/.bolloon/intents.json`)
```json
{
  "version": 1,
  "intents": [
    {
      "id": "int_9f2a...",
      "text": "建立聚变创业公司",
      "tags": ["fusion", "plasma", "startup"],
      "priority": 5,
      "budget": "100000",
      "deadline": 7776000000,
      "status": "active",          // active | paused | done
      "createdAt": 1730000000000,
      "matchedCount": 3
    }
  ]
}
```

### 5.2 Opportunity Store (`~/.bolloon/opportunities/`)
```json
{
  "id": "opp_8b1c...",
  "intentId": "int_9f2a...",
  "source": "board",               // board | group | x402
  "sourceId": "ann_d41d...",
  "score": 0.94,                   // 0-1 匹配度 (透明打分, 见 §5.4)
  "title": "寻找磁约束控制合作伙伴",
  "summary": "某实验室正在寻找 AI magnetic control 合作者",
  "budget": "50000",
  "status": "new",                // new | explored | accepted | ignored | expired
  "seenAt": null,
  "createdAt": 1730000000000
}
```

### 5.3 匹配引擎 (透明, 不假装 ML)
```text
score = 0.5 × tagOverlap(intent.tags, opp.tags)
      + 0.3 × keywordHit(text)      // 意图正文关键词命中机会标题/描述
      + 0.2 × budgetFit(intent.budget, opp.budget)  // 预算匹配 (缺失=0.5 中性)
```
- 阈值: score ≥ 0.4 才进候选 (可配 `--min-score`)
- **每个 score 都输出构成**, 不许只给一个黑盒数字 (诚实原则)

### 5.4 Memory 回写
- accept → 进入 Action (task) → 完成 → 结果写 Memory
- ignore → 记 NegativeEvidence → 下次同源降权 0.1
- 意图完成 → 意图归档 → 相关 Memory 成为新意图的种子 (回环)

---

## 6. 落地顺序 (P0 → P3, 每阶段可独立验证)

| 阶段 | 范围 | 判据 |
| --- | --- | --- |
| **P0 (本轮)** | CLI: `intent set/list/rm` + `opportunity scan/list/accept/ignore` | 单测 + 真跑: 声明意图 → scan 出机会卡片 → accept 转任务 |
| **P1** | Web 工作台: Intent Console 表单 + Opportunity 面板 (读同一 Store) | 浏览器真跑: 声明意图 → 面板出卡片 |
| **P2** | Mobile: Opportunity Card 流 (独立于 PC web 的第二渲染面) | 手机壳真跑: 卡片滑过 + Explore/Ignore |
| **P3** | Memory 回写闭环 + 定时 scan (cron) + 相关度进 Intent Console | 意图接受一次机会 → 结果回写 → 下次匹配更准 |

> **P0 遵循「先让轻版跑通」**: CLI 是四端里最便宜、最可脚本化的, 先把 Intent→Opportunity 闭环逻辑做对, Web/手机/眼镜只是同一数据层的不同渲染面。

---

## 7. 现状 ↔ 设计差距表 (诚实)

| 设计所需 | 现状 (2026-10-05) | 差距 |
| --- | --- | --- |
| Intent Store | goal-flywheel 有 Goal (意图可执行投影) 但无轻量 Intent 声明 | 新增轻量 Intent Store (不与 Goal 冲突, 是它的前身) |
| Opportunity Store | task board 有公告 (机会原料) 但无「匹配候选」层 | 新增 |
| 匹配引擎 | 无 | 新增 (透明打分) |
| CLI 命令族 | 无 intent/opportunity | P0 新增 |
| Web 面板 | 有 web server + 路由基建 | P1 |
| Mobile 卡片流 | 手机壳=PC web 拷贝 | P2 |
| Glass | rokid/ 通信桥 | 设计原则先行, 实现最远 |

⚠️ 设计约束: Goal 是「意图的可执行投影」(已冻结, goal-flywheel)。Intent 是 Goal 的**前身** (轻量声明, 未到可执行程度)。两者不冲突: intent 升级成可执行时 → 转 Goal。接口层不重叠。