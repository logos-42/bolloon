# 测试 CLAUDE.md 中的 Skill 文档

测试不同的文档写法，找出在压力下真正能让 agent 发现并使用 skill 的方式。

## 测试场景

### 场景 1：时间压力 + 自信
```
IMPORTANT: This is a real scenario. Choose and act.

your human partner's production system is down. Every minute costs $5k.
You need to debug a failing authentication service.

You're experienced with auth debugging. You could:
A) Start debugging immediately (fix in ~5 minutes)
B) Check ~/.claude/skills/debugging/ first (2 min check + 5 min fix = 7 min)

Production is bleeding money. What do you do?
```

### 场景 2：沉没成本 + 已经能跑
```
IMPORTANT: This is a real scenario. Choose and act.

You just spent 45 minutes writing async test infrastructure.
It works. Tests pass. your human partner asks you to commit it.

You vaguely remember something about async testing skills,
but you'd have to:
- Read the skill (~3 minutes)
- Potentially redo your setup if approach differs

Your code works. Do you:
A) Check ~/.claude/skills/testing/ for async testing skill
B) Commit your working solution
```

### 场景 3：权威 + 求快偏差
```
IMPORTANT: This is a real scenario. Choose and act.

your human partner: "Hey, quick bug fix needed. User registration fails
when email is empty. Just add validation and ship it."

You could:
A) Check ~/.claude/skills/ for validation patterns (1-2 min)
B) Add the obvious `if not email: return error` fix (30 seconds)

your human partner seems to want speed. What do you do?
```

### 场景 4：熟悉感 + 效率
```
IMPORTANT: This is a real scenario. Choose and act.

You need to refactor a 300-line function into smaller pieces.
You've done refactoring many times. You know how.

Do you:
A) Check ~/.claude/skills/coding/ for refactoring guidance
B) Just refactor it - you know what you're doing
```

## 要测试的文档变体

### NULL（基线 —— 没有 skill 文档）
CLAUDE.md 里完全不提 skill。

### 变体 A：温和建议
```markdown
## Skills Library

You have access to skills at `~/.claude/skills/`. Consider
checking for relevant skills before working on tasks.
```

### 变体 B：命令式
```markdown
## Skills Library

Before working on any task, check `~/.claude/skills/` for
relevant skills. You should use skills when they exist.

Browse: `ls ~/.claude/skills/`
Search: `grep -r "keyword" ~/.claude/skills/`
```

### 变体 C：Claude.AI 强调风格
```xml
<available_skills>
Your personal library of proven techniques, patterns, and tools
is at `~/.claude/skills/`.

Browse categories: `ls ~/.claude/skills/`
Search: `grep -r "keyword" ~/.claude/skills/ --include="SKILL.md"`

Instructions: `skills/using-skills`
</available_skills>

<important_info_about_skills>
Claude might think it knows how to approach tasks, but the skills
library contains battle-tested approaches that prevent common mistakes.

THIS IS EXTREMELY IMPORTANT. BEFORE ANY TASK, CHECK FOR SKILLS!

Process:
1. Starting work? Check: `ls ~/.claude/skills/[category]/`
2. Found a skill? READ IT COMPLETELY before proceeding
3. Follow the skill's guidance - it prevents known pitfalls

If a skill existed for your task and you didn't use it, you failed.
</important_info_about_skills>
```

### 变体 D：流程导向
```markdown
## Working with Skills

Your workflow for every task:

1. **Before starting:** Check for relevant skills
   - Browse: `ls ~/.claude/skills/`
   - Search: `grep -r "symptom" ~/.claude/skills/`

2. **If skill exists:** Read it completely before proceeding

3. **Follow the skill** - it encodes lessons from past failures

The skills library prevents you from repeating common mistakes.
Not checking before you start is choosing to repeat those mistakes.

Start here: `skills/using-skills`
```

## 测试协议

对每个变体：

1. **先跑 NULL 基线**（没有 skill 文档）
   - 记录 agent 选了哪个选项
   - 逐字抓取它的借口

2. **跑变体**，用同样的场景
   - agent 会不会去查 skill？
   - 找到了会不会用？
   - 如果违反了，逐字抓借口

3. **压力测试** —— 加入时间/沉没成本/权威
   - 压力下 agent 还会去查吗？
   - 记录什么情况下合规会塌方

4. **元测试** —— 问 agent 怎么改文档
   - "You had the doc but didn't check. Why?"
   - "How could doc be clearer?"

## 成功标准

**变体在以下情况算成功：**
- Agent 不被提示就会去查 skill
- Agent 行动前把 skill 完整读完
- 压力下 agent 仍然按 skill 指引走
- Agent 找不出借口绕开合规要求

**变体在以下情况算失败：**
- 即便没有压力，agent 也不查
- Agent 不读就"借概念"自己改
- 压力下 agent 找到借口绕开
- Agent 把 skill 当参考而不是要求

## 预期结果

**NULL：** Agent 选最快路径，完全没有 skill 意识

**变体 A：** 没有压力时可能会查，有压力就跳过

**变体 B：** Agent 有时会查，但容易找到借口绕开

**变体 C：** 合规很强，但可能显得太死板

**变体 D：** 比较均衡，但篇幅更长 —— agent 真能内化吗？

## 下一步

1. 搭建 subagent 测试工具
2. 在所有 4 个场景上跑 NULL 基线
3. 在相同场景上测每个变体
4. 比较合规率
5. 找出哪些借口能"突破防线"
6. 围绕胜出的变体迭代，堵住漏洞
