---
name: bolloon-rust-ci
description: BOLLOON Rust 工程的 CI 与质量门禁工作流。适用于：修改/审查 bolloon 的 Rust crate（rust/crates/*）、执行 fmt/clippy/cargo check/单元测试/集成测试、判断 PR 能否合并、排查 Rust 编译或测试失败、评估 feature 组合（quic-transport / diap-backend / dht-backend）、生成 CI 报告、维护 GitHub Actions（rust-ci / rust-security / rust-nightly / rust-release）。不适用于纯 TypeScript/前端/UI 设计或非 Rust 项目的 CI。
---

# BOLLOON Rust CI

本 Skill 的职责：在**修改 bolloon Rust 代码前后**，用仓内真实脚本跑质量门禁，给出可追溯的结论。
唯一事实源是 `rust/` workspace + `scripts/ci/`；不要凭记忆或"看起来没问题"下结论。

## 关键路径

| 用途 | 路径 |
|---|---|
| Cargo workspace | `rust/`（11 个 crate，见 `references/architecture.md`） |
| 本地/CI 同一入口 | `scripts/ci/{check,test,integration,security,report}.sh` |
| 审计与门禁说明 | `docs/ci/rust-audit.md`、`docs/ci/quality-gates.md` |
| clippy 存量债 | `docs/ci/clippy-baseline.md`（当前 45 条，非阻断） |
| 工作流 | `.github/workflows/rust-{ci,security,nightly,release}.yml` |
| Skill 自带脚本 | `.claude/skills/bolloon-rust-ci/scripts/ci-*.sh` |

## A. 修改前（必须）

1. 读相关 crate 的 `Cargo.toml` 与源码，确认它属于哪一层（kernel/harness/agent/web/p2p/llm）。
2. 查已有测试：`grep -rn '#\[test\]\|#\[tokio::test\]' rust/crates/<crate>/src`。
3. 判断受影响范围：改了 `bolloon-web` 往往要连带看 `bolloon-agent` 的工具/harness；改了 feature 要看 `references/quality-gates.md` 的三档矩阵。
4. 明确验证计划（跑哪些、哪些不跑及原因）。

## B. 修改后（必须）

按顺序执行，全部通过才算完成：

```bash
bash scripts/ci/check.sh     # L1: fmt + check(default/all/no-default) + clippy 统计
bash scripts/ci/test.sh      # L2: cargo test --workspace --lib
bash scripts/ci/integration.sh   # L3: crates/*/tests（依赖本机状态时说明）
```

- 只改一个模块时，先跑聚焦测试（`bash scripts/ci/test.sh bolloon-web <过滤名>`），**最后**再跑一次全量 `test.sh`。
- feature 相关改动必须额外跑 `bash scripts/ci/check.sh no-default`。
- clippy 默认只统计；不要把"存量债没清零"当成自己引入的失败，但**新增**的 lint 要修掉。

## C. 失败处理

1. 原样保留完整错误输出（命令 + stderr）。
2. 定位到 crate / 文件 / 函数。
3. 分类：**代码问题 / 环境问题（缺工具、网络、本机 ~/.bolloon 状态）/ 测试问题（用例过期、环境相关断言）**。
4. 给出最小修复；禁止通过删测试、放宽断言、`#[allow]` 全局规则来"变绿"（局部 allow 必须写清理由）。
5. 修完重跑**相关**测试，最后跑一次 L1+L2。

## D. 完成前

```bash
git -C . diff --stat
git -C . status --short
bash scripts/ci/report.sh    # 生成真实 CI 报告（PASS/FAIL/NOT RUN/SKIP）
```

- 检查 diff 里没有意外文件（`target/`、`test-results/`、临时脚本）。
- 新增测试必须真的能失败（先验证它抓得住缺陷），再让它通过。
- 报告里的数字必须来自真实输出，不许编造。

## E. 行为约束

- 不得谎报测试通过；没跑就写 `NOT RUN`。
- 不得跳过失败测试；不得删除测试来让 CI 变绿。
- 不得把"编译成功"当成"功能正确"。
- 不得把"单元测试通过"当成"集成/真实网络通过"。
- 不得为过 clippy 而全局关闭规则（`-A clippy::all`）。
- 不得未经分析升级依赖或改架构。
- 不得破坏现有 API；确需变更要在报告里列为 breaking。

## 常用命令速查

```bash
# 只看某个 crate
cd rust && cargo check -p bolloon-web --all-targets
cd rust && cargo test -p bolloon-agent --lib directory::

# feature 矩阵
cd rust && cargo check --workspace --all-targets --all-features
cd rust && cargo check -p bolloon-web --no-default-features

# 安全
bash scripts/ci/security.sh
SECURITY_STRICT=1 bash scripts/ci/security.sh

# 报告
bash scripts/ci/report.sh
bash scripts/ci/report.sh --fast   # 跳过 L3
```

## 已知边界（不要当成"已完成"）

- clippy：45 条存量债，CI 中非阻断；见 `docs/ci/clippy-baseline.md`。
- L4 性能：仓库 0 个 bench，**无基线**；Nightly 里明确 SKIP。
- P2P / MCP / 多机：只有单测或模拟，**未做真实多节点/公网验证**。
- 跨平台：CI 只做 `cargo check` 编译验证，不等于运行兼容。
- `cargo audit`/`cargo deny`：本机可能未安装，脚本会 SKIP 而不是假通过。
