---
title: hindsight-engine 记忆外挂接入 (crates.io 0.1.0, 进程内)
source: session
created: 2026-11-01
last_confirmed: 2026-11-01
schema_version: 2
audience: self
stage: current
status: current
confidence: high
entity_type: protocol
---

# hindsight-engine 记忆外挂接入

**一句话**: 用 crates.io 的 `hindsight-engine` (logos-42/hindsight-rust, **0.1.1**, 2026-11-01 发布) 给 Bolloon Rust 主路径加**进程内**语义记忆外挂 —— 本地 SQLite 恒为真源, hindsight 缺席/故障 = 自动降级, 行为与历史版本逐字一致。

> **0.1.1 变更 (同日)**: 撞到 0.1.0 的真限制 — `Context::connect` 急切构造 ChatModel, recall 根本不需要 LLM 却被 `llm.baseUrl` 卡死整个引擎。改法: `hindsight-llm` 新增 `LazyChat` + `build_chat_model_lazy` (构造不失败, 首次 `complete` 时才构造并诚实报错), `Context::connect` 改用懒构造。**recall-only 模式从此不需要任何 LLM 配置**。上游 commit `9ec65e7` 已推 logos-42/hindsight-rust main, llm/engine 双包 0.1.1 已上 crates.io, bolloon Cargo.lock 已升。

## 决策与依据

| 项 | 决定 | 依据 |
|---|---|---|
| 接入形态 | **进程内嵌** (`hindsight-engine` 直连), 不是 daemon/HTTP/MCP | 引擎就是为此设计的 (`Hindsight::connect` → `retain_text/recall_query`); Bolloon 主路径是 Rust 二进制; Rust 侧 `mcp.rs` 只有 stdio 帧而 hindsight MCP 是 HTTP transport |
| 真源 | 本地 SQLite (`~/.bolloon/rust/memory.db`) 恒先写 | 外挂可能缺席 (PG 没起/超时); 本地写入永远是真的 |
| 写路径 | SQLite 同步落盘 → `tokio::spawn` fire-and-forget 镜像 `retain_text` (async:true 语义) | retain 走 LLM 抽事实 (秒级), 绝不能阻塞 remember 工具返回 |
| 读路径 | 本地 top-k 在前, 外挂语义命中 `~` 前缀补充, 规范化去重, 截 900 字 (与 `dynamic.memory` max_chars 同口径) | `prompt.rs` 只有一个记忆注入层, 预算有限 |
| 隔离 | `bank_id = "{bankPrefix}:{agent_id}"` (缺省 `bolloon:local`) | hindsight 的隔离单位是 bank |
| 出境门 | `database_url` 必须 loopback, 非 loopback 需显式 `allowRemoteDatabase: true` | 记忆数据出本机 = 数据出境 (fail-closed, 不是配个 URL 就默许) |

## 引擎硬依赖 (hindsight-rust v0.1.0 如实边界, 与 Python 版不同)

1. **PostgreSQL + pgvector** (默认 `postgres://postgres:postgres@localhost:5432/hindsight`) — Python 版的 pg0 嵌入式 PG 在 Rust 版**没有**。
2. **LLM** (仅 retain 抽事实需要, 0.1.1 起懒构造): OpenAI 兼容给 `memory.llm.baseUrl` (如 ollama `http://localhost:11434/v1`) 或 Anthropic; **recall-only (`mirrorWrites: false`) 完全不需要 LLM**。
3. **embedding**: 缺省 `hash` (离线确定性, 零 key); 或 OpenAI 兼容 HTTP。**`local`/`onnx` 明确不支持** (报错, 不静默降级)。

## 落点清单

| 文件 | 内容 |
|---|---|
| `rust/crates/bolloon-agent/Cargo.toml` | `hindsight-engine = "0.1"` (crates.io, 非 path) |
| `rust/crates/bolloon-agent/src/memory_hindsight.rs` (新) | `HindsightSettings` 校验 (backend/llm.baseUrl/embeddings/loopback 门) · `HindsightMemory` (OnceCell 懒连接, 5s 连接超时, `last_error`/`config_error` 留痕) · `recall_merged` (超时 `recallTimeoutMs` 缺省 3000ms) · `mirror_remember_async` · 纯函数 `merge_lines`/`is_loopback_database_url` · 10 个单测 |
| `rust/crates/bolloon-llm/src/config_store.rs` | `LlmConfig.memory: Option<MemoryBackendSettings>` (camelCase, 与 TS 同文件同形状; key 不进 JSON, 走 `HINDSIGHT_API_LLM_API_KEY` env) |
| `rust/crates/bolloon-agent/src/domain_tools.rs` | `remember`: SQLite 落盘后 spawn 镜像 (evidence 加 `mirrored`); `recall`: 融合召回 + evidence `sources`/`degraded` |
| `rust/crates/bolloon-cli/src/main.rs` | `bolloon memory doctor` (配置/连接/bank 逐项如实报告); `cli_memory_recall_text` 融合外挂 (prompt 注入唯一取数点); `bolloon memory recall` 附带 `~` 外挂行 |

## 配置样例 (`~/.bolloon/bolloon-config.json`)

```jsonc
"memory": {
  "backend": "hindsight",              // 缺省 "local" = 外挂整体零行为
  "databaseUrl": "postgres://postgres:postgres@localhost:5432/hindsight",
  "llm": { "provider": "openai", "model": "gpt-4o-mini", "baseUrl": "http://localhost:11434/v1" },
  "embeddings": { "provider": "hash" } // 离线; 换 OpenAI 兼容端点则填 baseUrl
}
```

## 验证 (真跑)

- `cargo test -p bolloon-agent --lib` **470/0** (含 memory_hindsight 10 项: 默认关/未知 backend/baseUrl 仅 mirror 必需 + recall-only 合法/非 loopback 拒+显式放行/local-onnx 拒/bank 命名/loopback 解析/去重/**预算截断**/空外挂 noop) · `cargo check --workspace` 0 错。
- 上游 `hindsight-llm` 测试 **18/0** (含 3 个新: 懒构造无 LLM 配置可拿模型/缺 baseUrl 首次 complete 诚实报错/急切版仍 fail-fast 向后兼容)。
- `bolloon memory doctor` 五态真跑: 默认关 (零行为) / 配置不合法 (逐字报原因) / PG 不在 (连接失败如实报告, exit 0, 功能照常) / recall-only 配置合法 (mirrorWrites=false 无 LLM 配置不再被拒) / 本地 SQLite 恒 OK。
- 自测抓到一个真 bug: 去重键最初用了带 `~` 前缀的文本 → 外挂重复项滤不掉; 已修 (键 = 原始内容)。

## 诚实边界 (未做/未验)

1. **真引擎端到端未跑** (本机无 PG+pgvector, Docker 未起): `retain_text`→LLM 抽取→语义召回全链路未在真 PG 上验过; 只验到"连接失败诚实降级"。
2. Web 侧 (`/api/memory`) 未加双源标注 (P1); TS 侧 5 个 `memory_*` 工具未接 (P2, TS 路径不走 Rust 二进制)。
3. hash embedding 是确定性词桶, 召回质量弱于真语义向量 — 离线可用≠质量等价。
4. 外挂 `recall` 与本地 `recall` 的相关性分数不互比 (本地 importance×decay vs hindsight RRF), 合并只做去重不做分数融合。
5. 本机磁盘满 (233G, 100%) 曾阻塞构建, 已清理可再生缓存 (hindsight-rust/target 1.1G + 废纸篓 6.6G) 恢复; **占用来源未查明, 会缓慢回升**。
