import { AgentAuthManager, KeyManager } from '@diap/sdk';
import { initIrohIntegration, getIrohIntegration } from '../network/iroh-integration.js';

const IPFS_API = 'http://127.0.0.1:5001';
const IPFS_GATEWAY = 'http://127.0.0.1:8080';

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║       iroh + DIAP Integration Test       ║');
  console.log('╚═══════════════════════════════════════════╝\n');

  console.log('[1] Generating DIAP identity...');
  const keyPair = KeyManager.generate();
  console.log(`    DID: ${keyPair.did}`);
  console.log(`    Name: test-agent-${keyPair.did.substring(0, 4)}`);

  console.log('\n[2] Creating AgentAuthManager...');
  const authManager = await AgentAuthManager.newWithRemoteIpfs(IPFS_API, IPFS_GATEWAY);
  console.log('    AuthManager ready');

  console.log('\n[3] Initializing iroh integration...');
  const integration = await initIrohIntegration({
    agentAuthManager: authManager,
    keyPair: keyPair,
    agentName: `test-agent-${keyPair.did.substring(0, 4)}`,
    agentDescription: 'Test agent with iroh P2P transport',
    agentTags: ['test', 'iroh'],
    refreshIntervalMs: 5 * 60 * 1000,
    discoveryIntervalMs: 30 * 1000,
  });

  const nodeId = integration.getNodeId();
  console.log(`\n    ✅ Iroh Node ID: ${nodeId}`);

  const registration = integration.getRegistration();
  if (registration) {
    console.log(`    ✅ DIAP CID: ${registration.cid}`);
  }

  console.log('\n[4] Setting up message handlers...');

  integration.onMessage('ping', (msg, from) => {
    console.log(`\n    📥 Ping from ${from.substring(0, 12)}...`);
    console.log(`    Payload: "${new TextDecoder().decode(msg.payload)}"`);

    console.log('    📤 Sending pong...');
    integration.sendTo(from, 'pong', new TextEncoder().encode('pong from ' + nodeId?.substring(0, 8)));
  });

  integration.onMessage('task', (msg, from) => {
    console.log(`\n    📥 Task from ${from.substring(0, 12)}...`);
    const taskData = new TextDecoder().decode(msg.payload);
    console.log(`    Task: ${taskData.substring(0, 80)}...`);
  });

  integration.onMessage('response', (msg, from) => {
    console.log(`\n    📥 Response from ${from.substring(0, 12)}...`);
    console.log(`    Response: "${new TextDecoder().decode(msg.payload)}"`);
  });

  console.log('    Handlers registered for: ping, task, response');

  console.log('\n[5] Connection info for other peers:');
  console.log('    ───────────────────────────────────────');
  console.log(`    Node ID: ${nodeId}`);
  console.log('    ───────────────────────────────────────');
  console.log('\n    To connect another peer, use this Node ID.');

  console.log('\n[6] Waiting for connections (60s)...');

  let tick = 0;
  const ticker = setInterval(() => {
    tick++;
    const peers = integration.getDiscoveredPeers();
    const connected = integration.getConnectedPeers();
    process.stdout.write(`\r    [${tick}s] Discovered: ${peers.length}, Connected: ${connected.length}   `);
  }, 1000);

  await new Promise(resolve => setTimeout(resolve, 60000));
  clearInterval(ticker);

  console.log('\n\n[7] Shutting down...');
  await integration.shutdown();
  console.log('Done');
}

main().catch(e => {
  console.error('Error:', e);
  process.exit(1);
});
