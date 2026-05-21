## Protocol API 消费方

你正在编辑 /protocol/ 相关代码。以下是 Protocol API 的消费方列表：

| 消费方 | 入口 | 认证方式 |
|--------|------|----------|
| MCP Server (Python) | `mcp-server/boll_mcp/client.py` | session token |
| MCP Server (Node) | `mcp-server-node/src/client.ts` | session token |
| 前端 website | `website/` fetch 调用 | session token (cookie) |
| Bridge Agent | `bridge_agent/` | bridge API key |
| 外部 A2A 调用方 | federation endpoint | DID 签名 |

**行为约束**: 修改任何 /protocol/ 路由的请求/响应结构时，必须检查上述所有消费方是否兼容。
不得在不更新消费方的情况下修改返回字段名或删除字段。
新增字段必须是 optional，避免破坏现有消费方。
