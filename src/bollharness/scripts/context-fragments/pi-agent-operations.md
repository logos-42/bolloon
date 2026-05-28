---
paths:
  - "src/agents/**"
---

# Pi Agent 操作与工具定义

> 来源: pi-sdk.ts TOOL_DEFINITIONS + getDefaultResponse
> 关联: src/agents/constraint-layer.ts（工具注册）

---

## 核心操作

| 操作 | 描述 | 方法签名 |
|------|------|----------|
| 读取文档 | 读取并分析文档内容，支持 .txt, .md, .pdf, .docx | `read_document(path)` |
| 总结文档 | 总结文档内容，可选提供上下文 | `summarize_document(path, context?)` |
| 改进文档 | 改进文档，需提供文件路径和改进要求 | `improve_document(path, requirements)` |
| 查看节点 | 查看已连接的对等节点 | `list_peers()` |
| 发送消息 | 向指定对等节点发送消息 | `send_message(peer_id, message)` |
| 广播消息 | 广播消息到所有节点 | `broadcast_message(message)` |
| 查看身份 | 查看当前智能体身份 | `get_identity()` |
| 设置 Persona | 更新智能体 persona 信息 | `set_persona(persona_json)` |
| 执行工作流 | 执行预定义工作流 | `run_workflow(steps)` |
| 查看日志 | 查看最近操作日志 | `get_operation_logs()` |

---

## 示例请求格式

### 文档操作
```
"读取 README.md"
"总结一下 src/index.ts"
"改进文档，按照更清晰的错误处理要求"
```

### P2P 网络操作
```
"查看当前连接了哪些节点"
"向 QmABC... 发送测试消息"
"广播消息：系统将在 10 分钟后维护"
```

### 身份与状态
```
"查看身份"
"查看日志"
```

---

## 工具注册位置

工具在 `pi-sdk.ts` 的 `PiAgent` 类构造函数中注册，映射到：
- `src/agents/constraint-layer.ts` — ConstraintLayer 基类提供的基础能力
- `src/network/p2p.ts` — P2P 网络模块
- `src/documents/reader.ts` — 文档读取模块

---

## 自然语言指令映射

| 自然语言指令 | 解析关键词 | 执行方法 |
|-------------|-----------|----------|
| 读取 X | `读取`、`read_document`、`read` | `readDocument(path)` |
| 总结文档 | `总结`、`summarize_document` | `summarizeDocument(path, context?)` |
| 改进文档 | `改进`、`improve_document` | `improveDocument(request)` |
| 查看节点 | `查看节点`、`list_peers` | `listPeers()` |
| 发送消息 | `向 X 发送消息`、`send_message` | `sendMessage(peerId, message)` |
| 广播消息 | `广播消息`、`broadcast_message` | `broadcast(message)` |
| 查看身份 | `查看身份`、`get_identity` | `getIdentity()` |
| 查看日志 | `查看日志`、`get_operation_logs` | `getOperationLogs()` |