import { P2PDirect } from './src/network/p2p-direct.js';
const REMOTE = 'd92489cadd2a05063fbf3c0790817c0a81649436beb4a087ebab38d15a3ab61c';
const p2p = new P2PDirect({ name: 'p2p-sniffer' });
await p2p.start();
console.log('MY PK:', p2p.getPublicKey());
await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));
let r = await p2p.sendToWithWait(REMOTE, JSON.stringify({v:3,op:'agent.heartbeat',payload:{fromPublicKey:p2p.getPublicKey(),name:'sniffer',channels:[],ts:Date.now()}}), 10000).catch(()=>'TIMEOUT');
console.log('connect result:', r);
p2p.on('data', (evt: any) => {
  if (evt.fromPublicKey === REMOTE) {
    const d = JSON.parse(evt.data.toString());
    const txt = (d.payload?.text || d.payload?.content || '').substring(0,300);
    console.log(`[${d.op}] ${txt}`);
  }
});
console.log('waiting...');
