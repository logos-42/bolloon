import { irohTransport } from '../network/iroh-transport.js';

async function testTwoNodes() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║       iroh Two-Node E2E Test           ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  let serverNodeId: string | null = null;
  let clientNodeId: string | null = null;
  let messagesReceived = 0;

  console.log('[1] Starting server node...');
  const server = await irohTransport.start();
  serverNodeId = server.nodeId;
  console.log(`    Server Node ID: ${serverNodeId}`);
  console.log('');

  irohTransport.onMessage('ping', (msg) => {
    messagesReceived++;
    console.log(`    [Server] Got ping: "${new TextDecoder().decode(msg.payload)}"`);
    irohTransport.sendMessage(msg.from, 'pong', new TextEncoder().encode('pong'));
  });

  irohTransport.onMessage('request', async (msg) => {
    messagesReceived++;
    console.log(`    [Server] Got request: "${new TextDecoder().decode(msg.payload)}"`);
    const response = await irohTransport.requestResponse(msg.from, 'response', new TextEncoder().encode('response data'));
    if (response) {
      console.log(`    [Server] Response sent`);
    }
  });

  console.log('[2] Starting client node...');
  const clientTransport = new (await import('../network/iroh-transport.js')).IrohTransport();
  const client = await clientTransport.start();
  clientNodeId = client.node;
  console.log(`    Client Node ID: ${clientNodeId}`);
  console.log('');

  let clientPongs = 0;
  let clientResponses = 0;

  clientTransport.onMessage('pong', (msg) => {
    clientPongs++;
    console.log(`    [Client] Got pong: "${new TextDecoder().decode(msg.payload)}"`);
  });

  clientTransport.onMessage('response', (msg) => {
    clientResponses++;
    console.log(`    [Client] Got response: "${new TextDecoder().decode(msg.payload)}"`);
  });

  await new Promise(r => setTimeout(r, 500));

  console.log('[3] Client sending ping to server...');
  await clientTransport.sendMessage(serverNodeId!, 'ping', new TextEncoder().encode('hello'));

  await new Promise(r => setTimeout(r, 500));

  console.log('[4] Client sending request (with response)...');
  await clientTransport.sendMessage(serverNodeId!, 'request', new TextEncoder().encode('need data'));

  await new Promise(r => setTimeout(r, 2000));

  console.log('\n[5] Results:');
  console.log(`    Messages received by server: ${messagesReceived}`);
  console.log(`    Pongs received by client: ${clientPongs}`);
  console.log(`    Responses received by client: ${clientResponses}`);

  const success = messagesReceived >= 2 && clientPongs >= 1 && clientResponses >= 1;

  console.log('\n' + (success ? '✅ E2E TEST PASSED' : '❌ E2E TEST FAILED'));

  await clientTransport.shutdown();
  await irohTransport.shutdown();

  process.exit(success ? 0 : 1);
}

testTwoNodes().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
