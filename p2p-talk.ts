import { P2PDirect } from './src/network/p2p-direct.js';
const REMOTE = 'd92489cadd2a05063fbf3c0790817c0a81649436beb4a087ebab38d15a3ab61c';
const MY_PK = 'd2e7473e4a2f8e6057d6c000f2146109585ed3bdb387233c5f9fecdd0c57d17d';
const CHANNEL = 'ch_1785146677431_q2nrys';

const p2p = new P2PDirect({ name: 'p2p-talk' });
await p2p.start();
console.log('PK:', p2p.getPublicKey());
await p2p.joinTopic(Buffer.from('bolloon-agent-harness'));

// 连接远程
const r = await p2p.sendToWithWait(REMOTE, JSON.stringify({v:3,op:'agent.heartbeat',payload:{fromPublicKey:MY_PK,name:'talk',channels:[],ts:Date.now()}}), 20000).catch(()=>'TIMEOUT');
console.log('conn:', r);

// 发消息
const msg = JSON.stringify({v:3,op:'agent.chat.send',payload:{channelId:CHANNEL,text:'直接P2P连接测试，能收到吗？',fromPublicKey:MY_PK}});
p2p.sendTo(REMOTE, msg);
console.log('msg sent');

// 等回复
p2p.on('data', (evt: any) => {
  if (evt.fromPublicKey !== REMOTE) return;
  try {
    const d = JSON.parse(evt.data.toString());
    console.log(`>> [${d.op}]`, (d.payload?.text||d.payload?.content||'').substring(0,500));
    if (d.op === 'agent.chat.reply' || d.op === 'agent.chat.send') {
      console.log('=== 收到聊天消息! ===');
    }
  } catch(e) {}
});

console.log('等待回复中 (60s)...');
await new Promise(r => setTimeout(r, 60000));
console.log('结束');
await p2p.stop();
process.exit(0);
