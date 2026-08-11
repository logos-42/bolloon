# Bolloon Optional Skills

Bolloon 项目维护的**默认不激活**的技能模板 (借鉴 Hermes `optional-skills/` 模式)。

## 为什么 optional?

- **垂直领域** — 特定项目/特定人群才用 (MT5 回测、特定实验)
- **重量级依赖** — 需要本机特殊环境 (MT5 终端、MetaEditor MCP)
- **方法论沉淀** — 有价值的流程, 但不是每个人每次都需要

保持默认工作流精简, 需要时按需取用。

## 发现 / 安装

```bash
ls optional-skills/          # 看有哪些
# 安装 = 拷贝到 Hermes profile skills (让 agent 自动加载):
cp -r optional-skills/mt5-backtest ~/.hermes/skills/
# 或在 wiki (docs/wiki/index.md) 查看登记与使用记录
```

## 收录纪律 (照 Hermes 目录策略)

- 目录存在 = 本仓库实测/沉淀过, 不是随便写的
- 每个技能: 触发条件 + 步骤 + 陷阱 + 验证
- 用过的技能发现问题 → 当场修 (skill_manage patch)

## 当前技能

| 技能 | 触发 | 内容 |
|------|------|------|
| [mt5-backtest](./mt5-backtest/SKILL.md) | 用户要做 MT5 回测/策略验证 | MCP 拉数据 → 回测 → walk-forward/跨品种防过拟合 → 中文报告 (DengYu/HIBS 沉淀) |
| [hermes-borrow](./hermes-borrow/SKILL.md) | 研究外部 agent 架构借鉴落地 | 读源码 → 差距表 → 一次一 commit → wiki 回写 (本次 Hermes 借鉴的方法论) |
