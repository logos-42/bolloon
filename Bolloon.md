# Bolloon

> 一个本地优先的 P2P AI 智能体网络。每台机器运行一个 bolloon，自动积累人类判断力，跨机器互联互通。

## 架构总览

```
+------------------- 单台 bolloon 进程 -------------------+
|                                                        |
|  Web Server (port 54188) ← 用户聊天 / 配置 / 调试     |
|       ↓                                                |
|  Pi Agent (LLM 推理, 注入门, 监控门)                 |
|       ↓                                                |
|  Judgment System (判断力库 + 类 B 自适应)              |
|       ↓                                                |
|  P2P Network (跨机器互联, v3 + P2PDirect 双轨)         |
|                                                        |
+--------------------------------------------------------+
              ↕ P2P (跨机器, 端到端加密)
       [其它 bolloon 节点]
```

**核心循环**：人类聊天 → 注入门检索相关判断力 → LLM 推理 → AI 回复 → 监控门审计 → 行为记录到 usage.jsonl → 类 B 自适应扫描 → 演化日志。

## 目录结构

| 路径 | 职责 |
|---|---|
| `src/agents/pi-sdk.ts` | PiAgent 主类 / ReAct 循环 / 工具注册 / SessionStart/Stop/PreToolUse hook 接入点 |
| `src/agents/permission-mode.ts` | **本轮新增** — 3 种 permission mode (default/acceptEdits/bypassPermissions) + 解析 |
| `src/agents/pre-tool-validator.ts` | **本轮新增** — PreToolUse 4 步链式校验 (modeGate/blacklist/shell-guard/schema) |
| `src/pi-ecosystem-judgment/` | **判断力系统核心**：注入门 / 蒸馏 / 演化 / 自适应扫描 / 监控门 |
| `src/context-compaction/` | **本轮新增** — 5 层上下文压缩流水线 (Budget Reduction / Snip / Microcompact / Context Collapse / Auto-Compact) |
| `src/bootstrap/context-hierarchy.ts` | **本轮新增** — Bolloon.md 4 级层次 (Managed / User / Project / Local) |
| `src/web/server.ts` | Web server 主入口 (port 54188), 所有 REST API |
| `src/web/client.ts` | 前端 (timeline panel, 反向引用链接, 自适应 tab) |
| `src/network/` | P2P 网络层 (iroh-bootstrap, p2p-direct) |
| `src/constraint-runtime/` | Workflow / 技能注册 / 会话持久化 |
| `src/social/` | 全局共享上下文 / 智能体心跳 / 协作任务 |
| `src/bootstrap/` | 启动上下文收集 / SessionStart/Stop/cron 入口 |
| `~/.bolloon/` | 用户数据目录 (本机资产, 不进 git) |

## 关键设计意图

### 判断力库 = 本机资产 (跨机器不同步)

每台 bolloon 维护自己的判断力库 `~/.bolloon/human-values/judgments.json`。
**不**通过 P2P 广播 / 同步——这是原则。判断力沉淀人类偏好，是私有的。
跨机器共享只通过 P2P RPC 临时调用，**判断力本身不流出去**。

### 注入门 vs D 触发 vs 监控门 (3 道独立门)

| 门 | 触发时机 | 行为 | 写什么 |
|---|---|---|---|
| 注入门 (P0) | 每次 LLM chat 之前 | 检索相关判断力拼到 system prompt | `usage.jsonl` |
| D 触发 (D 路径) | AI 回复后 5min 节流 + async | 自动捕获新判断力 (蒸馏对话) | `judgments.json` |
| 监控门 (P3) | AI 回复后 fire-and-forget | 审计 AI 是否违反已注入原则 | `violations.jsonl` |

3 道门都**静默失败**——任何 1 道挂掉不影响主对话。

### 类 B 自适应扫描"只读不写"

每天 0:00 定时跑 `runAdaptiveScan()`，扫 `usage.jsonl` + `judgments.json`，
输出建议 (rising / stale / unused)，**不**自动改库。
用户在 UI "📊 自适应" tab 接受/拒绝，所有动作写 `evolution.jsonl` 留痕。
**可逆**是核心设计——AI 不能"自己改自己"。

### 反向引用链接 + timeline panel

AI 回复下方挂极简 `📎 参考 N 条原则` 链接（不展开内嵌）。
整个运行过程显示在 `loop-timeline-panel`（Claude Code 风格），按时间追加 phase / token / tool 事件。

## 运行约定

| 命令 | 用途 |
|---|---|
| `npm run dev` | 启动 web server (http://localhost:54188) |
| `npm run start` | 同上但生产模式 |
| `npm test` | 跑 vitest |
| `npm run typecheck` | tsc --noEmit |

数据存 `~/.bolloon/`：
- `human-values/judgments.json` — 判断力库
- `human-values/usage.jsonl` — 注入门使用记录
- `human-values/violations.jsonl` — 监控门违规记录
- `human-values/evolution.jsonl` — 类 B 自适应演化日志
- `persona.json` — 用户身份
- `sessions/<channel>/` — 每个 channel 的会话持久化
- `skills/` — 用户级 skills (与 .bolloon/skills/ 项目级并存)

## 开发约定 (不要随意改)

1. **v3 P2P + P2PDirect 双轨**——v3 是新协议，P2PDirect 是 fallback。两套都活着
2. **判断力库是本机资产**——绝对不同步、不广播
3. **类 B 不自动改库**——所有 AI 自动调整走 UI 接受 + evolution.jsonl 留痕
4. **任何 hook 静默失败**——主对话不能因为 hook 挂掉而卡住
5. **新模块加到 `src/pi-ecosystem-judgment/`**——这是判断力系统的归宿，别散落
6. **前端 DOM 改完要 dist/web 重新构建**（如果有 build step）

## 已知边界

- **类 B 自适应**每天 0:00 跑 1 次，重启 bolloon 期间不补跑
- **Context 缓存 24h**——中途改 Bolloon.md / persona / git commit 后, 重启才生效
- **PreToolUse 4 步链已接** — `onPreToolUse` 串接 modeGate + blacklist + shell-guard + schema;
  shell 工具永远走 shell-guard, bypassPermissions 仍受路径黑名单约束
- **5 层压缩**: 同步层 (Budget Reduction / Snip / Microcompact) 在 `buildContext` 跑;
  异步层 (Context Collapse / Auto-Compact) feature flag 默认关闭, 后续接 LLM 后启用
- **Bolloon.md 4 级层次** — 同时识别 Managed / User / Project / Local, 兼容旧 Bolloon.md;
  按 `managed → user → project → local` 顺序拼接到 system prompt, 截断优先保 managed
- **Stop hook 写 session 摘要**——不重复写完整 session 持久化（已存在）
- **跨 channel Context**——目前不分 channel, 单 channel 维度
- **embedding 检索**——上轮做了软相似度 (bigram) 兜底, 真 embedding 等 5k+ 条库再做

## 3 个吸收自 Claude Code 的子系统 (本轮新增)

### 5 层上下文压缩 (src/context-compaction/)
严格对齐论文 5 个 shaper, 由便宜到重:
1. **Budget Reduction** (总是跑) — 截断 > 4000 字符的单条消息
2. **Snip** (`BOLLOON_SNIP_ENABLED=1` 开启) — 裁掉老 history, 保留最近 20 对
3. **Microcompact** (总是跑) — 折叠老 tool_result, 保留最近 3 条完整
4. **Context Collapse** (`BOLLOON_CONTEXT_COLLAPSE=1` 开启) — 读时虚拟投影, 折叠前 5 对
5. **Auto-Compact** (兜底) — LLM 摘要, 缓存到 `~/.bolloon/sessions/compaction-cache/`

**关键不变量**: 第 1-3 层不破坏 messageHistory 内存结构, 第 4 层读时投影, 第 5 层破坏性.

### Bolloon.md 4 级层次 (src/bootstrap/context-hierarchy.ts)
| 优先级 | 路径 | 用途 |
|---|---|---|
| 1 | `/etc/bolloon/Bolloon.md` | Managed (企业 IT 部署预留) |
| 2 | `~/.bolloon/Bolloon.md` | User (用户级, 跨项目) |
| 3 | `<cwd>/Bolloon.md` (兼容 Bolloon.md / `.claude/rules/*.md`) | Project (项目级) |
| 4 | `<cwd>/CLAUDE.local.md` | Local (个人覆盖, .gitignore) |

按 `managed → user → project → local` 顺序拼接到 system prompt 顶部, 截断时反向砍,
**优先保 managed** (bolloon 自身约束).

### PreToolUse + 权限模式 (src/agents/permission-mode.ts + pre-tool-validator.ts)
3 种 mode: `default` (默认) / `acceptEdits` (跳过 edit_* 黑名单) / `bypassPermissions` (跳过非 shell 黑名单).

4 步链: `modeGate → blacklistGate (6 模式危险命令) → shellGuardGate (路径黑名单) → schemaGate (stub)`.

**关键约束**: shell 工具永远走 shell-guard, bypassPermissions 仍受 `.bolloon/` / `pi-sdk.ts` / `shell-guard.ts` / `.env` 路径黑名单保护.

环境变量: `BOLLOON_PERM_MODE=default|acceptEdits|bypassPermissions` (运行时切换).

---
title: Bolloon.md 4 级模板 (双栖 agent 网络对外协作偏好)
source: session
created: 2026-07-10
last_confirmed: 2026-07-10
schema_version: 2
audience: self
stage: current
tags: [bolloon-md, configuration, p2p, dual-habitat, agent-network]
---

# Bolloon.md 4 级模板 — 双栖 agent 网络配置

> **2026-07-10 改造**: bolloon 变成双栖 agent 网络, Bolloon.md 的 4 级层次 (`context-hierarchy.ts`)
> 不再只放"项目规则", 还要放"对外协作偏好". 本模板覆盖 user/project/local 3 级的推荐内容.

## 4 级路径速查

| 级别 | 路径 | 谁写 | 影响 |
|---|---|---|---|
| Managed | `/etc/bolloon/Bolloon.md` | 企业 IT 部署 | 不可覆盖, 系统约束 |
| User | `~/.bolloon/Bolloon.md` | 用户, 跨项目 | 本机默认协作规则 |
| Project | `<cwd>/Bolloon.md` 或 `.claude/rules/*.md` | 仓库 commit | 本项目特殊规则 |
| Local | `<cwd>/CLAUDE.local.md` | 用户本地覆盖 (gitignore) | 个人 override |

**4 级合并顺序** (context-hierarchy.ts:199-230): managed → user → project → local.
截断时反向砍 (local → project → user → managed), 优先保 managed.

---

## User 级模板 (`~/.bolloon/Bolloon.md`)

放"本机默认偏好":

```markdown
## 我的 bolloon 协作规则

## 信任的对端节点
- did:key:z6Mk...  (工作机 A — 永远信任, 任何任务都可推)
- did:key:z6Mk...  (家用机 — 只推非敏感任务, 不接受推送的 judgment)

## 哪些任务可外包
- 文档处理 / 总结 / 改写 → 可推到对端 (默认走 peer-sync)
- 代码执行 / 部署 → 必须在本地
- 涉及 judgment 库 / 隐私 → 不外包, 不接收对端推送的

## 双工 chat 规则
- 用户离开 > 30min, 后台 agent 可以响应 peer 消息, 但不主动给对端发
- 用户回来时, 在 UI 显示 "📥 你离开时 X 节点帮你推进了 N 步"
- 用户禁止任务 (judgments 带 `disabled: true`) → 后台 agent 跳过

## target_id 命名约定
- 用动词开头: "完成 X" / "实现 Y" / "修复 Z"
- 包含业务域: "完成财务模块迁移" 比 "迁移" 稳定
- 不超过 30 字
```

## Project 级模板 (`<cwd>/Bolloon.md`)

放"本项目协作规则", 提交到 git 让团队共享:

```markdown
## <项目名> 的 bolloon 协作规则

## 项目内允许的 P2P 行为
- 本项目 agent 可接受 "前端 / 后端" 类任务的外包
- 本项目 agent 不接受涉及数据库密码 / 私钥 的推送
- 本项目 agent 自动同步到组织内节点 (见 user 级 Bolloon.md 的"信任"列表)

## 项目术语
- "feature flag" = ...
- "deploy channel" = staging / canary / prod
- 团队常问的主题: ...

## 项目层 target_id 命名
- 统一前缀: "<项目代码>-<任务类型>-<月份>"
- e.g. "BLOON-migration-2026-07", "BLOON-bugfix-2026-07"
```

## Local 级模板 (`<cwd>/CLAUDE.local.md`, gitignore)

放"个人 override, 不让团队看到":

```markdown
## 个人 override — 不 commit

## 我不在时不要做的事
- 不要发 broadcast_message (浪费对端 token)
- 不要主动 habit-distill (等我手动)
- 接 push 任务前先 list_peers 查对方 expertise

## 我会手动调用的 skill
- habit-distill (每次完成任务后我手动跑)
- target-tracker (切 channel 前手动查)
```

---

## Managed 级模板 (`/etc/bolloon/Bolloon.md`, 企业部署)

放"组织级硬约束, LLM 必须遵守":

```markdown
## 组织硬约束 (IT 部署, 不可覆盖)

## 强制安全规则
- 所有 P2P 推送必须经过 channel.p2p-proactive layer (不允许绕过)
- 任何写 judgment 库的操作必须含 source 标签 (审计)
- 跨项目 park/resume 必须写 hook (goal-parked.jsonl / goal-resumed.jsonl)

## 强制路由规则
- 任务 > 5min LLM 推理 → 必须推到组织内有"heavy-compute" expertise 的节点
- 任务 < 30s → 本机直接做, 不推
- 涉及合规的 (法律 / 医疗 / 财务) → 本机做, 不推
```

---

## 验证生效

1. 写完 4 级文件后, 在本机跑 `bolloon doctor` 或重启服务
2. 打开 web UI, 问"我的对外协作偏好是什么" → LLM 应念出 user 级的"信任对端"
3. 切到一个新项目, 问同样问题 → LLM 应答 project 级的术语
4. 改 local 级的"我不发 broadcast" → 立刻生效 (重启 LLM session 即可)

参考: `src/bootstrap/context-hierarchy.ts` (4 级查找 + 合并逻辑),
`src/llm/system-prompt/registry.ts:80-106` (frontmatter 治理).
