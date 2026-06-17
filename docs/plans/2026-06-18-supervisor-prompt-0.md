# Prompt 0 — bolloon 智能体修 ReAct loop 空回复 (BLOCKING)

> **监督者递交给 bolloon agent 的 prompt. 来源**: 2026-06-17 iter-1 完整诊断.
> **触发条件**: web 模式 POST /message → /api/loop/inspect 返回 `{summary:"loop 已结束", steps:[], finalReply:""}`.
> **优先级**: 最高, 不修这个, Prompt 1-5 都跑不通.

## 复现 (5 步, 监督者已验过)

```bash
cd /Users/apple/Downloads/bolloon
nohup env CLAUDE_CODE_TMPDIR=/Users/apple/.bolloon/tmp-bolloon \
  npx tsx -r dotenv/config src/index.ts --web --port 54188 \
  > /Users/apple/.bolloon/tmp-bolloon/bolloon.log 2>&1 &
sleep 25  # 等 startup + iroh + bootstrap

curl -X POST -H "Content-Type: application/json" \
  -d '{"text":"一句话: 1+1=?","channelId":"verify"}' \
  http://localhost:54188/message
# 期望 202

sleep 30
curl "http://localhost:54188/api/loop/inspect?channelId=verify"
# 期望: steps > 0, finalReply 含 "2"
# 实际: {"summary":"loop 已结束","steps":[],"finalReply":"","tokens":{}}
```

## 监督者已确认的根因 (3 个, 前 2 个监督者已修, 第 3 个你修)

### 根因 #1: max_tokens 撞上限 ✅ 已修
- 文件: `src/llm/pi-ai.ts:104`
- 改动: `maxTokens: 8192` → `maxTokens: 16384`
- commit: `7f42307`

### 根因 #2: chat() 第 2 参数位置搞反 ✅ 已修
- 文件: `src/llm/pi-ai.ts:92` (heuristic 启发)
- 改动: chat(message, contextOrSystem?, signal?) — 2nd arg >2K 当 system override, 否则当 context
- commit: `7f42307`

### 根因 #3: pivot loop 把 47K 当 user message 发 ❌ 待你修

**症状** (监督者加临时 log 后看到):
```
[PiAgent] promptWithPivotLoop called, input len=46876
[pivot] iter=1 chat call: msg=46880 chars, sys=6498 chars
[pi-ai] hit max_tokens ceiling (model=MiniMax-M3, max_tokens=16384) — caller should trim prompt or raise cap
```

**根因链**:
1. `src/web/server.ts:1905` `agent.promptStream(markedPrompt, ...)`, markedPrompt = `【本轮用户请求】\n<text>\n【请求结束】\n\n<contextHint>` (46K)
2. `src/agents/pi-sdk.ts:promptStream` 把整个 46K 当 `input` 透传给 pivot loop
3. `src/agents/workflow-pivot-loop.ts:237` `llm.chat(context, systemPrompt)` — context 是 `buildContext()` 输出 ("用户: <46K markedPrompt>"), 47K 当 user message 发
4. LLM 看到 system=11K + user=47K = 58K, 撞 16K context window → content=""

**修复点** (2 个文件, 你来定怎么改):

#### 修复 A: `src/agents/pi-sdk.ts` `promptStream` 入口
解析 `【本轮用户请求】...\n【请求结束】` marker, 把:
- `userText` (marker 内的真正用户输入) → 传给 LLM 的 `message` 字段
- `contextHint` (marker 之外的 system context) → 拼到 `systemPrompt` 末尾

伪代码:
```typescript
async promptStream(input, onStream, signal, channelId) {
  // ...
  const markerMatch = input.match(/【本轮用户请求】\s*([\s\S]*?)\s*【请求结束】/);
  const userText = markerMatch ? markerMatch[1].trim() : input;
  const contextHint = markerMatch ? input.replace(markerMatch[0], '').trim() : '';

  this.messageHistory.push({ role: 'user', content: userText });
  // 后面所有用 `input` 的地方改成 `userText`
  // (computeJudgmentGate / classifyIntent / promptWithPivotLoop / monitorAfterReply)
  // contextHint 拼到 systemPrompt 末尾
}
```

#### 修复 B: `src/agents/workflow-pivot-loop.ts:237`
`llm.chat(this.rawInput, fullPrompt)`, 其中:
- `rawInput` 字段在 `execute()` 入口存 `input` (即上面修过的 userText, 4 chars)
- `fullPrompt` = `systemPrompt + "\n\n" + context` (原 buildContext 输出), 走 chat() 的 2nd-arg heuristic 当 system 覆盖

**或者**更简单的方案 B' (如果不想动 pi-sdk): 改 web server 的 promptStream 调用, 让 web 端自己提取 userText 后只把 userText 喂给 agent, contextHint 走别的渠道.

## 验证 (修完跑这个)

```bash
# 1. 重启 web (改完 ts 文件后)
pkill -f 'tsx.*src/index.ts' 2>/dev/null; sleep 2
nohup env CLAUDE_CODE_TMPDIR=/Users/apple/.bolloon/tmp-bolloon \
  npx tsx -r dotenv/config src/index.ts --web --port 54188 \
  > /Users/apple/.bolloon/tmp-bolloon/verify.log 2>&1 &
sleep 25

# 2. 发短消息
curl -X POST -H "Content-Type: application/json" \
  -d '{"text":"一句话: 1+1=?","channelId":"verify"}' \
  http://localhost:54188/message

# 3. 看 inspect
sleep 30
curl "http://localhost:54188/api/loop/inspect?channelId=verify"
# 应该看到: steps=[{name, status, durationMs}], finalReply 含 "2", summary 非空

# 4. 跑 npx tsc --noEmit 验证类型
npx tsc --noEmit

# 5. commit (message: "auto-evolve: prompt-0 fix pivot loop sending 47K user message")
```

## 完成

完成上述修改后回复监督者:
- 列改动文件 + diff 摘要
- inspect 验证结果
- vitest 全量结果
- commit hash

然后监督者会递 Prompt 1 (ReAct loop 自检 + 沉淀).

## 上下文: bolloon 5 大痛点 (Dive-into 架构分析)

1. 不够丝滑 — single-turn 8 步才答, 简单问题应在 1-3 步
2. 智能体循环完成度低 — 没学失败模式, 重复犯同错
3. 没有和外部远程智能体交流合作的能力 — p2p-chat-tools draft 状态
4. p2p 通信脆弱 — `discovery.update is not a function` (hyperswarm 4.x API 变了)
5. 远程加载记录不够稳健 — 远端 judgment 没 cache, 网络挂时无降级

详见 `docs/plans/2026-06-17-supervisor-prompts.md` (5 prompt playbook).
