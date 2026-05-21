---
name: vibedevteam-graph
description: 生成任务依赖可视化图。当用户需要查看或分析任务依赖关系时使用。
allowed-tools: "Bash(bd:*),Bash(.claude/skills/vibedevteam-graph/beads-graph.sh),Bash(dot:*)"
version: 0.3.0
status: active
tier: domain
owner: nature
last_audited: 2026-03-21
triggers:
  - beads 依赖图
  - 任务可视化
outputs:
  - 任务依赖图
truth_policy:
  - 图的事实以当前 beads 数据为准
  - skill 只描述如何生成，不复制任务状态
---

# VibeDevTeam: 生成任务依赖图

当用户调用此 skill 时，执行以下步骤：

## 触发条件

用户说类似：
- "生成依赖图"
- "依赖可视化"
- "任务图"

## 执行步骤

1. **确认参数**
   - EPIC_ID
   - 输出文件路径（可选，默认 docs/{EPIC_ID}-dependencies.svg）

2. **验证 Graphviz**
   ```bash
   command -v dot
   ```
   
   如果未安装，提示用户：
   ```bash
   # macOS
   brew install graphviz
   # Ubuntu
   sudo apt-get install graphviz
   ```

3. **执行脚本**
   ```bash
   cd .claude/skills/vibedevteam-graph && ./beads-graph.sh "$EPIC_ID" --output "$OUTPUT_FILE"
   ```

4. **报告结果**
   - 输出文件位置
   - 查看方法：`open $OUTPUT_FILE` 或 `xdg-open $OUTPUT_FILE`
