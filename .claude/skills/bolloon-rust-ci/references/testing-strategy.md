# 测试策略

## 分层

- **单测（L2）**：`cargo test --workspace --lib`。覆盖纯逻辑、序列化、错误路径、并发原语。
- **集成（L3）**：`crates/*/tests/`。跨模块真实组合；**依赖本机 `~/.bolloon` 或网络的用例在 PR 上不跑**。
- **UI E2E**：`e2e/*.spec.ts`（Playwright + 系统 Chrome，`npm run test:ui`）。属 TS 侧，不在 Rust CI 里跑。

## 纪律

1. 先让新测试**失败**（证明能抓缺陷），再让它通过。
2. 不许删失败测试、不许为通过而放宽断言。
3. flaky 先按"负载假红"处理：空载单跑该文件；仍红才算回归。
4. Mock 通过 ≠ 真实网络/存储已验证；报告里要写清"模拟"还是"真实实例"。
5. 异步/并发测试要可重复：避免依赖真实时间睡眠；用显式同步点。

## 常用

```bash
cd rust
cargo test -p <crate> --lib <过滤名>
cargo test --workspace --lib --no-fail-fast
cargo test --workspace --tests --no-fail-fast
```

## 覆盖现状（2026-11-15）

- 1296 个测试属性；5 个集成测试目录；0 个 bench。
- 真实多节点 P2P / MCP 未验证（见 `docs/ci/rust-audit.md` 能力矩阵）。
