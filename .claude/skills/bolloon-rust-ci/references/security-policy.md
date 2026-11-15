# 安全策略

## 依赖

```bash
cd rust
cargo audit                 # 漏洞（未安装则 SKIP，不伪报）
cargo deny check            # 许可证/重复依赖（需 rust/deny.toml）
cargo check --workspace --locked   # Cargo.lock 必须与 workspace 一致
```

## Unsafe

- 先**清单**再判断：`grep -rnE 'unsafe[[:space:]]*\{|unsafe[[:space:]]+fn|unsafe[[:space:]]+impl' rust/crates`。
- 审查要点：安全不变量、边界、并发、生命周期；能缩就缩。
- **不得**为过检查而删除必要的 unsafe 实现。

## Secret

- 禁止提交私钥/口令：`updater.key`、`personal_wallet.json` 明文、API key。
- 扫描模式：`BEGIN (RSA|OPENSSH|EC|PGP) PRIVATE KEY`、`AKIA...`、`ghp_...`。
- 已命中要人工确认并移出 + 轮换。

## 权限

- GitHub Actions：默认 `permissions: contents: read`；只有 release 工作流给 `contents: write`，且走 `environment: rust-release` 保护。
- PR 不允许触发发布；release 只认 tag。
