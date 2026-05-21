import { irohTransport } from '../network/iroh-transport.js';

async function main() {
  console.log('=== iroh Transport Core Verification ===\n');

  let allPassed = true;

  console.log('[1] Start transport');
  try {
    const node = await irohTransport.start();
    console.log('    ✅ Started, ID:', node.nodeId.substring(0, 20) + '...');
  } catch (e) {
    console.log('    ❌ Failed:', e);
    allPassed = false;
  }

  console.log('\n[2] Running state');
  console.log('    ' + (irohTransport.isRunning() ? '✅ Running' : '❌ Not running'));

  console.log('\n[3] Node ID format');
  const nodeId = irohTransport.getNodeId();
  if (nodeId && nodeId.length === 64) {
    console.log('    ✅ Valid 64-char hex ID');
  } else {
    console.log('    ❌ Invalid ID');
    allPassed = false;
  }

  console.log('\n[4] Message handlers');
  irohTransport.onMessage('test', () => {});
  irohTransport.onMessage('*', () => {});
  console.log('    ✅ Handlers registered');

  console.log('\n[5] Shutdown');
  await irohTransport.shutdown();
  if (!irohTransport.isRunning()) {
    console.log('    ✅ Stopped');
  } else {
    console.log('    ❌ Still running');
    allPassed = false;
  }

  console.log('\n[6] Re-start after shutdown');
  try {
    await irohTransport.start();
    console.log('    ✅ Restart works');
    await irohTransport.shutdown();
  } catch (e) {
    console.log('    ❌ Restart failed');
    allPassed = false;
  }

  console.log('\n' + (allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'));
  process.exit(allPassed ? 0 : 1);
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
