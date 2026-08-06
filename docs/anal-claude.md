下面是我对 Claude Code 架构的整体理解。

---

## 1. 最反直觉的结论: 1.6% vs 98.4%

整个 Claude Code 里只有 **1.6% 是真正的 AI 决策逻辑**,剩下的 **98.4% 都是确定性基础设施** —— 权限门、上下文管理、工具路由、恢复逻辑。

外行以为 Claude Code 强大靠"模型"和"prompt";作者的核心论点是: **真正难的部分是模型周围那一圈 harness**。Agent 循环本身就是一个 while 循环;复杂的是这个循环之外的所有系统。

---

## 2. 四个必须回答的设计问题

|问题|Claude Code 的选择|对比|
|---|---|---|
|推理放在哪?|模型推理 + 框架强制|LangGraph 用显式状态图|
|几个执行引擎?|**一个** `queryLoop`, CLI/SDK/IDE 全部走它|一些系统按 surface 分多个引擎|
|默认安全姿态?|**deny-first**: deny > ask > allow,最严的规则赢|SWE-Agent 用容器隔离|
|绑定资源约束?|~200K token 上下文窗口;**每次模型调用前 5 层压缩**||

---

## 3. 7 个组件 / 5 层分解

```
User
  → Interfaces (CLI / SDK / IDE / Desktop / Browser)
    → Agent Loop (queryLoop - 唯一的 async generator)
      → Permission System (7层防御)
        → Tools (最多54个内置 + MCP)
          → State & Persistence (append-only JSONL)
            → Execution Environment (shell sandbox, MCP, fs)
```

**5 个子系统层**:

- **Surface**: 入口和渲染
- **Core**: 上下文装配 + agent loop
- **Safety/Action**: 权限 + 工具
- **State**: 运行时状态 + 持久化
- **Backend**: shell、MCP、文件系统

---

## 4. Agent Loop: 一个 while 循环包了一堆基础设施

核心是 `queryLoop` (在 `query.ts` 里),实现成一个 `AsyncGenerator` 持续 `yield` 流式事件。

**每个 turn 走 9 步管道**:

```
1. Settings 解析
2. State 初始化
3. Context 装配
4. 5 个 pre-model 压缩器(由轻到重)
5. Model call
6. Tool dispatch
7. Permission gate
8. Tool execution
9. Stop condition 检查
```

**5 个上下文压缩 shaper(每次模型调用前顺序执行,最便宜的先跑)**:

|阶段|做什么|触发|
|---|---|---|
|Budget Reduction|单条消息大小限制|总是|
|Snip|裁掉老历史|feature flag|
|Microcompact|cache-aware 细粒度压缩|总是|
|Context Collapse|读时虚拟投影(非破坏)|feature flag|
|Auto-Compact|模型生成完整摘要(最后手段)|兜底|

**5 个停止条件**: 无 tool_use / 达到 max turns / context overflow / hook 介入 / 显式 abort。

**两个执行路径**:

- `StreamingToolExecutor`: 模型还在 stream 时就开始跑 tool(延迟优化)
- fallback `runTools`: 区分可并发与互斥 tool

**恢复机制**: max output token 升级(3次重试)、reactive compaction(每 turn 最多一次)、prompt-too-long 处理、流式回退、fallback model。

---

## 5. 7 层安全防御(Defense in Depth)

任何请求必须穿过所有适用层,任一层都能 block:

1. **Tool pre-filter** — 被 deny 的 tool 直接从模型视野里删掉
2. **Deny-first 规则评估** — 宽泛的 deny 永远覆盖精确的 allow
3. **Permission mode 约束** — 7 种模式: `plan` → `default` → `acceptEdits` → `auto`(ML 分类器) → `dontAsk` → `bypassPermissions` + 内部 `bubble`
4. **Auto-mode ML 分类器** (`yoloClassifier.ts`) — 独立 LLM 调用,内部/外部两套权限模板,两阶段(fast-filter + CoT)
5. **Shell 沙箱** — 文件系统 + 网络隔离
6. **Resume 时不恢复权限** — 信任必须每 session 重建
7. **Hook 拦截** — PreToolUse hook 可以改/拒绝

**关键洞察(也是弱点)**: 防御纵深只在各层**故障模式独立**时有效。Claude Code 的各层共享 token 预算这个经济约束,导致 >50 个子命令的命令**完全绕过安全分析**(否则会卡死 REPL)。这是共享失败模式导致纵深退化的典型例子。

**另外 2 个 CVE** 揭示了一个"pre-trust 窗口": hook 和 MCP server 在信任对话框弹出**之前**就已经执行了 —— 存在一个结构上特权的攻击窗口在 deny-first 管道之外。

---

## 6. 4 个扩展机制(按 context 成本梯度)

|机制|Context 成本|能力|
|---|---|---|
|Hooks|**零**|27 个事件,4 种执行方式(shell / LLM 评估 / webhook / subagent 验证)|
|Skills|低|`SKILL.md`,15+ YAML 字段,通过 SkillTool meta-tool 注入|
|Plugins|中|10 种组件类型(commands, agents, skills, hooks, MCP, LSP, styles...)|
|MCP Servers|高|7 种传输方式(stdio, SSE, HTTP, WS, SDK, IDE)|

**核心洞察**: 不是所有扩展都要消耗 context token。Hook 是零成本的;Skills 只在相关时注入;MCP 留给真正的新 tool surface。

**3 个注入点**(每个 agent loop 都有这三个):

- `assemble()` — 模型**看到**什么(CLAUDE.md、skill 描述、MCP 资源、hook 注入的 context)
- `model()` — 模型**能调用**什么(内置工具、MCP 工具、SkillTool、AgentTool)
- `execute()` — 动作**怎么跑**(权限规则、PreToolUse/PostToolUse hook、Stop hook)

**工具池装配(5 步)**: 基础枚举(最多 54)→ mode 过滤 → deny 预过滤 → MCP 集成 → 去重。

---

## 7. 上下文与记忆

**9 个有序的 context 来源**: system prompt → env → CLAUDE.md 层级 → 路径作用域规则 → auto-memory → tool metadata → 对话历史 → tool 结果 → 压缩摘要。

**CLAUDE.md 4 级层次**:

|级别|路径|范围|
|---|---|---|
|Managed|`/etc/claude-code/CLAUDE.md`|系统级(企业)|
|User|`~/.claude/CLAUDE.md`|用户级|
|Project|`CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/*.md`|项目级|
|Local|`CLAUDE.local.md`|个人(.gitignore)|

**关键设计选择**: CLAUDE.md 是**用户 context**(概率性遵守),**不是** system prompt(确定性)。确定性强制由权限规则提供。**这意味着 prompt injection 可以欺骗模型去读 CLAUDE.md 的指令,但无法绕过权限层**。

**记忆**: 不用 embedding,不用向量库。LLM 扫描 memory 文件头,按需选最多 5 个相关文件。**完全可检视、可编辑、可版本控制**。

---

## 8. Subagent 委派

**6 个内置类型** + 自定义 (`.claude/agents/*.md`): Explore, Plan, General-purpose, Claude Code Guide, Verification, Statusline-setup。

**核心设计: SkillTool vs AgentTool**:

- **SkillTool**: 把指令注入**当前 context**(便宜,共享窗口)
- **AgentTool**: 启动**隔离的 context 窗口**(贵,~7x token,但防止 context 爆炸)

**3 种隔离模式**:

- worktree (git worktree 文件系统隔离)
- remote (远程执行)
- in-process (共享 fs, 隔离对话,默认)

**Sidechain transcripts**: 每个 subagent 写自己的 `.jsonl`,**只有 summary 回给父级**,完整历史从不进入父级 context。多实例协调用 POSIX `flock()` —— 零外部依赖。

**权限覆盖**: 子 agent 的 `permissionMode` 生效,**除非**父级在 `bypassPermissions` / `acceptEdits` / `auto`(用户的显式决策永远优先)。

---

## 9. Session 持久化

**3 个通道**:

- 会话 transcript: append-only JSONL,带 chain-patch 压缩边界
- 全局 prompt 历史: `history.jsonl`,跨 session 提示回忆
- 子 agent sidechain: 每个子 agent 独立的 JSONL

**Chain patching**: 压缩边界记录 `headUuid` / `anchorUuid` / `tailUuid`,session loader 读时打补丁。磁盘上**没有破坏性编辑**。

**安全**: **resume 时从不恢复权限**。信任必须每 session 重建。

**设计取舍**: append-only JSONL 选了**可审计性和简洁性**,不选查询能力。每个事件人类可读、可版本控制、不需要专门工具就能重建。

---

## 10. 三个反复出现的元模式

1. **分层胜过一锅烩** — 安全、上下文、可扩展性都用了多级独立阶段,不是单一方案
2. **append-only 优先可审计** — 一切可重建,绝不破坏性编辑
3. **确定性 harness + 模型自由判断** — 模型自由决定,harness 强制边界。1.6%/98.4% 的比例不是偶然

---

## 11. 给我个人的提炼(给你读到这里用)

如果让我用一句话总结:"**Claude Code 的核心不是 prompt engineering,而是 harness engineering**。"

具体来说,做 agent 系统时真正要花心思的是:

1. **上下文管理** —— 它是瓶颈,所有其他决策围着它转。Claude Code 用 5 层渐进压缩,关键是**先做最便宜的,实在不行再上模型总结**
2. **deny-first 权限** —— 7 层防御纵深,但要小心各层不能共享失败模式(否则纵深失效)
3. **可审计优先于可查询** —— append-only JSONL 比数据库笨,但你不会后悔
4. **子 agent 隔离 context** —— 别让子 agent 把父级的 context 撑爆,只回 summary
5. **扩展按 context 成本分层** —— 零成本的 hook、低成本的 skill、高成本的 MCP,各用各的
6. **trust 永远不跨 session 持久化** —— resume 重新建立信任

仓库里 `docs/build-your-own-agent.md` 总结的 6 个决策(推理位置、安全姿态、上下文管理、扩展性、子 agent、session 持久化)就是这套架构的核心决策空间;`docs/architecture.md` 是 7 层分解 + 5 层 subsystem 的具体实现细节。`paper/Dive_into_Claude_Code.pdf` 是论文原文。

需要我深入讲哪一块?(比如具体的 5 层压缩怎么实现、subagent 的具体协议、权限 4 阶段管线的具体分支、或者和 OpenClaw / Hermes-Agent 的对比?)