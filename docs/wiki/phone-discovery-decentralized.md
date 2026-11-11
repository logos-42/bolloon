---
title: 手机号 → 去中心化发现 (Hyperswarm / iroh 边界与落地)
source: session
created: 2026-11-11
last_confirmed: 2026-11-11
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
---

# 手机号 → 去中心化发现

> 用户口径 (2026-11-11): 「支持直接手机号跨机链接吗，实现一下」→「我们使用去中心化连接，hyperswarm和iroh」。

## 1. 先说实话: 三个问题各自的答案

| 问题 | 答案 |
| --- | --- |
| 跨机好友成功了吗? | **Rust 0.7.x 已真跑通**（`/api/node/connect` 互加 + `/api/agents/public/*` 跨机对话），但需要双方**互相可达**，且首次要有人交换地址 |
| 支持 DIAP 协议吗? | **身份层对齐，传输层没有**。DID 是 DIAP 本命 `did:pi:<b58 ed25519>`，`pubkey_of_did` 能读 `did:key:` 互验；但 `diap-rs-sdk` 只是 `Cargo.toml` 里的注释/feature 占位，**没有真依赖**，跨机好友链路也不走 DIAP 传输 |
| 支持手机号直连吗? | **本机 + 已登记对端能**（`/api/contacts/connect`）；**两端从未交换过任何信息时不能** —— 没有全局目录，这是物理约束 |

## 2. 传输层现状 (为什么不是"接上 hyperswarm 就行")

- **Rust 桌面端**: `bolloon-p2p` 只有 **quinn**（QUIC 直连）。`iroh` 曾在 0.28 因 `netwatch`/`socket2` 传递依赖冲突被放弃（见 `bolloon-p2p/Cargo.toml:26-30`）。
- **iroh 现在可用性已变**: 最新 `iroh 1.4.1`，MSRV 1.91（本机 rustc 1.99.1），**依赖树解析通过（371 包）**；但本机物理内存 7.4 GB / 可用 0.4 GB 时编译报 `os error 1450/1455`（页面文件太小）—— 是**机器资源**限制，不是版本冲突。
- **Hyperswarm 在 Rust 没有官方实现**。它是 JS 生态（本仓 TS 侧 `src/network/p2p-direct.ts` 直接用 `hyperswarm` + `@diap/sdk`）。所以：
  - 桌面 Rust 端: 用 **iroh** 承担「打洞 + 按公钥拨号 + relay 兜底」；
  - 手机 / TS 端: 继续用 **hyperswarm**；
  - 两边共用同一个「发现键」（下一节），换传输不用换发现方式。

## 3. 手机号 → 32 字节发现键（本轮已落地）

`bolloon-agent/src/directory.rs`：

```text
topic = SHA256("bolloon/phone-topic/v1" || "||" || normalize_phone(手机号))
```

- 输出 32 字节，正好是 **iroh 的 pkarr key** 与 **hyperswarm 的 topic** 的形状。
- **不能用本机 pepper**：目录盲化用 per-machine pepper，两台机器 pepper 不同 ⇒ 同一个号推出两个哈希 ⇒ 永远互相发现不了。所以发现键用**协议内固定盐**（`DISCOVERY_SALT`）。
- 固定向量（两端联调必须一致，测试钉住）：

| 手机号 | topic_hex |
| --- | --- |
| 13115718038 | `bfebc13bffe70c01486443e7a91a7394831c8c4f5cefe5cfcc9be2d80ea31cd1` |
| 17681953616 | `ccb034a68673ae1f096a2089b6ea86c98dbda97afe6ffef310fa4c5957fbd2e7` |

- 端点：`GET /api/contacts/topic?phone=…` → `{ok, normalized, topic_hex, topic_b58, salt, honest}`。

**隐私边界（不能省）**: 手机号空间只有 ~10^10，有算力的人能穷举出某个号的 topic ⇒ **topic 只用于「找到人」，绝不能当身份证明**。找到之后仍必须验：
1. DID 签名（`bolloon_p2p::KeyPair::verify`）；
2. 手机号绑定签名（`~/.bolloon/rust/phone_binding.json` 里的 `signed` + `signature` + `public_key`）。

## 4. 连接码（首次地址交换，本轮已落地）

两端从没连过时，没有第三方目录就只能先换一次名片。连接码 = **DID 私钥签名的名片**：

```text
bolloon-connect:v1:<base58( {"v":1,"phone","did","url","ts","sig","topic"} )>
签名正文: bolloon-connect|1|{phone}|{did}|{url}|{ts}
```

- `GET /api/contacts/invite` → 生成（自动带本机可达地址：`BOLLOON_PUBLIC_URL` > UDP 探出口 IP > 回环）；
- `POST /api/contacts/accept-invite {code}` → **逐字节验签** → 拒绝自己连自己 → 拒绝未来时间戳 → 登记对端基址 → 加好友 + 写名片（名字=手机号）。
- 篡改任意字段（换号/换地址）⇒ 验签失败，不可能拿别人的手机号冒充。

**它不是中心化目录**：只是一次性人工引导；换完就回到直连 / 以后 iroh 的发现链路。

## 5. 本轮交付清单 (真跑状态)

| 项 | 位置 | 状态 |
| --- | --- | --- |
| 发现键派生 + 固定向量测试 | `bolloon-agent/src/directory.rs` | ✅ **`cargo check -p bolloon-agent` 编译通过** |
| `GET /api/contacts/topic` | `bolloon-web/src/native.rs` / `server.rs` | 代码已落，**本机内存不足未能编译验证** |
| 连接码生成 / 验签接收 | `bolloon-web/src/native.rs` / `server.rs` | 同上 |
| UI「我的连接码 / 用连接码连接」 | `bolloon-web/assets/index.html` | ✅ 内联 JS `node --check` 3/3 |
| wiki 回写 | 本页 + `log.md` + `index.md` | ✅ 四门校验通过（待复跑） |

**诚实边界**: `bolloon-web` 的编译验证在本机失败于 `os error 1450`（内存），不是类型/语法错误；需要在有 ≥4 GB 可用内存的机器上复跑 `cargo check -p bolloon-web --lib` 才能签字。

## 6. iroh 接入的正确步骤（下一阶段，未开工）

1. **抬 MSRV**: workspace `rust-version` 1.85 → 1.91（iroh 1.4 要求）。这会改所有人的编译门槛，必须一次说清。
2. **feature 门控**: `bolloon-p2p` 加 `iroh-transport = ["dep:iroh"]`，**默认关**，不拖垮现有构建。
3. **实现 `Transport` 适配器**: 复用 `quic_transport.rs` 的 `Transport` 端口（`send/broadcast/add_peer`），内部换 `iroh::Endpoint`；身份仍用 `SignedEnvelope`（DID），iroh 的 node_id 只是传输地址。
4. **发现**: `pkarr`（Mainline DHT 上的 DNS 记录，MSRV 1.85）发布/解析 `topic → node_id + relay`；或等 iroh 自带 `iroh-dns`。**topic = 本页第 3 节的 32 字节**。
5. **接线**: `/api/contacts/connect` 命中 DID 后，优先用 iroh 拨号；失败回落现有 HTTP + 连接码。
6. **验收**: 两台真机（无公网 IP、无 UPnP）互相发现并建立连接；断网/对方离线时如实报错，不假装连上。

**资源要求（实测）**: 本机 7.4 GB 物理内存 / 0.5 GB 可用时，iroh 的 371 包编译在任何并发下都会 `1450/1455` 失败。至少需要 **8 GB 可用内存或更大页面文件**，并建议 `CARGO_BUILD_JOBS=2`。

## 7. 两端联调步骤 (Windows ↔ Mac, 手机号)

**前提**: 两端都能跑 `bolloon`（Rust 0.7.7+，含本页端点），且网络互通（同 WiFi / Tailscale / 公网地址任一）。

```bash
# A (Windows, 17681953616)
$env:BOLLOON_BIND="0.0.0.0"
bolloon web --port 54188
# 浏览器 http://127.0.0.1:54188 → 设置 → 手机号 → 填 17681953616 → 签名绑定

# B (Mac, 13115718038)
BOLLOON_BIND=0.0.0.0 bolloon web --port 54188
# 打开面板 → 设置 → 手机号 → 填 13115718038 → 签名绑定
```

1. A 点「我的连接码」→ 复制 `bolloon-connect:v1:…` 发给 B；
2. B 粘贴 → 点「用连接码连接」→ B 侧登记 A + 加好友；
3. B 点「我的连接码」→ 发给 A → A 粘贴 → 双向完成；
4. 之后任意一端在通讯录搜手机号 → `POST /api/contacts/connect` → 走已登记地址直连。

**判据**: 第 2 步返回 `{ok:true, friend_added:true}`；第 4 步返回 `{ok:true, via:"本机目录"|"跨机目录"}`；`GET /api/friends` 双方都出现对方 DID。

**诚实边界**: 本机当前出口 IP 是 `100.100.23.98`（`100.64/10`，典型 CGNAT/Tailscale 段），若两端不在同一虚拟网络且没有公网映射，双方都拨不通——这时连接码里的地址是内网地址，会连不上，必须先把网络打通（Tailscale / 端口映射 / 同一 WiFi）。
