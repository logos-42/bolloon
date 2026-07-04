---
title: Bolloon Skill 索引
source: session
created: 2026-07-04
last_confirmed: 2026-07-04
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: meta
tags: [skills, indexing]
---

> Bolloon 项目用到的 skill 系统: 全局 opencode skills (35 个, `~/.config/opencode/skills/`)
> + Bolloon 项目特定 (2 个, 已从 opencode 复制到 `.bolloon/skills/`, 2026-07-04).

## 全局 Skill 索引 (35 个)

按类别分组, 每个 skill 用一句话说明触发场景.

### 内容 / 创作

| Skill | 触发场景 |
|-------|----------|
| AgentROI 结构 | AI Agent 商业价值 + ROI 分析 |
| HIBS 公理创生 | 从"感觉不对"创建新数学公理 (HIBS 8 步法) |
| Rails 升级 | 分析 Rails 应用并提供升级评估 |
| 一人公司函数 | 个人公司: Skill 当函数调用, 盘点/升级/自动化/减法 |
| 价值心法 | 姜胡说《价值心法》: Skill 是函数, Input/Process/Output/买单人 |
| 主权个人 | 戴维森《主权个人》: 暴力经济学 + 信息时代谋生 |
| 写实验报告技能 | 消融实验报告标准 8 节模板 + 假阳性验证 |
| 升级技能技能 | 升级维护现有 skill 文件 (frontmatter / 版本) |
| 反事实干预目标技能 | 反事实推理能力评估 + V25.5 海马体路径分叉突破 |
| 反脆弱 | 纳西姆《Antifragile》: 脆弱/坚韧/反脆弱三类 + 杠铃策略 |
| 反脆弱-barbell | 反脆弱杠铃策略 (从极保守到极激进两端配置) |
| 反脆弱-optionality | 反脆弱数学签名: 期权思维 + 凸性 + 泰勒斯甜葡萄 |
| 反脆弱-skin-in-the-game | 反脆弱伦理: 利益绑定 + 汉谟拉比法则 + 斯蒂格利茨综合征 |
| 实验设计技能 | LMT-twister 实验三步法: 假设→控制→验证 + 单一变量原则 |
| 微习惯 | Stephen Guise《微习惯》: 小到不可能失败 (1 个俯卧撑 / 1 页书) |
| 思考致富 | 拿破仑·希尔《Think and Grow Rich》: 13 条致富法则 |
| 技能写作 | 创建新 skill / 编辑已有 skill / 部署前验证 |
| 技能创造器 | 创建高效 skill 的指南 |
| 技能开发者 | Anthropic 最佳实践创建管理 Codex skill |
| 技能打磨器 | 迭代式审查修复 Claude Code skill 质量问题 |
| 技能探索 | 几 min 内自动文档/GitHub 仓库/PDF 转 Codex skill |
| 搭建个人系统 | 从"卖时间"模式升级到"系统自动运转"模式 |
| 效能优先 | 时间管理伪命题: 别讲效率, 改讲效能 (散步三问日记法) |
| 智能复利 | AI 时代企业持续进化的底层逻辑: 智能复利五要素 |
| 机制配合结构技能 | LMT-twister 新机制集成: 基类链 + 维度适配 + 世界交互 |
| 毛泽东思维 | 教员思维框架: 矛盾论/实践论/论持久战 + 战略分析方法论 |
| 消融实验技能 | 普适消融实验: 拆一个看缺啥 + 单一变量 + 基线 + 假阳性 4 模式 |
| 深度构建 agent | Claude Code / Codex / Cursor / Windsurf 架构分析 |
| 短视频价值法 | 短视频复利系统: 供需关系 + 产品思维 + 资产复利 |
| 结构思维 | 叙事消费 vs 结构掌控 + 个人决策验证系统 |
| 维基 llm | 知识系统 Bootstrap v2.0.0: wiki-first 范式 (本项目已 bootstrap) |
| 脑科学技能 | 脑启发三系统: 丘脑门控 + 基底选择 + 海马情景 |
| 自我蒸馏 | 把聊天记录/日记/照片解构成数字自我 |
| 财务自由笔记 | Andrew Hallam《Millionaire Teacher》: 9 堂课 + 指数基金 |
| 达尔文技能优化 | 达尔文技能优化器 2.0: SkillLens 9 维评分 + 迭代优化 |
| 达尔文投资 | 普拉萨德《我从达尔文那里学到的投资知识》: 永久所有者策略 |
| 乔布斯思维 | Steve Jobs 思维框架: 6 个心智模型 + 8 条决策启发式 |
| 音乐创作 | 情绪 → Suno Prompt 8 层流水线 |

### 工具 (编程 / debug)

| Skill | 触发场景 |
|-------|----------|
| Skill 类别含 `customize-opencode` | opencode 自身配置 (.opencode/, AGENTS.md 等) |

## 项目特定 Skill (Bolloon 内部)

| Skill | 来源 | 用途 | 接入时间 |
|-------|------|------|----------|
| 消融实验技能 | opencode (元木) | 验证 bolloon 工具调用循环 (D1) + skill 加载器 (D2) | 2026-07-04 |
| 技能写作 | opencode (元木/Anthropic) | 元技能: 验证 use_skill 协议端到端 (D3), 让 bolloon agent 能按 TDD 模式写新 skill | 2026-07-04 |

**复制方法** (将来新增 skill):
```bash
mkdir -p .bolloon/skills
cp -r ~/.config/opencode/skills/<skill_name> .bolloon/skills/
# 然后在 manifests/raw_sources.csv 加一行 (skill-source, hash, lifecycle)
```

验证加载: `npx tsx scripts/ablation/check_skills.ts` → 应输出 `COUNT=2` 及两个 skill 名字.

## 自定义 opencode 配置目录

```
~/.config/opencode/
├── skills/           # 35 个全局 skill
├── commands/         # slash command (本项目有 .claude/commands/)
├── agents/          # sub-agents
├── plugin/          # plugin (本项目无)
└── opencode.json     # opencode 主配置
```

## 触发词索引

| 触发词 | 调用的 skill |
|--------|--------------|
| "wiki" / "维基 llm" / "知识系统" | 维基 llm |
| "消融实验" / "ablation" | 消融实验技能 + 写实验报告技能 |
| "反事实" / "counterfactual" / "cf_acc" | 反事实干预目标技能 |
| "达尔文" / "SkillLens" / "skill 优化" | 达尔文技能优化 |
| "结构" / "叙事" / "拆解" | 结构思维 |
| "复利" / "智能复利" / "AI 闭环" | 智能复利 |
| "一人公司" / "person 函数化" | 一人公司函数 |
| "效能" / "散步三问" / "发呆" | 效能优先 |
| "短视频" / "Suno" / "内容复利" | 短视频价值法 |
| "微习惯" / "1 个俯卧撑" | 微习惯 |
| "反脆弱" / "杠铃" / "凸性" / "期权" | 反脆弱 |
| "价值心法" / "Skill 函数" | 价值心法 |
| "投资" / "达尔文投资" / "高 ROCE" | 达尔文投资 |

## 来源

- 全局 skills: `C:\Users\Mechrevo\.config\opencode\skills\`
- 本项目用 `~/.config/opencode/skills/` 作为 `defaultSkillPaths` 优先级 1 (src/agents/skill-loader.ts:160-166)
- 项目级 skills: `<cwd>/.bolloon/skills/` (priority 2)
- 兼容: `~/.boll/skills/` (priority 3, bollharness 旧用户)

## 同步说明

- 全局 skill 改动后: reload opencode 会看到 (`Bolloon` 项目里 AGENTS.md §6 触发维基)
- 不要 commit `~/.config/opencode/skills/` 到项目 (在 gitignore)
- 项目级 skill 若有, 写 `/skills/` 然后 AGENTS.md 加引用