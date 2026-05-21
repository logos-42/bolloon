---
paths:
  - "config.ts"
  - "settings.ts"
  - ".env*"
  - "scripts/deploy*"
---

# {{PROJECT_NAME}} 环境变量清单 (Template)

> 这是一个环境变量索引 rule 模板。bollharness fork 时保留骨架，{{PROJECT_NAME}} 自己填充具体变量。

## 如何使用

1. 把 `{{PROJECT_NAME}}` 替换成你的项目名
2. 下表每一项必须如实填写**用途 + 必需性 + 默认值**
3. **禁止**在这份文件里写任何真实 secret 值——这份文件会被提交到 repo

## 变量表

| 变量 | 必需 | 默认 | 用途 |
|------|------|------|------|
| `{{PROJECT_NAME_UPPER}}_ENV` | 是 | `development` | 运行环境 (`development` / `staging` / `production`) |
| `{{PROJECT_NAME_UPPER}}_PORT` | 否 | `8080` | HTTP 监听端口 |
| `{{PROJECT_NAME_UPPER}}_DB_URL` | 是 | — | 数据库连接串 |
| `{{PROJECT_NAME_UPPER}}_LOG_LEVEL` | 否 | `INFO` | 日志级别 |

## Secret 管理

- 真实 secret 值只能存在于 `.env.local` / CI secret store / 部署 secret manager
- `.env.local` 必须在 `.gitignore` 中
- bollharness `src/scripts/sanitize.ts` 会拦截常见 secret 模式 (`sk-ant-`、`sk-or-`、`.env*` KV 等)