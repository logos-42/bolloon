## MCP 双端一致性约定

你正在编辑 MCP 相关代码。Python 和 Node 两端必须保持一致：

- **工具数量**：两端都是 54 个 @mcp.tool() / registerTool()
- **工具名称**：必须完全相同（boll_xxx）
- **行为语义**：相同输入必须产生相同输出结构
- **版本号**：pyproject.toml 和 package.json 版本必须一致

对应文件映射：
- Python: `mcp-server/boll_mcp/server.py` <-> Node: `mcp-server-node/src/index.ts`
- Python: `mcp-server/boll_mcp/client.py` <-> Node: `mcp-server-node/src/client.ts`
- Python: `mcp-server/boll_mcp/config.py` <-> Node: `mcp-server-node/src/config.ts`

**行为约束**: 改了一端后，你必须检查另一端是否需要同步。不得单独修改一端的工具签名或行为。
Guard: `check_mcp_parity.py`
