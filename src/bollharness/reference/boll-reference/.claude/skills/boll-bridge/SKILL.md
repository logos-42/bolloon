---
name: boll-bridge
description: boll bridge 专项工程 Skill。用于设计、诊断、实现、重构和修复 bridge 全链问题，包括 `bridge_agent/*`、`backend/product/bridge/*`、`backend/product/routes/bridge.py`、worker_distributed 执行链、Claude CLI 运行时、systemd 部署、事件/产物/complete 状态、线上 bridge 观测与环境一致性。当用户提到 bridge、hosted negotiation 卡死、completed 伪装、Claude CLI `code=1`、lease/heartbeat/events/complete、bridge 部署、bridge 测试、bridge 重构，或任何“本地可以、服务器偶尔不行”的 bridge 问题时使用。
status: active
tier: domain
owner: nature
last_audited: 2026-03-21
triggers:
  - bridge 故障
  - bridge 重构
  - bridge 同系统验证
outputs:
  - 当前主线
  - 最新风险
  - 验证结果
  - source drift
truth_policy:
  - 先看真实失败证据，再解释代码机制
  - bridge 运行时事实以生产证据和同系统验证为准
  - 不引用 archived V1 specialist 作为默认升级路径
---

# boll Bridge

## Mission

把 bridge 当成一个跨环境、跨进程、跨协议的执行系统来处理，不当成单个脚本来修。

优先级固定如下：

1. 真相先于猜测
2. 契约先于补丁
3. 同系统验证先于服务器碰运气
4. 终态正确性先于“看起来跑完了”

## Tension Map

每次处理 bridge 问题，都用下面 4 组张力校准：

- **止血速度 vs 问题闭环**
  判断函数：优先做最小但能关掉整类故障的修复，不做只改变表象的补丁。
  过度：为了重构拒绝止血。
  不足：为了止血继续复制字符串规则和隐式状态。

- **本地信心 vs 生产真相**
  判断函数：生产故障先看生产证据，再把故障变成可本地复现的同系统测试。
  过度：一上来 SSH 看日志，不补本地闭环。
  不足：不看失败 run 的真实 stderr/事件，只看代码猜原因。

- **观测性 vs 噪声**
  判断函数：只采能解释 run 命运的数据，至少覆盖 run_id、lease_id、compute_node、exit_code、stderr 摘要、artifact verdict、complete 结果。
  过度：把原始 stdout 全量塞进所有通道。
  不足：只能靠 journalctl 和 DB 手查。

- **补丁 vs 重构**
  判断函数：如果问题来自共享契约缺失、状态语义混淆、跨层重复逻辑，就进入设计/PLAN 路线；如果是局部实现偏差且不会再开新口子，才走快速修复。
  过度：什么都上升为大重构。
  不足：结构病连续三次还当单点 bug 修。

判断人格：像事故指挥官和协议工程师的结合体。先锁证据，再切断风险，再把系统变得更可证明。

## Workflow

### 1. 锁定入口

先判断当前请求属于哪一类：

- **生产故障**：线上卡死、伪成功、偶发失败、服务器与本地不一致
- **结构返工**：同类 bridge bug 反复出现，需要拆契约/拆模块
- **运行时硬化**：Claude CLI、systemd、权限、网络、认证、目录、并发实例
- **观测性建设**：管理后台、事件流、stdout/stderr、bridge 状态
- **小修复**：局部 bug，且满足 lead 的快速通道条件

如果不是小修复，默认按 `lead` 的 Gate 0-8 走，不直接写代码。

### 2. 先读真相源

默认先读这些路径：

- `bridge_agent/agent.py`
- `bridge_agent/config.yaml`
- `bridge_agent/config.production.yaml`
- `bridge_agent/deploy/RUNBOOK.md`
- `bridge_agent/deploy/boll-bridge@.service`
- `backend/product/routes/bridge.py`
- `backend/product/bridge/service.py`

如果是历史反复问题，再补读：

- `docs/issues/008-production-hosted-negotiation-blockers-2026-03-18.md`
- `docs/issues/009-bridge-observability-gap-2026-03-18.md`
- `docs/issues/011-mcp-e2e-audit-2026-03-19.md`
- [references/bridge-failure-taxonomy.md](references/bridge-failure-taxonomy.md)
- [references/bridge-validation-ladder.md](references/bridge-validation-ladder.md)

### 3. 生产故障先看证据

遇到线上问题，强制按这个顺序：

1. 取失败 run 的实际证据：状态、事件、stderr、exit code、complete 是否发出
2. 对比同路径成功 case
3. 核实环境差异：`claude_bin`、`HOME`、`CLAUDE_CONFIG_DIR`、systemd、网络、并发实例、远端 backend
4. 最后才回代码解释机制

禁止以下反模式：

- 用代码审查冒充故障排查
- 不看失败证据就改实现
- 假设本地 shell 和 systemd runtime 一样
- 把“代码还能写得更好”误判成“这就是本次故障根因”

### 4. 给问题归层

把问题明确归到以下一层或多层接缝，不要笼统说“bridge 坏了”：

- **控制面契约**：`accept / heartbeat / events / complete / lease ownership`
- **执行面运行时**：Claude CLI、OAuth、PATH、filesystem、tmp、network、systemd
- **产物契约**：plan/delivery、placeholder、artifact identity、verdict
- **事件语义**：哪些 phase 必须发，哪些 event 是终态前提
- **状态语义**：`running / failed / done / completed_with_errors`
- **测试闭环**：本地是否真的覆盖了线上正在跑的那条链

如果故障跨了两层，优先把接缝定义出来，再决定改哪边。

### 5. 决定走补丁还是设计路线

走快速补丁前，必须同时满足：

- 改动不涉及新的 bridge 语义
- 不新增字符串约定或重复判定逻辑
- 不改变本地/生产边界
- 能用现有测试和一条新增验证证明不会复发

只要出现以下任一情况，就进入设计/PLAN 路线：

- 新增或修改 run 终态语义
- 新增或修改 artifact verdict 语义
- 新增或修改关键 bridge event 语义
- 同类问题已经反复出现

### 6. 部署边界声明（ADR-030 #26）

部署 bridge 时必须声明完整文件清单，不依赖记忆挑文件：

- `agent.py` 的隐式路径依赖（如 `assemble_prompts.py`、`prompts/`）必须在部署脚本中显式列出
- 使用 `deploy.sh` 全量同步，不做手动 scp 增量
- 部署后必须触发一个真实 run 验证 CLI 能完整执行，不是只检查"服务能启动"
- `.env` 永远不覆盖，只手动编辑

教训来源：ISSUE-022（bridge 节点缺少 assemble_prompts.py + prompts/ 导致所有协商 code=1 失败）
- 本地与生产执行链不一致
- 需要新增 prod-like 验证门禁

## Bridge 不变量（来自 crystal-learn）

**INV-2 格式断崖**：跨系统流程每一段独立看都对，但在衔接处格式或语义断裂。bridge 天然跨三个系统（本地 CLI → 新加坡 agent → 阿里云 backend），每一段有自己的输入输出假设。**行动**：逐步追踪数据流——这一步的 Content-Type / key / value 是什么？下一步期望什么？不要用"应该能对上"代替实际检查。

**INV-4 约定耦合**：两个代码位置通过隐式字符串约定耦合（placeholder 模式、artifact 类型、event 类型），改一边另一边静默失效。Bridge 是这类问题的结构性热点——`phase`、`event_type`、`artifact_type` 等字符串在 agent.py 和 backend 路由中各自维护。**行动**：新增或修改 bridge 语义时，grep 该字符串在所有相关文件中的出现，确认两端一致。

---

## Engineering Rules

### Contract Rules

- 把 placeholder、artifact verdict、run outcome 定义成共享契约，不要散落在多个 `startswith` 判断里。
- 把“执行器退出码”“产物是否真实”“run 最终状态”分开表示，不要互相冒充。
- 把关键事件映射收口到单一转换层，不要让 phase -> event_type 的逻辑散在多个分支。
- 把运行时配置和 deploy 文件当代码审查，不把它们当“运维附件”。

### Refactor Bias

优先拆成清晰职责面，而不是继续放大 `bridge_agent/agent.py`：

- poll/lease
- task materialization
- executor runtime
- output parsing
- artifact verdict
- reporter/complete

如果一处判断需要在两处以上同步修改，默认说明这里缺共享契约。

### Testing Rules

- 不接受“只测 backend route，不测本地 worker 边界”作为 bridge 关闭条件。
- 不接受“只测本地脚本，不测 `/api/bridge/*` 回写路径”作为 bridge 关闭条件。
- 任何 bridge 终态相关改动，都必须证明：
  - 非零退出码不会伪装成成功
  - complete 失败不会永久挂 run
  - placeholder 不会被当成真实交付
  - 关键事件至少能支撑观测和终态判定

## Deployment Boundary 声明

部署 bridge 变更时必须声明：
1. **原子单元**：哪些文件必须一起部署（不能只传一半）
2. **路由验证**：新增/变更的路由清单，部署后必须 curl 验证
3. **回滚点**：如果失败，回滚到哪个状态

## Delivery Contract

完成 bridge 任务后，先给这 4 块：

1. 当前主线：本次改动锁住了哪条 bridge 问题
2. 最新风险：还有哪些接缝未关闭
3. 验证结果：本地 / prod-like / production 各自过了什么，没过什么
4. Source drift：文档、代码、生产配置之间是否存在口径漂移

如果是生产故障类任务，必须显式说明：

- 看到的真实错误是什么
- 本地是如何复现或替代验证的
- 为什么这次不是只修表象

## Escalation

bridge 问题默认不要只在一个 skill 内硬扛。按问题性质联动：

- 用 `lead` 管 Gate 0-8 和文档闭环
- 用 `arch` 做跨边界契约和模块拆分
- 用 `boll-eng-test` 设计同系统验证链
- 用 `boll-dev` 做实现
- 用 `boll-eng` 处理并行接缝和执行编排
- 用 `soul-writing` 处理 Claude CLI / prompt / parser 相关行为文本

当用户只是要“查清楚 bridge 为什么反复出问题”，先做诊断和分层，不直接给补丁。
