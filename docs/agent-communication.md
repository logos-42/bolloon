# 智能体P2P通讯指南

## 架构概述

```
┌─────────────────────────────────────────────────────────────────┐
│                        P2P Network                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │  Agent A     │◄──►│  Relay/Boot  │◄──►│  Agent B     │      │
│  │  did:xxx     │    │  bootstrap   │    │  did:yyy     │      │
│  │  (签名验证)  │    │              │    │  (签名验证)  │      │
│  └──────────────┘    └──────────────┘    └──────────────┘      │
│         │                                           │            │
│         ▼                                           ▼            │
│  ┌──────────────┐                        ┌──────────────┐        │
│  │  agent-      │                        │  agent-      │        │
│  │  registry    │                        │  registry    │        │
│  │  (持久化)    │                        │  (持久化)    │        │
│  └──────────────┘                        └──────────────┘        │
│         │                                           │            │
│         ▼                                           ▼            │
│  ┌──────────────┐                        ┌──────────────┐        │
│  │  keypair.json│                        │  keypair.json│        │
│  │  (DID密钥)   │                        │  (DID密钥)   │        │
│  └──────────────┘                        └──────────────┘        │
└─────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. AgentRegistry (`src/network/agent-network.ts`)
- 维护已知智能体的注册表
- 存储每个智能体的 DID、peerId、multiaddrs、公钥
- 使用 DIAP SDK 的 `KeyManager` 进行签名/验证
- 持久化到 `~/.bolloon/agent-registry.json`
- 密钥对持久化到 `~/.bolloon/keypair.json`

### 2. AgentMessaging
- 发送签名消息到指定智能体
- 验证接收消息的签名
- 广播消息到所有在线智能体
- 支持中继消息（Relay）穿透NAT

### 3. P2PNetwork (`src/network/p2p.ts`)
- libp2p 底层P2P连接管理
- 节点持久化和自动重连
- 消息格式: `DID:<did>|type:payload` 或 `signed:{"type":"...","from":"...","signature":"..."}`

## DID签名机制

### 密钥管理
```typescript
import { KeyManager } from '@diap/sdk';

// 生成密钥对（Ed25519）
const kp = KeyManager.generate();
// kp.did = "did:key:xxx..."
// kp.publicKey = Uint8Array(32)
// kp.privateKey = Uint8Array(32)

// 签名
const signature = await KeyManager.sign(kp, data);

// 验证
const isValid = await KeyManager.verify(kp, data, signature);
```

### 签名消息格式
```typescript
interface SignedMessage {
  type: string;        // 消息类型: task, response, discovery, address_broadcast
  from: string;        // 发送者DID
  name: string;        // 发送者名称
  payload: string;     // 消息内容
  timestamp: number;    // 时间戳
  signature: string;    // 十六进制编码的签名
}
```

### 地址广播签名
```typescript
interface AddressBroadcast {
  type: 'address_broadcast';
  from: string;        // DID
  name: string;        // 智能体名称
  peerId: string;      // libp2p peerId
  multiaddrs: string[];// 监听地址列表
  timestamp: number;
  signature: string;    // 对上述字段的签名
}
```

## 初始化流程

```typescript
import { initializeAgentNetwork, agentRegistry, agentMessaging } from './network/agent-network.js';
import { p2pNetwork } from './network/p2p.js';

// 1. 创建P2P节点
const node = await p2pNetwork.createNode({
  bootstrapPeers: ['/ip4/x.x.x.x/tcp/4001/p2p/Qmxxx...']
});

// 2. 初始化智能体网络（自动生成/加载DID密钥）
await initializeAgentNetwork(
  'did:key:fallback',  // 如果没有密钥对使用的DID
  'MyAgent',           // 智能体名称
  node.peerId,         // libp2p peerId
  node.multiaddrs       // 监听地址
);

// 3. 注册签名消息处理器
agentMessaging.registerHandler('task', async (data, from, did) => {
  // did 是验证过的签名发送者DID
  console.log(`收到来自 ${did} 的签名任务消息`);
  // 处理任务...
});
```

## 发送消息

### 签名消息（推荐）
```typescript
// 发送签名任务给特定智能体（自动签名）
const success = await agentMessaging.sendSignedToAgent(
  'did:key:target-did',
  'task',
  JSON.stringify({ type: 'summarize', documentPath: '/path/to/doc.pdf' })
);
```

### 发送普通消息（无签名验证）
```typescript
// 用于内部网络或已信任的连接
await agentMessaging.sendToAgent(
  'did:key:target-did',
  'ping',
  'hello'
);
```

### 广播消息
```typescript
// 广播公告给所有在线智能体（签名）
await agentMessaging.broadcastToAll(
  'announcement',
  '系统将于今晚进行维护'
);
```

## 地址广播机制

智能体定期广播自己签名的地址信息（每5分钟）：

```typescript
const broadcast = await agentRegistry.createSignedBroadcast();
// {
//   type: 'address_broadcast',
//   from: 'did:key:xxx',
//   name: 'MyAgent',
//   peerId: 'Qmxxx...',
//   multiaddrs: ['/ip4/x.x.x.x/tcp/4001', ...],
//   timestamp: 1716038400000,
//   signature: 'abc123...'
// }
```

接收方验证签名后才更新注册表。

## 中继（Relay）机制

当两个智能体无法直接连接时（如NAT后面），可以通过已连接的节点中继消息：

```typescript
// 中继消息，最多3跳
await agentRegistry.relayMessage(
  targetDid,
  new TextEncoder().encode(messageData),
  fromDid,
  0  // hop count
);
```

## 密钥持久化

```
~/.bolloon/
├── keypair.json           # Ed25519 密钥对 (DID身份)
├── peer-store.json         # libp2p 节点持久化
├── agent-registry.json      # 智能体注册表 (含公钥)
└── sessions/
    ├── discovered-agents.json  # 发现的智能体
    └── local-channels.json     # 对话频道
```

**注意**: `keypair.json` 中的私钥是明文存储的，请确保目录权限安全。

## 签名验证流程

```
发送方:                                    接收方:
  │                                           │
  │  1. 创建消息结构体                         │
  │  2. 计算 SHA256 哈希                      │
  │  3. 用私钥签名哈希 → signature            │
  │  4. 发送 {msg, signature} ──────────────►│
  │                                           │ 5. 从agent-registry查找发送者公钥
  │                                           │ 6. 计算收到的消息的哈希
  │                                           │ 7. 用公钥验证签名
  │                                           │ 8. 验证通过 → 处理消息
  │                                           │    验证失败 → 拒绝消息
```

## 两个智能体建立连接示例

### Agent A (alice)
```typescript
// alice 启动
const aliceNode = await p2pNetwork.createNode();
await initializeAgentNetwork(
  'did:key:fallback',  // 不使用，会自动生成
  'Alice',
  aliceNode.peerId,
  aliceNode.multiaddrs
);

// 获取自己的DID
const keyPair = agentRegistry.getKeyPair();
console.log(`Alice DID: ${keyPair.did}`);

// 广播地址
await broadcastOwnAddress();

// 等待来自 Bob 的连接
agentMessaging.registerHandler('task', (data, from, did) => {
  console.log(`收到来自 ${did} 的任务`);
});
```

### Agent B (bob)
```typescript
// Bob 启动
const bobNode = await p2pNetwork.createNode();
await initializeAgentNetwork(
  'did:key:fallback',
  'Bob',
  bobNode.peerId,
  bobNode.multiaddrs
);

// 获取自己的DID
const keyPair = agentRegistry.getKeyPair();
console.log(`Bob DID: ${keyPair.did}`);

// 广播地址
await broadcastOwnAddress();

// 等待一段时间让广播传播
await new Promise(r => setTimeout(r, 60000));

// Bob 发现 Alice 并连接（需要Alice的DID）
await findAndConnectToAgent('did:key:alice-did'); // 需要知道Alice的DID

// Bob 发送签名消息给 Alice
await sendMessageToAgent(
  'did:key:alice-did',
  'task',
  JSON.stringify({ type: 'summarize', documentPath: '/path/to/doc.pdf' })
);
```

## 引导节点配置

启动时可以通过 bootstrapPeers 参数连接引导节点：

```typescript
const node = await p2pNetwork.createNode({
  bootstrapPeers: [
    '/ip4/123.456.789.0/tcp/4001/p2p/QmBootstrap1...',
    '/ip4/123.456.789.1/tcp/4001/p2p/QmBootstrap2...'
  ]
});
```

## 注意事项

1. **私钥安全**: `keypair.json` 包含明文私钥，请妥善保管
2. **DID共享**: 建立连接前需要某种方式共享彼此的DID（如通过引导节点）
3. **NAT穿透**: 当前版本依赖引导节点帮助建立连接
4. **离线消息**: 签名消息在重新连接后会自动投递（如果连接恢复）
5. **时间戳验证**: 消息时间戳超过24小时会被拒绝