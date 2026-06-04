# 跨用户智能体对接 & 一次建联访问对方所有智能体

> 目标：让两个用户各自启动的 Bolloon 智能体，在「交换一次节点 ID」之后，
> 智能体可以自动完成交流；并且在已经建联过的用户之间，可以由
> 文档/能力清单驱动，自动和**对方所有智能体**进行深度协作。
>
> 本文既是当前 core 功能的测试方案，也是 "建联一次访问所有智能体" 的工程化路线图。

---

## 0. 一句话总结

**当前代码已经基本够用，但缺四块砖：**

1. **统一入口 `node-id exchange`**：B 收到 A 的 `iroh nodeId` 后，自动解析 DID 文档 → 拿到 A 的所有服务/service endpoint → 自动建联。
2. **`agent-manifest` 协议消息**：节点连上之后，立刻发一份 "我有哪几个 agent，能力是什么，sessionId 是什么" 的清单。
3. **DOC-驱动委派**：B 的 web/CLI 收到 "把这个想法给 A" 的指令，能直接 pick 目标 agent → 走 `agent_delegate` 协议。
4. **本地回退 + 离线队列**：`irohTransport` 已经支持 `messageStore`，但全局还没接；现在的 demo/test 都是同进程或直连。

> 也就是说：**IPNS 后续能否跑通不是关键阻塞**——可以用 CID 缓存 + 定期 refresh 顶替。
> 真正的"建联一次访问所有智能体"走的是 **agent-manifest 协议**（节点间即时互换能力清单），IPNS 只是"冷启动 / 离线 N 天后再连"的兜底。

---

## 1. 当前架构（已读完的代码）

| 组件 | 路径 | 关键能力 |
|---|---|---|
| P2P 底层（libp2p + Hyperswarm） | `src/network/p2p.ts`, `src/index.ts` | libp2p + Hyperswarm 双栈，节点持久化、自动重连 |
| Iroh 传输 | `src/network/iroh-transport.ts` | iroh ALPN `bolloon/iroh/1`；节点 ID = `Endpoint.nodeId()`；`sendMessage(nodeId, type, payload)` / `requestResponse` / 离线持久化队列 |
| 多传输选择 | `src/network/hybrid-messenger.ts` | 按 `type + payloadSize + priority` 选 `iroh / libp2p / hyperswarm`；支持 `onMessage(type, handler)` 和 `onWildcard` |
| DID 身份 & 注册 | `@diap/sdk` (0.1.10) | `KeyManager` Ed25519 → `did:key:…`；`AgentAuthManager.registerAgent` → 上传 IPFS 拿 CID；`keyName = "did-<DID>"` 同步产出 IPNS 名 |
| 节点↔DID 解析 | `src/network/iroh-integration.ts`, `iroh-bootstrap.ts`, `iroh-discovery.ts` | `start()` 拿 iroh nodeId → 写进 `services[].endpoint` 上传 IPFS |
| 身份文档解析 | `src/social/channels/diap-doc-parser.ts` | `parseFromCID(cid)` / `parseFromIPNS(name)`；提取 `capabilities / interests / channels / peerId / multiaddrs / relayAddr` |
| 智能体注册表 | `src/network/agent-network.ts` | 本地 `~/.bolloon/agent-registry.json`；`SignedMessage` 签名验证；`connectToAgent(did)` 走 multiaddrs → relay 三级 fallback |
| 子智能体 | `src/agents/subagent-manager.ts`, `src/social/global-shared-context.ts` | 多 agent 注册表（`agentRegistry[agentId] -> {did, peerId, cid, ipnsName, capabilities, …}`） |
| 聊天/异步通道 | `src/agents/p2p-chat-tools.ts` | `agent_chat` 消息类型 + `~/.bolloon/inbox/<peerDID>.jsonl` 持久化 + draft 引擎 |
| 文档传输 | `src/agents/p2p-document-tools.ts` | `document_chunk` 分块（60KB） + `ai_feedback` 回送摘要 + 接收后自动调 LLM 解析 |
| 频道心跳发现 | `src/social/channels/channel-heartbeat-agent.ts` | 30s 心跳 + `publishPersona` 上传 IPFS → publishIpns；`agent_discovery` 广播 |
| 协作工作流 | `src/workflows/collaboration.ts` | `CommandParser` 关键字识别协作意图；`DIDRegistry` + `discoverAgents()` |
| Web API | `src/web/server.ts` | `/api/connect` 接受 `did|cid|ipnsName` 三种入参；`/api/chat/*` 操作 inbox；`/api/message-p2p` 发送 |

**已经能跑通：** 单条 ping/pong、agent_chat 单条、document_chunk 整篇传输、心跳发自己的 IPNS 公告。

**明显缺：** "**我连上你之后，立刻知道你有几个 agent**" 这条协议消息。

---

## 2. 双实例对接 core 测试（**今天就能跑**）

### 2.1 测试目标
- 终端 A `npx tsx src/test/p2p-minimal-test.ts` → 拿到 nodeId/pubKey
- 终端 B `npx tsx src/test/p2p-minimal-test.ts --connect <A的节点 ID>` → 双方互发 `message` / `response`
- 升级版：`iroh-e2e.ts` server / client，验证任务投递 + 回包

### 2.2 跑测试前要做的准备

1. **确认本机有 IPFS daemon**（DIAP SDK 需要 `http://127.0.0.1:5001`）
   - 装 [Kubo](https://docs.ipfs.tech/install/command-line/) 或 `ipfs-desktop`
   - `ipfs daemon` 起好，访问 `http://127.0.0.1:5001/api/v0/version` 有返回
2. **确认本机有 iroh endpoint**（`@rayhanadev/iroh` 内部跑 `n0`，自动发现节点）
3. **iroh 节点 ID 不是持久的**——重启会变。`IrohTransport.start(secretKey?)` 接受 secretKey 持久化（见 `iroh-transport.ts:95`），但**当前实现没把 secretKey 落盘**——这就是后续要补的。

### 2.3 推荐测试顺序

| 顺序 | 文件 | 验证什么 | 通过判据 |
|---|---|---|---|
| 1 | `p2p-minimal-test.ts` | Hyperswarm 主题直连 + 文本消息 | 两端互看到对方消息和自动回复 |
| 2 | `iroh-e2e.ts server` + `client <id>` | iroh 直连 + ping/pong + task/response | 客户端收到 server 的 pong/response |
| 3 | `p2p-cid-connect-test.ts --initiator` / `--cid=<…>` | CID → DID 文档解析 | 电脑 B 看到 `name / capabilities` |
| 4 | `p2p-doc-transfer.ts server/client` | 文档分块传输 | server 收到 md/yaml/html 3 篇 + client 收到 ack |
| 5 | `p2p-ai-dialogue-test.ts` | AI 双轮对话 | 两端都有完整对话日志 |
| 6 | **`agent_manifest_exchange`（新写）** | 节点握手后立刻互换 agent 清单 | B 端控制台打印 A 的 `agents: [{id, name, capabilities, sessionId}]` |

### 2.4 第 6 步"agent 清单握手"最小实现

写到 `src/test/agent-manifest-exchange.ts`：

```typescript
// —— A 端 ——
irohTransport.onMessage('manifest_request', async (msg) => {
  const manifest = await buildOwnManifest();   // 读取 subagent-manager + global-shared-context
  await irohTransport.sendMessage(msg.from, 'manifest_payload',
    new TextEncoder().encode(JSON.stringify(manifest)));
});
irohTransport.onMessage('manifest_payload', (msg) => {
  const m = JSON.parse(new TextDecoder().decode(msg.payload));
  console.log('[A] 收到 B 的 manifest:', m.agents.map(a => a.name).join(', '));
});

// —— B 端 ——
irohTransport.sendMessage(targetId, 'manifest_request',
  new TextEncoder().encode('{}'));
```

```typescript
// 共享：buildOwnManifest()
async function buildOwnManifest() {
  const { getSubAgentManager } = await import('../agents/subagent-manager.js');
  const { getGlobalSharedContext } = await import('../social/global-shared-context.js');
  const mgr = getSubAgentManager();
  const ctx = await getGlobalSharedContext();
  return {
    ownerDid: mgr.ownDid,
    ownerName: mgr.ownName,
    agents: mgr.list().map(a => ({
      id: a.id, name: a.name, did: a.did, peerId: a.peerId,
      capabilities: a.capabilities, status: a.status,
      cid: a.cid, ipnsName: a.ipnsName,
    })),
    sharedContext: { recentActions: ctx.memory.recentActions.slice(-10) },
    publishedAt: Date.now(),
  };
}
```

> **注意：** 走 `peerId` 而非 `did:key:...` 是因为 iroh 的 `nodeId` 在重启后会变，
> 真正的稳定身份要靠 `did:key:`（Ed25519 公钥）。本测试里两个进程**各自启动 iroh**，
> 节点 ID 是即时的，**这正是后续要落盘的 secretKey 的用处**。

---

## 3. "建联一次访问对方所有智能体" 设计

### 3.1 三层机制

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3: 冷启动兜底（IPNS / CID 缓存）                                  │
│   • A 不知 B 的 iroh nodeId（被防火墙 / 重启）                           │
│   • 通过 A 的 DID → IPNS → 最新 CID → DID Doc → 拿所有 service.endpoint  │
│   • 必要但低频 (离线 N 天 / 节点迁移时)                                   │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 2: 节点握手 manifest（**核心，常态**）                               │
│   • A 拿到 B 的 iroh nodeId → connect → 立刻收 'manifest_payload'         │
│   • manifest = B 的所有 subagent + capabilities + 状态                    │
│   • A 把 manifest 落 GlobalSharedContext.agentRegistry                  │
│   • 之后 A 的任何指令都能"按能力挑 agent"                                  │
├──────────────────────────────────────────────────────────────────────┤
│ Layer 1: 直连 P2P（已在跑）                                              │
│   • irohTransport.sendMessage(targetNodeId, 'agent_chat' | 'doc_chunk') │
│   • 不需要 manifest，但必须知道**目标 agent 所在的节点 iroh nodeId**         │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 为什么 IPNS 不是关键

- IPNS 在 DIAP SDK 里 `keyName = "did-<DID>"`（见 `did-builder.js:154`），**同一个 DID 每次启动拿到的 IPNS name 相同**（基于 Ed25519 公钥派生的稳定 key）。
- 当前 `index.ts:174 publishDID()` 已经有 60s × 10 次后台重试，**失败也不阻塞本地模式运行**（`⚠ IPNS发布重试结束，本地模式运行`）。
- 即使 IPNS 100% 失败：
  - 在双方**任一时刻在线且曾连过**的前提下，**Layer 2 manifest 已经把对方 agent 清单缓存到本地**，
  - 重启时只需要再连一次（拿新 nodeId）就能恢复。
- IPNS 的价值在「双方都下线 N 天后，**首次**重新拉取对方列表」——这个场景可以用 CID 缓存 + 定期 `republish` 顶替。

### 3.3 建联一次后访问对方所有 agent 的工程步骤

**Step 1：持久化 iroh nodeId（解决"重启节点 ID 变"）**
- 在 `~/.bolloon/iroh-secret.json` 存 `secretKey`（用 `irohTransport.start(secretKey, …)` 注入）
- `start()` 时若文件存在则读取，否则用 `crypto.randomBytes(32)` 生成并落盘
- 这样**同一台机器每次启动节点 ID 相同**

**Step 2：实现 manifest 协议**（test 里已经写了最小版）
- 新增 `src/agents/agent-manifest.ts`：
  - `buildOwnManifest(): Promise<AgentManifest>`
  - `irohTransport.onMessage('manifest_request', reply)`
  - `requestPeerManifest(nodeId): Promise<AgentManifest>`
- `AgentManifest` 形态：
  ```ts
  {
    ownerDid, ownerName,
    agents: [{
      id, name, did, peerId, irohNodeId,
      capabilities: string[],
      status: 'active'|'idle'|'busy',
      cid?, ipnsName?, sessionId?,
    }],
    publishedAt, ttl
  }
  ```

**Step 3：接入 GlobalSharedContext**
- `syncFromManifest(remoteManifest, remoteIrohNodeId)` → 写入 `agentRegistry[agentId]`
- 本地查询时 `pickAgent(capability: string, preferredOwnerDid?: string)`
- 缓存到 `~/.bolloon/peer-manifests/<ownerDid>.json` 兜底

**Step 4：DOC 驱动自动交流**
- 用户对 Bolloon 说："把这个想法交给 A 的写作 agent"
- `CommandParser`（`workflows/collaboration.ts`）解析 → `pickAgent('writing', preferredOwnerDid='A')`
- → 找到 A.写作-agent → 走 iroh `agent_delegate` 协议：
  ```ts
  {
    type: 'agent_delegate',
    fromAgentId, toAgentId, toOwnerDid,
    docCid: <想法文档上传 IPFS 的 CID>,
    instruction: '请基于这份想法草拟写作大纲',
    expectedReplyType: 'agent_response',
  }
  ```
- 接收方 `agent_delegate` 处理函数：
  1. 从 IPFS 拉文档
  2. 路由到本地 capability 匹配的 subagent
  3. 执行 → 写回 `agent_response` 携带 resultCid
- 发送方收到 `agent_response` → 落 `cooperationQueue` → 用户上线可见

**Step 5：web/CLI 前置化**（让用户"设计一点文档"就能跑）
- 新增 `POST /api/agent/delegate` 接受：
  ```json
  {
    "toOwnerDid": "did:key:...",
    "docPath": "/local/path",
    "instruction": "...",
    "capability": "writing"
  }
  ```
- 后端：读 doc → 走 IPFS → 调 step 4

### 3.4 关键文件改动清单（待实施）

| 文件 | 改动 |
|---|---|
| `src/network/iroh-transport.ts` | `start()` 自动从 `~/.bolloon/iroh-secret.json` 读/写 secretKey |
| `src/agents/agent-manifest.ts` **(new)** | `buildOwnManifest` / `requestPeerManifest` / `onManifestRequest` |
| `src/network/agent-network.ts` | 注册 `manifest_request` / `manifest_payload` handler；`connectToAgent` 成功后自动请求 manifest |
| `src/social/global-shared-context.ts` | `syncFromManifest(remote, remoteIrohNodeId)`；`pickAgent(capability, ownerDid?)` |
| `src/workflows/collaboration.ts` | `CommandParser` 接入 manifest；`executeDelegation(plan)` |
| `src/agents/agent-delegate.ts` **(new)** | `agent_delegate` / `agent_response` 协议 + 路由到本地 subagent |
| `src/web/server.ts` | `POST /api/agent/delegate`、`GET /api/peers/manifests` |
| `src/test/agent-manifest-exchange.ts` **(new)** | 端到端测试 |

### 3.5 测试矩阵（上线前必跑）

| 场景 | 命令 / 流程 | 通过条件 |
|---|---|---|
| 同一台机两实例对接 | 两个终端分别 `tsx src/test/agent-manifest-exchange.ts` + 互相传 nodeId | 双方均能列出对方的 agent |
| 节点 A 重启 | A 重启后 `iroh-secret.json` 命中，nodeId 不变 | B 端无感（继续用旧 nodeId 投递） |
| 节点 A 重启 + 换机器 | A 旧 nodeId 失效 | B 第一次发消息失败 → fallback 到 Layer 3 拉新 IPNS → 拿到新 nodeId → 重发 |
| DOC 驱动委派 | web `/api/agent/delegate` 提交 doc | 接收方 agent 处理后回 `agent_response`，发送方 `cooperationQueue` 有 done |
| 全员列表 | A 端 `/api/peers/manifests` | 返回所有已建联用户的 agent 清单 |

---

## 4. 风险 & 兜底

| 风险 | 影响 | 兜底 |
|---|---|---|
| iroh nodeId 重启变 | 对方缓存的 nodeId 失效 | 落 `iroh-secret.json`；不命中就走 Layer 3 IPNS |
| IPNS 长时间不发布成功 | 冷启动拿不到最新 CID | CID 缓存 + `cooperationQueue` 等待重试 + 推送时附带 CID 兜底 |
| iroh NAT 穿透失败 | 直连打不通 | `IrohIntegration` 已注册 `iroh-quic` + circuit-relay-v2（`p2p.ts`）；远端可达时走中继 |
| 文档太大 | 60KB 一片要传很久 | `HybridMessenger` 按 `largeThresholdBytes=64KB` 自动切到 iroh，且 `p2p-document-tools.ts` 已经分块 |
| 对方 agent 一直不在线 | 任务堆积 | `messageStore` 已有 5s retry × 10 次重试；超限入死信队列 |
| 同一用户多 agent 内部协调 | 任务分发错乱 | 走 `GlobalSharedContext.cooperationQueue`（`createdAt` 排序，状态机） |

---

## 5. 立即可执行清单（**今天**）

- [ ] 装 IPFS daemon + 起 5001 / 8080
- [ ] 跑 `p2p-minimal-test.ts` 两端直连
- [ ] 跑 `iroh-e2e.ts` 两端直连
- [ ] 跑 `p2p-doc-transfer.ts` 验文档
- [ ] 写 `agent-manifest-exchange.ts` test，跑通后并入 `npm run test`
- [ ] 写 `iroh-secret.json` 落盘改造，**单测**验证"重启后 nodeId 不变"
- [ ] 接入 web `/api/agent/delegate`（最小版即可）

完成上述即可宣告 "**建联一次，文档驱动跨用户多 agent 协作**" 的 v0 上线。
IPNS 在这之后作为渐进增强补上即可。
