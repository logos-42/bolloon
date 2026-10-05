---
title: Intent Network 愿景 — bolloon 的第四代定位 (草案 v0.1)
source: session (leo 2026-10-05 战略输入「AI 时代缺的是智能如何主动寻找/筛选/组合/交换/行动」)
created: 2026-10-05
last_confirmed: 2026-10-05
schema_version: 2
audience: self
stage: draft
status: draft
tags: [intent-network, agent-distribution, vision, direction, bolloon, strategy, match, trust, reputation, ephemeral-group]
---

# Intent Network 愿景 —— bolloon 的第四代定位

> 状态: **草案 v0.1** (2026-10-05)
> 来源: leo 的战略输入 (原文见 session)。本文是**消化版 + bolloon 映射 + 存疑点**。
> 结论先行: **bolloon 不定义成「Agent 社交网络/AI Twitter」, 而是 Intent Network (意图分发网络)** ——
> 解决的不是「Agent 怎么聊天」, 而是「世界上的智能和机会, 如何找到最应该接收它的 Agent」。

---

## 1. 核心论点 (leo 原文压缩)

互联网三个时代的分发对象迁移:

| 时代 | 核心对象 | 分发方式 | 核心稀缺资源 |
| --- | --- | --- | --- |
| Web | 网页/信息 | 搜索、链接、门户 | **人的主动搜索** |
| 移动互联网 | 内容/视频 | 推荐算法、Feed | **人的注意力** |
| AI | 智能/能力/意图 | Agent → Agent | **人的意图 + Agent 的决策权** |

- Google 分发「这个网页可能与你的问题有关」
- 抖音分发「这个视频可能让你继续看下去」
- 未来 Agent 分发「**这个东西现在应该进入你的现实世界**」

**分发单位迁移**: Page → Content → Attention → **Intent → Intelligence → Action**。

**关键论断**:
- Feed 的隐含前提是「人必须打开容器消费内容」; Agent 时代**世界主动向 Agent 流入**, 甚至可能没有界面。
- 未来最大的流量入口 = **谁控制用户的 Agent, 谁就控制意图流**。
- 推荐算法从 Attention Recommendation (你可能想看什么) → Action Recommendation (什么事值得你现在做/买/卖/参与) → Action Execution。
- 自媒体变异成 **Agent Media Creator** (24/7 对外行动的智能体 = 数字经济分身, 有知识/能力/声誉/交易历史/钱包/身份)。
- 「粉丝」变掉: 1000 个 Agent 知道你是某个节点, 比 100 万播放更有价值 (决策候选集合)。
- 新流量单位 **Agent View** (一个 Agent 看到另一个 Agent: 能力/信誉/价格/历史 → 判断匹配 → 调用)。
- 广告终点: 从「看看我的产品」→「**当某个 Agent 的需求满足 X 条件时, 把我纳入候选集合**」= Intent → Match → Transaction, 无广告/无 Banner/无点击。
- 群变掉: 不是固定社交结构, 而是**由任务产生、用完即散的临时 Agent Cluster** (Computational Social Network)。
- 未来首页 = **My World**: 打开不是信息流, 而是「WORLD CHANGED — 3 things happened that matter to you (Match: 93% / relevance 87% / expected value ¥80k)」。
- 互联网基本单位演进: URL → Content → Account → **Agent → Intent**。
- 最简洁的公式: Google=分发信息 · TikTok=分发注意力 · LLM=生成智能 · **Agent Network=分发意图、机会与行动**。
- 最终: **Internet stops being a place you visit. It becomes a system that continuously acts around your intent.**

外部佐证 (leo 提供): Google Search I/O 2026 往信息 Agent 推进 · arXiv 2507.21206 Agentic Web · arXiv 2606.19116 Agent-first Web。

---

## 2. bolloon 映射 —— 已有地基 (按愿景回看)

bolloon 已有的东西, 恰好是 Intent Network 的地基层, 不是「社交网络」:

| 愿景所需层 | bolloon 已有 | 说明 |
| --- | --- | --- |
| **可信身份层** | DID 身份 + 双侧签名成员事件 (gateway-group) | 成员变更可验签, 白名单可派生 |
| **通信层** | gateway 网络 + 群聊 (OrbitDB 复制) | 跨进程/跨机复制已通 |
| **意图表达雏形** | `task publish/board/claim` (capability 公告板) | **最早的 Intent→Match 雏形**: 发布能力+需求 → 认领 → 交易。但目前是**人手工发布+人工浏览**, 没有自动匹配 |
| **交易层** | x402 付费信息 + 链上结算 (escrow/release) | 意图落地为行动后有可核验的价值闭环 |
| **群层** | OrbitDB events store 群 | 技术上可做到**临时群/任务群**(建了用完删) |

## 3. bolloon 缺口 (从「社交网络」到「意图网络」还差什么)

1. **匹配层缺失** (最核心): 现在的 board 是「人看列表 → 人认领」, 不是「Agent 持续观察世界 → 发现变化 → 判断相关性 → 主动介入」。需要**自动发现+相关性打分**。
2. **意图的结构化表达**: capability 现在的描述是自由文本; 要机器可匹配需要 schema 化 (能力/约束/预算/时间窗/可靠性要求/交付条件)。
3. **信誉层缺失**: 谁的历史成交可信? 现在只有链上结算记录, 没有把「成交记录 → 信誉分数」的机制。
4. **临时群未做**: 现在的群是持久社交结构; 任务驱动建群 → 完成解散 (ephemeral cluster) 未实现。
5. **Agent View 的读取面**: 一个 Agent 要读另一个 Agent 的「能力/信誉/价格/历史」, 现在没有标准化的 agent profile 读取协议 (DID 目录是索引, 但没有能力/信誉维度)。

## 4. 存疑点 (我的保留意见, 标注分歧)

> wiki 共识文档要求分歧显式标记。以下是我对原文不完全同意的三处:

1. **「Feed 可能没有界面」—— 不同意**。人会要审批权。Agent 全权代理只适用于**低风险低价值**意图; 高价值意图 (花钱/签约/合作) 永远需要人确认。未来不是无界面, 是界面性质从**消费**变成**审批+决策** (leo 自己的 My World 就是界面)。真正形态 = Intent Dashboard + 代理层, 不是无界面。
2. **「Agent View 作为流量单位」—— 概念有力但商业机制未定义**。眼球经济死了不等于 Attention 死了: Agent 的注意力 (谁被纳入候选集合) 会成为新稀缺品, 但**计价/产权/防刷**没有先例。最大未解问题不是「会有」, 而是「怎么做到可信」。
3. **冷启动** (原文没提): Intent Network 需要供需双方都在场。bolloon 单节点阶段无法验证匹配层。落地顺序 = 先把现存 board 升级成「结构化意图表达 + 自动匹配」, 在两个真实节点跑通, 再谈大规模。

## 5. 落地顺序建议 (草案, 不下结论)

```text
阶段 0 (现状): 人发布 capability 公告 → 人浏览 → 人认领        [已有]
阶段 1:       capability 描述 schema 化 (可机器匹配) + 匹配打分   [缺口①+②]
阶段 2:       agent profile 读取协议 (能力/信誉/价格/历史)        [缺口⑤]
阶段 3:       临时任务群 (任务驱动建群 → 完成解散)                [缺口④]
阶段 4:       成交记录 → 信誉分数 → 纳入匹配打分                  [缺口③]
```

> ⚠️ 本草案只做方向锚定, **不构成当前开发任务**。任何阶段开工前由 leo 拍板, 并遵守「先让宏内核稳定运行, 再最小验证」原则。