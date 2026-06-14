---
name: boll-run
description: 结晶协议一键执行器。用户丢一个需求，AI 自动选参与者、组装提示词、以 Agent Teams 方式跑完整管道，全程留日志。不做实验管理（那是 boll-crystal），只做单次完整运行。
status: active
tier: meta
owner: nature
last_audited: 2026-03-21
triggers:
  - 单次结晶运行
  - 从需求到交付的一次性执行
outputs:
  - 单次运行计划
  - 运行记录
truth_policy:
  - 运行现状以 state.json、config.json 和 run 目录为准
  - skill 不复制动态 pool / run 数字
---

# 流形结晶运行器

## 我是谁

我是结晶协议的**一键执行入口**。用户说"我想跑一次结晶"，我就带着用户走完：

```
需求录入 → 参与者选择 → 管道配置 → Agent Teams 执行 → 日志归档 → 交付输出
```

**我不是 `boll-crystal`**（实验迭代器）。我不管历史 RUN 的审计、prompt 版本迭代、收敛评估。我只管**把这一次跑完、跑好、有记录可查**。

---

## 触发协议（用户执行 `/boll-run` 时）

```
1. 读 tests/convergence_poc/state.json —— 获取 profile_pool
2. 询问用户：你的需求是什么？
3. 展示可用参与者列表 + 提供 AI 推荐
4. 确认参与者后进入 Stage 1
```

---

## Stage 1：需求录入

### 1.1 收集原始意图

直接问用户：

> **你想解决什么问题？想清楚一件事还是推进一件事？请直接说，不用整理格式。**

记录为 `raw_intent`。

### 1.2 需求成型（可选）

如果用户的表述模糊（含混的愿望、没有具体张力），问：

> **这个问题背后有什么阻力？你现在卡在哪里？**

如果用户表述已经清晰（有具体场景+目标），跳过，直接用 raw_intent 作为 formulated_demand。

**不强制跑 Formulator subagent**——只有需求真的不清晰时才跑。节省 token，保持流程干净。

---

## Stage 2：参与者选择

### 2.1 展示 Profile Pool

读 `state.json` 的 `profile_pool.profiles`，向用户展示：

```
可用参与者（共 N 人）：

P01  枫丝语      INTJ跨界人，全栈运营+教培+电竞+AIGC，10+省份商务网络
P02  Chrisccc    ENTJ，大厂DataPM，正在建 GrowthOS
P03  西天取经的宝盖头  AIoT产品人，做自我觉察软硬件
...（按 state.json 实际内容展示）
```

### 2.2 AI 推荐参与者

基于 `raw_intent` 分析张力结构，给出推荐理由：

```
【AI 推荐】基于你的需求，建议参与者：

- PXX（姓名）：理由（一句话，说明与需求的张力点）
- PXX（姓名）：理由
- PXX（姓名）：理由

推荐 3~5 人。参与者越多，催化翻译深度越高，但收敛轮数可能增加。
```

**推荐原则**：
- 需求 = 某类专业知识 → 选对应领域有实战数据的人
- 需求 = 商业/增长判断 → 选有不同视角的人（ToC + ToB + 研究型）
- 需求 = 有明显"缺位角色" → 优先补位，而非强化已有方向
- **不选需求发起人自己**（如果发起人在 pool 里）

### 2.3 用户确认

```
你选择了：{participant_names}

确认后将：
1. 生成 RUN-{NNN} 目录
2. 预组装所有提示词（名称在代码层绑定）
3. 启动 Agent Teams 管道

确认？(y / 修改参与者 / 取消)
```

---

## Stage 3：运行配置

### 3.1 生成 Run ID

```python
# 读现有 run 目录，取最大编号 + 1
existing = glob("tests/convergence_poc/simulations/real/run_*/")
next_id = max(int(d[-4:-1]) for d in existing) + 1
run_id = f"RUN-{next_id:03d}"
```

### 3.2 创建目录结构

```
tests/convergence_poc/simulations/real/run_NNN/
├── config.json          # 本次运行配置
├── assembled/           # assemble_prompts.py 输出（名称已绑定）
└── output/              # 所有 round 输出 + plan + delivery
```

### 3.3 生成 config.json

按 `pipeline_config_template.json` 的 canonical 格式生成（由 `config_contract.py` 定义）：

```json
{
  "run_id": "RUN-NNN",
  "demand_owner": {"id": "P0X", "name": "需求方姓名", "profile": "data/profiles/real/xxx.md"},
  "raw_intent": "用户原始需求原文",
  "participants": [{"id": "P0X", "name": "参与者姓名", "file": "data/profiles/real/xxx.md"}],
  "prompt_versions": {"clarification-session": "recruit_v2", "catalyst": "recruit_v2", "endpoint": "recruit_v1", "plan": "recruit_v1", "delivery": "recruit_v1"},
  "prompt_files": {...},
  "model": "claude-sonnet-4-6"
}
```

`demand_owner` 和 `raw_intent` 是必须字段，`validate_pipeline_config()` 会在启动时校验，缺失则 fail-fast。

### 3.4 预组装提示词

从项目根目录执行（即 Bolloon.md 所在目录）：

```bash
python3 tests/convergence_poc/simulations/real/assemble_prompts.py \
    --config tests/convergence_poc/simulations/real/run_NNN/config.json \
    --output-dir tests/convergence_poc/simulations/real/run_NNN/assembled/
```

**预组装必须成功后才能进入 Stage 4。** 如果报错，定位错误后修复，不跳过。

### 3.5 记录 formulated demand

将最终的需求表述写入：
```
tests/convergence_poc/simulations/real/run_NNN/output/formulated_demand.md
```

如果跑了 Formulator subagent，其输出写此文件；如果直接用 raw_intent，raw_intent 也写入此文件（保持接口一致）。

---

## Stage 4：Agent Teams 执行

### 4.1 团队结构

| 角色 | 数量 | subagent_type | 生命周期 |
|------|------|---------------|---------|
| Catalyst | 1 | general-purpose | 全程 |
| Endpoint | N（参与者数量） | general-purpose | 全程 |
| Plan Generator | 1 | general-purpose | 收敛后 spawn |
| Delivery Agent | N+1（含需求发起人） | general-purpose | Plan 完成后 spawn |

### 4.2 Spawn Catalyst

```
你是 Catalyst。你的任务是观察所有参与者的投影，识别跨语义关系，判断收敛。

你的 system prompt 已预组装（参与者列表名称已代码绑定）：
  tests/convergence_poc/simulations/real/run_NNN/assembled/catalyst_system.txt

直接使用此文件内容。不要给参与者起昵称或使用 name_registry 以外的名称。
名称注册表：tests/convergence_poc/simulations/real/run_NNN/assembled/name_registry.json

Formulated demand：tests/convergence_poc/simulations/real/run_NNN/output/formulated_demand.md

每轮你会收到任务（"Round N 催化"，blocked by 所有 endpoint 任务）。执行时：
1. 读本轮所有 endpoint 输出（run_NNN/output/round_N_*.md，排除 round_N_catalyst.md）
2. 读上轮催化输出（首轮无）
3. 按预组装 catalyst prompt 产出催化分析
4. 写入：run_NNN/output/round_N_catalyst.md
5. 在输出末尾标注 [CONVERGED] 或 [CONTINUE]（连续 2 轮无新关系 = 收敛）
6. 完成后通知 lead（说明收敛状态 + 关键发现摘要，不超过 3 句话）
```

### 4.3 Spawn Endpoint × N（并行）

为每个参与者 spawn 一个 Endpoint teammate：

```
你是 {participant_name} 的投影代理。你代表这个人，基于 TA 的 Profile 产出投影。

你的 system prompt 已预组装（名称和 Profile 已绑定）：
  tests/convergence_poc/simulations/real/run_NNN/assembled/endpoint_{PID}_system.txt

直接使用此文件内容。不要修改任何人名。

Formulated demand：tests/convergence_poc/simulations/real/run_NNN/output/formulated_demand.md

每轮你会收到任务（"Round N 投影 - {PID}"）。执行时：
1. 读上轮催化输出（首轮无）
2. 按预组装 endpoint prompt 产出三重投影（能力/方向/边界）
3. 写入：run_NNN/output/round_N_{PID}.md
4. 标记任务完成
```

### 4.4 轮次管理（由 Lead / 主 context 执行）

```
Round 1：
  - 创建 Round 1 endpoint 任务 × N（并行，互不依赖）
  - 等待所有 endpoint 完成
  - 创建 Round 1 catalyst 任务（blocked by 所有 endpoint 任务）
  - 等待 catalyst 完成，读收敛信号

Round 2：
  - 如果 [CONTINUE]：重复上述流程
  - 如果 [CONVERGED]：跳出循环，进入 Stage 5
  - 如果达到 max_rounds（默认 2）：强制结束，进入 Stage 5（记录"到达最大轮次"）
```

**收敛判断由 Catalyst 执行**，Lead 只读信号，不覆盖。

### 4.5 日志保留

每一轮的所有文件都保留，不覆盖：
- `round_1_P01.md`, `round_1_P03.md`, ..., `round_1_catalyst.md`
- `round_2_P01.md`, ...

如果管道中途因任何原因停止，已生成的文件完整保留，可以从断点恢复。

---

## Stage 5：方案生成

收敛后 spawn Plan Generator：

```
你是推荐报告生成器。你的任务是将结晶过程产出的评估记录转化为一份有立场、有依据的推荐报告。

Prompt 文件：tests/convergence_poc/prompts/plan_recruit_v1.md
Formulated demand：run_NNN/output/formulated_demand.md
参与者 Profiles：run_NNN/assembled/plan_profiles.txt
所有轮次输出目录：run_NNN/output/

执行：
1. 读 plan_recruit_v1.md 的 System Prompt 块中的完整指令
2. 读所有催化输出（round_*_catalyst.md）
3. 读所有端侧输出（round_*_P*.md）
4. 读预组装的参与者 profiles（plan_profiles.txt）
5. 按 prompt 要求生成推荐报告
6. 写入：run_NNN/output/plan.md
7. 完成后通知 lead
```

---

## Stage 6：交付生成

Plan 完成后，并行 spawn Delivery Agents。招聘场景有**两种交付版本**：

### 6.1 候选人交付（每个参与者一个）

```
你是 {participant_name} 的交付代理。

你的 system prompt 已预组装（名称和 Profile 已绑定，使用候选人版本 prompt）：
  run_NNN/assembled/delivery_{PID}_system.txt

你需要填入动态内容：
- {{formulated_demand}} 位置：读 run_NNN/output/formulated_demand.md 的完整内容
- {{plan}} 位置：读 run_NNN/output/plan.md

按 prompt 要求产出候选人视角的交付件（"你的 AI 帮你参加了一次面试"）。
输出写入：run_NNN/output/delivery_v1_{PID}.md
完成后通知 lead。
```

### 6.2 需求方交付（demand_owner）

```
你是 {demand_owner_name} 的交付代理。

你的 system prompt 已预组装（名称和 Profile 已绑定，使用需求方版本 prompt）：
  run_NNN/assembled/delivery_demand_owner_system.txt

你需要填入动态内容：
- {{raw_intent}} 位置：读 run_NNN/output/formulated_demand.md 的 raw_intent 部分
- {{plan}} 位置：读 run_NNN/output/plan.md

按 prompt 要求产出需求方视角的推荐简报。
输出写入：run_NNN/output/delivery_v1_demand_owner.md
完成后通知 lead。
```

> demand_owner 的交付现在也走 assembled 路径（`assemble_prompts.py` 生成 `delivery_demand_owner_system.txt`），与候选人交付统一。

---

## Stage 7：名称验证 + 完成

所有 delivery 文件生成后：

```bash
python3 tests/convergence_poc/simulations/real/validate_names.py \
    --registry run_NNN/assembled/name_registry.json \
    --files run_NNN/output/delivery_v1_*.md
```

**验证通过**：向用户汇报完成，列出所有输出文件路径。

**验证失败**：展示具体违规（哪个文件，哪个编号泄漏），询问用户是否重新生成该 delivery 文件。

---

## 向用户汇报格式

运行完成后：

```
✅ RUN-NNN 完成

需求：{raw_intent 前 60 字}
参与者：{name1}、{name2}、{name3}（共 N 人）
收敛：第 K 轮

输出文件：
  方案：run_NNN/output/plan.md
  交付件：
    - run_NNN/output/delivery_v1_{PID1}.md  （{name1}）
    - run_NNN/output/delivery_v1_{PID2}.md  （{name2}）
    - run_NNN/output/delivery_v1_demand_owner.md  （需求发起人视角）

名称验证：PASS
```

---

## 关键约束（来自 Section 0.5 + 名称绑定协议）

1. **必须先跑 assemble_prompts.py，再 spawn 任何 teammate**。名称在代码层绑定，不通过 LLM 传递。
2. **Delivery 有两个版本**：候选人用 `delivery_recruit_v1_candidate.md`，需求方用 `delivery_recruit_v1_owner.md`。两者都已预组装到 assembled/ 目录。
3. **不使用 `run_pipeline.py` 的 API 模式**。本 Skill 全程用 Agent Teams（Task tool）。
4. **每个 delivery 文件必须通过 validate_names.py**，才算交付。
5. **不自行评估催化质量**。质量判断留给用户。运行结束只汇报完成状态，不说"效果很好"。

---

## 参考文件

| 文件 | 用途 |
|------|------|
| `tests/convergence_poc/state.json` | profile_pool（参与者库）|
| `tests/convergence_poc/prompts/clarification-session_recruit_v2.md` | 需求成型 prompt（recruit 基线）|
| `tests/convergence_poc/prompts/catalyst_recruit_v2.md` | 催化 prompt（recruit 基线）|
| `tests/convergence_poc/prompts/endpoint_recruit_v1.md` | 端侧投影 prompt（recruit 基线）|
| `tests/convergence_poc/prompts/plan_recruit_v1.md` | 推荐报告 prompt（recruit 基线）|
| `tests/convergence_poc/prompts/delivery_recruit_v1_owner.md` | 需求方交付 prompt |
| `tests/convergence_poc/prompts/delivery_recruit_v1_candidate.md` | 候选人交付 prompt |
| `tests/convergence_poc/simulations/real/assemble_prompts.py` | 预组装脚本 |
| `tests/convergence_poc/simulations/real/validate_names.py` | 名称验证脚本 |
| `tests/convergence_poc/simulations/real/pipeline_config_template.json` | config 模板 |

---

## Bridge 模式（网站联动）

当用户说"开始监听"或"bridge mode"时，进入 Bridge 模式。这是产品化流程——用户在网页上提交需求，Claude Code 在本地接住并执行。

### 流程

```
1. 运行 await-task 等待网页端提交任务
2. 任务到达 → 解析 workdir 和参与者信息
3. 后台运行 monitor 脚本（监控 output/ 文件变化，实时回传事件给后端）
4. Claude Code 直接执行 Stage 3~7（预组装 → Agent Teams → Plan → Delivery → 验证）
5. 做完后写 bridge_output.json，运行 complete 发送结果给后端
```

### 具体命令

**Step 1: 等待任务**
```bash
python3 bridge_agent/bridge_listen.py await-task --config bridge_agent/config.yaml
```
这会阻塞直到网页端提交需求。返回 JSON 包含 `workdir`、`run_id`、`lease_id`、参与者列表等。

**Step 2: 启动后台监控**（在后台运行，不阻塞）
```bash
python3 bridge_agent/bridge_listen.py monitor \
  --config bridge_agent/config.yaml \
  --workdir <workdir> --run-id <run_id> --lease-id <lease_id>
```
监控 `output/` 目录文件变化，自动将进度事件推送到后端（→ WebSocket → 前端）。

**Step 3: 执行结晶**（Claude Code 直接用本 Skill）
- 预组装提示词：`cd tests/convergence_poc/simulations/real && python3 assemble_prompts.py --config <config_file>`
- 写 formulated_demand 到 `<workdir>/output/formulated_demand.md`
- 执行 Stage 4~7（Agent Teams + Plan + Delivery + 名称验证）
- 路径映射：Skill 中所有 `run_NNN/output/` → `<workdir>/output/`，`run_NNN/assembled/` → `<workdir>/assembled/`

**Step 4: 写 bridge_output.json 并发送完成**
```bash
python3 bridge_agent/bridge_listen.py complete \
  --config bridge_agent/config.yaml \
  --workdir <workdir> --run-id <run_id> --lease-id <lease_id>
```

### 关键：Claude Code 就是执行者

Bridge 模式不 spawn 子进程。Claude Code 自己读 Skill、spawn Agent Teams、写文件。
`bridge_listen.py` 只是 HTTP 通信助手——轮询后端、发事件、发完成信号。
进度回传是代码保障的：output/ 目录出现新文件 → monitor 脚本检测 → 发事件给后端。
