# 架构速查（rust/）

workspace 根：`rust/Cargo.toml`；11 个成员，版本统一由 `version.workspace` 提供。

| crate | 层 | 职责 |
|---|---|---|
| `bolloon-kernel` | 机制 | 队列/租约/取消/端口/生命周期/孤儿恢复。**不含业务判断** |
| `bolloon-config` | 配置 | `RuntimePolicy`、权限白名单、超时 |
| `bolloon-harness` | 门禁 | `Harness::gate` 九步：discover→permission→policy→budget→idempotency→execute→evidence→event |
| `bolloon-llm` | 基建 | provider 适配、加密配置（`secret_file.rs`） |
| `bolloon-agent` | 运行时 | 内置工具集、skill、mail、belief、world、call、scratch、plugin |
| `bolloon-p2p` | 传输 | QUIC(quinn)、DIAP(iroh, 可选)、Kademlia DHT(可选) |
| `bolloon-x402` | 协议 | x402 付费 |
| `bolloon-web` | 接口 | axum HTTP + 内嵌 UI（`assets/index.html`）+ 钱包/代币/插件/联系人/设备同步 |
| `bolloon-cli` | 入口 | `bolloon web`（默认 54188）、cron/permission/sql 等子命令 |
| `bolloon-tui` | 终端 UI | 依赖平台终端 API（unsafe 较多） |
| `bolloon-econ` | 经济 | 内部信用结算 |

## 改动的连带影响（经验）

- `bolloon-web/src/native.rs` 是最大单体：改它常影响工具 schema、SSE、会话持久化。
- 工具相关改动通常要同时改：
  1. `bolloon-agent/src/builtin_tools.rs::builtin_tool_defs()`（schema）
  2. 同文件 `BuiltinExecutor::execute` 的 `match name`（分派）
  3. 权限：`DEFAULT_GRANTED_TOOLS` / `READONLY_TOOL_NAMES`（按风险决定加不加）
- feature 改动（`quic-transport`/`diap-backend`/`dht-backend`）必须跑三档 check。

## 快速定位

```bash
cd rust
cargo metadata --no-deps --format-version 1 | python3 -c "import json,sys;print([p['name'] for p in json.load(sys.stdin)['packages']])"
cargo tree -p bolloon-web -i bolloon-agent   # 谁依赖谁
```
