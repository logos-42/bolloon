# 内部商议群 · 警长制 + 持续交流 + 任务分派 设计

日期：2026-10-29
状态：M1–M4 已落地（见文末「本版实现」）

## 1. 需求与共识（与用户逐条敲定）

| 议题 | 结论 |
|---|---|
| 警长怎么产生 | 底层智能体民主选举，参照人民代表大会制度；五特质从历史算加权总分 → **计分直选**最高分者当选（开页即算，不在交流中重算） |
| 五特质计分源 | **混合**：确定性指标为主轴（任务完成率/被采纳建议/矛盾率/助人次数…），LLM 仅对少数主观项（正直/善良/远见）校准兜底 |
| 持续交流 / 终止 | **用户驱动 + 警长自驱**：用户发消息→全员并发；无人发言且沉默超时→警长自驱开新一轮；**任何智能体（含警长）可声明终止**，群回待命 |
| 任务来源 | **混合（用户 + 警长）**：用户可下指令，警长也可在自驱轮次主动派任务；智能体后台执行、只把汇报入群 |
| 发言顺序 | 警长决定顺序，**默认并发**；用户说完话后所有智能体并发 |
| 群内定位 | 群里**只汇报不跑进程**；智能体后台跑任务，在群里完成交流 |

## 2. 架构分层（遵循 AGENTS.md §8：Kernel 机制 + 端口、fail-closed、纯函数决策）

| 能力 | 落点 | 说明 |
|---|---|---|
| 五特质模型 + 计分直选 | `bolloon-agent::character`（Domain，纯函数 + 单测） | 新增；复用 `judgeness` 的「评分结构」模式，维度不同 |
| 选举时机 / 结果暴露 | `bolloon-web::native`（接线） | `elect_group_sheriff` 调 character，结果存 `forge.sheriff_by_group`，`room()` 仅返回当选者 |
| 持续监督 / 终止 / 任务 | `bolloon-web::room_bus::RoomSupervisor`（Kernel 机制） | 复用 `spawn_reports`；控制标记 `[[terminate]]` / `[[task:id:desc]]` |
| 警长越权 | `bolloon-harness::role`（能力门禁） | 新增 `Role::{Member,Sheriff}` + `Capability::{OwnDocs,ReadAnyAgentDoc,WriteAnyAgentDoc,FullFs}`，`can_access_doc` 纯判定 |
| 前台只显结果 | `index.html` | 警长显示在状态栏（复用既有 🎖️ leader 徽章），特质分不出行 |

## 3. 数据模型

- `CharacterTraits { integrity, kindness, capability, responsibility, foresight: f64 }`（0–1）
- `HistoryStats { judgments, avg_confidence, contradictions, intents, intents_adopted, helps }`
- `forge.sheriff_by_group: HashMap<group_id, agent_id>`（后端，不序列化给前端）
- `RoomBus.last_human_ms: HashMap<group_id, u64>`（监督器沉默计时）

## 4. 特质计分（混合，后台隐藏）

- 确定性主轴（免模型、可单测）：
  - 能力/责任 ← judgment 产出量 + 平均置信
  - 远见 ← 意图提出与被采纳数
  - 正直 ← 矛盾率（取自 `judgment` 状态字段，复用 `judgment.rs` 矛盾检测语义）越低越高
  - 善良 ← 协作/助人计数（确定性拿不准给中性，交 LLM 校准）
- 数据源：每智能体 `archive/judgment` 与 `archive/intents`（`bolloon-web::archive` 落点）。
- LLM 校准端口：预留 `LlmPort` 注入点，仅兜底主观项（本版热路径走确定性，未强制调模型）。

## 5. 选举

- `elect_sheriff(scores)`：加权总分最高者当选；平局取首现；空表 → `None`（fail-closed，不臆造）。
- 时机：点「发起交流」或打开群页面时各算一次，结果缓存进 `forge`。

## 6. 警长权限（Harness 门禁）

- `Role::Sheriff` 拥有 `ReadAnyAgentDoc` / `WriteAnyAgentDoc` / `FullFs`，普通 `Member` 只有 `OwnDocs`。
- `can_access_doc(role, target_is_self, write)` fail-closed：默认拒越权。
- 落实「对其他内部智能体负有责任与义务，但具备更多权限（含读写其内部文档）」的判定层。

## 7. 持续交流 + 终止（RoomSupervisor）

- 用户发消息 → `group_say` 标记人类发言 + `spawn_reports` 全员并发。
- 监督器：本轮最后一个智能体完成（`group_idle`）且群仍 `running` 且距人类发言沉默 ≥ `SUPERVISOR_IDLE_MS`（15s）→ `continue_round` 自驱下一轮（警长统筹，全员并发）。无限推进，由终止信号收尾，避免忙等。
- 终止：任意智能体汇报含 `[[terminate]]` → 去掉标记、落 `system` 消息「X 宣布散会」、置 `running=false`。

## 8. 任务（混合：用户 + 警长）

- 警长汇报含 `[[task:<智能体id或名字>:<描述>]]` → 解析后把任务分给对应成员，后台 `spawn_reports` 执行，仅汇报入群（群里只交流不跑进程）。
- 用户指令：走既有 `group_say` 自然触发对应智能体。

## 9. 前端

- `room()` 返回 `sheriff` / `sheriff_name`，并回填 `state.leader_agent_id`（复用既有 🎖️ 徽章）。
- 状态栏显示「👮 警长：X · 持续交流中 · 警长统筹，全员并发」。
- `system` 类消息（散会通知）居中提示渲染。
- 发起交流默认选中前两个智能体（已有）。

## 10. 本版实现（M1–M4 已落）

- M1 ✅ `bolloon-agent::character`（特质/计分/选举 + 6 单测）、`forge.sheriff_by_group` 接线、`room()` 暴露。
- M2 ✅ `bolloon-harness::role`（能力模型 + 3 单测）。
- M3 ✅ `room_bus` 监督器：`SUPERVISOR_IDLE_MS` 自驱、`[[terminate]]` 终止、`group_idle`/`mark_human`/`last_human_ms`；`parse_control` + 2 单测。
- M4 ✅ `[[task:id:desc]]` 任务分派 + 后台执行 + 汇报（同 `spawn_reports`）。
- 前端 ✅ 警长显示 / 持续交流文案 / 系统消息渲染。

## 11. 待深化（非阻塞，后续迭代）

- M2 越权**落地**：在 AgentDocs 读取点（web/agent 装载）接 `can_access_doc` 校验，使警长真正能读写他人内部文档；本版仅建判定层。
- LLM 校准：把 `LlmPort` 校准接到 `score_agent` 的主观项（正直/善良/远见）。
- 选举可解释性：前端可选显示「计分依据摘要」（仍不暴露原始分）。

## 12. 验证

- `cargo test -p bolloon-agent --lib character`：6 passed
- `cargo test -p bolloon-harness --lib role`：3 passed
- `cargo test -p bolloon-web --lib room_bus`：6 passed
- `cargo check -p bolloon-web`：通过（仅 1 个与本次无关的预存 warning：`archive::today` 未使用）
