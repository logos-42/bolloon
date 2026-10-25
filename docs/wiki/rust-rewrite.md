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

## DIAP Rust SDK (本机 /Users/apple/Downloads/DIAP_Rust_SDK)

同日更新: 0.2.7→**0.3.0** (edition 2021→2024, rust-version 1.99, ed25519-dalek 2→3) + iroh 1.4 API 对齐 (`NodeAddr`→`EndpointAddr`, `builder(presets::N0)`, `addr()/id()`, `remote_id()`)。3 个 examples 修复对齐新 API, `cargo build --examples` 0 警告过; **lib 测试 46 passed / 0 failed / 4 ignored** (修 nonce_manager/did_cache 测试缺 `async` — edition 2024 必需; key_generator 测试对齐废弃函数空占位语义; noir_embedded/noir_universal 测试输入自洽 + 默认 backend 未启用时切 Simplified)。crates.io 下载走 rsproxy 镜像 (直连超时/代理 SSL reset, 2026-10-25 实测)。提交 `fdbef37` + `aa9ec66`。
