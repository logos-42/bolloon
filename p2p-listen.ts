/**
 * p2p-listen.ts — listen for P2P data, print op names and first 200 chars
 */
import { P2PDirect } from './src/network/p2p-direct.js';
const p2p = new P2PDirect({ name: 'p2p-listen' });
await p2p.start();
console.log('publicKey:', p2p.getPublicKey());
await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
console.log('listening...');
p2p.on('data', (evt: any) => {
  try {
    const d = JSON.parse(evt.data.toString());
    if (d && d.v === 3 && d.op) {
      const txt = d.payload?.text || d.payload?.content || '';
      console.log(`[${d.op}] from ${evt.fromPublicKey.substring(0,12)}... ${txt.substring(0,200)}`);
    }
  } catch {}
});
process.on('SIGINT', () => { p2p.stop(); process.exit(0); });
