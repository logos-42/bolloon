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
| 列出文件 | 列出目录中的文件 | `list_files(path?)` |
| 读取目录 | 读取目录内容，返回文件列表和目录结构 | `read_directory(path?)` |

---

## 自主循环机制

智能体基于 ReAct (Reasoning + Acting) 模式工作，具备自动评估质量和错误恢复能力：

### 质量评估与自动改进
- **质量阈值**: `0.6` (6/10)
- **最大改进次数**: `3` 次
- 当回复或工具执行结果质量低于阈值时，自动触发改进循环
- 改进时在 system prompt 中添加质量提示，让 LLM 重新生成更优回答

### 错误处理与自动恢复
- **连续错误上限**: `3` 次
- 工具执行失败时增加错误计数
- 达到连续错误上限时，添加错误上下文让 LLM 换一种方式处理
- 工具执行异常会被捕获并记录，不中断循环

### 循环继续条件
当 LLM 返回不是 tool call 格式时，判断是否需要继续循环：
1. 包含错误/失败信息（不存在、找不到、错误、failed 等）
2. 回复太短（<100 字符且无换行），可能是中间回复
3. 包含问号，可能是需要更多信息
4. 不包含明确结论（完成、结果、答案等）

满足以上任一条件且循环未达上限，则继续处理。

### 重试机制
- 工具调用失败时重试（最多 3 次）
- 汇报发送失败时重试（最多 2 次，指数退避）
- 失败的汇报会进入待重试队列

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