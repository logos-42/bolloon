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
