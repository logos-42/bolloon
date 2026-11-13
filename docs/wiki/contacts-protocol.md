---
title: 联系方式与社交身份协议 (绑定 → 受约束调用 → 等待回复 → 唤醒任务 → 证据回放)
source: session (leo 2026-09-19 计划 + 真跑验收)
created: 2026-09-19
last_confirmed: 2026-11-13
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: chapter
tags: [contacts, social-identity, phone, email, otp, consent, secretref, contact-policy, batch-forbidden, awaiting-reply, supervisor, evidence, pairing, skills, smtp, http-webhook, local-sink, phase-0-9, acceptance-matrix]
---

# 联系方式与社交身份协议

## 一句话

Bolloon 的社交身份 = **DID 主身份 + 已验证联系方式 + 联系能力 Skill + 调用权限 + 可恢复任务证据**。
不是"公开手机号/邮箱", 也不是"再做一个社交平台"。它要解决的是长期任务缺的那一段:

```
绑定联系方式 → Agent 受约束调用 → 联系结果进长期任务 → 等待回复/人工确认 → Supervisor 恢复 → 结果与通信证据可回放
```

## 边界 (第一版冻结)

只做两个能力: `phone.contact` · `email.contact`。每个能力只支持: 绑定 / 验证 / 查看状态 / 发一条 / 记录或接收回复 / 撤销 / 作为长期任务的等待条件。

**明确不做**: 社交信息流 · 公开通讯录 · 自动群发 · 推荐联系人 · 社交积分 · ~~自动读全量邮箱~~ · ~~自动读全部手机通讯录~~ · 多账号合并 · 复杂 CRM · 关系图谱 · 自动代表用户做高风险承诺 · 用联系方式替代 DID。

> **2026-11-13 修订**: 划掉的两项已改为**受支持能力**(用户显式开启、默认支持、硬拒保留)。
> 见 [邮件/通讯录/短信设计](../plans/2026-11-13-mail-contacts-sms-design.md) 与本文末「2026-11-13 能力边界修订」。

## 外部只看到四类状态

| 外部状态 | 含义 |
|---|---|
| 已验证 | 验证通过, 但当前策略不允许直接联系 (如 `draft_only`) |
| 可联系 | 验证通过 + 有 send 能力 + 策略允许 |
| 不可联系 | `blocked` / `expired` / 未验证 |
| 需要重新授权 | 用户撤销过 (`revoked`) |

内部状态另有 `unbound` / `pending_verification` —— **不对外暴露**。

## 数据模型 (落盘事实)

`~/.bolloon/contacts/`

| 文件 | 内容 | 权限 |
|---|---|---|
| `social-identity.json` | SocialIdentity (ownerDid / verifiedContacts / privacyPolicy) | 默认 |
| `contacts.json` | VerifiedContact[] (**含 normalizedValue —— 真发信要用**) | **0600** |
| `secrets.json` | Secret Store (SMTP 密码 / 网关 token) | **0600** |
| `consents.json` | 人工批准请求 (只有脱敏预览) | 默认 |
| `pending/<requestId>.json` | 待批准的真实正文 + 执行参数 (发完即删) | **0600** |
| `otp.json` | 验证码挑战 (**只有 sha256(salt+code)**) | 默认 |
| `sent.json` | 发送台账 (requestId ↔ threadToken ↔ goalId, 摘要脱敏) | 默认 |
| `ledger.jsonl` | 只追加的通信台账 (每条带 evidenceRef) | 默认 |
| `outbox/` | `local-sink` 通道的真落盘发件箱 | 默认 |
| `grants.json` | **长期能力授权** (ContactGrant, 含签名) | **0600** |
| `devices.json` | 已登记设备公钥 (手机签名验签用) | **0600** |

硬规则: **明文手机号/邮箱不进 prompt、不进 Run、不进 Goal、不进 Git**; Goal/Run 只保存 `contactId` / provider / 动作 / 状态 / 证据引用。

## 调用链 (不可绕过)

```
Agent → PiAgentHarness → contact policy → consent → recipient → rate limit → preview → provider Skill → send → evidence
```

策略门判定顺序 (每种拒绝都有机器可读的 `blockKind`):

| # | 检查 | blockKind |
|---|---|---|
| 1 | 联系方式存在 | `not_found` |
| 2 | 已撤销 | `consent_revoked` |
| 3 | blocked / expired | `contact_blocked` / `verification_expired` |
| 4 | 未验证 | `unverified_contact` |
| 5 | 真外发通道的 secret 是否在 | `provider_not_configured` |
| 6 | 收件人 >1 | `batch_forbidden` (**批量永远禁止**) |
| 7 | 正文非空 | `missing_content` |
| 8 | `draft_only` | `policy_draft_only` |
| 9 | 同一 requestId 已发/已排队 | `duplicate_request` |
| 10 | 每天 / 每任务条数 | `rate_limited` |
| 11 | 任务存在且未结束 | `not_bound_to_task` / `goal_closed` |
| 12 | 是否绑定到这个任务 | `not_bound_to_task` |

要求人工批准的情形: **首次联系** (`first_contact`)、**敏感内容** (`sensitive_content`，卡号/身份证/密钥/密码/银行账号)、**每次确认** (`each_time`)、**策略要求** (`policy`)。用户明确给某个长期任务开 `auto_send` 后才可能免批 (仍需: 已绑定任务 + 非首次 + 无敏感内容 + 未超频)。

## 通道适配器

| provider | 行为 | secret | 真外发 |
|---|---|---|---|
| `local-sink` | 真写 `outbox/<requestId>.json` | 不需要 | **否** (预览/证据必须标"本地落盘(未真实外发)") |
| `http-webhook` | 真 HTTP POST (Bearer) | `{endpoint, token}` | 是 (短信网关) |
| `smtp` | 真 SMTP 会话 (net/tls + AUTH LOGIN, 支持多行应答) | `{host, port, user, pass, from}` | 是 |

未配置 = `provider_not_configured` **明确失败**, 绝不假装发送。

## 与长期任务/Supervisor 的接线 (复用既有地基)

- 发送成功且 `replyExpected` 且有 `goalId` → `bindExternalWait(goalId, { requestId, continuationId, expectedSource: 'contact', expectedEvent: 'reply', expiresAt })` → `Goal.status = awaiting_external`。
- 回复 → `deliverExternalEvent({ source: 'contact', eventId, requestId })` → 由既有实现按 **requestId 只唤醒对应 Goal**; 来源/关联不符 → 不唤醒。
- 来源校验在 chain 层: 回信地址必须等于绑定的联系方式, 否则记 `contact.reply_untrusted` —— **不计入证据、不唤醒**。
- 超时 → 既有 `expireExternalWaits` 把 Goal 转 `needs_human` + 记 `unresolvedItems` (不允许无限等)。
- 撤销 → 历史上等待该联系人的任务: 清等待 + 记 unresolved (不允许重试, 也不算完成)。
- **新增的外部事件来源 `'contact'`** 定义在 `goal-store.ts` 的 `GoalExternalSource` (单一事实, external-events 复用)。

## 通信台账 (证据可回放)

`contact.discovered` · `authorization_requested` · `approved` · `rejected` · `denied` · `sent` · `delivery_confirmed` · `reply_received` · `reply_untrusted` · `failed` · `revoked` · `wait_expired`

每条台账: `{ ts, activity, contactId, goalId, runId, eventId?, detail(脱敏, ≤300), evidenceRef }`,
`evidenceRef = contact:<contactId>@<ts>#<activity>` —— 同时写进 **Run.evidence** 与 **Goal.evidence**。

## 双端分工 (手机 / 桌面)

| 手机端负责 | 桌面端负责 |
|---|---|
| 输入手机号/邮箱 · OTP/验证链接确认 · 生物识别授权 · 展示待发内容 · 批准高风险联系 | 长期 Goal/Run · Supervisor · 执行与恢复 · 状态持久化 · 通信证据 · 等待回复 |

配对: 桌面 `POST /api/contacts/pairing/challenge` (一次性, 5 分钟) → 手机带 code + `deviceDid` 调 `/confirm`。
**只同步** `identityId / contactId / verificationStatus / capability / consentScope / provider / secretRef 关联状态`;
**绝不同步** 明文手机号/邮箱、API key、OAuth token、SMTP 密码。同步载荷里出现明文/密钥字段 → **整个请求被拒** (守卫函数 `looksLikePlaintextSecret`)。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/contacts` | 脱敏列表 + 通道 + 待批准 + 最近发送 |
| POST | `/api/contacts/bind` | 绑定 (规范化 E.164 / 邮箱 → 发验证码 → pending) |
| POST | `/api/contacts/verify` | 验证码校验 → verified |
| POST | `/api/contacts/:id/authorize` | 把联系方式授权给某个长期任务 |
| POST | `/api/contacts/:id/revoke` | 撤销 (历史证据保留, 后续拒绝) |
| POST | `/api/contacts/preview` | 可审计预览 (不发送) |
| POST | `/api/contacts/send` | 受约束发送 (需批准则返回 `awaiting_approval`) |
| POST | `/api/contacts/approvals/:id/{approve,reject}` | 人工批准/拒绝 |
| POST | `/api/contacts/reply` | 通道回调/手机转投 (来源校验) |
| POST | `/api/contacts/pairing/{challenge,confirm}` | 手机—桌面配对 |

Agent 侧工具: `contact.list_authorized` · `contact.preview` · `contact.request_consent` · `contact.send` · `contact.await_reply` · `contact.revoke`
(**只收 contactId, 不收地址**; 拿不到明文)。

## 真跑验收 (2026-09-19)

`npx tsx scripts/verify-contacts-chain.ts` → **51 passed / 0 failed, EXIT=0**

真跑的东西: 真 SMTP 服务器 (真走 220/EHLO/AUTH LOGIN/MAIL/RCPT/DATA/QUIT) · 真 HTTP 短信网关 (Bearer 鉴权) · 真 express 路由 (绑/验/预览/批准/撤销/配对全走 HTTP) · 真 Goal/Run 落盘 · 真 SkillsManager discover。

覆盖: 绑定→验证 (码取自**真收到的邮件/短信**) · 首次联系必须批准且批准前对方收不到 · 批准后真外发 + 回信关联头 · Goal 进 `awaiting_external` 且写明等谁/等到何时 · 冒名回复不唤醒 · 可信回复只唤醒对应 Goal + 唤醒回调收到正确 goalId · 重启后新实例仍读到等待事实 · 同 requestId 不重复 · 手机号通道真发真收 · 批量/未验证/撤销/未配置/超频/超时 全部拒绝或转人工 · 配对拒绝含明文载荷 + 一次性 · Skill 真登记 (v1.0.0 + contentHash) · 盘上无明文 (Run/Goal/ledger/consents/otp) · 事实表与秘密表 0600。

单测: `src/test/contacts.test.ts` **46/46**。

## 真跑逼出来并修掉的真 bug

1. **SMTP 多行应答丢行**: 一条 chunk 里带 `250-x\r\n250-AUTH LOGIN\r\n250 OK` 时, 早先实现只喂第一个等待者、其余行丢弃 → 客户端死等超时 (表现: 一发 EHLO 就 `smtp_timeout`)。修: 行队列 + 错误/断开快速失败。
2. **问候语竞态**: TCP 建好瞬间服务器就发 `220`, 监听器挂晚了会丢 → 先挂监听再等连接。
3. **批准后丢执行参数**: 等待窗口/是否等回复没跟正文一起暂存 → 批准后回退默认 48h。修: `pending/<requestId>.json` 连执行参数一起存。
4. **幂等占位自撞**: 待批准时写的 `sent.json` 占位会让"批准后复检"把自己判成 `duplicate_request`。修: 不写占位, 幂等由 consent 的 requestId 保证。
5. **`contacts.json` 明文副本**: 含 `normalizedValue` 的落盘文件改成 **0600** (纵深防御)。

## 未做 / 已知边界 (如实)

- 未接真实运营商/邮箱服务商 (验收用真 SMTP 服务器 + 真 HTTP 网关, 属"真协议真 socket", 但不是商用通道)。
- 接收侧只做"与任务绑定的回复" (带 threadToken/requestId + 发信地址匹配), **没有** IMAP 收信轮询、没有全量邮箱读取。
- 手机端只提供配对/确认的 API 契约与载荷守卫; 移动端 UI 未改 (APK/IPA 未重出)。
- 一版只一个收件人 (批量永久禁止); 无模板/无附件/无群发审批流。
- 未做 `email.draft` 落地 (draft_only 只用于拒绝发送)。

## 持久能力授权 (2026-09-19 升级: consent 只管一次, grant 管长期)

原先把联系方式做成"每次都要批准的工具" —— 那只解决了单次动作授权。真正的用户诉求是
**确认一次, 以后 Agent 可以持续使用**。为此把两层概念彻底分开:

| 概念 | 文件 | 语义 |
|---|---|---|
| 验证 | `contacts.json` 的 `verificationStatus` | 证明这个手机号/邮箱属于用户 (**不等于**长期发送权限) |
| 能力授权 | `grants.json` | 决定 Agent **以后**能否自动使用 |
| 一次性批准 | `consents.json` | 某一次发送 (没有长期授权时才会出现) |

### "完全访问"的确切定义

> 对**联系方式能力**完全授权, 而不是绕过 Bolloon 的安全边界或拿到整系统无限权限。

| 授权等级 (内部) | 用户看到的选项 | 范围 |
|---|---|---|
| `none` | 不允许 | — |
| `task_once` | 仅本次任务 | channels=both · verified_contacts · current_goal · normal |
| `persistent` | **长期使用 (推荐默认)** | channels=both · verified_contacts · **all_future_goals** · normal |
| `full_contact_access` | 完全授权联系方式能力 | channels=both · all_contacts · all_future_goals · **sensitive** |

**即使完全授权也仍然保留**: 单收件人 (批量永远禁止) · 频率限制 · 任务关联 · requestId 幂等 ·
provider 可用性检查 · 发送证据 · 撤销能力 · Harness 拦截。

**永不纳入联系方式授权** (属另一类高风险能力, 任何等级都拒): ~~读取全部邮箱~~ · ~~读取通讯录~~ · ~~短信历史~~ ·
邮箱附件 · 代签合同 · 支付/转账 · 绕过工具策略 · 读 API key 明文 · 把手机号/邮箱放进 prompt。

> **2026-11-13 修订**: 划掉的三项不再由「联系方式授权」管辖, 改为独立能力域(默认支持);
> 其余各项仍然**永不纳入任何授权**。详见文末「2026-11-13 能力边界修订」。

### 内容类别三分

| 类别 | 例子 | `persistent` | `full_contact_access` |
|---|---|---|---|
| 普通 | 商务询价、交期 | 直接发 | 直接发 |
| 敏感 (记类别不记明文) | 身份证号、卡号、一次性验证码 | 需人工批准 | **直接发 + 强提醒式审计事件** |
| **永不放行** | 密钥、密码、银行账号、支付/转账指令、合同承诺 | 拒绝 | 拒绝 (`forbidden_content_category`) |

### Policy 顺序 (引入 Grant 后)

```
contact 存在 → 未撤销 → 已验证 → provider 已配置 → Grant 存在且 active
→ channel 在范围内 → contact 在范围内 → task 在范围内 → content 在范围内
→ 收件人数量 (批量永远禁止) → requestId 幂等 → daily/per-task 限额
→ 敏感类别判定 → preview → provider send → ledger + Run/Goal evidence
```

机器可读拒绝/状态原因: `grant_missing` · `grant_revoked` · `grant_expired` · `grant_suspended` ·
`grant_channel_denied` · `grant_recipient_denied` · `grant_task_denied` · `grant_sensitive_content_denied` ·
`grant_device_untrusted` · `grant_version_conflict` · `grant_store_unreadable` · `forbidden_content_category`。

软/硬区分 (重要): `grant_missing` / `grant_suspended` / `grant_sensitive_content_denied` 是**软**的 ——
退回**一次性人工批准**, 不是"拒绝"; 其余是硬拒。**批准 ≠ 免检**: 批准路径执行前会**再判一次 policy**。

### 授权存储损坏 → fail-closed

`grants.json` 读不出来时: **拒绝自动发送**, 明确报 `grant_store_unreadable` 并要人工批准 + 修文件 ——
既不静默当成"无权限"(那样只会重新弹批准, 用户不知道文件坏了), 也不静默当成"已授权"。

### 手机 → 桌面 签名同步

- Grant 由**手机设备私钥 (Ed25519)** 签名, 桌面用 `devices.json` 里登记的公钥验签才接受 → **桌面不能自铸手机授权**。
- 规范化载荷: 固定字段顺序 (不含 `signature`/`lastUsedAt`), `payloadHash = sha256(规范载荷)`。
- 冲突规则: **撤销优先于授权** · 低 `grantVersion` 不覆盖高版本 · 同版本内容不一致 → 拒绝 (`grant_version_conflict`)。
- 手机撤销 (`revoke-sync`) → 桌面立即失效 (该 Grant 下等待回复的任务转人工)。
- 只同步 capability/Grant 元数据; 明文手机号/邮箱、API key、SMTP 密码一律不同步 (含明文载荷整包拒绝)。

### 证据 (Phase 7): 以后能回答"这条消息为什么不用再问我"

`contact.sent` 台账 + Run/Goal 证据里带:

```
authorizationMode=one_time | persistent | full_contact_access
grantId=<gr-…>  grantVersion=<n>  approvalSkipped=true|false  policyDecision=allowed:<grantId>:v<n>:<mode>
```

完全授权下发送敏感内容时, 额外写一条审计事件, **只记类别不记明文** (例: `id_number_cn`) + goal 引用。

### 撤销 / 暂停 / 恢复 (Phase 8)

```
/contacts revoke all          # 撤销全部 (等同完全收回)
/contacts revoke <grantId>    # 撤销单个授权
/contacts revoke <contactId>  # 撤销单个联系方式
/contacts pause | resume      # 暂停/恢复 (保留配置, 不丢)
```

撤销后: 立即阻止新发送 · 已发送消息不回滚 · 该授权下**正在等待回复的 Goal 转 `needs_human`** (清等待 +
留 unresolved, Supervisor 不再自动唤醒) · 旧 Grant 不能重新启用 (要重新授权) · 历史证据保留。

### 迁移 (Phase 9): 刻意保守

- 已验证但没有长期 Grant → **保持每次批准**, 不自动升级
- 已经人工批准过一次 → **不**推断为长期授权 (只能用户明确升级)
- 老 `taskRefs` → 仍是"任务级绑定", 不扩成所有未来任务
- `requireApprovalEachTime=true` → 保持最高优先级, 直到用户主动关
- 已撤销的联系方式 → **绝不**迁移成 active Grant

### 用户入口 (Phase 10, 只三个)

```
/contacts                    # 授权状态 + 联系方式(脱敏) + 待批准 + 正在等回复 + 最近通信
/contacts authorize [once|long|full]   # 一次性授予 (默认 long = 长期使用)
/contacts revoke all|<grantId>|<contactId>   # 暂停/撤销
```

CLI / Web (`/api/contacts/grants*`) / 手机读的都是同一份 `grants.json` 事实。首次授权在 Onboard/联系方式设置里
展示**统一授权卡** (「将获得权限 / 不会获得权限 / 三个选项」), 用户不需要理解 phone.contact 与 email.contact 是两个 Skill。

### 真跑验收 (2026-09-19 第二次)

`npx tsx scripts/verify-contacts-chain.ts` → **83 passed / 0 failed, EXIT=0** (P/Q/R/S/T 段为本次新增)

- **P 持久授权**: 一次授权 → 第二/第三个任务都不再创建待批准 (`consentId=none`) · 记录写明授权来源 · **重启后仍自动** · 台账可回放 `approvalSkipped/policyDecision`
- **Q 签名同步 (真 Ed25519 + 真 HTTP)**: 登记手机公钥 → 接受手机签名的完全授权 · 改载荷 → 拒 (`grant_device_untrusted`) · 未登记设备 → 拒 · 低版本 → 拒 (`grant_version_conflict`) · 手机撤销 → 桌面立即失效
- **R 完全授权边界**: 敏感内容直接发 + 审计只记类别 · 密码/密钥/转账指令/合同承诺 **四种全部拒绝**
- **S 撤销与故障**: 撤销 → 等待中的任务转 `needs_human` + unresolved · 后续发送 `grant_denied` · **grants.json 损坏 → 拒绝自动发送 + 台账大声记下** · 迁移保守 (不凭空造授权, 已撤销跳过)
- **T CLI**: `/contacts` 状态脱敏 · `revoke all` / `authorize long` 真生效 · 授权后立刻反映

单测 `src/test/contacts.test.ts` **63/63** (新增 17 条覆盖授权等级/范围/暂停恢复/签名/迁移/损坏)。

### 已知边界 (如实)

- 手机端仍是**契约 + 真密码学** (脚本扮演手机设备, 真密钥对真签名过真 HTTP), 不是真机 App。
- 完全授权下敏感内容"允许发送"依赖类别识别器的覆盖面; 识别不到的新类别会走普通路径 (这是已知取舍)。
- 未做: 按类别单独撤销 (`allowedCategories` 白名单) · 设备级信任度衰减 · 多设备冲突自动合并 (现在撤销优先)。

## 手机端能力 (2026-09-19, Phase 5/10 落地)

手机端负责 (与桌面分工不变): **输入联系方式 · OTP/验证链接确认 · 生物识别/系统确认 · 展示待发送内容 ·
批准高风险联系 · 用设备私钥签名长期授权 · 保存本地能力副本**。桌面负责落盘/执行/等待回复/证据。

### 代码落点

| 文件 | 作用 |
|---|---|
| `src/web/mobile-contacts.ts` | 手机端能力的**纯逻辑** (浏览器安全, 无 `node:` 导入): 设备密钥 · 签名/撤销签名 · 真 HTTP 调桌面 · 离线队列 · capability 副本 · 授权卡数据 |
| `src/web/mobile-core.ts` → `core.contacts.*` | 内核 API 面 (编译进 `mobile-core.js`), mobile.js 只调这一层 |
| `src/web/mobile.html` + `mobile.js` | 「我」页 → 联系方式与授权 sheet: 绑定/验证 · 待批准(含待发内容预览) · 三个授权选项 · 撤销 · 离线补同步 |
| `src/agents/contacts/grant-payload.ts` | **签名载荷单一规范** (手机 WebCrypto 与桌面 Node 必须字节一致) |

### 签名互操作 (为什么手机授的权桌面会认)

手机用 WebCrypto `Ed25519` 对 `canonicalGrantPayload(grant)` 签名 → 桌面用 `devices.json` 里登记的公钥
Node `crypto.verify` 验签。两侧**共用同一个载荷函数** (`grant-payload.ts`), 字段顺序/是否含 `lastUsedAt` 等
全部一致 —— 这是单测里真验过的 (手机签 → 桌面 `applySignedSync` 接受; 改任一被签字段 → 拒)。

### 三条诚实纪律 (手机端)

1. **WebView 不支持 Ed25519 就明说**: 返回 `device_signing_unavailable` 并提示去桌面授权,
   **绝不发"未签名"的授权糊过去** (桌面本来就拒收)。
2. **桌面离线不假装成功**: 授权进 `bolloon.contacts.queue.v1` 本地队列 + 返回 `queued=true`,
   文案明说"等桌面在线时自动同步"; 桌面回来后 `flushQueuedGrants()` 补同步并更新状态。
   撤销同理: 桌面不在线时**不会**当作已撤销, 提示稍后重试或去桌面撤销。
3. **本地只存 capability**: `bolloon.contacts.capabilities.v1` 里只有 `contactId/kind/displayValue(脱敏)/状态/能力`;
   手机号/邮箱明文只走"手机→桌面"这一次 HTTP 请求 (桌面负责落盘), 私钥只以 JWK 存本机且永不上传 (只上传 SPKI 公钥 PEM)。

### 手机端验收 (真跑, 同一脚本 U 段)

`npx tsx scripts/verify-contacts-chain.ts` → **101 passed / 0 failed, EXIT=0**, 其中 U 段:

- 手机建 Ed25519 设备密钥 (真 WebCrypto) → 手机确认的长期授权经**真 HTTP** 送桌面并**被验签接受**
- 桌面据此**直接发送**(不再创建待批准) 且证据写明 `grantId`/`approvalSkipped=true`
- 手机授出**完全授权** → 桌面敏感内容直接发; 密码**仍被拒**
- 手机撤销(带签名) → 桌面**立即失效**; 篡改撤销被拒且不会误撤
- 手机从桌面读到的视图**全是脱敏值**; 授权卡三选项 + "不会获得"清单齐
- 桌面离线 → 授权**只入本地队列**(不假装生效) → 桌面回来 **补同步成功且队列清空**
- 本地 capability 副本**无明文**; 不支持 Ed25519 的加密环境 → 明确报错

### Grant 存储的跨进程即时性 (真跑抓到的一个硬伤)

长驻进程 (web server) 早先会缓存 `grants.json` 列表 → **别的进程撤销后它还在用旧事实** (对"撤销必须立即生效"
是真问题)。现在 `GrantStore` 每次读/写前按 **mtime** 判断是否重读, 撤销/新授权**跨进程立即生效**, 不需要重启。

### 仍未被真机覆盖 (如实)

- 手机端是**契约 + 真密码学**(脚本与单测扮演手机: 真 WebCrypto 真签名过真 HTTP), **真机 App 未改** (APK/IPA 未重出)。
- UI 层 (mobile.html/mobile.js) 只做了语法与构建校验 + 逻辑单测, 没在真机/模拟器点过 (本机 iOS 模拟器脚本可用, 本轮未跑)。
- 生物识别 (FaceID/指纹) 与系统级确认未接 (当前是 sheet 内 `confirm` 二次确认)。

## 2026-11-13 能力边界修订(邮件 / 通讯录 / 短信)

leo 决定: 通讯录导入、短信读写、邮件读写从「永久禁止」改为**独立能力域**。

| 项 | 旧口径 | 新口径 |
|---|---|---|
| 读全量邮箱 / 通讯录 / 短信历史 | 任何等级都拒 | **默认支持**(不分级), 受总闸与硬拒约束 |
| Agent 自主读写 | 不允许(只允许单次受约束发送) | **允许**(Tool Capability + Harness Gate + 证据链) |
| 内容进 prompt | 明文不进 prompt | **全文可进 prompt**(用户自配供应商) |
| 跨机同步 | 只同步 capability 元数据 | 全文可同步, **仅限自己 DID 下已验签设备** |

### 仍然保留的硬拒(代码级, 不属于授权分级)

1. **外发**密码 / 密钥 / 银行账号 / OTP / 支付指令 / 合同承诺 → 拒(`forbidden_content_category`)。
2. 批量 / 多收件人外发 → 拒(`batch_forbidden`)。
3. 通讯录/短信/邮件全文**自动同步给好友智能体(他人节点)** → 拒; 仅接受用户显式选中的单条。
4. iOS 读短信 → 平台无 API, 如实标为不可用。
5. 绕过 iOS / Android 运行时授权 → 不做。

### 代码落点(Rust 主栈)

| 项 | 路径 |
|---|---|
| Port 契约 | `rust/crates/bolloon-agent/src/mail/ports.rs` |
| 索引 + 正文加密 | `rust/crates/bolloon-agent/src/mail/store.rs` |
| 硬拒 + 装配 | `rust/crates/bolloon-agent/src/mail/service.rs` |
| 本地落盘 Adapter | `rust/crates/bolloon-agent/src/mail/adapters/local_sink.rs` |
| 账号配置 / 工厂 | `rust/crates/bolloon-agent/src/mail/config.rs` |
| Agent 工具 | `rust/crates/bolloon-agent/src/mail_tools.rs` |
| HTTP 面 | `rust/crates/bolloon-web/src/mail_api.rs` (`/api/mail/*`) |
| CLI | `rust/crates/bolloon-cli/src/chat_command.rs` (`/mail`, 直连 crate) |

### 已实现 / 未实现(如实)

- **已实现并跑绿**: Port / Store(WAL + AES-256-GCM) / 硬拒 / LocalSink / 6 个 Agent 工具 / `/api/mail/*` / CLI `/mail`。
  验收: `cargo test -p bolloon-agent mail` **25/25**、`cargo test -p bolloon-web --lib` **115/0**、`cargo test -p bolloon-cli` **45/45**。
- **未实现**: 真 IMAP/SMTP Adapter、Android `ContactsContract` / `content://sms` Adapter、iOS `CNContactStore` Adapter、
  Tauri 手机原生工程(`gen/`)、三端 UI 面板、`scripts/verify-mail-chain.ts`。
- 因此当前 `local_sink` 账号只做本地落盘并**明确标 `really_sent: false`**, 不谎称已外发。

## 2026-11-13 电话能力(AI 外呼 · 首期)

| 项 | 现状 |
|---|---|
| 端口 | `CallPort`(`dial` / `next_event` / `speak` / `hangup`) · `rust/crates/bolloon-agent/src/call/mod.rs` |
| 状态机 | 纯函数 `reduce`(Idle → Dialing → Ringing → InProgress → Completed/Failed) · `call/state.rs` |
| 合规门 | AI 身份声明必填 · E.164 · 单目标 · 拒接后不重拨 · 勿扰 |
| 服务商 | **只有 Mock**；Twilio Media Streams 仅 JSON 编解码(`call/twilio.rs`)，**无 WebSocket 客户端** |
| 真音频 | **未接**：ASR / TTS / 回声消除 / 打断(barge-in) 全未验证 |
| 落盘 | `<home>/calls/records.jsonl`(只追加；脱敏：不存对方原话) |
| 入口 | `/api/call/{records,dial}` · CLI `/call [status\|dial <+E164> <原因>]` |

### 两条不可绕过

1. 接通后第一条播报**必须是 AI 身份声明**；声明为空 ⇒ `Failed` + 立即挂断。
2. **不批量外呼**：一次一个号码，无名单轮呼；对方拒接(`declined`/`do_not_call`)后不再重拨。

### 平台硬边界(不是设计选择)

- **iOS**: 不能自动拨号、不能录音、拿不到通话音频(`CallKit` 只服务自家 VoIP)。
- **Android**: `CALL_PHONE` 可拨号，但 Android 10+ 禁止第三方 App 录通话(`CAPTURE_AUDIO_OUTPUT` 是系统权限)。
- **桌面 / TUI**: 无蜂窝通话，只能经服务商 / SIP 中继。
- **结论**: AI 多轮实时对话只能走服务商音频中继，手机/桌面只做发起与控制。

### 已实现 / 未实现(如实)

- **已实现并跑绿**:
  - 状态机 / 合规门 / Mock 端到端 / Twilio Media Streams JSON 编解码（`call/twilio.rs`，无 WebSocket 客户端）
  - 真实音频层（`call/audio.rs` + `call/voice.rs`）：WAV 编解码、线性重采样、能量 VAD 分段、半双工门、打断(barge-in)检测
  - **真实 ASR / TTS 已本机跑通**：`WhisperAsr`(whisper.cpp) + `MacSayTts`(macOS say)；测试 `real_say_then_whisper_roundtrip`（识别「你好，這是語音識別測試」）与 `real_voice_loop_turn_latency`（实测 asr/tts/total 耗时均 >0）通过
  - 手机原生拨号**意图生成**（`call/native.rs`：Android `ACTION_CALL` / iOS `tel:` 纯函数 + 单测；运行时自检 `can_dial_natively()` 如实返回 false）
  - `/api/call/*` 与 CLI `/call`
  验收: `cargo test -p bolloon-agent call` **37/37** · web **118/0** · cli **45/45**。
- **未实现（如实）**:
  - 真实 Twilio / 阿里云 / SIP **连接**（需服务商账号 + 公网回调，你暂不提供，保留 Mock）
  - 真回声消除（AEC）：目前用**半双工**替代（播放时不采集），非神经网络 AEC
  - 通话录音（需双方同意 + 手机 OS 限制）
  - 手机原生拨号**真拨**：`gen/` 不存在、无手机壳可编译验证；`native.rs` 只生成意图，不执行
