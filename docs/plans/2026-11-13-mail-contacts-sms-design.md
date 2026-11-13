# 通讯录导入 · 短信 · 邮件管理 设计（手机 / 桌面 / TUI 三端）

日期：2026-11-13
状态：设计已确认（第 1–3 节逐节过），待实现
分支：`Rust`

## 1. 需求与共识（与用户逐条敲定）

| 议题 | 结论 |
|---|---|
| 与 `contacts-protocol.md` 的永久红线 | **修订协议**：把「读取通讯录 / 短信历史 / 全量邮箱」从「任何等级都拒」改为受支持的能力 |
| 授权模型 | **不分级**：能力默认支持，不设 `off/ask/auto` 逐项等级，不做逐次批准流；只保留总闸与紧急停止 |
| 「自动管理」的主体 | **Agent 自主读写为主**：Agent 在 Goal/Run 里自行收信、判断、起草、回复、归档 |
| 内容边界 | 全文可进 LLM prompt（用户自配供应商）；可跨机同步，但**仅限自己 DID 下已验签设备** |
| 首期范围 | **三端并行**：协议、Adapter、原生壳、三端 UI、Agent 工具同批 |
| CLI/TUI 接法 | **直连 crate**，不依赖 Web 服务在线 |
| 后台同步 | **默认开启**，可手动关闭 |
| 手机平台 | Android 通讯录 + 短信；iOS 通讯录；**iOS 短信平台不支持**，如实标注 |

## 2. 现状（事实，带证据）

| 项 | 事实 | 证据 |
|---|---|---|
| 主栈 | Rust（`rust/crates/*`），TS `src/*` 为旧栈 | `docs/wiki/current-status.md:31` |
| 三端 | `rust/app-tauri` 壳 + `bolloon-web` axum + 单源 `assets/index.html` | `rust/app-tauri/src-tauri/src/lib.rs:64-105`、`bolloon-web/src/server.rs:4144` |
| 通讯录 | DID 好友 + 本机名片本，**非系统通讯录** | `rust/crates/bolloon-agent/src/contacts.rs:335-363` |
| 邮件 | 仅 TS 旧栈 SMTP 发一条；Rust 零实现 | `src/agents/contacts/providers.ts:111-271`；`rust/` 检索 `smtp\|imap` = 0 |
| 短信 | 仅经 http-webhook 网关发一条；无读取 | `providers.ts:76-105`、`contacts-protocol.md:163` |
| 凭据 | 系统钥匙串 + AES-256-GCM 文件，目前只服务 LLM key | `rust/crates/bolloon-llm/src/{secret_store.rs:1-16,secret_file.rs:1-10}` |
| 手机原生工程 | **不存在**（无 `gen/apple`、`gen/android`、无 Info.plist / AndroidManifest） | `rust/app-tauri/src-tauri/` 目录、`tauri.conf.json:30-35` 仅桌面 targets |
| 硬拒机制 | `PolicyEngine::check` + `Harness::gate` + `forbidden_content_category` | `bolloon-harness/src/harness.rs:138,265` |

## 3. 协议变更（必须先做，否则代码无从依据）

### 3.1 作废 / 改写

| 旧条款 | 位置 | 处置 |
|---|---|---|
| 不自动读全量邮箱 / 全部手机通讯录 | `docs/wiki/contacts-protocol.md:30` | 作废 |
| 永不纳入授权：读全部邮箱 / 通讯录 / 短信历史 | `:193-194` | 作废 |
| 首次联系必须批准 | `:86` | 作废（改由总闸控制） |
| 单收件人 / 批量永久禁止 | `:78`、`:190` | **读**放开；**外发**仍限单收件人 |
| 明文不进 prompt / Run / Goal | `:61` | prompt 放开；Run/Goal 仍只存引用 ID + 摘要 |
| 不收集通讯录、短信、通话记录 | `docs/permissions-and-privacy.md:37` | 改写为「本地采集 · 用途告知 · 可一键清除」 |

### 3.2 新模型：默认支持 + 总闸 + 硬拒

- 能力默认开启，无逐项授权等级、无批准流。
- 总开关：`permission.json` 完全访问（`rust/crates/bolloon-web/src/server.rs:3509-3559`）+ Harness `emergency_stop`（`harness.rs:302`）。
- 「配置了哪个邮箱 / 账号」属数据源配置，不是授权。
- 撤销 = 关总闸 / 删账号 / 清本地库，立即生效。

### 3.3 仍然不做的硬边界（代码级硬拒，不属于授权分级）

1. **外发**密码 / 密钥 / 银行账号 / OTP / 支付指令 / 合同承诺 → 拒（读不拦，拦的是发出去）。
2. 批量群发 → 拒。
3. 通讯录 / 短信 / 邮件全文自动同步给**好友智能体**（他人节点）→ 拒；仅接受用户显式选中的单条。
4. iOS 读短信 → 平台不支持，标为缺口，不伪造。
5. 绕过 iOS / Android 运行时授权 → 不做。

## 4. 架构分层（遵循 `AGENTS.md` §8）

| 层 | 新增内容 | 落点 |
|---|---|---|
| Port | `MailPort` / `ContactsPort` / `SmsPort` | `rust/crates/bolloon-agent/src/ports.rs`（新） |
| Adapter | IMAP+SMTP、`ContactsContract`、`content://sms`、vCard/CSV | `rust/crates/bolloon-agent/src/adapters/`（新） |
| Service | `MailService` / `ContactsService` / `SmsService`（Adapter + Store + 硬拒的组装体） | `rust/crates/bolloon-agent/src/services/`（新） |
| 凭据 | `account_for_mail(<email>)` 命名空间 | 扩展 `bolloon-llm/src/secret_store.rs:337` |
| Store | 索引 SQLite + 正文加密库 | `~/.bolloon/mail/`（0600） |
| Tool Capability | `mail_tool_defs()` / `contacts_import_tool_defs()` / `sms_tool_defs()` | 加进 `bolloon-agent/src/builtin_tools.rs:185`，由 `:345` 注册 |
| 硬拒 | `forbidden_content_category` 扩展（多收件人、凭证类正文） | `bolloon-harness/src/harness.rs:138` + 新 `mail_policy.rs` |
| Route | `/api/mail/*`、`/api/contacts/import`、`/api/sms/*` | `bolloon-web/src/server.rs:438`；**必须**登记进 `:3513` 的 `FULL_ACCESS_GATED_*` |
| CLI/TUI | `/mail` `/contacts` `/sms` | `bolloon-cli/src/slash.rs:96` + `chat_command.rs:985`（另有 3 处门要同步） |
| Web / App UI | 邮件 / 通讯录 / 短信面板 | `bolloon-web/assets/index.html` |
| 手机原生壳 | `cargo tauri android init`、`ios init` | `rust/app-tauri/src-tauri/gen/`（待生成） |

两个入口（Web handler / CLI）都调同一个 `Service`，不产生第二条执行路径。

## 5. 数据模型与落盘

| 路径 | 内容 | 权限 |
|---|---|---|
| `~/.bolloon/mail/accounts.json` | 账号元数据（**无密码**） | 0600 |
| `~/.bolloon/mail/index.sqlite` | 邮件索引（uid / subject / from / to / date / flags / hash） | 0600 |
| `~/.bolloon/mail/bodies/<id>.enc` | 正文，AES-256-GCM | 0600 |
| `~/.bolloon/mail/outbox/` | 待发 / 失败重发 | 0600 |
| `~/.bolloon/rust/contacts-import.json` | 导入的通讯录条目 | 0600 |
| `~/.bolloon/rust/sms-index.sqlite` | 短信索引 | 0600 |

凭据走 `secret_store`（系统钥匙串优先，失败落 `~/.bolloon/secrets/` 的 AES 文件）：**不进 accounts.json、不进 prompt、不进 git、不进 Run/Goal**。

并发送写：`index.sqlite` 开 WAL + 进程间文件锁，写串行；Web 读走 WAL 快照。

## 6. Port 与 Adapter

```rust
pub trait MailPort {
    async fn sync(&self) -> Result<SyncReport>;
    async fn list(&self, q: MailQuery) -> Result<Vec<MailMeta>>;
    async fn read(&self, id: &MailId) -> Result<MailBody>;
    async fn send(&self, draft: MailDraft) -> Result<MailId>;   // 单收件人
    async fn archive(&self, ids: &[MailId]) -> Result<()>;
    async fn delete(&self, ids: &[MailId]) -> Result<()>;
}

pub trait ContactsPort {
    async fn import_all(&self) -> Result<ImportReport>;
    async fn list(&self, q: ContactQuery) -> Result<Vec<ContactMeta>>;
}

pub trait SmsPort {
    async fn sync(&self) -> Result<SyncReport>;
    async fn list(&self, q: SmsQuery) -> Result<Vec<SmsMeta>>;
    async fn send(&self, to: &str, body: &str) -> Result<SmsId>;
}
```

| Adapter | 桌面 | 手机 | CLI/TUI |
|---|---|---|---|
| `ImapSmtpAdapter` | ✅ | ✅ | ✅ |
| `VcardCsvAdapter` | ✅ | ✅ | ✅ |
| `AndroidContactsAdapter` | ❌ | ✅ | ❌ |
| `IosContactsAdapter` | ❌ | ✅ | ❌ |
| `AndroidSmsAdapter` | ❌ | ✅ | ❌ |
| `LocalSinkAdapter`（测试） | ✅ | ✅ | ✅ |

数据源：IMAP + SMTP 用户自配（Gmail / Outlook / QQ / 企业邮预设），OAuth 留扩展位但不首期做。

## 7. 数据流

```
系统权限授权
   ↓
Adapter.sync() → 归一化 → index.sqlite（元数据）+ bodies/<id>.enc（正文）
   ↓
Agent 工具：mail_search / mail_read / mail_send / contacts_search / sms_read …
   ↓
Harness.gate → 硬拒检查 → 执行 → 证据（Run/Goal 只存 id + 摘要）
```

## 8. 同步调度

| 数据源 | 触发 | 游标 |
|---|---|---|
| 邮件 | IMAP IDLE；不可用回落 5 分钟轮询（可配） | `UIDVALIDITY` + `last_uid` |
| 短信 | Android `ContentObserver`；否则 15 分钟轮询 | `_id` 最大值 |
| 通讯录 | 手动导入 + 变更增量 | `CONTACT_LAST_UPDATED_TIMESTAMP` |
| 手动 | `POST /api/mail/sync` · CLI `/mail sync` | — |

默认开启，复用现有 cron 调度；设置里可关（关后立即停，不用旧数据冒充最新）。

## 9. 错误处理（全部 fail-closed）

| 情况 | 行为 |
|---|---|
| 凭据缺失 / 失效 | `provider_not_configured` / `auth_failed`，不假装成功 |
| 网络不可用 | 保留上次结果并标 `stale` + 时间戳 |
| 单条解析失败 | 进 `parse_failed` 队列，不影响其它 |
| 索引库损坏 | 拒绝自动同步，`store_unreadable` |
| 系统权限被收回 | 立即停同步，`permission_revoked` |
| 发送失败 | 最多重试 3 次，落 `outbox/failed` |
| 附件超限 | 只存索引 + 标记，不截断成假内容 |

## 10. 三端接入

- **桌面**：Adapter 在 `app-tauri` 的 Rust 进程内直接调，不跨进程。
- **手机**：同一份 Rust 进程（Tauri mobile），Adapter 经 Tauri 命令调 Android `ContactsContract` / `content://sms` / iOS `CNContactStore`。
- **CLI/TUI**：直连 `bolloon-agent` 的 `Service`，不依赖 Web 服务在线；`/mail` `/contacts` `/sms` 注册进 `slash.rs`。
- **Web / App UI**：走 `/api/*`，handler 内调同一个 `Service`。

## 11. 测试与验收门

新增 `scripts/verify-mail-chain.ts`（照 `scripts/verify-contacts-chain.ts` 的写法，真协议真 socket）：

1. 假 IMAP / 假 SMTP 真跑同步，索引条数与投递一致
2. Agent 工具真读到正文，`mail_search` 命中
3. 发送后 SMTP 真收到，`outbox` 有记录
4. 硬拒：多收件人、正文含密码 / OTP → 拒且不发出
5. 关总闸 / `emergency_stop` → 立即全拒
6. 凭据 grep：`accounts.json`、`index.sqlite`、日志、Run/Goal 零明文密码
7. CLI `/mail` 与 Web `/api/mail` 读到同一份索引
8. 索引损坏 → fail-closed 并大声记录
9. 模拟好友节点请求全文同步 → 拒
10. `cargo test --workspace` 全绿 + `cargo check` 0 warning

另按 `AGENTS.md` §5.2 跑 `wiki_check.py`、`raw_manifest_check.py`、`wiki_lint.py --strict=v2`、`supersede_check.py`。

## 12. 构建顺序（依赖链，不是范围缩减）

`Port/Store` → `ImapSmtpAdapter` → `Tool + 硬拒` → `Service + Route + CLI` → `Android/iOS 原生壳与 Adapter` → `三端 UI 面板` → `verify-mail-chain.ts`

## 13. 风险与未决

| 风险 | 说明 | 缓解 |
|---|---|---|
| 双进程写索引 | CLI 与 Web 同开 | WAL + 文件锁，写串行 |
| Android `READ_SMS` 上架 | 非默认短信应用审核严 | 如实标注「需默认短信应用或特殊声明」 |
| iOS 短信 | 平台无 API | 标为缺口，不实现 |
| 全文进 prompt | 第三方信息进模型供应商 | 用户已知情选择；凭据类外发仍硬拒 |
| 手机原生壳从零起 | `gen/` 不存在，需 `tauri init` | 单列到构建顺序中段，先跑通桌面/TUI |
| 协议改动面大 | 触及 6 处 wiki 条款 | §3 清单逐条改，`wiki_lint` 校验 |

## 14. 诚实边界

- 本文件是设计，**代码尚未改动**。
- iOS 读短信物理不可实现，任何版本都不提供。
- 好友智能体自动同步全文不做，只接受用户显式选中的单条。
- 手机原生壳需先 `cargo tauri android init` / `ios init`，此前「手机版」只是网页布局。
