import { irohTransport } from '../network/iroh-transport.js';

const args = process.argv.slice(2);
const role = args[0] as 'server' | 'client';
const targetNodeId = args[1];

if (!role || !['server', 'client'].includes(role)) {
  console.log('Usage:');
  console.log('  Server: npx tsx src/test/iroh-e2e.ts server');
  console.log('  Client: npx tsx src/test/iroh-e2e.ts client <server-node-id>');
  process.exit(1);
}

async function runServer() {
  console.log('[Server] Starting iroh transport...');
  const node = await irohTransport.start();
  console.log('[Server] Node ID:', node.nodeId);
  console.log('[Server] Waiting for connections...\n');

  let msgCount = 0;

  irohTransport.onMessage('ping', (msg) => {
    msgCount++;
    console.log(`[Server] #${msgCount} Ping from ${msg.from.substring(0, 16)}...`);
    console.log(`[Server] Payload: "${new TextDecoder().decode(msg.payload)}"`);
    irohTransport.sendMessage(msg.from, 'pong', new TextEncoder().encode('pong from server'));
  });

  irohTransport.onMessage('task', (msg) => {
    msgCount++;
    console.log(`[Server] #${msgCount} Task from ${msg.from.substring(0, 16)}...`);
    const task = new TextDecoder().decode(msg.payload);
    console.log(`[Server] Task: ${task.substring(0, 60)}...`);
    irohTransport.sendMessage(msg.from, 'response', new TextEncoder().encode('task received'));
  });

  console.log('[Server] Ready. Press Ctrl+C to stop.');
  await new Promise(() => {});
}

async function runClient(targetId: string) {
  if (!targetId) {
    console.error('[Client] Error: target node ID required');
    process.exit(1);
  }

  console.log('[Client] Starting iroh transport...');
  const node = await irohTransport.start();
  console.log('[Client] Node ID:', node.nodeId);
  console.log('[Client] Target:', targetId);
  console.log('');

  irohTransport.onMessage('pong', (msg) => {
    console.log(`[Client] Pong from ${msg.from.substring(0, 16)}...: "${new TextDecoder().decode(msg.payload)}"`);
  });

  irohTransport.onMessage('response', (msg) => {
    console.log(`[Client] Response from ${msg.from.substring(0, 16)}...: "${new TextDecoder().decode(msg.payload)}"`);
  });

  await new Promise(resolve => setTimeout(resolve, 500));

  console.log('[Client] Sending ping...');
  await irohTransport.sendMessage(targetId, 'ping', new TextEncoder().encode('hello server'));

  await new Promise(resolve => setTimeout(resolve, 300));

  console.log('[Client] Sending task...');
  const task = JSON.stringify({ id: '123', type: 'summarize', documentPath: '/test.pdf' });
  await irohTransport.sendMessage(targetId, 'task', new TextEncoder().encode(task));

  console.log('[Client] Waiting for responses...');
  await new Promise(resolve => setTimeout(resolve, 5000));

  await irohTransport.shutdown();
  console.log('[Client] Done');
}

if (role === 'server') {
  runServer();
} else {
  runClient(targetNodeId!);
}
