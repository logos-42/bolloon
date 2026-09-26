# Wiki 索引

> Bolloon 项目的持久化共识存储。每个 session 启动时读 `current-status.md` 即可恢复上下文,详细规则看 SCHEMA.md.

## 8 个标准页

| 页 | frontmatter | 用途 |
| --- | --- | --- |
| [README.md](./README.md) | (none) | 范式 + 自检命令 |
| [SCHEMA.md](./SCHEMA.md) | (none) | v1/v2 双 schema 完整文档 |
| [project-overview.md](./project-overview.md) | v2 | 一句话定义 + 主线目标 + 交付边界 + 技术栈 |
| [current-status.md](./current-status.md) | v2 | 已支持 / 未支持 / 线上状态 / 风险 / 优先级 |
| [sources-and-data.md](./sources-and-data.md) | v2 | 数据分层 + raw 清单 + 隐私脱敏 + 数据流图 |
| [github-and-raw-strategy.md](./github-and-raw-strategy.md) | v2 | GitHub / 本机 / dist 三层分工 + workflow |
| [runtime-profile.md](./runtime-profile.md) | v2 meta | 校验脚本 CI/dev-only 矩阵 + ablation runner 状态 |
| [skills-index.md](./skills-index.md) | v2 meta | 35 个全局 skill 索引 + 触发词映射 |
|| [crystallized-claims.md](./crystallized-claims.md) | v2 claim | 4 条从 ablation 蒸馏的稳定断言 |
|| [bolloon-md-template.md](./bolloon-md-template.md) | v2 | 4 级 Bolloon.md 模板 (双栖 agent 网络对外协作偏好) |
|| [bolloon-bug-report-20260716.md](./bolloon-bug-report-20260716.md) | v2 | 10 个历史 Bug 状态一览 (2026-07-16 报告) |
|| [claude-code-design-parallels.md](./claude-code-design-parallels.md) | v2 | Claude Code 架构对照 Bolloon 参考 |
| [hermes-agent-architecture.md](./hermes-agent-architecture.md) | v2 | Hermes Agent 架构借鉴 (多智能体协作/生命周期/工具循环/状态语义/workspace kinds) |
| [android-agent-runtime.md](./android-agent-runtime.md) | v2 | Android Agent Runtime 架构 (Phase 1-4: Accessibility/Shizuku/本地LLM/Agent OS) |
| [agent-economic-protocol.md](./agent-economic-protocol.md) | v2 | Agent Economic Protocol 设计 (7 协议 + bolloon 映射 + Registry/x402/Policy MVP) |
| [durable-run-protocol.md](./durable-run-protocol.md) | v2 | Durable Run 协议 (Goal→Run→Checkpoint→Recovery 状态机 + 字段协议 + 现状盘点 + 六阶段完成度台账) |
| [model-selection-protocol.md](./model-selection-protocol.md) | v2 | 模型选择协议 (统一入口 + 有效模型配置 + 五层优先级 + 每 Run 快照 + 命令面 + 验收矩阵) |
| [model-selector-p2.md](./model-selector-p2.md) | v2 | 模型分步选择器 + **冻结的模型元数据接口** (七步流程 · P3/P5 唯一填充点 · 未知语义 · 三条遗留结清 · 并行名册) |
| [model-url-chain.md](./model-url-chain.md) | v2 | **探测原语** (独立, 未接线): API URL 四层解析 (显式 > 配置 > 供应商默认 > 环境变量) + 规范化合并重复 `/v1` + 六步探测 (协议形状/连接/模型接口/工具调用) + **失败七类** (`invalid_url`·`auth_failed`·`provider_unreachable`·`model_not_found`·`protocol_mismatch`·`tool_call_unsupported`·`timeout`) + 三条硬规则 (不静默退回默认/失败不当成功/凭证不进返回值) + 真跑 50/0 与 4 条变异判红 |
| [access-protocol-v1.md](./access-protocol-v1.md) | 外部接入协议 v1 (P1 冻结): 版本策略 + JSON 信封 + 错误码表 + 状态映射 + local-dev 红线 | current |
| [agent-access-layer.md](./agent-access-layer.md) | Agent 接入层: CLI 为主协议 · MCP 为薄适配 · Skill 为使用说明 (含六阶段落地状态) | current |
| [task-protocol.md](./task-protocol.md) | bolloon-task/1 任务协议: 14 态状态机 + 支付事实分离 + 受控自主签名闸 + 签名审计 + 公开投影 | current |
| [chain-settlement-design.md](./chain-settlement-design.md) | **链上化设计 v2**(设计): 数据权威划分 + AgentEscrow 主路径 + AgentDirectory 注册承诺 + 连接层八模块 + 五条上链硬规则 | draft |
- [long-term-collaboration-plan.md](long-term-collaboration-plan.md) — 长期合作方案 —— 用 Bolloon 托管"可核验的研究委托" (交付物标准 / 验收协议 / 结算 / 接单通道缺口)
| [chain-model-freeze.md](./chain-model-freeze.md) | **链上模型冻结 (P1)**: 合约盘点(Foundry/Hardhat/Solana 三项目) + AgentEscrow 主合约缺口 11 字段 + Treasury onlyOwner 边界 + Directory 新增/Ledger 不新增 + 事件与 hash 切径冻结 + chainId/token/确认数 + §3 五条硬规则差距表 + 必须先改清单 | current |
| [network-ledger-design.md](./network-ledger-design.md) | **Bolloon Network Ledger**(设计): 签名区块 DAG + 三层最终性 + 账本重放派生 Pulse/任务/交易 + Explorer 增量加载 | draft |
| [pulse-ledger-design.md](./pulse-ledger-design.md) | 链式活动账本 + 链上锚定 (设计计划): 哈希链/Merkle 根/最终性/由链派生的公开投影/跟区块头轮转 | proposed |
| [network-pulse.md](./network-pulse.md) | v1 (2026-09-22 加 `confirmed_activity`; **2026-09-24 顶部计数逐字段定源**) | **网络脉冲**: 匿名可验证的公开观察投影 (事件白名单 · 去重 · 隐私阈值 · live/stale/unavailable · `GET /api/public/network/progress` · **冻结形状 `confirmed_activity` = 真实任务/链上活动行, 来源 chain-index/pulse-events/none**) · **`totals_scope.fields` 逐字段口径 + 「无源 = null = 页面写未接入」+ 同一概念不变量门 (顶部计数 vs 表格)** |
| [m1-m4-closure.md](./m1-m4-closure.md) | v1 | **M1–M4 收口验收口径**(冻结): 四个唯一事实来源 + 四条不可违反规则 + 5 个用户态口径 + 跨里程碑验收矩阵 + 失败→出口映射 |
| [product-core-focus.md](./product-core-focus.md) | v1 | **产品核心收缩**: 一句话核心承诺 + 五步闭环 + 三问过滤器 + 冻结清单(不改代码) + M1-M4 路线图 + M1 真实差距 |
| [facilitator-paths.md](./facilitator-paths.md) | v1 | facilitator 协议路径本地真跑 (verify/settle 四结果 + txHash 有无 + 报价自洽 + 凭据绑定; 真链部分明确未验) |
| [milestone-dispute-responsibility.md](./milestone-dispute-responsibility.md) | v1 | 里程碑结算 (PartiallySettled) + 争议 (disputed/refund + 三条禁令 + 证据绑定) + 责任候选 + 交易审计 API |
| [payment-recovery-protocol.md](./payment-recovery-protocol.md) | v1 | 支付中断恢复 (5 个 SIGKILL 时点 + 决策纯函数 + 先对账再重试 + 0 重复付款/0 错误 verified 验收) |
| [executable-resource-protocol.md](./executable-resource-protocol.md) | v1 | 可执行资源协议 (输入/输出 Schema + 可执行入口 + 工具清单 + 验真/证据字段 + 能力边界 + 安装保真链 + Harness 执行) |
| [transaction-two-layer-state.md](./transaction-two-layer-state.md) | v1 | 交易两层状态协议 (生命周期 ⊗ 结算事实 + 责任候选 + 迁移 + verified 八项门 + 写路径拒绝非法迁移) |
| [agent-trace-sharing.md](./agent-trace-sharing.md) | v1 | 智能体工具执行轨迹与 P2P 连接信息出口 (文本/JSON 跨边界契约 + CLI/Web 接口 + 小工具边界) |
| [runtime-bootstrap-protocol.md](./runtime-bootstrap-protocol.md) | v2 | **运行时安装协议**: 完成定义(Node/npm/Git/Python 全部可用+可验证+路径已配) + 冻结最低版本 + 唯一管理器 + 三平台适配 + 不偷偷 sudo + PATH/配置持久化 + 真执行验证 + 安装未完成不许说成功 + Phase 0-9 台账 |
| [contacts-protocol.md](./contacts-protocol.md) | v2 | **联系方式/社交身份**: DID + 已验证联系方式 + 联系能力 Skill + 调用权限 + 可恢复证据; 外部四状态; `~/.bolloon/contacts/` 落盘事实 (0600); 12 步 contact policy (批量永久禁止/首次联系需批/幂等/限额/任务绑定); 三通道 (local-sink 明标未外发 / http-webhook / smtp); 与 external-events 的 `contact` 来源接线 (只唤醒对应 Goal); 双端配对只同步 capability; 真跑 51/0 |
| [update-protocol.md](./update-protocol.md) | v2 | **更新协议**: 版本身份唯一来源 + 安装方式/更新来源枚举 + 7 个检查结论 + 更新计划/风险检查 + 锁与回滚 + 更新后健康检查 + doctor + 发布硬门 + Phase 0-8 完成度台账 + 6 条行为变更 |
| [setup-protocol.md](./setup-protocol.md) | v2 | 初始化协议 M0/M1/M4 (初始化状态机 + SetupStore 唯一事实 + 分层 readiness + 启动硬门禁 + M2–M6 计划) |
| [copyright-registration.md](./copyright-registration.md) | v2 | 软著登记材料 (500 字主要功能 + 源程序前/后各 30 页 · 生成器/口径/自检/未闭合项) |
| [goal-continuation-flywheel.md](./goal-continuation-flywheel.md) | v2 | **Goal 长期执行飞轮 = 意图 + 执行机制** (leo: 飞轮是意图, **不是项目功能**): 意图是一等输入 · Goal 是意图的可执行投影 · **意图的落位** (意图 → Goal → continuation → Run → Memory/Skill → 下一次执行; 意图可改可撤, **意图级变更高于 Goal 级**) · 把已有能力收敛成一台引擎 · P0 节奏由进展决定 (ContinuationDecision + 三类硬底线) · P1 强制收尾四类产物 · P1b Memory 分层 + Skill 更新流程 · P2 AgentWorkContract · P3 WorkMonitor 阻塞 · P4 GoalChangeRequest + 两份输出 · P5 验收 (含 2 条强负例) · 文件所有权划分 + 函数签名 |

| [goal-flywheel-p5-acceptance.md](./goal-flywheel-p5-acceptance.md) | v2 | **P5 统一长周期验收报告** (独立真跑 6 场景 + 2 强负例 + 3 条必查): 逐场景结论与证据 · **缺口台账** (已修 4 / 未修 2, 改前→改后→证据) · 真 DOM 34 过/0 败 · 变异验证 (每处修复还原 → 必红) · 未验证项清单 |
| [goal-flywheel-m5-acceptance-report.md](./goal-flywheel-m5-acceptance-report.md) | v2 | **M5 长周期真跑验收报告** (10 场景真跑 · 191 过/0 败 · 注入时钟): 逐场景结论+证据形式+卡点 · **7 个真缺陷与修法** (⑥ 已完成 Goal 被界面显示成「执行中」· ⑦ 到点唤醒后 stale 状态把有进展的目标挂成「等外部」) · 夹具/断言写错如实区分 · 成本数字 (29 Run / 0 LLM / 18.7s) · 未做到逐条 |
|| [log.md](./log.md) | (none) | session-by-session 变更日志 |

## 读者向页面 (docs/, audience=reader)

| 页 | schema | 用途 |
|----|--------|------|
| [../why-bolloon.md](../why-bolloon.md) | v2 | 面向读者的导读:用户画像、为什么用 Bolloon、项目优势 |
| [../真正要做的事.md](../真正要做的事.md) | (none) | Bolloon 真正在做的事 (历史校准) |
| [../数学辅助智能体-核心效果定义.md](../数学辅助智能体-核心效果定义.md) | (none) | 数学场景下的核心效果定义 |

## v2 schema 必填字段 (所有内容页)

```yaml
---
title: <一句话>
source: session
created: YYYY-MM-DD
last_confirmed: YYYY-MM-DD
schema_version: 2
audience: self  # self / internal / reader / public
stage: current   # draft / current / stale / archived / crystallized
status: current
confidence: high  # high / medium / low / unverified
entity_type: chapter  # concept / person / protocol / chapter / claim / meta
---
```

详见 [SCHEMA.md](./SCHEMA.md).

## 自检命令

```bash
# wiki schema 校验 (v1 兼容)
python3 scripts/wiki_check.py

# manifest schema 校验 (v1/v2 自动)
python3 scripts/raw_manifest_check.py

# v2 严格 lint (需要所有内容页 schema_version: 2)
python3 scripts/wiki_lint.py --strict=v2

# supersede 链 + contradicts 对 校验
python3 scripts/supersede_check.py

# 知识图谱导出
python3 scripts/graph_export.py

# 晶化断言
python3 scripts/crystallize.py --min-occurrences 2

# 混合检索 (BM25 + 图遍历 + RRF)
python3 scripts/hybrid_search.py "我的查询" --depth 2

# 草拟 draft stub (新 raw 触发)
python3 scripts/delta_compile.py --write-drafts

# stale 报告 (6 类 fresh/stale)
python3 scripts/stale_report.py
```

## 关联资产 (非 wiki)

- [消融实验报告](../ablation/report.md) — 4 功能 × 15 项端到端验证
- [Q1-Q5 报告 2026-07-07](./q1-q5-report-2026-07-07.md) — 远程交流链路 + 五层记忆架构 + H2 修复
- [Bolloon.md](../../Bolloon.md) — 项目入口文档
- [CLAUDE.md](../../CLAUDE.md) — Claude Code 上下文 (root)
- [AGENTS.md](../../AGENTS.md) — 通用 agent 规则
