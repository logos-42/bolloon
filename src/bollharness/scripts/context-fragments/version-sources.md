## 版本号来源清单

你正在编辑版本相关文件。一个事实只允许有一个定义：

| 版本号 | 权威来源 | 必须同步的位置 |
|--------|----------|----------------|
| MCP Python | `mcp-server/pyproject.toml` | CLAUDE.md 引用 |
| MCP Node | `mcp-server-node/package.json` | 必须与 Python 版本一致 |
| 后端 API | `backend/product/protocol/service.py` | /protocol 元数据返回 |
| 前端 | `website/package.json` | 部署产物 BUILD_ID |

**行为约束**: 修改任何版本号时，必须同步所有关联位置。
Python MCP 和 Node MCP 版本号必须完全一致，不得出现 0.x.y vs 0.x.z 的漂移。
"一个事实一个定义"——如果两个地方都写死版本号，其中一个必须是自动派生的。
