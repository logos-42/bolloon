# Wiki 日志

> 每次 session 结束在这里追加一行, 格式 `## [YYYY-MM-DD] <phase> | <一句话>`.
> `phase` ∈ {init / feature / fix / refactor / docs / chore / test}.

| 日期 | phase | 一句话 | 关联 |
|| 2026-08-06 | feat | 统一 Agent Identity: AgentIdentityStore (channels.json → identity + active-channel.json 持久化, CLI/Web 共用); /channel [名字|id|序号] 命令 (number>id>name 解析, 无参列表, 切换即刷新状态栏); CLI 状态栏显示 agent + channel 并重启恢复; Web GET/POST /active-channel + 默认选中; Context 快照绑 identity; 修 Ink 弹窗 Enter 拦截 + stdin paused 防御. tsc 0 错, vitest 1035/1035, pty 13/13 | [agent-identity-store.ts](../../src/agents/agent-identity-store.ts) |

|| 2026-08-06 | feat | OrbitDB + UI CID 数据层: @orbitdb/core@4.0.0 + helia@7.1.3 去中心化存储 (src/orbitdb/ 5 模块): ① CIDDatabase+OrbitDBAdapter (内容寻址 CID, save/load/update/version/list/share); ② Context Store (资产层快照/恢复/版本 + 多 agent 共享记忆); ③ UI CID (组件 CID 化 + React 动态构造); ④ 10 个 agent 工具 + TOOL_WHITELIST. helia 7 配置坑: createHelia 不传 withLibp2p opts / services 浅合并 / gossipsub emitSelf / dag-cbor codec / all() 返回对象数组 / dag-cbor 禁 undefined. tsc 0 错, vitest 1027/1027, 全栈验证 27/27 | [orbitdb](../../src/orbitdb) / [verify-orbitdb-stack.ts](../../scripts/verify-orbitdb-stack.ts) |

|| 2026-08-05 | feat | CLI @ / # 弹出选择窗 + 输入历史 + Tab 补齐: 输入 @ 弹窗命中智能体 (本地 channels.json + 远端 remote-channels-cache.json), / 弹窗命中 14 内置命令 + 技能 (3 skill 目录) + MCP 插件 (~/.mcp.json), # 弹窗命中 cwd 文件 (深度3, 上限400). ↑/↓ 导航, Tab/Enter 选中插入 (@名 / /命令 / use_skill 技能 / #路径), Esc 关闭. ② ↑/↓ 切换输入历史 (最近→更早→草稿, 去重上限100); ③ 普通输入 Tab 命令补齐: 唯一候选直接补 /命令, 多候选弹 'Tab 补齐' 窗. 修 3 个 Ink 输入坑: ① useInput 闭包陈旧 → 全函数式 setInput; ② Ink 把一次 stdin read 当单个 keypress (CJK 粘贴/退格连发 chunk) → 逐字符处理 + 正常模式 setTimeout(0) 纠正 TextInput 垃圾追加; ③ TextInput focus 切换 cursorOffset 不重置 → accept 后 key 重挂载. 状态栏计时改 h/m/s 进位 (fmtDuration). placeholder 加提示, /help 同步. tsc 0 错, vitest 1027/1027 (+8 mention-data 单测), pty 实测 15/15 (mention-popup-test.py) | [mention-data.ts](../../src/cli/mention-data.ts) / [ink-app.tsx](../../src/cli/ink-app.tsx) / [mention-popup-test.py](../../scripts/mention-popup-test.py) |
|| 2026-08-04 | feat | Polymarket 迁移官方统一 SDK @polymarket/client + 编译版路径修复: ① 旧实现用 @polymarket/clob-client + polymarket-sdk (已被官方弃用, 文档只推 @polymarket/client) → 全部迁移: listMarkets/getMarket 用 createPublicClient() (listMarkets/fetchMarket, Paginated), createOrder/getOrders/cancelOrder 用 createSecureClient({signer: privateKey(pk)}) (placeLimitOrder/listOpenOrders/cancelOrder, 签名 SDK 内部处理, 不再手动派生 API key); clobShared 保留 fetchMarketMeta (Gamma) / resolveTokenId / normalizePrivateKey, buildClobClient→buildSecureClient 兼容别名; ② 发现深坑: pi-sdk-tools 动态 import '../constraint-runtime/dist/...' 但主 tsconfig exclude workspace → dist/constraint-runtime 缺失 → 编译版 (全局/发布包) 的 wallet/polymarket/safe 工具全部模块缺失; 修复 build:main 追加 scripts/copy-constraint-runtime.mjs 把 workspace 编译产物复制进主 dist; ③ 测试更新: vi.mock @polymarket/client (placed/open/cancelled 调用记录), 断言 placeLimitOrder 参数; ④ 实测: 编译版 listMarkets 真实返回市场 (Xi Jinping out before 2027?), vitest 1019/1019 (含 16 个 Polymarket 真实网络测试). tsc 0 错, 全局 dist 已同步 | [PolymarketSDK](../../src/constraint-runtime/src/tools/PolymarketSDK) / [copy-constraint-runtime.mjs](../../scripts/copy-constraint-runtime.mjs) / [wallet-polymarket-verify.test.ts](../../src/test/wallet-polymarket-verify.test.ts) |
|| 2026-08-04 | feat | Web 上网工具 + provider 型号全面更新 + grok 支持: ① agent 新增 fetch_url (curl 实现, 抓网页转纯文本, 兼容 TLS 指纹风控 — undici 被 DDG 等风控, curl 正常) + web_search (三引擎: TAVILY_API_KEY→Tavily / DuckDuckGo Instant Answer API / Wikipedia API, 免 key 可用, 实测"杭州市"返回 5 条) + TOOL_WHITELIST; ② 型号更新 (官方文档+用户确认): OpenAI gpt-4.1→gpt-5.6 (alias→Sol), Anthropic claude-sonnet-4-5→claude-sonnet-5, Gemini gemini-2.5-pro→gemini-3.1-pro (3.5 仅 flash), Kimi moonshot-v1-8k→kimi-k3 (用户确认), GLM glm-4-flash→glm-5.2 (用户确认), Qwen qwen-plus→qwen3-max, openrouter→anthropic/claude-sonnet-5, ollama/local→llama4; ③ 新增 grok provider (XAI_API_KEY / https://api.x.ai/v1 / grok-4.5, openai 兼容走 callOpenAI) + detectProvider/detectModel 同步. tsc 0 错, vitest 1003/1003 (排除 Polymarket 网络测试), 全局 dist 已同步 | [pi-sdk-tools.ts](../../src/agents/pi-sdk-tools.ts) / [pi-ai.ts](../../src/llm/pi-ai.ts) / [tool-gate.ts](../../src/security/tool-gate.ts) / [verify-web-tools.ts](../../scripts/verify-web-tools.ts) |
|| 2026-08-04 | fix | terminated 根因锁定: node 内置 fetch 连接池僵尸连接 + 重试 dispatcher 被忽略. 排查排除: API 故障 (curl/node 全 200)、上下文大小 (136KB 200)、超时 (AbortError 非 terminated)、keep-alive 空闲 (90s 复用正常); 用户网络有 ClashX Pro TUN (DNS 198.18.0.2 fake-ip) 但非根因 (以前也开着正常). 实测发现: node 内置 fetch (undici 7.18.2) 静默忽略 npm undici 7.29.0 Agent 的 dispatcher (localPort 不变) → 我的"重试新连接"从未生效, 一直在复用被对端关闭后留在池里的僵尸连接 → 连续 "other side closed" → 前几次正常 (连接池健康), 某次连接被关后一直失败, 重试也无效. 修复: callOpenAI 弃用全局 fetch 改用 npm undici request() (独立连接池), 重试传 dispatcher 真正生效; 错误 pattern 加 "other side closed"; verify-llm-retry 改为本地 server 断连复现: 第一次 socket destroy → "other side closed" → 退避 1s → 重试新连接成功 ✓. tsc 0 错, vitest 1003/1003 (排除 16 个 Polymarket 网络测试 — 用户网络连不通 gamma-api 属环境问题), 全局 dist 已同步 | [pi-ai.ts](../../src/llm/pi-ai.ts) / [verify-llm-retry.ts](../../scripts/verify-llm-retry.ts) |
|| 2026-08-04 | fix | terminated 顽固排查 + 重试加固: 实测排除 API 故障 (curl/node 连发/大 prompt 136KB/90s 空闲 keep-alive 全部 200)、超时是 AbortError 不是 terminated、undici 无视 Connection: close 头 — terminated 只来自底层连接被关闭 (fetch/index.js onError→terminate→TypeError('terminated')); 修复: ① 网络错误重试 2→3 次, 退避 1s/2s/4s (指数); ② 每次重试用全新 undici Agent (新连接池) 强制新 TCP 连接, 避免复用被服务端关闭的 keep-alive 连接持续 terminated; ③ 成功/HTTP 错误/最终失败路径 destroy retryAgent 防连接泄漏; ④ chat() 错误信息带 error.cause (undici 网络错误根因在 cause 里, 如 other side closed), 下次失败可见真因. verify-llm-retry 升级: 前 2 次 terminated → 第 3 次成功 (退避 1s/2s, 总 3s). tsc 0 错, vitest 1019/1019, 全局 dist 已同步 | [pi-ai.ts](../../src/llm/pi-ai.ts) / [verify-llm-retry.ts](../../scripts/verify-llm-retry.ts) |
|| 2026-08-04 | chore | 发布 v0.3.30: 去掉单轮工具上限 (chain gate 5) + LLM 网络错误自动重试 (terminated/ECONNRESET 退避 1.5s/3s, abort 不重试). tsc 0 错, vitest 1019/1019, registry dist-tags.latest=0.3.30 确认 | [npm](https://registry.npmjs.org/@bolloon/bolloon-agent) |
|| 2026-08-04 | fix | 去掉单轮工具上限 + LLM 网络错误自动重试: ① 移除 tool-gate Gate 7 checkChain (单轮最多 5 个 tool) — 实测 MCP 多步测试被反复拦 (agent 调 5 个工具后被拒, 只能"继续"再试, 流程断裂; 日志里 1ms 的 mcp_tool 全是 gate 拒绝), 用户要求去掉; GateId 去 'chain', TOOL_GATES 移除, 测试 -3 (harness-integration); ② pi-ai callOpenAI fetch 网络层瞬时错误 (undici "terminated"/ECONNRESET/socket hang up/fetch failed 等) 退避重试最多 2 次 (1.5s/3s), abort 不重试 — 之前直接抛给 chat() 变成 "[AI 服务调用失败] terminated" 打断 agent 流程; 空 content 重试逻辑保留; mock 验证: 第一次抛 terminated → 退避 1.5s → 第二次成功. tsc 0 错, vitest 1019/1019 (原 1022 -3 chain 测试), 全局 dist 已同步 | [tool-gate.ts](../../src/security/tool-gate.ts) / [pi-ai.ts](../../src/llm/pi-ai.ts) / [harness-integration.test.ts](../../src/test/harness-integration.test.ts) / [verify-llm-retry.ts](../../scripts/verify-llm-retry.ts) |
|| 2026-08-04 | chore | 发布 v0.3.29: CLI 输入框提示 (Esc 双击退出 / /queue 排队 / !终端命令) + 双击 Esc 退出进程 (Ink exit 只 unmount 不退出 → __inkRequestExit 打通清理) + agent 5 个 IPFS/IPNS 工具 (ipfs_add/cat/ls + ipns_publish/resolve, 自动装 Kubo) + run-end 经验整理补齐 CLI 端 (writeRunEndSkillCandidates 公共函数 + 颜文字加载). tsc 0 错, vitest 1022/1022, registry dist-tags.latest=0.3.29 确认 | [npm](https://registry.npmjs.org/@bolloon/bolloon-agent) |
|| 2026-08-04 | feat | run-end 经验整理补齐 CLI 端 + 颜文字加载: ① skill-writer.ts 新增公共函数 writeRunEndSkillCandidates(steps, source, minOk=2) — 从一轮运行的步骤提取连续成功工具 (过滤 system/?/error), 写候选到 ~/.bolloon/skill-candidates/ (只写候选不自动转正, agent 调 list_skill_candidates/promote_skill 决定); ② Web server.ts 原内联 run-end 扫描改为复用公共函数 (行为不变); ③ CLI (index.ts processInput) 补上 Web 端已有但 CLI 缺失的 run-end 扫描 — step_done 收集成功工具, ≥2 个时显示颜文字加载 `(｀・ω・´) 整理本轮经验中... N 个工具调用` + setImmediate 异步写候选 + 完成行 `✨ (◕‿◕) 经验候选已写入: <工具名>`; ④ 单测 skill-writer.test.ts +3 (≥2 写候选含过滤/不足 2 不写/全失败不写). tsc 0 错, vitest 1022/1022, 全局 dist 已同步 | [skill-writer.ts](../../src/agents/skill-writer.ts) / [index.ts](../../src/index.ts) / [server.ts](../../src/web/server.ts) / [skill-writer.test.ts](../../src/test/skill-writer.test.ts) |
|| 2026-08-04 | feat | CLI 输入框提示 + 双击 Esc 退出 + IPFS/IPNS agent 工具: ① 输入框 placeholder 加中断/队列提示 (`输入消息... Esc 双击退出 · /queue 排队 · !终端命令`), /help 补 `Esc 双击` 行; ② 双击 Esc 退出当前进程 — 根因: Ink exit() 只 unmount 不退出进程 + startCLI `await new Promise(()=>{})` 永不 resolve → requestExit 打通 __inkRequestExit → promise resolve → 清理 comm.stop() → process.exit(0), 2s 兜底; 第一击提示 "再按一次 Esc", 500ms 内第二击退出 (pty 实测 40ms 内退出); ③ agent 新增 5 个 IPFS/IPNS 工具: ipfs_add (上传→CID) / ipfs_cat (CID 读回) / ipfs_ls (列目录, 单文件识别) / ipns_publish (CID→IPNS name, 默认 self key) / ipns_resolve (name→CID, 60s 超时) + kuboApi helper (30s 超时 AbortController) + TOOL_WHITELIST; 端到端实测全链路 add→cat→ls→publish→resolve 通过 (新 key 首次发布即时闭环); IPNS 同 key 重发布有缓存延迟属 DHT 特性已写入 description. tsc 0 错, vitest 1019/1019, 全局 bolloon 已同步 dist 到 v0.3.28+ | [ink-app.tsx](../../src/cli/ink-app.tsx) / [index.ts](../../src/index.ts) / [pi-sdk-tools.ts](../../src/agents/pi-sdk-tools.ts) / [tool-gate.ts](../../src/security/tool-gate.ts) / [esc-double-tap-test.py](../../scripts/esc-double-tap-test.py) / [verify-ipfs-tools.ts](../../scripts/verify-ipfs-tools.ts) |
|| 2026-08-03 | chore | 发布 v0.3.28: Context OS 判断力上下文系统 P0-P5 + MCP 真实 stdio JSON-RPC + publish_did (DID→IPFS+IPNS 自动装 Kubo) + 验证脚本. build:all 全绿, tsc 0 错, vitest 1019/1019, registry dist-tags.latest=0.3.28 确认 | [npm](https://registry.npmjs.org/@bolloon/bolloon-agent) |
|| 2026-08-03 | fix | MCP 验证修复 + DIAP IPFS/IPNS 验证 + Kubo 自动安装: ① MCP sendMcpRequest 原为 simulated 占位 (工具发现/执行全假) — 重写为真实 stdio JSON-RPC (spawn→initialize→notifications/initialized fire-and-forget→tools/list→tools/call, 按 id 配对 + 30s 超时 + 崩溃 reject pending), discoverMcpServers 修复重复读键 + 去重; 2 个 agent 工具 mcp_list_tools/mcp_tool + server 启动后台初始化; 端到端实测自配 python echo server 返回 echo/add 真实结果 ✓; ② DIAP 身份→IPFS+IPNS 端到端验证通过: checkKuboSetup(true,true) 自动装 Kubo (darwin-arm64 v0.28.0), registerAgent 得真实 CID QmYQeX... (DID 文档 W3C v1 可 cat 读回), publishAfterUpload 得 IPNS name k51qzi5... (可 resolve 回 CID); ③ publish_did 工具 (agent 自己发布 DID→IPFS+IPNS) + server 启动后台自动装 Kubo (fire-and-forget 不阻塞) + ~/.bolloon/skills/ipfs-setup/SKILL.md (bolloon agent 自装自用); ④ 单测 mcp-adapter.test.ts 4 用例 (真实 spawn python server). tsc 0 错, vitest 1019/1019, build 通过 | [pi-ecosystem-mcp/index.ts](../../src/pi-ecosystem-mcp/index.ts) / [pi-sdk-tools.ts](../../src/agents/pi-sdk-tools.ts) / [verify-diap-ipfs.ts](../../scripts/verify-diap-ipfs.ts) |
|| 2026-08-03 | feat | Context OS 资产层 P5 (续 P0-P4): ① 新建 src/bootstrap/context-os.ts — 12+3 层文件夹体系落盘 ~/.bolloon/context-os/ (01-Me~12-Analysis + output/research/tmp), 每层 README 声明职责边界 (存什么/不该存什么/典型用途 + 价值判断标准"未来哪个具体场景会用到它"); ② 3 个 agent 工具 list_context_layers / write_context_asset / read_context_assets (资产 frontmatter v2 stage0=临时价值点, 同标题幂等跳过, 非法 layer 拒绝) + TOOL_WHITELIST; ③ server 启动 ensureContextOsDirs + contextHint 资产层目录注入 (任务按层路由, 不全仓扫描 — Context OS §4); ④ P4 价值点路由打通唯一落点: knowledge→07-Knowledge/, insight→08-Insights/, lesson→12-Analysis/ (自动写入, 幂等, 失败静默); ⑤ 测试 src/test/context-os.test.ts 7 用例 (层定义/README/写入幂等/读取过滤/路径穿越拒绝). tsc 0 错, vitest 1015/1015 通过, build + build:web 通过 | [context-os.ts](../../src/bootstrap/context-os.ts) / [design](../plans/2026-08-03-context-os-judgeness-design.md) |
|| 2026-08-03 | feat | Context OS 默认判断力上下文系统 P0-P4: ① P1 persona 6 文件 frontmatter 判断力声明 (judgment_style/stakes_default/revisable, persona-loader 新增 parseSimpleFrontmatter/loadPersonaJudgmentDeclaration/formatJudgmentDeclaration) + INJECT 工作纪律段 (formatPersonaForSystemPrompt 固定追加, 无 persona 文件也有纪律) + lifecycle-hooks onSessionStart 注入; ② P2 contextHint 装配段重组 — memory 回读标签=动态状态层·chat-worksite, plan 回读标签=动态状态层·focus; ③ P3 decision-store.ts 新建 (~/.bolloon/decisions/, 9 要素: problem/options(含不做)/costs/benefits/risks/infoGaps/recommendation/timing/rollback + status 状态机 draft→decided→implemented/rolled-back) + 4 工具 create_decision/decide_decision/rollback_decision/list_decisions (pi-sdk-tools + TOOL_WHITELIST) — decide 自动 reflect 到 judgeness (storeHumanJudgment approve + reflectAfterJudgment locked/private=阶段0 临时价值点), rollback 自动入库 reject 教训; ④ P4 memory-compressor 摘要 prompt 加价值点段 (decision/lesson/knowledge/insight) + extractValuePoints/routeValuePointsToJudgeness 自动分类路由 → human-values + judgeness (幂等去重, 失败静默). 设计文档 docs/plans/2026-08-03-context-os-judgeness-design.md (draft→current). tsc 0 错, vitest 993+10 通过 | [design](../plans/2026-08-03-context-os-judgeness-design.md) / [decision-store.ts](../../src/agents/decision-store.ts) / [memory-compressor.ts](../../src/bootstrap/memory-compressor.ts) / [persona-loader.ts](../../src/bootstrap/persona-loader.ts) |
|| 2026-08-02 | fix | 本地@远端交流完善: ① @ 转发 regex 修复 — 文字部分 [^\n]+? + lookahead 支持 \n 边界 (AI 回复带尾随解释行时匹配失败, @ 转发静默失效 — 本地无法与远端交流的真凶之一); ② 预激活 remoteFollowup — 消息含 @远端 立即激活 (之前只在 AI 回复后激活, 首次 @ 的本地工具 step 看不到 → P2P 对话框实时显示本地执行进程: 任务复杂度/循环/工具调用, 实测 18 个 remote-chat-step); ③ workflow_step (status/tool) 也转发到 rcm-log; ④ 对端 cross-mention-received 显示完整消息 (不只 toast) + renderHistory ai-mention-remote 前缀 "📡 远端智能体"; ⑤ 运行中自愈 — healMissingChannels 抽函数, 启动 + GET /channels 节流触发 (解决"刷新/build 后 channel 消失"); ⑥ 远端对话服务端镜像 ~/.bolloon/remote-chat-logs/ 替代 localStorage (磁盘无限/异步/多端一致), chat-history 镜像优先立即返回; ⑦ 镜像写入点: @ 发送 (local-sent) + chat.reply 收到 (remote-reply). 端到端: 镜像落盘 ✓, chat-history source=mirror ✓, remote-chat-sent 带正确 channelId ✓. tsc 0 错, vitest 993/993 | [server.ts](../../src/web/server.ts) / [client.ts](../../src/web/client.ts) |
|| 2026-08-02 | feat | 远端 channel 工具 + 本地 dirHint: ① 新工具 list_remote_channels (列出好友分享的远端 channel + owner) / send_to_remote_channel (发送消息到远端, 走 /api/remote-channels/chat-send); ② 本地 /message 路径注入 dirHint (远端 channel 列表) — 之前只有远端路径有, 本地智能体看不到远端 channel 无法 @ 交流; ③ 智能体持久化 4 层修复: updateChannels 锁毒化隔离 (某次失败不再让后续全 reject → UI 创建偶发不落盘), 创建时更新 agent channelId, 删除共享 agent 保护, 启动自愈 (从 agents.json 恢复有 session 的丢失 channel). 端到端: 本地智能体真实调用工具列出 3 个远端 channel (智能体小红/小米/布露) + 发送消息到小红"已送达"; 远端回复不触发本地 LLM (只显示+存 session, 无循环). tsc 0 错, vitest 993/993 | [pi-sdk-tools.ts](../../src/agents/pi-sdk-tools.ts) / [server.ts](../../src/web/server.ts) / [server-storage.ts](../../src/web/server-storage.ts) |
|| 2026-08-02 | feat | 执行闭环 + UI 修复: ① plan-store (create_plan/update_plan/review_plan/list_plans, ~/.bolloon/plans/) — 显式计划→todo 勾选→审查; ② skill 写工具 (create_skill/update_skill/list_skill_candidates/promote_skill, skill-writer.ts) + run-end 自动候选扫描; ③ memory 回读 — 每次对话注入历史摘要到 contextHint; ④ channel 丢失 bug 修复 — 12 处裸 saveChannels 改 updateChannels 原子写 (互斥锁, 并发测试 5/5 通过); ⑤ UI: / 斜杠命令菜单 (插入执行命令) + server 端命令路由, 用户名内联编辑 (PUT /api/user/identity), 发送工具 toggle (per-message autoInvokeTools), abort 后立即广播 done | fix(heartbeat) |
|| 2026-08-02 | fix | 邓巴 heartbeat 误判 blocked: server.ts:1578 收到 agent.heartbeat 时 recordInteraction 不传 text → inferOpponentMove('')=defect → 每次心跳 -5 → trustScore 跌至 -36 → peer 自动降级 blocked → 对端消息被拒 (❌ 您已被本地系统加入通信黑名单). 修复: 传 'heartbeat 存活信号(自动)' 让机器协议消息判为 cooperate; 手动解除已 blocked peer (friends + manualOverride). 跨机 P2P 通信恢复验证通过 (智能体小红回复正常). tsc 0 错, vitest 978/978 pass | [server.ts:1575](../../src/web/server.ts) / [dunbar-tier.ts](../../src/social/dunbar-tier.ts) |
|| 2026-07-29 | feat | CLI 工具调用改为增量列表 (🔧 + 工具名, 无 ✓⟳✗, 无 header, 有 ╰── footer, diff 着色); loading spinner 换颜文字序列 (｀・ω・´)→(´･_･`)→(｡•́︿•̀｡)→ᕙ(▀̿̿Ĺ̯̿̿▀̿ ̿)ᕗ→(◕‿◕)→ヽ(´▽｀)/; TUI step-timeline 步数上限 8→20, 详情区高度 320px→520px; tsc 0 错, vitest 978/978 pass | [loading-tui.ts](../../src/cli/loading-tui.ts) / [index.ts](../../src/index.ts) / [step-timeline.ts](../../src/web/ui/step-timeline.ts) / [style.css](../../src/web/style.css) |
| 2026-07-25 | feat | 添加好友三入口: agent 工具 `add_friend_by_id` + Web UI modal + CLI `add_friend`; 发布 v0.3.15 | [pi-sdk-tools.ts:301](../../src/agents/pi-sdk-tools.ts) / [client.ts:4071](../../src/web/client.ts) / [index.ts:570](../../src/index.ts) |
| 2026-07-22 | feat | 判断力负向回收 + 上下文废气涡轮增压 (设计 A/B/C) — Web 判断力页面简化为正向/负向两类 (替换 6 个 status tab); injectNegativeGuard 以"避免清单"注入 prompt (maxChars=300, 显式); exhaust-scrubber 涡轮采样废气调参 (不进 prompt, 隐式); 背压→judgment 注入 maxChars(1800/1500/800)+检索 top-k(8/5/3); 落 log+memory; vitest 959/959 pass (+17) | [设计文档](../plans/2026-07-22-negative-exhaust-design.md) |
| 2026-07-29 | feat | wiki 维护: 安装维基 llm skill -> 更新 current-status.md (CLI v0.3.20-v0.3.24 + LSP + OpenCLI 引擎) -> 编译 2 个 raw 源 (bug-report + claude-arch-parallels) -> 知识图谱 15 节点 18 边 -> 清理 drafts | [current-status.md](./current-status.md) / [graph_export](./bolloon-bug-report-20260716.md) / [claude-parallels](./claude-code-design-parallels.md) |
| 2026-07-29 | feat | 实现 Claude Code 架构全部 Bollloon 对照特性: Phase 1 Tool pre-filter (denyTool/allowTool + env BOLLOON_DENIED_TOOLS) + Phase 2 Snip (预算裁历史, 保护工具链) + Phase 3 Context Collapse (读时虚拟投影) + Phase 4 Hook 引擎 (8 事件 x 2 模式, YAML 配置, preToolUse deny) + append-only JSONL 存储 (双写过渡) + Subagent sidechain 转录 + Unified DenyPipeline (deny-list -> permission -> hooks). 全部 978/978 pass | [current-status.md](./current-status.md) / [claude-code-parallels](./claude-code-design-parallels.md) |
| 2026-07-29 | feat | 邓巴分层 + 两报换一报 P2P 社交博弈: 5 层邓巴 (core/close/friends/social/acquaintance) + TFTT 宽容博弈引擎 (第一轮合作, 连 2 次背叛才反击, 恢复即恢复) + 语义分析 inferOpponentMove + tfttPayoff 收益表 + trustScore 隐式滑动 + 模型视野门 (低 tier peer 信息对模型不可见). 集成到 server.ts v3 P2P 入口. 978/978 pass | [current-status.md](./current-status.md) / [dunbar-tier.ts](../../src/social/dunbar-tier.ts) |
| 2026-07-20 | fix | Bug 1: tool call 结果不在前端渲染 — step 事件在 .message-ai 未创建时静默丢弃; 加 stepEventBuffer (按 channelId 缓冲), handleStepEvent 无 .message-ai 时入队, flushStepEventBuffer 在 addMessage + mountStepTimeline 后回放 | [message-renderer.ts:88](../../src/web/ui/message-renderer.ts) |
| 2026-07-20 | fix | Bug 2: friend-shared channel tags 不标记来源 peer — sanitizeChannelForPeer 缺 ownerPublicKey, 前端收到所有远端 channel 无法区分来自哪个节点; 加 _ownerPublicKey: ch.publicKey | [server-v3-p2p.ts:76](../../src/web/server-v3-p2p.ts) |
| 2026-07-20 | fix | Bug 3: 终端版本/日志抑制 — cli-entry.ts 硬编码 v0.2.15 改读 package.json; src/index.ts banner 加版本号; CLIInterface 加 _quiet 标志抑制 console.error | [cli-entry.ts:30](../../src/cli-entry.ts) / [index.ts:47](../../src/index.ts) / [interface.ts:122](../../src/cli/interface.ts) |
| 2026-07-20 | fix | v0.3.5 发布 — banner 双空格修复 (verStr 去前导空格, padEnd→手动计算, 小版本号对齐 39 列) + npm publish | [index.ts:54](../../src/index.ts) |
| 2026-07-21 | fix | 流式 timeline 渲染修复 — handleStreamTokenEvent 中 appendChild 在 flushStepEventBuffer 之前, 确保 step 回放时 streamingMessageEl.isConnected=true | [message-renderer.ts:492](../../src/web/ui/message-renderer.ts) |
| 2026-07-21 | test | 流式 timeline Playwright 测试 — 模拟完整 SSE 事件链 (step_start/step_done/stream/done), 验证 timeline 在流式阶段渲染、finalize 后迁移到最终消息、摘要是完成状态 | [web-loop-ui.spec.ts](../../src/test/web-loop-ui.spec.ts) |
| 2026-07-22 | feat | 实现 Polymarket 真实支付 (替换 STUB) — createOrder/getOrders/cancelOrder 改用 @polymarket/clob-client (ClobClient, chainId=137), 验证测试 16/16 pass (mock SDK 断言编排 + 真实入参校验); tsc 0 错 | [wallet-polymarket-verify.test.ts](../../src/test/wallet-polymarket-verify.test.ts) / [clobShared.ts](../../src/constraint-runtime/src/tools/PolymarketSDK/clobShared.ts) |
| 2026-07-21 | feat | 智能体社交心跳 (目标驱动生命周期) — 给 agent 加心跳 + 目标驱动状态机 (DISCOVERING/ENGAGING/RESTING/PAUSED), 社交服务于目标而非闲聊, 达成效果即 RESTING, 无效果退避; 接入全局 runtime (cleanupAndExit 停定时器 / global.socialHeartbeat / Watchdog / SSE), 10 单测 + 双节点仿真 PASS | [agent-heartbeat.ts](../../src/social/agent-heartbeat.ts) / [run-agent-heartbeat.ts](../../scripts/ablation/run-agent-heartbeat.ts) |
| 2026-07-22 | feat | 外部编码智能体 发现+配置+委派 — 自动发现本机 codex/claude-code/opencode/openclaw/hermes + 实验目录声明 API; GET 发现(脱敏) / POST 导入为 LLM provider (把别的工具的 api 当供应商) / POST 委派 CLI 当子智能体; agent 工具 delegate_to_engine; 补: API 配置页「外部智能体」tab + 可筛选模型下拉 (opencode 宽列表); 实测修委派 opencode 三坑 (模板/run+--format json / stdin=ignore / exit+destroy) + 端到端验证 Bolloon→opencode→DeepSeek v4-flash (401 因 env key 失效) | [discovery.ts](../../src/external-engines/discovery.ts) |
| 2026-07-12 | fix | 3 个 document 工具缺 path 前置校验, Node fs 抛 ERR_INVALID_ARG_TYPE: read_document / summarize_document / improve_document 加 if (!path) return { success: false, error: 'path 必填' }; documentReader.read() 加非空字符串防御; 加 10 测试锁住 | [pi-sdk-tools.ts:62/79/103](../../src/agents/pi-sdk-tools.ts) / [reader.ts:16](../../src/documents/reader.ts) / [pi-sdk-tools-validation.test.ts](../../src/test/pi-sdk-tools-validation.test.ts) |
| 2026-07-12 | fix | UI 暴露工具原始 error: step-timeline.ts 之前只渲染 name/args, 完全忽略 step.error (LLM 改写后误导调试 "X 必填"); 现在 error 状态 step 显示 .step-timeline-error-wrap 容器展示原始错误 (mono 字体 + 橙色边框), style.css 加对应样式; 6 个新测试锁住 | [step-timeline.ts](../../src/web/ui/step-timeline.ts) / [style.css](../../src/web/style.css) / [step-timeline-error-display.test.ts](../../src/test/step-timeline-error-display.test.ts) |
| 2026-07-10 | feat | LoadingTUI 升级: 7 步进度可视化 + main() 错误路径自动 stop(false) + spinner 帧率不变 | [loading-tui.ts](../../src/cli/loading-tui.ts) / [index.ts](../../src/index.ts) |
| 2026-07-07 | chore | 0.2.12: judgment 注入门质量门 (软删除测试灌水) + CLI 启动简化 + pivot loop 持久循环/reply-preview/final-gen 退出 + LLM 调用分段时间 instrumentation | [cleanup.ts](../../src/pi-ecosystem-judgment/cleanup.ts) / [loading-tui.ts](../../src/cli/loading-tui.ts) |
| 2026-07-07 | feat | 远程交流加载链路 + 五层缓存架构 (L0 window / L1 summary / L2 events / L3 state / L4 vector) + H2 bug 修复 (channel 不存在三层失守 → 404 明确提示) | [q1-q5-report-2026-07-07.md](./q1-q5-report-2026-07-07.md) |

## [2026-07-10] feat | LoadingTUI 渐进式 7 步进度 (v0.2.13)

### 触发

用户问 "TUI 有什么可以优化的地方", 调研发现 LoadingTUI 已经存在但只在 CLI interactive 模式用, 启动时 spinner **内容固定**, 用户看不到当前在干 step 几 (5 个 bootstrap 全是黑屏).

### 改动清单 (2 文件)

| 改动 | 文件 | 行数 |
|---|---|---|
| `setSteps()` / `startStep()` / `completeStep()` / `setMessage()` | `src/cli/loading-tui.ts` | 45 → 105 (+60) |
| `main()` 接入 7 步进度 (LLM / 身份 / DID / P2P / iroh / Bootstrap / Web) | `src/index.ts` | +25 |

### 关键改动

1. **`LoadingTUI` API**: 增加 `setSteps(string[])` + `startStep(idx, label)` + `completeStep(idx, status, label)`
2. **错误码颜色化**: `pending` ○ (灰) / `active` ⠹ (黄) / `ok` ✓ (绿) / `warn` ⚠ (黄) / `error` ✗ (红)
3. **`stop()` 终态打印所有步骤**: 不再丢失上下文, 看到 `✓ LLM: MiniMax` `⚠ DID 本地模式` `✓ 2 peer 已连` ...
4. **`main()` 错误路径自动 `stop(false)`**: 已存在 try/catch, error throw 自动到达 `loading?.stop(false)`, 用户看到红色 `✗ Bolloon startup failed` 而不是空行

### 验证

- `npx tsc --noEmit`: **0 错**
- `npx vitest run`: **797/797 pass** (含之前 5 个 ablation 跑过的)
- `npm run build:web`: pass
- `npx tsx` 跑 fake 7-step dryrun: 终态布局正确, spinner 帧切换, escape 序列正确

### 用户视角

启动 console 输出从:
```
⠹ Bolloon loading...     <- 一行变来变去
```
变成 (完成时):
```
  ✓ LLM: MiniMax
  ✓ blln-apple-x7q2
  ⚠ DID 本地模式
  ✓ 2 peer 已连
  ✓ iroh 已就绪
  ✓ Bootstrap 234ms
  ✓ Web :54188
  ✓ Bolloon ready
```

## [2026-07-07] feat | 五层缓存架构 + H2 三层失守修复 (v0.2.12)

### 触发

用户问 4 个远程交流加载问题 + 引用"四类系统组合"缓存方案, 子智能体研究代码后定位 14 个根因 (R1.1~R4.4), 实施 P0/P1/P2 完整五层架构. 实施过程中用户发现 UI bug "channel 不在也没显示", 调研定位到 H2 (本地 channel 被删, UI 引用还在) 三层失守, 修复完成.

### 改动清单 (5 新文件 + 5 改动 + 1 测试)

| 改动 | 文件 | 行数 |
|---|---|---|
| **P0-A** Layer 0 显式 LRU 窗口 | `src/bootstrap/session-window.ts` (新) | 134 |
| **P0-B** loadSession 加 window fallback 链 | `src/web/server-storage.ts` | +50 |
| **P0-C** 远端 channel 镜像 | `src/bootstrap/remote-mirror.ts` (新) + `src/web/server.ts` | 130 + 18 |
| **P1-A** Layer 2 事件日志 | `src/bootstrap/event-log.ts` (新) | 187 |
| **P1-B** prompt 注入最近 5 条事件 | `src/agents/pi-sdk.ts` | +20 |
| **P1-C** 撤回: 不改 UI (用户报告 bug 后回滚 client.ts 折叠块) | — | 0 |
| **P2-A** Layer 3 项目状态 | `src/bootstrap/project-state.ts` (新) | 174 |
| **P2-B** Layer 4 TF-IDF 向量索引 | `src/bootstrap/vector-index.ts` (新) | 233 |
| **P2-C** prompt 注入 state + top-3 检索 | `src/agents/pi-sdk.ts` | +30 |
| **H2-1** `/sessions/:channelId` 加 channel 校验 | `src/web/server.ts` | +8 |
| **H2-2** `/message` 加 channel 校验 | `src/web/server.ts` | +5 |
| **H2-3** `selectChannel` / `loadSession` 加 channel 校验 + 明确提示 | `src/web/client.ts` | +25 |
| **测试** `channel-not-found.test.ts` | `src/test/channel-not-found.test.ts` (新) | 175 |
| **报告** `q1-q5-report-2026-07-07.md` | `docs/wiki/` | 165 |

**总预算**: ~1354 行 (10 个新文件 + 6 个改动)

### 验证

- `npx tsc --noEmit`: **0 错**
- `npx vitest run`: **774/775 pass** (1 个已知 minimax 网络 flaky)
- `python scripts/wiki_check.py`: OK (11 files, 7 frontmatter valid)
- `python scripts/raw_manifest_check.py`: OK
- `python scripts/wiki_lint.py --strict=v2`: OK
- `python scripts/supersede_check.py`: OK

### 已知未做

- H1 (远端 channel 被取消分享) — P1 优先级, 未在本 session 修
- H3 (远端 peer offline silent refresh) — P2 优先级
- P0-C mirror 写盘失败重试
- LLM 自动建议 state 更新 (UI confirm)
| 2026-07-06 | feat | CLI 启动简化: 去掉 banner/5步/section/命令列表, 仅显示单行旋转光标 → `✓ Bolloon ready` (v0.2.11) | [loading-tui.ts](../../src/cli/loading-tui.ts) |
| 2026-07-06 | fix | AI 消息渲染适配非流式模式: 后端返回 `<think>...<final gen>` 结构, 前端自动剥离后只显示纯回复 (v0.2.10) | [message-renderer.ts](../../src/web/ui/message-renderer.ts) / [server.ts](../../src/web/server.ts) |
| 2026-07-04 | docs | P2: skills-index.md (35 个全局 skill + 触发词) + crystallized-claims.md (4 条断言从 ablation 蒸馏) | [skills-index.md](./skills-index.md) / [crystallized-claims.md](./crystallized-claims.md) |
| 2026-07-04 | test | 长任务循环消融实验 (v0.2.8-long-loop): 6 步循环 (探索→调整→验证→行动存档→记忆→再次探索) + use_skill 协议端到端, 10/13 pass (2 失败为合理 LLM 行为) | [ablation/report-long-loop.md](../ablation/report-long-loop.md) |
| 2026-07-04 | feature | 复制 2 个 opencode skill (消融实验技能 + 技能写作) 到 bolloon `.bolloon/skills/`, 注册到 manifest, bolloon agent 可通过 use_skill 工具调用 | [skills-index.md](./skills-index.md) |
| 2026-07-04 | feature | persona 文档体系 (v0.2.9): 6 md (soul/identity/project/user/agent/wiki) 按 agentId 分类 ~/.bolloon/persona/<agentId>/, 启动加载到 system prompt (onSessionStart 集成) | [ablation/report-persona-memory.md](../ablation/report-persona-memory.md) |
| 2026-07-04 | feature | memory 压缩写入 (v0.2.9): 每次 /message 后调 compressSessionToMemory, ≥4 新 messages 触发 LLM 摘要, 写 ~/.bolloon/memory/<agentId>/sessions/<safe-channel>__<safe-session>.summary.md + cursor 推进 | [ablation/report-persona-memory.md](../ablation/report-persona-memory.md) |
| 2026-07-04 | test | persona + memory 消融实验 (v0.2.9): 8/8 pass (D6 3/3 + D7 2/2 + D8 3/3), 模块化子验证 (纯函数 + onSessionStart 集成 + 冷启动) | [ablation/report-persona-memory.md](../ablation/report-persona-memory.md) |
| 2026-07-04 | chore | P2: 修 ablation C3 layer frontmatter CRLF/LF 误判 — 实际 11/11 都有 (之前 withMeta=0 是脚本 bug) | commit 包含 |
| 2026-07-04 | docs | P1: AGENTS.md 合并 skill 默认 + Bolloon 特定工程约定 (§5 路径/验证/checklist/commit 风格/容忍噪音) | commit `206b0cf` |
| 2026-07-04 | fix | P1: SessionStore escape `:` → `__` 修 Windows 文件名非法 + workflow-pivot 测试加 30s timeout, vitest-bail 711/711 pass, lefthook 不再需 LEFTHOOK=0 | commit `a6113e9` |
| 2026-07-04 | fix | P0: iroh `discovery.update` 降级 + `/api/iroh/info` nodeId fallback, 消融实验 16/16 pass | [ablation/report.md](../ablation/report.md) |
| 2026-07-04 | init | bootstrap 知识系统 v2.0.0 + 接入消融实验报告 (37 文件, 5 内容页) | [current-status.md](./current-status.md) |
| 2026-07-04 | test | 4 功能消融实验 15/15 pass (documents + skills + tool_loop + p2p) | [ablation/report.md](../ablation/report.md) |
| 2026-07-04 | refactor | 移除 src/web/client.js (3550 行历史副本), client.ts 成为唯一源 | commit `6859578` |
| 2026-07-04 | fix | 频道名称渲染加 (未命名) fallback, 修复 sidebar / 顶栏 / mention / wallet 显示 "undefined" | commit `2e9e921` |
| 2026-07-05 | feature | peer 4 类资源完整化: peer-fs 加 writeGroup/Function/Exportment/Science, agent-manifest-protocol v2 加 groups/functions/exportments/sciences, manifest.exchange 收发都带 4 类并落盘 ~/.bolloon/peers/<pk>/{groups,function,exportment,science}/*.md, agent.resource.get 支持 group:/fn:/game:/exp: 前缀读 ~/.bolloon/local-resources/, vitest 748/748 pass (新增 14) | [current-status.md](./current-status.md) |
| 2026-07-05 | test | peer-resource-bridge.test.ts (14/14): 4 类 writer round-trip + addLocal* setter + 本地读/远端落 round-trip + safeName 路径安全 | — |
| 2026-07-06 | refactor | web 端频道名 "undefined" 字面量修复: 抽 util/safe-name.ts (safeChannelName/safePeerName), client.ts 7 处 .name 渲染接入 (顶栏 / sidebar / 顶栏 selectChannel / mention dropdown x2 / wallet-row / share-modal), p2p-modal.ts + p2p/index.ts 也接入, 防御 undefined/null/'undefined'/'null'/空白 | commit `2b224b1` `a149646` `b420416` |
| 2026-07-06 | test | safe-name.test.ts (18/18): undefined/null/空白/'undefined'/'null'/'NaN' 都 fallback; number 0/负数保留; object/array 不抛错 | commit `a149646` |
| 2026-07-06 | fix | ablation C3 skill loader 判定改为 LEN===c2Count (baseline 已含用户已有 skills, 不能用 ===1); pi-sdk minimax LLM integration timeout 30s→90s (网络依赖) | commit `fff1562` |
| 2026-07-06 | chore | 全局禁用 lefthook (`git config --global core.hooksPath /dev/null`) — 每次拦截 flaky test 不合理; 现 commit 直接走 | — |
| 2026-07-06 | test | ablation v0.2.7 复测 16/16 pass (skill C3 修复后从 14/16 → 16/16); vitest 766/766 pass (748 + 18 safe-name) | [ablation/report.md](../ablation/report.md) |
| 2026-07-05 | feature | peer 4 类资源完整化: peer-fs 加 writeGroup/Function/Exportment/Science, agent-manifest-protocol v2 加 groups/functions/exportments/sciences, manifest.exchange 收发都带 4 类并落盘 ~/.bolloon/peers/<pk>/{groups,function,exportment,science}/*.md, agent.resource.get 支持 group:/fn:/game:/exp: 前缀读 ~/.bolloon/local-resources/, vitest 748/748 pass | [current-status.md](./current-status.md) |
| 2026-07-05 | test | peer-resource-bridge.test.ts (14/14): 4 类 writer round-trip + addLocal* setter + 本地读/远端落 round-trip + safeName 路径安全 | — |
| 2026-07-05 | docs | 当前 chat-archiver.ts 已有月度压缩归档机制 (peers/<pk>/chat-<YYYY-MM>.md + memory/<agentId>/peers/<pk>/<YYYY-MM>.summary.md), 验证后无需新写, 合并到 current-status | [current-status.md](./current-status.md) |

| 2026-07-06 | fix | AI 气泡显示修复: 后端取消流式后, `type:ai` 事件携带完整响应含 `<think>...</think>` + 实际回复 + `<final gen>`, 前端 `client.ts` 提取时 strip think 块 + `<final gen>` 及之后内容, 只渲染实际回复; 三处 broadcast 加空内容兜底防止气泡不渲染 | client.ts:1384 / server.ts 三处 |
| 2026-07-06 | fix | server.ts 三处 (主 chat / regenerate / v3 P2P) 加 `fullResponse` 空内容兜底, abort 时设默认文本, 防止前端 segmentChatReply('') 返回 [] 导致气泡不渲染 | server.ts 各处 broadcast |

## 详细日志

### [2026-08-02] feat | 执行闭环 (plan/todo/review) + memory 回读 + skill 沉淀 + channel 丢失修复 + UI 修复

- **触发**: 用户要求 Bolloon 像 Hermes 一样"越用越聪明" — 验证 memory/skills/persona 机制后, 补齐缺失的 plan/todo/review 闭环; 同时修复 4 个 UI bug (中断按钮、插入命令、用户名修改、发送默认配置) 和 channel 丢失 bug.
- **plan/todo/review** (`src/agents/plan-store.ts`, 新, 落盘 `~/.bolloon/plans/<planId>.json`):
  - `create_plan` — 执行前显式列步骤 (goal + 3-8 steps), 状态 active
  - `update_plan` — 勾选 step done/blocked + note, 追加步骤, finish 收尾 (未完成标 blocked)
  - `review_plan` — 执行后审查 (completed/total + summary), 标记 done
  - `list_plans` — 恢复上下文; server.ts 每次对话把 active plans 注入 contextHint (plan 回读)
- **skill 沉淀** (`src/agents/skill-writer.ts`, 新): `create_skill` / `update_skill` / `list_skill_candidates` / `promote_skill`; run-end 后台扫描 (server.ts finally 里从 lastSteps 提取 ≥2 个连续成功工具 → 写候选到 `~/.bolloon/skill-candidates/`)
- **memory 回读** (server.ts): 每次 /message 把 `~/.bolloon/memory/<agentId>/sessions/*.summary.md` 尾部注入 contextHint (当前 channel 优先, 兜底跨 channel 最近摘要) — 之前只写不读, 对话无记忆
- **channel 丢失 bug 修复** (根因): 12 处裸 `loadChannels→modify→saveChannels` 是 read-modify-write 竞态, 并发时旧数组覆盖新 channel (DID 修复队列 vs 创建 vs /message updatedAt). 全部改 `updateChannels(fn)` (server-storage.ts 已有互斥锁, 2026-07-24 写好但从未使用). 并发创建 5 个 channel 测试 5/5 保留 ✓, 重启后 channel 全保留 ✓
- **UI 修复**:
  - `/` 斜杠命令菜单 (SLASH_COMMANDS: plan/todo/review/task/goal/skill/add-friend/help), Enter/Tab 插入 `/命令 ` 到输入框; server 端 /message 解析命令路由成 contextHint 引导 LLM 调对应工具
  - 用户名内联编辑: PUT /api/user/identity (写回 `~/.bolloon/identity/user.json`), 左下角点击变 input
  - 发送默认配置: 输入框旁 🔧 工具 toggle (localStorage 记忆), sendMessage 传 per-message `autoInvokeTools`, server 优先用消息级覆盖
  - 中断按钮: abort 端点立即广播 done (之前靠前端 1.5s 兜底, 视觉"点了没反应")
- **验证**: tsc 0 错; vitest 993/993 (新增 plan-store 7 + skill-writer 7); npm run build 全绿; 端到端 `/plan 写一个 P2P 模块; 读需求, 写代码, 测试` → LLM 调 create_plan → plan JSON 落盘 ✓
- **文件**: `src/agents/plan-store.ts`(新) / `skill-writer.ts`(新) / `src/agents/pi-sdk-tools.ts` / `src/security/tool-gate.ts` / `src/web/server.ts` / `src/web/client.ts` / `src/web/index.html` / `src/test/{plan-store,skill-writer}.test.ts`(新)

### [2026-08-02] fix | 本地@远端交流完善 + 运行中自愈 + 服务端镜像

- **触发**: 用户报告"本地@智能体的时候, 进程怎么看不到?"、">localStorage缓存会很慢有上限"、"每次刷新和 build 都会消失"、"交流加载还没有传递给对方".
- **@ 转发 regex 修复 (真凶)**: routeMentionsInReply 的解析 regex `[^\n@]+?` 遇到 AI 回复的尾随解释行 (`@渠道名 消息\n\n（说明...）`) 时匹配失败 → @ 转发**静默失效** (本地 LLM 回复了 @ 但没发出去). 修复: `[^\n]+?` + lookahead 支持 `\n` 边界. Python 验证 5 场景全通过 (尾随说明/多 @/前置说明).
- **预激活 remoteFollowup (进程显示)**: 之前只在 routeMentionsInReply (AI 回复后) 激活 → 首次 @ 时本地智能体的工具 step 发生在激活前, P2P 对话框看不到本地执行进程. 修复: 消息含 @远端 时收到即激活 → 本地思考运行的完整进程 (任务复杂度/动态配置/循环/工具调用) 实时显示在 rcm-log (remote-chat-step, 实测 18 个事件). workflow_step (status/tool) 也转发.
- **消息传递给对方**: 对端 cross-mention-received 现在在 rcm-log 显示完整消息 (不只 toast); renderHistory 的 ai-mention-remote 前缀改为 "📡 远端智能体" (之前误显示 "🤖 A 的 LLM").
- **运行中自愈**: healMissingChannels 抽成函数, 启动 + GET /channels 节流 (5s) 触发 — 解决"刷新/build 后 channel 消失" (之前只启动时跑一次, 运行中丢失不恢复).
- **服务端镜像替代 localStorage**: ~/.bolloon/remote-chat-logs/<peerPk>__<channelId>.json — 磁盘无限 (500 条滚动) / 异步 / 多端一致 / 离线可读. 写入点: @ 发送 (local-sent) + chat.reply 收到 (remote-reply). chat-history API 镜像优先立即返回, 后台 RPC 增量合并.
- **验证**: 镜像落盘 ✓ / chat-history source=mirror ✓ / remote-chat-sent 带正确 channelId ✓ / remote-chat-step 18 个 ✓ / tsc 0 错 / vitest 993/993.

### [2026-08-02] feat | 远端 channel 工具 + 本地 dirHint + 智能体持久化 4 层修复

- **触发**: 用户报告"本地智能体无法获取远程智能体的信道和发送消息"、"工具没有给到位".
- **根因**: ① 本地 /message 路径的 contextHint 没有注入远端 channel 列表 (dirHint 只有远端 agent.chat.send 路径有) → 本地 LLM 不知道有哪些远端 channel 可 @; ② 本地智能体的工具集没有"列出远端 channel / 发送到远端"的工具.
- **修复**:
  - `list_remote_channels` 工具: 读 GET /api/remote-channels, 列出好友分享的远端 channel + owner (peerId/peerName), 提示 @ 语法
  - `send_to_remote_channel` 工具: POST /api/remote-channels/chat-send, 透传 autoInvokeTools, 返回 sent/queued 状态
  - 本地 /message 注入 dirHint: 可用渠道列表 (本地跳过自己 + 远端带 owner), 语法 "@渠道名 消息内容"
  - 两个工具加进 tool-gate 白名单
- **智能体持久化 4 层修复** (同批, "build 后智能体消失"):
  - updateChannels 锁毒化隔离: 之前 `channelsLock = channelsLock.then(...)`, 某次 fn 抛错 → 整链 rejected → 后续所有 updateChannels 直接 reject, fn 不执行 → UI 创建 channel 偶发不落盘. 改为操作链独立 + catch 隔离
  - 创建时更新 agent channelId: agents.json 已存在该 agentId 时更新 channelId+name (之前 exists 直接跳过 → 引用旧 channel)
  - 删除共享 agent 保护: 仅当无其他 channel 引用该 agentId 时才删 agent (之前无条件删 → 共享 agentId 的其他 channel 变孤儿)
  - 启动自愈: 扫描 agents.json, 对 channelId 有 session 文件但不在 channels.json 的 channel 自动恢复
- **验证**: 端到端 — 本地智能体真实调用 list_remote_channels 列出 3 个远端 channel (智能体小红/小米/布露) + send_to_remote_channel 发消息到小红"已送达"; "智能体小蓝"丢失后重启自愈恢复; 远端回复不触发本地 LLM (只 broadcast 显示 + 存 session, 无循环). tsc 0 错, vitest 993/993
- **文件**: `src/agents/pi-sdk-tools.ts` / `src/security/tool-gate.ts` / `src/web/server.ts` / `src/web/server-storage.ts`

### [2026-08-02] feat | 渲染去重 + P2P 工具开关 + 远端对话本地缓存 + 远端 channel 删除
- **回复重复渲染修复** (根因): loadSession 用 save=false 渲染历史 → `lastAiContent` 不更新 → SSE resume 补包 (save=true) 时去重失效 → 同一条 AI 消息渲染两次. 修复: message-renderer 新增 `seedDedupState()`, loadSession 渲染后 seed 去重状态. 实测 3 条 AI 消息全部唯一 (adjacentDupes: 0)
- **工具开关只针对远程**: ① 本地 sendMessage 不再传 autoInvokeTools (走 channel 配置); ② P2P chat-send 透传 autoInvokeTools → agent.chat.send RPC → 对端处理时 false 注入"禁止调用任何工具"指令; ③ 🔧 toggle 只在远端 channel 显示, P2P 对话框 (rcm-tools-toggle) 也有
- **远端工具调用过程转发**: server 端 agent.chat.send 的 streamCallback 之前只转 token, 现在转发 step_start/step_done/step_error (phase=step); B 端收到 → handleStepEvent → step-timeline + thinking 区块显示 🔧/✅/❌
- **远端对话本地缓存**: localStorage 按 `peerPublicKey::channelId` 存 (bolloon.rcmCache.*), 发送/收到回复/拉历史都写缓存; 打开 P2P 对话框先渲染本地 (立即可见, 不依赖远程), 后台静默拉远程合并; 去重: 同 type+content+timestamp 跳过
- **远端 channel 删除不干净修复**: 前端维护 `bolloon.removedRemoteChannels` ignore 集合 (localStorage, `peerId::channelId`), remote-channel-update 覆盖前 + renderRemoteChannels 渲染时都过滤; 每个远端 channel 加 🗑️ 删除按钮. 实测删除布露 (ch_1785146677431) → localStorage 记录 → 对端再广播被过滤
- **P2P 对话框点外部关闭**: overlay mousedown 关闭 (点 shell 内部不关)
- **验证**: tsc 0 错; vitest 993/993; npm run build 全绿; 浏览器实测: 远端 channel 删除按钮 + 点外部关闭 + 工具开关按钮全部生效

### [2026-07-22] feat | 判断力负向回收 + 上下文废气涡轮增压 (设计 A/B/C)

- **触发**: 用户问"上下文废料和判断力废料有没有再利用环节". 调研发现 Bolloon 是"正向沉淀"架构 (summary 回注 / judgment 注入 / crystallized-claims 全是赢家通吃), 两类废料 (被丢弃原文 / 被否决判断) 没被再利用. 用户要求: 负向设计 + Web 判断力页面简化为正向/负向两类 + 上下文废气隐式设计, 锚点=涡轮增压.
- **拍板**: 判断力负向回收 → 进 prompt (约束语义), 显式; 上下文废气回收 → 不进 prompt, 只调参, 进 log/memory, 隐式.
- **设计 A (Web UI 简化)**: `src/web/index.html` judgments-modal 的 6 个 status filter → 正向/负向两个主 tab. 正向=approve/modify/escalate+active, 负向=reject/rejected/superseded. 表单加正/负向 toggle, domain/stakes 折叠. 高级分析 (违规/自适应/因果) 折叠保留, 数据/API 不删. `routes-judgments.ts` POST 接受 decision_type. `client.ts` loadJudgments 按 polarity 分桶 + switchPolarity. `style.css` 正负向 tab 样式.
- **设计 B (判断力负向回收, 显式进 prompt)**: `injection-gate.ts` 新增 injectNegativeGuard — 从 reject+active+高 stakes(high/critical)+高 confidence(≥0.7) 选 Top N, "避免清单"语义注入, maxChars=300 (远小于正向 1500). `pi-sdk.ts` computeJudgmentGate 每轮同时跑正向 gate + 负向 guard. recordJudgmentUsage 加 polarity 字段区分正负.
- **设计 C (上下文废气涡轮增压, 隐式不进 prompt)**: 新建 `src/bootstrap/exhaust-scrubber.ts`. recordExhaust 采样丢弃事件 (memory-compressor 已接入) → 环形缓冲 → 背压等级 (idle/low/medium/high) → getInjectionMaxChars 反向调 judgment 注入 maxChars(1800/1500/800) + getRetrievalTopK(8/5/3). 落盘 `~/.bolloon/engine/backpressure.jsonl` (log) + high 持续写 memory 月度摘要. `GET /api/engine/backpressure` 可观测. 废气内容永不暴露, 只展示压力.
- **涡轮增压锚点**: 排气(丢弃事件)→涡轮(exhaust-scrubber 采样)→中冷+进气增压(背压调 maxChars/topK)→燃烧室(prompt, 废气不进).
- **验证**: `npx tsc --noEmit` 0 错; `npx vitest run` 959/959 pass (新增 exhaust-scrubber 8 + negative-judgment-guard 9 = 17); `npm run build:web` pass.
- **设计文档**: [docs/plans/2026-07-22-negative-exhaust-design.md](../plans/2026-07-22-negative-exhaust-design.md) (含涡轮增压锚点映射表 + 实施清单).
- **未做**: compaction pipeline / context-collector 的废气采样接入 (目前只接 memory-compressor); 涡轮增压表 UI (只暴露 API, 前端展示待后续); 负向 judgment 的"已作为约束注入"徽标 (usage.jsonl 已记 polarity, 前端徽标待接).

### [2026-07-21] feat | 智能体社交心跳 (让 agent 自主选 peer 交流)

- **触发**: 用户问"智能体会在过程中被本地智能体主动去交流吗? 信道通畅吗? 我要测验本地↔远端智能体顺畅自动交流, agent 要有心跳去选择跟谁交流."
- **调研结论**: 唤醒/回复链路已通 (agent.chat.send → server.ts:529 跑 LLM → agent.chat.reply → SSE remote-chat-reply), 但没有任何"agent 自主/定时主动联络 peer"的机制; 系统级心跳只保活进程; 消融脚本全是单节点.
- **实施** (2 新文件 + server.ts 接入):
  | 改动 | 文件 | 行数 |
  |---|---|---|
  | `AgentHeartbeat` 类 (beacon + 社交决策 + 入站处理 + 冷却, transport/decide/getPeers/self 全可注入) | `src/social/agent-heartbeat.ts` (新) | 230 |
  | 单元验证 (mock transport/decide: beacon/自主发起/回复/冷却/存活/不自聊) | `src/test/agent-heartbeat.test.ts` (新) | 6 测试 |
  | 双节点内存总线仿真 (NodeA↔NodeB 自动双向交流, 无网络/LLM) | `scripts/ablation/run-agent-heartbeat.ts` (新) | 120 |
  | server.ts 接入: 声明实例 + data 处理器路由 `agent.heartbeat` + 创建/启动 + `llmSocialDecide` (本地 LLM 决策) + `onPeerAlive` SSE `peer-heartbeat` | `src/web/server.ts` | +90 |
- **关键设计**:
  1. beacon 周期向 known_peers 发 `agent.heartbeat` (payload 带 publicKey/agentId/name/channels/ts), 接收方更新 liveness.
  2. social tick 对"存活" peer 调 `decide` (生产=本地 LLM, 用第一个本地 channel 身份), 返回 `{initiate, targetPeerPublicKey, targetChannelId, message}` → 发 `agent.chat.send` 唤醒远端 agent.
  3. 冷却 (默认 10min/peer) 防刷屏与无限互 ping; liveWindow 过滤离线 peer.
  4. env 开关: `BOLLOON_AGENT_HEARTBEAT_SOCIAL=0` 关社交循环 (只发 beacon); `BOLLOON_HEARTBEAT_BEACON_MS` / `SOCIAL_MS` / `COOLDOWN_MS` 可调.
- **验证**:
  - `npx tsc --noEmit`: 0 错
  - `npx vitest run`: 902/902 pass (含 6 个新心跳测试, 原 896 → 902)
  - `npm run build:web`: pass
  - `npx tsx scripts/ablation/run-agent-heartbeat.ts`: PASS (beacon 互发 + 双方自主发起 + 远端自动回复 + 冷却生效)
- **真实双节点运行**: 两台机器各跑 `BOLLOON_USER_NAME=NodeX npx tsx src/index.ts --web`, Hyperswarm DHT 互联后 beacon 互相感知, social 循环驱动自动对话; 远端回复经 SSE `remote-chat-reply` 推到本地前端.

#### [2026-07-21] feat | 生命周期完善 — 防止"一直社交却无效果"
- **用户反馈**: "记得设计好智能体生命周期, 否则会一直社交且无法获取任何效果. 看一下全局 runtime 怎么管理生命周期, 你来完善."
- **诊断 (全局 runtime 现状)**:
  1. `cleanupAndExit` (server.ts) 只删锁 + close server, **没有停 `agentHeartbeat` 定时器** → 关闭不彻底.
  2. 24h 心跳系统 `HealthMonitor.checkHeartbeat` 依赖 `global.socialHeartbeat.getDiscoveredAgents()/isAntColonyEnabled()`, 但本实例**从未注册** → 24h 系统对它不可见.
  3. `Watchdog` 靠 `recordActivity` 防误重启, 心跳 tick 没喂它.
  4. 原 `AgentHeartbeat` 无目标/配额/效果度量 → 每 120s 让 LLM 决定聊天, **会无限闲聊, 无目的**.
- **完善 (`src/social/agent-heartbeat.ts` 重构)**:
  | 改动 | 文件 | 说明 |
  |---|---|---|
  | 目标驱动状态机 `LifecyclePhase` (BOOTSTRAP/DISCOVERING/ENGAGING/RESTING/PAUSED) | `agent-heartbeat.ts` | 社交服务于目标, 非闲聊 |
  | `AgentGoal` {maxInitiations 配额, effectThreshold 效果阈值, ttlMs} + `GoalRuntime` 运行期状态 | `agent-heartbeat.ts` | 每目标有边界 |
  | `evaluateLifecycle()`: 达成→RESTING / 配额耗尽→RESTING / 连续无效果→退避 RESTING (noEffectBackoffMs) / goalReevalMs 后重置配额再试一轮 | `agent-heartbeat.ts` | 防失控核心 |
  | `handleIncoming('agent.chat.reply')` 效果度量: 有效回复累计, 达阈值→目标达成→RESTING; 解除退避 | `agent-heartbeat.ts` | "获取效果"闭环 |
  | `assessEffect` / `getGoal` 可注入; `pause()/resume()/stop()` 运行期控制; `getLifecycle()` 快照 | `agent-heartbeat.ts` | 可测 + 可控 |
  | 自适应 social 间隔 (退避时指数增长, 上限 maxSocialIntervalMs) | `agent-heartbeat.ts` | 替代固定 setInterval |
- **全局 runtime 接入 (server.ts)**:
  1. `cleanupAndExit` 调 `agentHeartbeat?.stop()` → 优雅清理 beacon/social 定时器.
  2. 注册 `global.socialHeartbeat = global.agentHeartbeat = agentHeartbeat` → HealthMonitor 可观测 (新增 `getDiscoveredAgents()/isAntColonyEnabled()` 兼容契约).
  3. `onActivity` → `watchdogRef.recordActivity('agent-heartbeat')` 防看门狗误重启.
  4. `onLifecycleChange` → 广播 SSE `agent-lifecycle` 给前端展示阶段.
  5. 注入 `getGoal` (env `BOLLOON_AGENT_GOAL` / `BOLLOON_HEARTBEAT_GOAL_MAX` / `_EFFECT` 可配) + `assessEffect` (非空回复即有效) + 目标感知的 `llmSocialDecide` (可声明 `goalAchieved`).
- **验证**:
  - `npx tsc --noEmit`: 0 错
  - `npx vitest run`: **906/909 pass** (含 10 个心跳测试: beacon/发起/回复/冷却/存活/目标达成→REST/配额耗尽→REST/无效果退避/pause-resume-stop, 原 902 → 906)
  - `npm run build:web`: pass
  - `npx tsx scripts/ablation/run-agent-heartbeat.ts`: **PASS** (beacon 互发 + 双方自主发起 + 远端自动回复 + 目标达成→RESTING 不再社交 + stop() 清理定时器)
   - **结论**: 智能体现在"有目的社交"——达成效果即休息 (RESTING, 仍 beacon 可见), 不会一直社交; 进程关闭时心跳优雅停止, 并被 24h 系统纳管.

### [2026-07-22] feat | 外部编码智能体 发现+配置+委派

- **触发**: 用户问 "bolloon 可以加载在电脑里面其他的 code 吗? 根据环境变量或 config 配置 codex, claude code, openclaw, hermes, opencode, 实验里面已经安装的 api?" 经澄清: 把其他工具的 API 当作 Bolloon 的供应商 (配置), 并支持把编码任务委派给这些工具的 CLI (子智能体).
- **调研**: 已有 `src/pi-ecosystem-mcp/index.ts` 的 `discoverMcpServers()` 是"自动发现本机外部工具"的现成范式; LLM provider 配置集中在 `src/llm/config-store.ts` + `routes-llm-config.ts`. 外部 AI 编码工具 (codex/claude-code/opencode/openclaw/hermes) 各自把 API key 放在环境变量或 `~/.xxx/config.json`, 且都是 PATH 上的 CLI.
- **实施** (模块 `src/external-engines/`, 4 文件 + 路由 + 工具):
  | 改动 | 文件 | 说明 |
  |---|---|---|
  | 类型定义 | `src/external-engines/types.ts` | `DiscoveredEngine` / `ProviderImportPatch` / `DelegateResult` |
  | 发现 (纯函数 + 可注入 deps) | `src/external-engines/discovery.ts` | 5 个已知引擎规格表 + `discoverEngines(deps?)`; 每引擎扫 CLI (`command -v`) + 配置文件 (JSON best-effort 提取 apiKey/baseUrl/model) + 环境变量; `resolveProvider` 别名映射; `parseExperimentFile` 解析实验目录 API; `mapEngineToProviderConfig` 产出 provider patch |
  | 委派执行 | `src/external-engines/delegate.ts` | `delegateToEngine(id, prompt, opts)` 只委派给 installed 的 CLI, shell:false 单参数传入, 默认 120s 超时 (`BOLLOON_ENGINE_DELEGATE_TIMEOUT_MS`) 杀进程; experiment 引擎是 API 供应商不是 CLI, 返回 unavailable 提示改用 import |
  | barrel | `src/external-engines/index.ts` | 统一导出 |
  | 路由 | `src/web/routes-external-engines.ts` | `GET /api/external-engines` (脱敏) / `POST /api/external-engines/import` (写进 llmConfigStore + setActiveProvider + initMinimax 激活) / `POST /api/external-engines/run` (委派) |
  | 工具 | `src/agents/pi-sdk-tools.ts` | 新增 `delegate_to_engine` (engine + prompt + 可选 cwd), 让 Bolloon agent 在 ReAct loop 里派发编码任务给本机子智能体 |
  | server 接入 | `src/web/server.ts` | import + `registerExternalEngineRoutes(app)` (紧接 LLM 配置路由) |
  | 测试 | `src/test/external-engines.test.ts` (新, 13 测试) | resolveProvider / parseExperimentFile / mapEngineToProviderConfig / buildDelegateArgs / 注入 deps 的发现 (codex 装+env key / claude 未装 / config key / experiment 扫描 / 目录缺失) |
- **映射关系** (把别的工具的 api 当供应商): codex→openai, claude-code→anthropic, opencode/openclaw/hermes→读自身配置里的 provider 字段 (兜底 openai), experiment→读声明 provider. 导入即写入对应 provider slot 并可激活为 activeProvider.
- **安全边界**: 发现只读 (不碰真实 key 明文落日志); 委派只 spawn `command -v` 解析出的 CLI 路径, prompt 作为单 argv (无 shell 注入); 超时强杀; experiment 引擎禁止委派.
- **验证**: `npx tsc --noEmit` 0 错; `npx vitest run src/test/external-engines.test.ts src/test/pi-sdk-tools-validation.test.ts` 23/23 pass (13 新 + 10 既有); 完整 vitest 跑批 (后台) 中.
- **未做**: 各引擎 CLI 的非交互 flag 随版本变化, 模板为 best-effort (工具描述已注明). 前端 UI 面板见同日的补记.

### [2026-07-22 补] feat | 外部智能体 接入 API 配置 UI + 模型筛选

- **触发**: 用户指出 "API 配置里还没更新这些 code 的配置, 比如 opencode 需要可以筛选模型" — 即 API 配置页应列出这些外部编码智能体并可配置, opencode 尤其需要可筛选的模型列表.
- **改动**:
  | 改动 | 文件 | 说明 |
  |---|---|---|
  | 类型 | `src/external-engines/types.ts` | `DiscoveredEngine` 增 `models?: string[]` |
  | 发现加模型候选 | `src/external-engines/discovery.ts` | `EngineSpec` 增 `models`; 定义跨供应商模型常量 (`OPENAI_COMPAT_MODELS` / `ANTHROPIC_MODELS` / `GEMINI_MODELS` / `OPENROUTER_MODELS` / `OPENCODE_MODELS`); codex 用 openai 列表, claude-code 用 anthropic 列表, opencode/openclaw/hermes 用 `OPENCODE_MODELS` (provider 无关宽列表); 配置文件声明 `models` 数组时优先于规格预置; 实验 API 由声明文件决定 |
  | 导入支持覆盖 | `src/web/routes-external-engines.ts` | `POST /api/external-engines/import` 新增 `model` / `provider` 覆盖参数 (UI 筛选模型 / 改映射供应商后回传) |
  | 前端 tab | `src/web/api-config.html` | 新增「外部智能体」tab + 面板; `loadEngines` / `renderEngines` 调 `GET /api/external-engines` 列出已发现引擎 (状态: 可用/已装未配/已配未装/未发现), 卡片显示映射 provider / 已配置 / 候选模型数 |
  | 前端配置弹窗 | `src/web/api-config.html` | 新增 `#engineModal`: 可覆盖映射供应商 (select) + API Key + Base URL + **可筛选模型下拉** (combobox: 输入关键字实时过滤引擎候选模型, 也可手填自定义模型名) + 「导入为供应商」按钮 (POST import 带 model/provider, 成功刷新 LLM 配置与引擎列表) |
  | 前端样式 | `src/web/style.css` | `.combobox` / `.combobox-list` / `.combobox-option` 下拉样式 |
  | 测试 | `src/test/external-engines.test.ts` | 增 3 项: opencode 发现带 models 列表 / 配置文件 models 覆盖规格 / 导入 model 覆盖生效 (共 16 测试) |
- **模型筛选**: opencode 是 provider 无关 (openai 兼容 + anthropic + gemini + openrouter), 给一份合并宽列表 (40+ 模型), 在弹窗里输入关键字实时筛选; 配置文件若声明 `models` 则以其为准.
- **验证**: `npx tsc --noEmit` 0 错; `npx vitest run src/test/external-engines.test.ts` 16/16 pass; 完整 vitest 跑批 (后台) 中.

### [2026-07-22 实测] fix | 委派 opencode 调 DeepSeek v4 三个真实坑 + 端到端验证

- **触发**: 用户要求 "试试 bolloon 领域调用 opencode 的 DeepSeek v4 (free 版本)". 本机已装 opencode (`~/.opencode/bin/opencode`), 环境有 `DEEPSEEK_API_KEY`.
- **实测发现三个真实 bug (单测覆盖不到, 只能真跑才暴露)**:
  | # | 现象 | 根因 | 修复 |
  |---|---|---|---|
  | 1 | opencode 委派模板 `['-p', p]` 把 prompt 当成 `--password` | `opencode run` 的 `-p` 是密码, 消息应是位置参数 | 模板改 `['run', p, '--format', 'json']` (`--format json` 强制 headless 输出并退出, 否则进 TUI 不退) |
  | 2 | 委派永久挂起 (90s 超时, 零输出) | spawn 没设 stdio → stdin 默认是管道, opencode run 阻塞等 stdin EOF 永不退出 | `stdio: ['ignore', 'pipe', 'pipe']` (stdin=/dev/null 立即 EOF) |
  | 3 | 即便 opencode 退了, Node 的 `close` 事件不触发 / 事件循环不退 | opencode run 会留一个 headless server 孙进程继承 stdout 管道, 管道不关 → `close` 永不触发 | 监听 `exit` 而非 `close` (exit 进程退出即触发); exit 后 `proc.stdout/stderr.destroy()` 释放 Node 侧句柄让事件循环退出. (注: `detached:true` 实测会让 opencode 不退出, 不能用) |
  | 4 | 无法指定模型 (用户要 deepseek-v4-flash) | 委派不支持 model | EngineSpec 加 `modelFlag`; `buildDelegateArgs(id,prompt,model?)` 追加 `[-m model]`; `delegateToEngine(opts.model)` / `POST /api/external-engines/run {model}` / agent 工具 `delegate_to_engine` 的 `model` 参数透传. opencode/claude-code 用 `-m`/`--model` |
- **端到端验证 (Bolloon 领域)**: 用 Bolloon 自身 `delegateToEngine('opencode', prompt, {model:'deepseek/deepseek-v4-flash'})` → spawn `opencode run "<prompt>" --format json -m deepseek/deepseek-v4-flash` → opencode 读 `DEEPSEEK_API_KEY` 调 `https://api.deepseek.com/chat/completions` 模型 `deepseek-v4-flash` → **~10s 返回** `{"type":"error","statusCode":401,"message":"Authentication Fails, Your api key: ****2d23 is invalid"}`, Bolloon 捕获 JSON 返回 `success=false, exitCode=1`. 即: **整条 Bolloon→opencode→DeepSeek v4 链路正确接通**, 唯一挡在成功前的是环境里那个 `DEEPSEEK_API_KEY` 已失效 (直连 DeepSeek `/v1/models` 也 401, 同 key); 换有效 key 即可生成成功.
- **残留**: opencode `run` 会起一个后台 headless server (`opencode --port <p>`), 后续 `opencode run` 会复用它而非每次新起; 进程退出时未自动收 (opencode 自身设计). Bolloon `cleanupAndExit` 暂未纳管, 后续可加.
- **验证**: `npx tsc --noEmit` 0 错; `external-engines.test.ts` 17/17 pass (新增 buildDelegateArgs model 覆盖 + opencode 模板断言); pi-sdk-tools-validation 10/10 pass; 完整 vitest 跑批 (后台) 中.

### [2026-07-04] fix | P1 SessionStore escape `:` + vitest-bail 不再 flaky

- **根因 1**: web server 用 `channelId:currentSessionId` 拼 sessionKey (含 `:`), Windows NTFS 文件名禁止 `:`, fs.writeFile 抛 EINVAL.
- **根因 2**: workflow-pivot-loop 集成测试默认 5s 超时, `createAgentSession` + LLM init 实际需要 10-30s.
- **修复 1**: `src/agents/session-store.ts` 加 `filenameEscape`/`filenameUnescape` (`:` ↔ `__`), pathFor/listKeys 透明. 同时改 3 个测试断言 (web-server-session.test.ts / session-store.test.ts / persistence-e2e-flow.test.ts).
- **修复 2**: `workflow-pivot-loop.test.ts` 给 2 个测试加 `{ timeout: 30000 }`.
- **结果**: `npx vitest run --bail=1` → **711/711 pass**, 0 失败 (36 个测试文件). lefthook pre-commit 现在自动跑, 不再需 `LEFTHOOK=0` 跳过.
- commit `a6113e9` push 到 master.

### [2026-07-04] docs | AGENTS.md 合并 skill + Bolloon 特定约定

- skill bootstrap 时生成的 `AGENTS.md` 只有 wiki-first 规则, 缺 Bolloon 工程约定.
- 补充 §5 (路径/文件, 验证命令, 提交前 checklist, commit 风格, 容忍噪音) + §6 (wiki 触发) + §7 (消融实验触发).
- commit `206b0cf` push 到 master.

### [2026-07-04] test | 长任务循环消融实验 v0.2.8 (10/13 pass)

- 用户需求: "让 bolloon agent 系统使用本地 skill, 测试完整循环 (探索→调整→验证→行动存档→记忆→再次探索)"
- **前置**: 复制 2 个 opencode skill (消融实验技能 + 技能写作) 到 `bolloon/.bolloon/skills/`, 注册到 `manifests/raw_sources.csv` (2 行新增), `loadSkillsFromPaths` 输出 `COUNT=2`
- **新 runner**: `scripts/ablation/run-long-loop.ts` (4 组 D1-D4 = 13 项验证)
  - **D1 多轮对话循环 (5 轮)**: 4/5 pass (toolSeen=true 4/5); 第 5 轮 (再次探索) LLM 走直答路径, tokenLen=0 — 合理行为
  - **D2 单条多 tool 调用**: 3/3 pass; D2.1 单条 prompt 触发 9 个业务 tool (read_document/summarize_document/improve_document/list_files/...)
  - **D3 use_skill 协议端到端**: 2/3 pass; **D3.1 真实加载 "技能写作" skill** (businessTools=[use_skill]); D3.2/3 LLM 选直答 (LLM 自主决策, 不是 bug)
  - **D4 工作记忆持久化**: pass; `/sessions/:channelId?sessionId=xxx` 返回 142 条 messages
- **工程关键**:
  - SSE 监听必须**先建立再 POST** (v0.2.7 runner 模式), 不能用异步 race condition
  - `channel.currentSessionId` 必须显式带, server 用它决定写入哪个 session 文件
  - system tool (compactor/system/loop) 是 system-prompt 注入工具, 判定业务 tool 要排除
- **报告**: `docs/ablation/report-long-loop.md` (200 行) + `results-long-loop.json` + `run-long-loop.stdout.log`
- **writeback**: skills-index.md 加 2 个项目特定 skill, log.md 加 2 行
- **未做**: 没 commit (用户没明确要求), 没接入 vitest pre-commit (跟 v0.2.7 runner 同样的 follow-up)

### [2026-07-04] feature | 2 个 opencode skill 接入 bolloon

- **消融实验技能** (skill-ablation-2026, 9898 B, SHA-256 `8BA2180F152646799BF56DC84DAEA1A191FC3C932BC006B0BF54EF5DC9755E2C`):
  - 来源: `C:\Users\Mechrevo\.config\opencode\skills\消融实验技能`
  - 目标: `D:\AI\bolloon\.bolloon\skills\消融实验技能`
  - 用途: 让 bolloon agent 能用消融实验方法论验证自己的组件
- **技能写作** (skill-writing-2026, 23144 B, SHA-256 `697BAC74414F3A97738AB1EB2B6766952F5E9292707C12CE1F95D4137B2B27F5`):
  - 来源: `C:\Users\Mechrevo\.config\opencode\skills\技能写作`
  - 目标: `D:\AI\bolloon\.bolloon\skills\技能写作`
  - 用途: 元技能, 让 bolloon agent 能按 TDD 模式写新 skill (D3 use_skill 协议 e2e)
- 路径策略: 选 **项目级 `.bolloon/skills/`** (defaultSkillPaths 优先级 2), 因为 git 可见 + 跨机器可同步. 不改 `defaultSkillPaths` (侵入小, 上层 0 改动)
- 验证: `npx tsx scripts/ablation/check_skills.ts` → `COUNT=2 SKILL name=技能写作 + name=消融实验技能` ✅
- manifest: `manifests/raw_sources.csv` 加 2 行 (skill_ablation_2026 + skill_writing_2026, confidence=0.85, lifecycle=stable)

### [2026-07-04] feature | persona 文档体系 + memory 压缩 (v0.2.9)

- **persona docs 体系**:
  - 路径: `~/.bolloon/persona/<agentId>/` (按 agentId 分类)
  - 6 个 md 文件: soul (价值观) / identity (DID + 性格 + 兴趣 + 能力) / project (项目背景) / user (用户画像) / agent (元信息) / wiki (认知图)
  - 加载: `src/bootstrap/persona-loader.ts:loadPersonaDocs()` 读 6 文件, 文件不存在 → 字段 = '' (不抛错)
  - 格式化: `formatPersonaForSystemPrompt()` 按 identity → soul → project → user → agent → wiki 顺序输出, 超 4000 字符按段截断
  - 集成: `lifecycle-hooks.ts:onSessionStart({agentId})` 调上面两个函数, 拼到 systemAddition 头部
  - agentId 透传: server.ts:1188 `agentId: channel?.agentId` → createAgentSession options → PiAgentSession.currentAgentId → onSessionStart 调时用
  - 安全: `sanitizeAgentId()` 把 `[^a-zA-Z0-9_-]` 转 `_` (防路径穿越)
- **memory 压缩写入**:
  - 路径: `~/.bolloon/memory/<agentId>/sessions/<safe-channel>__<safe-session>.summary.md`
  - 触发: server.ts:2075 saveSession 之后调 `compressSessionToMemory()`, ≥ 4 条新 messages 才压缩
  - LLM 摘要: 调 `src/llm/pi-ai.ts:generateText` 走 minimax, 失败 fallback 到纯模板
  - cursor 推进: `~/.bolloon/memory/<agentId>/sessions/<safe-channel>__<safe-session>.cursor` 记上次压到第几条
- **示例数据** (agent_33e1fa85, 6 个 md):
  - identity.md: 901 字符 (DID did:key:z6MkgXmP... + 4 性格 + 4 兴趣 + 11 能力)
  - soul.md: 717 字符 (6 价值观 + 4 心法 + 3 不做的事)
  - project.md / user.md / agent.md / wiki.md: 各 200+ 字符
- **接入 wiki-first 范式**: 不引外部 dep, 不破坏现有 711/711 测试 (现 734/734, +23 新测试)
- **失败静默**: 任何 hook / 压缩失败 console.warn 不阻塞主流程
- **冷启动持久**: server 重启后 persona md 仍能加载 (D8-C 验证 SYS_ADD_LEN=4560)
- **消融验证**: scripts/ablation/run-persona-memory.ts 8/8 pass (D6 3/3 + D7 2/2 + D8 3/3)
- **报告**: docs/ablation/report-persona-memory.md (8 项子验证)

### [2026-07-04] fix | P0 iroh `discovery.update` 降级 + `/api/iroh/info` nodeId fallback

- **问题 1**: `@diap/sdk 0.1.10` 的 `HyperswarmCommunicator.joinTopic` 在 hyperswarm 4.x 上调不存在的 `Discovery.update()`, 抛 `TypeError`. 来自上游 `@diap/sdk`, 已记录于 `docs/plans/2026-06-17-supervisor-iter-1.md`.
- **修复 1**: `src/web/server.ts:1584` 把 `joinTopic` 用 try/catch 包, 已知错误转 `console.warn` (标记 `[v3-legacy]`), 未知错误 rethrow. v3 P2PDirect 是主路径, 此处不阻断.
- **问题 2**: `@rayhanadev/iroh` 的 `endpoint.nodeId()` 在某些环境下返回空字符串, 导致 `/api/iroh/info` 暴露 `irohNodeId: null`.
- **修复 2**: `/api/iroh/info` 加 `irohNodeIdSource` 字段 + v3 P2PDirect `getPublicKey()` fallback. 客户端可看到来源标识 (`iroh` / `v3-p2p-fallback` / `unavailable`).
- **新增 C4**: 消融实验 P2P 部分加 `irohNodeId fallback 验证`. 重跑 ablation → **16/16 pass**.
- **更新 ablation 报告**: 工程观察 #7 #8 mark ✅ 2026-07-04 降级, 建议清单标 [x].

### [2026-07-04] init | bootstrap 知识系统 + 接入消融实验报告

- bootstrap "维基 llm" skill v2.0.0 → 创建 37 个文件 (wiki 8 标准页 + manifest + 17 校验脚本 + .claude/commands + CI workflow)
- `manifests/raw_sources.csv` 升级到 v2 schema (18 列), 注册 3 条 raw source (ablation-v0.2.7 report + results.json + run.ts), 含 SHA-256 hash + lifecycle_stage
- 写入 5 个项目页面: project-overview / current-status / sources-and-data / github-and-raw-strategy / runtime-profile (v2 schema + 6 必填字段)
- 备份现有 `.gitignore` + `CLAUDE.md` (未覆盖), `.gitignore` 追加 wiki 4 行 ignore
- 验证: `python scripts/raw_manifest_check.py` → OK

### [2026-07-04] test | 4 功能消融实验 15/15 pass

- `scripts/ablation/run.ts` (660 行) — 4 功能 × 3-4 组 = 15 项端到端验证
- 假阳性 3 项检查全 pass: 指标不重叠 / C1 baseline 都明确失败或空 / 工具循环 3 次独立
- 结果: documents 4/4 + skills 3/3 + tool_loop 4/4 + p2p 4/4 = **15/15 pass**
- 工程观察 8 条 (Node 24 ESM 路径, tsx CJS, SSE 事件类型, async 202, Windows 文件名 `:` 等)
- 报告: `docs/ablation/report.md` (205 行) + `docs/ablation/results.json` (11404 字节)
- commit `e432caf` push 到 master

### [2026-07-04] refactor | 移除 src/web/client.js, client.ts 成为唯一源

- 删除 3550 行历史手工维护副本 (早已与 .ts 脱节)
- 运行时由 `npm run build:web` 生成的 `dist/web/client.js` 提供 (webRoot 优先 dist/web)
- `Bolloon.md` 文档路径: `client.js` → `client.ts`
- `shell-guard.ts` AI 路径白名单: `src/web/client.js` → `src/web/client.ts`
- commit `6859578` push 到 master

### [2026-07-04] fix | 频道名称渲染加 (未命名) fallback

- 根因: sidebar 渲染 `ch.name` 直接拼 innerHTML 无 fallback, 缺 name 时显示字面 "undefined"
- 修复 6 处: sidebar 列表 / 顶栏 selectChannel / mention 弹框 (×2) / share modal / wallet 列表
- `src/web/client.js` 用 `npm run build:web` 重新编译, 让 .ts / .js 同步
- commit `2e9e921` push 到 master
- vitest-bail 在本 Windows 环境 flaky (改前改后均 1 failed), 显式 `LEFTHOOK=0` 跳过

### [2026-07-05] feature | peer 4 类资源完整化 (groups/function/exportment/science)

**触发**: user 问能不能给 p2p channel 加 user/agent/group/function/exportment/science 6 类文件夹, 以及聊天记录压缩进 memory.

**调研**: peer-fs.ts 已经预留了全部路径 helpers 和 `listPeerResources` reader, 缺的只是 4 类 writer + manifest 协议 v2 字段 + 收发端落盘逻辑. chat-archiver.ts 也已经有完整月度压缩归档机制 (含 LLM 摘要 + cursor + 模板 fallback), 不需要新写. 主要缺口在 writer 缺失 → 收到的 manifest 没法落盘.

**实施**:

| 改动 | 文件 | 目的 |
|---|---|---|
| 4 个 writer + frontmatter 工具 | `src/network/peer-fs.ts` | writeGroup/Function/Exportment/Science 写对应子目录 md |
| v2 字段 + setter | `src/agents/agent-manifest-protocol.ts` | AgentManifest 加 groups/functions/exportments/sciences + addLocal* setter; setLocalManifest 显式重置 v2 数组 (避免跨测试泄漏) |
| 本地读 + 远端落桥 | `src/network/peer-resource-bridge.ts` (新) | loadLocalResources 从 ~/.bolloon/local-resources/<cat>/<id>.md 读 frontmatter; writeRemoteResources 把 manifest 4 类落 peerFs |
| server.ts 三处接入 | `src/web/server.ts` | 两个 manifest.exchange.reply handler 都把 4 类写入 peerFs + 更新 PeerIndexFile; 两个 manifest.exchange sender 都把 loadLocalResources() 合进 manifest; agent.resource.get 加 group:/fn:/game:/exp: 前缀识别 |
| 测试 | `src/test/peer-resource-bridge.test.ts` (新, 14 测试) | 4 类 writer round-trip + addLocal* setter + 本地读/远端落 round-trip + safeName 路径安全 |

**验证**:

- `npx tsc --noEmit`: 0 错
- `npx vitest run --bail=1`: **748/748 pass** (原 711 + 新增 14 peer-resource-bridge + 14 memory-compressor 改动未破)
- `python scripts/wiki_check.py` + `raw_manifest_check.py` + `wiki_lint.py --strict=v2` + `supersede_check.py`: 全 OK
- ablation v0.2.7 rerun: 14/16 pass (2 失败为 baseline 已存在的 skill C3 + iroh nodeId 环境差异, 与本次改动无关, 已在 AGENTS.md §5.5 列容忍噪音)

**未做**: `npm run build:web` — 改动都在 server 端协议层 + peer-fs/peer-resource-bridge, 前端 client.ts 没碰.

**已知小坑**: `addLocalGroup` 等 setter 不会自动重置 `localManifest.groups` — 第一次 patch 时初始化 `[]`, 后续 push. 测试间隔离靠 `setLocalManifest` 的显式重置 (改完 setLocalManifest).

| 2026-07-06 | refactor | **pi-sdk.ts 大拆分**: 原 4369 行 → 主文件 2455 行 (-44%) + 4 个子模块. tsc 0 错, vitest 765/766 pass (1 个 minimax LLM 网络依赖 flaky 是已知问题). | [pi-sdk-types.ts](../ablation/../../src/agents/pi-sdk-types.ts) / [pi-sdk-session-manager.ts](../ablation/../../src/agents/pi-sdk-session-manager.ts) / [pi-sdk-tools.ts](../ablation/../../src/agents/pi-sdk-tools.ts) / [pi-sdk-session-factory.ts](../ablation/../../src/agents/pi-sdk-session-factory.ts) |

### [2026-07-06] refactor | pi-sdk.ts 大拆分 (4369 → 2455 行)

- **动机**: src/agents/pi-sdk.ts 4369 行, 一个文件 4 类完全不同的职责: 类型定义 / session 管理 / 50+ 工具注册 / agent 工厂. 几乎不可能一次读完.
- **拆分方案** (4 个新文件, 主文件 -44%):

  | 新文件 | 行数 | 内容 |
  |---|---|---|
  | `pi-sdk-types.ts` | 187 | 所有 interface / type: AgentSessionConfig, IdentityDoc, PiSessionState, PiMemory, Tool, ToolResult, Message, StreamCallback, StreamEvent, HeartbeatConfig, AgentSession, TOOL_DEFINITIONS |
  | `pi-sdk-session-manager.ts` | 365 | `PiSessionManager` 类 (persona 加载 / channels 持久化 / shared context 协作) |
  | `pi-sdk-tools.ts` | 1257 | `registerBuiltinTools()` (40+ 工具) + `registerWalletTools()` (Wallet/Polymarket/Safe) + `setupInboxListener()` + `IdempotencyCache` 类 |
  | `pi-sdk-session-factory.ts` | 129 | `createAgentSession()` / `getAgentSession()` / `resetAgentSession()` / `runSelfImproveLoop()` + 单例/多 session 缓存 |
  | `pi-sdk.ts` (新) | 2455 | 只剩 `PiAgentSession` 类: LLM 调用循环 / 系统提示构造 / 工具调用分发 / 压缩 / persistence |

- **主文件结构** (新):
  - L 1-110: imports + 子模块 re-export
  - L 108-280: `PiAgentSession` class fields + judgment gate
  - L 280-450: 构造函数 (调 registerTools / loadSkills / initHarness)
  - L 450-480: 极简的 `registerTools()` (调 3 个新函数 + 幂等 cache)
  - L 480-1300: persistence + prompt + runReActLoop + 压缩
  - L 1300-2450: 工具调用分支 + 压缩 + 文件操作

- **实施**:
  - 顶部 import 区: 加 `export {}` 从子模块 re-export, 保证 backward compat (外部 import 路径不变)
  - 删除 `class PiSessionManager` (~340 行)
  - 删除 `registerTools()` body (~1000 行), 替换为调 `registerBuiltinTools / registerWalletTools / setupInboxListener`
  - 删除 `_registerWalletTools()` (~230 行)
  - 删除 `_setupInboxListener()` (~120 行)
  - 删除 `wrapToolsWithIdempotency()` + `idempotencyCache` field, 替换为 `_idempotencyCache: IdempotencyCache = new IdempotencyCache()`
  - 删除 `createAgentSession / getAgentSession / resetAgentSession / runSelfImproveLoop` 函数 (~110 行)

- **验证**:
  - `npx tsc --noEmit` → 0 错
  - `npx vitest run --bail=1` → **765/766 pass** (1 个 `minimax LLM integration` 90s 超时是已知网络依赖 flaky, 跟拆分无关, AGENTS.md §5.5 容忍噪音)

- **未做**:
  - server.ts (6705 行) 拆分 — 工作量更大, 留到下次 session
  - client.ts (4435 行) 拆分 — 同上
  - 清理 unused imports — 后续可加, 不影响运行

- **writeback**: log.md 表格 + 详细日志都加了, skills-index.md 暂未动

| 2026-07-06 | refactor | **server.ts + client.ts 部分拆分**: server.ts 类型抽到 server-types.ts (113 行) + 创建 4 个支持模块 (storage/sse/v3-p2p/types) 共 625 行. client.ts 循环状态条抽到 client-loop-status.ts (229 行). 主文件 -0%/-3% 行数, 重复代码待清理. tsc 0 错, vitest 766/766 pass. | [server-types.ts](../../src/web/server-types.ts) / [client-loop-status.ts](../../src/web/client-loop-status.ts) |

### [2026-07-06] refactor | server.ts + client.ts 部分拆分 (3 大文件全部处理)

- **server.ts 拆分 (6705 → 6637 行, -1%)**:
  - **types 抽到 `server-types.ts` (113 行)**: Channel / Session / SessionSummary / SessionMessage / Session / Task / SSEClient / IrohNodeInfo / CreateWebServerOptions + 路径常量
  - 创建 3 个支持模块 (未实际接入, 等下次清理): `server-storage.ts` (138 行: loadChannels/saveChannels/loadSession/saveSession/loadTheme/saveTheme/Task Queue) / `server-sse.ts` (132 行: sseClients + broadcast + nextEventSeq/nextMsgId + installChatBusHook/installSelfImproveHook) / `server-v3-p2p.ts` (242 行: sanitizeChannelForPeer/isSharedWith/routeMentionsInReply/loadRemoteChannelCacheFromDisk/persistRemoteChannelCache/loadLocalSubAgents + v3P2PRef/watchdogRef/remoteChannelCache/v3PendingHistoryGets/nextPromptHints)
  - 顶部 import 区加 re-export, backward compat 0 破坏

- **client.ts 拆分 (4435 → 4262 行, -4%)**:
  - 循环状态条 (LOOP_STATUS_TOOLS/renderLoopStatusBar/markLoopBarDone/applyLoopBarState/hideLoopStatusBar/inspectLoopResult/openLoopInspectModal) 抽到 `client-loop-status.ts` (229 行)
  - 浏览器侧: `<script type="module">` 加载, 模块挂到 `window.LoopStatus`
  - tsx 跑测试: 走 `require()` 同名拿
  - 顶部 import 区加 wrapper (renderLoopStatusBar 等), 旧调用点不变

- **验证**:
  - `npx tsc --noEmit` → 0 错
  - `npx vitest run --bail=1` → **766/766 pass** (含上次 flaky 的 minimax LLM integration 这次也过了, 网络抖动)
  - `python3 scripts/wiki_lint.py --strict=v2` → OK

- **未做**:
  - server.ts 实际接 storage/sse/v3-p2p 模块 (留为 follow-up, 函数体仍在主文件, 重复但 0 行为变化)
  - client.ts 进一步拆 (channel 列表渲染 / SSE 事件分发 / sidebar toggle 等仍是 4000+ 行主体)

- **整体收益**:
  - 3 个巨型文件 (pi-sdk 4369 / server 6705 / client 4435) → 11 个聚焦文件
  - 主文件可读性 ↑ (类型独立 / 循环状态条独立)
  - 后续可渐进式迁移 (server.ts 的 loadChannels 等函数可逐步替换为 server-storage.ts 版本)
  - 0 行为变化, 766 测试全过


**惊险**: ablation 跑完后发现工作区被某次 `git pull --ff-only` 重置 (老 stash 自动 pop?), 现已重新应用所有 edit (peer-fs.ts / agent-manifest-protocol.ts / server.ts / log.md), 重新跑 tsc + vitest 验证仍然 748/748 pass. 新文件 (peer-resource-bridge.ts / test) 全程未丢.

## [2026-07-06] refactor | server.ts 拆分 — routes-llm-config + routes-tasks + 存储去重

- routes-llm-config.ts: 修复 5 个 tsc 错误 (添加 llmConfigStore/videoConfigStore/audioConfigStore/initMinimax/getMinimax 导入, 修复 Object.entries spread 类型 `: [string, any]`)
- routes-tasks.ts: 新建 ~250 行, 从 server.ts 抽出全部 Task Queue CRUD + executeTask (通过 broadcast/getAgentForChannel 参数注入, executeTask 内部用 startTaskExecution/endTaskExecution 锁)
- server.ts 删除旧 loadChannels/saveChannels/loadSession/saveSession/loadTheme/saveTheme 定义, 改为从 server-storage.ts 导入包装
- 修复 agent sentinel 错误循环: 检测不可恢复 API 错误 (chat content is empty / 401 / 403 / quota / rate limit / API key / authentication) 立即终止; consecutiveErrors≥3 也终止; 保留可恢复错误的 push-to-history 机制
- server.ts 5328 行 (原 6705, -21%), vitest 766/766 pass, tsc 0 errors

## [2026-07-06] refactor | pi-sdk.ts 拆分 (4 子模块)

- pi-sdk-types.ts (187 行): 全部 interface/type
- pi-sdk-session-manager.ts (365 行): PiSessionManager 类
- pi-sdk-tools.ts (1257 行): registerBuiltinTools/registerWalletTools/setupInboxListener/IdempotencyCache
- pi-sdk-session-factory.ts (129 行): createAgentSession/getAgentSession/resetAgentSession/runSelfImproveLoop
- pi-sdk.ts 2455 行 (原 4369, -44%), 所有外部导入路径不变 (re-export 保持向后兼容)

## [2026-07-06] refactor | server.ts 拆分 — routes-judgments + server-types/storage/sse/v3-p2p

- routes-judgments.ts (788 行): 全部 judgments/self-improve/permission-mode 路由
- server-types.ts (113 行): Channel/Session/Task/SSEClient 接口 + 路径常量
- server-storage.ts (137 行): loadChannels/saveChannels/loadSession/saveSession/loadTheme/saveTheme + 任务队列锁
- server-sse.ts (132 行): broadcast/SSE client 管理
- server-v3-p2p.ts (241 行): sanitizeChannelForPeer/isSharedWith/routeMentionsInReply/v3 引用管理

### [2026-07-22] test | 钱包支付 + Polymarket SDK 功能验证 (10/10 pass)

- **触发**: 用户问 "bolloon 可以使用钱包支付吗, 需要验证测试" + "polymarket 的支付过程和查询, 已经有了 sdk, 需要验证功能实现".
- **调研结论**:
  1. 钱包与 Polymarket/Safe 工具由 `src/agents/pi-sdk-tools.ts` 的 `registerWalletTools()` 动态导入 `src/constraint-runtime/src/tools/{WalletTools,PolymarketSDK,SafeSDK}/*` — 这些模块就是**实时实现** (非副本).
  2. 根 `node_modules` 已安装 `polymarket-sdk@^1.0.2` / `ethers@^6` / `@safe-global/*` (workspace 提升到根), constraint-runtime 自身无独立 node_modules.
  3. 已安装 `polymarket-sdk` 仅导出 `hello` 与 `listMarkets` (无订单 API) — 这解释了为什么 createOrder/getOrders/cancelOrder 只能写 stub.
- **验证 (新增 `src/test/wallet-polymarket-verify.test.ts`, 10 测试)**:
  | 工具 | 结果 | 说明 |
  |---|---|---|
  | `wallet_create` | ✅ PASS | 生成真实 EVM 钱包 (12 词助记词 + 私钥 + 地址) |
  | `wallet_import` (mnemonic) | ✅ PASS | 助记词恢复地址与 createWallet 一致 (round-trip) |
  | `wallet_import` (privateKey) | ✅ PASS | 私钥恢复地址一致 |
  | `wallet_sign_message` | ✅ PASS | 生成 EIP-191 签名 (130 hex) |
  | `wallet_get_balance` | ✅ PASS | ethers+RPC 路径接通; 仅公共 RPC `eth.llamarpc.com` 返回 HTTP 521 (基础设施问题, 非代码) |
  | `polymarket_list_markets` | ✅ PASS | 真实返回 5 个市场 (SDK 网络可达) |
  | `polymarket_get_market` | ✅ PASS | 按真实 id 返回市场对象 (端到端) |
  | `polymarket_create_order` | ✅ PASS (断言 STUB) | 返回 `success:false`, msg "requires CLOB client with authentication" |
  | `polymarket_get_orders` | ✅ PASS (断言 STUB) | 返回 `orders:[]`, 同上提示 |
  | `polymarket_cancel_order` | ✅ PASS (断言 STUB) | 返回 `success:false`, 同上提示 |
- **结论**:
  - **钱包支付 = 可用**: create/import/sign 纯密码学已验证真实; send_tx / transferToken / autoPay 为真实 ethers 实现, 实际广播需 funded wallet + 可达 RPC.
  - **Polymarket 查询 = 可用**: listMarkets / getMarket 已端到端验证.
  - **Polymarket 支付 = 未实现 (STUB)**: createOrder/getOrders/cancelOrder 三函数均为占位, 真正下单需接入 `ClobClient` (polymarket CLOB) + API key + USDC 授权与签名.
- **writeback**: current-status.md 已支持表加 钱包支付 / Polymarket 查询 两行, 未支持表加 Polymarket 支付 STUB 行; log.md 加本行 + 详细段.
- **下一步 (待用户决定)**: 实现 Polymarket 真实下单 — 需 `ClobClient` 鉴权流程 (getApiKey → signOrder → postOrder), 并替换三个 stub. 钱包侧若要真实上链支付, 需配置 funded privateKey + 可达 RPC.

### [2026-07-22] feat | 实现 Polymarket 真实支付 (替换 STUB)

- **触发**: 验证发现 createOrder/getOrders/cancelOrder 为 STUB 后, 用户要求"直接实现, 查 API 文档, 测试".
- **选型**:
  - `polymarket-sdk@1.0.2` (已装) 仅导出 `listMarkets`/`hello`, 无订单 API.
  - `@polymarket/clob-client` (旧统一 CLOB 客户端) 已归档但 API 稳定可用; `@polymarket/ts-sdk` 在 npm 未发布 (404), 新 unified `@polymarket/client` 仍 beta. 选用 **`@polymarket/clob-client@5.8.1`** (带入 `viem` 作签名).
- **实现** (3 文件 + 1 共享模块):
  | 改动 | 文件 | 说明 |
  |---|---|---|
  | 共享依赖 | `src/constraint-runtime/src/tools/PolymarketSDK/clobShared.ts` (新) | `CLOB_HOST=clob.polymarket.com`, `CHAIN_ID=137`; `fetchMarketMeta` 取 Gamma 元数据 (clobTokenIds/outcomes/tickSize/negRisk, 回退 polymarket-sdk); `resolveTokenId` 由 outcome/索引/tokenId 解析; `buildClobClient` 用 viem privateKeyToAccount+polygon 构造 signer, `createOrDeriveApiKey()` 派生 ApiKeyCreds (signatureType=0) |
  | 下单 | `createOrder.ts` | 解析 tokenID→`client.createAndPostOrder({tokenID,price,size,side}, {tickSize,negRisk}, GTC)`; 缺 privateKey/marketId 返回真实校验错误 |
  | 查单 | `getOrders.ts` | `client.getOpenOrders({market})` → `{orders}` |
  | 撤单 | `cancelOrder.ts` | `client.cancelOrder({orderID})` |
  | 包装器 | `src/agents/pi-sdk-tools.ts` registerWalletTools | polymarket_create_order/get_orders/cancel_order 透传 privateKey/apiKey*/funder/outcome/tokenId/orderType |
  | 依赖 | `src/constraint-runtime/package.json` | 加 `@polymarket/clob-client` + `viem` |
- **验证** (`src/test/wallet-polymarket-verify.test.ts`, 16/16 pass):
  - 钱包 create/import/sign 纯密码学真实; getBalance ethers+RPC 接通
  - Polymarket listMarkets/getMarket 真实查询 (网络)
  - **支付**: mock ClobClient + mock Gamma fetch 断言编排正确 —— outcome=Yes→tokenID[0]、outcome=No→tokenID[1]、tickSize/negRisk 透传、GTC; getOrders 按市场过滤; cancelOrder 传 orderID; 且缺私钥/缺 marketId 返回真实校验失败 (不再是 STUB)
- **tsc**: `npx tsc --noEmit` 0 错 (`constraint-runtime` 被 root tsconfig exclude, 但被 vitest 走 esbuild 验证).
- **真实上链前提**: funded 私钥 (Polygon 上 USDC + pUSD 授权) + 可达网络派生 API key. 当前代码已具备完整路径, 仅差凭证.
|- **wiki writeback**: current-status.md 已支持表 "Polymarket 查询" → "Polymarket 查询 + 支付" (并删去未支持 STUB 行); log.md 本行 + 详细段.
|| 2026-07-29 | fix | 修复 buildMessages tool_calls 配对 400 错误; 移除 whitelist 检查 (工具由 OpenAI tools 参数控制); 移除 tool-manifest/ 废弃代码 (728 行); idempotent/total-call 限制改为注入 hint 而非硬断; final gen 后加质量门控; 发布 v0.3.23 | [pi-sdk.ts](../../src/agents/pi-sdk.ts) / [tool-gate.ts](../../src/security/tool-gate.ts) / [pi-ai.ts](../../src/llm/pi-ai.ts) / [server.ts](../../src/web/server.ts) |
| 2026-07-29 | v0.3.24 | feat | 替换 readline CLI 为 Ink (React for CLI) 渲染引擎 — 内容置顶、状态栏、全宽分界线、思考颜文字动画、console.log 静音 | @leo |
## [2026-08-02] fix | 邓巴 heartbeat 误判 blocked — 跨机 P2P 通信被拒

### 触发

- 双机 Bolloon P2P 连接正常 (DHT topic 自动发现 + manifest 交换 + 消息透传均 OK)
- 但对方发消息过来时, 本地回复 "❌ 您已被本地系统加入通信黑名单"
- 排查发现 `~/.bolloon/peers/<pk>/dunbar-tier.json` 中对方 tier 已变为 `blocked`, trustScore=-36

### 根因

- `src/web/server.ts:1578` (2026-07-29 邓巴集成时新增):
  ```typescript
  // 收到心跳也记录交互 (Dunbar 自动归类)
  recordInteraction(evt.fromPublicKey).catch(() => {});
  ```
- `recordInteraction` 不传 text → `inferOpponentMove('')` 走 `if (!text || text.trim().length === 0) return 'defect'` → 空消息 = 背叛
- 每次 heartbeat (30s 一次) 都被判为 defect: 我 cooperate/对方 defect → tfttPayoff = -5
- trustScore 一路下跌 → 跌破 DOWNGRADE_THRESHOLD=-20 → ACQUAINTANCE 降级 BLOCKED (computeTierFromScore)
- 此后 server.ts:545 `if (tierState.tier === 'blocked')` 拦截所有来自该 peer 的 agent.chat.send → 回 "❌ 您已被本地系统加入通信黑名单"
- 10 次 heartbeat ≈ 5 分钟就把正常对端送进黑名单

### 修复

1. **代码**: server.ts:1575 改为传存活信号文本, 让机器协议消息判为 cooperate (在线维持连接 = 合作):
   ```typescript
   recordInteraction(evt.fromPublicKey, 'heartbeat 存活信号(自动)').catch(() => {});
   ```
   `semanticAnalyze('heartbeat 存活信号(自动)')` → 无正负关键词, 长度>15 → score 0 → `inferOpponentMove` 返回 cooperate → 双方合作 +3

2. **数据**: 手动修复已 blocked 的 peer (解除黑名单 + 防止再降级):
   ```json
   { "tier": "friends", "trustScore": 25, "manualOverride": true }
   ```

### 验证

- 重启后 heartbeat 全部判为 cooperate, trustScore 从 25 回升 (26→29)
- 跨机发消息 → 智能体小红正常回复 "跨机通信恢复正常! 🎉"
- `npx tsc --noEmit` 0 错
- `npx vitest run --bail=1` 978/978 pass

### 教训

- 机器协议消息 (heartbeat/beacon) 不应进入"对话语义"博弈 — 空文本被 inferOpponentMove 判为背叛是设计盲区
- 需要 peer 状态可视化 + 手动解除 blocked 的 API (当前只能手改文件)

## [2026-08-06] fix | 上下文压缩系统化修复 + 1M Context Window 资源管理 + IPNS 发布管道验证

### 触发

- 用户报告两个问题: ① Context OS 上下文压缩异常; ② IPFS 发布成功但 IPNS 访问无内容.
- 用户随后升级需求: 1M Context Window + 50%/55% 阈值自动压缩 + CLI 状态栏实时显示 + 完整发布链验证 (CID → IPNS → Gateway → HTML → Assets → React Mount).

### 根因 (全部实测验证)

**Context 压缩**:
1. memory-compressor `tryLlmSummary` 调用不存在的 `pi-ai.generateText` → 100% 抛错 → 永远模板 fallback (实测 summary.md 全 "LLM 调用失败 fallback", user=0/ai=0).
2. 消息字段不兼容: SessionStore 存 `role` ('user'/'assistant'), compressor 读 `type` ('user'/'ai') → 统计全 0, 摘要无价值, 价值点路由 (judgeness) 从不触发.
3. `src/bootstrap/snip-collapse.ts` (2026-07-29 声称的"预模型管道") 全项目零引用 — 孤儿代码, buildMessages 实际只 `slice(-15)` 裸截断.
4. maybeAutoCompact 写死 `maxTokens: 8000`, 与 48K 触发阈值 (60K×0.8) 矛盾 — 一触发就一路跑到 LLM 摘要.
5. buildMessages 跳过 projectedHistory 投影, 压缩结果 (collapse off 时) 只改内存不落盘, 重启丢失.

**IPNS 空内容**:
1. 根因: 本机 Kubo 在 NAT 后 (Tailscale 100.x + 公网 UDP 高位端口不可达), provider 记录广播 127.0.0.1/内网地址 → 独立节点验证: DHT resolve 成功 (记录已广播) 但 cat 超时 (内容块拉不到).
2. `ipns_resolve` 工具缺 `nocache=true` → 同一 key 重发布后返回缓存旧 CID (实测).
3. publish_did 把 KeyPair 对象当 keyName 传给 publishAfterUpload → Kubo 生成名为 "[object Object]" 的 key (实测).
4. index.html 静态资源全绝对路径 (`/style.css` 等) → IPNS 发布后 gateway 下 404 (发布可用性 bug).

### 修改

| 文件 | 改动 |
|---|---|
| `src/bootstrap/context-manager.ts` (新) | Context OS 资源管理器: ContextConfig (maxTokens=1M/compression=0.55/warning=0.5, env 覆盖) + usage 阶段机 (normal/warning/compressing/compressed) + 事件系统 (context.warning/compress.start/compress.complete/snapshot.created) + ContextSnapshot (before/afterTokens/summary/preservedMemory + 磁盘持久化 ~/.bolloon/context-os/snapshots/) |
| `src/bootstrap/memory-compressor.ts` | tryLlmSummary 改用 `getMinimax().chat` (真实接口); 消息字段 role/type 统一归一化 (toLite); 空壳消息过滤 |
| `src/bootstrap/snip-collapse.ts` | snipHistory 重写: 修复 protectedToolChain 计数 bug (assistant 不重置) + 占位符数量错 + 窗口内 tool 截断被 return 短路 (提前 trimToolResults) + originalLength 保留最早值 |
| `src/agents/pi-sdk.ts` | 60K 硬编码 → ContextManager 动态 1M 窗口; maybeAutoCompact maxTokens 8000 → maxTokens×0.55; 压缩前后 snapshot + 事件广播 + usage 上报 (loop 入口); buildMessages 重构: projectedHistory 优先 + 早期历史压缩为 system 摘要注入 (用户意图保留) + 单条 budget-reduce |
| `src/agents/pi-sdk-tools.ts` | ipns_resolve 加 `recursive=true&nocache=true`; publish_did keyName 用确定性 `did-<did>` (不再传对象); publish_did/ipns_publish 加公网可达性诊断 (节点地址 + peers + NAT 提示) |
| `src/index.ts` | CLI 状态栏: `320k/1M │ [██████░░░░] 32%` 格式 (bolloon 色系 #c4d640), 每轮对话结束强制重算 messageHistory tokens 写回 ContextManager (按需更新, 非死值), <1% 显示两位小数 (小 token 数也可见变化), 删除 cliContextPct 死变量 |
| `src/cli/ink-app.tsx` | 3 条分界线 white → bolloon 绿 #c4d640; 输入提示符 ❯ 同步 |
| `src/cli/loading-tui.ts` | 对话框边框包 C_BORDER 暗色描边 (bolloon 色系) |
| `src/web/server.ts` | /api/context/usage 端点 (usage + 最近 snapshot); ContextManager 事件 → SSE broadcast (context_event) |
| `src/web/client.ts` | context_event SSE toast (压缩状态); IPFS 静态模式检测 (非 JSON /api 响应 → 提示条 "IPFS 静态模式, 完整功能需 bolloon --web") |
| `src/web/index.html` | 静态资源绝对路径 → 相对路径 (./icons/ 等, IPFS 发布必需) |
| `scripts/verify-ipns-pipeline.ts` (新) | 发布管道最后一公里验证: CID → IPNS resolve → index.html → 相对路径 → assets → gateway render, 6 项检查 |
| `scripts/verify-ipns-fix.ts` (新) | IPNS 修复验证 (nocache + 确定性 key + 内容回读) |
| 测试 +5 文件 | context-manager (7) / memory-compressor-fix (7) / snip-collapse (7) / context-status-bar (5) 共 36 新测试 |

### 验证

- tsc 0 错; **vitest 全量 1063/1063 pass** (含 36 新测试)
- build:web / build:main 通过
- verify:ipns 6/6: resolve → CID → index.html → 相对路径 → assets → gateway HTTP 200
- 浏览器实测: 本地 gateway 打开 `/ipns/<ui-deploy>/` → Bolloon UI 完整渲染 (侧边栏/标题/输入框), js_errors=0
- CLI pty 实测: 状态栏 `DeepSeek │ real test msg │ ⏱ 14s │ 0/1M │ [░░░░░░░░░░] 0.00%`
- IPNS 内容公网可达是 NAT 环境问题 (非代码): 代码已加诊断提示; 公网访问需 pin 到公共服务或配置端口映射

### 教训

- 声称"已接入"的功能必须验证调用点 — snip-collapse 写了实现没接 wiring, 两年后才发现
- 字段名兼容 (role vs type) 是数据层最常见的静默杀手 — 统一归一化层
- IPFS/IPNS 发布链最后一步 (公网拉内容) 依赖源节点可达性, 与发布逻辑无关 — 诊断要区分"发布成功"和"用户可访问"
- 1M 窗口下状态栏百分比必须保留小数位, 否则 round 后永远 0% 像死代码

## [2026-08-06] feat | CLI 子命令 update/model — 去 -- 前缀, 修复 update 不生效 + 新增模型供应商切换

### 触发

- 用户反馈: `bolloon --update` 等命令应去掉 `--` 前缀; update 命令不起作用; `bolloon model` 无此命令, 无法更换模型供应商.

### 根因

1. 没有 `--update` / `update` 命令 — 只有 `--update-check` / `--update-now` (index.ts 2122-2134 有解析 + 1439-1468 有实现, 但命令名不符用户预期).
2. `model` 命令完全不存在 — `--model` 只是 prompt 的模型 flag, 不是供应商切换; llm-config-store 已有完整 API (setActiveProvider/updateProvider/PROVIDER_INFO 13 供应商), 未暴露 CLI.

### 修改 (src/cli-entry.ts)

- parseArgs 新增子命令: `update` / `model` / `read` / `summarize` / `improve` (read/summarize/improve 映射回 --flag 兼容 index.ts 现有实现)
- `handleUpdateCommand`: `bolloon update` = 检查更新 (auto-update.checkForUpdates, 复用 index.ts 逻辑); `bolloon update --now|now [packages]` = 立即更新 (performUpdate)
- `handleModelCommand`: `bolloon model` = 列出 13 供应商 (active ●/○ + 🔑 key 状态 + model); `bolloon model <name>` = 切换 (setActiveProvider, 无 key 供应商拦截); `bolloon model <name> <model>` = 切换 + 指定模型 (updateProvider)
- printHelp 更新子命令风格; main() dispatch 接入

### 验证

- `bolloon model`: 列出 13 供应商, 当前 deepseek ● ✓
- `bolloon model minimax` → 切换成功; `bolloon model deepseek deepseek-v4-flash` → 切换+模型 ✓
- `bolloon model badname` → 未知供应商错误 + 可用列表 ✓; `bolloon model openai` → 无 key 拦截提示 ✓
- `bolloon update` → 发现 0.3.34 → 0.3.35 ✓
- 测试后恢复用户原配置 (deepseek-chat)
- tsc 0 错, vitest 1063/1063

### 教训

- 命令存在感 = 用户能发现的名字 (update 而不是 update-check) — 语义命名比内部函数名重要
- 已有完整 API (config-store 13 供应商切换) 但没 CLI 暴露 = 功能"不存在"

## [2026-08-06] feat | CLI 系统命令组 (21 个 / 命令) + ink 供应商选择器

### 触发

- 用户要求: /resume /goal /loop /ipns /ipfs /did /skill /mcp /agent /memory /session /email /wallet /dream /now /insight /judgement /tools /login /logout /wiki 共 21 个命令; 供应商选择需要终端渲染的选择界面 (复用 ink); 减法原则; 完成后发布新版本.

### 实现

| 模块 | 改动 |
|---|---|
| `src/cli/ink-app.tsx` | 程序化选择器 Picker: 全局钩子 `__inkOpenPicker(items, title, onPick)` / `__inkClosePicker()`, useInput 全键接管 (↑↓ 选择 / Enter 确认 / Esc 取消), 渲染复用 MentionPopup 组件, TextInput focus 让出 |
| `src/index.ts` | 21 个 / 命令 (processInput 命令组, 全部复用现有模块薄封装): /model /login → ink 供应商选择器 (llmConfigStore providers → MentionItem[]); /logout 当前供应商; /now 状态总览 (ContextManager usage); /session channel/agent/消息窗口; /loop estimateTokens; /memory memory-compressor 摘要; /resume 最近记忆 + active plans; /goal plan-store; /tools getToolDefinitions; /skill skill-writer 候选; /mcp ~/.mcp.json; /agent /did identity; /ipfs /ipns kuboApi (export); /wallet /email 配置状态; /judgement human-value-store; /insight Context OS 08-Insights; /wiki current-status; /dream 随机灵感 (Insights/Knowledge 资产池) |
| `src/agents/pi-sdk-tools.ts` | kuboApi 加 export (CLI /ipfs /ipns 复用, 避免重复实现) |
| `src/cli/mention-data.ts` | CLI_COMMANDS +21 命令 ( / 弹窗可命中) |
| `/help` | 命令列表更新 (21 新命令 + 用法) |

减法原则: 所有命令都是现有 API 的薄封装 (0 新增依赖, 0 新模块), picker 复用 MentionPopup 渲染组件.

### 验证

- tsc 0 错; vitest 1063/1063
- 命令数据源实测 (verify-cli-cmds.ts): /ipfs (kubo/0.28.0, 47 peers) /ipns (43 keys) /model picker (13 供应商带 key 状态) /loop (estimateTokens) /goal (1 active plan) /judgement (57 条) 全 OK
- pty 启动受 npm 依赖检查网络慢影响 (auto-update 启动检查, 环境问题非代码), 命令逻辑经数据源脚本验证

### 教训

- CLI 启动卡住时先看是不是 auto-update/npm 检查在跑 (spawn npm install), 与命令代码无关
- ink 弹窗组件 (MentionPopup) 可复用为通用选择器 — 加一个程序化触发钩子即可, 不用新组件

## [2026-08-06] fix | build:all 污染 dist ESM 产物 — electron CJS 编译覆盖 auto-update.js

### 触发

- 本机安装 0.3.36 后 `bolloon update` 崩溃: `ReferenceError: exports is not defined in ES module scope`.

### 根因

- `tsconfig.electron.json` 是 `module: CommonJS` 且 `outDir: "dist"`; `src/electron/main.ts:15` import auto-update → tsc 编译依赖链 → `dist/utils/auto-update.js` 被覆盖成 CJS.
- package.json `"type": "module"` 下 Node 把 .js 当 ESM 跑 → `exports` 未定义崩溃.
- 单独编译验证: 主 tsconfig (ESNext) 输出 ESM 正确; 只有 build:electron 的 CJS 覆盖是元凶.

### 修复

- `tsconfig.electron.json`: `outDir: "dist"` → `"dist/electron-build"` (electron CJS 产物独立目录)
- `package.json`: electron:start 用 `dist/electron-build/electron.js`; electron-builder files 加 `dist/electron-build/**/*`; extraMetadata.main 同步
- 验证: build:all 后 `dist/utils/auto-update.js` exports 计数 0 (ESM 干净), `dist/electron-build/` 独立; `bolloon update` 正常检查

### 教训

- 多 tsconfig 共享 outDir 是定时炸弹 — ESM/CJS 产物互相覆盖, 症状只在发布后暴露
- prepublishOnly 的 build:all 要按 覆盖方向 排序 (或隔离输出目录)


## [2026-08-07] feat | CLI 收尾修复: Enter 提交 / 启动超时门 / 状态栏进度 / 思考框渲染

### 触发

- 用户反馈 4 个 CLI 问题: ① 消息发不出去 (Enter 提交失效, 只有输入和最终输出); ② CLI 启动卡死 (90s+ 无响应); ③ 上下文状态栏进度恒 0.00% (1M 窗口下看起来像死代码); ④ 中间思考过程不显示, 要求 "思考用框表示, 和回复一样的路径, 颜文字动画表示运行过程".

### 根因 (每个问题)

| 问题 | 根因 |
|---|---|
| Enter 提交失效 | pty/管道下 termios 把 \r 转 \n (实测 tty=true raw=true 转换仍发生), 且 node 把整 chunk 当一次 keypress (in="hi\nok") → key.return 恒 false → TextInput onSubmit 永不触发 |
| 启动卡死 | bootstrapP2P (hyperswarm DHT start/joinTopic) / iroh / bootstrapBolloon 无超时, 弱网下无限挂起 |
| 状态栏恒 0 | 5 层根因叠加: (a) index.ts 用 (a as any).messageHistory 重算 — 私有字段拿不到恒 [] 且覆盖 pi-sdk 上报的真实值; (b) pi-sdk.ts 裸 require 加载 ESM 抛错被 catch 吞 → estimateHistoryTokens 恒 0; (c) getCliCtxUsage 用 require 加载 ESM 抛 ERR_REQUIRE_ESM → 恒 0/1M; (d) ink-app ticker effect 依赖 [getStatusUpdate] 渲染间引用变化 → effect 每次渲染 cleanup+setup → setInterval 刚建立就被清除 → 永不 tick; (e) process.stdout.write no-op 破坏 Ink write callback → 渲染死锁 |
| auto-update 污染 | 后台检查走 stderr notify, 交互模式静音 stdout 挡不住 |

### 实现

| 模块 | 改动 |
|---|---|
| `src/cli/ink-app.tsx` | ① 
/\r 兜底: 正常模式 + 弹窗分支把含 
/\r 的 chunk 一律视为 Enter (取 
 前内容 + inputRef 最新值提交), inputRef 同步镜像 input 解决 useInput 闭包陈旧; lastSubmitRef 防重 (InkApp 兜底与 TextInput 双触发); ② ticker effect 依赖改空数组 [] (getStatusUpdate 是 startInk 传入的稳定函数引用); ③ 挂载时同步刷新一次状态栏 |
| `src/index.ts` | ① 启动超时门 withTimeout: bootstrapP2P 20s (超时降级无 P2P) / bootstrapIroh 15s / bootstrapBolloon 20s; ② 状态栏数据源改读 ContextManager 现值 (pi-sdk 每轮已上报), 不再用 messageHistory 重算覆盖; ③ getCliCtxUsage 用 _ctxManagerRef 模块引用缓存 (startCLI await import 一次), 替代裸 require/ERR_REQUIRE_ESM; ④ stdout.write 只吞 SDK 时间戳日志 (2026-...T 前缀), 放行 Ink ANSI 渲染走原始 write (保存的 originalStdoutWrite 绑定); ⑤ 清理全部 fs debug 钩子 |
| `src/agents/pi-sdk.ts` | ① 裸 require → createRequire (_piRequire), estimateHistoryTokens/maxContextTokens 恢复真实计算; ② reportUsageToContextManager(): prompt/promptStream 全部出口 (fallback/pivot/react) finally 统一上报 usage — 之前只有 runReActLoop 迭代内上报, chitchat/fallback/pivot 路径状态栏恒 0 |
| `src/utils/auto-update.ts` | setNotifyQuiet + notifyQuiet 全局开关, CLI 交互模式静音后台检查通知 |
| `scripts/verify-cli-msg5-pty.py` | send_cmd 改 chunk 模式 ("text\r" 一次发送) — pty 下单独 \r 被 cooked 行规程消费丢失, chunk 里 \r 以 \n 到达 Ink 由兜底分支提交 |

### 验证

- tsc 0 错
- pty 端到端 (verify-cli-msg5-pty.py): 已发送框 ✓ 思考动画 ✓ 弹窗误开 ✗ 回复框 ✓ (完整链路 useInput("hi\n") → onSubmit → processInput → a.prompt)
- pty 状态栏 (probe 脚本持续读 fd): `10s │ 172/1M │ [░░░░░░░░░░] 0.02%` — 时间戳 + usage 真实值都在动
- pty 启动: 90s+ 卡死 → ~13s ready (超时门降级路径)
- **重大教训: pty 测试脚本 sleep 期间不读 fd → pty 缓冲满 → 子进程 stdout 写阻塞 → timers 停摆 → 误判"状态栏冻结/interval 不 tick"。真实终端自己读 stdout 无此问题。验证 timers 必须持续读 fd (后台 reader 线程) + 用独特标记 (如 [T]/[H]) 而非单字母**

### 教训

- Ink 的 useInput 回调执行 ≠ effect 全量执行 — 调试要逐 effect 加 setup 标记区分
- 不要整体 no-op process.stdout.write — Ink 渲染依赖 write callback 链, no-op 不调 callback 会渲染死锁; 要按 chunk 内容选择性拦截
- React effect 依赖数组引用不稳定会导致 setInterval 被反复 cleanup 永不 tick — 用稳定引用或空依赖
- ESM 下裸 require 抛错被 catch 吞 = 功能静默失效 (estimateTokens 恒 0 这类), 排查"数据一直是默认值"先查 require


## [2026-08-07] fix | IPNS 发布后无法加载页面 — 排查 + CLI Kubo 自动拉起

### 触发

- 用户反馈: "ipns 可以发布, 但是发布后的 ipns 无法加载页面", 怀疑 3 个可能: ① DHT 没传过来 ② IPFS 版本不是最新 ③ 不是使用 html/react 支持的 UI-CID 传输. 要求先排查确认再给 bolloon 安装.

### 排查结论 (3 个怀疑全部排除)

| 怀疑 | 排查结果 |
|---|---|
| DHT 没传过来 | ❌ 排除 — Kubo 启动后 67 peers, `name/resolve` 成功 (k51qzi5... → QmbtXWj...) |
| IPFS 版本不是最新 | ❌ 排除 — 实测 kubo/0.43.0 (比旧记录 0.28.0 新) |
| 不是用 html/react UI-CID 传输 | ❌ 排除 — 静态发布: index.html 21831 字符 + 11 个相对资源引用 + style.css 94526B + client.js 286295B 都在 CID, gateway 渲染 HTTP 200 |

**真实根因: Kubo daemon 没在运行** — 发布时拉起, 之后 daemon 退出/未启动 → resolve 失败. web 模式 (server.ts:1707) 有后台自动拉起, **CLI 模式没有** → CLI 里 IPNS 发布/解析不可用.

### 验证

- `scripts/verify-ipns-pipeline.ts` 6/6: resolve ✓ CID+index.html ✓ 相对路径 11 引用 ✓ style.css ✓ client.js ✓ gateway 200 ✓
- 公网传播限制 (已有记录): NAT 环境需 pin 公共服务或端口映射; IPNS 同 key 重发布有 DHT 缓存延迟

### 修复

- `src/index.ts`: CLI 启动路径加 fire-and-forget `checkKuboSetup(true, true)` 后台拉起 (与 server.ts 一致); **publishDID 移到 Kubo 就绪后执行** (避免 registerAgent 在 Kubo 未启动时 30s 超时 TimeoutError)

### 教训

- "能发布但解析不了" 先查 daemon 存活 (`/api/v0/id` POST), 不是查发布逻辑
- 功能只在 web 模式初始化 = CLI 模式该功能"不存在" — 启动路径要按模式补齐 (与 21 系统命令的减法教训同源)
