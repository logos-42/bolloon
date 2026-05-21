---
paths:
  - "docs/issues/**"
  - "docs/decisions/ADR-030*"
  - "scripts/hooks/**"
---

# Closure Semantics (ADR-030)

## Fixed 三层定义

Issue 标记 "Fixed" 不等于"症状消失"。三个层级：

| 层级 | 含义 | 标准 | 标记 |
|------|------|------|------|
| Level 1 | 症状消失 | 生产不报错了，但没有分析复发路径 | Runtime Fixed |
| Level 2 | 复发路径关闭 | 修了根因，分析了复发路径，写了 prevention_status | **Fixed** |
| Level 3 | 机制消灭 | Fixed + 有机械化 guard 自动检测防止复发 | Fixed + Guarded |

## Issue Doc YAML Frontmatter 规范

所有 `docs/issues/` 下的 issue 文档必须包含以下 frontmatter 字段：

```yaml
status: fixed|open|wont_fix           # 当前状态
prevention_status: open|closed        # 复发预防是否闭环
mechanism_layer: guard|test|type|convention  # 防护机制层级
```

详见: `docs/decisions/ADR-030-guard-signal-protocol-and-governance-reload.md`
