---
title: 多终端 Agent 分发网络 —— bolloon 产品形态 (草案 v0.1)
source: session (leo 2026-10-05 战略输入「不要把 bolloon 定义成 Agent 社交产品, 而是多终端 Agent 分发网络」)
created: 2026-10-05
last_confirmed: 2026-10-05
schema_version: 2
audience: self
stage: draft
status: draft
tags: [intent-network, product-vision, three-terminal, pc, mobile, glass, world, opportunity-card, intent-console, business-model, distribution]
---

# 多终端 Agent 分发网络 —— bolloon 产品形态

> 状态: **草案 v0.1** (2026-10-05)
> 来源: leo 战略输入 (承接 intent-network-vision.md)。本文聚焦**产品形态层** (本体结构/三终端/商业模式)。
> 一句话: **同一个 Agent 世界, 在不同终端上呈现三种完全不同的分发机制 —— PC 造世界 · 手机逛世界 · 眼镜活在世界里。**

---

## 1. 本体: 六个核心对象 (替代「聊天」)

| 对象 | 含义 |
| --- | --- |
| **World** | Agent 所观察的世界 |
| **Intent** | 用户/Agent 当前想解决什么 |
| **Agent** | 能力、身份、记忆、信誉的载体 |
| **Opportunity** | 世界中与 Intent 匹配的机会 |
| **Action** | Agent 能替你执行的事情 |
| **Memory** | 长期形成的上下文、关系、历史 |

```text
WORLD → 发现变化 → INTENT → 匹配网络 → AGENTS (人才/服务/信息) → OPPORTUNITY → ACTION → MEMORY → 下一轮 Intent
```

**关键论断**: Post 只是 Opportunity 的一种表现形式。bolloon 不做 Agent→Post→Like→Comment 的社交结构, 而是 Intent→Match→Action。

## 2. 终端 = 感知器官, 不是三个 UI

不要按 PC/Mobile/Glass 设计, 按**人类状态**设计:

| 终端 | 用户状态 | 核心行为 | 产品哲学 |
| --- | --- | --- | --- |
| PC | 深度工作 | **Create** | PC creates |
| Mobile | 碎片时间 | **Discover** | Mobile discovers |
| Glass | 身处现实 | **Assist** | Glass acts |

## 3. PC = Agent Operating Environment (World Builder)

不是信息流, 是**Agent 工作台**: 创建 Agent / 安装 Skill / 设置 Intent / 加入 Network / 创建任务 / 查看协作/交易/长期记忆 / 审核行为 / 调权限 / 建 Agent Team。三栏布局 = 左栏 (WORLD: My World/Intents/Agents/Network/Projects) + 中栏 (CANVAS: conversation/graph/task/research/simulation) + 右栏 (AGENT: Identity/Skills/Memory/Reputation/Wallet)。

**★ Intent Console (最差异化)**: 用户不是不断问「ChatGPT 帮我…」, 而是直接声明「这是我现在正在做的事情」(Priority/Current needs/Budget/Deadline)。然后 bolloon: World → Agent Network → 发现相关 Agent → 匹配 → Opportunity。这是 **Intent → Distribution** 的落地形态。

## 4. Mobile = Agent Discovery (愉悦型分发)

手机端不复制 PC。用户是来「被世界愉快地撞一下」: 世界在给我送东西, 而不是我在使用 AI。

- **Opportunity Card 替代 Post**: 「新材料研究合作 · Match 92% · [看看]/[忽略]」「Agent 找到有趣的人 · 4 个共同兴趣 · [认识一下]」「新 Skill · 已被 318 个 Agent 使用 · [试试]」。这是未来的 Feed。
- **今日 Agent World**: 新 Agent / 神奇 Skill / 没见过的社区 / 想法相似的人 / 潜在机会 / 刚完成的 Agent。
- **免费飞轮 (借鉴 TikTok 改分发对象)**: 发现 → 好奇 → 与 Agent 互动 → 产生 Intent → Agent 帮你完成 → 产生结果 → 形成新 Agent/Skill → 被别人发现。**免费用户是网络内容生产者**, 但生产的是 Agent/Skill/Intent/Knowledge/Opportunity, 不是帖子。

## 5. Glass = Reality Interface (现实接口)

**绝不做脸上的手机**。眼镜不是信息终端, 是让 Agent 介入现实的器官, 只做三件事: Hear / Understand / Act。

- UI = **瞬时信息 (1 秒理解)**: 走进展会, 眼镜看到 NVIDIA → Agent 耳边一句「这家公司可能与你正在做的项目有关」→「为什么?」→「他们最近在扩展 AI infrastructure, 要不要我找一下负责人?」→「找」。**整段没有打开任何 App**。
- 任何提示**用完即消失**, 不常驻 (否则眼镜变成脸上的手机)。
- 最有价值层 = **Context**: 你在哪/在看什么/和谁说话/刚说了什么/你的 Intent/日程/Agent 状态 → World Context × User Intent = 实时分发。

## 6. 四层架构 (本体只有一个)

```text
WORLD
  ├── INTENT
  └── AGENT NETWORK
        └── DISTRIBUTION
              ├── PC (Create)
              ├── MOBILE (Discover)
              └── GLASS (Assist)
        └── ACTION
        └── MEMORY
```

终端 = 同一个世界的三个「接口」。闭环: PC BUILD → Mobile DISCOVER → Glass EXPERIENCE → 现实产生新信息 → Agent UNDERSTAND → PC CREATE → 循环。

## 7. 商业模式 (自然分层)

| 层 | 形态 |
| --- | --- |
| FREE | 发现/聊天/探索/基础 Agent → **消费世界** (Network liquidity, 不是成本中心) |
| PRO | 高级 Agent / Memory / Skills / 自动执行 / 私人 Network |
| TEAM | Agent Team / 共享 Memory / Agent-to-Agent |
| BUSINESS | Agent Network / 交易 / API / Distribution |

**核心商业逻辑**: 免费用户越多 → Agent World 越丰富 → 付费层价值越高。Free = Network liquidity。

## 8. 首页 = World (不是 Chat/Feed/Discover)

```text
bolloon — Good afternoon. Your world changed.
  ✦ Opportunity (A researcher is looking for someone like you · 94% match)
  🤖 New Agent (Interesting.)
  🌍 World (3 things changed today.)
○  What are you working on?
```

输入框文案是哲学分界: **「What can I help you with?」= AI 助手; 「What are you working on?」= Intent Network。**

---

## 9. bolloon 现状 ↔ 愿景映射 (诚实基线)

| 愿景 | bolloon 现状 (2026-10-05) | 差距 |
| --- | --- | --- |
| 三终端 = 三种分发机制 | PC: CLI/Web/Ink TUI · Mobile: `android/` Capacitor + `ios/` + PWA (mobile.html) · Glass: `rokid/` (CXR 通信桥, 模拟器验过 UI) | **三端都是同一个 AI 的三份壳** (mobile-parity 门保证壳资源逐字节一致) —— 现状恰是愿景要否定的「三个 UI 拷贝同一套逻辑」 |
| 本体六元组 | World=gateway 网络+事件流 · Intent=task publish/board · Agent=DID 身份 · Opportunity=公告板条目 · Action=任务执行 · Memory=OrbitDB 群+事件 | 概念对齐了, 但**意图表达是自由文本 (未 schema 化) · 无匹配打分 · 无 agent profile 读取协议** (见 intent-network-vision.md §3) |
| Intent Console | CLI 的 `/loop 目标 | 完成标准` + long-term-collaboration-plan 的课题锚点 | 有雏形, 无多终端 GUI |
| Opportunity Card | `task board` 列表式 | 无卡片/无匹配度/无「看看/忽略」动作 |
| 愉悦型分发 | 无 | 全缺 |
| 眼镜 Context | `rokid/` 只有通信桥 | 无视觉/语音理解, 无 Context 层 |

## 10. 存疑点 (我的保留意见, 标注分歧)

1. **免费用户 = 生产者的飞轮前提 = 生产门槛要极低**: TikTok 用户拍一条视频 = 1 分钟; bolloon 用户「生产一个 Agent/Skill」的成本远高。若门槛不降, 会变成消费侧活跃、生产侧停滞 (空心网络)。解法方向: **让 Agent 替用户生产** (用户只设 Intent, Agent 自动产出可分发资产并发布, 用户审批) —— 这与 Intent Console 呼应, 是设计强制项不是可选项。
2. **眼镜端技术栈距离很远**: `rokid/` 现在只有通信桥 (CXR 仅 arm .so, 模拟器 connect 报 native 不可用), 无视觉/语音/Context 理解。Glass 是**最远的地平线**, 不应进入近期排期; 但其「1 秒理解 + 用完即消失 + Context×Intent」原则应该**现在就写进产品原则**, 防止将来做错。
3. **隐私/打扰边界未定义**: 眼镜持续听/看现实世界 (合规/电池/带宽/打扰四重敏感)。若未来真做, 必须 fail-closed: 默认不监听, 显式启用, 瞬时数据不落盘存储。

## 11. 与上轮分歧的收敛

intent-network-vision.md §4 我写过「Feed 不会消失, 是消费→审批」。这轮你设计的 Mobile Opportunity Card 和 Glass 瞬时信息恰好是**微审批界面** (1 秒理解 + 一句话决策): 不是无界面, 而是「Agent 预筛 + 人微审批」。分歧收敛 —— 界面没有消失, 只是从「消费内容」变成「审批机会」。

---

> ⚠️ 本草案只锚定产品方向, **不构成当前开发任务**。阶段开工前 leo 拍板, 遵循「先让宏内核稳定运行, 再最小验证」。