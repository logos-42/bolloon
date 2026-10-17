---
title: 手机优先登录与身份验证方案 (leo 想法整理 v1 — 两端功能分化)
source: session
created: 2026-10-17
last_confirmed: 2026-10-17
schema_version: 2
audience: self
stage: draft
status: draft
confidence: medium
entity_type: chapter
tags: [phone, login, did, identity, verification, biometric, sms, email, qr, design, mobile-first, dual-core]
---

# 手机优先登录与身份验证方案

## 0. 一句话

**手机是主使用场景 → 登录与身份验证围绕手机展开;验证以 DID 为主(避免低效短信),短信只作辅助通道;手机号定位为"搜索栏指针"而非登录凭证;智能体互验是后置阶段。**

## 1. leo 三条想法 (原话整理)

| # | 想法 | 要点 |
|---|---|---|
| 1 | **核心需求** | 个人登录以手机为主(使用场景是手机),然后**慢慢实现**智能体之间互相验证 —— 智能体互验是后置阶段,不是首发 |
| 2 | **验证方式 (a)** | **避免低效短信**: 短信收发是低效状态,不应以短信为主,直接用 **DID 做验证** |
| 2 | **验证方式 (b)** | **辅助短信服务**: 短信收发也有用,若有 **Cloudflare 短信收发服务** 最好 |
| 2 | **验证方式 (c)** | **首次绑定以方案 A 为主**: 手机第一次绑定时,可用短信验证,**也可用 DID 进行人脸识别** —— 这样是最好的 |
| 3 | **功能定位** | **DID 变成主动的选择**,而手机号更适合放在**搜索栏**上使用 |

## 2. 现状核对 (2026-10-17 实查)

| 能力 | 状态 | 落点 |
|---|---|---|
| 手机号绑定 + OTP | ✅ 已有 | `src/agents/contacts/chain.ts` (bind/verify) · CLI `/contacts bind\|verify` |
| 验证码机制 | ✅ 已有但**假回显** | `providers.ts` 默认 `local-sink`: 码直接回显屏幕, 无真实外发 |
| 手机号→DID 目录 | ✅ 已有 | `human-directory.ts` (盲化哈希) · `directory.publish/lookup/add_friend/retract` |
| 加好友闭环 | ✅ 已有 | 目录→publicKey→`/api/friend-request`→consent→known-peers |
| 手机登录页 | ✅ 已有 (2026-10-15) | `mobile.js` openLoginPage — 但验证走 local-sink 自回显 = **假验证** |
| 设备签名 / 登记 | ✅ 已有 (2026-09-19) | `mobile-contacts.ts` device key (Ed25519) · `registerDeviceOnDesktop` · `registerDevice` |
| 生物识别 (人脸/指纹) | ❌ 无 | WebAuthn/Passkey 未接入 |
| Cloudflare 短信 | ❌ **不存在** | Cloudflare 只有 Email Service 与 Workers 平台, 无原生 SMS (实查官方文档) |

## 3. 验证层次设计

### 3.1 主路径: DID 验证 (避免短信, leo 想法 2a)

```
登录动作 = 设备密钥签名 (已有设备密钥) + 可选生物识别解锁
首次绑定 = 设备接力 (方案 A, leo 想法 2c 首选):
   电脑端(已登录) 生成一次性设备码 → 手机输入码 + 自生成设备密钥
   → 电脑验码 → registerDevice 登记手机公钥 → 手机登录完成
手机号 = 绑定在 DID 上的"可搜索指针", 不承担验证
```

- 设备密钥体系**已存在** (mobile-contacts.ts + grants.registerDevice), 方案 A 是"接线", 不是新造
- 登录不再依赖短信; 手机号不参与验证

### 3.2 辅助: 短信 (leo 想法 2b)

**诚实核查**: Cloudflare **没有**原生短信收发服务 (官方只有 Email Service 和 Workers 运行时; 短信教程全是"在 Worker 里调 Twilio")。所以"Cloudflare 短信"若要做 = Workers 代理第三方网关 (Twilio/阿里云), 底层仍是第三方。

| 落点 | 说明 |
|---|---|
| 直接接第三方 | `http-webhook` 通道**代码就绪**, 配 secretRef `{endpoint, token}` 即通; 国内选阿里云/腾讯云 (~0.04 元/条, 个人实名可开) |
| Cloudflare Workers 代理 | 可行但多一层; 且 Workers 免费档有调用配额 — 不构成"用 Cloudflare 替代运营商" |
| 结论 | 短信定位 = **可选辅助通道**, 不在主路径; 方案不要建立在"Cloudflare 短信"前提上 |

### 3.3 首次绑定组合 (leo 想法 2c)

| 档位 | 机制 | 验证强度 | 成本 |
|---|---|---|---|
| 首选 | 方案 A 设备接力 (一次性码 + 设备密钥登记) | 中: 你持有已登录设备 + 新手机 | 0 |
| 可选 1 | 短信验证 (第三方网关就绪后) | 高: 你持有该手机号 | ~0.04 元/条 |
| 可选 2 | **DID + 生物识别** | 高: 你本人在场 + 持有设备密钥 | 0 |

**"DID 人脸识别"的准确实现** = Passkey/WebAuthn: 人脸/指纹**解锁设备密钥**, 私钥签名证明"本人在场 + 持有密钥"。它不是"人脸即身份", 是"生物识别解锁 DID 私钥"。手机 WebView 需 HTTPS + 系统生物识别 (iOS Face ID / Android 指纹), Capacitor 壳内可用。

## 4. 功能定位 (leo 想法 3)

```
搜索栏  ← 手机号 (查找指针: 输手机号 → 目录 → DID → 加好友)
主动选择 ← DID (用户显式用 DID 登录 / 验证 / 授权)
主终端   ← 手机 (登录流程围绕手机展开; 电脑端是底座)
```

- 手机号 = 人类可记忆的搜索键, **不承担验证/登录凭证**
- DID = 用户主动选择使用的身份凭证

## 4.5 两端功能分化 (leo 2026-10-17 第二轮定稿)

**手机端和电脑端功能不一样, 必须分开设计。**

### 4.5.1 手机端: 无电脑也能独立验证

用户没有电脑端时, 手机端也要能**独立完成验证**。验证优先级 (从首选到最次):

| 优先级 | 方式 | 说明 |
|---|---|---|
| 1 (首选) | **手机号确认** | 本机持有手机号 → 设备密钥签名确认 (DID 内部确认) |
| 2 | **朋友之间互相确认** | P2P 好友互认: 朋友确认"这是我认识的人" |
| 3 (最次) | **短信验证** | 需要运营商网关; 仅作兜底 |
| 3' (同层) | **邮箱验证** | 与短信同一优先级层级 — Cloudflare 支持邮箱服务, 手机端可用邮箱收发验证码 |

### 4.5.2 手机 ↔ 电脑互验两种方式

| 方式 | 方向 | 机制 |
|---|---|---|
| **扫码** | 电脑出示二维码 → 手机扫描 | 电脑端生成一次性配对码 (QR), 手机扫码确认, DID 签名回传 |
| **验证码** | 手机出示验证码 → 输入到电脑 | 手机端生成简单验证码, 用户敲进电脑终端, 电脑端验签 |

### 4.5.3 电脑端

- (a) **终端命令**: 验证在命令行输入框进行 (已有 `/contacts bind|verify` + 快捷符号 `=` + `/directory` 命令族)
- (b) **功能完善**: 手机登录 ↔ 电脑登录互相验证都要完成 (扫码 + 验证码双向)
- (c) **验证机制**: **DID 为主验证方式** — 用户操作以手机号登录为主, 但内部确信和验证过程用 DID 确认; 朋友之间用 P2P 方式互相确认

### 4.5.4 双核运转

**电脑端 + 手机端两个"核"都要运转同一套手机号登录与通讯录逻辑**: 手机端核 (mobile-core/mobile-agent) 独立于电脑端核 (kernel/pi-sdk), 无电脑时手机端核要能自足完成验证; 电脑端核继续维护既有完整链路。手机端目录数据可复制到本机 (OrbitDB 副本或本地存储), 不依赖电脑端在线。

## 5. 与既有资产映射 (不新造轮子)

| 方案需要 | 既有资产 |
|---|---|
| 设备接力码 | `OtpStore` (6位/10分钟/一次性, 改投递目标为"屏幕"即可) |
| 设备密钥登记 | `registerDeviceOnDesktop` / `grants.registerDevice` |
| 手机号搜索指针 | `human-directory.ts` + `/api/contacts/directory/lookup` |
| 加好友 | `/api/contacts/directory/add-friend` → friend-request 链路 |
| 手机登录页 | `mobile.js` openLoginPage (改造: 假回显 → 真设备码) |
| 生物识别 | ❌ 需新增 WebAuthn/Passkey 层 (P2) |

## 6. 分阶段

| 阶段 | 内容 | 判据 |
|---|---|---|
| P0 | 手机登录从"假验证"改"设备码 + 设备签名": 电脑生成码 → 手机输入 → 设备密钥登记 → 登录 | 无短信完成手机登录; 登录态绑定设备密钥; local-sink 不再当验证 |
| P1 | 搜索栏手机号查找 + 加好友收口 (既有, 补电脑端 CLI `/directory` 命令族) | 电脑端可敲命令 publish/lookup/add-friend |
| P2 | 生物识别解锁 (WebAuthn/Passkey): 首次绑定可选"人脸解锁设备签名" | iOS/Android 真机过 Face ID/指纹解锁后签名 |
| P3 | 短信辅助接真实网关 (阿里云/腾讯云 http-webhook) | 真短信 OTP 端到端; local-sink 降为纯开发通道 |
| P4 | 智能体互验 (leo 想法 1 的后置阶段): ownerSig 签名声明 + 验签 | 目录条目带签名; 好友请求互相验签 |

## 7. 诚实边界

- **Cloudflare 无原生短信** — 方案 B 若做, 底层必须是第三方网关, 不要建立在"Cloudflare 短信"前提上
- **"DID 人脸识别" = 生物识别解锁设备私钥**, 不是人脸照片即身份; WebAuthn 需要 HTTPS + 设备生物识别支持
- 首次绑定时手机号仍是**自声明** (除非走短信); 方案 A 验证的是"你同时持有电脑+手机", 不是"手机号归你"
- 设备接力只解决"登录", 不解决"手机号归属证明" — 两条验证语义要分开说

## 8. 关联

- 手机号反查加好友设计 (目录/隐私红线): [phone-account-lookup-design.md](./phone-account-lookup-design.md)
- 联系方式协议 (OTP/通道/授权): [contacts-protocol.md](./contacts-protocol.md)
- 本方案属 docs 层; 落地时按架构四原则 (五问) 分层归属
