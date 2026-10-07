/**
 * 世界卡片创建链路实证 (2026-10-07)
 * 外部 agent 用 DIAP Ed25519 身份签名投递机会 → 验签入库 → 进世界流
 * 完全按 opportunity-inbox.ts 的协议实现
 */
import crypto from 'node:crypto';
import bs58 from 'bs58';

// ---- did:key:z6Mk... 生成 (multicodec 0xed01 + 32B 公钥, base58btc) ----
function didKeyFromPub(pubHex) {
  const prefix = Buffer.from([0xed, 0x01]);
  const full = Buffer.concat([prefix, Buffer.from(pubHex, 'hex')]);
  return 'did:key:z' + bs58.encode(full);
}

// ---- canonicalize: 与 x402/paid-info-protocol 同源 (确定性序列化) ----
// 对照源码: canonicalize = 按 key 排序 + JSON 序列化(紧凑)
function canonicalize(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

// ---- 构造签名 ----
const keypair = crypto.generateKeyPairSync('ed25519');
const pubHex = Buffer.from(keypair.publicKey.export({ type: 'spki', format: 'der' })).subarray(-32).toString('hex');
const did = didKeyFromPub(pubHex);
console.log('provider DID:', did);

const payload = {
  protocol: 'bolloon-opportunity-inbox/1',
  title: '手机端世界卡片创建验证',
  summary: '这张卡片由实证流程创建：外部 agent 用 Ed25519 签名投递，验签通过后入库并进入世界流。',
  refs: ['https://bolloon.cn', 'https://github.com/logos-42/bolloon'],
  provider: { did, name: 'verify-agent' },
  issuedAt: new Date().toISOString(),
};

const canonical = canonicalize(payload);
const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), keypair.privateKey).toString('base64');
console.log('canonical:', canonical.slice(0, 80) + '...');
console.log('signature:', sig.slice(0, 40) + '...');

// ---- 验签自检 (模拟服务端) ----
const ok = crypto.verify(null, Buffer.from(canonical, 'utf8'), keypair.publicKey, Buffer.from(sig, 'base64'));
console.log('本地验签:', ok ? '✅ 通过' : '❌ 失败');
if (!ok) process.exit(1);

// ---- POST 到电脑端 ----
const r = await fetch('http://127.0.0.1:54188/api/world/inbox', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Signature': sig },
  body: JSON.stringify(payload),
});
const d = await r.json();
console.log('\nPOST /api/world/inbox →', r.status);
console.log(JSON.stringify(d, null, 1).slice(0, 600));

// ---- 读回验证 ----
const list = await fetch('http://127.0.0.1:54188/api/world/inbox').then(x => x.json());
console.log('\n信箱现有卡片:', list.count);
for (const o of (list.opportunities || [])) {
  console.log('-', o.title, '| 验签:', o.verification, '| provider:', o.provider?.name);
}
