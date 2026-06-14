# Bolloon.md — bollharness

bollharness 是一个 **AI Agent Session 治理框架**——通过 Claude Code hooks、guards、上下文路由和安装器，给任意项目加装结构化的 agent 行为约束。

## 架构

```
bollharness/
├── .boll/
│   ├── settings.json        # Hook 注册表（16 hooks，7 stages）
│   ├── rules/               # Path-scoped rules（Claude Code 按文件路径自动加载）
│   └── skills/              # Skill 定义（harness-dev-handoff, guardian-fixer 等）
├── scripts/
│   ├── hooks/               # 14 个 hook 脚本（session lifecycle + tool guards）
│   ├── guard-feedback.ts    # PostToolUse 入口 — 上下文路由（机制 A）+ guard 检查（机制 B）
│   ├── deploy-guard.ts      # PreToolUse Bash 入口 — 部署安全拦截
│   ├── context_router.ts    # 文件路径 → 上下文片段路由表（ADR-030 §3.4.1）
│   ├── guard_router.ts      # 文件路径 → guard 脚本映射（ADR-030 §3.3）
│   ├── context-fragments/   # 17 个上下文片段（guard-feedback.ts 注入用）
│   ├── checks/              # Guard 脚本（check_*.ts）
│   ├── install/             # 安装器（phase2_auto.ts + trust token）
│   └── lib/                 # 共享库
├── templates/scaffold/      # 目标项目骨架模板（安装时复制）
├── schemas/                 # YAML/JSON schema 定义
├── docs/decisions/          # ADR-030, ADR-038, ADR-041
└── .boll/MANIFEST.yaml  # 物理清单（版本 + 文件注册表）
```


**同步覆盖范围**：
- Step 1: `scripts/hooks/*`（跳过 boll-only 的 `find-boll-root.sh`）
- Step 2: 路径修补（`find-boll-root.sh` → `find-project-root.sh`）
- Step 3: settings.json hook 注册对比
- Step 4: 共享脚本（guard-feedback.ts, deploy-guard.ts, context_router.ts, guard_router.ts）
- Step 5: context-fragments/ 目录

## 开发约束

### 必须遵守
- 所有命令使用 `npx ts-node`
- Commit message 中英双语 + `Co-Authored-By: Claude Opus 4.6`
- 审查类 subagent 必须用 opus 模型，不降级 sonnet
- 审查类 agent 工具白名单必须 schema-level 隔离写权限（ADR-038 D11）
- Guardian issue 必须先建 `docs/issues/*.md` 再写代码

### 安装器开发
- `phase2_auto.ts` 所有函数必须**幂等**（重复运行不改变结果）
- Trust token 使用 HMAC + 30min 滑动窗口 + 6h 绝对窗口
- 安装步骤顺序不可打乱（trust → bundle → scaffold → gitignore → paths → hooks）

### Hook 开发
- Hook 必须 fail-open（`|| true`）或有明确的 fail-closed 理由
- Hook timeout 不超过 30s（guard-feedback.ts 最大）
- 新增 hook 后必须同时更新 settings.json 注册和 MANIFEST.yaml

### 路径规则
- `find-project-root.sh` 是 bollharness 的项目根定位器（3 层锚点，fail-closed）
- `find-boll-root.sh` 是 boll 专用的（不同步到 bollharness）
- settings.json 中所有 hook command 使用**相对路径**解析器，不含绝对路径

## 接手入口

```bash
npx ts-node .boll/skills/harness-dev-handoff/scripts/collect_handoff_context.ts
```

然后读 `.boll/skills/harness-dev-handoff/SKILL.md`。

## 关键 ADR

- **ADR-030**: Guard Signal Protocol — 上下文路由 + guard 检查的设计
- **ADR-038**: Harness Optimization — 11 决策（metrics、fragment TTL、review agent 隔离等）
- **ADR-041**: Codex Division of Labor — 判断类 vs 执行类 subagent 分流
