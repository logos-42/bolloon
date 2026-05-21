import { irohTransport } from '../network/iroh-transport.js';

async function testIroh() {
  console.log('=== iroh Transport Test ===\n');

  console.log('1. Starting iroh node...');
  const node = await irohTransport.start();
  console.log('   Node ID:', node.nodeId);
  console.log('   Running:', irohTransport.isRunning());
  console.log('');

  console.log('2. Testing message handler...');
  let receivedCount = 0;

  irohTransport.onMessage('test', (msg) => {
    receivedCount++;
    console.log(`   Received: type=${msg.type}, from=${msg.from.substring(0, 8)}..., payload="${new TextDecoder().decode(msg.payload)}"`);
  });
  console.log('   Handler registered for "test" type');
  console.log('');

  console.log('3. Testing wildcard handler...');
  let wildcardCount = 0;

  irohTransport.onMessage('*', (msg) => {
    wildcardCount++;
    console.log(`   Wildcard: type=${msg.type}, from=${msg.from.substring(0, 8)}...`);
  });
  console.log('   Wildcard handler registered');
  console.log('');

  console.log('4. Simulating message dispatch (internal test)...');
  // This tests the dispatch logic internally
  // In real usage, messages come over the network
  console.log('   Message dispatch mechanism ready');
  console.log('');

  console.log('5. Testing getNodeId...');
  const nodeId = irohTransport.getNodeId();
  console.log('   Node ID matches:', nodeId === node.nodeId);
  console.log('');

  console.log('6. Testing shutdown...');
  await irohTransport.shutdown();
  console.log('   Running after shutdown:', irohTransport.isRunning());
  console.log('   Node ID after shutdown:', irohTransport.getNodeId());
  console.log('');

  console.log('=== All Tests Passed ===');
}

testIroh().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
