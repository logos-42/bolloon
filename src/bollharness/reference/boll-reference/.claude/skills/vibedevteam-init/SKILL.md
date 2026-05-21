---
name: vibedevteam-init
description: 批量创建 beads 任务并关联 TASK 文档。当用户需要初始化 Epic 的 beads 任务时使用。
allowed-tools: "Bash(bd:*),Bash(.claude/skills/vibedevteam-init/beads-auto-link.sh),Read,Write,Grep,Glob"
version: 0.3.0
status: active
tier: domain
owner: nature
last_audited: 2026-03-21
triggers:
  - beads 初始化
  - Epic 拆任务
outputs:
  - beads 初始化结果
truth_policy:
  - 任务事实以当前 beads 数据和 TASK 文档为准
  - skill 不复制项目状态
---

# VibeDevTeam: 批量初始化 beads 任务

当用户调用此 skill 时，执行以下步骤：

## 触发条件

用户说类似：
- "初始化 beads 任务"
- "创建 beads 任务"
- "批量创建任务"

## 执行步骤

1. **确认参数**
   - EPIC_ID（如：E-014）
   - TASK_DIR（如：docs/E-014-xxx/task）

2. **验证前置条件**
   ```bash
   ls "$TASK_DIR"/TASK-*.md
   command -v bd
   command -v jq
   ```

3. **执行脚本**
   ```bash
   cd .claude/skills/vibedevteam-init && ./beads-auto-link.sh "$EPIC_ID" "$TASK_DIR"
   ```

4. **验证并报告**
   - 创建的任务数量
   - 关联的 TASK 文档数量
   - 提示下一步：`bd dep add` 设置依赖
