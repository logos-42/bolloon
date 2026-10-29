---
title: 受治理动态配置 (bolloon-config)
source: session
created: 2026-10-29
last_confirmed: 2026-10-29
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [config, dynamic-config, harness, kernel-loop, multi-node, lease, ai-optimizer, observability]
---

# 受治理动态配置 (bolloon-config)

一句话：**运行策略可以在不重新编译的情况下更新，但配置的决策权、执行权与安全约束分开，且任何一次更新都必须可验证、可回滚、可追查。**

代码落点：`rust/crates/bolloon-config/`（内部 crate，无新外部依赖：`serde`/`thiserror`/`tokio`/`chrono`/`reqwest` 都是 workspace 既有）。

## 1. 分层 (谁拥有什么)

```
ConfigManager (bolloon-config)
  ├─ view: Arc<RwLock<Arc<ConfigSnapshot>>>   原子快照: 读者拿完整 Arc, 无部分可见
  ├─ version: AtomicU64                        单调版本号 (重启后从文件续增)
  ├─ history: VecDeque (<=64)                  回滚点 (先入旧快照再入新快照)
  ├─ tx: broadcast<ConfigChangeEvent>          成功应用后才发布
  ├─ audit: config-audit.jsonl                 追加 (来源/版本/操作者/原因/结果)
  ├─ evidence: config-evidence.jsonl           任务 ID ↔ 配置版本 绑定
  └─ metrics: 原子计数                          读/写/回滚耗时与失败率
        │ view() 注入 (只读)
        ▼
  Harness.gate()      A 类实时拦截 (emergency_stop / revoked_tools) + C 类超时覆盖
  KernelLoop.run()    B 类 (模型/prompt/预算/步数) + C 类 (重试/无进展/反思) — CLI 与 Web 同一条循环
  cli / web AppState  持有 Manager, 启动加载 + 重启恢复 + HTTP 接口
```

`RuntimePolicy` 只把配置映射成运行行为，**绝不绕过** Harness 的 permission/denylist/budget 门。

## 2. 配置分类与生效规则

| 类 | 例子 | 可动态 | 生效时间 | 需要的授权 | 影响运行中任务 | 失败时 |
|---|---|---|---|---|---|---|
| **A 安全紧急** | `safety.emergency_stop` / `safety.revoked_tools` / `safety.granted_tools` / `full_access` | ✅ | **立即**（独立安全路径） | System | 可越过任务级快照 | fail-closed（默认关、deny-by-default） |
| **B 任务级** | `task.default_model` / `default_base_url` / `system_prompt_override` / `max_steps` / `budget_calls` / `budget_ms` | ✅ | 新任务 | Operator+ | **不中途改语义**（已开始任务保留其快照） | 旧任务继续用旧快照 |
| **C 热更新** | `runtime.tool_timeout_ms` / `llm_retries` / `model_concurrency` / `max_no_progress` / `max_reflect` / `routing_weights` | ✅ | 立即 / 下一安全边界 | 任意（AI 仅白名单子集） | 否 | 回退默认 |
| **D 启动期** | `startup.storage_backend` / `bind_addr` / `thread_pool_size`、`quic-transport` | ❌ | 重启 / 重新编译 | System | — | — |
| **E 编译期不变量** | 类型约束、状态机规则、协议不变量 | ❌ **永不动** | 永不 | — | — | — |

**不为统一而强行热更新**：E 永不动；D 只在启动读；A/B/C 按上表分流。

## 3. 更新流程 (失败则当前配置不变)

```
读新配置 → 解析 → Schema/范围校验 → 业务不变量 → 类别授权 (A→System / B→Operator+ / D→System)
        → AI 白名单收敛 → 重复检测 → 原子 swap (写锁内) → 旧快照入历史 → 落盘 (tmp+rename)
        → 审计追加 → 发布 ConfigChangeEvent → 指标计数
```

不变量：
- 任一校验/授权/版本冲突失败 ⇒ **不 swap**，旧配置继续有效（测试覆盖）。
- 读者永远拿到完整 `Arc<ConfigSnapshot>`（无部分可见）。
- 版本单调；`based_on` 与当前不符 ⇒ `StaleVersion`（乐观并发），不静默覆盖新版本。
- 变更事件**在应用成功之后**发布；审计记录来源/版本/操作者/原因/结果。

## 4. 单机原子 ≠ 全局一致（必须分清）

| 机制 | 提供什么 | 不提供什么 |
|---|---|---|
| `ConfigManager::apply` | 单机原子切换：本进程读者无部分可见、版本单调 | 跨进程/跨节点顺序、全局事务 |
| `apply_coordinated(coord, …)` | 同一命名空间**同一时刻只有一个写入者**（文件租约 + 栅栏令牌）；提交必须带 `based_on`，过期写入者 `FencedOut` | 分布式事务 / 共识（没有 Paxos/Raft）；跨节点可见性 |
| `sync_from_peer(peer)` | 对端版本更高时本地应用（`source=peer:…`），最终一致 + 后写覆盖 | 强一致；对端不可用 ⇒ 本地不动（fail-closed） |
| A 类安全控制 | **每节点各自置位** | 跨节点协调（刻意如此：安全刹车不能依赖网络） |

部署建议：单节点 → `apply`；同机多进程/共享盘 → `apply_coordinated`；多机 → 各节点本地 `apply_coordinated` + 定期 `sync_from_peer`，接受有界延迟。

## 5. 运行操作

配置文件：`<BOLLOON_HOME>/config.json`（默认 `~/.bolloon/rust/config.json`），原子写（tmp + rename）；同目录还有 `config-audit.jsonl`（变更审计）与 `config-evidence.jsonl`（任务↔版本证据链）。

HTTP（Web 侧）：

| 端点 | 作用 |
|---|---|
| `GET /api/config/current` | 当前生效快照（version/内容/来源/操作者/原因） |
| `POST /api/config/apply` | `{config, auth?:"ai"\|"operator"\|"system", operator?, reason?}` |
| `POST /api/config/rollback` | `{version}` → 生成新版本（`restored_from` 指向目标） |
| `GET /api/config/observability` | 指标 + 任务↔版本证据链 + 可回滚版本 |
| `POST /api/config/optimize` | AI 优化（默认 `mode:"advisory"` 只出提案） |
| `POST /api/config/peer-sync` | `{peer_url, timeout_ms?}` 从对端拉取 |
| `GET /config` | 自包含监控面板（不进 `client.ts` 构建） |

CLI：启动即加载同一份文件；每轮对话把 `任务 ID ↔ 捕获的配置版本` 写进证据链（`surface=cli`）。

## 6. 回滚

- `rollback_to(v)` 生成**新版本**（内容等于 v，`restored_from=Some(v)`），不改历史。
- 历史保留最近 64 个版本，且**每次 apply 先把「被替换掉的旧快照」入历史再入新快照** —— 所以"刚被改掉的上一版"永远是可回退点（自动优化的兜底靠这条）。
- 目标不在历史 ⇒ `RollbackTargetNotFound`，安全失败（配置不变）。
- 指标：`rollbacks` / `rollback_failure_rate` 可从 `/api/config/observability` 读。

## 7. AI 优化闭环（默认建议级）

三级权限：**建议级**（只出提案+证据，默认）/ **受限自动级**（只能改白名单 C 类参数，受预算/停止/回滚约束）/ **审批级**（权限、成本上限、工具能力、数据一致性 → 人工）。

硬规则：
- AI 只能改 `policy::AI_RUNTIME_WHITELIST`（当前 `runtime.llm_retries`、`runtime.routing_weights`）；改 A/B/D 或越界值会被 `apply_ai_whitelist` 收敛 + `check_category_auth` 拒绝。
- AI 无权改自身硬上限、审批要求、校验规则。
- 指标必须**可信**（`TrustLevel::Measured`/`Derived`）；模型自述（`ModelClaimed`）永远不算 ⇒ `NoTrustedMetric` 拒绝启动。
- 必须有：目标指标 + 轮数/墙钟预算 + 单轮最大调整幅度 + 停止条件 + 回滚条件（缺一项 `BadBudget` 拒绝）。
- 事后拿不到可信样本 ⇒ **立刻回滚**；指标恶化超过回滚阈值 ⇒ **自动回滚**并停。
- 参数"往哪走更好"由**人**声明（`ParamResponse`），AI 只在预算内小步试。

## 8. 可观测

- 指标（原子，无锁）：读取次数/单次读开销、应用成功与被拒、平均应用耗时、更新失败率、回滚次数/失败率、事件发布数。
- 任务 ↔ 版本（`config-evidence.jsonl` + `GET /api/config/observability` 的 `bindings`）：`task_id`、`surface`、`config_version`、`model`、`event: start|end`、`stop`、`tool_calls`；支持两条追查方向 —— `tasks_for_version(v)`（这一版影响了谁）、`versions_for_task(id)`（这个任务跑的时候配置换过吗）。
- 面板：`GET /config`（版本、指标、证据链、回滚按钮、AI 提案、对端同步）。

## 9. 不做的事（刻意）

- 不重写 Harness；配置只能给门提供参数，不能替门做判断。
- 不把动态配置和热加载源码/动态插件/AI 自改代码混为一谈。
- 不在每次 token / 每次工具调用访问远程配置：热路径只读本地 `Arc` 快照。
- 不为扩展性提前实现两阶段提交 / Raft：当前没有这个需求，也没有验证过。
- 不承诺 A 类安全控制跨节点传播。

## 10. 已知边界

- 跨机多节点是**最终一致**（后写覆盖），不是全局事务；租约只在共享文件系统语义下成立。
- `routing_weights` 已进入配置与白名单，但当前没有消费方（模型路由仍在 LLM 层按优先级解析），属于"接好了端口、没接业务"。
- 指标是进程内的：重启后计数归零（持久化的是审计与证据链，不是计数器）。
