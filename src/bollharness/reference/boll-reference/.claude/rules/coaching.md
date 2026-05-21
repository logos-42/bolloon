---
paths:
  - "scenes/example-coach/**"
  - "backend/product/coaching/**"
  - "backend/product/routes/coaching*.py"
---

# example-coach（kunzhi-coach）开发规则

- 独立上下文：`scenes/example-coach/CLAUDE.md` 是专属开发指南
- 协议接口契约：`scenes/example-coach/docs/PROTOCOL-CONTRACT.md` 定义与协议的精确依赖
- 高危模式：`scenes/example-coach/docs/ERROR-PATTERNS.md` 列出 6 个 coaching 专属错误模式
- 两套语言：协议术语和用户语言严格分离，场景用户永远不接触协议内部概念
