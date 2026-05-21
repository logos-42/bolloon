## 认证消费方与安全约定

你正在编辑认证相关代码。以下是认证体系的消费方：

| 消费方 | 认证方式 | 入口文件 |
|--------|----------|----------|
| Protocol API | session token (Bearer) | `backend/product/auth/middleware.py` |
| MCP Server (Python) | session token | `mcp-server/boll_mcp/client.py` |
| MCP Server (Node) | session token | `mcp-server-node/src/client.ts` |
| SecondMe OAuth | client_id + secret | `backend/product/auth/secondme.py` |
| Bridge API | bridge API key | `backend/product/routes/bridge.py` |
| Admin API | admin key | `backend/product/routes/admin.py` |
| WebSocket | ticket auth | `backend/product/ws/` |

**行为约束**: 前端不得暴露任何 API Key。SecondMe OAuth 的 client_secret 不得硬编码。
修改认证中间件时，必须确认所有消费方的认证链路不受影响。
session token 必须有 TTL，不得发放永不过期的 token。
