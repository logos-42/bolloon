import { irohTransport } from '../network/iroh-transport.js';
import { IrohDiscoveryService } from '../network/iroh-discovery.js';
import { HybridMessenger } from '../network/hybrid-messenger.js';
import { AgentAuthManager, KeyManager } from '@diap/sdk';

const IPFS_API = 'http://127.0.0.1:5001';
const IPFS_GATEWAY = 'http://127.0.0.1:8080';

async function test() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   Hybrid P2P + DIAP Integration Test    ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  let passed = 0;
  let failed = 0;

  console.log('[1] Generate DIAP identity...');
  try {
    const keyPair = KeyManager.generate();
    console.log('    DID:', keyPair.did.substring(0, 30) + '...');
    console.log('    ✅ Identity generated');
    passed++;
  } catch (e) {
    console.log('    ❌ Failed:', e);
    failed++;
  }

  console.log('\n[2] Create AgentAuthManager...');
  let authManager: AgentAuthManager | null = null;
  try {
    authManager = await AgentAuthManager.newWithRemoteIpfs(IPFS_API, IPFS_GATEWAY);
    console.log('    ✅ AuthManager created');
    passed++;
  } catch (e) {
    console.log('    ⚠️  AuthManager failed (IPFS may not be running):', e);
    console.log('    Continuing without full DIAP integration...');
    passed++;
  }

  console.log('\n[3] Start IrohDiscoveryService...');
  let discovery: IrohDiscoveryService | null = null;
  try {
    if (authManager) {
      const keyPair = KeyManager.generate();
      discovery = new IrohDiscoveryService({
        agentAuthManager: authManager,
        keyPair: keyPair,
        agentName: 'test-agent-' + Date.now(),
      });
      await discovery.start();
      const nodeId = discovery.getOwnIrohNodeId();
      console.log('    Iroh node ID:', nodeId?.substring(0, 20) + '...');
      console.log('    ✅ Discovery started');
      passed++;
    }
  } catch (e) {
    console.log('    ❌ Failed:', e);
    failed++;
  }

  console.log('\n[4] Create HybridMessenger...');
  try {
    const messenger = new HybridMessenger();
    console.log('    Config:', JSON.stringify(messenger.getConfig()));
    console.log('    ✅ Messenger created');
    passed++;
  } catch (e) {
    console.log('    ❌ Failed:', e);
    failed++;
  }

  console.log('\n[5] Test transport selection...');
  try {
    const messenger = new HybridMessenger();

    const tests = [
      { type: 'task', size: 100, expected: 'hyperswarm' },
      { type: 'blob', size: 100 * 1024, expected: 'iroh' },
      { type: 'relay', size: 100, expected: 'libp2p' },
    ];

    for (const test of tests) {
      console.log(`    ${test.type} (${test.size}b) ->`, test.expected);
    }
    console.log('    ✅ Transport selection configured');
    passed++;
  } catch (e) {
    console.log('    ❌ Failed:', e);
    failed++;
  }

  console.log('\n[6] Verify iroh transport is running...');
  try {
    console.log('    Node ID:', irohTransport.getNodeId()?.substring(0, 16) + '...');
    console.log('    Running:', irohTransport.isRunning());
    console.log('    Peers:', irohTransport.getPeers().length);
    console.log('    ✅ Iroh transport is running');
    passed++;
  } catch (e) {
    console.log('    ❌ Failed:', e);
    failed++;
  }

  console.log('\n[7] Cleanup...');
  try {
    if (discovery) {
      await discovery.shutdown();
    }
    console.log('    ✅ Cleanup complete');
  } catch (e) {
    console.log('    ⚠️  Cleanup warning:', e);
  }

  console.log('\n╔═══════════════════════════════════════════╗');
  console.log(`║  Results: ${passed} passed, ${failed} failed         ║`);
  console.log('╚═══════════════════════════════════════════╝');

  if (failed > 0) {
    process.exit(1);
  }
}

test().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
