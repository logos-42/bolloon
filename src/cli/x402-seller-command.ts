/**
 * x402-seller-command.ts — `bolloon x402 pending list|show|sign|auth-init|key`
 *
 * 薄包装: 业务逻辑一律在 `agents/x402/seller-signing.ts`, 本文件只做
 *   ① 参数解析 ② 人类可读输出 ③ 失败时的可操作提示。
 *
 * 红线 (与 docs/wiki/x402-seller-signing.md 一致):
 *   · 私钥**只在本进程内存里**用于签名; 绝不打印、绝不落日志、绝不进命令行、绝不上服务器
 *   · 共享密钥只出现在 0600 文件与请求头里; 输出里只有 keyId 与指纹
 *   · 签名只走既有 `buildSignedEnvelope` → `ed25519Sign` (不新写一套签名实现)
 *   · 卖方不在线 ⇒ 如实报 "已付款待签名", 不假装能交付
 */

import {
  sellerApiPaths, sellerAuthPath, sellerAuthFingerprint,
  generateSellerAuth, loadSellerAuth, saveSellerAuth, sellerHome,
  sellerClientRequest, pendingView, signPending, resolveSellerKey, paidInfoRetrievePath,
  type PendingSignRequest,
} from '../agents/x402/seller-signing.js';
import { canonicalize, ed25519Verify } from '../agents/x402/paid-info-protocol.js';

const USAGE = `
bolloon x402 pending —— 卖方本机签名交付 (私钥不离开本机)

  bolloon x402 pending list [--endpoint <url>] [--status awaiting_signature] [--json]
  bolloon x402 pending show <pendingId> [--endpoint <url>] [--json]
  bolloon x402 pending sign <pendingId> [--endpoint <url>] [--agent <agentId>] [--json]
  bolloon x402 pending auth-init [--endpoint <url>] [--force]
  bolloon x402 pending key [--agent <agentId>] [--json]

  auth-init   生成 0600 共享密钥 (~/.bolloon/x402-seller-auth.json), 打印 keyId/指纹/安装提示
  key         打印本机卖方公钥 (给服务器钉住; **只有公钥**, 私钥永不出机)
  list/show   带 HMAC 认证拉取待办 (服务器只持公钥, 签不了信封 ⇒ 必须本机签)
  sign        读本机内容 → 既有 ed25519Sign 签信封 → 回传服务器 → 本机自检验签

选项: --endpoint <url> (也可在 auth 文件里存 endpoint) · --agent <agentId> · --json
`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) { if (!a.includes('=')) i++; continue; }
    return a;
  }
  return undefined;
}

/** endpoint: --endpoint > auth 文件 > env */
async function resolveEndpoint(args: string[]): Promise<string> {
  const explicit = flagValue(args, '--endpoint') || process.env.BOLLOON_X402_SELLER_ENDPOINT;
  if (explicit) return explicit;
  const cfg = await loadSellerAuth();
  if (cfg?.endpoint) return cfg.endpoint;
  throw new Error('没有端点: 给 --endpoint <url>, 或先跑 `bolloon x402 pending auth-init --endpoint <url>` 把它存进 auth 文件');
}

function short(s: unknown, n = 20): string {
  const v = String(s ?? '');
  return v.length > n ? `${v.slice(0, n)}…` : v;
}

// ─────────────────────────────────────────────────────────── 子命令

async function cmdList(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const endpoint = await resolveEndpoint(args);
  const auth = await loadSellerAuth();
  if (!auth) { console.error('❌ 本机没有共享密钥 (~/.bolloon/x402-seller-auth.json) — 先跑 `bolloon x402 pending auth-init --endpoint <url>`'); return 1; }
  const status = flagValue(args, '--status');
  const urlPath = status ? `${sellerApiPaths().list}?status=${encodeURIComponent(status)}` : sellerApiPaths().list;
  // 被签的只有 pathname (查询串不参与)
  const r = await sellerClientRequest({ endpoint, auth }, { method: 'GET', path: sellerApiPaths().list, urlPath });
  if (!r.ok) {
    console.error(`❌ 拉取失败 (HTTP ${r.status}): ${r.json?.code || ''} ${r.json?.error || r.text.slice(0, 200)}`);
    if (r.json?.hint) console.error(`   ${r.json.hint}`);
    return 1;
  }
  if (json) { console.log(JSON.stringify(r.json, null, 2)); return 0; }
  const items: PendingSignRequest[] = r.json.pending || [];
  console.log(`卖方待办 (${endpoint}) — 共 ${r.json.total ?? items.length} 条, 待签名 ${r.json.awaitingSignature ?? '?'} 条`);
  if (!items.length) {
    console.log('  (空) 没有待签名的付款 —— 卖方不在线时买方只会拿到「已付款待签名」');
    return 0;
  }
  for (const p of items) {
    const v = pendingView(p);
    console.log(`  ${v.pendingId}  [${v.status}]  ${v.itemId}  ${v.payment.amount} ${v.payment.currency}@${v.payment.network}  ${v.createdAt}`);
    console.log(`      内容哈希 ${v.contentHash} · 付款凭据哈希 ${v.payment.receiptHash} · mode=${v.payment.mode}`);
  }
  console.log('  下一步: bolloon x402 pending show <pendingId> → sign <pendingId>');
  return 0;
}

async function cmdShow(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const id = firstPositional(args);
  if (!id) { console.error('用法: bolloon x402 pending show <pendingId>'); return 1; }
  const endpoint = await resolveEndpoint(args);
  const auth = await loadSellerAuth();
  if (!auth) { console.error('❌ 本机没有共享密钥 — 先跑 auth-init'); return 1; }
  const r = await sellerClientRequest({ endpoint, auth }, { method: 'GET', path: sellerApiPaths().show(id) });
  if (!r.ok) { console.error(`❌ 取不到 (HTTP ${r.status}): ${r.json?.code || ''} ${r.json?.error || r.text.slice(0, 200)}`); return 1; }
  if (json) { console.log(JSON.stringify(r.json, null, 2)); return 0; }
  const p: PendingSignRequest = r.json.pending;
  console.log(`待办 ${p.pendingId}  [${p.status}]`);
  console.log(`  item          ${p.itemId}  (${p.title})`);
  console.log(`  卖方 DID      ${p.providerDid}`);
  console.log(`  内容哈希      ${p.contentHash}${p.contentCid ? `  cid=${p.contentCid}` : ''}`);
  console.log(`  来源声明      kind=${p.source?.kind} refs=${(p.source?.refs || []).length}`);
  console.log(`  价格          ${p.price.amount} ${p.price.currency}@${p.price.network} → ${p.price.payTo}`);
  console.log(`  付款          mode=${p.payment.mode}  ${p.payment.amount} ${p.payment.currency}@${p.payment.network}`);
  console.log(`  付款凭据哈希  ${p.payment.receiptHash}   ← 签名会绑定它`);
  console.log(`  付款凭据原文  ${short(p.payment.receipt, 48)}   (回执原文, 本机要用它重建哈希)`);
  if (p.payment.txHash) console.log(`  链上 txHash   ${p.payment.txHash}`);
  if (p.payment.payer) console.log(`  付款方        ${p.payment.payer}`);
  console.log(`  创建/过期     ${p.createdAt} → ${p.expiresAt}`);
  if (p.envelopeHash) console.log(`  已签信封哈希  ${p.envelopeHash}`);
  console.log(`  下一步: bolloon x402 pending sign ${p.pendingId}`);
  return 0;
}

async function cmdSign(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const id = firstPositional(args);
  if (!id) { console.error('用法: bolloon x402 pending sign <pendingId> [--agent <agentId>]'); return 1; }
  const endpoint = await resolveEndpoint(args);
  const auth = await loadSellerAuth();
  if (!auth) { console.error('❌ 本机没有共享密钥 — 先跑 auth-init'); return 1; }

  // ① 拉这条待办 (服务器是待办的事实来源)
  const r = await sellerClientRequest({ endpoint, auth }, { method: 'GET', path: sellerApiPaths().show(id) });
  if (!r.ok) { console.error(`❌ 取不到待办 (HTTP ${r.status}): ${r.json?.code || ''} ${r.json?.error || r.text.slice(0, 200)}`); return 1; }
  const pending: PendingSignRequest = r.json.pending;
  if (pending.status !== 'awaiting_signature') {
    console.error(`❌ 这条待办状态是 ${pending.status} — 不能签 (已签过/已过期都不许重签)`);
    return 1;
  }

  // ② 本机内容 (签名要绑内容哈希 ⇒ 没有内容就签不出来, 如实报错)
  const { getStoredInfo } = await import('../agents/x402/paid-info-store.js');
  const stored = await getStoredInfo(pending.itemId, sellerHome());
  if (!stored) {
    console.error(`❌ 本机没有 item ${pending.itemId} 的内容 (~/.bolloon/x402-info/) — 没法签 (签一个对不上的信封等于假交付)`);
    return 1;
  }

  // ③ 本机钥匙: 必须是这条 item 的卖方 DID (**不新建钥匙**)
  const agentId = flagValue(args, '--agent');
  const key = await resolveSellerKey(pending.providerDid, { agentId });
  if (!key) {
    console.error(`❌ 本机找不到能给 ${pending.providerDid} 签名的私钥 (查过 ~/.bolloon/agent-keys/*.json 与 ~/.bolloon/identity.json)`);
    return 1;
  }

  // ④ 签 (既有 ed25519Sign), ⑤ 本机自检验签 —— 不信"我签好了", 用公钥验一遍
  const envelope = await signPending({ pending, item: stored.item as any, content: stored.content, keypair: { did: key.did, publicKey: key.publicKeyHex, privateKey: Buffer.from(key.privateKeyHex, 'hex') } });
  const selfCheck = await ed25519Verify(envelope.proof.publicKeyHex, canonicalize(envelope.proof.payload), envelope.proof.signature);

  // ⑥ 回传 (服务器会用钉住的公钥再验一次)
  const post = await sellerClientRequest({ endpoint, auth }, { method: 'POST', path: sellerApiPaths().envelope(pending.pendingId), body: JSON.stringify({ envelope }) });

  if (json) {
    console.log(JSON.stringify({
      ok: post.ok && selfCheck,
      pendingId: pending.pendingId,
      itemId: pending.itemId,
      contentHash: envelope.proof.payload.contentHash,
      receiptHash: envelope.proof.payload.receiptHash,
      publicKeyHex: envelope.proof.publicKeyHex,
      did: envelope.proof.did,
      keySource: key.source,
      selfCheckSignature: selfCheck,
      server: { status: post.status, ok: post.ok, code: post.json?.code, envelopeHash: post.json?.envelopeHash },
      envelope: post.ok ? undefined : envelope,
    }, null, 2));
    return post.ok && selfCheck ? 0 : 1;
  }

  console.log(`签名自检: ${selfCheck ? '✅ ed25519Verify 通过' : '❌ 验签不通过 (绝不回传这种信封)'}`);
  console.log(`  签名        ${short(envelope.proof.signature, 28)}  (base64, 完整值用 --json)`);
  console.log(`  签名公钥    ${envelope.proof.publicKeyHex}`);
  console.log(`  钥匙来源    ${key.source} (DID ${envelope.proof.did})`);
  console.log(`  载荷绑定    itemId=${envelope.proof.payload.itemId} · contentHash=${short(envelope.proof.payload.contentHash, 24)} · receiptHash=${short(envelope.proof.payload.receiptHash, 24)}`);
  if (!post.ok) {
    console.error(`❌ 回传失败 (HTTP ${post.status}): ${post.json?.code || ''} ${post.json?.error || post.text.slice(0, 200)}`);
    return 1;
  }
  if (!selfCheck) return 1;
  console.log(`✅ 已回传并收下 — pendingId=${pending.pendingId} envelopeHash=${post.json?.envelopeHash}`);
  console.log(`   买方下一步: 用取件 token 取 (不要重放付款凭据 —— 会再跑一遍结算):`);
  console.log(`     GET ${paidInfoRetrievePath(pending.itemId, pending.pendingId)}   → 200 + 信封, 然后 ed25519Verify / verifyEnvelope 离线验签`);
  return 0;
}

async function cmdAuthInit(args: string[]): Promise<number> {
  const endpoint = flagValue(args, '--endpoint') || process.env.BOLLOON_X402_SELLER_ENDPOINT;
  const force = args.includes('--force');
  const existing = await loadSellerAuth();
  if (existing && !force) {
    console.log(`已存在共享密钥 (keyId=${existing.keyId} 指纹 ${sellerAuthFingerprint(existing)}) — 换新密钥要显式 --force`);
    console.log(`  endpoint: ${existing.endpoint || '(未设置)'} · 文件 ${sellerAuthPath()}`);
    return 0;
  }
  const cfg = generateSellerAuth(endpoint);
  const file = await saveSellerAuth(cfg);
  console.log('✅ 已生成共享密钥 (0600 文件, 值不打印)');
  console.log(`  keyId     ${cfg.keyId}`);
  console.log(`  指纹      ${sellerAuthFingerprint(cfg)}   ← 核对两端是不是同一把就用它`);
  console.log(`  endpoint  ${cfg.endpoint || '(未设置, 用 --endpoint 指定)'}`);
  console.log(`  文件      ${file}`);
  console.log('');
  console.log('安装到服务器 (值只走 stdin, 不进命令行/不进日志/不进会话):');
  console.log(`  ssh <server> 'install -m600 -o bolloonpay -g bolloonpay /dev/stdin /opt/bolloon-pay/.bolloon/${'x402-seller-auth.json'}' < ${file}`);
  console.log('卖方公钥钉钉子 (只有公钥):');
  console.log('  bolloon x402 pending key > /tmp/seller-key.json   # 再 scp 到服务器 /opt/bolloon-pay/.bolloon/seller-key.json');
  return 0;
}

async function cmdKey(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const agentId = flagValue(args, '--agent');
  // 不指定 agent 时用身份文件 (与 routes-x402-info.ts 的 loadProviderKeypair 同源)
  const did = process.env.BOLLOON_SELLER_DID || '';
  const key = await resolveSellerKey(did, { agentId });
  if (!key) { console.error('❌ 本机找不到卖方身份 (~/.bolloon/identity.json 或 agent-keys/)'); return 1; }
  const out = { protocol: 'bolloon-x402-seller/1', did: key.did, publicKeyHex: key.publicKeyHex, note: '这是公钥 (可放服务器)。私钥不在此输出中。' };
  if (json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log(`卖方 DID    ${out.did}`);
  console.log(`公钥 (hex)  ${out.publicKeyHex}`);
  console.log(`来源        ${key.source}`);
  console.log(`钉到服务器: /opt/bolloon-pay/.bolloon/seller-key.json`);
  return 0;
}

// ─────────────────────────────────────────────────────────── 入口

export async function x402PendingCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  try {
    switch (sub) {
      case 'list': return await cmdList(args);
      case 'show': return await cmdShow(rest);
      case 'sign': return await cmdSign(rest);
      case 'auth-init': return await cmdAuthInit(rest);
      case 'key': return await cmdKey(rest);
      case undefined:
      case '--help':
      case '-h':
        console.log(USAGE.trim());
        return sub === undefined ? 1 : 0;
      default:
        console.error(`未知 x402 pending 子命令: ${sub}`);
        console.log(USAGE.trim());
        return 1;
    }
  } catch (e: any) {
    console.error(`❌ ${String(e?.message || e).slice(0, 300)}`);
    return 1;
  }
}

export { USAGE as X402_PENDING_USAGE };
