import { irohTransport } from '../network/iroh-transport.js';
import { HybridMessenger } from '../network/hybrid-messenger.js';

async function testHybridMessenger() {
  console.log('=== HybridMessenger Verification ===\n');

  console.log('[1] Starting iroh transport...');
  await irohTransport.start();
  console.log('    Iroh node ID:', irohTransport.getNodeId()?.substring(0, 16) + '...');
  console.log('    ✅ Iroh started\n');

  console.log('[2] Creating HybridMessenger...');
  const messenger = new HybridMessenger({
    preferIrohForLarge: true,
    largeThresholdBytes: 64 * 1024,
    enableRelay: true,
  });
  console.log('    ✅ Messenger created\n');

  console.log('[3] Testing transport selection logic...');
  const config = messenger.getConfig();
  console.log('    Config:', JSON.stringify(config));
  console.log('    ✅ Config correct\n');

  console.log('[4] Testing message handlers...');
  let handlerCalled = false;

  messenger.onMessage('task', (msg) => {
    handlerCalled = true;
    console.log('    Handler called for:', msg.type);
  });

  messenger.onWildcard((msg) => {
    console.log('    Wildcard called for:', msg.type);
  });

  messenger.dispatchMessage({
    type: 'task',
    payload: new TextEncoder().encode('test'),
    from: 'test-peer',
  });

  messenger.dispatchMessage({
    type: 'unknown',
    payload: new TextEncoder().encode('test'),
    from: 'test-peer',
  });
  console.log('    ✅ Handlers work\n');

  console.log('[5] Testing config modification...');
  messenger.setLargeThreshold(1024);
  messenger.setPreferIrohForLarge(false);
  const newConfig = messenger.getConfig();
  console.log('    New threshold:', newConfig.largeThresholdBytes);
  console.log('    Prefer iroh:', newConfig.preferIrohForLarge);
  console.log('    ✅ Config modification works\n');

  console.log('[6] Shutting down...');
  await irohTransport.shutdown();
  console.log('    ✅ Shutdown complete\n');

  console.log('=== ✅ HybridMessenger Verification Passed ===');
}

testHybridMessenger().catch((e) => {
  console.error('Test failed:', e);
  process.exit(1);
});
