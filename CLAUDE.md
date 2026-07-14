# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库性质

- `@bolloon/bolloon-agent` v0.3.x，全局安装后执行 `bolloon` 启动产品（Web / CLI / Electron 三种形态）
- P2P 文档智能体 + 人类判断力捕获/蒸馏/注入；底层对接 Pi Agent Session ReAct loop
- 核心范式：**wiki-first / compile-first / writeback 必做**——只改代码不回写 wiki = 没做完
- 启动规则：进入任何非闲聊任务前，默认先 `python3 scripts/version_check.py` + 读 `docs/wiki/index.md` + `docs/wiki/current-status.md` + `docs/wiki/log.md`（详见 `AGENTS.md`）

## 常用命令

```bash
# 开发
npm run dev                 # tsx + dotenv 起 src/index.ts（CLI 模式）
npm run dev:web             # 先 build:web，再起 src/index.ts --web
npm run dev:electron        # 并发 build:web + electron:start

# 构建（发布前必跑全量）
npm run build:main          # tsc → dist/
npm run build:web           # esbuild 把 src/web/client.ts → dist/web/client.js（前端唯一源）
npm run build:electron      # tsc -p tsconfig.electron.json → dist/electron.js
npm run build:cli           # node scripts/build-cli.js（产出 bin/bolloon-cli.cjs 包装）
npm run build:all           # 上面四个全跑
npm run prepublishOnly      # build:all + smoke:esm（发布闸门）

# 桌面打包
npm run app:bundle          # 手搓 scripts/build-app-bundle.cjs（electron-builder OOM 兜底）
npm run electron:pack       # electron-builder --dir
npm run electron:build      # electron-builder 出 dmg/nsis/AppImage

# 测试
npm test                    # vitest run（只匹配 src/test/**/*.test.ts，见下）
npm run test:watch
npm run test:pi-sdk         # tsx src/test/pi-sdk.test.ts（网络依赖，可能慢）
npm run smoke:esm           # 发布前 ESM 兼容性兜底

# 类型检查 / 验证
npx tsc --noEmit
npx vitest run --bail=1                          # 单测快速失败
npx tsx scripts/ablation/run.ts                  # 端到端 16 项验证，60s+
python3 scripts/wiki_check.py                    # wiki schema
python3 scripts/raw_manifest_check.py            # raw manifest
python3 scripts/wiki_lint.py --strict=v2        # v2 严格 lint
python3 scripts/supersede_check.py               # supersede/contradicts
```

### 测试约定（vitest.config.ts）

- 只匹配 `src/test/**/*.test.ts`；`*.spec.ts` 留给 playwright e2e
- 下列 `*.test.ts` 实际是 tsx 集成脚本（顶层 async + console.log），vitest 会 "No test suite found"——用 `npx tsx` 单跑：
  - `human-value-store` / `iroh-communication` / `iroh-transport` / `llm-judgment-integration` / `storage-integration`

### 提交前检查（lefthook）

- `vitest-bail` + `tsc-check` + `validate-system-prompt-layers` 并行自动跑
- 不要把 `LEFTHOOK=0` 加进 workflow（2026-07-06 已废弃全局禁用策略）

## 关键架构

```
src/
├─ index.ts                 # main() 入口；PORT 默认 54188（不是 3000）
├─ cli/                     # CLI 入口 + loading-tui.ts（启动旋转光标 + ready 提示）
├─ cli-entry.ts             # npm 全局安装后的 bolloon 入口
├─ electron.ts              # Electron 主进程
├─ agents/
│  ├─ pi-sdk.ts             # 主文件 2455 行（ReAct loop + 工具调度）；其余 4 个子模块从顶部 re-export
│  ├─ pi-sdk-{types,session-manager,tools,session-factory}.ts
│  ├─ react-loop.ts         # 流式事件链 (thinking → status:tool → token → ai → done)
│  ├─ skill-loader.ts       # 项目级 .bolloon/skills/ + 全局 skill 加载
│  ├─ shell-guard.ts        # shell 工具执行前白名单/危险模式拦截
│  ├─ pre-tool-validator.ts # tool 参数前置校验（如 document tools 的 path 必填）
│  ├─ parse-tool-call.ts    # ⚠️ 已知坑：必须能识别 `<invoke name="X">...</invoke>`，否则整个工具链废
│  ├─ judgment-protocol.ts  # 4 类判断 (rule/preference/trajectory/reward) 序列化
│  └─ agent-manifest-protocol.ts  # v2 字段 groups/functions/exportments/sciences
├─ llm/
│  ├─ pi-ai.ts              # LLM 多 provider 适配（minimax/openai/anthropic/openrouter）
│  ├─ llm-judgment-client.ts
│  ├─ config-store.ts       # ~/.bolloon/llm-config.json（永不入 git）
│  └─ system-prompt/layers/ # 15 层 system prompt，frontmatter 校验脚本见 scripts/validate-system-prompt.ts
├─ web/
│  ├─ server.ts             # 5275 行主文件，createWebServer(port) 闭包；**default param 是 3000 但 main() 显式传 54188，调用方别信默认值**
│  ├─ server-{types,storage,sse,v3-p2p}.ts  # server 拆出来的支持模块
│  ├─ client.ts             # 浏览器 UI 唯一源；**禁止手改 dist/web/client.js**（会被 build:web 覆盖）
│  ├─ client-loop-status.ts # 循环状态条抽离
│  ├─ routes-{judgments,llm-config,tasks}.ts
│  └─ util/safe-name.ts     # safeChannelName/safePeerName/safeName，防 undefined/null/NaN 渲染字面量
├─ network/
│  ├─ p2p-direct.ts         # 当前 P2P 主路径（纯 TS，persistent secretKey at ~/.bolloon/p2p-direct-secret-{role}.json）
│  ├─ iroh-transport.ts     # iroh 已 init 但 nodeId 通过 v3 P2PDirect publicKey fallback 暴露
│  └─ peer-fs.ts            # 4 类资源 (group/function/exportment/science) + 月度 chat 归档
├─ documents/reader.ts      # Bolloon.md / persona 等加载，缺 frontmatter 仍能装配
├─ bootstrap/
│  ├─ persona-loader.ts     # ~/.bolloon/persona/<agentId>/*.md 6 类
│  ├─ memory-compressor.ts  # ≥4 新 messages 触发 LLM 摘要
│  └─ chat-archiver.ts      # 月度滚动 + LLM 摘要 fallback 模板
├─ constraints/             # 约束层（操作日志 / 权限 / 质量门禁）
├─ security/                # shell-guard + secret 管理
├─ workflow/                # 8-Gate 状态机骨架
├─ test/                    # vitest 单元测试 + tsx 集成脚本混居
└─ pi-ecosystem-*           # Pi 子生态（colony / goals / judgment / mcp / subagents）
```

## 核心概念速查

- **P2P 主路径** = `src/network/p2p-direct.ts`（不用 `@diap/sdk` 的 sendToConnection，那是 mock；别引入回退）
- **Web 端口契约** = 54188；任何测试 harness / 文档如果写 3000 都过时
- **前端构建链** = `src/web/client.ts` → esbuild → `dist/web/client.js`（iife），改前端不跑 `build:web` 不会生效
- **判断力四类** = `rule` / `preference` / `trajectory` / `reward`（见 `judgment-protocol.ts`）
- **peer 4 类资源** = `groups` / `functions` / `exportments` / `sciences`（v2 manifest 字段名）
- **system prompt 层** = 15 层在 `src/llm/system-prompt/layers/*.md`，CI 用 `validate-system-prompt.ts` 校验 frontmatter

## 已知坑（必读）

| 坑 | 现状 |
|----|------|
| `parseToolCall` 不识别 `<invoke name="X">...</invoke>` 格式 | 工具调用全失败的根因；改时务必回归 `src/test/parse-tool-call.test.ts` |
| `saveCurrentSession` Windows `:` 文件名非法 | `SessionStore` 已 escape `:` → `__`，别再 revert |
| `@diap/sdk` `discovery.update is not a function` | 已 try/catch 降级到 warn；别尝试恢复 iroh hyperswarm 链路 |
| LLM 空 content | MiniMax-M3 + 16K+ system prompt + max_tokens=8192 → content=""；调大 max_tokens |
| 前端 `<final gen>` 块泄漏 | `addMessage` 入口已剥离 think 块 + 取 final gen 前内容 |
| `src/web/client.js` 已删 | esbuild 是唯一运行时源；手改 dist/ 无效且会被 build 覆盖 |
| iroh `/api/iroh/info` 返回 `nodeId: null` | server.ts 走 v3 P2PDirect publicKey fallback，标 `irohNodeIdSource` |

## 知识管理（wiki-first 范式）

- 改了代码 → 跑 §"常用命令"里 typecheck/test/ablation/build:web 全套
- 改了 wiki → 更新 `docs/wiki/log.md`（表格 + 详细）并检查 wiki 引用
- 改了 manifest → `python3 scripts/raw_manifest_check.py`
- 收到任何非代码文件（PDF/Excel/截图/附件/CAD/压缩包）→ 先查 `manifests/raw_sources.csv`，不在里面就 `python3 scripts/ingest_raw.py` 登记再用
- 提交风格：`feat(scope): 中文一句话` / `fix(scope): 中文一句话 (v0.2.X)` / `refactor|docs|test|chore(scope): 中文一句话`，参考 `git log --oneline -10`

## 不要做

- 不要手改 `dist/`、`bin/`、`node_modules/`、`bolloon-bolloon-agent-*.tgz`（本地包缓存）
- 不要把 API key / 私钥写进 git（统一放 `~/.bolloon/llm-config.json`）
- 不要把 `parseToolCall` 的 9 个正则删掉或"重构简化"——那是 `minimax` LLM 输出的唯一解码路径
- 不要给文档起包含 `:` 的文件名（跨平台 session 存档已 escape，但 wiki 链接会断）
- 不要相信 `createWebServer(port: number = 3000)` 的默认值——main() 显式传 54188，所有 dev/test 也用 54188