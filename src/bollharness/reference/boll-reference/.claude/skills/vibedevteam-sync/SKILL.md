---
name: vibedevteam-sync
description: 同步 beads 状态到 PROJ 文档。当用户需要更新项目进度时使用。
allowed-tools: "Bash(bd:*),Bash(.claude/skills/vibedevteam-sync/beads-sync-proj.sh),Read,Write,Grep"
version: 0.3.0
status: active
tier: domain
owner: nature
last_audited: 2026-03-21
triggers:
  - beads 状态同步
  - PROJ 文档刷新
outputs:
  - beads 同步结果
truth_policy:
  - 状态以当前 beads 数据为准
  - skill 不复制项目进度事实
---

# VibeDevTeam: 同步 beads 状态到 PROJ

当用户调用此 skill 时，执行以下步骤：

## 触发条件

用户说类似：
- "同步状态"
- "更新 PROJ"
- "同步进度"

## 执行步骤

1. **确认参数**
   - PROJ 文件路径（如：docs/E-014-xxx/proj/PROJ-E-014-v1.md）

2. **验证前置条件**
   ```bash
   test -f "$PROJ_FILE"
   bd list | head -5
   ```

3. **执行脚本**
   ```bash
   cd .claude/skills/vibedevteam-sync && ./beads-sync-proj.sh "$PROJ_FILE"
   ```

4. **报告结果**
   - 备份文件位置
   - 更新的任务数量
   - 未找到的任务数量
