/**
 * P2P Minimal Test - 判断力智能体 P2P 通信测试
 *
 * 运行方式:
 *   电脑 A: npx tsx src/test/p2p-minimal-test.ts
 *   电脑 B: npx tsx src/test/p2p-minimal-test.ts --connect <电脑A的NodeId>
 *
 * 测试流程:
 * 1. 生成 DIAP 身份
 * 2. 发布 DID 到 IPFS
 * 3. 连接对方节点（或等待连接）
 * 4. 交换 AI 消息（带判断力注入）
 */

import crypto from 'node:crypto';
import readline from 'node:readline';
import { KeyManager } from '@diap/sdk';
import { createHyperswarmCommunicator, createTopic, HyperswarmCommunicator, type P2PConnection, type P2PMessage } from '@diap/sdk';

const IPFS_API = 'http://127.0.0.1:5001';
const IPFS_GATEWAY = 'http://127.0.0.1:8080';

// 简单的消息协议
interface P2PProtocol {
  type: 'hello' | 'message' | 'response' | 'ping' | 'pong';
  from: string;
  content?: string;
  timestamp: number;
}

function parseArgs(): { connectTo?: string } {
  const args = process.argv.slice(2);
  const connectIdx = args.indexOf('--connect');
  return {
    connectTo: connectIdx >= 0 ? args[connectIdx + 1] : undefined
  };
}

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║         P2P Minimal Test - 判断力智能体 P2P 通信        ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const args = parseArgs();

  // 1. 生成 DIAP 身份
  console.log('[1/5] 生成 DIAP 身份...');
  const keyManager = KeyManager.generate();
  const did = keyManager.did;
  const username = process.env.USER || process.env.USERNAME || 'user';
  const agentName = `blln-${username.toLowerCase()}-${did.split(':').pop()?.substring(0, 4)}`;
  console.log(`    DID: ${did}`);
  console.log(`    名称: ${agentName}`);

  // 2. 注册到 IPFS
  console.log('\n[2/5] 注册 DID 到 IPFS...');
  let ipfsCid: string | null = null;
  try {
    const { AgentAuthManager } = await import('@diap/sdk');
    const authManager = await AgentAuthManager.newWithRemoteIpfs(IPFS_API, IPFS_GATEWAY);
    const result = await authManager.registerAgent({ name: agentName, services: [] }, keyManager, '');
    ipfsCid = result.cid || null;
    console.log(`    ✅ IPFS CID: ${ipfsCid || '未获取到'}`);
  } catch (e) {
    console.log(`    ⚠️  IPFS 注册失败（本地模式继续）: ${(e as Error).message}`);
  }

  // 3. 创建 P2P 通信器
  console.log('\n[3/5] 初始化 P2P 网络...');
  const rawSeed = crypto.getRandomValues(new Uint8Array(32));
  const comm = createHyperswarmCommunicator({
    server: true,
    client: true,
    autoConnect: true,
    maxConnections: 10,
    seed: rawSeed as any
  });

  const topic = createTopic('bolloon-judgment-test-v1') as Buffer;
  await comm.joinTopic(topic);

  console.log(`    ✅ 已加入主题: ${topic.slice(0, 8).toString('hex')}...`);
  console.log(`    📋 你的节点 ID: ${(comm as any).publicKey?.substring(0, 16) || '生成中...'}`);

  // 消息处理
  const messageQueue: P2PProtocol[] = [];
  let peerConnection: P2PConnection | null = null;

  comm.on('connection', (conn: P2PConnection) => {
    const shortKey = conn.publicKey.substring(0, 8);
    console.log(`\n    🔌 新连接: ${shortKey}...`);

    if (!peerConnection) {
      peerConnection = conn;
      console.log('    ✅ 已建立连接');
    }

    // 发送 hello
    const hello: P2PProtocol = {
      type: 'hello',
      from: agentName,
      content: `你好！我是 ${agentName}`,
      timestamp: Date.now()
    };
    sendMessage(conn, hello);
  });

  comm.on('message', (msg: P2PMessage, conn: P2PConnection) => {
    const content = new TextDecoder().decode(msg.content);
    try {
      const data: P2PProtocol = JSON.parse(content);
      handleMessage(data, conn);
    } catch {
      console.log(`\n    📩 收到原始消息: ${content.substring(0, 100)}`);
    }
  });

  // 连接远程节点
  if (args.connectTo) {
    console.log(`\n[4/5] 连接到远程节点: ${args.connectTo}...`);
    try {
      await comm.joinPeer(args.connectTo as any);
      console.log('    ✅ 连接请求已发送，等待对方响应...');
    } catch (e) {
      console.log(`    ⚠️ 连接失败: ${(e as Error).message}`);
    }
  } else {
    console.log('\n[4/5] 等待连接...');
  }

  // 5. 交互界面
  console.log('\n[5/5] P2P 交互模式');
  console.log('    ─────────────────────────────────────────────────');
  console.log('    输入消息发送到对方，或输入以下命令:');
  console.log('      /peers   - 查看已连接节点');
  console.log('      /cid     - 显示本机 IPFS CID');
  console.log('      /nodeid  - 显示本机节点 ID');
  console.log('      /quit    - 退出');
  console.log('    ─────────────────────────────────────────────────\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = () => {
    rl.question(`[${agentName}] > `, async (input) => {
      const trimmed = input.trim();

      if (trimmed === '/quit') {
        console.log('再见！');
        rl.close();
        process.exit(0);
      } else if (trimmed === '/peers') {
        const connections = (comm as any).connections;
        if (connections) {
          console.log(`    已连接节点数: ${connections.size}`);
          for (const [k, v] of connections) {
            console.log(`      - ${(v as any).publicKey?.substring(0, 16) || k}...`);
          }
        } else {
          console.log('    暂无连接');
        }
        prompt();
      } else if (trimmed === '/cid') {
        console.log(`    IPFS CID: ${ipfsCid || '未注册'}`);
        prompt();
      } else if (trimmed === '/nodeid') {
        const nodeId = (comm as any).publicKey;
        console.log(`    节点 ID: ${nodeId || '生成中'}`);
        prompt();
      } else if (trimmed) {
        // 发送消息
        if (peerConnection) {
          const msg: P2PProtocol = {
            type: 'message',
            from: agentName,
            content: trimmed,
            timestamp: Date.now()
          };
          sendMessage(peerConnection, msg);
          console.log(`    ✅ 消息已发送`);
        } else {
          console.log('    ⚠️  暂无连接，消息已加入队列');
          messageQueue.push({
            type: 'message',
            from: agentName,
            content: trimmed,
            timestamp: Date.now()
          });
        }
        prompt();
      } else {
        prompt();
      }
    });
  };

  // 定期检查连接
  setInterval(() => {
    if (!peerConnection) {
      const connections = (comm as any).connections;
      if (connections && connections.size > 0) {
        for (const [k, v] of connections) {
          const conn = v as P2PConnection;
          if (conn && conn.publicKey) {
            peerConnection = conn;
            console.log('\n    🔗 检测到新连接！');

            // 发送队列中的消息
            while (messageQueue.length > 0) {
              const queued = messageQueue.shift()!;
              sendMessage(peerConnection, queued);
            }
            break;
          }
        }
      }
    }
  }, 2000);

  prompt();
}

function sendMessage(conn: P2PConnection, msg: P2PProtocol) {
  const data = JSON.stringify(msg);
  conn.send(new TextEncoder().encode(data));
}

function handleMessage(msg: P2PProtocol, conn: P2PConnection) {
  switch (msg.type) {
    case 'hello':
      console.log(`\n    👋 收到问候: ${msg.content}`);
      break;
    case 'message':
      console.log(`\n    💬 ${msg.from}: ${msg.content}`);
      // 自动回复
      const response: P2PProtocol = {
        type: 'response',
        from: 'bot',
        content: `[自动回复] 收到你的消息: "${msg.content?.substring(0, 50)}..."`,
        timestamp: Date.now()
      };
      sendMessage(conn, response);
      break;
    case 'response':
      console.log(`\n    🤖 ${msg.from}: ${msg.content}`);
      break;
    case 'ping':
      console.log(`\n    🏓 收到 Ping`);
      sendMessage(conn, { type: 'pong', from: 'bot', timestamp: Date.now() });
      break;
    case 'pong':
      console.log(`\n    🏓 收到 Pong`);
      break;
    default:
      console.log(`\n    📩 收到消息: ${JSON.stringify(msg)}`);
  }
}

main().catch(e => {
  console.error('\n❌ 错误:', e.message);
  process.exit(1);
});