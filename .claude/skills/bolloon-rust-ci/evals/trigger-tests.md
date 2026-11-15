# 触发测试（Trigger Tests）

目的：确认 `bolloon-rust-ci` 只在 Rust 工程/CI 语境触发，不误触发到无关任务。

## 应该触发

| 输入 | 期望 |
|---|---|
| 检查 bolloon Rust CI | 加载 Skill，读 `docs/ci/*`，跑 `scripts/ci/check.sh` |
| 修复 Rust Clippy 错误 | 加载 Skill，按 `docs/ci/clippy-baseline.md` 判断存量/新增 |
| 给 Rust 模块加测试 | 加载 Skill，按 `references/testing-strategy.md` 先失败后通过 |
| 调查 Rust 集成测试失败 | 加载 Skill，分环境/代码/测试三类 |
| 检查 Cargo Workspace | 加载 Skill，读 `references/architecture.md` |
| 评估 Rust PR 能否合并 | 加载 Skill，跑 L1+L2（必要时 L3）并出报告 |
| 检查 Rust Release 构建 | 加载 Skill，指出 `.github/workflows/rust-release.yml` 门禁 |
| 定位 Rust 性能回归 | 加载 Skill，但明确"当前无 bench，需先建基线" |

## 不应该触发

- 纯产品设计 / UI 设计稿。
- 普通 TypeScript / 前端组件开发（用前端流程）。
- 非 Rust 项目的 CI 配置。
- 与 bolloon 无关的通用问答。

## 验证方式

对每条输入跑一次 Agent，检查：
1. 是否读取了 `SKILL.md`（而非直接猜）。
2. 是否调用了真实脚本/命令。
3. 不应触发的输入是否没有宣称为 Rust CI。
