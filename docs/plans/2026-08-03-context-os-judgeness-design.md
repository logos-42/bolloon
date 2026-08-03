---
title: Context OS × judgeness × persona 融合设计 — Bolloon 默认判断力上下文系统
source: session
created: 2026-08-03
last_confirmed: 2026-08-03
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [context-os, judgeness, persona, design, value-lifecycle, judgment, decision-store, valuepoint-routing]
---

# Context OS × judgeness × persona 融合设计

> 目标: 把 Ziye-Context-OS 的系统骨架(四层架构 + 价值回归 + 决策推理链 + 对话收尾)设计为
> Bolloon 的**默认判断力上下文系统**; persona 6 文件对齐该架构; 与已有 judgeness 系统结合。

> **实现状态 (2026-08-03)**: P0-P5 全部落地.
> - P1 ✅ persona-loader 判断力声明 + INJECT 纪律段 + lifecycle-hooks 注入
> - P2 ✅ server.ts contextHint 动态状态层段 (chat-worksite / focus)
> - P3 ✅ decision-store 9 要素决策协议 + 4 工具 + reflect 到 judgeness
> - P4 ✅ memory 摘要价值点分类路由 → human-values + judgeness
> - P5 ✅ 资产层 12+3 文件夹体系 (~/.bolloon/context-os/) + 3 工具 + contextHint 目录注入 + 价值点唯一落点
> 验证: tsc 0 错, vitest 1015/1015 通过, build + build:web 通过.

## 0. 三套系统现状对照

| 维度 | Ziye Context OS (文档) | judgeness (src/judgeness/) | persona (src/bootstrap/persona-loader.ts) |
|---|---|---|---|
| 核心资产 | 可被未来调用的判断/能力/关系/证据/产出 | JudgenessDescription 5 维 (judgment/taste/novelty/imagination/curiosity) + basis + scope | 6 文件: soul/identity/project/user/agent/wiki |
| 生命周期 | 临时→验证→固化→索引→归档 (阶段0-4) | openState 状态机 (open/locked/human-only) + HumanJudgment status (active/pending/superseded/rejected) + TTL | 无生命周期, 静态读 |
| 授权 | 隐私三层 (公共/工作/私密) | 3 道闸: 闸1 scrubber / 闸2 allowlist / 闸3 human-override + visibility 4 层 (public/allowlist/peers/private) | 无隐私控制 |
| 读取 | 先看现在→再看任务→再调历史; 最小读取集 = chat-worksite/NOW/focus | rank 4 因子 (recency/breadth/depth/trust) 带 why | contextHint 注入 (server.ts ~3321) |
| 收尾 | 提取价值点→唯一落点→归档→更新工作现场 | reflect 双向反射 (hv ↔ jd) + run-end 工具候选扫描 | 无 |
| 状态 | — | 防御期: P2P protocol / auto-add 为 stub | 已生产 |

## 1. 核心洞察: 两套系统是同构的

Context OS 的"价值回归机制"和 judgeness 的"状态机 + 3 道闸"解决的是**同一个问题**:
什么值得留下、谁能写、谁能看、何时淘汰。映射:

| Context OS 价值阶段 | judgeness / HumanJudgment 对应 |
|---|---|
| 阶段0 临时价值点 (对话中刚出现, 未验证) | HumanJudgment source=implicit + jd openState=locked, by=agent |
| 阶段1 验证 (实际使用一次/证据/明确确认) | openState: locked→open (闸3 human 确认) 或 by=human |
| 阶段2 固化 (写唯一正式位置) | visibility: private→allowlist/public; description_version=1 |
| 阶段3 索引化 (高频引用→默认入口) | rank.ts 4 因子分高 → 进入默认注入集 |
| 阶段4 归档/删除 (过期/被替代/无法验证) | status→superseded/rejected + expiresAt 到期→pending |

**结论**: Context OS 的价值判断标准 ("未来哪个具体场景会用到它? 回答不出=噪音")
已经内建在 judgeness 的 openState=locked 默认 + 闸3 human-override 里。不需要新机制,
只需要把两者**显式连线**。

## 2. 融合设计: Bolloon 默认判断力上下文系统

### 2.1 上下文装配对齐 Context OS 四层读取协议

server.ts contextHint 构建顺序 (现: persona → memory 回读 → plan 回读 → dirHint) 对齐四层:

| Context OS 层 | Bolloon 装配点 | 现状 | 改动 |
|---|---|---|---|
| 入口层 (身份/边界/纪律) | persona 6 文件 + system-prompt core layers | ✅ 已注入 | 加 INJECT 段 (agent 工作纪律: 先看现在→再任务→再历史; 区分事实/判断/待确认) |
| 动态状态层 (NOW/focus/worksite) | memory 摘要回读 ≈ chat-worksite; active plans ≈ focus | ✅ 已注入 | NOW.md 语义 = "当前 channel 最近记忆 + 未完成计划" 合并段, 已有数据, 只需改标签 |
| 判断与协议层 (JUDGMENT.md/06-Protocols) | judgeness 注入门 + 决策协议 | ⚠️ 判断注入有, 决策协议无 | 决策 9 要素协议注入 (见 2.3); JUDGMENT.md 概念 = judgeness 5 维 + 避免清单 |
| 资产层 (01-12 按需) | skill/plan/document 按需加载 | ✅ 已是按需 | 无需改 |

### 2.2 persona 6 文件 ↔ Context OS 目录映射

| persona 文件 | Context OS 层 | 职责边界 (该存什么/不该存什么) |
|---|---|---|
| soul.md | 01-Me | 长期身份、原则、不可碰边界、稳定偏好 (不存临时情绪) |
| identity.md | 01-Me | 身份声明、DID、角色 |
| project.md | 04-Projects | 当前项目的真实状态、已验证事实、未验证假设 (不存脑暴) |
| user.md | 02-Network | 用户画像、关系、可调用资源 |
| agent.md | 09-Tools/10-Skills | agent 自身能力、已验证技能 (不存"想学") |
| wiki.md | 07-Knowledge | 跨项目复用的领域知识 |

增强: persona 文件 frontmatter 加 judgment 声明字段
(judgment_style: 决策偏好 / stakes_default: 默认风险等级 / revisable: 是否可回滚),
与 judgeness 5 维 facets 对应 — persona 提供"这个人怎么判断"的入口, judgeness 提供"已验证的判断资产"。

### 2.3 决策协议 = Context OS §7 的 9 要素

重大决策不允许只写结论。落地:
- 工具: 扩展 plan-store 或新 decision-store — 记录 问题/选项(含不做)/成本/收益/风险/信息缺口/推荐/时机/回滚条件 9 字段
- 注入: 决策协议以 layer 形式进 system-prompt (tool:decision 或 channel 层), 只在高 stakes 场景提示
- 落点: 12-Analysis (决策过程与复盘) — bolloon 侧 = ~/.bolloon/decisions/<ts>.json
- 与 judgeness: 决策确认后自动 reflect → HumanJudgment + jd (阶段0 入账)

### 2.4 对话收尾四步 = 现有 run-end 链路补强

| Context OS 步骤 | Bolloon 现状 | 补强 |
|---|---|---|
| Step1 提取价值点 | compressSessionToMemory (LLM 摘要) ✅ | 摘要中显式分类: decision/lesson/knowledge/insight (已有能力, 加结构化字段) |
| Step2 唯一落点 | skill-writer 候选扫描 (≥2 成功工具) ⚠️ 只覆盖技能 | 扩展: 检测到 decision/insight → 写 human-values + judgeness (reflectAfterJudgment 已就绪) |
| Step3 执行归档 | session 落盘 ✅ | 已有 |
| Step4 更新工作现场 | memory 摘要已承担 ✅ | 已有 |

### 2.5 隐私三层 ↔ visibility 4 层 (无需新机制)

| Context OS 隐私层 | judgeness visibility | 已实现 |
|---|---|---|
| 公共方法论 | public | ✅ |
| 工作资产 (脱敏后分享) | allowlist | ✅ 闸2 |
| 私密资产 | private + 闸1 scrubber 出站剥字段 | ✅ |

## 3. 落地路径 (分阶段, 减法优先 — 不建新系统, 只连线)

- **P0** 本设计文档落盘 (完成)
- **P1** persona 架构对齐: 6 文件 frontmatter 加 judgment 声明 + INJECT 段注入 agent 工作纪律 (改 persona-loader + server.ts contextHint)
- **P2** 上下文装配段重组: memory 回读 + plan 回读合并为 "动态状态层" 段, 标签对齐 Context OS 语义
- **P3** 决策协议: decision-store + 9 要素工具 + 决策后自动 reflect 到 judgeness (打通 Context OS §7 ↔ judgeness)
- **P4** 收尾补强: memory 摘要分类路由 → decision/insight 自动写 human-values + judgeness (打通 Context OS §6 ↔ judgeness)

## 4. 不做的事 (边界)

- 不建 12 个目录 (Context OS 文档自己说 MVP 只要 6 目录 4 文件)
- 不引入新存储格式 (judgeness frontmatter v2 已是 Context OS 兼容)
- 不把 judgeness P2P 协议提前激活 (防御期 stub 保持)
- 不追求"记录完整", 追求"关键时刻调出正确上下文" (Context OS §11 边界)

## 5. 一句话总结

> Bolloon 的默认判断力上下文 = persona(入口, 怎么判断) + memory/plan(动态状态, 现在在哪)
> + judgeness(判断资产, 验证过什么) + 决策协议(怎么决策) + 收尾路由(价值不流失)。
> Context OS 提供骨架和纪律, judgeness 提供生命周期和授权, 两者本就是同一套机制的两种描述。
