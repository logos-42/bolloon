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
