# Clippy 存量债基线（2026-11-15）

- 命令: `cargo clippy --workspace --all-targets --all-features --message-format short`
- 结果: **45 条**（含 `lib` 与 `lib test` 的重复计数）
- 状态: **CI 中只统计、不阻断**（`CLIPPY_STRICT=0`）；清债后改 `-D warnings` 阻断。

> 行号会随 `cargo fmt` / 代码改动漂移，故此处**按 lint 名 + 文件**记录，不锁行号。
> 重新生成明细：
> ```bash
> cd rust
> cargo clippy --workspace --all-targets --all-features --message-format short 2>&1 \
>   | grep -E '^crates/.*: (warning|error):'
> ```

## 按 lint 分类

| 数量 | lint 现象 | 优先级 | 备注 |
|---|---|---|---|
| 8 | `MutexGuard` held across an `await` (`clippy::await_holding_lock`) | 高（正确性） | **全部在测试**（`belief_tools.rs`×4、`domain_tools.rs`×4）；`test_env` 的串行化锁，无真实并发竞争。修复方式：把 guard 作用域缩到 await 之前，或测试模块局部 `#[allow]` 并注释理由 |
| 4 | `sort_by_key` 可简化 | 低 | 机械替换 |
| 5 | `contains()` 替代 `iter().any()` | 低 | 语义等价，性能略好 |
| 2 | `std::slice::from_ref` 替代 `clone` 造切片 | 低 | 少一次分配 |
| 2 | 遍历 map 应用 `values()` | 低 | 机械 |
| 2 | `std::io::Error::other(_)` | 低 | 机械 |
| 2 | doc list 缩进 | 低 | 文档格式 |
| 2 | `DoubleEndedIterator` 上的 `last()` | 低 | 可用 `next_back()` |
| 2 | 函数参数 > 7（`belief.rs`、`chain_tx.rs`） | 中 | 建议 `#[allow(clippy::too_many_arguments)]` + 注释，或引入参数结构体（后者属重构，另开） |
| 2 | `new_without_default`（`FileEncryptedBackend`、`MacSayTts`） | 低 | 补 `Default` 或局部 `#[allow]` |
| 1 | `repeat_n()` 替代 `repeat().take()` | 低 | `chain_tx.rs` |
| 1 | `useless_vec` | 低 | `router.rs` |
| 1 | `let_unit_value` | 低 | `server.rs` |
| 1 | `?` 运算符可简化 | 低 | `diap_hub.rs` |
| 1 | `Option.and_then(|x| Some(y))` → `map` | 低 | `local_model.rs` |
| 1 | `useless format!` | 低 | `skill_authoring.rs` |
| 1 | `assert_eq!` 字面量 bool | 低 | 测试 |
| 1 | `length comparison to zero` | 低 | 测试 |
| 1 | 数字下划线分组不一致 | 低 | `native.rs`（`3_600_000`） |
| 1 | `field_reassign_with_default` | 低 | `call/voice.rs` |
| 1 | "operation always returns zero" / "no effect" | 低 | `initiative.rs` **测试里的写法**（`0*M+1`、`1*M`），非运行期 bug |

## 清债计划（建议顺序）

1. **先清低风险机械项**（sort_by_key / contains / from_ref / values / Error::other / repeat_n / useless_vec / doc 缩进 / 数字分组）——一次性批量，review 只看 diff 无逻辑变化。
2. **测试内 8 条 `await_holding_lock`**：把 `let _g = setup();` 的 guard 在 await 前后显式 `drop`，或测试模块顶部
   `#![allow(clippy::await_holding_lock)]` 并写清"测试串行锁，无并发竞争"。
3. **`too_many_arguments`**：加局部 `#[allow]` + TODO（结构体化是 API 变更，另开 PR）。
4. 全绿后把 `scripts/ci/check.sh` 的 `CLIPPY_STRICT` 默认改为 `1`，CI 加 `-D warnings`。

## 纪律

- 不允许用 `-A clippy::all` / 全局 `allow` 让数字变好看。
- 不允许删除测试来消掉测试内 lint。
- 每清一类，更新本文件的"数量"列，并记录 commit。
