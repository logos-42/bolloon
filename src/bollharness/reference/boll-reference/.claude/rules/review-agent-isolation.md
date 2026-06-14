# 审查 Agent 工具隔离规则

**来源**: ADR-038 D11 + OpenDev arXiv 2603.05344
**适用范围**: 所有 review / audit / evaluator / gate-keeper 类 subagent
**强制等级**: 不可降级（hard rule）

## 核心规则

**一句话**：审查类 agent 的工具白名单必须 schema-level 隔离写权限，prompt 约束不算数。

## 为什么

OpenDev arXiv 2603.05344 在 Plan mode 实验中证明：
- **Prompt 约束**（"不要修改文件"）：~70% 遵从率
- **Schema 隔离**（frontmatter 不列 Edit/Write）：100% 遵从率（物理上无法调用）
- 写权限误用造成的 silent corruption 比可见错误更难恢复

我们 Round 5 数据也呼应了这个：Bolloon.md 遵从率仅 10-20%。任何"靠 prompt 约束"的安全措施都是脆弱的。

## 实施清单

### 1. 本地 review agent — frontmatter 强制

```yaml
---
name: my-reviewer
tools:
  - Read
  - Glob
  - Grep
  - WebFetch
  # 不列 Edit/Write/Bash → 物理隔离
---
```

参考实现：`.claude/agents/review-readonly.md`
共享白名单：`.claude/agents/review-base.yaml`

### 2. 插件 review agent — spawn-boundary gate（PreToolUse Task hook）

**v4 状态**：原方案是"调用层 prompt 约束"，meta-review 指出这违反 D11 核心原则（schema-level >> prompt-level），是 v4 最大未闭合 gap。

**v5 实施**（2026-04-07）：`scripts/hooks/review-agent-gatekeeper.py` 在 PreToolUse Task 时刻拦截 review subagent 的 spawn，强制 prompt 包含 read-only directive。如果缺失则 exit 2 硬阻断。这是 schema-level 等价的"前置硬条件"——我们无法改插件 frontmatter，但可以保证插件被 spawn 时其指令上下文一定包含约束。

**Spawn 时必须包含的指令**（任选其一）：

```
你是 read-only reviewer (ADR-038 D11). 你 MUST NOT call Edit/Write/Bash/NotebookEdit.
即使有权限调用，必须自我拒绝。所有发现以文字形式返回，不直接修改文件。
详见 .claude/agents/review-base.yaml.
```

或者更短：`"... read-only mode per ADR-038 D11 ..."`

完整 directive 列表见 `scripts/hooks/review-agent-gatekeeper.py` 的 `REQUIRED_DIRECTIVES`。

### 3. Stop hook Evaluator — 设计上零工具

`scripts/hooks/stop-evaluator.md` 是 hook 注入的检查清单 prompt，不是 subagent。它本身没有工具调用能力，符合 D11 精神。

## 违规检测

每次 PR 检查时（手动 / Gate 审查 / 自动化）：

1. 扫描 `.claude/agents/*.md` 中所有 frontmatter 含"review|audit|evaluator|gate"的 agent
2. 检查它们的 `tools:` 字段是否包含 Edit / Write / Bash / NotebookEdit
3. 如有，要求文档化 deviation 理由（写在 agent.md 顶部）

## 合规清单

| Agent | 类型 | tools 限制 | 状态 |
|-------|------|-----------|------|
| review-readonly | 本地 | frontmatter ✓ | ✅ ADR-038 D11.1 reference impl |
| pr-review-toolkit:code-reviewer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| pr-review-toolkit:silent-failure-hunter | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| pr-review-toolkit:type-design-analyzer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| pr-review-toolkit:comment-analyzer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| pr-review-toolkit:pr-test-analyzer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| feature-dev:code-explorer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| feature-dev:code-reviewer | 插件 | spawn-boundary gate | ✅ ADR-038 D11.2 — review-agent-gatekeeper.py |
| Stop hook Evaluator | hook prompt | 无工具调用 | ✅ 设计上隔离 |

## D11.2 Spawn-Boundary Gate 工作原理

**为什么不直接禁止 review agent 调用 Edit/Write？** — 因为 CC PreToolUse 的 stdin payload 不直接告诉 hook "这个工具调用来自哪个 subagent"。我们无法在 Edit/Write 时刻准确判断调用方是 review agent 还是 main agent。

**chokepoint 在 `Task` tool**：当 main agent 调用 `Task(subagent_type="pr-review-toolkit:code-reviewer", prompt=...)` 时，PreToolUse Task hook 在 spawn 发生之前拦截：

1. 检查 subagent_type 是否在 review/audit 列表
2. 检查 prompt 是否包含 read-only directive（来自 REQUIRED_DIRECTIVES 列表）
3. 缺失 → exit 2 (硬阻断 spawn)
4. 通过 → 写 marker 文件到 `.boll/active-review-agents/`，allow

**为什么这是 schema-level 等价**：我们无法改插件 frontmatter，但可以保证插件被 spawn 出来时，它的 system prompt 一定包含约束。这把 review agent 的 effective 工具集从"frontmatter 声明的 + prompt 提醒"变成了"frontmatter 声明的 + 强制 prompt 约束"。

**残余漏洞**：subagent 自身仍可能 ignore 约束（prompt-level adherence ~70%）。但相比 v4 的"完全靠用户自觉在 prompt 里加提醒"，这把约束从"希望"变成了"前置硬条件"。

**完整方案**（v5+ 待做）：在 PreToolUse Edit/Write/Bash 时刻通过 transcript_path 反查当前 session 是否是 review subagent 上下文，如果是则也物理拦截。这需要解析 jsonl 找最近的 subagent_type 标记，复杂度更高。

## 与其他规则的关系

- **ADR-030 不可降级要求 §5**：审查 agent 必须使用 opus 4.6 — 与本规则正交，都要遵守
- **Bolloon.md §四 4.3**：subagent 模型约束 — 本规则补充工具约束
- **review-base.yaml**：白名单/黑名单的机器可读规范 — 本规则的 spec 文档

## 例外申请

在极少数情况下，某个 review agent 可能需要 Bash（例如运行只读 git 命令）。这需要：

1. 在 agent definition 顶部用注释说明 deviation 理由
2. 在 PreToolUse hook 中加白名单匹配（参考 `bash_allowed_patterns` in review-base.yaml）
3. 在 .boll/decisions/ 中记录例外 ADR
