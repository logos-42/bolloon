# 质量门禁速查

完整版：`docs/ci/quality-gates.md`（本文件只列执行口径）。

| 层 | 阻断？ | 命令 |
|---|---|---|
| L1 fmt | ✅ | `cargo fmt --all -- --check` |
| L1 check | ✅ | `cargo check --workspace --all-targets` |
| L1 check all-features | ✅ | `cargo check --workspace --all-targets --all-features` |
| L1 check no-default | ✅ | `cargo check -p bolloon-web --no-default-features` |
| L1 clippy | ❌（存量 45 条） | `cargo clippy --workspace --all-targets --all-features --message-format short` |
| L2 单测 | ✅ | `cargo test --workspace --lib --no-fail-fast` |
| L3 集成 | ✅（push 主干） | `bash scripts/ci/integration.sh` |
| L4 性能 | 不跑 | Nightly；当前无 bench → SKIP |
| L5 locked | ✅ | `cargo check --workspace --locked` |
| L5 audit | 装了才跑 | `cargo audit` |
| L5 secret | ✅（命中即失败） | `bash scripts/ci/security.sh` |

## 三档 feature 矩阵（为什么）

- `default`：日常主路径（`quic-transport`）。
- `--all-features`：diap + dht + quic 组合不被破坏。
- `bolloon-web --no-default-features`：验证可选传输真的正交（本轮实测发现 4 条 cfg 告警）。

## clippy 纪律

- 存量债允许存在，但**新增** lint 要修；不要用 `-A` 全局关。
- 清完存量后：`CLIPPY_STRICT=1` + CI 加 `-- -D warnings`。
