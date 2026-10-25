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
| `bolloon-cli` | `bolloon` / `web --port` / `status` / `memory remember\|recall` / `task publish\|id` | 0 |

合计 **81 测试全绿** (`cargo test`, 2026-10-25)。

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

## DIAP Rust SDK (本机 /Users/apple/Downloads/DIAP_Rust_SDK)

同日更新: 0.2.7→**0.3.0** (edition 2021→2024, rust-version 1.99, ed25519-dalek 2→3) + iroh 1.4 API 对齐 (`NodeAddr`→`EndpointAddr`, `builder(presets::N0)`, `addr()/id()`, `remote_id()`)。3 个 examples 修复对齐新 API, `cargo build --examples` 0 警告过; **lib 测试 46 passed / 0 failed / 4 ignored** (修 nonce_manager/did_cache 测试缺 `async` — edition 2024 必需; key_generator 测试对齐废弃函数空占位语义; noir_embedded/noir_universal 测试输入自洽 + 默认 backend 未启用时切 Simplified)。crates.io 下载走 rsproxy 镜像 (直连超时/代理 SSL reset, 2026-10-25 实测)。提交 `fdbef37` + `aa9ec66`。
