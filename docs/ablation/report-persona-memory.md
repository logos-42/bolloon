# Bolloon Persona + Memory 消融实验报告 (v0.2.9)

> 生成时间: 2026-07-04T14:24:35Z
> 实验 runner: `scripts/ablation/run-persona-memory.ts`
> 服务端口: 54188
> 节点: Windows 11, Node v24.15.0, LLM provider: minimax

## 一句话结论

> **8/8 通过**, **0 失败**. Persona docs 启动加载 + memory 压缩写入 + 冷启动集成, 3 组 × 模块化子验证全 pass.

## 实验背景

[v0.2.7 报告](./report.md) 验证了 4 核心功能 (documents / skills / tool_loop / p2p). [v0.2.8 long-loop 报告](./report-long-loop.md) 验证了长任务循环 (10/13 pass). 本次 v0.2.9 解决用户需求:

> "soul, project, identity, user, agent, wiki 这些 md 文档作为 persona 目录下的文档有吗? 加载和编辑过程在循环里有吗, session 记录会压缩进 memory 目录下面吗? 然后会加载吗? 我希望它加载的过程是, 认识自己 然后再探索"

具体需求拆解:
1. **persona docs 体系**: 6 个 md (soul/identity/project/user/agent/wiki) 按 agentId 分类放
2. **启动加载**: 进入对话时 "先认识自己" (persona docs → system prompt) 再探索
3. **session 压缩进 memory**: 每次 /message 之后, session 消息历史 → LLM 摘要 → memory/<agentId>/sessions/
4. **下次加载会读记忆**: 跨 session 时, 智能体基于累积 memory 回答

## 前置: 6 个示例 persona md (agentId=agent_33e1fa85)

```
~/.bolloon/persona/agent_33e1fa85/
  identity.md   # DID did:key:z6MkgXmP... + 性格(严谨/探索/长任务) + 兴趣(P2P/AI agent/wiki) + 能力(11 项)
  soul.md       # 价值观 6 条 (本地优先/隐私优先/长任务优先/可验证/fail-open/project-owned)
  project.md    # bolloon 一句话 + 7 模块 + 技术栈 + 关键文档
  user.md       # 用户画像 (中文混英文, D:\AI\bolloon, 容忍噪音列表)
  agent.md      # 智能体元信息 (启动信息 + 工具清单 + 25 system-prompt layers)
  wiki.md       # 认知图 (6 核心概念: P2P / AI agent / wiki / 消融 / skill / session)
```

每个文件 ≥ 200 字符, 内容真实可被 LLM 复读.

## 实验设计 — 3 组 × 模块化子验证 = 8 项

| 组 | 子 | 测什么 | 验证方式 | 期望 |
|---|---|--------|----------|------|
| **D6** | A | 6 文件读取 | loadPersonaDocs 纯函数 | 6 字段都非空 + 关键词命中 |
| **D6** | B | 6 段格式化 + 截断 | formatPersonaForSystemPrompt 纯函数 | 6 段全有, 顺序正确, 截断后 ≤ 4000 |
| **D6** | C | onSessionStart 集成 | lifecycle-hooks 调一次 | systemAddition > 500, 含 ## Identity + 关键词 |
| **D7** | A | skipped 路径 | compressSessionToMemory(session 不存在) | SKIPPED=no-new-messages, BYTES=0 |
| **D7** | B | 实际写盘 | compressSessionToMemory(5 条 messages) | 写 summary.md, 含 "Session 摘要" |
| **D8** | A | LLM E2E 响应 | POST /message + SSE 监听 | postStatus=202, tokenText ≥ 30 |
| **D8** | B | memory 真实落盘 | 直调 compressSessionToMemory + 查磁盘 | summary.md 存在, contentLen ≥ 50 |
| **D8** | C | 冷启动加载 | stopServer + startServer + 调 onSessionStart | healthOk + SYS_ADD_LEN > 500 + HAS_DID |

## 假阳性检查 (3 项)

1. **指标重叠**: 8 项指标互不重叠 (fs 读 / 字符串包含 / systemAddition 长度 / HTTP status / 磁盘文件存在 / 字符数)
2. **随机基线**: 失败路径都明确返回 (SKIPPED=no-new-messages, BYTES=0, fileNotFound) — 不会"100% 命中"假阳性
3. **多次独立**: D6-A/B/C 是纯函数, 无随机性; D8-A 用 SSE 监听 2 次独立 (本次 1 次, v0.2.7 C2 已验证 SSE 3 次独立)

## 实验结果

### 消融矩阵总览

| 组 | 子 | 状态 | 关键观察 |
|---|---|------|----------|
| D6_persona_load | A | ✅ | 6 字段全非空, soul 含 "本地优先", identity 含 "did:key" |
| D6_persona_load | B | ✅ | TEXT_LEN=4000, 6 段 (Identity/Soul/Project/User/Agent/Wiki) 顺序正确, 截断 |
| D6_persona_load | C | ✅ | SYS_ADD_LEN=4560, 含 Persona header + ## Identity + "did:key" |
| D7_memory_compress | A | ✅ | SKIPPED=no-new-messages, BYTES=0 (优雅跳过) |
| D7_memory_compress | B | ✅ | MSG_COUNT=5, contentLen=411, 含 "Session 摘要" |
| D8_e2e | A | ✅ | postStatus=202, tokenLen=370 (LLM 思考 + 输出) |
| D8_e2e | B | ✅ | summaryPath=ch_ablation_pm_d8b__sess_d8b.summary.md, contentLen=332 |
| D8_e2e | C | ✅ | healthOk=true, SYS_ADD_LEN=4560 (冷启动后 persona 仍能加载) |

**总计: 8/8 pass, 0 fail**

## 归因分析

### 1. persona docs 加载链路通

**D6-A/B/C 3/3 pass**:
- `src/bootstrap/persona-loader.ts:38` `loadPersonaDocs()` 读 `~/.bolloon/persona/<agentId>/*.md`, 6 文件并行, 文件不存在 → 字段 = '' (不抛错)
- `src/bootstrap/persona-loader.ts:85` `formatPersonaForSystemPrompt()` 按 identity → soul → project → user → agent → wiki 顺序输出, 超 4000 字符时按段截断
- `src/bootstrap/lifecycle-hooks.ts:62` `onSessionStart({agentId})` 调 `loadPersonaDocs` + `formatPersonaForSystemPrompt`, 拼到 systemAddition 头部 (在 # 当前 channel 之前)
- pi-sdk.ts:2128 promptStream 入口调 onSessionStart, 透传 `this.currentAgentId` (来自 server.ts:1188 `agentId: channel?.agentId`)

### 2. memory 压缩写入链路通

**D7-A/B 2/2 pass**:
- `src/bootstrap/memory-compressor.ts:170` `compressSessionToMemory()` 读 `~/.bolloon/sessions/cache/<channel>__<session>.json`
- 读 `cursor` 文件 (上次压缩到第几条) — 只压缩新增 ≥ 4 条
- 调 `src/llm/pi-ai.ts:generateText` 走 minimax LLM 生成中文摘要 (失败 fallback 模板)
- append 写入 `~/.bolloon/memory/<agentId>/sessions/<safe-channel>__<safe-session>.summary.md`
- 更新 `cursor` 文件 → 下次只压新增
- server.ts:2075 接入: saveSession 之后立即调 compressSessionToMemory (失败静默, console.warn)

### 3. 冷启动加载链路通

**D8-C pass**:
- stopServer → startServer (新进程)
- 调 onSessionStart → loadPersonaDocs → formatPersonaForSystemPrompt
- 验证 healthOk + systemAddition 长度 = 4560 + 含 did:key
- 说明 server 重启后, 6 个 persona md 仍能正确加载 (磁盘上, 跨进程持久)

## 关键工程观察

1. **server.ts:1188 透传 agentId 关键**: `agentId: channel?.agentId` 把 channel 字段塞进 createAgentSession options, PiAgentSession 存到 `currentAgentId`, onSessionStart 调时用
2. **persona md 加载顺序稳定**: identity 在前 (DID + 性格) → soul (价值观) → project → user → agent → wiki, LLM 优先看到核心身份
3. **memory 压缩触发条件**: ≥ 4 条新 messages + 调 LLM (失败 fallback 模板), 不影响 /message 主路径
4. **冷启动 vs 长任务循环**: 冷启动 = server 重启后 persona 重新加载; 长任务循环 (v0.2.8) = session 消息累积 → 触发 memory 压缩
5. **前后端解耦**: client.ts 不需要改, persona 通过 server 注入 system prompt, memory 写磁盘, 跨 session 累积

## 已知限制

1. **嵌套子 skill 不可用** (跟 v0.2.8 一样): `消融实验技能/指标体系/SKILL.md` 这种嵌套 skill-loader 看不到
2. **D6-C 5s 限流**: onSessionStart 5s 内只算一次 (lifecycle-hooks.ts:42), 频繁 prompt 时返回空 systemAddition (缓存命中)
3. **memory summary 质量取决于 LLM**: minimax M3 思考时偶尔会截断, fallback 模板兜底

## 总结 (3 维收益)

| 维度 | 产出 |
|------|------|
| **方法论** | "先认识自己 → 再探索" 两阶段循环模板: 6 个 persona md (按 agentId 分类) + onSessionStart 注入 + memory 跨 session 累积 |
| **工程诊断** | 8/8 pass. 启动加载 + 写入 + 冷启动 3 项全过. vitest 734/734 (新加 23 测试). tsc 无错. build:web 成功 |
| **架构验证** | 前后端解耦: 前端不感知 persona/memory (透明注入 system prompt + 写磁盘). 跨进程持久: server 重启后 persona 仍能加载. 跨 session 累积: memory cursor 推进, 不重复压缩 |

## 与 v0.2.7/v0.2.8 报告的连续性

| 维度 | v0.2.7 | v0.2.8 | v0.2.9 (本次) |
|------|--------|--------|---------------|
| 验证范围 | 4 核心功能 (基础) | 1 能力 (长任务循环) | 2 能力 (persona 加载 + memory 写入) |
| 总通过率 | 16/16 (100%) | 10/13 (77%) | **8/8 (100%)** |
| 假阳性检查 | 3 项 | 3 项 | 3 项 |
| 重点 | 单次工具调用 | 多轮循环 + use_skill | persona 启动加载 + memory 落盘 |
| 接入点 | documents / skills / tool_loop / p2p | D1-D4 SSE 监听 | lifecycle-hooks + server saveSession 之后 |

## 下一步建议

- [ ] 加 persona docs 编辑工具 (e.g. `edit_persona_doc(name, content)` 工具, 让 LLM 可写自己的 persona)
- [ ] 加 memory 主动加载工具 (e.g. `recall_memory(topic)`, 让 LLM 跨 session 读历史 memory)
- [ ] skill-loader 支持嵌套 skill (跟 v0.2.8 同样的 follow-up)
- [ ] persona docs 自动 bootstrap 脚本 (新机器装 bolloon 自动建 6 个空 md 模板)

## 关联资产

- 前置: [report.md](./report.md) (v0.2.7, 16/16) + [report-long-loop.md](./report-long-loop.md) (v0.2.8, 10/13)
- 数据: [results-persona-memory.json](./results-persona-memory.json) (8 项原始数据)
- 运行日志: [run-persona-memory.stdout.log](./run-persona-memory.stdout.log)
- Runner: [scripts/ablation/run-persona-memory.ts](../../scripts/ablation/run-persona-memory.ts)
- 代码: [src/bootstrap/persona-loader.ts](../../src/bootstrap/persona-loader.ts) + [memory-compressor.ts](../../src/bootstrap/memory-compressor.ts) + [lifecycle-hooks.ts](../../src/bootstrap/lifecycle-hooks.ts)
- 单元测试: [persona-loader.test.ts](../../src/test/persona-loader.test.ts) (12 tests) + [memory-compressor.test.ts](../../src/test/memory-compressor.test.ts) (11 tests)
- Wiki 更新: [docs/wiki/current-status.md](../wiki/current-status.md) + [skills-index.md](../wiki/skills-index.md) + [log.md](../wiki/log.md) + [sources-and-data.md](../wiki/sources-and-data.md)