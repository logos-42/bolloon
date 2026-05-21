# 审查 Agent 工具隔离规则

**来源**: ADR-038 D11 + OpenDev arXiv 2603.05344
**适用范围**: 所有 review / audit / evaluator / gate-keeper 类 subagent
**强制等级**: 不可降级（hard rule）

## 核心规则

**一句话**：审查类 agent 的工具白名单必须 schema-level 隔离写权限，prompt 约束不算数。

## 为什么

- **Prompt 约束**（"不要修改文件"）：经验上约 70% 遵从率
- **Schema 隔离**（frontmatter 不列 Edit/Write）：100% 遵从率（物理上无法调用）
- 写权限误用造成的 silent corruption 比可见错误更难恢复

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

参考实现：`.boll/agents/review-readonly.md`
共享白名单：`.boll/agents/review-base.yaml`

### 2. 插件 review agent — spawn-boundary gate（PreToolUse Task hook）

我们无法改第三方插件的 frontmatter，但可以在 CC spawn subagent 之前的 `PreToolUse Task` hook 拦截：

1. 检查 subagent_type 是否在 review/audit 列表（配置见 `.boll/review-agents.yaml`）
2. 检查调用 prompt 是否包含 read-only directive
3. 缺失 → exit 2 硬阻断 spawn
4. 通过 → 写 marker 文件到 `.boll/active-review-agents/`，allow

参考实现：`src/scripts/hooks/review-agent-gatekeeper.ts`

### 3. Stop hook Evaluator — 设计上零工具

`src/scripts/hooks/stop-evaluator.md` 是 hook 注入的检查清单 prompt，不是 subagent。它本身没有工具调用能力，符合 D11 精神。

## 违规检测

每次 PR 检查时（手动 / Gate 审查 / 自动化）：

1. 扫描 `.boll/agents/*.md` 中所有 frontmatter 含"review|audit|evaluator|gate"的 agent
2. 检查它们的 `tools:` 字段是否包含 Edit / Write / Bash / NotebookEdit
3. 如有，要求文档化 deviation 理由（写在 agent.md 顶部）

## D11.2 Spawn-Boundary Gate 工作原理

**为什么不直接禁止 review agent 调用 Edit/Write？** — 因为 CC PreToolUse 的 stdin payload 不直接告诉 hook "这个工具调用来自哪个 subagent"。我们无法在 Edit/Write 时刻准确判断调用方是 review agent 还是 main agent。

**chokepoint 在 `Task` tool**：当 main agent 调用 `Task(subagent_type=<reviewer>)` 时，PreToolUse Task hook 在 spawn 发生之前拦截并强制 prompt 包含 read-only directive。

**残余漏洞**：subagent 自身仍可能 ignore prompt 约束（~70% adherence）。但相比"完全靠调用方自觉"，这把约束从"希望"变成了"前置硬条件"。

## 例外申请

在极少数情况下，某个 review agent 可能需要 Bash（例如运行只读 git 命令）。这需要：

1. 在 agent definition 顶部用注释说明 deviation 理由
2. 在 PreToolUse hook 中加白名单匹配（参考 `bash_allowed_patterns` in review-base.yaml）
3. 在 `docs/decisions/` 中记录例外 ADR