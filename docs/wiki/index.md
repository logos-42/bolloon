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
| [provider-registry.md](./provider-registry.md) | v2 | **供应商注册表 + 兼容协议 (P3)**: 13 家内置逐项有出处 (默认 URL/环境变量/默认模型/发现/认证/工具调用/reasoning/是否本地/**是否允许当长期任务执行器**) + 通用自定义供应商 (`openai-compatible`/`anthropic`/`gemini`/`ollama` + baseUrl/modelsEndpoint/authHeader) 不动 TS 联合类型 + **旧配置向后兼容** (数组形/吸收旧写法/自定义 activeProvider 不再被静默改成 ollama) + 元数据填充点只填有真值的项 + 真跑 44/0 与 8 条变异判红 |
| [model-url-chain.md](./model-url-chain.md) | v2 | **探测原语** (独立, 未接线): API URL 四层解析 (显式 > 配置 > 供应商默认 > 环境变量) + 规范化合并重复 `/v1` + 六步探测 (协议形状/连接/模型接口/工具调用) + **失败七类** (`invalid_url`·`auth_failed`·`provider_unreachable`·`model_not_found`·`protocol_mismatch`·`tool_call_unsupported`·`timeout`) + 三条硬规则 (不静默退回默认/失败不当成功/凭证不进返回值) + 真跑 50/0 与 4 条变异判红 |
| [model-discovery.md](./model-discovery.md) | v2 | **模型发现与缓存 (P5)**: 已认证优先取 `/models` (openai 兼容/gemini/ollama 三形状) + 缓存按 **provider+baseUrl+凭证身份** 分桶 (**只存指纹不存明文** · 默认 30 分钟有效期 · 两个 key 不共用) + 回退链 (网络不可用→上次成功缓存 / 从未成功→内置目录 / 自定义模型可手输) + **发现失败不静默删 provider** (保留并标 `unavailable` + 原因) + 五种标记 (`live`·`cached`·`curated`·`custom`·`unavailable`) + 元数据填充点只填响应体字面写着的 + 真跑 81/0 与 4 条变异判红 |
| [goal-model-policy.md](./goal-model-policy.md) | v2 | **长期任务/Supervisor 模型策略 (P7)**: 切 Global 不改写在跑的 Run (快照即真源) · 新 Run 用最新 Global · Goal `modelPolicy` (`auto`/`pinned`/`session`) · Supervisor 按失败类别挑备用 · 切换写 Run 事件 (`modelSwitches` + harness 镜像) · **模型变了不重跑非幂等工具** (探针 1B/2B 负控制 + 敏感性对照) + 真跑 36/0 与 2 条变异判红 |
| [provider-catalog.md](./provider-catalog.md) | v2 | **供应商目录驱动 (公开目录 223 家) + `bolloon model` 交互面口径 (2026-09-27)**: 公开源 `models.dev/api.json` (字节数/sha256/取回时间/源自报 223 家全记在 provenance) 烘焙成**离线可用**的 `provider-catalog.json` (223 家 / 8174 模型 / 有基址 197 / **无基址 26**) + 四族分布 (`openai-compatible` 200 · `anthropic` 8 · `gemini` 1 · `special` 14) + **诚实边界** (无基址不许编地址 / special 如实标不支持 / 能力只填字面声明 / 陈旧不许装新) + **内置 13 家零变化怎么证的** (注册表条目逐字节相同 · 目录层不回答内置 · 同名不顶掉 · 合并读口 13 家在前 · 文本格式未变) + 运行期 `refresh` 链 (真 HTTP → 0600 原子落盘 → provenance; >30 天标 ⚠ 陈旧; 比烘焙旧则不采用并说明) + **真终端裸敲 `bolloon model` 直接进选择器** (第一屏就是带序号/●○/`← 当前` 的供应商列表 · 每步先印选项再问 · 非法输入给范围再重问 · EOF 干净取消零写入; 管道/非 TTY 才退回清单+用法) + 真跑 `verify-provider-catalog.ts` **70/0** 与 **5/5 变异判红** (M3 要**同时**拆两道"内置优先"闸才红) + 真 pty 门 `verify-model-ux.ts` **27/0** 与 **2/2 变异判红** |
| [model-selection-acceptance.md](./model-selection-acceptance.md) | v2 | **模型切换 · P8 终验收口报告**: 用户点名的 16 条端到端验收**逐条真跑** (CLI 真切真命中 · 同 provider 切 model 请求体真变 · 自定义 baseUrl 真命中 · 四类错误全拒且配置字节不变 · CLI/Web 同一份配置 · 重启生效 · Session 不改 Global · Global 影响新 Session · 旧 Run 保快照 · 新 Run 用新模型 · Supervisor 恢复用对策略 · 两进程互不覆盖 · 旧配置可迁移 · `/models` 不可用时缓存与手输仍可用 · 不支持工具调用的模型被拒 · 失败后旧模型仍可用) = **16/16 条目 · 103/103 断言 · 16/16 反事实**, 变异 **5/5 判红** (每条红在它该红的条目上) · **0 次真 LLM** (全打本地假上游) · 没做到/有保留逐条列出 |
| [cli-startup-output.md](./cli-startup-output.md) | v2 | **CLI 启动期加载日志默认静默**: 先真跑归因「谁在打哪些行」(本仓 `src/web/server.ts`·`supervisor-host.ts`·`iroh-transport.ts`·`bootstrap.ts`·`pi-ai.ts`·`pi-ecosystem-mcp` / 依赖 `@diap/sdk` 的 ISO `[info]` 行 / **tsx 运行时 stderr 实测 0 行**) → 集中式闸门 `src/cli/log-gate.ts` (三个启动面 · 信号行改道 stderr 不吞 · 日志仍写 `${BOLLOON_HOME:-~/.bolloon}/logs/startup.log`) · 默认 `139 → 26` 行且加载日志 `102 → 0` · `--verbose`/`BOLLOON_VERBOSE=1` 诊断回流 100 行一字不少 · 定向注入坏配置的真错误照样显示 · 验收门 `scripts/verify-cli-quiet.ts` 12/0 + 变异判红 | current |
| [cli-reply-stream-hygiene.md](./cli-reply-stream-hygiene.md) | v2 | **CLI 会话内回复流卫生 (2026-09-27)**: 先真跑捕获回复流里真出现的 **8 行内部运行日志**并归因到具体发送点 (`src/agents/pi-sdk.ts` 的 `type: 'status'` emit → CLI 的 `onStream` **就是**回复流, 根因是"按内容子串猜"漏掉 `🔄 开始 ReAct 循环...`) → 修法=**发送点声明** (`StreamEvent.internal` + 20 处 `internal: true`) + **回复流组装口唯一落判** (`src/cli/reply-hygiene.ts` 的 `isInternalRunLog`, 不在渲染层做子串过滤) → **搬走不是删掉**: 同一行原文落 `${BOLLOON_HOME:-~/.bolloon}/logs/startup.log` 的 `[运行]` 通道 (目的地走已有 `startupLogPath()`), `--verbose`/`BOLLOON_VERBOSE=1` 时原样回到屏上; Web 面 (状态栏/workflow_step) 与轨迹面**一字不变**。验收门 `scripts/verify-reply-hygiene.ts` **15/0** (5 个真会话): 黑名单 16 串**回复流 0 命中 / 日志逐串可查** · verbose 召回 **17 处** · 回复流唯一行 **78 → 48** (内部日志 8 → 0) · 阳性对照 (修复前真抓包 fixture + "会话真跑了"三证据) 防空文档假绿 · 变异 **3/3 判红** | current |
| [cli-startup-panel.md](./cli-startup-panel.md) | v2 | **CLI 启动面与面板几何 (2026-09-27)**: 敲完 `bolloon --cli` **直接出面板**, 启动期那一坨 (初始化状态/就绪度/已完成/配置来源/已存输入/缺/下一步/启动面板框/Onboard 模式) 默认 **0 行**, `--verbose` 下**一字不少回来** (真 pty: 第一帧前 19 行 → 0 行; verbose 58 行 ⊇ 老路径 19 行**逐字 0 缺** — 该总数随环境抖, 判据一律同轮同一构建互比) · **失败不许吞** (折成 `/!\` 前缀进面板; 源码字面量必须 `\\ `, 少一个反斜杠屏上变 `/! `) · **几何不抖** (三个固定行 `height`/`overflow`/`width`; 60 列窄屏 42 帧: 输入行号恒 `22` · 固定栏 `20,22,24` · 帧高恒 24) · **跟随可暂停** (探针 `stick=false && top>0` + 屏上"已暂停跟随", End 回底恢复) · **`/copy` 真落剪贴板** (stub 实收 == 面板自报 90 字符 · 运行期 0 次 `2J` 清屏 · 不用 alt-screen) · **会话内 `/model` 与子命令共用同一套 `tui-select`** (屏上 `共 231 家登记` == 门自己 `buildProviderSummaries` 真算 231; 展开全部折叠组后连续 ↓ 到 `第 237/237`; 单帧 11–15 行 ≤ 终端高)。验收门 `scripts/verify-cli-panel.ts` **47/47** (收尾轮加 A7: 面板前 0 行之外, 真发生过的降级必须能在面板里逐字定位 — 地面真值取盘上 `startup.log`, 不看屏幕) · 变异 **5/5 判红 + M6 手工判红 (A7)** | current |
| [kv-prefix-cache.md](./kv-prefix-cache.md) | v2 | **前缀 KV 命中链 (2026-09-28)**: leo 原话「缓存无法命中」→ 判据是**字节前缀逐字一致** (不是语义) → 三处真失配归因 (system 每轮现拼且掺动态层 · 注入不回写调用方 history · tools/嵌套 key 顺序抖 + 流式拿不到 usage) → 一条链只留**一个会变的位置**: `[stable system] + [只追加的 history] + [尾部 CURRENT TURN 区]`。八条机制逐条落 (装配缓存 10min + stable/dynamic 拆分 · `ChatResult.messages` 回带 + `writeBackCurrentTurnInto` 真写回 · 标记幂等 · `canonicalizeJson`/`canonicalizeTools` · `cache_prompt` 仅 main-agent 且只对本机 endpoint · 指纹幂等复用 + `clearSystemPromptCache()` · `[kv-server]`/`[kv-debug]`/`[prompt-profile]` 只打数字与 hash · `stream_options.include_usage`) + 我们多做的两件 (pi-sdk 的 `refineContext`/`loopProgressSection` 易变段改走 `currentTurnContext`; 按 purpose 分重/轻前缀) + `llamacpp` 声明 id (空 key 不带鉴权头) + **环境变量表**。门 `verify-kv-prefix.ts` **90/0** (5 轮以上主对话逐字节前缀 + 工具结果轮 + 抖顺序 tools hash + 净化 + 幂等 + 逐 purpose cache_prompt + 指纹不重建 + 轻量阈值 + 日志卫生 + 流式 + llamacpp 四落点) 与变异 **10/10 判红** | current |
| [access-protocol-v1.md](./access-protocol-v1.md) | 外部接入协议 v1 (P1 冻结): 版本策略 + JSON 信封 + 错误码表 + 状态映射 + local-dev 红线 | current |
| [agent-access-layer.md](./agent-access-layer.md) | Agent 接入层: CLI 为主协议 · MCP 为薄适配 · Skill 为使用说明 (含六阶段落地状态) | current |
| [task-protocol.md](./task-protocol.md) | bolloon-task/1 任务协议: 14 态状态机 + 支付事实分离 + 受控自主签名闸 + 签名审计 + 公开投影 | current |
| [chain-settlement-design.md](./chain-settlement-design.md) | **链上化设计 v2**(设计): 数据权威划分 + AgentEscrow 主路径 + AgentDirectory 注册承诺 + 连接层八模块 + 五条上链硬规则 | draft |
- [long-term-collaboration-plan.md](long-term-collaboration-plan.md) — 长期合作方案 —— 用 Bolloon 托管"可核验的研究委托" (交付物标准 / 验收协议 / 结算 / 接单通道缺口)
- [intent-network-vision.md](intent-network-vision.md) — Intent Network 愿景 —— bolloon 的第四代定位 (分发对象迁移 / bolloon 已有地基 / 五个缺口 / 三处存疑 / 落地顺序草案)
- [four-terminal-intent-design.md](four-terminal-intent-design.md) — Intent Network 四端设计 —— PC creates / Mobile discovers / Glass acts; World→Intent→Agent→Opportunity→Action→Memory; 数据层 + 落地顺序 (P0–P3)
- [three-terminal-product-vision.md](three-terminal-product-vision.md) — 多终端 Agent 分发网络 —— bolloon 产品形态 (本体六元组 / 三终端=感知器官 / PC=Create·Mobile=Discover·Glass=Assist / 四层架构 / 商业模式分层 / 首页=World / 现状映射 / 存疑点)
| [chain-model-freeze.md](./chain-model-freeze.md) | **链上模型冻结 (P1)**: 合约盘点(Foundry/Hardhat/Solana 三项目) + AgentEscrow 主合约缺口 11 字段 + Treasury onlyOwner 边界 + Directory 新增/Ledger 不新增 + 事件与 hash 切径冻结 + chainId/token/确认数 + §3 五条硬规则差距表 + 必须先改清单 | current |
| [agent-event-network-plan.md](./agent-event-network-plan.md) | v2 plan | **Agent Event Network (计划)**: 1 万智能体协作的共享事件与记忆层 —— 现状基线 (记录形状已是元数据+CID+按需拉块 · 群已是 OrbitDB events store · 测试全走 fake 无真两节点) + 四个真缺口 (ACL `write:'*'` / 跨机复制从未真验 / 无查询面 / 全量复制 vs 轻量) + 核心命题 (×100 规模下本地占用·带宽·查询延迟须 O(1)/O(log N)) + P0–P5 每阶段判据门 | plan |
| [network-ledger-design.md](./network-ledger-design.md) | **Bolloon Network Ledger**(设计): 签名区块 DAG + 三层最终性 + 账本重放派生 Pulse/任务/交易 + Explorer 增量加载 | draft |
| [pulse-ledger-design.md](./pulse-ledger-design.md) | 链式活动账本 + 链上锚定 (设计计划): 哈希链/Merkle 根/最终性/由链派生的公开投影/跟区块头轮转 | proposed |
| [network-pulse.md](./network-pulse.md) | v1 (2026-09-22 加 `confirmed_activity`; **2026-09-24 顶部计数逐字段定源**) | **网络脉冲**: 匿名可验证的公开观察投影 (事件白名单 · 去重 · 隐私阈值 · live/stale/unavailable · `GET /api/public/network/progress` · **冻结形状 `confirmed_activity` = 真实任务/链上活动行, 来源 chain-index/pulse-events/none**) · **`totals_scope.fields` 逐字段口径 + 「无源 = null = 页面写未接入」+ 同一概念不变量门 (顶部计数 vs 表格)** |
| [m1-m4-closure.md](./m1-m4-closure.md) | v1 | **M1–M4 收口验收口径**(冻结): 四个唯一事实来源 + 四条不可违反规则 + 5 个用户态口径 + 跨里程碑验收矩阵 + 失败→出口映射 |
| [product-core-focus.md](./product-core-focus.md) | v1 | **产品核心收缩**: 一句话核心承诺 + 五步闭环 + 三问过滤器 + 冻结清单(不改代码) + M1-M4 路线图 + M1 真实差距 |
| [facilitator-paths.md](./facilitator-paths.md) | v1 | facilitator 协议路径本地真跑 (verify/settle 四结果 + txHash 有无 + 报价自洽 + 凭据绑定; 真链部分明确未验) |
| [x402-order-identity.md](./x402-order-identity.md) | v2 | **x402 订单标识 (约定 v1, 标签 `BOL1`)**: 把"买的是哪件"编进 EIP-3009 的 32 字节 `nonce` (`tag(4B "BOL1") ‖ orderSeq(uint32 BE) ‖ keccak256(utf8(itemId)‖uint256be(orderSeq))[0..23]`) ⇒ "谁付·多少·给谁·买什么"**在同一笔交易里自证** (`AuthorizationUsed(authorizer, nonce)` 事件); 卖方复算本店 item 的哈希才认"自证", 对不上/没事件 ⇒ **如实降级「直转(无订单标识)」**; 买方 CLI `bolloon x402 pay --with-memo` (自己签 EIP-712、自己发, 私钥只从文件读, **EIP-712 name 实测是 `USD Coin` 不是 `USDC`** → 靠链上 `DOMAIN_SEPARATOR()` 反查); 台账加 `NONCE_ALREADY_USED` 门 (链上 `(payer,nonce)` 只能用一次); **只读入口 `readOrderIdentityFromTx` / `orderIdentityFromLogs` 给统一索引区那条线用**; 首笔真钱 0.01 USDC (`0x1499e5f2…02a7`) 端到端 | current |
| [diap-address-binding.md](./diap-address-binding.md) | v1 | **DIAP 地址↔DID 绑定登记 (`diap-address-binding/1`)**: 让网关能把链上付款行里的**付款方地址**翻成**智能体身份** —— 一份**链下**声明 (冻结 canonical 正文: `protocol/did/address/chainId/issuedAt/expiresAt/nonce`), 被**两侧分别签名**同一份字节串 (`sig_did` = DID 私钥 Ed25519 · `sig_addr` = 该地址私钥 EIP-191 personal_sign), 验证 = **两侧都过才算数** (缺一侧 = 拒, 不降级; 判据逐条列出: `did_matches_public_key`/`statement_canonical`/`id_matches_statement`/`not_expired`/`nonce_unused`); 名字 (label) 另有 `label_sig` 覆盖 (有 label 就必须验); 绑定库 `~/.bolloon/bindings/` (**加载时逐条重验**, 未验签的一条都不出名字不出 DID) + CLI `bolloon identity bind-address|bindings list|show|verify|publish` (**没有默认钱包路径**, 私钥不进任何输出); 索引集成: 已验签绑定命中的付款行多出 `payer_identity{name_short,did_short,verified,method,source}` (**没绑定 ⇒ 键整个不出现**), 快照加 `payer_identity_scope` 口径块 (页面就地标「链下登记(可离线验签)」); 隐私门**有意修改** (只收紧: 位置/键集/取值/短写形状逐条核, 对照测试 29 → 46 条) | current |
| [x402-chain-payment-index.md](./x402-chain-payment-index.md) | v2 | **x402 订单标识 (约定 v1, 标签 `BOL1`)**: 把"买的是哪件"编进 链上交互索引 的 32 字节 `nonce` (`tag(4B "BOL1") ‖ orderSeq(uint32 BE) ‖ keccak256(utf8(itemId)‖uint256be(orderSeq))[0..23]`) ⇒ "谁付·多少·给谁·买什么"**在同一笔交易里自证** (`AuthorizationUsed(authorizer, nonce)` 事件); 卖方复算本店 item 的哈希才认"自证", 对不上/没事件 ⇒ **如实降级「直转(无订单标识)」**; 买方 CLI `bolloon x402 pay --with-memo` (自己签 EIP-712、自己发, 私钥只从文件读, **EIP-712 name 实测是 `USD Coin` 不是 `USDC`** → 靠链上 `DOMAIN_SEPARATOR()` 反查); 台账加 `NONCE_ALREADY_USED` 门 (链上 `(payer,nonce)` 只能用一次); **只读入口 `readOrderIdentityFromTx` / `orderIdentityFromLogs` 给统一索引区那条线用**; 首笔真钱 0.01 USDC (`0x1499e5f2…02a7`) 端到端 | current |
| [x402-seller-signing.md](./x402-seller-signing.md) | v2 | **x402 卖方本机签名交付 (接口冻结)**: 私钥不出本机 (服务器只持卖方公钥, 没钉住就拒收) + 数据流图 (买方→ECS→待办队列→本机拉取→确认→本机 ed25519Sign→回传→买方离线验签) + 待办记录结构/幂等键 `receiptHash` + 认证 (0600 共享密钥 + HMAC(方法/路径/ts/nonce/体哈希), 先验签再记 nonce 防 DoS, nonce 台账落盘 ⇒ 重启不刷新重放窗口) + **取件走只读 token (不重放 X-PAYMENT)** + 超时口径 (卖方不在线买方只有 `202 已付款待签名`, 过期 410, 未配密钥 403) + 与 facilitator 关系 (路 A 自建 relayer / 路 B 买方直付+txHash 链上校验, 都不引入平台) + CLI `bolloon x402 pending list\|show\|sign` 真跑输出 + 39/39 聚焦测试 + **§十一 = `direct` 去中心化直付 (`mode=direct`) 已实现并上机**: 买方自己发 USDC 到 `payTo` · 卖方端点**只读链**核验 (8 条判定 + **≥2 条 RPC 交叉一致**) · **无托管/无 facilitator** · `POST /api/x402/info/:id/payment` → 202 待办 + 取件 token (复用既有链路) · `BOLLOON_X402_DIRECT=1` 可由 health 看出 · **首笔真钱端到端 (0.01 USDC, tx `0x8d06bc84…0ff1`) 跑通并通过买方离线验签** | current |
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
| [docker-deployment.md](./docker-deployment.md) | v2 | **容器化部署 (Docker / Compose)** (2026-09-28): 多阶段镜像 (构建装全依赖 → 运行只留生产依赖+`dist`, 基础镜像 `node:22.22.3-bookworm-slim` — 选 glibc 因为 `sodium-native`/`iroh`/`classic-level` 是 glibc 预编译原生模块) · **非 root uid/gid 1001** + 状态卷 `/home/bolloon/.bolloon` · 端口只认 `PORT`(默认 54188) 且容器内必须 `BOLLOON_HOST=0.0.0.0` · **真探针** (`/api/health` 200+`ok:true` **且** `/` 200; 不断言 P2P/LLM 以免假红) · 密钥两条通道 (`env_file: .env.docker` 或只读挂载 0600 `llm-config.json`, 后者更安全; **实测教训: `${}` 插值会把仓根 `.env` 的真 key 原样打进 `docker compose config`** ⇒ 凭证一律不插值) · 三个只有真跑才撞得上的坑 (`postinstall` 必须早于 `npm ci` / iroh 的 `peer typescript@^5` vs 根 `typescript@7.0.2` ⇒ `--legacy-peer-deps` / workspace 裸包名符号链接必须换成构建产物) · 冷启动 ≤15s 的 iroh 门 + `start-period=120s` · 真跑证据与如实保留 | current |
| [efficode.md](./efficode.md) | v2 | **Efficode —— AI 专用交流语言 (参考实现 · 诚实边界)**: 状态总表逐节标 `✅ 已实现`/`🚧 规范中`/`❌ 未实现(为何)` (包封装/指令集/双模式/压缩层/DID 摘要段/协商/接线 已实现 · **签名与 ECC 临时会话密钥未实现** · 声波模式未实现 · 5G/区块链纯设想 0 行代码 · 论坛地址未定) + 语言结构 (6 条符号指令 `@DID:` `#DATA:` `#REQ:` `!ACK/!SEND/!END` · 前缀表达式四条写死的解析规则 · 文本/二进制双模式) + 包结构 `[Header 2B][DID 32B][指令段][数据块][CRC32 4B]` (flags 逐位 + varint + **逐段自描述**, 截断/CRC 不符/未知 opcode 一律抛) + 三条协商硬规则 (双方声明才用 · 明确回落并记录 · **声明绝不进解码器**) + **「更高效吗」逐条对表** (宣传句只作待测假设, 旁边放真测: x40 帧省 **92.9%** · 信息密度实测最高 **14.15x** · 「兼容度 100%」「微秒级」「链路缩短 50%」= **未测**) + **短消息被包头吃回去的真算** (20B 载荷 → **111B** 包, 净开销 **91B**, 开销/载荷 **4.55x**; 身份被写两遍白花 46B) + 门 `verify-efficode.ts` **55/0** · 变异 **4/4** · 单测 **53/53** | 
| [bolloon-native-macro-kernel.md](./bolloon-native-macro-kernel.md) | v2 | **Bolloon Native Macro-Kernel (方向 · 边界 · K0–K10 台账)**: 意图层架构决定 (leo 2026-10-02) —— 进程内高性能 Agent 内核, 模块化 / 统一调度 / 共享状态受控, **Pi 降为可替换推理适配器**; 8 模块现状对账 (5 有地基 / 2 分层收口 / **只有 Channel Actor + 并发 ModelRuntime 真新建**) + 五条越权禁令+1 派生 (落**写入口**不是整层) + `constraint-runtime` A/B/C 定位 + 机制/判断分工 + 第⑤风险 (Kernel 自己变巨型单体) ⇒ **K1/K2/K3 机器门** + **K0–K10 阶段台账 (K0 ✅ 已完成 `26ffa6d`, K1–K10 ❌)** + 验收矩阵 (并发/模型/长任务/安全/性能) + 明确不做 + K10 六条撤换条件 + §12 K0 真跑证据 (37/37 · tsc 0 · 真盘变异 4/4 · 欠账 4 处) | draft |
||| [log.md](./log.md) | (none) | session-by-session 变更日志 |

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
