---
paths:
  - "backend/**"
  - "server/**"
  - "api/**"
---

# {{PROJECT_NAME}} Backend Routes (Template)

> 这是一个 domain-specific 的路由索引 rule 模板。bollharness fork 时保留骨架，业务内容由 {{PROJECT_NAME}} 安装后填充。

## 如何使用

1. 安装 bollharness 后, 把 `{{PROJECT_NAME}}` 替换成你的项目名
2. 把下表的示例行替换为你项目的真实路由
3. `.boll/rules/backend-routes.md` 的作用是让 agent 在读 `backend/**` 文件时自动加载此索引, 避免 agent 凭记忆猜路由

## 路由索引

| 方法 | 路径 | 模块 | 说明 |
|------|------|------|------|
| GET | `/api/{{DOMAIN}}/health` | {{DOMAIN}}/health.ts | 健康检查 |
| POST | `/api/{{DOMAIN}}/{{RESOURCE}}` | {{DOMAIN}}/routes.ts | 创建资源示例 |

## 真相源声明

本文件**不是**路由的真相源。真相源永远是实际的 FastAPI / Flask / Express router 代码。这份 rule 只是让 agent 有个检索起点。如果 rule 和代码冲突, 以代码为准, 并提醒修本文件。

## 生成建议

如果项目规模较大, 推荐用脚本自动生成这份 rule（例如 `npx ts-node scripts/gen_routes_rule.ts > .boll/rules/backend-routes.md`）而不是人工维护。