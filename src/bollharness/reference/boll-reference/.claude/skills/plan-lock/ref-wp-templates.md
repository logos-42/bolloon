# WP 文档规范

每个 WP 必须有独立文件夹：`docs/decisions/tasks/{PLAN编号}-{WP编号}/`

## 目录结构

```
PLAN024-WP1/
├── TASK.md    # 任务定义（目标、文件、验收标准、约束）
├── TODO.md    # 执行清单（审查项 + 实施项 + 测试项 + 回归项）
└── LOG.md     # 开发日志（实际修改 + 测试结果 + 偏差 + 复审结论）
```

每个 PLAN 还需要 `{PLAN-ID}-DEV-LOG.md` 记录整体修改总览。

## 创建时机

- TASK.md + TODO.md：task-arch 拆分时创建
- LOG.md：执行开始时创建，过程中持续更新

不允许在没有 TASK.md 的情况下开始写代码。

## TASK.md 模板

```markdown
# {PLAN-ID}-{WP-ID}: {标题}

**Phase**: {归属阶段}
**依赖**: {前置 WP 列表，无则写"无"}
**状态**: pending | in_progress | done | blocked

| 项 | 内容 |
|---|------|
| **Input** | 当前相关文件和代码位置 |
| **Output** | 修改后的文件和具体变更 |
| **Acceptance** | 可写成 pytest 的验收条件 |
| **Bounded** | 不改什么（明确边界） |
| **Root Cause** | 为什么要做这个修改 |
```

## TODO.md 模板

```markdown
# {PLAN-ID}-{WP-ID} TODO

## 审查项
- [ ] 变更链路完整
- [ ] 消费方覆盖

## 实施项
- [ ] 代码修改
- [ ] commit

## 测试项
- [ ] 端到端测试通过

## 回归项
- [ ] 无新增失败
```

## LOG.md 模板

```markdown
# {PLAN-ID}-{WP-ID} 开发日志

## 实际修改
- 文件: {path}
- 变更: {描述}

## 测试结果
- {test_name}: PASS/FAIL

## 偏差/阻塞
- 无 / {描述}

## 复审结论
- 通过 / 待修复
```
