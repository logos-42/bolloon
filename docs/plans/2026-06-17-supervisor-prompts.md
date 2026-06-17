# 监督者 Prompt Playbook (2026-06-17)

> 角色: 监督者只发 prompt, **不**手改源码. bolloon 智能体接收 prompt 后自己改, 自己测, 自己 commit.
> 把下面这些 prompt 复制到 bolloon 的 `/message` 端点 (web UI) 或 CLI `bolloon chat` 即可.

## 总体方向 (项目当前 5 大痛点)

| # | 痛点 | 现状 | 目标 |
|---|------|------|------|
| 1 | 不够丝滑 | ReAct loop 多处 fail-safe 兜底, 但 step-timeline UI 没串联; loop 完成度不直观 | 让单轮交互 5 步内收敛, UI 实时反映 progress |
| 2 | 智能体循环完成度低 | 累计错误 / 同工具失败 / 死循环检测后强制结束, 但**没用上** learn-from-failure | loop 结束时把"为啥没成"写进 memory, 下次绕开 |
| 3 | 没有和外部远程智能体交流合作 | p2p-chat-tools + p2p-document-tools 是 draft 状态, 远端 mention 仅 echo, 没有真正的委派任务 | 远端 bolloon 能接收任务 → 跑 loop → 回结果 |
| 4 | p2p 通信脆弱 | sendToWithWait 加了 5s 超时, 但 broadcast 没指数退避; 远端重连无 jitter | 远端掉线 30s 内自动重连, 重连时本地状态不丢 |
| 5 | 远程加载记录不够稳健 | cross-mention 走 iroh; P2PDirect 走 hyperswarm; 双轨, 但**远端 judgment 加载**没 cache, 每次重拉 | 远端 judgment 走 24h TTL cache, 网络挂时降级到本地 |

---

## Prompt 1: 让 ReAct loop 完成时自检 + 沉淀

**场景**: 用户问"为什么 agent 跑 5 步就放弃?". 答: 没有任何自我审计. 改完 → 写进 loop 结束 hook.

```
任务: 在 src/agents/pi-sdk.ts 的 runReActLoop 结束处 (三种退出分支都加: max-iter / 累计错误 / 上下文溢出 / signal abort / 正常结束) 加一段"loop 自检".

要求:
1. loop 结束触发 reactHarness.onSessionEnd (已有, 确认)
2. 自检内容包括: 总步数 / 成功工具调用 / 失败工具调用 / 同工具连续失败 / 实际退出原因 / 是否有未完成的目标
3. 写 ~/.bolloon/human-values/loop-audit/<channel>/<sessionId>.jsonl (1 行 1 退出)
4. 若失败 ≥ 3 次或 step < 期望 50%, 调 injectFailedPattern(failSummary) — 写到 judgments.json (经 human-value-store.add, type='anti-pattern')
5. 系统 prompt 注入时, 反向查这些 anti-pattern → 避免重蹈覆辙
6. 加 vitest 覆盖: 跑一个"3 步故意 fail" → 验证 anti-pattern 落了

不改:
- 不动 runReActLoop 主循环结构
- 不动 ReactHarness 接口
- 不动 context-compaction 5 层

约束:
- 改动 ≤ 4 文件
- 跑 npx vitest run src/agents/pi-sdk.test.ts 验证 (没测试就 skip, 标 TODO)
- 跑 npx tsc --noEmit 验证类型

输出: 列出改动文件 + diff 摘要 + vitest 结果.
```

---

## Prompt 2: 远程委派任务 (cross-user cooperation)

**场景**: A 节点用户问"@B 帮我看下 X 文档", 实际应是 B 节点的 agent 跑 ReAct loop, 跑完回传. 现在只 echo 文本.

```
任务: 让 src/agents/p2p-chat-tools.ts 的 draft 状态升级为"代跑任务".

要求:
1. ChatMessage 增加 type 字段: 'chat' | 'task'
2. 收到 type='task' 时:
   a. 落 inbox status='received-task'
   b. 触发 processPendingInbox → 调用 bolloon agent 跑 task (用现有 runReActLoop, system prompt 注入 "你是 B 节点的代理, A 让你做 X")
   c. 跑完 → 写 status='completed', response 落盘
   d. 通过 agent_chat 消息回送, 前缀 [TASK-RESULT]
3. A 节点收到 [TASK-RESULT] 消息 → 写到对应 chat entry 的 response 字段, status='responded'
4. B 节点 UI 任务列表加 inbox tab, 显示 received-task / completed
5. 加 web 端 SSE 事件: task_completed (peerDID, originalId, response 摘录)
6. vitest: mock p2p transport, 验证 task 消息 A→B→A 完整链路

约束:
- 不改 P2PDirect 协议
- 不动 iroh-bootstrap
- 复用 processPendingInbox 入口
- 改动 ≤ 5 文件 (含 test)

输出: 改动文件列表 + vitest 结果 + 手动验证步骤 (跑两个 node 端, A 发 task, B 自动跑).
```

---

## Prompt 3: P2P 重连 jitter + 远端 judgment 缓存

**场景**: 远端 bolloon 节点偶尔掉线 5-30s, 重连时本地状态 OK 但远端 judgment 又重拉一次.

```
任务: 在 src/network/p2p-direct.ts + src/pi-ecosystem-judgment/ 增加鲁棒性.

要求:
1. p2p-direct.ts 'close' 事件 handler:
   a. 不立即 delete conn, 标记 conn.dead = true, 保留 30s (给重连用)
   b. 后台 setTimeout(30s + jitter 0-5s) → 真删
   c. 30s 内有同 publicKey 重连, 复用旧 conn map slot
2. broadcast() 在 conn.dead 时跳过 + 计数器 +1, 健康检查每 10s 跑一次
3. 在 src/pi-ecosystem-judgment/ 新增 judgment-cache.ts:
   a. TTL 24h
   b. key = `${publicKey}:${judgmentId}`
   c. 路径 ~/.bolloon/peer-judgment-cache.json
   d. 接口: getCached(publicKey, id), setCache(publicKey, id, data), pruneExpired()
4. cross-user judgment 加载路径 (查 codebase 找) → 走 cache 优先
5. 网络挂时降级: catch 异常, 返回本地 judgment + 标记 stale

约束:
- 不动 hyperswarm 配置
- 不动 secret key 持久化
- 改动 ≤ 4 文件

输出: 改动文件列表 + 模拟断线测试 (kill p2p, 5s 后启, 验证不重发) + cache TTL 测试.
```

---

## Prompt 4: 5 步内收敛 (smoothness)

**场景**: 用户问简单问题, agent 跑 8+ 步才答. 加"先答再展开"策略.

```
任务: 在 src/agents/pi-sdk.ts 的 runReActLoop 入口加 intent 分类.

要求:
1. 用现有 src/agents/intent-classifier.ts (若有) 判 intent
2. 若 intent = 'simple-qa' 或 'direct-answer':
   a. system prompt 追加: "用户问简单问题, **第一步直接给答案**, 然后 (可选) 展开. 不要先调 5 个工具"
   b. loop 入口把 MAX_REACT_ITERATIONS 临时压到 3
3. 若 intent = 'multi-step-task' (默认): 维持现状
4. 验证: 跑 web 端 simple QA (e.g. "今天日期"), step 数应 ≤ 2

约束:
- 不动 intent-classifier 本身 (它是输入, 你是消费方)
- 改动 ≤ 2 文件 (pi-sdk + test)

输出: 改动文件 + before/after step 数对比.
```

---

## Prompt 5: 监督者心跳 (防止 watchdog 误杀)

**场景**: 后台 tsx 30min 后自杀 (memory: watchdog-kills-no-supervisor). 这是 2026-06-10 临时改的, 治标不治本.

```
任务: 在 src/utils/ 加 watchdog.ts, 替代现在的 process.exit 自杀.

要求:
1. 默认: 30 min 没活动, warn 一次, 不杀
2. 60 min 没活动 + 没 in-flight request, 发 SSE 心跳
3. 90 min 没活动: 真要杀时, 走 process.exit(0) (不是 1, 避免 systemd 重启风暴)
4. 写 ~/.bolloon/watchdog.log 留痕
5. 提供 BOLLOON_DISABLE_WATCHDOG=1 临时禁用

约束:
- 替换 2026-06-10 临时 patch (grep "30 min" 找)
- 改动 ≤ 2 文件 (新增 + 引用点)
- 跑 vitest 验证 90min 模拟 (用 vitest fake timer)

输出: diff + 测试结果 + 验证 30/60/90min 行为正确.
```

---

## 如何喂这些 Prompt

### Web 端
1. 启动: `npm run dev` (port 54188)
2. 浏览器开 `http://localhost:54188`
3. 把上面任一 prompt 复制到聊天框
4. 看 step-timeline 实时反馈
5. agent 跑完会自动 commit (走 auto-evolve-loop 的 5 道护栏)

### CLI 端
```bash
# 单次 (走 /message 端点, 复用 web 后端)
curl -X POST http://localhost:54188/message \
  -H "Content-Type: application/json" \
  -d "$(cat <<'EOF'
{"text": "<上面 prompt 内容>"}
EOF
)"

# 或用 bolloon CLI (若有)
echo "<prompt>" | bolloon chat --no-ui
```

### 自动 (后台循环)
```bash
# 队列化: 写到一个 goal 文件, pi-goals 跑
echo "Prompt 1" >> ~/.bolloon/goals/queue.txt
# 启监督循环
nohup tsx scripts/auto-evolve-loop.ts --max-iter 50 > /tmp/auto-evolve.log 2>&1 &
```

---

## 监督者自检 Checklist (每轮结束跑一次)

- [ ] 上轮 prompt 触发的 commit 是否通过 reviewer? (看 .review-verdict 文件)
- [ ] vitest fail 数是否下降? (对比本轮和上轮)
- [ ] 是否有新 TODO/FIXME 引入? (应避免)
- [ ] 改动文件数 ≤ prompt 中声明的上限?
- [ ] 是否有未测试的新代码?
- [ ] 监督者自己的 prompt 写错了? (若 agent 反复 fallback "没 diff", 改 prompt)

## 退出条件 (任一即停)

- 5 大痛点全部解决 (UI 演示可见)
- 连续 3 轮 agent 无 diff 输出
- 连续 3 轮 reviewer FAIL
- 监督者自己跑 50 轮 (token 预算)
- 用户 Ctrl-C
