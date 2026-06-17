# 监督者迭代 1 报告 (2026-06-17 15:30)

## 任务
让 bolloon 智能体完成"ReAct loop 自检 + 沉淀" (Prompt 1 of 5).

## 已做的事
1. **写监督者 prompt playbook** → [2026-06-17-supervisor-prompts.md](2026-06-17-supervisor-prompts.md)
   5 个针对痛点的 prompt, 加上"web/CLI/auto"三种喂法 + 自检 checklist.
2. **启动 web server** (port 54188) → bolloon v0.1.41, web 模式 OK
3. **POST Prompt 1** → 端点 202 async, channel=supervisor

## 关键发现 (BLOCKING)

**Agent loop 总是返回 0 steps + 空 finalReply.** 直接诊断:

```
GET /api/loop/inspect?channelId=supervisor
→ {"summary":"loop 已结束","steps":[],"finalReply":"","tokens":{}}
```

**根因** (在 src/llm/pi-ai.ts 验证):

| 测试 | endpoint | 模型 | 结果 |
|------|----------|------|------|
| MiniMax `/text/chatcompletion_v2` | v2 原生 | MiniMax-M3 | content=`""`, finish=length |
| MiniMax `/chat/completions` (bolloon 用的) | OpenAI 兼容 | MiniMax-M3 | content=`1+1=2` ✅ |
| bolloon agent promptStream | OpenAI 兼容 | MiniMax-M3 | (无 1+1 这种简单问题) |

**bolloon 走的是 OpenAI 兼容路径** (callOpenAI at pi-ai.ts:285), 这条路 **对单轮短问题能跑**, 但 agent 注入 1000+ judgments + 20 个 skills 后变成 8K+ 系统提示, 加上 miniReAct loop 的 tool_definitions 后总 token 超 16K, 模型 output 撞 max_tokens=8192 限制, 返回空.

**为什么之前的 auto-evolve-loop 也"没 diff"**? 同样的原因 — LLM 返回空字符串, extractDiff 拿不到 ```diff 块, 连续 3 次 → 自动 rollback → 退出. 监督者之前以为 loop 不稳, 实际是 **LLM 路径在 agent 规模下就不通**.

## 验证步骤 (下次直接跑)

```bash
# 1. 启动 web
npx tsx -r dotenv/config src/index.ts --web

# 2. 发短消息
curl -X POST -H "Content-Type: application/json" \
  -d '{"text":"1+1=?","channelId":"test"}' \
  http://localhost:54188/message
# → 202

# 3. 看 inspect (3-5s 后)
curl "http://localhost:54188/api/loop/inspect?channelId=test"
# → 期望: steps > 0, finalReply 非空
# → 实际: steps=[], finalReply=""
```

**如果是空**, LLM 没返回 → 看 `~/.bolloon/tmp-bolloon/bolloon.log` 里 `[PiAIModel] Initializing` 之后有没有 `CombinedSignal` / fetch / response.

## 配套发现: P2P `discovery.update is not a function`

启动日志里 hyperswarm 老 P2P 通道 throw:
```
TypeError: discovery.update is not a function
⚠ P2P 初始化失败: discovery.update is not a function
```

这是 hyperswarm 4.x API 变了, 老代码 (估计在 src/network/p2p.ts 的 joinTopic 实现里) 调了不存在的 `discovery.update`. P2PDirect (v3) 走的是 `swarm.join(topic, {server,client})` 然后 `discovery.flushed()` — 这条路是 WORKING 的 (memory: v3-p2p-end-to-end-working), 所以不影响主流程. **这条可以忽略**, 不在本次 prompt 范围.

## 下一步: 把诊断打包成 Prompt 0 (P0) 让 agent 自己修

新增 Prompt 0 给 bolloon:

```
[Prompt 0 — 必须先修, 否则其它 prompt 都不通]

任务: 修 src/llm/pi-ai.ts 的 callOpenAI, 让 MiniMax 在 agent 大 system prompt 下也能正确返回.

复现: web 模式 POST /message '1+1=?' → loop/inspect 返回空.

诊断 (我已经做了):
1. MiniMax-M3 在 /chat/completions 短 prompt 跑得通
2. 同样的代码, agent 拼出 16K+ system prompt + 8K+ tool defs 后, fetch 200 但 content="" 
3. 怀疑: max_tokens=8192 撞上限 / model 不知道是哪一个 / response format 不对

要求:
1. 跑 web 模式, 发短消息, 拿实际 response JSON (在 callOpenAI 末尾加临时 console.log 整个 data, 删)
2. 如果 finish_reason='length' → 把 max_tokens 提到 16384
3. 如果 content="" 但 finish='stop' → 检查 messages 末尾有没有空 system / 空 user, 滤掉
4. 修完跑 vitest 全量
5. commit 'auto-evolve: prompt-0 fix minimax empty content under large system prompt'
```

Prompt 1 (loop 自检) 等 Prompt 0 修完才能跑.

## 监督者 TODO

- [ ] Prompt 0: MiniMax 大 prompt 空内容 (BLOCKING, 必先修)
- [ ] Prompt 1: ReAct loop 自检 + 沉淀
- [ ] Prompt 2: 远端委派任务 (cross-user cooperation)
- [ ] Prompt 3: P2P 重连 jitter + 远端 judgment 缓存
- [ ] Prompt 4: 简单问题 5 步内收敛
- [ ] Prompt 5: watchdog 治本 (替代 30min 自杀)

## 监督者自检

- [x] 写完 5 prompt playbook
- [x] 启 web server, 确认 200
- [x] POST prompt 验证 endpoint 工作
- [x] **诊断出 BLOCKING 根因** (LLM 路径在大 prompt 下空)
- [ ] 写 Prompt 0 让 agent 自修
- [ ] 重启 web, 跑 prompt 0 → 验通
- [ ] 跑 prompt 1 → 验通
