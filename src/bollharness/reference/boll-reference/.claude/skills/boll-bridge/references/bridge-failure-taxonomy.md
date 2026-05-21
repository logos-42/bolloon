# Bridge Failure Taxonomy

## Purpose

用这份表快速判断 bridge 问题属于哪一类结构病，而不是把所有症状都叫成“bridge 不稳定”。

## Surface Map

boll bridge 不是单模块，而是一条跨边界执行链：

1. backend `worker_distributed` run 被创建
2. `/api/bridge/accept` 发 lease
3. local bridge materialize task
4. Claude CLI / subprocess 执行
5. stdout / output files / bridge_output 被解析
6. `/api/bridge/events` 推进观测链
7. `/api/bridge/complete` 写终态和 artifacts

任何一步失真，最终都可能表现为“偶尔成功、偶尔失败、偶尔卡住”。

## Recurring Failure Classes

### 1. Verdict Drift

典型症状：

- 失败 run 被标成 `completed`
- placeholder delivery 被当成真实结果
- 非零退出码和真实 plan/delivery 关系不清

结构原因：

- placeholder 生成和检测不共用契约
- artifact verdict 在多处重复实现
- run final status 缺少明确中间态

优先检查：

- `bridge_agent/agent.py`
- fallback artifact 生成逻辑
- artifact truthiness / has_real_artifacts 逻辑
- backend result serialization

### 2. Event Chain Break

典型症状：

- run 卡在 `running`
- 某阶段明明完成了但前端看不到
- `complete` 没发出或发出后状态没落地

结构原因：

- phase -> event_type 映射散落
- 关键事件没有强制断言
- complete 和 heartbeat 失败路径不统一

优先检查：

- `bridge_agent/agent.py`
- `backend/product/routes/bridge.py`
- `backend/product/bridge/service.py`
- run events / ws / admin SSE 的接缝

### 3. Runtime Parity Break

典型症状：

- 本地能跑，服务器 `code=1`
- SSH 手跑成功，systemd 失败
- OAuth / PATH / HOME / TMP 在生产下不稳定

结构原因：

- 本地 shell 与 systemd runtime 不一致
- CLI 登录态、配置目录、权限边界没有进验证链
- 把 deploy 文件当文档，不当代码

优先检查：

- `bridge_agent/config*.yaml`
- `bridge_agent/deploy/boll-bridge@.service`
- `bridge_agent/deploy/RUNBOOK.md`
- journalctl 中的真实 stderr

### 4. Control Plane Drift

典型症状：

- lease ownership mismatch
- accept/heartbeat/complete 偶发 403/400
- 多实例并发下 run 被重复处理或长时间无人处理

结构原因：

- lease、compute_node、status 契约不一致
- 边界条件只在一端验证
- 并发模型和观测模型脱节

优先检查：

- `backend/product/bridge/service.py`
- `backend/product/routes/bridge.py`
- DB lease / status / heartbeat 字段

### 5. Test Illusion

典型症状：

- 本地测试全绿，线上首跑才发现主链断了
- 测了 route，但没测 worker
- 测了 CLI 局部逻辑，但没测远端 complete 路径

结构原因：

- 测试只覆盖片段，不覆盖同一系统
- 线上正在跑的边界没有本地等价验证
- 把“mock E2E”当真实 release gate

优先检查：

- 现有测试到底跳过了哪条边
- 是否有 local same-system integration
- 是否有 prod-like runtime smoke

## Anti-Patterns

- 用字符串模板充当状态机
- 在 3 处复制 verdict 逻辑再靠人同步
- 生产第一次发现问题，本地之后才补测试
- 线上靠 SSH 调试，本地没有稳定复现路径
- 把“偶发”当运气问题，不把变量清单列出来

## First Questions

每次进入 bridge 故障，先回答：

1. 失败发生在 accept、execute、report 还是 complete？
2. 失败 run 的 exit code、stderr、event timeline 是什么？
3. 成功 case 和失败 case 的环境差异是什么？
4. 当前问题属于 verdict drift、event chain break、runtime parity break、control plane drift 还是 test illusion？
5. 这次修复是在关掉故障类别，还是只改一个文案和分支？
