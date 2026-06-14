# ADR-030: Guard Signal Protocol and Governance Reload

**Status**: Proposed
**Date**: 2026-03-22
**Revised**: 2026-03-22 (v6 — Part B governance reload 完整设计：上下文路由 + 上下文片段 + guard-feedback.ts 双重机制)
**Origin**: PLAN-057 后续讨论 — 如何让 coherence guard 的思维范式永久存活

---

## 1. 问题

### 1.1 直接诱因：19 个审计发现

2026-03-21 的全局系统审计（`docs/reviews/global-system-audit-2026-03-21.md`）揭示了 19 个跨系统的问题，涵盖 P0（安全/正确性）到 P2（质量/规范）：

| 编号 | 级别 | 问题 | 类型 |
|------|------|------|------|
| 4.1 | P0 | 真相源导航断裂（MEMORY.md/INDEX.md 死链） | 真相漂移 |
| 4.2 | P0 | MCP 默认公网 HTTP 传输 bearer token | 承诺 vs 现实 |
| 4.3 | P0 | run_events 读模型截断导致长 run 状态不正确 | 共享结构过载 |
| 4.4 | P0 | /protocol/runs/{id}/prompt 双重 O(history) 扫描 | 共享结构过载 |
| 4.5 | P0 | 事件写入按 run 序列化（扩展瓶颈） | 共享结构过载 |
| 4.6 | P1 | BYOK base_url 从受控中继退化为任意 SSRF 面 | 承诺 vs 现实 |
| 4.7 | P1 | SecondMe 回调仍允许公网 HTTP origin | 承诺 vs 现实 |
| 4.8 | P1 | Node MCP 未收敛到 PLAN-051 auth surface | 多实现漂移 |
| 4.9 | P1 | smart-home-butler 承诺真实协议，跑 demo fallback | 承诺 vs 现实 |
| 4.10 | P1 | 网站暴露 startup-hub 路由解析为 null | 承诺 vs 现实 |
| 4.11 | P1 | Bridge admin stdout_chunk 信任模型弱于主事件路径 | 边界模糊 |
| 4.12 | P1 | Bridge 回归门禁文档说关了，实际标准调用失败 | 承诺 vs 现实 |
| 4.13 | P1 | Discovery 仍为全表扫描 + N+1 过滤 | 共享结构过载 |
| 4.14 | P1 | AgentWork Inbox 消费旧契约 | 多实现漂移 |
| 4.15 | P2 | MCP 本地配置文件为明文非原子密钥存储 | 真相漂移 |
| 4.16 | P2 | bridge_listen.ts 在一条完成路径上伪装成功 | 承诺 vs 现实 |
| 4.17 | P2 | ENGINEERING_REFERENCE.md 过期但仍被当基线用 | 元层漂移 |
| 4.18 | P2 | 版本/部署/生成产物的真相碎片化 | 真相漂移 |
| 4.19 | P2 | 公开 Agent API 暴露稳定的 owner-identity 映射 | 边界模糊 |

### 1.2 病因分析：不是 19 个独立 bug

这 19 个 finding 聚成 5 个共同病因（审计 Section 7 的根因分析）：

1. **代码演化快，真相收敛慢**（7.1）— 代码改了但文档/测试/消费方没同步。多层真相源（代码、Bolloon.md、MEMORY.md、INDEX.md、plans、.boll memory、部署现实）没有显式治理。
2. **目标态文档跑在实现前面**（7.2）— plan/ADR 写的是"已完成"语气，代码还在过渡态。场景文档说"真实协议"，跑的是 demo fallback。
3. **共享数据结构承担太多角色**（7.3）— `run_events` 同时是审计日志、重放历史、进度来源、轮次来源。一旦过载，每个消费方都从一个不完整的存储中推断语义。
4. **多实现产品缺乏主动一致性治理**（7.4）— Python MCP 和 Node MCP 不会"自动"保持一致。auth、config、版本号各自漂移。
5. **元层漂移是第一等风险**（7.5）— 过期的 skill/指南文档不只是"文档不准"——它会主动把未来的 AI 开发引向错误方向。

审计的核心结论：

> **Bollharness 的本地实现能力已经超过了系统级协调能力。核心问题不再是"能不能实现复杂功能"，而是"能不能维护一个关于'已经实现了什么'的一致的、可信的解释"。**

### 1.3 标和本

用户要求："既要能够解决我们目前遇到的几十个问题，又要是一套美的方式防止以后出现类似的问题，而且其本身也是可维护的。本质和实现我都要，标和本我都要治。"

- **治标**：PLAN-057 逐条修复 19 个 finding（已完成，19 WP + 672 测试）
- **治本**：本 ADR（ADR-030）建立机制，让这 5 类病因不再反复发作

### 1.4 为什么这些 bug 会反复出现

每一类病因的复发机制都相同：**AI 在改代码的那个瞬间，缺乏"这段代码在系统中的完整位置感"。**

- 改了 Python MCP auth 但不知道 Node MCP 是消费方 → 病因 4（多实现漂移）
- 改了 run_events 的读取逻辑但不知道 6 个消费方 → 病因 3（共享结构过载）
- 改了 scene 文档承诺但不知道运行时还是 fallback → 病因 2（承诺 vs 现实）
- 改了 Bolloon.md 的版本号但不知道 pyproject.toml 也要改 → 病因 1（真相漂移）
- 改了 skill 文档但不知道旧版还在其他地方被引用 → 病因 5（元层漂移）

**共同根因**：AI 做决策时，相关的上下文不在它的窗口里。

这不是 prompt 问题（"告诉 AI 要注意消费方"），不是记忆问题（"让 AI 记住 Python/Node 是一对"），不是流程问题（"要求 AI 先查消费方再改代码"）。

这是**上下文工程问题**：在合适的时候，把合适的上下文投影到 AI 的工作窗口中。

### 1.5 核心问题的精确定义

> **如何让每一次代码变更都在完整的上下文下发生——AI 知道这个改动涉及哪些消费方、哪些约定、哪些承诺、哪些已知教训——从而在源头防止这 5 类病因反复出现？**

具体而言：
- 改 `mcp-server/boll_mcp/server.ts` 时，AI 窗口里有 `mcp-server-node/` 的对应文件路径和 parity 约定
- 改 `backend/product/bridge/` 时，AI 窗口里有 Bridge 宪法 5 条规则
- 改 issue doc 标 Fixed 时，AI 窗口里有 "Fixed 三层"定义
- 改 scene 文档承诺时，AI 窗口里有该 scene 的实际 runtime fidelity 分级
- 改 `Bolloon.md` 版本号时，AI 窗口里有所有版本号来源的清单
- 改契约（URL/schema/env var）时，AI 窗口里有消费方列表

这些上下文不靠 AI 自己想起来，不靠 skill 碰巧被加载，不靠人提醒。由代码确定性地路由和注入。

### 1.6 这本质是什么

> **这是上下文工程——在合适的时候给出合适的上下文，而不是 prompt。**

Prompt 是静态的、全量的、前置的指令。上下文工程是动态的、精准的、按需的知识投影。

区别：
- Prompt 把所有规则塞给 AI，希望它记住 → 注意力稀释，规模不可扩展
- 上下文工程检测 AI 正在做什么，投影此刻相关的知识 → 精准，可扩展，由代码控制

LLM 的工作方式是：上下文窗口里有什么，它就用什么来推理。上下文工程利用这个特性——把正确的输入放进窗口，让 transformer 自然产出正确的输出。不是"告诉 AI 应该怎么想"，而是"让 AI 的输入中包含它需要的知识"。

### 1.7 PLAN-057 的思维范式贡献（仍然重要）

PLAN-057 除了修复 19 个 finding，还沉淀了一套思维范式：

- "Fixed"有三层（runtime / prevention / mechanism），不是症状消失就算完
- Guard > Memory：如果一件事靠记忆维护，它一定会出错
- 一个事实只允许一个定义，其余自动派生或自动报警
- 验证看最后一公里，不是"服务启动了"就算过

这些思维范式是上下文工程要投影的**内容**之一。当 AI 改 issue doc 时，"Fixed 三层"框架应该出现在它的窗口里。当 AI 新增一个版本号时，"一个事实只允许一个定义"应该出现在它的窗口里。

**核心矛盾依然存在**：思维方式不能被机械执行（你不能写代码检测"AI 有没有想清楚"），但如果不机械化地把相关思维框架放进 AI 的窗口，它一定会蒸发。上下文工程是解决这个矛盾的机制。

## 2. 关键洞察

### 2.1 思维范式不是被"记住"的，是被"要求输出"的

你不能机械检测"有没有正确思考"，但你可以：

1. 定义"正确思考的产物长什么样"（Convention）
2. 写代码检查产物格式（Guard）
3. 检测到违反时，强制把 AI 拉回正确思维轨道（Signal → Governance Reload）

例：

| 思维规则 | 约定（机器可检查的输出） | Guard |
|---|---|---|
| Fixed 不等于症状消失 | issue.md frontmatter 必须包含 `prevention_status` 字段 | `check_issue_closure.ts` |
| 改代码前要规划 | 代码变更必须伴随 issue/plan artifact | `check_artifact_link.ts` |
| 一个事实只允许一个定义 | Python/Node MCP 工具名和行为必须一致 | `check_mcp_parity.ts` |
| Guard > Memory | issue 标 Fixed 时必须指向 guard 或标 `not_applicable` | `check_issue_closure.ts` |

Guard 不只是语法检查——**它是思维规则的可执行编码**。当 guard 拒绝接受缺少 `prevention_status` 的 issue doc 时，它在教每一个新会话：你必须思考 prevention。

### 2.2 这是上下文工程，不是 Prompt

19 个审计 finding 的共同根因：**AI 做决策时，相关上下文不在它的窗口里。**

- 改了 Python MCP 但不知道 Node MCP 是消费方（窗口里没有 parity 约定）
- 改了 run_events 读取逻辑但不知道 6 个消费方（窗口里没有消费方列表）
- 改了 scene 文档承诺但不知道运行时是 fallback（窗口里没有 fidelity 分级）

传统的解决方式是 prompt："把所有规则写进 Bolloon.md / skill，让 AI 记住"。

问题：
- 规则太多 → 注意力稀释
- 静态全量 → 改 bridge 和改前端需要的知识完全不同，但 prompt 不区分
- Advisory → AI 读完可以不照做
- 上下文压缩 → 长会话后早期 prompt 被挤掉

**上下文工程是不同的路径**：检测 AI 正在做什么 → 用代码确定性地投影此刻相关的知识到窗口 → LLM 自然用它来推理。

这不是"告诉 AI 应该怎么想"（prompt），而是"让 AI 的输入中包含它需要的知识"（context engineering）。路由是代码控制的确定性操作，AI 不参与"要不要加载"的决策。

### 2.3 两部分的成熟度

| 部分 | 内容 | 成熟度 | 行业对标 |
|------|------|--------|---------|
| **Part A: Enforcement** | Convention + Guard + Signal + Blocking Gates | 设计完整，可用现成工具（pre-commit framework, GitHub Actions） | 任何大公司的 CI/CD |
| **Part B: Governance Reload** | 上下文路由 + 上下文片段 + 动态投影 | **本 ADR 的核心贡献**，设计见 Section 3.4.1 | AI 开发时代的新问题，无行业先例 |

Part A 治标（阻止错误产出进入代码库），Part B 治本（让 AI 在源头就用正确的知识做决策）。

## 3. 决策

### 3.1 架构总览

```
                  Bollharness Mechanism Stack
                  ════════════════════

  ┌─────────────────────────────────────────────────┐
  │  Layer 1: Convention                            │
  │  定义"正确的产物长什么样"                        │
  │  载体: Bolloon.md + docs/ + issue/plan 格式约定   │
  │  覆盖: 通用                                     │
  ├─────────────────────────────────────────────────┤
  │  Layer 2: Guard                                 │
  │  检查约定是否被遵守                              │
  │  载体: scripts/checks/*.ts                      │
  │  覆盖: 通用（纯 TypeScript，任何环境可跑）       │
  ├─────────────────────────────────────────────────┤
  │  Layer 3: Signal                                │
  │  把 guard 结果写入文件系统                        │
  │  载体: .boll/guard/session-{pid}.json          │
  │  覆盖: 通用（JSON 文件，任何工具/人可读）          │
  ├─────────────────────────────────────────────────┤
  │  Layer 4: Trigger                               │
  │  什么时候跑 guard                                │
  │  载体: git hooks + deploy.sh (通用)              │
  │         + Claude Code hooks (Claude-specific)    │
  ├─────────────────────────────────────────────────┤
  │  Layer 5: Governance Reload（上下文工程）         │
  │  在 AI 编辑代码时，动态投影相关思维框架到窗口      │
  │  两个机制：                                      │
  │    主动投影: 文件路径→上下文片段（每次编辑都做）   │
  │    被动重载: guard 报红→required_skills/reads     │
  │  载体: context-router.ts + context-fragments/    │
  │  覆盖: Claude Code (native), Codex (adapter)    │
  ├─────────────────────────────────────────────────┤
  │  Layer 6: Blocking Gates                        │
  │  不允许带病通过                                  │
  │  载体: pre-commit + deploy.sh + remote CI       │
  │  覆盖: 通用（git hooks + shell + GitHub Actions）│
  └─────────────────────────────────────────────────┘
```

#### 3.1.1 Enforcement Plane vs Feedback Plane

Mechanism Stack 中的 6 层分属两个截然不同的平面：

```
  ╔══════════════════════════════════════════════════╗
  ║  FEEDBACK PLANE（反馈面）                        ║
  ║  目的: 让 AI/开发者在编辑时立刻知道问题            ║
  ║  特征: 不阻断操作，stderr 输出，advisory          ║
  ║  组件: PostToolUse hook, PreToolUse hook,        ║
  ║        session signal files, governance reload   ║
  ║  覆盖: Claude Code (native), Codex (via signal)  ║
  ╠══════════════════════════════════════════════════╣
  ║  ENFORCEMENT PLANE（强制面）                     ║
  ║  目的: 硬性阻止坏代码进入 repo/生产               ║
  ║  特征: exit ≠ 0 → 操作失败，不可绕过              ║
  ║  组件: pre-commit hook, deploy.sh,               ║
  ║        remote CI (GitHub Actions coherence)      ║
  ║  覆盖: 通用（任何 git client、任何 CI 平台）       ║
  ╚══════════════════════════════════════════════════╝
```

**关键裁决**：

1. **反馈面和强制面不能混淆**。PostToolUse 的 `exit 2` 是反馈（AI 收到信息但可以选择继续），不是阻断。真正的阻断只发生在 pre-commit、deploy、remote CI。
2. **反馈面的价值是速度**：AI 编辑文件后 1-2 秒内收到 signal，不需要等到 commit 时才发现问题。
3. **强制面的价值是不可绕过**：local pre-commit 可以被 `--no-verify` 跳过，deploy.sh 可以被绕过，但 remote CI 不能。Remote gate 是最终防线。
4. **两者互补而非替代**：反馈面减少到达强制面时的问题数量；强制面保证漏网的问题不能落地。

### 3.2 Guard Signal Protocol

Guard 运行后，每个进程写自己的 session 文件到 `.boll/guard/`：

```
.boll/guard/
  session-{pid}.json      # 每个进程独立写，不互相覆盖
  .session-notified-{pid} # SessionStart 通知标记（见 3.5）
```

单个 session 文件格式：

```json
{
  "timestamp": "2026-03-22T10:15:00Z",
  "pid": 12345,
  "stage": "post-edit | pre-commit | deploy",
  "trigger": "guard-feedback.ts | pre-commit | deploy.sh",
  "findings": [
    {
      "severity": "P0 | P1 | P2",
      "blocking": true,
      "category": "closure_semantics | contract_drift | bridge_boundary | doc_integrity | version_drift | artifact_linkage | governance_bootstrap",
      "problem_class": "policy | contract | implementation",
      "message": "Issue 022 marked Fixed but prevention_status is open",
      "file": "docs/issues/022-bridge-node-missing-execution-files-2026-03-21.md",
      "line": 5,
      "required_skills": ["lead", "bollharness-ops"],
      "required_reads": [
        "docs/issues/022-bridge-node-missing-execution-files-2026-03-21.md"
      ]
    }
  ],
  "summary": {
    "p0": 0,
    "p1": 1,
    "p2": 0,
    "has_blocking": true,
    "required_skills": ["lead", "bollharness-ops"]
  }
}
```

**`severity` 与 `blocking` 是独立维度**：

| 概念 | 回答 | 值域 |
|------|------|------|
| `severity` | 问题有多严重 | P0 (安全/数据丢失), P1 (功能断裂), P2 (质量/规范) |
| `blocking` | 是否阻止 commit/deploy | true / false — 由 guard 按治理要求声明 |

一个 P2 的 closure 违规可能不那么"严重"，但它违反治理规则，所以 `blocking: true`。分离这两个维度是让 closure 体系真正可执行的关键。

**`category` 与 `problem_class` 是正交维度**：

| 字段 | 回答 | 用于 | 值域 |
|------|------|------|------|
| `category` | 发现了什么类型的问题 | skill 路由（见 3.4） | closure_semantics, contract_drift, bridge_boundary, doc_integrity, version_drift, artifact_linkage, governance_bootstrap |
| `problem_class` | 问题在哪个架构层 | 修复者决定修复策略 | policy, contract, implementation |

`required_skills` 从 `category` 派生，不从 `problem_class` 派生。`problem_class` 是给修复者的元信息——对应 R1 "先分层再动手"。

**多 session 读取**：

任何需要了解仓库 guard 状态的代码，通过 union 所有 session 文件获取：

```typescript
const SEVERITY_RANK: Record<string, number> = { "P0": 0, "P1": 1, "P2": 2 };

async function readAllFindings(guardDir: Path, maxAgeSeconds: number = 3600): Promise<Finding[]> {
  const raw: Finding[] = [];
  const now = Date.now() / 1000;
  for (const path of guardDir.glob("session-*.json")) {
    const age = now - path.stat().st_mtime;
    if (age > maxAgeSeconds) {
      path.unlink(missing_ok=True);
      continue;
    }
    const data = JSON.parse(path.read_text());
    raw.push(...data["findings"]);
  }
  return mergeFindings(raw);
}

function mergeFindings(findings: Finding[]): Finding[] {
  const byKey: Map<string, Finding> = new Map();
  for (const f of findings) {
    const key = `${f["file"]}:${f["category"]}`;
    if (!byKey.has(key)) {
      byKey.set(key, { ...f });
    } else {
      const existing = byKey.get(key)!;
      if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[existing.severity]) {
        existing.severity = f.severity;
        existing.message = f.message;
      }
      existing.blocking = existing.blocking || f.blocking;
      existing.required_skills = [...new Set([...existing.required_skills, ...f.required_skills])];
    }
  }
  return Array.from(byKey.values());
}
```

**合并规则（保守原则——取最严）**：

| 字段 | 合并策略 | 理由 |
|------|---------|------|
| `severity` | `max`（P0 > P1 > P2） | 两个 session 对同一问题评估不同，取最严防漏 |
| `blocking` | `OR` | 任一 session 认为应阻断 → 阻断 |
| `required_skills` | `union` | 所有相关 skill 都应被加载 |
| `message` | 取 severity 最高的 | 最严发现的描述最有信息量 |

**设计原则**：

- **每个 writer 只写自己的 scope，reader union 全部**：消除竞态，不需要锁或 merge-on-write
- **signal 不是日志**：session 文件只保留该 session 最新一次 guard 结果，超过 1 小时自动过期
- **required_skills 是建议**：AI 读到后应加载对应 skill，但 guard 本身不依赖 skill 是否被加载

### 3.3 Guard Router

文件路径到 guard 的映射，定义在 `scripts/guard_router.ts`：

```typescript
const GUARD_MAP: Record<string, string[]> = {
  "bridge_agent/":        ["check_bridge_deps"],
  "mcp-server/":          ["check_mcp_parity"],
  "mcp-server-node/":     ["check_mcp_parity"],
  "backend/":             ["check_versions"],
  "website/":             ["check_doc_links"],

  "docs/issues/":         ["check_issue_closure", "check_doc_links"],
  "docs/decisions/":      ["check_doc_links"],
  "docs/":                ["check_doc_links"],

  "Bolloon.md":            ["check_doc_links"],
  ".boll/skills/":        ["check_doc_links"],
  ".boll/settings.json":   ["check_hook_installed"],
  ".githooks/":           ["check_hook_installed"],
  "scripts/checks/":      ["check_versions"],
  "scripts/coherence.ts":  ["check_versions"],
  "scripts/guard_router.ts": ["check_versions"],
  "scripts/context-router.ts": ["check_fragment_integrity"],
  "scripts/context-fragments/": ["check_fragment_integrity"],
};

const DEFAULT_GUARDS = ["check_doc_links"];
```

Guard 命名沿用 PLAN-057 已建立的规范（`check_versions` 而非 `check_version_drift`）。

**`check_fragment_integrity.ts`** — guard 保护上下文片段自身不漂移（元层漂移的反漂移机制也需要被保护）：

```typescript
async function run(repoRoot: Path): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const name of allReferencedFragments(repoRoot)) {
    const path = repoRoot / "scripts" / "context-fragments" / `${name}.md`;
    if (!path.exists()) {
      findings.push(new Finding({
        severity: "P1",
        category: "governance_bootstrap",
        blocking: true,
        message: `CONTEXT_MAP references fragment '${name}' but file missing`
      }));
    }
  }

  for (const path of (repoRoot / "scripts" / "context-fragments").glob("*.md")) {
    const name = path.stem;
    if (!allReferencedFragments(repoRoot).includes(name)) {
      findings.push(new Finding({
        severity: "P2",
        category: "doc_integrity",
        blocking: false,
        message: `Fragment '${name}' exists but not referenced in CONTEXT_MAP`
      }));
    }
  }

  return findings;
}
```

新增 guard 只需：写 `scripts/checks/check_xxx.ts`，在 `GUARD_MAP` 注册路由。

### 3.4 Category → Skill 映射

```typescript
const CATEGORY_TO_SKILLS: Record<string, string[]> = {
  "closure_semantics":    ["lead", "bollharness-ops"],
  "contract_drift":       ["bollharness-dev", "bollharness-eng-test"],
  "bridge_boundary":      ["bollharness-bridge", "bollharness-ops"],
  "policy_freeze":        ["lead", "arch", "plan-lock"],
  "doc_integrity":        ["bollharness-ops"],
  "version_drift":        ["bollharness-ops"],
  "artifact_linkage":     ["lead"],
  "governance_bootstrap": ["bollharness-ops"],
};
```

当 guard 发现问题时，`required_skills` 由 `CATEGORY_TO_SKILLS[finding.category]` 生成。AI 收到信号后加载这些 skill 获取完整的思维框架，而不是盲目修。

### 3.4.1 Governance Reload 完整设计（Part B — 上下文工程）

> **这是 ADR-030 区别于标准 CI/CD 的核心贡献。**
>
> Enforcement plane（Part A）检查"产出对不对"——这是任何大公司都有的标准 CI。
> Governance Reload（Part B）解决"AI 做决策时窗口里有没有正确的知识"——这是 AI 开发时代的新问题。

#### 核心原理：上下文工程，不是 Prompt

```
Prompt 思路:    写一套静态规则 → 希望 AI 记住 → 检查有没有遵守
                问题: 规则太多注意力稀释, 新会话可能没加载, AI 可以读完不照做

上下文工程:     检测 AI 正在做什么 → 投影此刻相关的知识到窗口 → LLM 自然用它推理
                原理: Transformer 的工作方式就是用上下文中的信息来推理
                保障: 路由是代码（确定性），投影是脚本（自动），AI 不参与"要不要加载"的决策
```

#### 两个机制

Governance Reload 由两个独立的机制组成，通过同一条管道（PostToolUse → stderr → exit 2）送达，但使用不同的输出标记以区分语义：

```
AI 编辑文件
  │
  ├─→ 机制 A: 上下文路由（主动，每次编辑都做）
  │     输入: 被编辑的文件路径
  │     逻辑: context-router.ts 匹配路由表
  │     输出: 相关的上下文片段（精炼的思维框架，10-25 行）
  │     目的: 让 AI 在做决策时，窗口里有此刻需要的知识
  │     举例: 改 bridge → 注入 Bridge 宪法 5 条规则
  │
  └─→ 机制 B: Guard 检查 + Signal（被动，有问题才报）
        输入: 被编辑的文件路径 + diff
        逻辑: guard-router → 相关 check_*.ts
        输出: findings + required_skills + required_reads
        目的: 发现具体违规，指向需要补读的 skill/文档
        举例: issue 标 Fixed 但 prevention_status 缺失 → 报 P1 + 指向 lead skill
```

机制 A 是**主动的**——不管有没有问题都注入。改 bridge 代码时，Bridge 宪法出现在窗口里，AI 自然不会违反它。
机制 B 是**被动的**——只在发现问题时才报。这是 Section 3.2 已有的 signal 协议。

**两者的关系**：机制 A 减少错误产生（AI 在正确的上下文下做决策），机制 B 兜住漏网的（有些错误即使有上下文也会犯，guard 拦住）。

#### 上下文路由表（`scripts/context-router.ts`）

```typescript
const CONTEXT_MAP: Record<string, string[]> = {
  "bridge_agent/":                    ["bridge-constitution"],
  "backend/product/bridge/":          ["bridge-constitution"],

  "mcp-server/":                      ["mcp-parity"],
  "mcp-server-node/":                 ["mcp-parity"],

  "backend/product/routes/protocol.ts": ["protocol-consumers", "contract-consumers"],
  "backend/product/protocol/":        ["protocol-consumers"],

  "backend/product/routes/":          ["contract-consumers"],

  "backend/product/db/crud_events.ts": ["run-events-consumers"],

  "backend/product/auth/":            ["auth-consumers"],

  "backend/product/db/":              ["db-shared-structures"],

  "backend/product/catalyst/":        ["catalyst-distributed"],

  "docs/issues/":                     ["fixed-three-layers", "closure-checklist"],

  "scenes/":                          ["scene-fidelity", "two-language"],
  "website/app/[scene]/":             ["scene-fidelity", "two-language"],
  "website/components/scene/":        ["scene-fidelity", "two-language"],

  "Bolloon.md":                        ["truth-source-hierarchy"],
  "MEMORY.md":                        ["truth-source-hierarchy"],
  "docs/INDEX.md":                    ["truth-source-hierarchy"],

  "mcp-server/pyproject.toml":        ["version-sources"],
  "mcp-server-node/package.json":     ["version-sources"],

  "website/":                         ["two-language"],

  "docs/decisions/":                  ["artifact-linkage"],
};

function match(filePath: string): string[] {
  const matched: string[] = [];
  for (const [pattern, fragments] of Object.entries(CONTEXT_MAP).sort((a, b) => b[0].length - a[0].length)) {
    if (filePath.startsWith(pattern) || filePath.endsWith(pattern)) {
      matched.push(...fragments);
    }
  }
  return [...new Map(matched.map(f => [f, f])).keys()];
}

const FALLBACK_FRAGMENTS = ["general-dev-principles"];
```

路由表是确定性代码。新增一个领域 = 写一个片段文件 + 在路由表里加一条规则。

#### 上下文片段库（`scripts/context-fragments/`）

每个片段是一个精炼的 Markdown 文件，设计原则：
- **短**：10-25 行，一屏看完，不稀释 AI 注意力
- **自足**：不需要跳转到其他文档就能理解
- **面向当前操作**：不是"这个领域的全部知识"，而是"你正在改这个文件，这几件事必须知道"
- **可维护**：每个片段对应一个领域，独立更新

示例片段 — `scripts/context-fragments/bridge-constitution.md`：
```markdown
## Bridge 宪法（ADR-026）

你正在编辑 Bridge 相关代码。以下 5 条规则约束所有 bridge 改动：

1. **Worker 不拥有业务解释权，只上报执行事实。** 如果代码需要理解输出内容的含义，它写错了地方。
2. **同一个语义只允许有一个定义。** 文件名模式、artifact 类型、event 含义，只能在一个地方定义。
3. **跑通了就发结果，没跑通就报 failed。** 不做 partial_success 抢救、不生成 placeholder。
4. **生产不能是第一个集成环境。** 本地必须能用 fake CLI + 真实 HTTP backend 跑完整链。
5. **新增观测维度或 event 类型，只改 server，不改 worker。**

三层职责：`boll-run` 定义成功产物契约 → `worker` 执行和上报事实 → `server` 解释事实并生成产品语义。
```

示例片段 — `scripts/context-fragments/mcp-parity.md`：
```markdown
## MCP 双端一致性约定

你正在编辑 MCP 相关代码。Python 和 Node 两端必须保持一致：

- **工具数量**：两端都是 54 个 @mcp.tool() / registerTool()
- **工具名称**：必须完全相同（boll_xxx）
- **行为语义**：相同输入必须产生相同输出结构
- **版本号**：pyproject.toml 和 package.json 版本必须一致

对应文件映射：
- Python: `mcp-server/boll_mcp/server.ts` ↔ Node: `mcp-server-node/src/index.ts`
- Python: `mcp-server/boll_mcp/client.ts` ↔ Node: `mcp-server-node/src/client.ts`
- Python: `mcp-server/boll_mcp/config.ts` ↔ Node: `mcp-server-node/src/config.ts`

改了一端后，检查另一端是否需要同步。Guard: `check_mcp_parity.ts`
```

示例片段 — `scripts/context-fragments/fixed-three-layers.md`：
```markdown
## Fixed 三层定义

你正在编辑 issue 文档。"Fixed" 不等于"症状消失"：

| 层级 | 含义 | 标准 | 标记 |
|------|------|------|------|
| Level 1 | 症状消失 | 生产不报错了 | Runtime Fixed |
| Level 2 | 复发路径关闭 | 有机制防止同类问题再次发生 | **Fixed**（最低标准） |
| Level 3 | 机制消灭 | 有 guard 自动检测 | Fixed + Guarded |

issue doc frontmatter 必须包含：
- `prevention_status: open | closed | not_applicable`
- `mechanism_layer: runtime | prevention | guard`

如果标 Fixed 但 prevention_status 是 open → 不合格。Guard: `check_issue_closure.ts`
```

片段清单（初始集，覆盖 19 个审计 finding 的 5 个病因 + 高频变更区域）：

| 片段文件 | 覆盖的病因 | 内容概要 |
|----------|-----------|----------|
| `bridge-constitution.md` | 边界模糊 | ADR-026 五条规则 + 三层职责 |
| `mcp-parity.md` | 多实现漂移 | 双端映射 + 同步约定 |
| `fixed-three-layers.md` | 真相漂移 | Fixed 定义 + frontmatter 要求 |
| `closure-checklist.md` | 真相漂移 | prevention_status 检查清单 |
| `protocol-consumers.md` | 多实现漂移 | /protocol/ API 的消费方列表 |
| `run-events-consumers.md` | 共享结构过载 | run_events 的 6 个消费方 + 角色 |
| `scene-fidelity.md` | 承诺 vs 现实 | scene 分级（real/demo/shell）|
| `two-language.md` | 承诺 vs 现实 | 协议语言 vs 用户语言 |
| `truth-source-hierarchy.md` | 元层漂移 | 真相源优先级 |
| `version-sources.md` | 真相漂移 | 所有版本号来源清单 |
| `artifact-linkage.md` | 真相漂移 | 代码变更必须伴随 artifact |
| `contract-consumers.md` | 多实现漂移 | 契约 vs 实现 + 消费方追踪 |
| `general-dev-principles.md` | 通用 | Guard > Memory + 一个事实一个定义 |
| `auth-consumers.md` | 多实现漂移 | SecondMe OAuth 消费方 + session 安全约定 |
| `db-shared-structures.md` | 共享结构过载 | DB 表的多消费方声明 + 迁移约定 |
| `catalyst-distributed.md` | 边界模糊 | 分布式协商约定 + 端侧 vs 平台侧职责 |

**扩展原则**：这是初始集，不是完整集。当某个代码区域反复出现同类错误时，应为其创建上下文片段并加入路由表。判断标准：如果 AI 在编辑该区域时"应该知道但反复不知道"某条规则，就需要一个片段。

#### `guard-feedback.ts` — PostToolUse 枢纽脚本

`guard-feedback.ts` 是 Governance Reload 的实际执行入口。它同时承担上下文路由和 guard 检查两个职责：

```typescript
#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { match, loadFragment, FALLBACK_FRAGMENTS } from './context_router';
import { GUARD_MAP, runGuards } from './guard_router';
import { writeSessionSignal } from './signal_writer';

async function main() {
  const filePath = process.env.TOOL_FILE_PATH || '';
  if (!filePath) return;

  const repoRoot = process.env.REPO_ROOT || '.';
  const relPath = path.relative(repoRoot, filePath);

  const outputParts: string[] = [];

  const fragments = match(relPath) || FALLBACK_FRAGMENTS;
  const contextParts: string[] = [];
  for (const name of fragments) {
    const content = loadFragment(name);
    if (content) contextParts.push(content);
  }
  if (contextParts.length) {
    outputParts.push("## Context\n\n" + contextParts.join("\n\n"));
  }

  const findings = await runGuards(relPath);
  if (findings.length) {
    outputParts.push(formatFindings(findings));
    writeSessionSignal(findings);
  }

  if (outputParts.length) {
    console.error("---\n" + outputParts.join("\n---\n"));
    process.exit(2);
  }
}

function formatFindings(findings: Finding[]): string {
  const lines = ["## Guard Findings\n"];
  for (const f of findings) {
    lines.push(`- **${f.severity}** [${f.category}]: ${f.message}`);
    if (f.required_skills?.length) {
      lines.push(`  → 建议加载: ${f.required_skills.join(', ')}`);
    }
    if (f.required_reads?.length) {
      lines.push(`  → 建议参考: ${f.required_reads.join(', ')}`);
    }
  }
  return lines.join('\n');
}

main().catch(console.error);
```

#### Claude Code Hook 配置

```json
// .boll/settings.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "npx ts-node scripts/guard-feedback.ts"
      }
    ]
  }
}
```

Claude Code 在 AI 每次调用 Edit 或 Write 工具后自动执行 `guard-feedback.ts`。脚本输出到 stderr + exit 2，内容被 Claude Code 注入 AI 的对话上下文。AI 的下一步推理，窗口里已经有了相关的思维框架。

#### Codex Adapter

Codex 没有原生 PostToolUse hook。实现同等效果的路径（按优先级）：

1. **Codex task wrapper**：在 Codex task 启动脚本中注入 `guard-feedback.ts` 调用
2. **Filesystem watcher**：监听工作目录文件变更，变更后调用 `guard-feedback.ts`，输出写入 `.boll/guard/session-*.json`，Codex 读取
3. **Pre-task 注入**：在 Codex task description 中包含"先运行 `npx ts-node scripts/guard-feedback.ts --file {file}`"的指令

无论哪条路径，核心脚本相同（`scripts/guard-feedback.ts`），差异只在触发方式。

**诚实声明**：以上三条路径均为候选，尚未验证 Codex 实际支持哪一条。Phase 2 开始时必须先做 Codex 能力调研（支持哪些 hook/plugin/watcher 机制），确定可行路径后再实现。如果 Codex 当前不支持任何主动推送机制，则在 Phase 2 完成标准中标注"待 Codex 支持后交付"，并持续跟踪 Codex 新功能。**不接受**静默降级为"Codex 被动可读"。

#### 与 Enforcement Plane 的关系

```
Governance Reload（Layer 5）              Enforcement（Layer 6）
────────────────────────────              ──────────────────────
时机: 编辑时（即时，1-2 秒）                时机: 提交/合并/部署时
目的: 让 AI 在正确的上下文下做决策           目的: 阻止错误产出进入代码库
方式: 投影相关知识到 AI 窗口                方式: 检查产物格式 + exit ≠ 0
效果: 从源头减少错误产生                    效果: 兜底拦住漏网的
依赖: Claude Code hooks / Codex adapter   依赖: git hooks / GitHub Actions（通用）
```

两层独立运作，互补而非替代：
- Governance Reload 只要有效运作，到达 Enforcement 时的问题数量大幅减少
- 即使 Governance Reload 完全失效（hook 没装、Codex 没 adapter），Enforcement 仍然拦住所有 blocking 问题

#### 可维护性

新增一个领域的治理：
1. 写一个上下文片段文件 `scripts/context-fragments/xxx.md`（10-25 行）
2. 在 `CONTEXT_MAP` 里加一条路由规则
3. （可选）写一个 `scripts/checks/check_xxx.ts` guard
4. （可选）在 `CATEGORY_TO_SKILLS` 里加一条映射

删除一个过时的治理：
1. 删除片段文件
2. 从 `CONTEXT_MAP` 移除路由
3. 下次 guard 跑不到就自然失效

这满足用户要求 #1（显式强调——机制入口在每次 Edit 后自动触发）和"其本身也是可维护的"。

### 3.5 触发点

| 触发点 | 机制 | Guard 范围 | 平面 | 阻断判定 | 覆盖 |
|--------|------|-----------|------|---------|------|
| **Session-start** | Claude Code `PreToolUse` hook (first `Read` only) | 不跑新 guard，只读现有 session 文件 | Feedback | Advisory（stderr 输出） | Claude Code |
| **Post-edit** | Claude Code `PostToolUse` hook | 增量（改动文件相关 guard） | Feedback | Advisory（stderr + exit 2） | Claude Code |
| **Pre-commit** | `.githooks/pre-commit` | `--staged_only` + `check_artifact_link` (presence) | Enforcement | **Hard — 拦 `blocking: true`** | 通用 |
| **Commit-msg** | `.githooks/commit-msg` | `check_bugfix_binding`（message + staged files） | Enforcement | **Hard — 拦 bugfix 无 issue doc** | 通用 |
| **Deploy** | `deploy.sh` | 全量 | Enforcement | **Hard — 拦 P0** | 通用 |
| **Remote CI** | GitHub Actions `coherence.yml` (required check) | 全量 + bugfix binding | Enforcement | **Hard — PR 不过不能 merge** | 通用（不可绕过） |

**阻断逻辑**：

```typescript
function shouldBlock(findings: Finding[], stage: string): boolean {
  if (stage === "deploy") {
    return findings.some(f => f.severity === "P0");
  }
  if (["pre-commit", "commit-msg", "remote-ci"].includes(stage)) {
    return findings.some(f => f.blocking);
  }
  return false;
}
```

**Post-edit 信号闭环**：

```
AI 编辑文件
  → PostToolUse hook 触发 guard-feedback.ts
  → guard-feedback.ts 通过 guard router 跑相关 guard
  → 写 .boll/guard/session-{pid}.json
  → 如果有 finding：stderr 输出摘要 + exit 2
  → AI 收到 stderr 反馈
  → 反馈中包含 required_skills
  → AI 加载对应 skill，获取完整思维上下文
  → 带着正确思维框架去修问题
```

**Session-start 早期感知**：

```
新 session 打开
  → AI 首次使用 Read 工具
  → PreToolUse hook 触发 guard-feedback.ts --check-only --once
  → 读 .boll/guard/ 下所有 session 文件（不跑新 guard）
  → 如果有 blocking finding：stderr 输出摘要
  → 写 .boll/guard/.session-notified-{pid} 标记，同一 session 不重复通知
  → AI 知道 repo 当前有 blocking 问题，优先处理
```

Session-start 触发是 advisory，不是硬阻断。其价值是减少浪费（避免在已有 blocker 时做无效规划），不是防止错误（那是 pre-commit/deploy 的事）。

### 3.6 Closure Semantics

#### Issue 文档格式（Convention）

`docs/issues/*.md` 必须使用 YAML frontmatter：

```markdown
---
title: Bridge node missing execution files
date: 2026-03-21
status: Fixed
prevention_status: closed
guard_status: exists
problem_class: contract
guard_ref: check_bridge_deps
---

## 问题描述
...
```

字段定义：

| 字段 | 必填 | 值域 | 含义 |
|------|------|------|------|
| `title` | 是 | 自由文本 | 问题标题 |
| `date` | 是 | YYYY-MM-DD | 发现日期 |
| `status` | 是 | Open, Runtime-Fixed, Fixed, Fixed+Guarded | 当前状态 |
| `prevention_status` | 是 | open, closed, not_applicable | 预防机制是否存在 |
| `guard_status` | 是 | missing, exists, not_applicable | 自动化检测是否存在 |
| `problem_class` | 是 | policy, contract, implementation | 问题所在的架构层 |
| `guard_ref` | 条件 | guard 脚本名 | `guard_status=exists` 时必填 |
| `scope` | 推荐 | 代码目录列表 | 受影响的代码路径（用于 artifact linkage scope binding，见 3.9） |

#### Status 语义（新增到 Bolloon.md）

```
- Runtime-Fixed: 现网症状已消除，生产验证通过。
  复发路径尚未关闭。
- Fixed: 预防机制已存在于 repo 中
  (runbook step / guard / automation)。
  同一失败模式不能通过同一路径再次发生。
- Fixed+Guarded: 自动化检测已存在于
  scripts/checks/。未来回归会被 coherence runner 捕获。
```

#### Guard 解析

`check_issue_closure.ts` 使用 YAML frontmatter 解析，不做 prose scraping：

```typescript
import * as yaml from 'js-yaml';
import * as fs from 'fs';

function parseIssueFrontmatter(filePath: string): Record<string, unknown> | null {
  const text = fs.readFileSync(filePath, 'utf-8');
  if (!text.startsWith("---")) return null;
  const parts = text.split("---", 2);
  if (parts.length < 3) return null;
  return yaml.load(parts[1]) as Record<string, unknown>;
}
```

### 3.7 Multi-session Coordination

4-5 个并行上下文窗口的协调通过 per-session 文件实现：

```
              .boll/guard/
    ┌──────────────────────────────────┐
    │  session-1234.json  (Session A)  │
    │  session-5678.json  (Session B)  │
    │  session-9012.json  (Session C)  │
    └──────────────────────────────────┘
                     │
           ┌─────────┼─────────┐
           │ reads   │ reads   │ reads
           │ all     │ all     │ all
           ▼         ▼         ▼
       Session A  Session B  Session C
```

**为什么不用单个 `latest.json`**：

Session A 发现 P1 → 写入 latest.json → Session B 运行 guard 无发现 → 覆写 latest.json → Session A 的 P1 消失 → 假绿。

Per-session 文件消除竞态：每个进程只写自己的文件，不碰别人的。读的时候 union 所有文件。文件系统是天然的无锁共享层。

过期清理（> 1 小时）防止死 session 残留累积。

### 3.8 Bootstrap Protocol

Git 不会自动执行 repo 中的 hook 文件。`.githooks/pre-commit` 和 `.githooks/commit-msg` checked into repo 不等于它们会被执行。

**`check_hook_installed.ts`** — 用 guard 保障 guard 基础设施本身：

```typescript
import { execSync } from 'child_process';

async function run(repoRoot: Path): Promise<Finding[]> {
  try {
    const result = execSync('git config core.hooksPath', { cwd: repoRoot, encoding: 'utf-8' });
    const hooksPath = result.stdout.trim();
    if (hooksPath === ".githooks") return [];
  } catch {}

  const legacyHook = repoRoot / ".git" / "hooks" / "pre-commit";
  if (legacyHook.is_symlink() && ".githooks" in legacyHook.resolve().toString()) {
    return [];
  }

  return [new Finding({
    severity: "P0",
    category: "governance_bootstrap",
    blocking: true,
    message: "Pre-commit hook not active. Run: git config core.hooksPath .githooks",
    required_skills: ["bollharness-ops"],
  })];
}
```

**自举链**：

```
Claude Code 启动
  → 加载 .boll/settings.json（Claude Code 自动行为，不需手动）
  → PostToolUse hook 配置指向 guard-feedback.ts
  → AI 首次编辑文件 → guard-feedback.ts 跑
  → check_hook_installed 发现 git hook 未安装 → P0 blocking
  → AI 收到 stderr 反馈 → 执行 git config core.hooksPath .githooks
  → 此后所有 commit 经过 pre-commit hook
```

**非 Claude Code 环境**：手动 git commit 时如果 hook 未安装，deploy.sh 全量 coherence 会拦住。hook 未安装的代码可以 commit，但无法部署。

### 3.9 Artifact Linkage

**问题**：`check_issue_closure.ts` 只在 issue 文件被 staged 时检查合规性。如果开发者只改代码不碰 issue doc，guard 根本不触发。

Artifact linkage 分两个阶段实现，当前阶段和增强阶段解决不同层次的问题：

#### Phase 3: Presence Gate（当前）

强制代码变更伴随**某个** issue/plan artifact。打破"纯代码提交零文档"的模式。

**`check_artifact_link.ts`**：

```typescript
const CODE_DIRS = ["backend/", "bridge_agent/", "mcp-server/", "mcp-server-node/", "website/"];
const ARTIFACT_PREFIXES = ["docs/issues/", "docs/decisions/PLAN-", "docs/decisions/ADR-"];

async function run(stagedFiles: string[]): Promise<Finding[]> {
  const codeFiles = stagedFiles.filter(f => CODE_DIRS.some(d => f.startsWith(d)));
  if (!codeFiles.length) return [];

  if (codeFiles.every(f => f.toLowerCase().includes("test"))) {
    return [];
  }

  const hasArtifact = stagedFiles.some(f => ARTIFACT_PREFIXES.some(p => f.startsWith(p)));
  if (!hasArtifact) {
    return [new Finding({
      severity: "P1",
      category: "artifact_linkage",
      blocking: true,
      message: "Code changes staged without an associated issue/plan document.",
      required_skills: ["lead"],
    })];
  }
  return [];
}
```

**诚实的局限**：presence gate 只检查"有没有 artifact 陪跑"，不检查"是不是正确的 artifact"。开发者可以 stage 一个不相关的旧 issue doc 来满足门禁。这是 Phase 3 的已知 tradeoff：它消除了最常见的失败模式（纯代码提交），但不能防止刻意绕过。

#### Phase 4+: Scope Binding（增强）

Issue/plan frontmatter 的 `scope` 字段声明受影响的代码路径。Guard 验证 staged 代码路径与 artifact 声明的 scope 匹配。

Issue frontmatter 示例：

```yaml
---
title: Bridge node missing execution files
date: 2026-03-21
status: Fixed
prevention_status: closed
guard_status: exists
problem_class: contract
guard_ref: check_bridge_deps
scope:
  - bridge_agent/
  - backend/product/bridge/
---
```

增强后的 `check_artifact_link.ts`：

```typescript
async function runWithScope(stagedFiles: string[]): Promise<Finding[]> {
  // ... presence check (same as Phase 3) ...

  const artifactFiles = stagedFiles.filter(f => ARTIFACT_PREFIXES.some(p => f.startsWith(p)));
  const declaredScopes = new Set<string>();
  for (const af of artifactFiles) {
    const fm = parseFrontmatter(Path(af));
    if (fm && "scope" in fm) {
      (fm.scope as string[]).forEach(s => declaredScopes.add(s));
    }
  }

  const unlinked = codeFiles.filter(f => !declaredScopes.has(s => f.startsWith(s)));
  if (unlinked.length) {
    return [new Finding({
      severity: "P1",
      category: "artifact_linkage",
      blocking: true,
      message: `Code files ${unlinked.slice(0, 3)} not covered by any staged artifact's scope.`,
      required_skills: ["lead"],
    })];
  }
  return [];
}
```

**Phase 4+ 不在本 ADR 的初始实现范围内**，但 `scope` 字段现在就定义到 frontmatter 规范中（见 3.6），为增强预留接口。Phase 3 的 presence gate 是可接受的起步。

#### Closure 链路（Phase 3 → Phase 4 渐进）

两种 artifact 走不同的 closure 路径——不能假装 PLAN/ADR 会触发 closure 检查：

```
Phase 3 — presence gate:
  代码变更 → check_artifact_link 要求伴随某个 artifact（pre-commit）

  路径 A（issue doc staged）:
    → check_issue_closure 检查 YAML frontmatter
    → 必须包含 prevention_status + guard_status
    → 违反 → blocking: true → pre-commit 拦住
    → ✅ 完整 closure 链路

  路径 B（PLAN/ADR staged）:
    → presence gate 通过
    → ⚠️ 无 closure 检查 — PLAN/ADR 没有 prevention_status 字段
    → 对功能开发足够，对 bugfix 不够

Phase 4 — bugfix binding + scope binding:
  commit-msg hook:
    → commit message 含 fix/bugfix/hotfix/incident
    → 必须走路径 A（强制 issue doc）
    → ✅ bugfix closure 链路关闭

  scope binding:
    → artifact frontmatter 的 scope 必须覆盖 staged 代码路径
    → 不相关的 artifact 不再被接受
```

Phase 3 路径 B 的缺口是已知的过渡状态。Phase 4 通过 `commit-msg` hook 和 scope binding 关闭。

这是 lead 流程 Gate 1（规划 → 产物: PLAN 文档）的机械化。

### 3.10 Tool Scope and Non-Claude Fallback

本 ADR 的覆盖范围对不同层有不同承诺：

| 层 | 覆盖范围 | 非 Claude 环境行为 |
|----|---------|-------------------|
| Convention (L1) | 通用 | Bolloon.md、issue frontmatter 格式对任何开发者/工具可见 |
| Guard (L2) | 通用 | 纯 TypeScript 脚本，`npx ts-node scripts/coherence.ts` 任何环境可跑 |
| Signal (L3) | 通用 | JSON 文件，人或任何工具可读可解析 |
| Trigger - hard (L4) | 通用 | `pre-commit` + `deploy.sh` 只依赖 git + shell |
| Trigger - advisory (L4) | Claude Code native, Codex adapter-based | Claude Code: PostToolUse/PreToolUse; Codex: adapter/watcher 主动推送 |
| Governance Reload (L5) | Claude Code native, Codex adapter-based; both active | 两者都必须有即时本地反馈，触发方式不同但效果相同 |
| Blocking Gates (L6) | 通用 | git hooks + shell |

**各环境覆盖矩阵**：

| 环境 | Feedback Plane | Enforcement Local | Enforcement Remote |
|------|---------------|-------------------|-------------------|
