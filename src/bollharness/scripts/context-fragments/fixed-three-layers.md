## Fixed 三层定义

你正在编辑 issue 文档。"Fixed" 不等于"症状消失"：

| 层级 | 含义 | 标准 | 标记 |
|------|------|------|------|
| Level 1 | 症状消失 | 生产不报错了 | Runtime Fixed |
| Level 2 | 复发路径关闭 | 有机制防止同类问题再次发生 | **Fixed**（最低标准） |
| Level 3 | 机制消灭 | 有 guard 自动检测 | Fixed + Guarded |

issue doc YAML frontmatter 必须包含：
```yaml
status: fixed|open|wont_fix
prevention_status: open|closed|not_applicable
mechanism_layer: guard|test|type|convention
```

**行为约束**: 如果标 `status: fixed` 但 `prevention_status` 是 `open`，则不合格。必须先分析复发路径。
Guard: `check_issue_closure.py`
