import { irohTransport } from '../network/iroh-transport.js';

async function testBasicTransport() {
  console.log('=== Test 1: Basic Transport ===');

  const node = await irohTransport.start();
  console.log('Node started:', node.nodeId.substring(0, 16) + '...');
  console.log('Running:', irohTransport.isRunning());

  return node;
}

async function testMessageHandler() {
  console.log('\n=== Test 2: Message Handler ===');

  let receivedMsg: any = null;

  irohTransport.onMessage('test', (msg) => {
    console.log('Handler called!');
    receivedMsg = msg;
  });

  console.log('Handler registered');
  return receivedMsg;
}

async function testShutdown() {
  console.log('\n=== Test 3: Shutdown ===');

  await irohTransport.shutdown();
  console.log('Shutdown complete');
  console.log('Running:', irohTransport.isRunning());
  console.log('NodeId:', irohTransport.getNodeId());
}

async function runTests() {
  try {
    await testBasicTransport();
    await testMessageHandler();
    await testShutdown();
    console.log('\n=== All tests passed ===');
  } catch (e) {
    console.error('Test failed:', e);
  }
}

runTests();
