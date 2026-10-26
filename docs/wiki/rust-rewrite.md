---
title: Bolloon Rust 原生版 (rust-rewrite-1.99 分支) 重写台账
source: session
created: 2026-10-25
last_confirmed: 2026-10-25
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [rust-rewrite, kernel, harness, p2p, task-board, memory, session-store, v0.6.10]
---

# Bolloon Rust 原生版

`rust-rewrite-1.99` 分支 (rustc 1.99.1, edition 2024, workspace 版本 **0.6.10**)。原 TS 代码**冻结不删**, master 分支保持原样; Rust 版是并行实现, 数据目录走 `~/.bolloon/rust/` 子目录 (与 TS 共存不互踩)。

## Workspace 结构 (rust/)

| crate | 内容 | 测试 |
| --- | --- | --- |
| `bolloon-kernel` | K5 ChannelActor+SerialMailbox / K6 ModelRuntime 租约+熔断 / control / run-lifecycle / session-lifecycle / **transport 端口 (未注入即拒)** / HA 心跳仲裁+守护 | 20 |
| `bolloon-harness` | 工具门: discover→permission→budget→idempotency→execute→verify→evidence→event | 5 |
| `bolloon-llm` | 唯一咽喉 generate: 429/5xx 退避 / 400 不重试 / 超时自适应 / 工具名净化 | 7 |
| `bolloon-agent` | KernelLoop (prepare→model→harness→checkpoint→reducer→continuation) · 群聊 Autopilot (仅被@/提问开口·冷却·每小时上限·seen 幂等) · **任务公告板** · **记忆库** · **会话 JSONL** | 28 |
| `bolloon-p2p` | DID 身份 (did:pi + ed25519) · 群 store (ACL 独占/白名单/开放) · **签名信封 `bolloon-envelope/1`** · **gossip 广播总线 (实现 kernel Transport 端口)** | 21 |
| `bolloon-web` | axum + hushforge 布局单页 (284px 侧栏 + 主聊天 + room 面板) | 0 |
| `bolloon-cli` | `bolloon` / `web --port` / `status` / `memory remember\|recall` / `task publish\|id` / `chat` / `model` / `dream` | 0 |
| **`bolloon-tui`** (2026-10-26 新增) | **复用原 TS 的 CLI TUI** (`src/cli/` 那套纯 ANSI 视觉层 + raw 模式交互), 13 个模块 | **87** |

## 2026-10-25 本轮新增 (commit 待填)

1. **签名信封 + gossip 多节点广播** (`bolloon-p2p`): canonical JSON (键排序+无空格, 与 TS `canonicalize` 同语义) + Ed25519 签名; 接收侧**验签不过即丢** (拒伪造) + content_hash 去重; 三节点 mesh 广播闭环真测。跨机传输未来替换同一 `Transport` 端口 (iroh/libp2p), kernel 不改。
2. **任务公告板 `bolloon-task/1`** (`bolloon-agent`): announcementId = sha256(capability‖digest‖issuer‖budget) 前 16 hex → 稳定; 同内容 publish → `dup=true` 不覆盖; claim 守卫 (不存在/过期/被抢/重复认领) 全拒 + Ed25519 签名; 认领不执行不付款不标 verified。落盘 `~/.bolloon/rust/task-board.json` (CLI 与 Web 同源, 跨进程 dup/claim 判定一致)。
3. **记忆库** (`bolloon-agent`): 4 层 (run_fact/lesson/decision/temporary) + importance 衰减 (half-life: temp 1h / fact·lesson 24h / decision 72h) + temporary 到期失效 + recall top-k 纯函数。落盘 `~/.bolloon/rust/memory.json` (启动恢复)。
4. **会话持久化** (`bolloon-agent`): 仅追加 JSONL (一行一事件, 换行转义) + 损坏行跳过计数不中断 + **恢复会话绝不自动恢复权限** (load 面无权限出口, 枚举编译期冻结)。落盘 `~/.bolloon/rust/sessions/{id}.jsonl`, web 启动恢复历史。
5. **Web/CLI 接线**: Web 新端点 `/api/groups` (建群/列表/消息/发言, 群消息 Ed25519 签名) · `/api/tasks` (发布/看板/认领) · `/api/memory` (remember/recall) + bootstrap 带真 DID; UI 侧栏群聊列表 + room 面板绑定群聊 + hushforge 同款细节 (room-grip 拖拽 / 成员思考点 / 流式 shimmer / 建群按钮)。DID 身份持久化 `~/.bolloon/rust/identity.json` (0600)。

## 端到端验证 (真跑, 隔离 BOLLOON_HOME)

10/10 全过: health · bootstrap 真 DID · 建群 (OwnerOnly) · 群聊签名发言 · 读回 · 任务板 CLI/Web 同源 · 签名认领 · 重复认领拒 · 记忆跨进程恢复 · 会话 JSONL 落盘。

## 诚实边界

- gossip 是**进程内多节点 hub** (单机多智能体闭环可真验); 跨机真传输 (iroh/libp2p/DIAP) 未接 — 端口已留, 未注入即拒。
- DIAP Rust SDK 只通过 feature 注入注释预留, workspace 未直接 path 依赖 (DIAP 的 cid→core2 yanked 依赖会拖垮解析)。
- Web 聊天的 room 面板群聊轮询 3s; 群聊 UI 无跨节点成员 (单节点)。
- LLM 并发闸默认 2; 工具循环 (kernel_loop) 未接 harness 真工具注册表。

## 2026-10-25 第二批 (功能面全覆盖, 182 测试全绿)

新 crate `bolloon-x402` (25 测试) + 7 个新模块 (48 测试), 对齐 TS 功能面:

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| `bolloon-x402/order_identity` | agents/x402/order-identity.ts | BOL1 nonce 字节级一致 (tag4+seq4+hash24); **EIP-712 domain 与真链实测值对表** (name="USD Coin" 不是 "USDC" 的证伪断言钉住) |
| `bolloon-x402/paid_info` | paid-info-protocol.ts | 验真四档 (verified/self-attested/content-only/unverified) 不冒充; 改 scope 验签必败防伪 |
| `bolloon-x402/direct_payment` | direct-payment.ts | 直付 8 判据纯函数; ≥2 RPC 一致才算事实, **矛盾 ⇒ RpcDisagreement ⇒ 不交付 (fail-closed)**; tx 复用拒; 自付自收拒 |
| `bolloon-agent/efficode` | src/efficode/* | 帧布局逐段自描述 + CRC32 硬门 (对表 "123456789"→0xCBF43926); 截断优先报 Truncated; 保留位非 0 拒; 6 指令符号文本往返 |
| `bolloon-agent/hooks` | hooks/hooks-engine.ts | 8 事件 + toolFilter + deny 短路 + 注入 system; **未注入执行器如实报错不假成功**; 超时如实标 |
| `bolloon-agent/judgment` | pi-ecosystem-judgment | 注入门 (精确域优先, 无命中不硬造 hint) + 入库即演化 (jaccard merge/contradict/created) + channelKeyOf 节流归一化 (修 TS 侧踩过的 key bug) |
| `bolloon-agent/world` | intent-store/opportunity-match/world-cards | 默认世界流永不空流 (无意图=0.5/world); 信箱置顶; ignore 校准环同源不再流入; scope 进签名防伪造公域 |
| `bolloon-agent/goal` | goal-flywheel/types.ts | continuation 决策 9 步优先级 (无价值→stop/阻塞→needs_human/硬底线熔断/等外部→sleep_until/有进展→continue); Goal 不许悬空 (终态冻结集) |
| `bolloon-agent/contacts` | contacts/human-directory.ts | 手机号 HMAC 盲化 (明文不进目录, pepper 换哈希必变) + 好友请求 consent 状态机 (幂等/已处理拒) |
| `bolloon-agent/heartbeat` | social/heartbeat.ts + kernel/ha | 心跳注册表: 过期判定 + sweep + thinking 点 (群聊 UI) |
| `bolloon-kernel/cron` | cron/ | tick 判定纯函数 (时间注入) + 防重叠锁 + DND 窗口 (跨零点) + 陈旧锁恢复 |
| `bolloon-llm/compaction` | context-compaction | 渐进式: 锚截断→工具结果压首行→逐条截断→预算削减丢中段 (首条+当前轮永不动, 丢处放摘要占位) |
| `bolloon-harness/security` | shell-guard.ts | denylist 高危命令拒 (空白/大小写归一防绕过) + `curl|sh` 管道模式检测; 纯 curl 交上层 permission 门 |

Web 接线: `/api/judgment` (top-N 注入门 + 入库即演化, action 如实回 merged/contradicted/created) + `/api/world/feed` (默认流 + 意图重打分)。

**诚实边界**: x402 是判定纯函数 (真 RPC 拉取/签名由调用方注入, 不动钱); hooks 执行器 trait 注入 (Rust 版不 spawn shell); judgment 演化留痕由调用方落 jsonl。

## 2026-10-25 第三批 (x402 闭环 + 装配/生态件, 234 测试全绿)

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| `bolloon-x402/settlement_state` | settlement-state.ts | 结算事实 8 态迁移表冻结 (非法迁移写路径拒绝不静默改写); local-dev 联调最高只认"提交过(模拟)"; 责任候选 6 类机器只给候选 |
| `bolloon-x402/payment_recovery` | payment-recovery.ts | 恢复决策唯一入口 (7 动作); **0 重复付款硬验收** (任何有支付证据路径 mustNotRepay); 5 个 SIGKILL 时点逐个走对路 |
| `bolloon-x402/seller_signing` | seller-signing.ts | 未钉公钥拒收; receiptHash 幂等; **did 不匹配/内容哈希不对 → 拒签**; 取件 token 一次性 (不重放 X-PAYMENT); auth HMAC+时间窗 |
| `bolloon-agent/setup` | setup-store.ts | 三层 readiness + 硬门禁失败不吞 (全列人话缺因); 连通性"测过+配置没变"才有效 (configHash 比对不看墙钟) |
| `bolloon-agent/subagents` | goal-flywheel P2 + subagent-manager | 合同带 5 禁项; **无证据的漂亮回报 → 父不完成 (强负例)**; 证据数 ≥ 判据数; 隔离上下文 (合同不带父会话) |
| `bolloon-agent/judgeness` | judgeness/* | 5 维评分校验; 打包 markdown 往返无损; verdict 解析容错 (json 围栏/非法如实报错不猜) |
| `bolloon-agent/documents` | bootstrap/context-collector | mtime+size 指纹 (BTreeMap 确定性); 新建/删除/touch 全触发失效; 文档改了下轮生效链路 |
| Web x402 端点 | routes-x402-info.ts | 上架 → 402 报价 (accepts 形状一致) → 直付核验 → 交付; tx 复用拒; 非 BOL1 交付不标自证 (诚实降级) |

**端到端真跑 7/7**: publish → 402 → BOL1 自证交付 → tx 复用拒 → 单 RPC 拒 → RPC 矛盾 fail-closed → 无订单标识诚实降级。

## 2026-10-25 第四批 (任务群聊留痕 + 钱包台账, 253 测试全绿)

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| `bolloon-agent/task_group` | task-group.ts + task-public-text.ts | `[bolloon-task]` 单行事实协议 (announce/claim/deliver/screen/final); **隐私守卫发送侧拒发+读回侧遮蔽记账** (地址/DID/peerId/IPv4/私钥形状/PEM/私钥字样); 交付哈希闸 (0x+40 钱包地址形状拒 / Qm 与 peerId 同形拒 / 只收 sha256/CIDv1); **诚实计数: 无交付痕迹却终审 accept = 显式标矛盾** |
| `bolloon-agent/wallet` | cli/commands/wallet.ts | 地址形态校验 (0x+40, 存小写); 流水只记事实; **台账结构无私钥字段 (编译期无出口)**; 本地余额不冒充链上事实; 失败流水不改余额 |

## 2026-10-25 第五/六批 (生态件收尾, 286 测试全绿)

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| `bolloon-x402/milestone` | milestone-settlement.ts | 金额正整数原子单位不变式; **总额必须等于交易金额 (账平)**; partially_settled 不算完成不进 Goal 成功证据; 交付失败 → **进争议不许静默关闭**; 证据累积不覆盖 |
| `bolloon-agent/workflow` | workflow-pivot-loop.ts | **空回复 0 分打回** (TS 空串 0.7 分=阈值 ⇒ CLI 空框的教训写进测试); 迭代上限不被 adaptive 压死; 无进展熔断 (同工具签名连续 N 轮); 续跑注入无 `<final gen>` 标记; 工具参数 canonical 化 (键序抖动不骗死循环检测); 慢工具超时非致命 |
| `bolloon-agent/mcp` | pi-ecosystem-mcp | JSON-RPC 2.0 帧构造/解析; **协议序门 (未 initialize 拒 tools/*)**; 响应带 method 拒; 未知工具拒; 粘包/半包如实报错 |
| `bolloon-agent/migration` | migration/ | 迁移链按版本序幂等可重放; 已到目标 = no-op 不假装修了; 未知版本如实报错不跳步; 步骤失败停链 |
| `bolloon-agent/lsp` | lsp/ | Content-Length 分帧 (粘包全解/半包如实报); 协议序门; didOpen/didChange 文档簿 (没 open 就 change 拒) |

## 2026-10-25 第七批 (核心组件: orbitdb 原生实现 + git + terminal + Tauri 外壳, 321 测试全绿)

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| **`bolloon-p2p/oplog`** (orbitdb 原生实现) | orbitdb/* (@orbitdb/core 4.x 语义) | append-only **DAG**: entry 带 prev 指针 + lamport 时钟 + Ed25519 签名 + 内容寻址 hash; **join 三重门** (hash 一致/验签/ACL 白名单, 重放去重, 乱序 prev 后到可收敛); 遍历确定性线性序 (clock+hash); **索引从 entries 重放与原逐条一致** (P2 语义); 改载荷/重算 hash 绕 hash 门也过不了签名门 |
| **`bolloon-p2p/replication`** (复制协议) | P0/P0b 真两节点 | 三步: 交换 heads → **沿 prev 链探测缺失块** → fetch 拉块 → join 收敛; **收敛判据 = 遍历线性序一致**; 51 条全量真测 + 增量只拉缺的 21 条 + 复制后继续写双向再收敛 + **伪造 entry 接在真 head 上被 ACL 拒阻断** + 幂等 no-op; 拉块走 `BlockExchange` 端口 (跨机接同一端口) |
| **`bolloon-agent/git`** | cli git 纪律 + git-safety 同源 | porcelain status/log/diff-stat 解析纯函数; **force-push main/master 永远拒** (即使"用户明确要求"); --no-verify/reset --hard 需显式; git config 不改; commit 风格校验 (type(scope): 中文); GitExecutor 注入真执行 |
| **`bolloon-agent/terminal`** | terminal-tool + shell-guard | 三级分类 (ReadOnly 白名单/Mutating 走 permission 门/Dangerous 拒, **未知命令宁可保守**); 管道取最严; cd 越出工作目录拒; **门禁在 spawn 之前**; 超时进上下文不拖死循环; 输出截断保留头尾; TerminalExecutor 注入 |
| **Tauri App 外壳** (`rust/app-tauri/`, 独立编译) | 替代 Electron | **壳不写业务**: 内嵌 bolloon-web axum 服务 (随机回环端口) + 窗口加载它; 数据目录共享 `~/.bolloon/rust/`; cargo check 全树通过 (tauri 2, 产物 ~10MB vs Electron ~800MB); 独立 workspace 不拖垮主构建 |

**调试实录**: missing_for 的 seen 污染 bug (push 时提前 insert 导致 pop 被 continue 跳过, 链断在 head) —— 分离 queued/visited 两集合修复; Python hashlib.sha3_256 ≠ keccak256 的 padding 坑再次出现 (E2E 里用 Rust 侧算的 nonce 真值)。

## 2026-10-25 第九批 (记忆 SQL 化 / 群聊上 oplog / process / workspace / 派送检查 / Clarity, 378 测试全绿)

| Rust 模块 | 语义 |
| --- | --- |
| **`bolloon-agent/memory_db`** (+8) | **轻量化 Postgres 记忆 = 嵌入式 SQL** (SQLite bundled, 单文件 `memory.db` 零服务零配置, 标准 SQL 方言); agent 行级隔离 (查询恒带过滤, 越权 forget 返回 false); 分层+TTL 过期+sweep; importance×衰减 top-k; 子串 LIKE; **文件持久化重开数据还在**; 老 memory.json 幂等导入; WAL 模式 |
| **`bolloon-p2p/group_log`** (+5) | **去中心化群聊信息上 oplog**: 群 = OpLog (events 语义), 消息 = entry payload (kind/from/text/reply_to); ACL 由 OpLog 强制 (陌生人拒); **两节点各说各话 → 双向复制 → 群历史逐条一致** (收敛判据); 活跃度统计; 分片阈值 500 与 TS 对齐 |
| **`bolloon-agent/process`** (+7) | **process 执行**: 进程登记 (pid/command/workspace/状态机 starting→running→exited/killed/failed); stdout/stderr **有界尾部缓冲** (不膨胀, 保最新); 终止 (SIGTERM 语义) → **超时回收 (128+9=SIGKILL)**; 双重退出拒; 真 spawn 由 executor 注入 |
| **`bolloon-agent/workspace`** (+7) | **工作区隔离**: resolve 词法 canonical (a/./b/../c → a/c) + **顶层以上穿越拒** + 绝对路径外逃拒 + Windows 反斜杠输入拒; `a/../b` 在 root 内放行 (canonical 后判, 不是见 .. 就拒) |
| **`bolloon-agent/dispatch_check`** (+7) | **子智能体派送检查闭环**: 在途合同检查四结论 (on_track/needs_nudge/timed_out/blocked, **阻塞优先于一切**); 心跳停半程催; nudge 一次防重复催; 超时回收 (escalated); settle 终报; 派遣≠放手 |
| **`bolloon-agent/clarity`** (+6) | **Clarity 一键说清楚**: 从会话事件提取结构化现状 (goal/done/pending/next_step/blockers + **health 健康度 0-100**); goal 判据命中缩放健康度; 纯函数可测 |
| Web 接线 | `/api/memory` 切 SQLite (响应带 store:sqlite 标记); **Clarity 按钮** (composer-footer ◎ Clarity) → `/api/clarity` → 结构化摘要框 (目标/已完成/未决/下一步/阻塞/健康度); **e2e 真跑 4/4** (sqlite 写/召回/fresh clarity/goal 提取) |

## 2026-10-25 第十批 (计划工具 / skills 进化闭环 / 终止队列中断 / bootstrap / cron 心跳, 404 测试全绿)

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-agent/todo`** (+9) | **task/plan/待办清单工具**: item 状态机 pending→in_progress→completed (+cancelled, 迁移表冻结, 跳步拒); **同一时刻唯一 in_progress** (专注纪律, 测试钉); 复工/恢复允许; **progress() 每轮注入 system** (✅▶○✗ 标记 + 当前项; 空清单不注入防上下文腐烂) |
| **`bolloon-agent/skills_runtime`** (+7) | **工具/技能加载流程防上下文腐烂**: 索引只注入"名字+一句描述"每条一行 (**索引不含全文**, 测试钉); read_skill 按需全文; **run 结束自动进化**: distill(教训)→SkillCandidate → **promote 批准门** (唯一入库口, distill 不入库) → **下一轮索引自动包含复用**; 垃圾防噪 (空/超长 4000/重复哈希/同名 拒) |
| **`bolloon-agent/bootstrap`** (+6) | **bootstrap 加载**: 六步有序装配 (home→identity→memory_db→skills→cron→heartbeat), 每步报告 ok/耗时/原因; **失败如实标出不静默吞**; 身份缺失如实标 pending 不造假 DID; 幂等重启动安全 |
| **runtime 扩展** (+7) | **输入框终止/队列/中断**: `RunControl` — stop (终止按钮, 下一轮前生效, 本轮不跑) / interrupt (**本轮跑完即停, 回复保留** — 与终止语义区分, 测试钉) / queue (run 期间输入 FIFO 排队, 消费后清空); **每轮前自动 compress** (超预算丢中段保锚+当前轮); **skills 索引随每轮 system 注入** (EchoLlm 测试钉: LLM 真的看到); **cron 触发→拿锁防重叠→run→放锁** + **心跳 thinking 态**接线 |
| Web UI | 输入框 **⏹ 终止按钮** (AbortController + AbortError 显示"已终止", 终止连队列一起清) + **queue 徽标** (run 期间输入自动排队显示"排队 N", 按序消费) |

## 2026-10-25 第十一批 (UI 改版: Clarity 可见/空态居中/气泡动作/供应商弹窗/完全访问, e2e 6/6)

| 需求 | 落地 |
| --- | --- |
| **Clarity 按钮显示出来** | 输入框下方 composer-footer, accent 描边+SVG 图标显著样式, 点击出结构化摘要 |
| **完全访问权限, 随时取消** | `fullAccessBtn` toggle (红点态可见) + `/api/permission` GET/POST (AppState AtomicBool, 默认关 = 走 permission 门; e2e 钉: 默认关→开→取消) |
| **输入框空态居中/有内容落底部** | `main.chat-empty` class 切换 (renderChat 按消息数): 空态 hero 居中 + composer 随居中限宽 760px, 有消息后落底部 (附带按钮随落) |
| **模型供应商筛选按钮 (弹窗)** | composer-footer 并列 `供应商: 默认` → `/api/providers` (llm.provider_ids + base_url/model/has_key) → 弹窗列表选择 → localStorage 记忆 |
| **SVG 动作按钮** | assistant 气泡下: 复制/分支/分享/重试; user 气泡下: 复制/修改 (内联 SVG stroke 图标, hover 显现, 复制成功打勾); 分支=截断历史开新会话, 修改=回填输入框, 重试=取前条 user 重发 |
| **AI 头像/圆角/私有头像** | bot 气泡左侧圆角方块 🜁 (bolloon 图), user 右侧圆形私有头像 (account 顶部点击上传 → dataURL → localStorage, 气泡与侧栏同步); 流光 shimmer 沿用 |
| **创建按钮分离** | 创建智能体在左侧侧栏 (＋), **新会话在消息框左上角浮动** `#newChatFloat` (header 旧 ✦ 移除避免重复) |

## 2026-10-25 第十二批 (TS prompt 借用 / 判断力唤起 / 钱包全套工具 / 群邀请链接, 423 测试全绿)

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-agent/prompt`** (+11) | **系统提示词完全翻译 TS 版 `llm/system-prompt/registry.ts`**: PromptLayer (id/version/priority/appliesTo/maxChars) + 装配器 (过滤→priority 排序→单层截断→总预算 8000 硬限→`<!-- id@version -->` 拼接, never 层永不装配); **core.identity/core-traits/refusal 借用 TS 原文** (逐字关键句断言; 用户改稿保留: "你是 hibs 组织的智能体"); **判断力唤起核心引导**: `inject_judgment_gate` 双路径 — **有过去的经验会唤起** (jaccard 相似召回 top-3 带相似度%) + **有新的预测会唤起** (计划性输入标记: 将要/计划/打算/预测/… → 跨域高置信度情境提醒), 防重复 (already-injected 跳过), 1500 硬上限, 空库/空输入如实 skip; `build_system_prompt` 统一入口 (快照+skills+todo+judgment+history 说明, 全部层过预算门) |
| **`bolloon-x402/wallet_tools`** (+4) | **钱包全套工具, 私钥永不泄露**: address / balance / sign_message / **transfer_with_authorization (EIP-3009 USDC 形状**, BOL1 nonce, 授权即台账扣减) / **publish_task_onchain (在已有合约上发表任务**: escrow 地址由调用方给, 公告 entry+资金授权全签名) / **purchase (x402 购买)**; **泄露扫描测试**: 全部输出的 serialize+Debug 断言不含 seed 的 hex/b58/半段, 无 private_key/seed 字段 |
| **群聊邀请 (group_log 扩展)** (+5) | **分享链接要有**: `bolloon://join/<gid>?t=<b58 群主签名>&exp=<7 天>&by=<did>`; 验证 = 签名+过期 (伪造/篡改 gid/过期/形状不对全拒); **主动拉群**: `propose_group` 邀请事件上 oplog (带友好 greeting 🤝 + 邀请链接), 成员复制可见可加入; **群聊合作语气层** (channel.group-tone: 友好和善/主动拉群/分享有链接/接力不抢话, 仅群聊 channel 注入) |

## 2026-10-25 第十三批 (自动更新: 检查/提示/内部安装一条龙无弹窗, e2e 真网验证)

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-agent/updater`** (+7) | **未检测到更新之前不显示**: check 源不可达/无网络 → `status=unknown, update_available=false` (**绝不误报有更新**); semver 三段比较 (容忍 `v` 前缀); **安装一条龙**: 下载→校验 (≥1KB, 过小拒)→备份旧二进制→**原子替换** (tmp+rename, 运行中可换)→可执行位→失败自动回滚 (不把自己装残); **重启**: spawn 新进程 (同参数) + 旧进程退出; `UpdateSource` 端口注入 (真实现 GitHub Release latest/download, 测试 fake) |
| Web | 侧栏「系统」区更新按钮 — **默认 `display:none`**; 启动 + 每 30 分钟轮询 `/api/update/check`, **有更新才显示** (带新版本号); 点击 → 按钮文字"安装中… → 重启中…" (**全程无弹窗**) → 轮询 `/api/health` 等新服务起来 → `location.reload()` 完成一条龙 |
| CLI | `status` **tip 栏**: 有更新才输出一行 `tip: ⬆ 有新版本 X 可用 — 运行 bolloon update install`; `update check` (当前/状态/有无更新+说明) + `update install` (同 web 一条龙, 完成自动重启) |
| e2e | GitHub Release 真网检查: latest tag = **v0.6.10** = 当前 → `update_available:false` ⇒ 按钮不显示 (真实生效); 页面含隐藏按钮与 install 调用 |

## 2026-10-25 第十五批 (手机号/邮箱跨机查询与加好友 — 对齐 TS human-directory + directory-rpc, 18 测试 + e2e 10/10)

| Rust 模块 | 对齐 TS | 核心纪律 |
| --- | --- | --- |
| **`bolloon-agent/directory`** (18 测试) | `agents/contacts/human-directory.ts` + `directory-rpc.ts` | **盲化**: HMAC-SHA256(pepper, `salt‖normalized`) → hex (per-user salt 防离线枚举; pepper 换 → 哈希全变); **归一化**: phone 只留数字与 `+` / email trim+小写 / `sniff_kind` 按 `@` 判; **形状校验**: phone 8-15 位、email 标准形态 — 不 plausible 直接 found:false (不猜); 目录 publish/lookup/retract(软删标 revoked)/summarize — **明文与 pepper 绝不出现在条目里** (测试钉) |
| 跨机查询协议 (v3 帧) | directory-rpc.ts | op `agent.directory.lookup` → reply `…lookup.reply`; **rpcId 匹配才收** (串台 reply 不入); 超时 4000ms; 多 reply `pick_first_hit` (全 miss → found:false); 接收侧 `foreign_lookup` 用**本机 pepper** 查 (对端拿不到我的 pepper → 查不到) |
| 跨机加好友 | routes-contacts.ts | lookup 命中拿 did + publicKeyHex → 走 `FriendBook` consent 状态机 (**需对方同意, 不自动通过**); 重复请求幂等; 已撤销条目不可用于加好友 |
| Web 端点 | — | `/api/directory/publish｜lookup｜retract｜remote-lookup` + `/api/friends/request｜accept｜reject` + `/api/friends`; pepper 落盘 `contacts/pepper.json` **0600** (对齐 TS directory-pepper.json) |

**e2e 10/10**: 发布手机/邮箱 → 本机查(跨大小写) → **跨机查(手机+邮箱)** → 未发布 miss → **跨机加好友** → 同意进好友列表 → 幂等 → 落盘无明文。

## 2026-10-25 第十四批 (世界模式 + bolloon 色系深/浅主题, e2e 8/8)

| 项 | 落地 |
| --- | --- |
| **bolloon 色系** | 原 TS `src/web/style.css` 变量逐字搬入: 深色 `--bg:#1a1a18 / --accent:#c4d640 / --glow:#ffd166 / --user-bg:linear-gradient(135deg,#c4d640,#a4b630)`; 浅色 `--bg:#f0f0e8 / --accent:#8a9430 / --glow:#b77900` (此前是 hushforge 蓝色系) |
| **深/浅主题切换** | 三态按钮 `◐跟随系统 → ☾深色 → ☀浅色` (header 右侧), `data-theme` 属性 + localStorage 持久化; 无显式选择时 `prefers-color-scheme` 跟随系统 |
| **世界模式 (对齐 TS routes-world)** | 端点: `/api/intents` (增删) · `/api/opportunities` (按意图重打分 + 校准环过滤 + 信箱置顶) · `/opportunities/{id}/ignore|accept` · `/api/world/profile|watch|inbox|stats`; UI: header `🌍 世界` tab + 徽章, 主区 world-view (机会卡片带 score/**透明 reason**/scope 图标 🌐🎴) + 右侧意图列 (chip 可删 + 添加 + stats), 输入框 `/world` `/chat` 命令就地切面板 (不发消息), 15s 轮询 |
| **校准环** | 忽略的机会**同源不再流入** (e2e 钉: opp-000 忽略后 feed 中消失); 信箱卡片 score=2.0 恒置顶 |
| e2e | 8/8: 机会流非空 → 加意图重打分 (match:1/2 透明) → 忽略校准 → 接受 → 信箱置顶 → profile/watch/stats → 意图移除 → 页面结构 |

**协同修订 (第十三批期间)**: efficode 压缩扩展 (compression 字段 + pick_algo/compress_block, 数据块首字节恒写算法 id "解码端按 id 解不猜"); 群邀请**生成时守卫** (过期时刻≤当下直接拒, 不生成注定失效的邀请 — 双闸: 生成+验证); prompt identity 文案改稿 ("你是 hibs 组织的智能体")。三方修订全部纳入 436 测试。

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-agent/home`** (8 测试) | **CLI/Web/App/SDK 同一路径加载**: `BOLLOON_HOME`(缺省 ~/.bolloon) 下 `rust/` 子目录, env 一处解析四端共享 (真跑: CLI 写记忆 → Web 读同一份); **智能体专属目录** `agents/<id>/` (memory.json / soul.md / agent.md / sessions, agent_id 校验拒路径穿越); **文档快照冻结** `DocSnapshot::freeze` (内容+hash+盘状态): 运行期间盘上改动不影响快照 (快照即真源), `disk_drifted` 只标记"下一会话要 re-freeze", 缺失文档给内置缺省 |
| **`bolloon-agent/runtime`** (12 测试) | **AgentRuntime 多 session/多 agent 并发**: registry per-agent 独立快照+memory, per-session 独立历史, 跨 agent 访问拒; **每轮 system prompt 注入**: `assemble_system_prompt` = [快照稳定层 soul+agent+memory 摘录] + [动态层当前轮], 稳定层逐字不变 (测试钉: 三轮 stable 相等、盘改不见、re-freeze 后生效); **长执行 loop**: 上限 **200 轮** (冻结常量 MAX_ROUNDS, 跑满如实收尾不冒充完成), **工具调用次数不限** (单轮 20 工具真测), **无畏并发** (join_all 同时发起, 20×20ms 总耗时 ≪ 串行 400ms, 测试钉), **错误恢复** (工具失败/LLM 全重试失败 → 错误进上下文继续不中断), **超时重试** (指数退避 llm_retries=2), **目标 review** (goal_criteria 逐条核对, 未过打回继续直至上限, review 纯函数) |
| web/cli env 收口 | 两处 `data_dir()` 删本地口径, 统一走 `BolloonHome::resolve()` (单一真源, 四端共享); workflow 默认迭代 50 → **200** + 冻结测试 |

## 2026-10-26 第十六批 (做梦机制 dream: 整理记忆→提炼判断力→升级 skills, 幂等闭环 + 464 测试全绿)

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-agent/dream`** (8 测试) | **四个阶段每阶段如实记账, 不硬造产出**: ① **整理** `consolidate` — 临时层过期 (expires_at ≤ now) 剔除 + 相似记忆 jaccard ≥ 0.6 (与 judgment merge 同口径) 贪心聚类归并, 簇文本**保留最长的一条** (信息量最大, 不截断); ② **提炼** 经验 → `JudgmentStore::evolve`, **反向冲突标给用户 (`notes`) 不静默覆盖**, Created/Merged/Contradicted/Superseded 分别计数; ③ **升级** 经验 → `SkillCandidate` → `SkillEvolver::promote` (走批准门, 重复/垃圾被拒**计数不静默**); ④ **灵感** 从真实条目里挑 (簇成员最多的一条, 100 字截断), **没素材就如实报 `empty-memory`「梦境空空」, 不编洞察**; `should_dream(idle_ms, threshold_ms, busy)` 纯判定 (忙 → 不打扰); `dream_doc` 对齐 TS `/dream <主题>` 落盘文档 |
| **幂等 (本轮核心验证)** | 同一批记忆连做两次梦: 第一次 `新建 2 · 并入 0 · 晋升 2`; 第二次 `新建 0 · 并入 2 · 晋升 0 · 被拒 2` ⇒ **重复做梦不重复晋升** (测试 `second_dream_is_idempotent` 钉住, 且 `registry.len() == 首次晋升数`) |
| 跨进程积累 | `JudgmentStore::save_json/load_json` + `SkillEvolver::save_json/load_json` (坏文件 → 空库, **不冒充有判断/有技能**); 落盘 `~/.bolloon/rust/judgments.json` / `skills.json` ⇒ 一夜一夜地升级, 不是每次从零 |
| CLI | `bolloon dream [主题] [--domain all]` — 读 SQLite 记忆库 (500 条) → 做梦 → 打印报告 (扫描/过期/归并 · 判断力新建/并入/冲突 · skills 晋升/被拒 · 灵感) → 落盘; 给主题另写 `dreams/<日期>-<主题>.md`。**顺带收口**: `memory remember/recall` 从 `memory.json` 迁到 **SQLite `memory.db` 单一真源** (与 Web 同源; temporary 层给 1h TTL), 死代码 `memory_path/load_memory_store/save_memory_store` 删除 |
| Web | `POST /api/dream` (busy/不够空闲 → `skipped` 不做梦, 不打扰正在跑的任务) · `GET /api/dream/last` · `POST /api/dream/topic`; `AppState` 增 `skills: Arc<Mutex<SkillEvolver>>`, `NativeState` 增 `last_dream` (落盘) |
| 门禁 | `cargo test --workspace` **464 passed / 0 failed**; dream 8/8; CLI 真跑两次做梦复现幂等 (`新建 0 · 并入 2 · 晋升 0 · 被拒 2`) |

**诚实边界**: 提炼是**纯函数 (不调 LLM)**, 真语义抽象待接 LLM 端口; 无 cron 自动触发 (靠 CLI/`/api/dream` 手动或 kernel/cron 排程); `bolloon-web` 仍有 4 条 `unused variable st` + 2 个未接线 bootstrap/models 死代码告警 (预先存在, 本轮未动)。

## 2026-10-26 第十七批 (死代码补实现: 分享真链接 / 更新互斥 / 运行时版本 / 梦想作者 / bootstrap 真消息)

| 死代码 | 原状 | 补成什么 |
| --- | --- | --- |
| `native::share_session` | 返回 `/share/{id}` **假链接** (无该路由, 点开 404) | 真生成快照 `~/.bolloon/rust/shares/<token>.json`; token = 身份私钥签名 `(会话\|时间)` 取前 **24 hex** (不可猜, 不依赖随机源); 新增 `GET /share/{token}` 只读分享页 (内容一律 HTML 转义) + `GET /api/share/{token}` JSON; 会话不存在 → 明确报错不返回假链接; 只认 hex token, 拒路径穿越 |
| `native::update_apply` | `st` 未用 ⇒ 两个请求可**并发替换同一二进制** | `AppState.updating` 互斥 (`compare_exchange`); 已在装 → `{busy:true, installing:true}`; 拿不到 self_path / 装失败 / 装好但没能重启 → **释放**, 可重试 (不卡死在"安装中") |
| `native_update_info` | 用编译期 `CURRENT_VERSION` 比版本, 与运行时脱钩 | 新增 `updater::check_with(source, current)` 端口 (`check` 委托它, +1 测试), web 侧传 `st.version` |
| `native::dream_topic` | `st` 未用, 作者硬编码 `"user"` | 作者取本机 `profile.name` (显式传入优先); 写成的文档登记 `NativeState.dreams` (`#[serde(default)]` 兼容旧状态文件), `GET /api/dream/last` 一并返回 |
| `server::bootstrap` / `server::models` + `BootstrapResponse` / `BootstrapState` | 与 `native::bootstrap_native` / `native::models` **重复的旧实现** (未接线) | **删重复**; 把其独有的「真实运行期消息流」搬进 bootstrap: `state.messages` 不再是恒空数组 (取 `AppState.messages`, 先取再锁 forge 防锁序交错), 补 `state.edge`; `/api/models` 仍走 native 超集版 (has_key/write_tools) |
| 门禁 | — | 抽 `pub fn app(state)` / `serve_on(state, listener)` (路由与端口绑定分离); 新 e2e 真起服务 (端口 0) 走真 HTTP: bootstrap 形状 → 分享链接打开 → 坏 token 如实说不存在 → 梦想文档作者=profile/登记可查; `cargo test -p bolloon-agent -p bolloon-web` **301 + 5 全绿**, **bolloon-web 0 告警** (原 8 条全清) |

**诚实边界**: 分享快照**只读、永不过期** (token 不可猜, 删 `shares/*.json` 即失效; 没做撤销/回收) · 分享页只有文本消息, 不含头像与工具调用细节 · 更新安装仍在请求内同步跑 (互斥只防并发, 不改变长耗时) · `bolloon-cli` 当时正被另一条 TUI 移植线改动 (未接线且不编译), 全量 workspace 测试留给那条线收尾。

## 2026-10-26 第十四批 (CLI 端 UI **复用原 TS 的 CLI TUI** — 新 crate `bolloon-tui`, 87 测试全绿)

leo 口径: 「cli 端 UI 复用原 ts 的 cli tui」⇒ 不另设计一套终端 UI, 把 `src/cli/` 那套**纯 ANSI + 纯函数**的
视觉层**逐字搬**过来, 用测试钉住字节一致。新 crate `rust/crates/bolloon-tui` (**库**, 不是塞进 bin 模块 ——
bin 里 `pub` 项会被判 dead_code, 库 crate 才是它的正确落位)。

| Rust 模块 | TS 原文 | 搬的是什么 / 钉住的判据 |
| --- | --- | --- |
| `theme` | `src/cli/theme.ts` | THEME token 表逐字 (10 个 hex) + `fg`/`bg` 与 `\x1b[38;2;196;214;64m` 逐字节; `C_*` 常量写成字面量后用 `derived_colors_match_palette` 逐条断言 `C_* === fg(THEME_*)` (**改调色板忘改常量 ⇒ 立刻红**) |
| `width` | `loading-tui.ts` / `status-segments.ts` | `dispWidth` 的 East-Asian-Width 判据 (CJK/全角=2, ANSI 不计宽) · `dispWidthSafe` 的 Ambiguous 保守子集 (18 个字符按 2 列) · `truncate`/`truncateSafe` · 终端尺寸走 `ioctl(TIOCGWINSZ)`, 非 TTY 兜底 80/24, 另有 `set_term_size` 供门里钉尺寸 + `wait_for_term_size` |
| `boxart` | `loading-tui.ts` | 方角 `SQ` / 圆角 `RD` + `boxTop/boxRow/boxBottom`; 每行宽度恒等于框宽 |
| `brand` | `loading-tui.ts` | 机器人头 6 行 + BOLLOON 艺术字; **实测大号 61 列 / 小号 37 列** (TS 注释里写的"87 列"是旧稿估值, 以实测为准); `pick_banner` 按内宽降档 大→小→文字 |
| `markdown` | `src/cli/markdown.ts` | `mdInline` 四次 replace 的**顺序**与"内容里不许出现定界符"判据; `a*b*c` 不误判斜体 |
| `trace` | `src/cli/trace-line.ts` | 28 条工具→中文动作短语表 + `toolArgsSummary` (认不出就留空, **绝不显示空白**) |
| `panel` | `loading-tui.ts` | 仪表盘/对话框/消息框/引用框/工具行/diff 着色; **空回复不出空框** (2026-10-19 那条) 有测试钉 |
| `loading` | `loading-tui.ts` | `LOADING_FRAMES` 6 帧逐字 + `LoadingTui` 原地刷新 (帧行数 = 上框+艺术字+steps+spinner+下框, 靠 `\x1b[nA` 回退), 后台线程 100ms/帧 |
| `select` | `src/cli/tui-select.ts` | 固定高度视窗 `max(3, min(40, rows-3))` · 视窗外**根本不画** · 上下"还有 N 家"指示 · 光标行 `ESC[7m` + accent 底 + `→ ` 前缀 (**符号通道不依赖颜色**) · 六种一等选择方式 (↑↓/Enter/数字跳行/筛选/折叠/滚动) · `parse_keys` |
| `scroll` | `src/cli/keymap.ts` | 滚动键位表 + `apply_scroll` 位移; `stick` = 贴底跟随, 上滚即暂停, End 恢复 |
| `screen` | `ink-app.tsx` 的**几何纪律** | 帧高恒 = rows · 输入行号恒 = rows-2 · 四个固定行 (rule/status/input/hint) · 超宽先截断不折行 · 跟随可暂停 |
| `history` | `src/cli/input-history.ts` | 一渠道一文件 `input-<ch>.jsonl` (**0600**) · **秘密不写盘** (64 位 hex / 助记词形态 / 私钥字样) · 连续重复去重 · 内存 200 / 文件 500 原子裁剪 · 坏行跳过 |
| `input` | `tui-select.ts` 的 `tuiAskLine`/`tuiAskMasked` | termios raw 模式逐键编辑 + ↑↓ 历史 + 掩码 (`•` 按**字符数**不是字节数); 非 raw 退化为读一行 (不卡住) |
| `compose` | (**新增**, 无 TS 对应) | 输入缓冲状态机 (纯函数): 多行 / 历史游标 / 草稿 / 贴图的**语义**; `resolve_action` 是键→意图唯一映射; `render_input` 负责多行几何 (每行 ≤ cols-1, 超行留尾部 + `… (+N 行)`) |
| `help` | (**新增**, 无 TS 对应) | `bolloon chat` 键位文案**唯一事实源**; `HELP_ITEMS` 与 `compose::resolve_action` 在测试里逐条互钉 (**写了没做 / 做了没写 都会红**) |
| `clipboard` | (**新增**, 无 TS 对应) | Alt+V 贴图: 剪贴板图片 → `~/.bolloon/rust/paste/paste-<ms>.png`; 平台差异只在这一处 (macOS pngpaste/AppleScript · Linux wl-paste/xclip · Windows PowerShell), `BOLLOON_PASTE_CMD` 可整条接管 |

**接线** (`bolloon-cli/src/main.rs`): `bolloon` / `web` → 启动仪表盘 (4 步, 真终端才画; 非 TTY 一行说清) ·
`status` → 品牌仪表盘 (更新 tip **有更新才出现**) · 新增 `bolloon chat [--channel X]` → 全屏面板壳 + 用户/智能体
消息框 + 工具调用行 (一行说清"它在做什么") + 输入历史 · 新增 `bolloon model` → 全屏光标选择器 + **掩码输入**
(密钥只报长度, **不回显不落盘**; Rust 侧暂无 config store, 只给 env 用法) 。

**真跑证据**: `cargo check --workspace --all-targets` **0 error / 0 warning** · `cargo test --workspace`
**557 通过 / 0 失败** (原 439 + tui 87 + 做梦线 31) · `bolloon status` 出带品牌艺术字的仪表盘 ·
管道输入 `printf '你好\n/exit\n' \| bolloon chat --channel smoke` → 品牌 banner + `✓ 已发送` 框 + 真 401 错误
如实报出 (不冒充成功回复) + 历史真落盘 `~/.bolloon/rust/history/input-smoke.jsonl` (**权限 0600**) ·
`bolloon model` 非 TTY 时退回编号清单 + 用法 (不进全屏菜单)。

**两处刻意偏离 TS** (都写进代码注释): ① `loading` —— TS 的 `LoadingTUI.draw` **没有** `renderDashboard` 那道
"装不下就不画艺术字"的闸 (80 列下 77 列艺术字塞进 74 列内宽 ⇒ 行被折成两截), 这里按 2026-09-30 的规矩补上**降档**;
② `select` —— 鼠标滚轮上报 (`?1006h`) 与 `SIGWINCH` 重绘**未移植**, 键盘六种方式都在。

**诚实边界 / 未做**: `setup-wizard.ts` 七步向导未移植 (属业务流, 且 Rust 侧还没有 config store) ·
OSC52 剪贴板 (`/copy`, 把**文本**送出去) 未做 · `ink-app.tsx` 的 React 壳本身没搬 (搬的是它定下的**几何纪律**, 见 `screen`) ·
`renderDashboard`/面板类的颜色**不按 TTY 门控** (与 TS 同: 写出来就带 ANSI, 管道里也会有转义码) ——
这一条若嫌脏, 后续可在 `main.rs` 出口统一过一道 `NO_COLOR` 剥离, 记在这里当欠账。

## 2026-10-26 第十五批 (chat 输入框: 帮助文案 + 四条快捷键**全实现**, 112 tui 测试 / 全 workspace 582)

**问题 (leo 三问)**: 「这段帮助文案要落到哪个终端? 不只是帮助页, 要完成实现, 只在 Rust 实现」
「这次做到哪一步?」→ 「文案 + 快捷键全实现 (多行输入 Ctrl+J/Alt+Enter、Ctrl+G 草稿、Alt+V 贴图都真做)」。

**落到哪个终端 (答)**: 只落 **`bolloon chat` 这个 Rust 终端界面** —— 完整帮助页走 `Screen` 正文 (`/help` 触发),
一行摘要走 `Screen` 最底那条固定提示行 (`rows-1`)。Web 终端、`bolloon model` 的 TUI 选择器、TS 版 CLI **都不吃这份文案**
(TS 侧一行未动, 全在 `rust/`)。

**新增/改动**:

| 文件 | 改了什么 |
| --- | --- |
| `bolloon-tui/src/compose.rs` (新) | 输入缓冲状态机 (纯函数): `resolve_action` 键→意图 · `Compose` (缓冲/历史游标/暂存) · `render_input` 多行几何 |
| `bolloon-tui/src/help.rs` (新) | 键位文案唯一事实源: `HELP_ITEMS` / `HINT` / `help_page()` |
| `bolloon-tui/src/clipboard.rs` (新) | 剪贴板图片 → PNG 落盘 (macOS/Linux/Windows + `BOLLOON_PASTE_CMD` 接管) |
| `bolloon-tui/src/input.rs` | 重写: 多行重画 (上移 N 行 + 清到屏末) · Ctrl+G 起 `$VISUAL/$EDITOR` (真交还/重进 raw) · Alt+V 贴图 + 状态行 · 掩码不再允许换行/草稿/贴图 |
| `bolloon-tui/src/select.rs` | `Key` 增 `Newline/AltEnter/CtrlG/AltV`; `parse_keys` 把 `\r`(Enter) 与 `\n`(Ctrl+J) **分开**; 新 `read_key_raw` 用 `poll` + **裸 `libc::read`** (见下"踩坑"①) |
| `bolloon-cli/src/main.rs` | hint 改用 `tui::help::HINT` · `/help` `/ ?` 出帮助页 (不写历史) · 帧高 = `term_height()-1`, 最后一行留给输入块 |

**键位→行为 (全部真跑, 不是只写文案)**:
`Enter` 发送 (多行整段一起发) · `Ctrl+J` / `Alt+Enter` 换行 (raw 模式下 Enter=`\r`, Ctrl+J=`\n`, **不同字节** ⇒ 可分辨) ·
`Ctrl+G` 用 `$VISUAL`/`$EDITOR` 写草稿, 存盘返回即成输入 (草稿空 ⇒ 保留原输入, 不弄丢已打的字) ·
`Alt+V` 贴剪贴板图片 → `~/.bolloon/rust/paste/paste-<ms>.png` → 插入 `@路径` · `↑↓` 历史 · `Esc`/`Ctrl+C` 取消 · `Ctrl+D` 退出 · `/help` 帮助页。

**验证 (真跑)**:
- `cargo check --workspace --all-targets` **0 error / 0 warning** · `cargo test --workspace` **582 通过 / 0 失败**
  (原 557 → 582, +25: compose **10** · clipboard **6** · help **4** · select **3** · input **2**)。
- **真机 pty 端到端** (python `pty` 驱动 `target/debug/bolloon chat`, 非模拟):
  ① `第一行` + `Ctrl+J` + `第二行` + `Enter` → `✓ 已发送` 框里**两行都在** (干净 401 如实报出);
  ② `/help` → 帮助页 8 条键位 + 两段说明, 提示行含 `/help`;
  ③ `Ctrl+G`: 缓冲写成 `printf … > "$0"` 脚本, `VISUAL=/bin/sh` 真跑一次编辑器往返 → 读回两行 + 状态行 `✓ 草稿已读入 · 2 行`;
  ④ `Alt+V` (`BOLLOON_PASTE_CMD`) → 真落 `paste-<ms>.png` (7 字节 PNG 签名) + 插入 `@/…/paste-….png` + 状态行 `✓ 已贴图`.

**踩到的坑 (都写进代码注释了)**:
① **`std::io::stdin()` 的 8KB 用户态缓冲**把多字节输入吃掉 —— `read(1)` 先把 9 字节吸进 `Stdin` 缓冲, 内核缓冲变空 ⇒
  随后 `poll` 判"没数据" ⇒ 超时 ⇒ 中文续字节被当"孤独的 Esc"丢弃。真机现象: 打 `第一行` 只剩 `行`。改用**裸 `libc::read`** 后 poll 与读同一缓冲。
② **孤独的 Esc 会挂住**: 原来读到 `0x1b` 就阻塞再读 2 字节 ⇒ 按 Esc 要等下一个键。现在 `poll` 给 **40ms** 宽限。
   Alt+Enter / Alt+V 正是靠这个宽限窗口识别的 (`ESC` + `\r` / `v`)。
③ **帧高算多一行**: 原来帧 = `rows` 行, 再 `println!()` 给输入行 ⇒ **单行输入也会把整帧顶上去一格** (帧顶永远看不到)。
   现在 `frame_rows = term_height()-1`, 最后一行就是输入块; 多行输入再额外占行, 靠往上滚消化 (有意为之, 与 `screen` 的帧内几何无关)。

**边界 (如实)**: `ChatMessage.content` 是单模态 `String` ⇒ **Alt+V 只把 `@路径` 插进输入, 像素没进模型**
(视觉编码要先改 `bolloon-llm` 的请求体, 记欠账); 掩码输入禁用换行/草稿/贴图 (秘密不落盘);
输入缓冲**没有光标移动** (`← →` 明确不响应, 不当假动作); 非 TTY (管道) 仍是一行一读, 多行靠调用方自己拼。

## 2026-10-26 第十六批 (`bolloon chat` 命令面: 118 条全量注册, 27 条真实现)

leo 贴出 Hermes 风格 118 条 `/命令` 并要求「都要有」。口径三条: **全量注册** / **能做的真做** / **做不到的写清原因**
(不拿"没实现"冒充"已实现")。

| 文件 | 角色 |
| --- | --- |
| `bolloon-cli/src/slash.rs` (新) | 命令**唯一事实源**: 118 条 (93 命令 + 25 别名) · 分类/用法/说明 · `Status::{Ready, Planned(原因), Na(原因)}` · `parse` / `find` / `help_lines` / `detail_lines`; 别名用 `alias_of` 继承本体状态 (逻辑只有一份) |
| `bolloon-cli/src/chat_command.rs` (新) | 命令**实现**: `ChatSession` (消息/标题/模型/附件 + 会话落盘 `~/.bolloon/rust/chat/sessions/<id>.json` **0600**) · `Cmd` 结果枚举 (Say/Send/Prefill/Clear/Redraw/Update/Quit) ⇒ 命令逻辑不碰终端 |
| `bolloon-tui/src/{input,select}.rs` | 整段会话持 raw (`hold_raw_mode`, 可重入深度) · `Esc`/`Ctrl+C` 改为"只丢当前输入" |
| `bolloon-tui/src/clipboard.rs` | 新增 `copy_text` (`/copy` 用): pbcopy / wl-copy / xclip / clip, `BOLLOON_COPY_CMD` 可接管 |

**真实现 27 条** (每条都有单测, 且 `every_ready_command_has_an_impl` 把 27 条各跑一遍防"标了没做"):
`/new /reset /clear /redraw /history /save /retry /undo /title /prompt /compose /resume /sessions /plan /worktree`
`/compress /compact /status /context /ctx /config /model /profile /diff /help /copy /paste /image /update /version /v /quit /exit`。

**85 条不可用的原因分类** (帮助页带 `[待接]`/`[不适用]`, `/help <命令>` 展开):
没有 agent 循环 (`/bg` `/queue` `/steer` `/loop` …) · 没有消息网关 (`/handoff` `/branch` `/platforms` …) ·
Hermes/Nous 账号计费面 (`/login` `/topup` `/subscription` …) · 只有一套品牌主题 (`/skin` `/pet` …) ·
审批门在 Harness (`/yolo` `/approvals`) · 底座在但没接线 (`/goal` `/heartbeat` `/review` `/snapshot` `/skills` …)。

**行为变更 (需要记住)**: `Esc` / `Ctrl+C` 不再退出会话 —— 只丢当前输入, 退出用 `/exit` 或 `Ctrl+D`
(以前 `/undo` 回填后按 Esc 会把整个会话关掉)。会话库 `chat/sessions/*.json` 是 `/resume` `/sessions` `/quit --delete` 的事实来源。

**验证**: `cargo check --workspace --all-targets` 0/0 · `cargo test --workspace` **607/607** (+25) ·
真机 pty 18 项 PASS · 管道 `/help` 出 118 条 / 7 分类。

**边界**: 视觉编码未接 (`/image` `/paste` 只把 `@路径` 拼进消息) · `/compress` 是**截断**不是摘要 ·
非 TTY 仍一行一读。

## 2026-10-26 第十七批 (视觉编码 + agent 循环 + 快照回滚: 上批三条边界全部收掉)

| 层 | 改了什么 |
| --- | --- |
| `bolloon-llm` | `ChatMessage.images: Vec<String>` (data URL) · `messages_payload()` 唯一收口 (无图时形状与旧版一致; 有图时 content 变视觉数组) · `is_vision_model()` / `check_vision()` 闸 |
| `bolloon-cli` `chat_command` | 轮末调度 `next_scheduled` (busy: steer/queue/interrupt) · `/queue` `/steer` `/busy` `/loop` `/goal` `/subgoal` `/bg` `/agents` `/tasks` `/stop` `/btw` `/review` `/refine` · `/snapshot` `/rollback` · `/compress focus` 摘要 · `/skills` |
| `bolloon-cli` `main` | 每轮之后 (成功/失败) 推一次调度, 自动轮带来源标记、不进输入历史、单次≤6 轮 |
| `bolloon-cli` `slash` | 15 条命令状态翻 Ready (118 条 = 53 可用 / 33 待接 / 18 不适用) |

**关键判据**:
- **像素真进模型**: 请求体 mock 抓包断言 `content[1].type == "image_url"`; 被视觉闸拒绝时附件**保留**可换模型重发。
- **循环不会卡死**: 调度取走即消费、loop 取走即排下一次、自动轮上限 6、失败即停。
- **快照真恢复**: 改坏 `skills.json` → `/rollback 1` → 内容回到快照里的字节。
- **摘要 ≠ 截断**: `focus` 走模型并把结果以 assistant 角色放最前; `here N` 继续自称截断。

**验证**: `cargo check --workspace --all-targets` 0/0 · `cargo test --workspace` **618/618** · 真机 pty **32 项** PASS。

**仍未做 (照实)**: `/heartbeat` (需要能收定时器的非阻塞输入循环) · `/moa` (多模型编排) ·
`/goal` 的 `draft/gate/wait` 子命令 · `/timestamps` `/focus` 等展示类开关 · 网关/账号/宠物一类仍 `Na`。

## 2026-10-26 第十八批 (Rust 侧 200+ provider + web 真对话 + CLI model 全量, 645 测试全绿)

**背景**: web 端「对话」此前是**桩** —— `generate_reply` 只回「模型通路已配置」不回模型; LLM 侧只有 OpenAI 兼容一条协议、provider 只能从环境变量来。本轮把 TS 那套 provider 能力在 Rust 补齐。

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-llm/provider_catalog`** (4 测试) | **与 TS 同一份事实源**: `include_str!("../../../../src/llm/data/provider-catalog.json")` (223 家 / 8174 模型 / 936KB, **不复制不手抄**); 形状不认就拒 (`MIN_PROVIDERS_FOR_TRUST=100`, 少了当坏文件); **族判定** npm 包名 → 云凭证环境变量 → 兜底 openai-compatible, **每条带 signal 理由**; **鉴权形状** bearer / x-api-key / x-goog-api-key / none / special (`special` ⇒ `supported=false`, 如实标"不支持"不假装能用) |
| **`bolloon-llm/provider_registry`** (6 测试) | 内置 13 家 (与 TS `DEFAULT_PROVIDER_CONFIGS` 逐条对齐: id/基址/默认模型) + 自定义 + 目录 → **同一个 `ProviderRegistryEntry`** (`origin` 三值); **目录同名/别名去重** (gemini↔google / kimi↔moonshotai / glm↔zhipuai / qwen↔alibaba / mimo↔xiaomi / grok↔xai), 内置家的模型清单从目录挂过来 ⇒ 界面可下拉选模型; 总表 **225 家** (内置 13 + 目录 223 − 别名 6 − 同名若干) |
| **`bolloon-llm/config_store`** (10 测试) | **与 TS 同路径同形状**: `${BOLLOON_HOME:-~/.bolloon}/bolloon-config.json`, camelCase (`activeProvider` / `providers` / `customProviders`), **0600 + tmp + 原子 rename** (单写入路径), 坏文件 → 空配置**不猜**; 解析顺序 配置 key → 环境变量 (按注册表变量名顺序) → 注册表默认; **缺 key/缺模型/缺基址给可操作报错** (点名环境变量); 回显只给 `authRef` (`config` / `env:XXX` / `none`), **永不回显密钥** |
| **`bolloon-llm/runtime` 四协议** (9 测试) | `ProviderConfig` 不变 (零 churn), 协议放在 `ProviderSlot`; `generate` 分派 **4 条真分支**: openai-compatible `/chat/completions` · **anthropic `/messages`** (`x-api-key` + `anthropic-version`, system 抬顶层) · **gemini `:generateContent`** (`x-goog-api-key`, `contents/parts`, `systemInstruction`) · **ollama `/api/chat`** (无鉴权, `stream:false`); 出网/重试/退避**唯一收口** `post_json`; **空 tools 不再发** (有的家见 `[]` 直接 400); `LlmRuntime::from_config` 只装能解析的家 |
| **web: 真对话** | `/api/chat` · `/api/chat/stream` · `/api/send` 统一走 `reply_with_model`: provider = UI 选中 → 配置 active → runtime 第一家, 模型 = UI → provider 默认; 上下文取最近 12 条 + 本轮, 并把轮次写回 `messages` + `sessions/*.jsonl`; 失败把**原因**当回答返回 (缺 key / 缺模型 / HTTP 4xx) 而不是假装成功; `AppState.llm` 改 `RwLock<Arc<LlmRuntime>>` + `reload_llm()` (改 key 不用重启) |
| **web: 200+ 列表/测试/选型** | `GET /api/models` · `/api/models/providers` 回**全量 225 家** (origin/protocol/has_key/models_count/note); `GET /api/models/options?provider=` 回该家模型清单; `POST /api/models/select` 选一家 (可带 key/base_url/model, 落盘 0600 + 重载 runtime); `POST /api/models/test` **真发一条 ping** (max_tokens 8) 回 ok/ms/协议/错误; `/api/settings` 的 `api_key`/`base_url` 不再被忽略 |
| **web UI** | 模型弹窗: **筛选框** (id/名称/协议) + **按来源 optgroup** (内置/已配置/目录) + 模型 **datalist** 建议 + **测试连接** 按钮 (显示 ✓ 协议/model/ms 或 ✗ 原因); 家数提示 |
| **CLI `bolloon model`** | 从 5 家硬编码 → **全量 225 家** 全屏选择器 (分组: 当前/已配置/内置/目录) + `--filter` 关键词 + `--usable` 只看可用 + 直接 `bolloon model deepseek --model deepseek-v4-flash`; 密钥**掩码输入** (已存则留空不改), 落盘同 TS 同一份 config; 结束回显 provider/protocol/base_url/model/authRef |
| **CLI `bolloon chat`** | 通路改为 `build_chat_llm()`: **配置 activeProvider 优先** → env 三件套 → 本机可用家; 选中的家连**协议**一起装进 `"env"` 槽位, 故 200+ 家里任何一家都能直接对话; `/config` 显示配置来源与 authRef |

**门禁 (真跑)**: `cargo test --workspace` **645 passed / 0 failed** (llm 44 · web 5 · cli 113 …); 真起 web (`BOLLOON_HOME` 临时目录): `/api/models/providers` **231 家** (含条目 `count`) → `POST /api/models/select {"provider":"deepseek"}` → `{"ok":true,"protocol":"openai-compatible","auth":"env:DEEPSEEK_API_KEY"}` → `POST /api/chat` **真打到上游** (返回 401 是本机 env key 失效, 证明通路已通); `/api/models/options?provider=deepseek` 回 4 个模型; 坏家/缺 key 都给出点名报错; CLI `bolloon model --filter deepseek` 列表、`bolloon model deepseek --model ...` 落盘 `0600` 全通过; pty 抓 `bolloon chat` 首屏: 机器人头 + BOLLOON 字标 + 状态行 `model deepseek-v4-flash` (来自 config store) + 输入条。

**诚实边界**: ① **流式仍是「先整段生成再切块」** — `chat/stream` 的 delta 是事后按 24 字切, 不是上游 token 流 (真 SSE 待接 reqwest stream); ② 工具循环/agent loop 在 CLI 侧有, **web 侧仍是单轮** (web 是薄层); ③ 图片只走 OpenAI 视觉数组, anthropic/gemini 分支**暂不发图**; ④ `special` 家 (AWS/Azure/Vertex/watsonx 等, 约 20 家) **如实不支持**, 用自定义 provider 也需自备签名; ⑤ 上游模型发现 (`/v1/models` 拉取 + 30 分钟缓存) 未移植, 模型清单来自目录快照 (可手填); ⑥ 目录来自 TS 烘焙文件, **刷新要跑 TS 的 `scripts/gen-provider-catalog.ts`** (Rust 侧不自己拉 models.dev)。

## 2026-10-26 第十九批 (Tauri App 桌面三栏式侧边导航, 网页端不变)

| 项 | 落地 |
| --- | --- |
| **三栏布局 (Three-column Sidebar Layout)** | 第一栏 `.primary-rail` 56px 全局导航 (💬智能体/会话 · 🌍世界 · 🗨内部商议 + 底部主题/设置/头像) · 第二栏复用现有 `<aside>` 按模块显隐 (`dmod-chat`=智能体/会话 · `dmod-world`=意图面板) · 第三栏 `main` 主内容区 (room 面板仍是可开合附加列) |
| **开关走壳, 不搞嗅探** | `app-tauri/main.rs` 加载 URL 加 `?app=desktop` (一行) — UI 侧 `isDesktopShell` 判定加 `body.desktop3col`; 浏览器访问同一端口不带参数 ⇒ 全部新 CSS/JS 不生效, 网页端零改动。壳仍只改导航 URL, 不写业务 |
| **第二栏不重复造** | 世界意图面板 `.world-side` **整体 DOM 搬进第二栏** `#worldSideSlot` — id 全不变, `loadWorld/addWorldIntent/worldStats` 等 JS 原样工作; 主区世界流变全宽 (不与第二栏重复同一份意图 UI)。第一栏底部全局入口 relay 到现有按钮 (themeBtn/roomBtn/settingsBtn/brandLogo click()), 不重复绑定; 头部 `#worldTabBtn/#roomBtn` 桌面下隐藏 (消除重复导航) |
| **更新按钮也进第一栏** | `#railUpdateBtn` ⟳ 放 rail 底部簇, **默认 `display:none`**, `renderUpdate()` 里 `syncRailUpdate()` 同步: 仅 `update.available` 才显形 + glow 脉冲 (复用 `pulse` 动画), 点击 relay 到 `#updateBtn` 同一套安装流 (下载→校验→原子替换→重启→reload), 不另写一份; 三栏下第二栏 `.side-update` 隐藏 (不重复)。**无更新/源不可达 (unknown) 一律不显形** — 沿用第十三批「绝不误报」纪律 (真跑 `/api/update` = available:false ⇒ 按钮不出现) |
| **更新一条龙 (点击即装, 装完自动重启, 不弹窗)** | 把 `#updateBtn` 的处理抽成 `runUpdateFlow()` (侧栏与第一栏 rail 同一个入口): 点击 → `/api/update/apply` (后端 下载→校验→备份→原子替换→spawn 新进程) → `waitForRestart` 轮询 `/api/version` → `location.reload()`, **全程无 alert/confirm/prompt**, 进度只写在按钮上。**修真 bug**: `waitForRestart` 原用 `j.version===latest` — `/api/version` 回 `0.6.10` 而 GitHub tag 是 `v0.6.10` ⇒ **恒不相等** ⇒ 20s 后判「重启超时」⇒ **自动重启这条链一直是断的**; 改 `normVer()` 归一 (去 `v`/`V` 前缀, 空目标版本时服务重新应答即算已重启), 窗口 20s→30s。**进度可见**: 桌面三栏下第二栏 `.side-update` 已隐藏 ⇒ 新增 `setUpdateStage()` 把 安装中⏳/重启中⏳/✓/⟳ 同步到 rail 按钮 (图标+title), 不再「点了看不见任何反馈」 |
| **联动** | `setPanel` 内同步模块 (header 世界 tab / 输入框 `/world` `/chat` 命令切面板时第一/二栏跟着切); `setRoomOpen` 同步 rail 🗨 按钮态; `setPanel`/rail 点击互为入口 |
| **响应式/折叠** | 第二栏折叠沿用 `#app.collapsed` (66px 图标列); ≤860px 窄窗第二栏自动收成图标列 (第一栏/主区保留); collapsed/room-open 两态的 grid 模板都适配三栏 |
| **折叠态: 图标保位 / 按钮隐去 / 点图标展开** | 折叠后 **Bolloon 图标留在原位** (覆盖全局 `#app.collapsed .brand{justify-content:center}` — 那条把图标挪到栏中央, 与"保留位置"相反), wordmark 文字与 `#collapseBtn` 一并隐去 (66px 栏里原会挤字), 再点 Bolloon 图标即展开; 抽出 `collapseSidebar/expandSidebar/syncCollapseHint`, 两处 Bolloon 图标 (第二栏 brandLogo / 第一栏 railLogo) 行为一致, title 随态提示「展开侧边栏」 |

**验证**: `cargo test -p bolloon-web` 5/5 · `cargo check` (app-tauri) 0 error · 真跑起服务 `/api/health` ok, 页面含 `desktop3col`×27 / `primary-rail`×4 / `worldSideSlot`×5 标记。**诚实边界**: 未真开 Tauri 窗口目验 (需 `cargo tauri dev`); 第二栏折叠未做宽度 0 (沿用 66px)。

## 2026-10-26 第二十批 (群聊真正接入 OrbitDB: 内容寻址 + 落盘 + 可复制)

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-p2p/orbit_store`** (新增) | **内容寻址的持久化 events store**: `StoreManifest` (name/type/owner/write ACL) 的 canon 哈希 = **address** (内容寻址, 可按地址打开); 每个 entry = `blocks/<hash>.json` (内容寻址); **blocks 是唯一真源**, manifest 里的 heads 只作复制协商缓存, 重开由 blocks 重放重建; 原子写 (tmp+rename); 打开时逐块验签 + ACL + prev 完整性, **坏块不进 oplog 且如实计数**; address 与 manifest 不自洽 ⇒ 拒 (`AddressMismatch`) |
| **`bolloon-p2p/group_orbit`** (新增) | **群 = 一个 OrbitDB store**: 群 id→address 索引落盘 `groups.json`; 消息 = oplog entry (hash 链 + Ed25519 签名 + ACL 门); `create_group`/`import_group`(按 manifest 开**同一个** store)/`say`/`reply`/`history`/`replicate_from`; **邀请链接带 manifest** (`bolloon://join/<id>?...&m=<b58 manifest>`), 群主签名覆盖 group_id+过期+manifest, 验证时还校验 manifest.owner==签名者 DID |
| **`bolloon-p2p/replication`** (扩展) | 新增 **`FileExchange`** —— 真块从磁盘读 (与跨机传输**同一端口形态**, 只认 hash 不认人); 复制协议 (`replicate`) 跨内存/磁盘两实现**一致** |
| **`bolloon-p2p/oplog` (改)** | `WriteAcl` 加 `open` 变体 (对齐 TS `write:'*'`) + `OpLog::contains` |
| **web 接线** | `AppState.groups` 从内存 `GroupStore` 换成 `GroupOrbitHub`, 落盘到 `~/.bolloon/rust/orbitdb/`; `/api/room*` 与 `/api/groups*` 全走 oplog (真签名/落块); `orbit_status` 由谎报的 `"local-oplog"` 改为如实 `"oplog-persisted"` 并附 `orbit_address`/`orbit_entries` |
| **删除** | 删除内存 `group_store.rs`(GroupStore) 与内存 `group_log.rs`(GroupLog) —— Rust 侧群聊**只有一条执行路径** (OrbitDB), 不再有两套真相 |

**门禁 (真跑)**: `cargo test -p bolloon-p2p` **50/50** (含 `two_nodes_converge_via_exchange` 真两目录两节点复制收敛、`create_append_reopen_recovers_entries` 重启恢复、`tampered_block_is_rejected_on_reopen` 篡改拒收、`acl_owner_only_blocks_stranger_on_disk_store` ACL 拒、`manifest_address_mismatch_rejected`、邀请伪造/过期/篡改拒); `cargo test --workspace` 全绿; `cargo build --workspace` 0 error。

**诚实边界**: ① 跨机传输本身**未接** — `FileExchange` 是「同机不同目录 = 两节点」的磁盘真块交换, 跨机只需把这一层换成网络传输, 上层复制协议一行不改; ② **分片轮转未做** (与 TS 产品路径一致: 单库 events store); ③ 邀请链接带 manifest 是「被邀请方按同一 address 开同一个 store」的载体, 但 web 层还没暴露 import 入口 (前端 UI 暂无加入群表单); ④ `orbit_status` 如实标注 `oplog-persisted` (本地 oplog 已落盘), 不再谎报 `channel:"orbitdb"` 却走内存。

## 2026-10-26 第二十一批 (Rust 归属签名 `bolloon-ownership/1`: agent 归属担责 / 钱包归属 / 手机号邮箱绑定)

**动机**: leo 要求「用户后续身份确认都要 DID 签名 (含手机号/邮箱绑定), 对智能体也要归属签名并对 agent 负责」。Rust 侧此前 `owner_sig`/`ownerSig` 全是**空占位、从不验签**, 目录条目可被任意 `did` 字符串伪造 (只有 HMAC 盲化防枚举, 不防冒充身份)。**本命结论: Rust 的 DID 体系保持 DIAP 的 `did:pi:`, 不做替换。**

| Rust 模块 | 冻结语义 |
| --- | --- |
| **`bolloon-p2p/identity`** (扩展) | DID **可反解公钥** (`pubkey_of_did`) —— `did:pi:` 的内容就是公钥本身 ⇒ 天然可反解, 也能读 W3C `did:key:z…` 便于跨实现互验; 新增 `did_pi_to_key` / `did_key_to_pi` **互认转换 (只是互认, 本命仍是 `did:pi:`)**; 测试钉住「只有 DID 字符串就能验签」 |
| **`bolloon-p2p/attestation`** (新增) | **统一归属签名** `bolloon-ownership/1` (**一套代码管三类归属**, 不各写一套): `agent` = owner 声明「该智能体归我, 我对它负责」(**这就是担责**) / `wallet` = 钱包地址归该 agent / `phone`+`email` = 联系方式归我; canonical (serde_json Value = BTreeMap ⇒ **键字母序**, 两侧重算一致) + Ed25519 签名; **`owner_did` 必须就是签名者自己的 DID (不许替别人签)**; **自验不过即拒返回/拒落盘** (对齐 TS `address-binding` 范式); 判据: `protocol`/`statement_canonical`/`id_matches_statement`/`owner_did_resolvable`/`owner_sig_shape`/`owner_sig`/`nonce_shape`/`not_expired`/`nonce_unused` |
| **`bolloon-agent/directory`** (改) | 新增 **`publish_signed`** (用本机 keypair 对「这个联系方式归我」签名, 复用 attestation) + **`verify_entry`** (用落盘字段**重建** statement 后验签 ⇒ 为此新增 `owner_nonce` 字段); `LookupHit` 加 **`verified`**; 跨机 reply 帧 **`LookupReplyPayload.verified` 跟着过线** (否则接收方分不清「命中」和「可信」); **`remote_add_friend` fail-closed: 没有有效 DID 归属签名的条目 ⇒ 拒绝加好友** (这才是真正堵住伪造) |

**门禁 (真跑)**: `cargo test -p bolloon-p2p` **63 passed / 0 failed** (新增 attestation 9 + identity 7); `cargo test -p bolloon-agent directory` **20/20** (新增 `unsigned_entry_cannot_be_friended` 未签名条目不可加好友 · `publish_signed_roundtrip_and_forged_did_rejected` 篡改拒 + 替别人签拒 · `cross_machine_add_friend_flow` 改走真签名且断言 `verified`); `cargo build --workspace` **0 error** (cli 2 条 warning 为既有, 与本批无关)。

**诚实边界 (重要)**:
- **钱包归属目前只是「DID 单侧声明」, 不是所有权证明**。钱包要自证必须该地址私钥的 EIP-191 签名, 而 Rust workspace **没有 secp256k1/keccak 依赖** ⇒ 现在**验不了**。做法: `wallet_sig` 字段留口 + 判据 `wallet_self_proving` 恒 `Some(false)` 并附人话说明; 调用方可开 `require_wallet_proof` 让它直接判红 (**现在恒定红, 不糊过去**)。要真正做实钱包侧, 需给 workspace 加 **`k256`(secp256k1) + `sha3`(keccak256)** —— 依赖决策, 待拍板。
- Rust web 里 **agent DID 是「轻量派生显示层」** (`native.rs`: `did:pi:<b58(派生)>`), **没有对应私钥**, 所以现在只能由 **owner 对 agent DID 签名声明归属** (= owner 担责, 正是要的责任面), 还不能让 agent 自己反签; 要 agent 自签需给 agent 分配真 KeyPair。
- **web 层尚未接线**: `/api/directory/publish` 等仍走无签名的 `publish`; attestation 目前是**库能力 + 目录模块能力**, 运行时还没自动给 agent/钱包签发归属。下一步按 Rust 优先级接线。

---

## DIAP Rust SDK (本机 /Users/apple/Downloads/DIAP_Rust_SDK)

同日更新: 0.2.7→**0.3.0** (edition 2021→2024, rust-version 1.99, ed25519-dalek 2→3) + iroh 1.4 API 对齐 (`NodeAddr`→`EndpointAddr`, `builder(presets::N0)`, `addr()/id()`, `remote_id()`)。3 个 examples 修复对齐新 API, `cargo build --examples` 0 警告过; **lib 测试 46 passed / 0 failed / 4 ignored** (修 nonce_manager/did_cache 测试缺 `async` — edition 2024 必需; key_generator 测试对齐废弃函数空占位语义; noir_embedded/noir_universal 测试输入自洽 + 默认 backend 未启用时切 Simplified)。crates.io 下载走 rsproxy 镜像 (直连超时/代理 SSL reset, 2026-10-25 实测)。提交 `fdbef37` + `aa9ec66`。
