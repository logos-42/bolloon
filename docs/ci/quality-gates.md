# BOLLOON Rust CI 质量门禁（Stage 2）

五层门禁。原则：**能执行的真实执行；不能执行的明确标记 SKIP/NOT RUN，绝不伪报 PASS。**

| 层 | 名称 | 阻断策略 | 入口 |
|---|---|---|---|
| L1 | 代码质量 | `fmt` + `cargo check`(三档 feature) **阻断**；`clippy` 存量债**只报不阻断** | `scripts/ci/check.sh` |
| L2 | 单元测试 | 阻断（`--workspace --lib`） | `scripts/ci/test.sh` |
| L3 | 集成测试 | PR 跑 `crates/*/tests`（有限范围）；Nightly 全量 | `scripts/ci/integration.sh` |
| L4 | 可靠性与性能 | **不在 PR 跑**；Nightly 采集基线（当前无 bench，标记 TODO） | `rust-nightly.yml` |
| L5 | 安全与依赖 | `cargo check --locked` **阻断**；audit/deny 缺工具 SKIP；secret 命中阻断 | `scripts/ci/security.sh` |

---

## L1 代码质量

### 命令（与 CI 完全一致）

```bash
cd rust
cargo fmt --all -- --check
cargo check --workspace --all-targets
cargo check --workspace --all-targets --all-features
cargo check -p bolloon-web --no-default-features
cargo clippy --workspace --all-targets --all-features --message-format short   # 统计
# 清债后改成阻断：
cargo clippy --workspace --all-targets --all-features -- -D warnings
```

### Feature 矩阵（依据审计实测）

| 组合 | 目的 | 是否阻断 |
|---|---|---|
| default（`quic-transport`） | 日常开发主路径 | ✅ |
| `--all-features`（diap+dht+quic） | 跨 NAT / DHT 组合不被破坏 | ✅ |
| `bolloon-web --no-default-features` | 关掉可选传输仍能编译（正交性） | ✅ |

> 不使用"只跑 `--all-features`"：会掩盖 no-default 分支的 cfg 问题（本次实测就发现 4 条）。

### clippy 存量债

- 当前 **45 条**（含 lib/test 重复），明细见 [`clippy-baseline.md`](./clippy-baseline.md)。
- 默认 `CLIPPY_STRICT=0`：`check.sh` 只统计并打印数量，**不判失败**。
- 清债后把默认改为 `1`，并在 CI 加 `-D warnings`。
- **禁止**用 `-A` 全局关掉规则来"变绿"（那是掩盖而不是修复）。

---

## L2 单元测试

```bash
cd rust
cargo test --workspace --lib
```

- 只跑 `--lib`：集成/网络测试依赖本机运行态，PR 上不全跑（与既有 `rust.yml` 决策一致）。
- 回归纪律：失败测试**不许删除**；先判定是代码问题、环境问题还是测试问题。

---

## L3 集成测试

```bash
cd rust
bash ../scripts/ci/integration.sh          # 跑 crates/*/tests
bash ../scripts/ci/integration.sh --list   # 只看有哪些目标
```

现状：`crates/{config,agent,p2p,web,econ}/tests/`。

诚实边界：
- 部分集成测试依赖 `~/.bolloon` 或真实网络；本机跑通 ≠ 多机/公网验证。
- PR 上只做"目标可编译 + 独立用例"；多节点/压力测试放 Nightly。

---

## L4 可靠性与性能

当前状态：**未建立基线**（仓库 0 个 `benches/`）。

本轮只做：
1. 在 `rust-nightly.yml` 里预留 `criterion` 任务位（未装依赖时 SKIP）。
2. 任何性能结论必须记录：Commit SHA、机器、基线值、变化比例。
3. **不凭空制定阈值**；先采 3 次基线取中位数。

建议后续（未实施，标记 TODO）：
- 在 `bolloon-harness`/`bolloon-agent` 加 `criterion` bench：工具分发、`SkillRegistry` 查找、`Harness::gate` 开销。
- 长稳：Nightly 跑 1 小时多 Agent 心跳。

---

## L5 安全与依赖

```bash
bash scripts/ci/security.sh
SECURITY_STRICT=1 bash scripts/ci/security.sh   # 缺 audit/deny 也判失败
```

检查项：
- `cargo audit`（未安装 → SKIP）
- `cargo deny check`（缺 `rust/deny.toml` → SKIP）
- `cargo check --workspace --locked`（Cargo.lock 一致性，**阻断**）
- unsafe 清单（统计并输出，不阻断；审计用）
- secret 启发式扫描（私钥头 / AWS key / GitHub token，命中**阻断**）

---

## 报告模板（`scripts/ci/report.sh` 的真实输出）

```text
============================
BOLLOON RUST CI REPORT
============================
Commit: <sha> (<branch>)

L1 Code Quality : PASS|FAIL
L2 Unit Tests   : PASS|FAIL
L3 Integration  : PASS|FAIL|NOT RUN
L4 Reliability  : NOT RUN
L5 Security     : PASS|FAIL

Final Status    : PASS|FAIL
============================
```

规则：
- 凡未执行 → `NOT RUN`；凡缺工具 → 该层输出里标 `SKIP`。
- 不编造测试数量/覆盖率；数量以各命令真实输出为准。
