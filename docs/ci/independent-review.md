# 独立审查记录（Stage 10）

- 日期: 2026-11-15
- 方式: 独立 Agent **只读**打开实际文件核对（不依赖实现者总结）
- 审查范围: `.github/workflows/rust-*.yml`、`scripts/ci/*.sh`、`docs/ci/*.md`、`.claude/skills/bolloon-rust-ci/**`、`.agent/skills/bolloon-rust-ci`，以及仓库事实（Cargo workspace / features / benches / deny.toml / 测试目录）

## 审查结论（摘要）

> 原文结论：YAML 合法；action 名称/输入真实存在；没有"必然让 CI 失败"的错误；但发现若干会误导/丢证据的问题。

### 已修（本轮）

| # | 问题 | 证据 | 修复 |
|---|---|---|---|
| 1 | `check.sh clippy` 子命令退出码 2（非严格分支未置 `ONLY_RAN`） | `scripts/ci/check.sh` | 非严格分支加 `ONLY_RAN=1` |
| 2 | `report.sh` 四层共用一个日志，失败证据被覆盖 | `scripts/ci/report.sh` | 改为 `/tmp/bolloon-ci-<layer>.log` |
| 3 | `rust-release.yml` 的 `dry_run` 是死参数 | workflow | 删除该 input；dispatch 仅构建不发布，并在注释写明 |
| 4 | `security.sh` 未 prune `.git`，且扫到 `contracts`（第三方 forge-std）会误阻断 | `scripts/ci/security.sh` | prune 加 `.git`；扫描范围收敛为 `rust .github scripts` |
| 5 | 手动触发 `rust-ci` 时 L3 被静默跳过 | `rust-ci.yml` | 条件改为 `github.event_name != 'pull_request'` |
| 6 | release workflow 级 `contents: write` 过宽 | `rust-release.yml` | 顶层 `contents: read`，仅 `publish` job 给 `write` |
| 7 | checkout 未禁用凭据持久化 | workflows | 全部 `persist-credentials: false` |
| 8 | CI 自称"与本地同入口"但 L1/L2 内联命令 | `rust-ci.yml` | L1/L2/L3/L5 全部改为调 `scripts/ci/*.sh` |
| 9 | `integration.sh --list` 在无目标时先输出 SKIP | `scripts/ci/integration.sh` | `--list` 判断提前 |
| 10 | Skill 缺 `ci-integration.sh` / `ci-security.sh`，与 `ci-*.sh` 表述不对称 | skill | 补齐两个包装脚本 |

### 接受但未改（记录在案）

| 项 | 原因 |
|---|---|
| action 未 pin 到 commit SHA | 需要逐仓核对 SHA；当前用官方 major tag，作为后续加固项 |
| `cargo deny` 段当前恒 SKIP（无 `rust/deny.toml`） | 不伪造策略文件；等确定许可证白名单后再启用；脚本已明确 SKIP |
| `.claude/` 被 `.gitignore` 忽略 | 使用 `git add -f` 强制纳入 `bolloon-rust-ci`；`.agent` 符号链接指向它（目标已入库） |
| evals 是 Markdown 说明书而非可执行 harness | 与仓库现有测试体系（vitest/cargo）解耦；场景表可直接人工/AI 执行 |
| 45 条 clippy 数字散落多处 | 已集中在 `clippy-baseline.md`；清债时以该文件为准同步其它引用 |

## 审查者明确核对的仓库事实

- 11 个 workspace 成员；feature 为 `quic-transport` / `diap-backend` / `dht-backend`。
- unsafe **71 处 / 16 文件**（与 `rust-audit.md` 一致）。
- 集成测试目录 **5 个**；`benches` **0 个**；无 `deny.toml`。
- `rust/Cargo.lock` 存在（`version = 4`）。
- `[[bin]] name = "bolloon"` 与 release 产物名一致。

## 审查者未能复核（受只读/环境限制）

- `cargo fmt --check` 是否真通过、45 条 clippy、1296 个测试属性、`cargo check --locked` 的实时状态。
  → 这些由实现方在本机会话中实际执行（见 `rust-audit.md` 第 3/7 节），CI 首次运行时会再次验证。

## 未解决风险

1. 本机磁盘耗尽（APFS 快照占用），`cargo test --workspace --lib` 全量**未在本机跑完**；只跑了聚焦子集。
2. 跨平台 job 仍 `continue-on-error: true`，平台兼容性未验证。
3. 无性能基线（0 bench）。
