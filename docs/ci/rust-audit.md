# BOLLOON Rust 仓库审计（Stage 1）

- 审计日期: 2026-11-15
- 审计环境: macOS 13.7.8 / x86_64
- 工具链: `rustc 1.99.1` · `cargo 1.99.1` · `clippy 0.1.99` · `stable-x86_64-apple-darwin`
- 工作目录: `rust/`（Cargo workspace 根）
- 原则: 所有结论都来自**实际执行过的命令**；未执行的明确标注"未验证"。

---

## 1. Workspace 结构

`rust/Cargo.toml` 是 workspace 根，成员 **11 个 crate**，版本统一 `0.7.10`（`version.workspace = true`）：

| crate | 职责（据 Cargo.toml + 代码注释） | 关键依赖 |
|---|---|---|
| `bolloon-kernel` | 宏内核机制层：队列/租约/取消/端口/生命周期/孤儿恢复 | — |
| `bolloon-config` | 配置与 Policy（`RuntimePolicy`、权限白名单） | serde |
| `bolloon-econ` | 经济/账本层（内部信用结算） | — |
| `bolloon-harness` | 工具门禁：discover→permission→policy→budget→idempotency→execute→evidence→event | — |
| `bolloon-llm` | LLM runtime / provider 适配 / 加密配置 | sha2, k256 |
| `bolloon-agent` | Agent 运行时：内置工具集、skill、mail、belief、world、call 等 | 大量（见下） |
| `bolloon-p2p` | P2P：QUIC（quinn）/ DIAP(iroh) / Kademlia DHT（可选） | quinn, libp2p(可选) |
| `bolloon-x402` | x402 付费协议 | — |
| `bolloon-web` | HTTP API + 内嵌 Web UI（`assets/index.html`）：个人代币/钱包/插件/联系人/设备同步 | axum, aes-gcm, pbkdf2, ureq |
| `bolloon-cli` | CLI / 守护进程入口（`bolloon web` 默认起 54188） | clap |
| `bolloon-tui` | 终端 UI | crossterm 等 |

依赖方向（简化，实测 `cargo metadata`）：

```
bolloon-cli
 ├── bolloon-agent ── bolloon-llm? / bolloon-p2p / bolloon-harness? / bolloon-kernel?
 ├── bolloon-web  ── bolloon-agent / bolloon-llm / bolloon-p2p / bolloon-x402 / bolloon-kernel / bolloon-config / bolloon-econ
 └── bolloon-tui
```

> 注：上图为职责关系示意；精确边以 `cargo tree` 为准（CI 里不跑 `cargo tree`，避免噪声）。

### 关注点

- `bolloon-web` 是**最大的单体 crate**（`native.rs` 上万行），同时承担 HTTP API、内嵌 UI、工具编排接线。
- `bolloon-agent` 依赖树最大（mail/imap、iroh 可选、libp2p 可选），是编译时间的主要来源。
- `bolloon-web` 与 `bolloon-agent` 存在**双向概念耦合**（web 调 agent 的工具/harness，agent 的 Skill 又被 web 的插件栏复用）。CI 必须同时覆盖两者。

---

## 2. Feature Flags

| crate | default | 可选 feature | 说明 |
|---|---|---|---|
| `bolloon-p2p` | 空 | `quic-transport`(quinn)、`diap-backend`(iroh) | DIAP 依赖树很大，不默认开 |
| `bolloon-web` | `quic-transport` | `diap-backend`、`dht-backend`(libp2p) | `peer_json` 有 DIAP 走隧道，否则回落 HTTP |
| `bolloon-cli` | `quic-transport` | `diap-backend`、`dht-backend` | 转发到 web/p2p |

实测结论：

- `cargo check --workspace --all-targets --all-features` **可编译**（2026-11-15 实测）。
- `cargo check -p bolloon-web --no-default-features` **可编译**；初始有 4 条 feature 相关告警（unused import / unused_mut），已在本次修复为 0。
- 因此 CI 采用**三档矩阵**：`default` / `--all-features` / `bolloon-web --no-default-features`，而不是只跑 `--all-features`。

---

## 3. 测试现状

| 指标 | 实测值 | 方法 |
|---|---|---|
| 测试属性数 | **1296** | `grep -rn '#\[tokio::test\]\|#\[test\]' crates --include='*.rs' \| wc -l` |
| 集成测试目录 | **5** | `crates/{config,agent,p2p,web,econ}/tests/` |
| Benchmarks | **0** | 无 `benches/` 目录 |
| Doc tests | 未验证 | 未单独执行 `cargo test --doc` |

已实跑（本次会话）：

- `cargo test -p bolloon-agent --lib directory::` → **20 passed**
- `cargo test -p bolloon-web --lib discovery::` → **3 passed**
- `cargo test -p bolloon-agent --lib plugin_tools::` → **2 passed**
- `cargo test -p bolloon-agent --lib builtin_tools::` → **15 passed**
- `cargo test -p bolloon-agent --lib domain_tools::` → **5 passed**
- `cargo test -p bolloon-web --lib personal_token::` → **5 passed**
- `cargo test -p bolloon-web --lib wallet_crypto::` → **5 passed**
- `cargo test -p bolloon-web --lib chain_tx::` → **6 passed**

未实跑：`cargo test --workspace --lib` 全量（见"不能执行的检查"）。

---

## 4. 质量风险

| 风险 | 实测 | 说明 |
|---|---|---|
| **rustfmt 漂移** | 初始 2400 处 diff | 已在本次 `cargo fmt --all` 规范化，现 `cargo fmt --all -- --check` **通过** |
| **clippy 存量债** | **45 条**（默认 feature + all-features，含 lib/test 重复） | 明细与修复优先级见 [`clippy-baseline.md`](./clippy-baseline.md)。其中 8 条 `await_holding_lock` 全在**测试**里 |
| **unsafe** | **71 处**（16 个文件） | 集中在 `bolloon-tui`（终端控制）、`bolloon-web`（server/qr/rendezvous）、`bolloon-agent`（test_env/home/net） |
| 编译告警 | default / all-features **0**；no-default 修复后 **0** | `cargo check` 已 0 warning |
| 无基准 | 0 bench | L4 只能先采集基线，不能凭空定阈值 |
| 集成测试依赖本机状态 | 5 个 tests 目录 | 部分依赖 `~/.bolloon` 运行态，PR 不宜全量跑 |
| 单文件过大 | `bolloon-web/src/native.rs` 万行级 | 合并冲突/审查成本高，非本次 CI 范围 |

---

## 5. 现有 CI（重构前）

| 文件 | 作用 | 结论 |
|---|---|---|
| `.github/workflows/rust.yml` | ubuntu + stable，`cargo check --workspace --all-targets` + `cargo test --workspace --lib`，有 `rust/**` path 过滤与 concurrency | **基线可用**，本次扩展为 `rust-ci.yml` 并**删除**旧 `rust.yml`（避免重复触发） |
| `.github/workflows/release.yml` | Electron 多平台发布 | 与 Rust CI 无关，保留 |
| `.github/workflows/gh-release.yml` | GitHub Release（注释说明 CI 未真跑） | 保留 |
| `.github/workflows/wiki-lint.yml` | wiki 校验 | 保留 |

CI 缺失项（本次补齐）：

1. 无 `fmt` / `clippy` 门禁。
2. 无 feature 矩阵（只跑默认）。
3. 无安全扫描（audit/deny/secret）。
4. 无缓存优化（仅旧 rust.yml 未配 cache）。
5. 无 nightly 性能/长稳。
6. 无 release 门禁（Rust 二进制发布走本地 `scripts/build-native.mjs` / `tauri-release.sh`，CI 未校验）。

---

## 6. 能力矩阵（诚实分级）

> 依据：代码存在性 + 测试存在性 + 本次实际执行过的测试。**"部分验证"= 有单测/模拟，但未见真实多机/真实网络 E2E。**

| 能力 | 状态 | 证据 / 边界 |
|---|---|---|
| Workspace 编译 | ✅ 已验证 | `cargo check --workspace --all-targets` 0 warning |
| Feature 组合（default/all/no-default） | ✅ 已验证 | 三条命令实测通过 |
| Agent Runtime（初始化/执行/生命周期） | 🟡 部分验证 | 有大量 lib 测试；未跑真实长稳 |
| Tool Registry / Selection / Execution | ✅ 已验证（本机） | `builtin_tools` 15 测试；harness 门禁单测 |
| Function Calling / 工具门禁 | ✅ 已验证（本机） | Harness 九步门禁有测试；未见真实 LLM 全链 E2E |
| MCP | ⚠️ 未验证 | 代码存在但未接线（此前审计结论）；无测试 |
| P2P（QUIC / DIAP / DHT） | 🟡 部分验证 | 有 p2p tests 目录与 discovery 单测；**未做真实多节点/公网联调** |
| Persistence（SQLite / JSON 落盘） | 🟡 部分验证 | 有 store 单测；并发/恢复未压测 |
| Session / Context Management | 🟡 部分验证 | 有单测；长上下文/并发未测 |
| Multi-Agent 协作 | 🟡 部分验证 | 有 room/group 测试；真实多进程未验证 |
| CLI / Web 接口 | ✅ 已验证（本机） | 联系人/连接码真机 UI E2E 2/2；钱包/代币单测 |
| 性能 / 长稳 | ❌ 未验证 | 无 bench、无压测 |
| 安全（依赖漏洞/许可证） | ⚠️ 未验证 | 本机未装 `cargo-audit`/`cargo-deny` |

---

## 7. 当前可执行 / 不可执行

### 可执行（本机与 CI 相同入口）

```bash
bash scripts/ci/check.sh          # L1: fmt + check(default/all/no-default) + clippy 统计
bash scripts/ci/test.sh           # L2: workspace --lib
bash scripts/ci/integration.sh    # L3: crates/*/tests
bash scripts/ci/security.sh       # L5: audit/deny(缺则 SKIP) + locked + unsafe 清单 + secret 扫描
bash scripts/ci/report.sh         # 汇总报告
```

### 当前不可执行 / 有限制

| 检查 | 原因 | 处理 |
|---|---|---|
| `cargo clippy ... -D warnings` 作为阻断 | 存量 45 条（含 8 条测试内 `await_holding_lock`） | 先**报告不阻断**，见 `clippy-baseline.md` 的清债计划 |
| `cargo audit` / `cargo deny` | 本机未安装；仓库无 `deny.toml` | 脚本明确 SKIP；CI 安装后运行 |
| `cargo test --workspace --lib` 全量 | 审计机磁盘耗尽（APFS 快照占满，`target/debug` 42G） | 只跑聚焦子集（见第 3 节）；全量留给 CI 首次运行 |
| 真实多节点 P2P | 需要 ≥2 台可达设备/公网 | Nightly 也只能本机多进程；公网联调标"未验证" |
| 性能基线 | 无 bench | 先建 Criterion 基线（未在本轮实施，标记 TODO） |
| Windows 目标 | 本机 macOS x86_64 | CI 用 windows-latest 编译检查；运行验证标"未验证" |

---

## 8. 结论

- Rust workspace 结构清晰、测试基数大（1296 个测试属性），但**缺 CI 质量门禁**（fmt/clippy/feature 矩阵/安全）。
- 主要债务：**clippy 45 条**、**unsafe 71 处**、**无性能基线**、**集成测试依赖本机状态**。
- 本次 CI 设计据此取舍：`fmt + cargo check(三档 feature)` 阻断；`clippy` 先统计；集成测试分 PR（限定范围）与 Nightly（全量）。
