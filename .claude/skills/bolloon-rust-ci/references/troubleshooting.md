# 排障手册

## 1. `cargo check` 失败

- 先看第一个 `error[E....]`（后面的常是连锁反应）。
- `--all-features` 失败但 default 通过 → feature 组合问题：加 `#[cfg(feature=...)]`。
- `--no-default-features` 失败 → 有用到仅默认 feature 提供的类型，检查 import 的 cfg。

## 2. clippy 报错但 check 通过

- 存量 45 条是已知债（`docs/ci/clippy-baseline.md`），不算你的回归。
- 新增 lint 必须修；不要 `-A clippy::all`。
- `await_holding_lock`：不要跨 await 持 `std::sync::MutexGuard`；测试里可用局部 allow + 注释。

## 3. 测试超时 / 假红

- 先空载单跑该文件：`cargo test -p <crate> --lib <名> -- --nocapture`。
- 仍失败再当回归；区分"断言失败 / 超时 / 夹具缺失"。

## 4. 本机 `~/.bolloon` 干扰

- 集成测试可能读本机运行态。用 `BOLLOON_HOME=$(mktemp -d)` 隔离后再跑。
- 不要为了让测试过而清用户数据。

## 5. 链接 / 平台错误

- macOS 上 arm64 二进制不能在 x86_64 主机跑（`Bad CPU type`）：按 `process.arch`/`uname -m` 选二进制。
- Windows 相关：`bolloon-tui` 有 `term_compat`；报错先确认 cfg 分支。

## 6. `Cargo.lock` 不一致

- CI 用 `--locked`；本地改依赖后要提交 lock 变更，否则 CI 失败。

## 7. GitHub Actions

- 失败先看 job 日志第一处 error；`continue-on-error` 的 job 红了不会阻断，但要在报告里注明。
- 缓存问题：`Swatinem/rust-cache` key 基于 lockfile；改依赖会自动换 key。
- 不要给 PR 工作流 `contents: write`。
