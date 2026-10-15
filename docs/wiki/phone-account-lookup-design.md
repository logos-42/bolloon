---
title: 手机号反查人类账号与加好友设计方案
source: compiled from leo 需求 (2026-10-14: 能否用手机号注册绑定, 或根据手机号查询人类账号加好友) + contacts-protocol / known-peers / did-agent-resolver 实查
created: 2026-10-14
last_confirmed: 2026-10-14
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [contacts, phone, human-account, directory, lookup, friend, privacy, design, decentralized]
---

# 手机号反查人类账号与加好友设计方案

## 0. 一句话

**把「手机号绑定」从纯本机身份验证, 扩展出「可选公开的人类账号目录」: 用户可决定是否把「手机号哈希 → DID」的指针公开到去中心化目录; 对方凭手机号查目录 → 拿到 DID → INBOUND 好友请求 → 同意后进 known-peers。默认不公开, 公开是显式 opt-in。**

## 1. 现状 (实查, 2026-10-14)

| 层 | 现状 | 文件 |
|---|---|---|
| 手机号绑定 | `/api/contacts/bind` → OTP 验证 → 挂本机 SocialIdentity (DID 主身份) | `src/web/routes-contacts.ts` / `src/agents/contacts/chain.ts` |
| 身份模型 | DID 主身份 + 已验证 contactId 列表 (`social-identity.json`) | `src/agents/contacts/store.ts` |
| 加密/隐私 | 完整手机号**不进** prompt/Run/Git; 外部只见「已验证/可联系」; provider 凭据走 secretRef | `contacts-protocol.md` |
| 好友 | `known-peers.ts` — 持久化 P2P 好友列表 (publicKey 标识, 启动自动重连) | `src/network/known-peers.ts` |
| DID 解析 | agent 文档 (cid/ipnsName → IPFS DID 文档), **不含联系方式** | `src/network/did-agent-resolver.ts` |
| P2P 入站 | 群聊 link / 远端 channel / contacts pairing 已有入站通道 | `src/agents/contacts/` |

**关键现状约束 (contacts-protocol 第一版冻结边界):**
> 明确不做: 社交信息流 · **公开通讯录** · 推荐联系人 · 社交积分 · 自动读全量邮箱 · **用联系方式替代 DID**

所以「手机号反查」是**有意扩边界** —— 必须显式设计隐私墙, 不能默认公开。

## 2. 需求拆解

leo 问的两个能力:
1. **手机号注册绑定** — 已有 (`/api/contacts/bind` + OTP), 但它是「本机身份验证」不是「账号注册」。方案里把它升级为可选「账号公开声明」。
2. **根据手机号查询人类账号来加好友** — 不存在, 这是新增。

## 3. 设计 (按架构四原则分层)

### 3.1 核心概念: 公开指针 vs 隐私

```
本机:  手机号(明文) + DID  ← 已有, 永不离开本机
目录:  手机号哈希(盲化) → DID  ← 新增, 用户 opt-in 才发布
查询:  查的人是"哈希", 查不到明文, 拿回 DID
加好友:拿 DID → 发好友请求 (INBOUND, 对方同意才建立) → known-peers
```

**关键隐私决策:**
- 目录存的不是手机号, 是 **HMAC 盲化哈希** (per-user salt + 全局 pepper, pepper 不进目录)
- 目录不存明文手机号、不存姓名、不存社交内容
- **查询时无法枚举**: 想批量扫号 (输入 13800000000-9999999 遍历) 拿不到任何东西 —— 每个查询返回「有/无」且只有哈希精确匹配才有结果; 且哈希带 per-user salt, 同一手机号在不同目录里的哈希不同, 无法离线撞库
- 未 opt-in 的用户 = 不在目录 = 查询返回「无此账号」(与不存在同义, 不可区分)

### 3.2 分层归属 (五问过一遍)

| 能力 | 归属层 | 理由 |
|---|---|---|
| 手机号哈希算法 / 盲化策略 | **domain module** (`src/agents/contacts/human-directory.ts`) | 业务判断: 哈希怎么算、pepper 存哪 |
| 目录存储 (哈希→DID 映射) | **OrbitDB store** (type='human-directory') | 去中心化存储机制, 复用 CIDDatabase |
| 目录发布 / 更新 / 撤销 | **agent 工具 + CLI** (`directory_publish` / `directory_retract`) | 暴露操作面 |
| 目录查询 (`directory_lookup`) | **agent 工具 + HTTP 路由** (复用 `/api/contacts/lookup`) | 查询面 |
| 好友请求收发 (INBOUND) | **P2P 通道** (复用 contacts pairing / known-peers) | 通信机制, 既有 |
| 好友请求审批 (consent) | **Harness Gate + consent 链** (复用) | 门禁: 不经同意不加好友 |
| 查询/发布审计 (谁查了谁) | **Run/Goal evidence** (复用 run-store) | 证据链: 查询是事实, 要留痕 |

**不新增的全局状态** (原则 4): 不搞全局好友 Map / session singleton; 好友仍走 known-peers 文件 + 目录只存哈希指针。

### 3.3 数据模型

```
// 目录条目 (OrbitDB human-directory store)
interface DirectoryEntry {
  phoneHash: string;        // HMAC-SHA256(salt_i || phone, pepper) → base64url, 截断? 否, 全量
  salt: string;             // per-user salt (发布时生成, 存本机, 使哈希不可离线枚举)
  did: string;              // 目标 DID (did:key:...)
  displayName?: string;     // 可选: 昵称 (用户自己填, 不是真名)
  publishedAt: string;
  revokedAt?: string | null; // 撤销指针 (软删)
  ownerSig: string;         // 用户私钥签名 (防目录伪造条目)
}

// 查询请求/响应
interface DirectoryLookupRequest {
  phoneHash: string;        // 查的人算同一算法 (需要 pepper? 否 —— 查的人只给哈希, pepper 在目录服务端)
  salt?: string;            // 若知道对方 salt 可用; 常规路径: 目录服务对条目逐个试
}
interface DirectoryLookupResult {
  found: boolean;           // false = 不在目录 (与不存在同义)
  did?: string;             // 对方 DID (若 found)
  displayName?: string;
  ownerSigVerified: boolean;
}
```

**哈希算法的 pepper 归属 (关键设计决策):**
- 方案 A (推荐): **pepper 在目录服务端** (每个 Bolloon 节点的本地目录 = 服务端)。发布者算 `HMAC(salt||phone, pepper)` 时 pepper 从本地配置取 (同 salt 一样是本机私密)。查询者只发「我要找这个哈希」→ 服务端 (对方节点/目录节点) 用条目自身的盐比对。**pepper 不进目录、不进 URL、不进日志**。
- 方案 B (去中心化无服务器): 全局 DHT 广播。**不选** —— 全局共享 pepper = 单点泄露即全库可枚举, 不符隐私目标。

**统一到「本地目录 + P2P 转发查询」:**
```
每个节点维护自己的 human-directory 子集 (自己发布的条目)
查询流程:
  ① 查的人: HMAC(salt_self || phone_target) 本地算不出 (不知道对方 salt)
     → 实际: 查的人对**自己的手机号**做反向查询? 不 —— 查的人是"输入对方手机号"
  ② 关键简化: 查询时, 查的人把自己的「手机号明文」经一条**加密的 P2P 查询通道**发给目标/目录节点?
     ✗ 不行, 明文不能出本机 (隐私红线)
  ③ 正确路径: **查询 = 先握手, 后本地比对** ——
     a. 查的人对目标手机号: HMAC(salt_a || phone_b, pepper_a)? 不对, salt 是对方的
     b. 结论: 无 centralized 目录时, "凭手机号搜全网" 必须有一个**双方已知的中介盐约定**,
        或接受"只能搜到已与你交换过 salt/或都在同一群里的节点"
```

这里要诚实: **全去中心化 + 完全隐私 + 盲搜全网 = 三角不可能** (隐私/可搜索/去中心化, 只能取二)。方案落点要在三角里选:

### 3.4 三角取舍 → 三个落点

| 落点 | 取 | 舍 | 适用 |
|---|---|---|---|
| **A. 群内目录 (推荐起步)** | 完全隐私 + 去中心化 | 只能搜「同群/已交换 salt」的人 | 好友的熟人链扩展: 双方已在同一 Bolloon 群 |
| **B. 中央可查目录 (托管)** | 可搜全网 + 隐私哈希 | 依赖一个目录服务 (非纯去中心化) | 想要「输入手机号就能找到人」的完整体验 |
| **C. 用户名/邀请码 (替代)** | 去中心化 + 可搜索 | 不是手机号 | 不想碰手机号隐私的用户 |

**推荐: A 起步 (与项目 P2P 方向一致), B 作为可选增强 (用户显式 opt-in 到托管目录才发布), C 永远免费提供。**

#### 落点 A: 群内/已知盐目录 (去中心化 + 隐私)
```
前提: 双方已加入同一 Bolloon 群 (群链接已有) 或已交换 contact (pairing)
机制: 群共享一个「群盐」→ 群成员手机号哈希 = HMAC(群盐 || phone, 群pepper?)
      pepper 仍不进群 —— 用「群盐 + 成员数」盲化? 实际: 群盐本身就是共享 secret,
      泄露群盐 = 群内成员手机号可枚举 (群里本来就认识, 可接受?)
      → 更稳: 群盐 + per-member salt, 查询要试 N 次 (N=成员数, 群小, 可接受)
查询: 输入手机号 → 本地算 HMAC(群盐||phone) → 遍历群成员目录条目比对 → 命中拿 DID → 好友请求
```

#### 落点 B: Opt-in 托管目录 (全网可查, 隐私保留)
```
发布: 用户显式 `directory publish --phone` → 本机算 hash → POST 到托管目录服务
      (或广播到多个对等节点) → 条目带 ownerSig + revokedAt
查询: `directory lookup --phone X` → 目录服务:
      ① 本地哈希比对 (目录存的是 HMAC(serverPepper||salt||phone), 查询端只能发明文?
        ✗ 不 —— 查询端把「哈希后的值」发来, 服务端用自己 pepper 验证? pepper 在服务端,
        查询端发 HMAC(salt||phone) 无 pepper → 服务端再 HMAC ← 双重盲化可行)
      ② 命中 → 返回 DID (脱敏, 无手机号)
加好友: 拿 DID → P2P 好友请求 (INBOUND, 对方 consent) → known-peers
```

### 3.5 工具面 (暴露给 LLM + CLI)

| 工具/CLI | 参数 | 动作 |
|---|---|---|
| `directory publish` | phone / displayName? | 算哈希 + ownerSig → 发目录 (opt-in, 先弹隐私确认) |
| `directory retract` | — | 撤销指针 (软删, 目录条目 revokedAt) |
| `directory lookup` | phone | 群内/托管目录查 → DID (未 opt-in 返回「无此账号」) |
| `friend request` | did | P2P INBOUND 好友请求 (复用 pairing 通道) |
| `friend approve` / `friend reject` | requestId | consent 链审批 → 进 known-peers |

**工具门禁 (Harness):**
- `directory publish` = 高危 (曝光身份指针) → 必须用户显式确认 (consent 链, 非 agent 自动)
- `directory lookup` = 中危 → 查询留痕进 Run evidence (审计谁查了谁)
- 好友请求自动拒绝除非用户设置「自动接受来自已验证联系人的请求」

### 3.6 隐私红线 (写进门禁)

1. 目录**永不存明文手机号** (只存盲化哈希)
2. 哈希带 per-user salt (无法离线枚举) + pepper 不进目录 (方案 B 服务端持有)
3. 查询响应**不泄露**「电话号码是否存在」之外的任何信息 (未 opt-in = 与不存在同义)
4. 查询/发布**都留痕** (Run evidence: 谁在何时查了谁的哈希)
5. 完整手机号**不进** prompt / Run / Git (沿用 contacts-protocol 既有红线)
6. 可随时 `directory retract` 全撤

## 4. 阶段 (小步落地)

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 落点 A: 群盐 + 群内目录 store + `directory lookup` (群内) | **✅ 已完成 2026-10-11**: human-directory.ts 盲化哈希目录 (本地 JSON) + HTTP 四端点 + LLM 三工具 + 撤销。**诚实**: 本版目录是「本机 + 未来群复制」, 跨节点真同步未验 (需群 store 接入) |
| P1 | 好友请求 INBOUND 链路 (pairing 复用) + consent 审批 + known-peers 写入 | **✅ 已完成 2026-10-15**: 目录条目带 publicKeyHex (发布自动从 user.json 带出) + lookup 直达公钥 + `directory.add_friend` 工具 + `/api/contacts/directory/add-friend` 端点 (委托既有 friend-request 链路 → 对方 consent 接受 → known-peers) |
| P2 | 落点 B: opt-in 托管目录 (哈希双重盲化 + ownerSig) + `directory publish/retract` | 发布→查询→撤销全闭环 + 审计留痕 |
| P3 | 隐私门: 查询限流 (防扫号) + 审计 UI + 导出脱敏 | 扫号尝试被限流 + 审计可见 |

**P0+P1 是第一个可交付** (纯 P2P, 无新基础设施); P2 需要决定托管目录放哪 (自托管 or 公共) —— 按项目去中心化方向, 先自托管。

## 5. 明确不做 (Contrast)

- ❌ 不做全局公开通讯录 (默认明文可搜) —— 违背 contacts-protocol 冻结边界
- ❌ 不做「手机号替代 DID」—— 手机号只是查询指针, 身份仍是 DID
- ❌ 不做自动加好友 (不经 consent)
- ❌ 不做批量扫号/推荐联系人
- ❌ 不做验证码短信服务自建 (复用现有 OTP 通道)

## 6. 风险与诚实边界

- **三角不可能 (隐私/可搜索/去中心化)**: 方案诚实选 A 优先, B 可选, C 兜底; 不宣称「去中心化 + 隐私 + 全网可搜」三者全有
- 目录被恶意节点污染 → ownerSig 验签兜底 (条目声明 DID 必须对应用户私钥签名)
- pepper 归置: 方案 A 群盐泄露 = 群内手机号可枚举 (群内本就认识, 边界可接受); 方案 B pepper 服务端持有, 服务端被攻破 = 该库可枚举 → 需 pepper 轮换机制
- 真实手机号段枚举防护: 查询接口限流 (每 IP/DID 每分钟 N 次) + 哈希不可离线校验 (pepper 不在查询端)

## 7. 与记忆方案的关系

- 好友/联系人关系进记忆 (`kind: 'relationship'`, 记忆方案 P0 的 MemoryEntry), 但**手机号明文不进记忆** (只进哈希指针)
- 好友的 DID 是记忆归属锚, 不是记忆内容
- 两个方案共用: OrbitDB store 模式 · consent/门禁链 · 脱敏导出模式