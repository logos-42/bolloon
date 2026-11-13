---
title: Bolloon 当前状态
source: session
created: 2026-07-04
last_confirmed: 2026-11-08
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [status, rust-workspace, app-0.7.8, release-gate, world-cards, contribution-proof]
---

# Bolloon 当前状态

**只保留当前事实。** 2026-07 ~ 2026-10 的逐条流水（TS 时代代码结构表、已关闭的风险、旧版本发布记录、K0–K10 台账）已从本文件移除；需要追溯请查 [`log.md`](./log.md) 与 git 历史。本文件不再重复记录「已完成」的历史任务。

## 版本与发布

| 项 | 当前 |
|---|---|
| 线上 App | **0.7.8**（GitHub Pages + jsDelivr 验签通过；手动包 `~/Downloads/Bolloon_0.7.8_x64.dmg`） |
| 代码分支 | `Rust`，**已有多批功能未进安装包**，下一版按 semver 只能是 **0.7.9**（`0.7.8_1` / 四段版本号 Tauri 与 Cargo 都不接受） |
| 签名密钥 | 已换钥（id `90ED1F410A295CD7`），三件套 0600 存 `rust/app-tauri/src-tauri/.tauri/` + 备份；**≤0.7.5 客户端无法自动升级，需手动重装一次** |
| 发布门 | `scripts/tauri-release.sh`（密钥三件套 → 公钥一致 → 版本一致 → 构建签名 → 本地真验签）+ `scripts/verify-updater-signature.mjs`（Node blake2b512 + ed25519 真验 minisign）；**打包后必须真启动冒烟**（曾拦下启动崩溃的坏包） |
| 外部待办 | `bolloon.cn` 是另一台独立主机，仍可能返回旧清单与 404 产物路径，需人工同步 `update/` 或从 endpoints 移除 |

## 架构现状

- 内核全在 `rust/crates/`（`bolloon-agent` / `bolloon-llm` / `bolloon-web` / `bolloon-p2p` / `bolloon-x402` / `bolloon-econ` / `bolloon-cli` 等）；Node 只剩脚本与站点。
- **Web / App / CLI 三端同源**：桌面壳加载内嵌服务的同一份 `assets/index.html`（`?app=desktop`）；CLI 通过 HTTP 调同一套 `/api/*`，壳不写业务。
- 数据目录 `~/.bolloon/`（`rust/` 下是 native-state、技能、判断力、信念库等；`agent/` 下是信念 SQLite / todo）。
- **API key 不明文**：链式凭据后端 = 系统钥匙串优先、失败落 `~/.bolloon/secrets/` 的 AES-256-GCM 加密文件；前端只拿 `has_key` 布尔，重启直接可用。

## 当前能力快照（详见 `log.md` 当日行）

| 面 | 现状 |
|---|---|
| 好友 / 群组 | 好友「⋯」全套设置、选择式授权（普通/信任/极度信任三档）、群首轮全员并发（上限 20）、中断一次广播全停、流光面板定高、回合沉淀（技能/意图/判断力/记忆） |
| 世界模式 | 卡片「⋯」9 项、IPFS/IPNS/Web 链接、固定/持续更新、付费 x402 卡片与买方链路、音乐（唱片/歌词跟随）与视频（封面/全屏半屏）卡片、gap 资产卡片、AI 工具 `world_card_publish` |
| 交互与推荐 | 每次点击 → 记忆/判断力/工作流/信念四件套；点击上下文按「未对话全量 / 对话中洞察过滤」注入；接受/拒绝写状态并反馈推荐引擎 |
| 贡献与善意 | 贡献积分显示在左下角余额：服务交付 +5（不可自报）、共享 skill +0.5 / 卡片 +0.3；累计只增不减，仅购买增值服务消耗；求助零分也分发；**跨机可验证**用 DID 自带公钥验签 |
| 路由与成本 | 真实调用账本 + 任务×成本矩阵 + 影子→真路由（带回退）+ 本地小模型 / Ollama Cloud 登记 + 特化包评测与外溢 |
| 安全边界 | 好友永远拿不到「本地完全权限」；极度信任档开放 shell 但保留审计/预算/取消；只读指挥走显式工具白名单 |
| 终端 TUI | AI 循环期间 100ms 全周期重绘（秒表连续）、忙时输入草稿实时上屏 + Enter 排队、提交后输入框立即清空；`/agent` 切换当前智能体，`/did /wallet /ipfs /ipns` 全按它读取且可 copy；`/model` 接全量 200+ 家目录；`/help` 默认只列可用命令 |
| 跨机互联 | 手工登记对端 URL 后：双向好友 + DID 验签消息 + 远程 shell 执行（授权分级 / 逐工具审计）；手机号绑定自动发布盲索引，`/api/contacts/connect` 按手机号一步连上；`/api/agents/{id}/reach-out` 让智能体主动跨机开口（cron 默认关闭）。**整链走 DIAP（Rust 原生，crates.io `diap-rs-sdk 0.3.7`）**：`BOLLOON_DIAP=1` 后 `peer_json`/目录查询/互加回调自动优先走 iroh 隧道；两条去中心化发现路径：**gossip**（DID 签名记录每节点都存都转发）+ **Kademlia DHT**（libp2p 0.57，`PUT/GET_RECORD` 按手机号派生 key 分散存取），**陌生人只输手机号即可互联**（分别实测 `via:"去中心化发现"` / `via:"Kademlia DHT"`）。**多轮交流**：session_id 由双方 DID 确定性派生，消息双向落盘，对端用最近 12 轮上下文回答；`/chat/history` 回看、`/chat/auto` 智能体自动接力（轮数预算）。**初次寻找**：边缘目录**已部署上线**——`https://bolloon.cn/api/discovery/remote/*`（Worker 路由，KV `6848af03…`）+ 备用 `bolloon-rendezvous.yuanjieliu65.workers.dev`；只传 topic 哈希 + DID 签名记录，客户端本地验签、不信服务端，陌生人零 bootstrap 只输手机号即可连上；`BOLLOON_RENDEZVOUS=off` 可改走纯去中心化。DHT/gossip 仍需 bootstrap；公共 pkarr/Mainline relay 本机不可达；无 SMS，隧道只走 JSON API |
| Kernel / UI | 双核分工（A 机制 / B 执行）+ **真心跳文件互检/补拍** + 三模式统一事件面 + 8 端口 VFS/dispatch + 网页/终端同源（`bolloon kernel …`）；执行步骤显示工具名与 shell 结果、文档全屏阅读、卡片互动、好友面板、模型池绑定、路由使用费 |

## 当前已知边界（2026-11-08 复核）

1. **链上**：ETH 只登记用户提供的 `tx_hash`，本机不代签；IPFS 锚定需本机 Kubo 或真实 CID；orbitdb / 跨机共识层未接。
2. **跨机分发**：`world_cards_share` 反序列化成标准 `WorldCard`，媒体卡片 `presentation` 扩展字段对端看不到舞台；QUIC 直发需 feature 开启。
3. **Kernel**：双核心跳是**本机文件互检**（`~/.bolloon/kernel-ha/{a,b}.unified.heartbeat.json`；可读回 `dual_core` 的 `{a,b}.heartbeat.json`，但不覆盖其 fence/seq），启动后前 15s 为相位预热（`phase_ok=false`）；事件序号网页/CLI 统一取 `max(seq)+1`，重启与外部写入都不倒退；跨进程 HA 仍需 `BOLLOON_HA`，外部进程的核只如实报 stale、不由本进程代打；事件面/VFS 是本机机制面，跨机共识未接。
4. **模型**：API 用户自配；每会话/每智能体绑定在**主聊天与群聊旁路**都用真实 `session_id`（不再拿 `group_id` 冒充），`enforce` 路由不覆盖显式绑定；幂等缓存 key = 规范化后的 provider+model+session+完整请求（tools 排序），TTL 10 分钟 / 200 条上限 / 命中率可查，**工具回合单列 `skipped` 不计入命中率分母**；provider 端 KV prefix（`cache_prompt`/`cached_tokens`）仍未接；模型分享卡片能否导入取决于对端；旧 `charge_model` token 扣费函数保留但**零调用**。
5. **额度**：付费 = 路由调度次数（100 万次 0.001 元），只有**成功响应**才记一次（缓存命中 / 调用失败 / 账本记账都不计，没用成不收费）；不按 token、不动贡献积分、不再有余额闸与充值提示；历史账本仅作参考。
6. **求助响应**：候选响应者仅本机智能体，跨机响应要对端配合。
7. **Ollama Cloud**：`deepseek-v4.1-flash` 不在免费额度（HTTP 402），可用 `gpt-oss:20b` 等；key 曾在对话里出现，建议轮换。
8. **更新链**：`bolloon.cn` 主机未同步；jsDelivr 有缓存延迟。

## 下一步优先级

| 优先级 | 任务 |
|---|---|
| P0 | 打 **0.7.9**：把 0.7.8 之后全部批次（付费卡 / Ollama / key 持久化 / 三档授权 / 媒体卡片 / 贡献验证 / 交互沉淀 / Kernel 双核与 UI）打进包，走发布门 + 真启动冒烟 + 线上验签 |
| P0 | 人工同步 `bolloon.cn` 的 `update/`，或把它从 updater endpoints 去掉 |
| P1 | 跨机 `presentation` 字段保留（信封层带扩展字段）；真 Kubo / orbitdb 锚定与跨机贡献账本同步 |
| P1 | 歌词逐字时间轴、自建 IPFS 网关配置 |
| P2 | x402 真实小额链上交易走完 `world/pay/confirm`，让 `receipts.paid` 第一次为 1 |
| P2 | 清理旧 `charge_model` token 扣费遗留（需先迁移历史账本）；接 provider 端 KV prefix 命中指标（`cached_tokens`） |
| P2 | 跨进程 HA 真两节点验收（`BOLLOON_HA=1` 各选 A/B + 孤儿接管），并消除启动 15s 相位预热窗口 |

> 2026-11-08：11 项需求已实现并完成一次**代码复核 + 漏洞收口**（另一批次存在假接线：心跳恒真、group 模式误判、卡片计数永为 0、群分享函数未定义、缓存截断、路由费重复计等，见 [`log.md`](./log.md) 当日 `fix(kernel/ui)` 行）；挂起测试已清零。
> 维护纪律：本文件只写「现在是什么 / 还差什么 / 下一步」；每批实现细节写 [`log.md`](./log.md) 一行，不再往这里堆流水。
