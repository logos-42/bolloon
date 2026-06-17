# 监督者迭代 1 报告 (2026-06-17 15:30)

## 任务
让 bolloon 智能体完成"ReAct loop 自检 + 沉淀" (Prompt 1 of 5).

## 已做的事
1. **写监督者 prompt playbook** → [2026-06-17-supervisor-prompts.md](2026-06-17-supervisor-prompts.md)
   5 个针对痛点的 prompt, 加上"web/CLI/auto"三种喂法 + 自检 checklist.
2. **启动 web server** (port 54188) → bolloon v0.1.41, web 模式 OK
3. **POST Prompt 1** → 端点 202 async, channel=supervisor

## 关键发现 (BLOCKING) — 已修

**Agent loop 总是返回 0 steps + 空 finalReply.** 完整诊断:

```
GET /api/loop/inspect?channelId=supervisor
→ {"summary":"loop 已结束","steps":[],"finalReply":"","tokens":{}}
```

### 根因 #1: max_tokens 撞上限
agent 注入 16K+ system prompt (1000+ judgments + 20 skills + 5 层 system-prompt layers) + 8K+ tool defs, LLM output max_tokens=8192 撞上限, 返回空 content. **已修**: max_tokens 8192 → 16384.

### 根因 #2: pivot loop 调用 chat 的位置搞反
`workflow-pivot-loop.ts:237` 调 `llm.chat(context, systemPrompt)`, 但 `PiAIModel.chat` 签名是 `chat(message, context?)` — 第 2 个参数被吞到 `buildSystemPromptAsync`, 真正的 system prompt 没生效. **已修**: heuristic 启发 — 2nd arg >2K 当 system prompt 覆盖 (pivot 风格), 否则当 context (旧 chat 风格).

### 根因 #3 (待修): pivot loop 把 46K char 当 user message
`workflow-pivot-loop.ts:237` 传 `context` (= `buildContext()` 输出, 含"用户: <input>"前缀) 当 message, 整个 messageHistory 都拼进去. agent 喂 46K markedPrompt → pivot buildContext 拼成 47K → 当 user message 发. 模型拿到 16K system + 47K user → 撞 16K context window. **这条要 Prompt 0 让 agent 修**.

### 监督者已做的 3 个小修
1. `src/llm/pi-ai.ts:maxTokens` 8192 → 16384
2. `src/llm/pi-ai.ts:callOpenAI` 加 finish_reason warn, 撞 max_tokens 上限时报日志
3. `src/llm/pi-ai.ts:chat()` 2nd-arg heuristic (pivot 风格 vs 旧 chat 风格)

## Prompt 0 (P0) — 给 bolloon agent

```
[Prompt 0 — 必须先修, 否则其它 prompt 都不通]

任务: 修 src/agents/workflow-pivot-loop.ts 的 llm.chat 调用, 让 LLM 拿到合理大小的 user message.

复现: 启 web, POST /message '一句话: 1+1=?' → loop/inspect 仍然空.

诊断 (监督者 2026-06-17 已做):
1. src/llm/pi-ai.ts 已修 (max_tokens 16K + chat heuristic)
2. 但 workflow-pivot-loop.ts:237 调 llm.chat(context, systemPrompt) — context 是 buildContext() 输出
   (含 "用户: <input>" 前缀的完整 messageHistory), 被当 user message 发出去
3. agent 喂 46K markedPrompt, pivot buildContext 拼成 47K, 当 user message
4. 模型: 16K system + 47K user = 撞 context window, 回复空

要求:
1. 改 src/agents/workflow-pivot-loop.ts 的 llm.chat 调用, 让 message 字段是真正的 user query (4 chars 那种),
   不是 buildContext() 拼的 47K 字符串
2. 系统提示 + context 可以合并成一个 system 字段, 走 chat(message, systemOverride) 风格
   (注意: chat() 已加 heuristic, 2nd arg >2K 当 system 覆盖)
3. 加 vitest: 跑一个简单 query, 验证 message.length < 100
4. 跑 npx tsc --noEmit 验证类型
5. commit 'auto-evolve: prompt-0 fix pivot loop sending 47K user message'
```

### 验证步骤 (Prompt 0 修完后)

```bash
# 1. 重启 web
nohup npx tsx -r dotenv/config src/index.ts --web --port 54188 &

# 2. 发短消息
curl -X POST -H "Content-Type: application/json" \
  -d '{"text":"一句话: 1+1=?","channelId":"sup"}' \
  http://localhost:54188/message

# 3. 看 inspect (3-5s 后)
curl "http://localhost:54188/api/loop/inspect?channelId=sup"
# 期望: steps > 0, finalReply 含 "2"
```

## 配套发现: P2P `discovery.update is not a function`

启动日志里 hyperswarm 老 P2P 通道 throw (非 fatal, 已被 try/catch 吞):
```
TypeError: discovery.update is not a function
⚠ P2P 初始化失败: discovery.update is not a function
```
这是 hyperswarm 4.x API 变了, 老 P2PNetwork (src/network/p2p.ts 的 joinTopic) 调了不存在的 `discovery.update`. P2PDirect (v3) 走的是 `swarm.join(topic, {server,client})` 然后 `discovery.flushed()` — 这条路是 WORKING 的, 不影响主流程. **忽略**.

## 监督者 TODO

- [x] 写完 5 prompt playbook → docs/plans/2026-06-17-supervisor-prompts.md
- [x] 启 web server, 确认 200
- [x] POST prompt 验证 endpoint 工作
- [x] **诊断 3 个根因** (max_tokens / chat heuristic / pivot 47K user message)
- [x] 修 3 个小 fix (max_tokens / finish_reason / chat heuristic) → commit
- [x] 写 Prompt 0 给 agent → 在本文档
- [ ] Prompt 0 修完: 重启 web, 跑 prompt 1 → 验通
- [ ] Prompt 1: ReAct loop 自检 + 沉淀
- [ ] Prompt 2: 远端委派任务 (cross-user cooperation)
- [ ] Prompt 3: P2P 重连 jitter + 远端 judgment 缓存
- [ ] Prompt 4: 简单问题 5 步内收敛
- [ ] Prompt 5: watchdog 治本 (替代 30min 自杀)
