# Bolloon Agent Bug Report & Fix Attempts

> 发现日期：2026-07-16
> 环境：Windows 10, Node.js v24.15.0, deepseek-v4-flash
> 版本：bolloon 0.2.15 (@bolloon/bolloon-agent)

---

## 1. 会话记忆缺失（AI 不记得之前说了什么）

**现象**：每次回复只针对用户最后一条消息，不记得同一会话中之前的对话内容。

**根因**：`dist/web/server.js` 中 3 处 LLM prompt 构造只取了最新一条 `text`：
```javascript
const fullPrompt = `【本轮用户请求】\n${text}\n【请求结束】\n\n...`;
```

Session 消息虽然被保存到磁盘（`session.messages.push`），但构建 prompt 时**从不从 session 加载历史**。

**Fix**：在 3 处 prompt 构造点前插入 `loadSession()` → 提取历史消息 → 拼接为 `【对话历史】` 区块注入 prompt：

| 路径 | 位置 | 作用 |
|------|------|------|
| 主聊天 `/message` | line 2294 | 发送消息时注入历史 |
| P2P 远程聊天 | line 586 | 远端访客发消息时注入历史 |
| 重新生成 `/regen` | line 3356 | 重新生成回复时注入历史 |

**涉及文件**：`dist/web/server.js`

---

## 2. deepseek-chat 模型停用迁移（7/24 截止）

**现象**：`deepseek-chat` 将于 2026-07-24 停用，Bolloon 中 4 处硬编码。

**根因**：模型名在以下位置写死为 `'deepseek-chat'`：

| 位置 | 文件 | 用途 |
|------|------|------|
| 用户配置 | `~/.bolloon/llm-config.json` | 用户的实际模型配置 |
| `mapModel()` 默认值 | `dist/llm/pi-ai.js` line 262 | PiAI 类模型映射 |
| `detectModel()` 硬编码 | `dist/llm/pi-ai.js` line 603 | initPiAI 的后备默认值 |
| 默认配置 + UI 模型列表 | `dist/llm/config-store.js` lines 68, 137 | 配置存储和前端下拉菜单 |

**Fix**：全部改为 `deepseek-v4-flash`。

---

## 3. 无原生 Tool Calling（AI 光说不做）

**现象**：AI 回复"好的我来检查"但从不实际调用任何工具。

**根因**：`callOpenAI()` 发送的 API 请求体没有 `tools` 参数：
```javascript
// dist/llm/pi-ai.js callOpenAI()
const requestBody = {
    model: this.mapModel(),
    messages,
    temperature,
    max_tokens: maxTokens
};
// 没有 tools！
```

deepseek-v4-flash 支持 OpenAI 兼容的原生 function calling，但 Bolloon 只把工具描述以纯文本形式写在 system prompt 里（ReAct XML 格式），从未通过 API 的 `tools` 参数传入。

**Fix**：

| 步骤 | 文件 | 改动 |
|------|------|------|
| ① 添加 schema 转换 | `dist/agents/pi-sdk.js` | `getOpenAIToolSchemas()` — 将内部 tool Map 转为 OpenAI function calling 格式 |
| ② runReActLoop 传参 | `dist/agents/pi-sdk.js` line 1033 | 调用 `getOpenAIToolSchemas()` 并传给 `callLlmWithRecovery` |
| ③ callLlmWithRecovery 传参 | `dist/agents/pi-sdk.js` line 1645/1677 | 接受 `openaiTools` 参数并传给 `llm.chat()` |
| ④ pi-ai chat 接受 tools | `dist/llm/pi-ai.js` line 71/91 | `chat()` 接受 `tools` 参数，传给 `generateText()` |
| ⑤ generateText 传给 callOpenAI | `dist/llm/pi-ai.js` line 195 | 将 `tools` 传给 `callOpenAI()` |
| ⑥ callOpenAI 加入请求体 | `dist/llm/pi-ai.js` line 284 | `requestBody.tools = tools` |
| ⑦ tool_choice 设置 | `dist/llm/pi-ai.js` line 285 | `requestBody.tool_choice = 'auto'` |

---

## 4. usePivotLoop 绕过 runReActLoop

**现象**：所有针对 runReActLoop 的 tool calling 修改从未被执行。

**根因**：`dist/web/server.js` line 1231 将 `usePivotLoop` 设为 `true`：
```javascript
usePivotLoop: true,
```

promptStream 中 `usePivotLoop=true` 时走 `promptWithPivotLoop` 路径，完全不经过 `runReActLoop`。我的所有修改（native tool calling、tool schema 转换等）全部在 runReActLoop 中，等于没用。

**Fix**：临时设为 `false`（line 1231）：
```javascript
usePivotLoop: false, // 临时关闭以启用 native tool calling
```

> 建议：后续应将 tool calling 移植到 `promptWithPivotLoop`，或在 `promptWithPivotLoop` 入口也加上工具 schema 传递。

**涉及文件**：`dist/web/server.js`

---

## 5. Native Tool Calls 被读取后丢弃

**现象**：即便 LLM 正确输出了 `tool_calls`（`finish_reason='tool_calls'`），系统仍回复空白。

**根因**：`runReActLoop` line 1006 读取了 `response.toolCalls`，但 line 1101 只检查 `this.parseToolCall(reply)`（文本格式），从未使用 `nativeToolCalls` 变量。

```javascript
// runReActLoop
const reply = (response.reply || '').trim();
const nativeToolCalls = response.toolCalls;  // ← 读到了
// ... 中间 95 行代码 ...
const toolCall = this.parseToolCall(reply);  // ← 只检查文本格式
// nativeToolCalls 从未被使用！
```

**Fix**：在 line 1101 前先检查 `nativeToolCalls`，将 native 格式转换为 internal `{name, args, id}` 格式。`buildMessages()` 已支持将 internal 格式转回 OpenAI 协议的 `tool_calls` 数组。

```javascript
// 优先处理 native function calling，回退到文本解析
let toolCall = null;
if (nativeToolCalls && nativeToolCalls.length > 0) {
    const nc = nativeToolCalls[0];
    // 解析 JSON arguments，提取 name/args/id
}
if (!toolCall) {
    toolCall = this.parseToolCall(reply);
}
```

**涉及文件**：`dist/agents/pi-sdk.js`

---

## 6. Tool Role 被 buildMessages 转为 User Role

**现象**：DeepSeek API 返回 400 错误："An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'."

**根因**：`buildMessages()` 中所有 `role: 'tool'` 的消息被转为 `role: 'user'`（为兼容 MiniMax）：
```javascript
// dist/agents/pi-sdk.js buildMessages()
if (role === 'tool') {
    const result = m.toolResult ? JSON.stringify(m.toolResult) : content;
    content = `[工具结果] ${result}`;
    out.push({ role: 'user', content });  // ← 转成了 user role！
    continue;
}
```

OpenAI/DeepSeek API 协议要求：assistant 消息带 `tool_calls` 后，下一条消息必须是 `role: 'tool'` 并带有匹配的 `tool_call_id`。转成 `user` 后违反了协议约束。

**Fix**：增加 `lastHadToolCalls` 追踪，当前一条是 `tool_calls` 时，保留 `role: 'tool'`：

```javascript
let lastHadToolCalls = false;
// ...
if (role === 'assistant') {
    if (tc && tc.id) {
        lastHadToolCalls = true;
        // 发出 tool_calls 格式
    }
}
if (role === 'tool') {
    if (lastHadToolCalls && (m.toolCallId || m.id)) {
        out.push({ role: 'tool', content, tool_call_id: m.toolCallId || m.id });
        lastHadToolCalls = false;
        continue;
    }
    // 否则回退到 user role（兼容旧 history）
}
```

**涉及文件**：`dist/agents/pi-sdk.js` — `buildMessages()`

---

## 7. 空 Content + Tool Calls 被误判为 API 错误

**现象**：LLM 正确输出 tool_calls 但无文本内容（`content=""`），code 将其视为上游错误并重试 3 次后放弃。

**根因**：`callOpenAI()` line 321 的条件判断：
```javascript
const content = choice?.message?.content || '';
const toolCalls = choice?.message?.tool_calls;
if (content) {  // ← 空字符串为 falsy！
    return { reply: content, toolCalls };
}
// 空 content → 当错误处理，退避重试
```

当 LLM 只输出 `tool_calls` 不附带文本时，`content` 为 `''`，被当作错误。

**Fix**：加入 toolCalls 判断：
```javascript
if (content || (toolCalls && toolCalls.length > 0)) {
    return { reply: content, toolCalls };
}
```

**涉及文件**：`dist/llm/pi-ai.js` — `callOpenAI()`

---

## 8. Session 存储多路径导致脏数据残留

**现象**：即使清除了缓存，旧 session 仍被加载，恢复已损坏的 tool_calls 历史。

**根因**：Bolloon 在三处存储 session 数据：

| 路径 | 格式 | 用途 |
|------|------|------|
| `~/.bolloon/sessions/` | `{channelId}__{sessionId}.json` | 主 session 存储 |
| `~/.bolloon/sessions/cache/` | JSON 文件 | session 缓存 |
| `~/.bolloon/memory/agent_*/sessions/` | `.summary.md` | 摘要记忆 |

清理时需**三处都清**，漏任一则 session 恢复时会从残留文件重建对话历史。

**Fix**：手动清理三处。

> 建议：增加 session 验证机制，加载历史时检查格式完整性，发现非法 tool_calls（无对应 tool result）时自动降级。

---

## 9. 僵尸进程端口耗尽

**现象**：多次重启后，node.exe 进程堆积，所有 54188-54197 端口被占用，新实例无法启动。

**根因**：进程管理机制不完善。Bolloon 切换端口时不会清理前一个实例。

**Fix**：`taskkill /F /IM node.exe` 全杀后重启。

> 建议：启动时增加端口健康检查 + 旧进程清理逻辑。

---

## 10. deepseek-v4-flash Thinking 模式与 tool_choice 冲突

**现象**：`tool_choice: 'required'` 导致 400 错误："Thinking mode does not support this tool_choice"。

**根因**：deepseek-v4-flash 默认启用 thinking 模式（与旧版 deepseek-chat 行为不同）。Thinking 模式不支持 `tool_choice: 'required'`，仅支持 `'auto'` 或 `'none'`。

**Fix**：使用 `tool_choice: 'auto'` 而非 `'required'`。

> 建议：如需要强制工具调用，需在 DeepSeek API 中禁用 thinking 模式（`thinking.type` 参数格式待确认）。

---

## 剩余问题

### Tool Calling 仍不可靠

即使以上所有修复均已应用，deepseek-v4-flash 在中文对话上下文中仍倾向于生成纯文本回复而非调用工具。`tools` 参数已被正确传入 API 请求体，但模型选择不使用它们。

**可能的原因**：
- deepseek-v4-flash 对 OpenAI 协议 function calling 的支持不如专用 agent 模型
- Thinking 模式（默认开启）干扰了工具调用决策
- 系统提示词中的 ReAct 格式文本（`<invoke>` 标签描述）与原生 `tools` 参数可能产生冲突

**建议方向**：
1. 尝试 DeepSeek 新提供的 Anthropic 兼容端点（`https://api.deepseek.com/anthropic`），Bolloon 已有 `callAnthropic()` 路径
2. 降低 temperature 值（0.3-0.5），减少模型"创造性回复"倾向
3. 简化 system prompt 中关于工具调用的描述，避免与原生 tools 参数冲突

---

## 修改文件清单

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `dist/web/server.js` | 修复 + 配置 | 3 处记忆注入 + usePivotLoop 关闭 |
| `dist/agents/pi-sdk.js` | 新增 + 修复 | getOpenAIToolSchemas + native tool_call 处理 + tool role 保留 |
| `dist/llm/pi-ai.js` | 修复 | 模型名迁移 + tools 参数传递 + tool_choice 设置 + 空 content 判断 |
| `dist/llm/config-store.js` | 修复 | 模型名默认值 + UI 模型列表 |
| `~/.bolloon/llm-config.json` | 配置 | 模型名迁移 |

---

*报告生成时间：2026-07-16 16:20*
