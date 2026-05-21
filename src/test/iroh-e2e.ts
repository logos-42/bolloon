import { irohTransport } from '../network/iroh-transport.js';

async function main() {
  const args = process.argv.slice(2);
  const role = args[0] as 'server' | 'client';
  const targetNodeId = args[1];

  if (!role || !['server', 'client'].includes(role)) {
    console.log('Usage:');
    console.log('  Server: npx tsx src/test/iroh-e2e.ts server');
    console.log('  Client: npx tsx src/test/iroh-e2e.ts client <server-node-id>');
    process.exit(1);
  }

  if (role === 'server') {
    console.log('[Server] Starting...');
    const node = await irohTransport.start();
    console.log('[Server] Node ID:', node.nodeId);
    console.log('[Server] Waiting 60s for connections...');

    irohTransport.onMessage('ping', (msg) => {
      console.log(`[Server] Got ping from ${msg.from.substring(0, 12)}...`);
      irohTransport.sendMessage(msg.from, 'pong', new TextEncoder().encode('pong'));
    });

    irohTransport.onMessage('task', (msg) => {
      console.log(`[Server] Got task: "${new TextDecoder().decode(msg.payload).substring(0, 50)}..."`);
      irohTransport.sendMessage(msg.from, 'response', new TextEncoder().encode('task received'));
    });

    await new Promise(resolve => setTimeout(resolve, 60000));
    await irohTransport.shutdown();
  } else {
    if (!targetNodeId) {
      console.error('[Client] Need server node ID');
      process.exit(1);
    }

    console.log('[Client] Starting...');
    const node = await irohTransport.start();
    console.log('[Client] Node ID:', node.nodeId);
    console.log('[Client] Connecting to:', targetNodeId.substring(0, 12), '...');

    await new Promise(resolve => setTimeout(resolve, 500));

    // 发送 ping
    console.log('[Client] Sending ping...');
    await irohTransport.sendMessage(targetNodeId, 'ping', new TextEncoder().encode('hello'));

    // 发送 task
    await new Promise(resolve => setTimeout(resolve, 300));
    console.log('[Client] Sending task...');
    const task = JSON.stringify({ id: '123', type: 'summarize', documentPath: '/test.pdf' });
    await irohTransport.sendMessage(targetNodeId, 'task', new TextEncoder().encode(task));

    // 等待响应
    irohTransport.onMessage('pong', (msg) => {
      console.log('[Client] Got pong:', new TextDecoder().decode(msg.payload));
    });

    irohTransport.onMessage('response', (msg) => {
      console.log('[Client] Got response:', new TextDecoder().decode(msg.payload));
    });

    await new Promise(resolve => setTimeout(resolve, 3000));
    await irohTransport.shutdown();
    console.log('[Client] Done');
  }
}

main().catch(console.error);
