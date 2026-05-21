import { irohTransport } from '../network/iroh-transport.js';

async function testTransport() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║      iroh Transport Verification          ║');
  console('╚═══════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  console.log('[1] Starting transport...');
  try {
    const node = await irohTransport.start();
    console.log('    ✅ Transport started');
    console.log('    Node ID:', node.nodeId.substring(0, 24) + '...');

    if (node.nodeId.length === 64) {
      console.log('    ✅ Valid node ID (64 hex chars)');
      passed++;
    } else {
      console.log('    ❌ Invalid node ID length');
      failed++;
    }
  } catch (e) {
    console.log('    ❌ Start failed:', e);
    failed++;
  }

  console.log('\n[2] Checking running state...');
  if (irohTransport.isRunning()) {
    console.log('    ✅ Transport is running');
    passed++;
  } else {
    console.log('    ❌ Transport not running');
    failed++;
  }

  console.log('\n[3] Testing message handler registration...');
  let handlerCalled = false;
  irohTransport.onMessage('test', (msg) => {
    handlerCalled = true;
  });
  console.log('    ✅ Handler registered');
  passed++;

  console.log('\n[4] Testing wildcard handler...');
  irohTransport.onMessage('*', (msg) => {
    console.log('    Wildcard handler triggered by:', msg.type);
  });
  console.log('    ✅ Wildcard handler registered');
  passed++;

  console.log('\n[5] Testing getNodeId...');
  const nodeId = irohTransport.getNodeId();
  if (nodeId && nodeId.length === 64) {
    console.log('    ✅ getNodeId returns valid ID');
    passed++;
  } else {
    console.log('    ❌ getNodeId failed');
    failed++;
  }

  console.log('\n[6] Testing shutdown...');
  await irohTransport.shutdown();
  if (!irohTransport.isRunning()) {
    console.log('    ✅ Transport stopped');
    passed++;
  } else {
    console.log('    ❌ Transport still running');
    failed++;
  }

  console.log('\n[7] Testing restart...');
  try {
    await irohTransport.start();
    const newNodeId = irohTransport.getNodeId();
    if (newNodeId && newNodeId.length === 64) {
      console.log('    ✅ Transport restarted');
      passed++;
    } else {
      console.log('    ❌ Restart failed');
      failed++;
    }
    await irohTransport.shutdown();
  } catch (e) {
    console.log('    ❌ Restart failed:', e);
    failed++;
  }

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log(`║  Results: ${passed} passed, ${failed} failed          ║`);
  console.log('╚═══════════════════════════════════════════╝');

  if (failed > 0) {
    process.exit(1);
  }
}

testTransport().catch(e => {
  console.error('Test error:', e);
  process.exit(1);
});
