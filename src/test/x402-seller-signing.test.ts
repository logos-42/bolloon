/**
 * x402-seller-signing.test.ts — 卖方本机签名交付 (bolloon-x402-seller/1) 的聚焦测试
 *
 * 这条链路最要紧的一句话: **私钥不出本机**。所以这里不用 mock 讲道理, 全部真跑:
 *   · 真 Ed25519 身份 (@diap/sdk 的 KeyManager, 与 agent-identity.ts 同一条路)
 *   · 真 HTTP 服务器 (复刻 ECS server.mjs 的两条路由: 402 → 付款 → 202/200, 与 /api/x402/seller/**)
 *   · 真 CLI 子进程 (`npx tsx src/cli-entry.ts x402 pending list|show|sign`)
 *   · 真验签 (既有 ed25519Verify + verifyEnvelope)
 *   · **全程 0 链上交易 / 0 真钱**: 付款凭据是 local-dev (协议里如实标 mode='local-dev')
 *
 * 负面对照 (缺了它们, 上面全绿说明不了任何事):
 *   · 未付款 → 402 (accepts 逐字 = 仓内 buildPaymentRequired)
 *   · 没认证头 → 401; 未配密钥 → 403; 重放 → 401; 时间戳超窗 → 401; 篡改方法/路径/密钥 → 401
 *   · 服务器没钉公钥 → 拒收 (503); 别人签的信封 → 拒收 (400); 签名被改 → 拒收 (400)
 *   · 本机没内容 → 拒签, 且服务器上仍是 awaiting_signature (不产生假交付)
 *   · 内容被改一个字节 → 内容哈希检查必红
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KeyManager } from '@diap/sdk';

import { publishInfo, buildPaymentRequired, checkAndSettlePayment, getStoredInfo } from '../agents/x402/paid-info-store.js';
import { canonicalize, computeContentHash, ed25519Verify, verifyEnvelope } from '../agents/x402/paid-info-protocol.js';
import {
  SELLER_API_PREFIX, sellerApiPaths, handleSellerApi, resolvePaidDelivery, resolvePendingDelivery,
  signPending, paidInfoRetrievePath,
  generateSellerAuth, saveSellerAuth, loadSellerAuth, sellerAuthPath, NonceLedger,
  sellerPendingDir, enqueuePending, readPending, listPending, getStoredEnvelope,
  signSellerRequest, computeAuthSignature, resolveSellerKey, AUTH_MAX_SKEW_MS,
  acceptSignedEnvelope, sellerKeyPath,
} from '../agents/x402/seller-signing.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-seller-signing-'));
const HOME = path.join(TMP, 'home');
const PREV_SELLER_HOME = process.env.BOLLOON_SELLER_HOME;

const CONTENT = JSON.stringify({ spec: 'efficode-spec-pack (测试夹具)', lines: [1, 2, 3] }, null, 2);
const PRICE = { amount: '0.012', currency: 'USDC' as const, network: 'base-sepolia', payTo: '0x1111111111111111111111111111111111111111' };

let sellerDid = '';
let sellerPublicKeyHex = '';
let sellerPrivateKeyHex = '';
let item: Awaited<ReturnType<typeof publishInfo>>;
let auth: Awaited<ReturnType<typeof generateSellerAuth>>;
let port = 0;
let server: http.Server;
let ledger: NonceLedger;
/** 服务器端"钉住的公钥"—— 测试里可切成 '' 模拟未配置 */
let pinnedKey = '';
/** 每张新凭据都不同 (payload 带时间戳) → 每条都产生独立待办 */
let receiptCounter = 0;
function newReceipt(tag: string): string {
  receiptCounter += 1;
  return `local-dev:${tag}:${receiptCounter}:${Date.now()}`;
}

const url = (p: string): string => `http://127.0.0.1:${port}${p}`;

/** 造一张 local-dev 付款凭据 (非链上; 与 buyInfo 的 allowLocalDev 分支同形状) */
function localDevPaymentHeader(requirements: any, itemId: string): string {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: requirements.accepts[0],
    payload: { localDev: true, at: new Date().toISOString(), itemId, n: ++receiptCounter },
    payer: 'local-dev',
  }), 'utf-8').toString('base64');
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** 真 HTTP 服务器: 复刻 ECS server.mjs 的两条路由 (402 分支与仓内 buildPaymentRequired 同源) */
async function startServer(): Promise<void> {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const p = u.pathname.replace(/\/+$/, '') || '/';
    const body = await readBody(req);
    const send = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
      const b = JSON.stringify(obj, null, 2);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b), ...headers });
      res.end(b);
    };

    // ---- 卖方队列端点 (与 server.mjs 同一份 handleSellerApi) ----
    if (p.startsWith(`${SELLER_API_PREFIX}/`)) {
      const out = await handleSellerApi(
        { home: HOME, auth: await loadSellerAuth(HOME), ledger, ...(pinnedKey ? { sellerPublicKeyHex: pinnedKey, sellerDid } : {}) },
        { method: req.method || 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams.entries()), headers: req.headers as any, bodyText: body ? body : undefined },
      );
      res.writeHead(out.status, out.headers);
      return res.end(out.body);
    }

    // ---- 买方取件 token (只读, 不重跑结算) ----
    const rm = p.match(/^\/api\/x402\/info\/([^/]+)\/pending\/([^/]+)$/);
    if (rm) {
      const delivery = await resolvePendingDelivery({ itemId: decodeURIComponent(rm[1]), pendingId: decodeURIComponent(rm[2]) }, HOME);
      if (!delivery) return send(404, { error: '取件 token 不存在或不属于这条资源' });
      if (delivery.kind === 'envelope') return send(200, delivery.envelope, { 'X-BOLLOON-SELLER-DID': delivery.envelope.proof.did });
      if (delivery.kind === 'expired') return send(410, { ok: false, status: 'pending_expired', pendingId: delivery.pendingId });
      return send(202, { ok: true, status: 'paid_awaiting_signature', pendingId: delivery.pendingId, hint: delivery.hint }, { 'Retry-After': '15' });
    }

    // ---- 付费信息 (与 server.mjs 同一条: 402 逐字不变 → 202 待签 / 200 信封) ----
    const m = p.match(/^\/api\/x402\/info\/([^/]+)$/);
    if (m) {
      const stored = await getStoredInfo(decodeURIComponent(m[1]), HOME);
      if (!stored) return send(404, { error: '信息不存在' });
      const requirements = buildPaymentRequired(stored.item, url(`/api/x402/info/${stored.item.id}`));
      const paymentHeader = req.headers['x-payment'] as string | undefined;
      if (!paymentHeader) {
        return send(402, { ...requirements, error: '需要 x402 微支付' }, { 'X-PAYMENT-REQUIRED': JSON.stringify(requirements.accepts) });
      }
      const pay = await checkAndSettlePayment({ paymentHeader, requirements, expectedItemId: stored.item.id, allowLocalDev: true, facilitatorUrl: '' });
      if (!pay.ok) return send(402, { ...requirements, error: pay.error });
      const delivery = await resolvePaidDelivery({
        item: stored.item,
        payment: {
          mode: pay.mode === 'facilitator' ? 'facilitator' : 'local-dev',
          receipt: String(pay.receipt || ''), txHash: pay.txHash, payer: pay.payer,
          network: pay.network || stored.item.price.network,
          amount: stored.item.price.amount, currency: stored.item.price.currency,
        },
      }, HOME);
      if (delivery.kind === 'envelope') return send(200, delivery.envelope, { 'X-PAYMENT-RESPONSE': String(pay.receipt || '') });
      if (delivery.kind === 'expired') return send(410, { ok: false, status: 'pending_expired', pendingId: delivery.pendingId });
      return send(202, {
        ok: true, status: 'paid_awaiting_signature', pendingId: delivery.pendingId, itemId: stored.item.id,
        contentHash: stored.item.contentHash,
        payment: { mode: pay.mode, receiptHash: delivery.pending!.payment.receiptHash },
        retrieval: { token: delivery.pendingId, path: paidInfoRetrievePath(stored.item.id, delivery.pendingId) },
        hint: delivery.hint,
      });
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as any).port;
}

/** 打一次款 (不带真钱): 返回 202/200 的 body */
async function payOnce(target: { id: string }): Promise<{ status: number; body: any; header: string }> {
  const reqBody = buildPaymentRequired(target as any, url(`/api/x402/info/${target.id}`));
  const header = localDevPaymentHeader(reqBody, target.id);
  const r = await fetch(url(`/api/x402/info/${target.id}`), { headers: { 'X-PAYMENT': header } });
  return { status: r.status, body: await r.json() as any, header };
}

/** 真 CLI 子进程 (隔离 HOME: 只给 BOLLOON_SELLER_HOME, 不给 BOLLOON_HOME_DIR) */
function runCli(args: string[], timeoutMs = 180_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, BOLLOON_SELLER_HOME: HOME };
  delete env.BOLLOON_HOME_DIR;
  return new Promise((resolve) => {
    execFile('npx', ['tsx', 'src/cli-entry.ts', ...args], { cwd: REPO, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ code: err ? (err as any).code ?? 1 : 0, stdout, stderr }));
  });
}

/** 认证头 (手搓真 HMAC — 与客户端同一函数 computeAuthSignature) */
function authHeaders(pathname: string, opts: { method?: string; body?: string; ts?: number; nonce?: string; secret?: string; keyId?: string } = {}): Record<string, string> {
  const method = opts.method || 'GET';
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce || randomBytes(16).toString('hex');
  const secret = opts.secret || auth.secret;
  return {
    'x-bolloon-seller-key': opts.keyId || auth.keyId,
    'x-bolloon-seller-ts': ts,
    'x-bolloon-seller-nonce': nonce,
    'x-bolloon-seller-sig': computeAuthSignature(secret, { method, path: pathname, ts, nonce, body: opts.body }),
  };
}

beforeAll(async () => {
  process.env.BOLLOON_SELLER_HOME = HOME;
  // 确定性: 清掉可能让 local-dev 分支被 facilitator 分支顶掉的 env
  delete process.env.BOLLOON_X402_FACILITATOR;
  delete process.env.BOLLOON_X402_LOCAL_VERIFY;
  await fsp.mkdir(path.join(HOME, '.bolloon'), { recursive: true });
  await startServer();

  // ① 真 DIAP 卖方身份 (与 agent-identity.ts 同一字段形状, 0600)
  const kp = KeyManager.generate();
  sellerDid = kp.did;
  sellerPrivateKeyHex = Buffer.from(kp.privateKey as any).toString('hex');
  sellerPublicKeyHex = Buffer.from(kp.publicKey as any).toString('hex');
  await fsp.writeFile(path.join(HOME, '.bolloon', 'identity.json'), JSON.stringify({
    keyType: 'Ed25519', privateKey: sellerPrivateKeyHex, publicKey: sellerPublicKeyHex,
    did: sellerDid, createdAt: new Date().toISOString(), version: '1.0',
  }, null, 2), { mode: 0o600 });

  // ② 真发布一条 item (内容落盘到隔离 HOME)
  item = await publishInfo({
    id: 'info_test_seller_signing',
    title: '卖方本机签名交付 · 测试条目',
    category: 'data',
    content: CONTENT,
    description: '测试夹具 (不发真钱, 不发链上交易)',
    price: PRICE,
    source: { kind: 'self', refs: [], note: '测试夹具' },
    provider: { did: sellerDid, name: '测试卖方' },
  }, { home: HOME });

  // ③ 真 0600 共享密钥 (endpoint 指向本测试的服务器)
  auth = generateSellerAuth(url(''), 'sk_test_seller_signing');
  await saveSellerAuth(auth, HOME);

  pinnedKey = sellerPublicKeyHex;
  ledger = new NonceLedger(path.join(sellerPendingDir(HOME), '.nonces.json'));
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (PREV_SELLER_HOME === undefined) delete process.env.BOLLOON_SELLER_HOME; else process.env.BOLLOON_SELLER_HOME = PREV_SELLER_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ────────────────────────────────────────────── 认证: 0600 密钥 + HMAC + 时间戳 + 一次性 nonce

describe('认证 (0600 共享密钥 + HMAC + 时间戳 + 一次性 nonce)', () => {
  it('共享密钥落在 0600 文件里; 新建的目录是 0700', async () => {
    expect(((await fsp.stat(sellerAuthPath(HOME))).mode & 0o777)).toBe(0o600);
    // 目录: 若是我们新建的 → 0700; 已存在(如本测试的 .bolloon)则不动它 (只保证文件 0600)
    const freshHome = path.join(TMP, 'fresh-home');
    await saveSellerAuth(generateSellerAuth('https://example.test', 'sk_fresh'), freshHome);
    expect(((await fsp.stat(path.join(freshHome, '.bolloon'))).mode & 0o777)).toBe(0o700);
    expect(((await fsp.stat(sellerAuthPath(freshHome))).mode & 0o777)).toBe(0o600);
    // 覆盖写也保持 0600
    await saveSellerAuth({ ...auth, keyId: 'sk_overwritten' }, HOME);
    expect(((await fsp.stat(sellerAuthPath(HOME))).mode & 0o777)).toBe(0o600);
    await saveSellerAuth(auth, HOME);   // 还原
  });

  it('未配置共享密钥 → 403 (不是"没有待办")', async () => {
    const out = await handleSellerApi({ home: path.join(TMP, 'no-auth') }, { method: 'GET', path: sellerApiPaths().list, headers: {} });
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).code).toBe('SELLER_AUTH_NOT_CONFIGURED');
  });

  it('缺认证头 → 401 SELLER_AUTH_REQUIRED', async () => {
    const r = await fetch(url(sellerApiPaths().list));
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe('SELLER_AUTH_REQUIRED');
  });

  it('正确 HMAC → 200 (真 HTTP)', async () => {
    const r = await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list) });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe('bolloon-x402-seller/1');
  });

  it('同一个 nonce 再用一次 → 401 SELLER_AUTH_REPLAY (一次性, 防重放)', async () => {
    const nonce = randomBytes(16).toString('hex');
    const r1 = await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list, { nonce }) });
    expect(r1.status).toBe(200);
    const r2 = await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list, { nonce }) });
    expect(r2.status).toBe(401);
    expect((await r2.json() as any).code).toBe('SELLER_AUTH_REPLAY');
  });

  it('nonce 台账落盘 → 换一个新实例 (等价于服务重启) 仍然拒绝同一个 nonce', async () => {
    const nonce = randomBytes(16).toString('hex');
    expect((await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list, { nonce }) })).status).toBe(200);
    const fresh = new NonceLedger(path.join(sellerPendingDir(HOME), '.nonces.json'));
    const ts = String(Date.now());
    const out = await handleSellerApi({ home: HOME, auth, ledger: fresh }, {
      method: 'GET', path: sellerApiPaths().list,
      headers: { 'x-bolloon-seller-key': auth.keyId, 'x-bolloon-seller-ts': ts, 'x-bolloon-seller-nonce': nonce, 'x-bolloon-seller-sig': computeAuthSignature(auth.secret, { method: 'GET', path: sellerApiPaths().list, ts, nonce }) },
    });
    expect(out.status).toBe(401);
    expect(JSON.parse(out.body).code).toBe('SELLER_AUTH_REPLAY');
  });

  it('时间戳超出 ±5 分钟 → 401 SELLER_AUTH_EXPIRED', async () => {
    const r = await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list, { ts: Date.now() - AUTH_MAX_SKEW_MS - 60_000 }) });
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe('SELLER_AUTH_EXPIRED');
  });

  it('方法被改 → 401 SIGNATURE_INVALID (签的是 方法+路径+ts+nonce+body哈希)', async () => {
    const h = authHeaders(sellerApiPaths().list, { method: 'GET' });
    const r = await fetch(url(sellerApiPaths().list), { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect((await r.json() as any).code).toBe('SELLER_AUTH_SIGNATURE_INVALID');
  });

  it('路径被改 → 401 (换一条路径复用签名不成立)', async () => {
    const r = await fetch(url(`${sellerApiPaths().list}/pnd_deadbeef`), { headers: authHeaders(sellerApiPaths().list) });
    expect(r.status).toBe(401);
  });

  it('密钥不对 → 401 (另一把 shared secret 签不出来)', async () => {
    const r = await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list, { secret: randomBytes(32).toString('base64') }) });
    expect(r.status).toBe(401);
  });
});

// ────────────────────────────────────────────── 402 不变 + 付款 → 待办

describe('付款路径 (402 逐字不变; 付了钱但卖方没签 → 202)', () => {
  let firstPendingId = '';
  let firstReceiptHash = '';

  it('未付款 → 402, accepts 与仓内 buildPaymentRequired 逐字一致', async () => {
    const r = await fetch(url(`/api/x402/info/${item.id}`));
    expect(r.status).toBe(402);
    const expected = buildPaymentRequired(item, url(`/api/x402/info/${item.id}`));
    expect(await r.json()).toEqual({ ...expected, error: '需要 x402 微支付' });
    expect(JSON.parse(r.headers.get('x-payment-required')!)).toEqual(expected.accepts);
    expect(expected.accepts[0].amount).toBe('12000');   // 0.012 USDC → 原子单位
    expect(expected.accepts[0].payTo).toBe(PRICE.payTo);
    expect(expected.accepts[0].extra.itemId).toBe(item.id);
  });

  it('付款凭据通过 → 202 已付款待签名 (卖方不在线时买方拿不到信封)', async () => {
    const r = await payOnce(item);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('paid_awaiting_signature');
    expect(r.body.pendingId).toMatch(/^pnd_/);
    expect(r.body.contentHash).toBe(item.contentHash);
    expect(String(r.body.hint)).toContain('已付款待签名');
    firstPendingId = r.body.pendingId;
    firstReceiptHash = r.body.payment.receiptHash;
    expect(firstReceiptHash).toMatch(/^sha256:/);

    const rec = await readPending(firstPendingId, HOME);
    expect(rec?.status).toBe('awaiting_signature');
    expect(rec?.payment.receiptHash).toBe(firstReceiptHash);
    expect(rec?.providerDid).toBe(sellerDid);
    // 待办文件里**没有**私钥
    expect(JSON.stringify(rec)).not.toContain(sellerPrivateKeyHex);
  });

  it('同一张凭据的**同一次结算结果** (同一 receipt) 只落一条待办 (幂等键 = receiptHash)', async () => {
    const receipt = newReceipt('idem');
    const pay = { mode: 'local-dev' as const, receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' };
    const a = await enqueuePending({ item: item as any, payment: pay }, HOME);
    const b = await enqueuePending({ item: item as any, payment: pay }, HOME);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.pending.pendingId).toBe(a.pending.pendingId);
    expect((await listPending(HOME)).filter((p) => p.payment.receiptHash === a.pending.payment.receiptHash).length).toBe(1);
    // 同一 receipt 的第二次 resolvePaidDelivery 也仍然指向同一条
    const d = await resolvePaidDelivery({ item: item as any, payment: pay }, HOME);
    expect(d.pendingId).toBe(a.pending.pendingId);
  });

  it('★ 反面对照: local-dev 回执自带时间戳 ⇒ 重放同一张 X-PAYMENT 会得到**新** receipt (所以取件必须走 token, 不是重放凭据)', async () => {
    const reqBody = buildPaymentRequired(item, url(`/api/x402/info/${item.id}`));
    const header = localDevPaymentHeader(reqBody, item.id);
    const b1 = await (await fetch(url(`/api/x402/info/${item.id}`), { headers: { 'X-PAYMENT': header } })).json() as any;
    const b2 = await (await fetch(url(`/api/x402/info/${item.id}`), { headers: { 'X-PAYMENT': header } })).json() as any;
    expect(b1.status).toBe('paid_awaiting_signature');
    expect(b1.payment.receiptHash).not.toBe(b2.payment.receiptHash);
    expect(b1.pendingId).not.toBe(b2.pendingId);
    // 而"同一 receipt"永远只有一条待办 (上面那条已证) ⇒ 幂等键是 receiptHash 而不是 X-PAYMENT 原文
  });

  it('待办可通过认证接口读到 (list + show)', async () => {
    const lb = await (await fetch(url(sellerApiPaths().list), { headers: authHeaders(sellerApiPaths().list) })).json() as any;
    expect(lb.pending.some((p: any) => p.pendingId === firstPendingId)).toBe(true);
    const sb = await (await fetch(url(sellerApiPaths().show(firstPendingId)), { headers: authHeaders(sellerApiPaths().show(firstPendingId)) })).json() as any;
    expect(sb.pending.payment.receiptHash).toBe(firstReceiptHash);
    expect(sb.delivered).toBe(false);
    expect(sb.pending.providerDid).toBe(sellerDid);
  });

  it('不存在的待办 → 404 PENDING_NOT_FOUND', async () => {
    const r = await fetch(url(sellerApiPaths().show('pnd_nope')), { headers: authHeaders(sellerApiPaths().show('pnd_nope')) });
    expect(r.status).toBe(404);
    expect((await r.json() as any).code).toBe('PENDING_NOT_FOUND');
  });
});

// ────────────────────────────────────────────── 真 CLI 子进程: list / show / sign

describe('真 CLI 子进程 (bolloon x402 pending list|show|sign)', () => {
  let pendingId = '';
  let receiptHash = '';
  let signStdout = '';
  let signStderr = '';

  it('pending list --json 真拉到待办 (带认证, 无 secret 泄漏)', async () => {
    const r = await payOnce(item);
    expect(r.status).toBe(202);
    pendingId = r.body.pendingId;
    receiptHash = r.body.payment.receiptHash;

    const cli = await runCli(['x402', 'pending', 'list', '--endpoint', url(''), '--json']);
    expect(cli.code).toBe(0);
    const out = JSON.parse(cli.stdout.slice(cli.stdout.indexOf('{')));
    expect(out.ok).toBe(true);
    expect(out.protocol).toBe('bolloon-x402-seller/1');
    expect(out.pending.some((p: any) => p.pendingId === pendingId)).toBe(true);
    expect(cli.stdout).not.toContain(auth.secret);
    expect(cli.stdout).not.toContain(sellerPrivateKeyHex);
  }, 180_000);

  it('pending show 展示付款凭据哈希 / 内容哈希 / 来源', async () => {
    const cli = await runCli(['x402', 'pending', 'show', pendingId, '--endpoint', url('')]);
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain(receiptHash);
    expect(cli.stdout).toContain(item.contentHash);
    expect(cli.stdout).toContain('kind=self');
    expect(cli.stdout).toContain(sellerDid);
    expect(cli.stdout).not.toContain(sellerPrivateKeyHex);
  }, 180_000);

  it('pending sign 真签真回传, 本机自检验签通过', async () => {
    const cli = await runCli(['x402', 'pending', 'sign', pendingId, '--endpoint', url('')]);
    signStdout = cli.stdout; signStderr = cli.stderr;
    expect(cli.code).toBe(0);
    expect(cli.stdout).toContain('✅ ed25519Verify 通过');
    expect(cli.stdout).toContain('✅ 已回传并收下');
  }, 180_000);

  it('CLI 输出里不出现私钥 / 共享密钥 (凭证卫生)', () => {
    expect(signStdout).not.toContain(sellerPrivateKeyHex);
    expect(signStdout).not.toContain(auth.secret);
    expect(signStderr).not.toContain(sellerPrivateKeyHex);
    expect(signStderr).not.toContain(auth.secret);
  });

  it('签完的信封能被 ed25519Verify + 卖方公钥验签通过 (真输出)', async () => {
    const env = await getStoredEnvelope(receiptHash, HOME);
    expect(env).toBeTruthy();
    expect(await ed25519Verify(env!.proof.publicKeyHex, canonicalize(env!.proof.payload), env!.proof.signature)).toBe(true);
    expect(env!.proof.publicKeyHex).toBe(sellerPublicKeyHex);
    expect(env!.proof.did).toBe(sellerDid);
    expect(env!.proof.payload.itemId).toBe(item.id);
    expect(env!.proof.payload.receiptHash).toBe(receiptHash);
    expect(env!.proof.payload.contentHash).toBe(computeContentHash(CONTENT));
    // 签名真覆盖内容: 改一个字节 → 内容完整性检查必红
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.content = `${CONTENT} `;
    const rep = await verifyEnvelope(tampered as any);
    expect(rep.checks.find((c) => c.name === 'content-integrity')!.ok).toBe(false);
    expect(rep.trust).toBe('unverified');
    // 反过来: 改外层 item.source 而不重签 → 载荷自洽检查必红
    const tampered2 = JSON.parse(JSON.stringify(env));
    tampered2.item.source = { kind: 'quoted', refs: ['https://example.test/x'] };
    expect((await verifyEnvelope(tampered2 as any)).checks.find((c) => c.name === 'signed-payload-consistency')!.ok).toBe(false);
  });

  it('协议分档如实: local-dev 支付只能到 self-attested (不许说成 verified)', async () => {
    const env = await getStoredEnvelope(receiptHash, HOME);
    const rep = await verifyEnvelope(env as any);
    expect(rep.ok).toBe(true);
    expect(rep.trust).toBe('self-attested');
    expect(rep.warnings.join(' ')).toContain('local-dev');
  });

  it('买方用取件 token 取 (卖方还没签) → 202 已付款待签名, 且**不重跑结算**', async () => {
    // 用一条**全新**的待办 (没被签过) 来验 "卖方不在线时买方看到什么"
    const fresh = await payOnce(item);
    expect(fresh.status).toBe(202);
    const token = fresh.body.retrieval.token as string;
    expect(token).toBe(fresh.body.pendingId);
    const r = await fetch(url(paidInfoRetrievePath(item.id, token)));
    expect(r.status).toBe(202);
    expect(r.headers.get('retry-after')).toBe('15');
    const b = await r.json() as any;
    expect(b.status).toBe('paid_awaiting_signature');
    expect(b.pendingId).toBe(token);
    expect(String(b.hint)).toContain('卖方还没签名');
    // token 绑定本条 item: 拿它去读另一条资源 → 404
    expect((await fetch(url(paidInfoRetrievePath('info_not_this_item', token)))).status).toBe(404);
    // 不存在的 token → 404
    expect((await fetch(url(paidInfoRetrievePath(item.id, 'pnd_nope')))).status).toBe(404);
  });

  it('签完后买方用取件 token → 200 + 信封 (幂等, 不再扣款)', async () => {
    const r = await fetch(url(paidInfoRetrievePath(item.id, pendingId)));
    expect(r.status).toBe(200);
    const env = await r.json() as any;
    expect(env.proof.payload.receiptHash).toBe(receiptHash);
    expect(await ed25519Verify(env.proof.publicKeyHex, canonicalize(env.proof.payload), env.proof.signature)).toBe(true);
    // 再取一次: 还是**同一个**信封 (不是重新签一个)
    const r2 = await fetch(url(paidInfoRetrievePath(item.id, pendingId)));
    expect(r2.status).toBe(200);
    expect(canonicalize(await r2.json())).toBe(canonicalize(env));
    const rec = await readPending(pendingId, HOME);
    expect(rec?.status).toBe('signed');
    expect(rec?.envelopeHash).toBe(`sha256:${createHash('sha256').update(canonicalize(env)).digest('hex')}`);
    // 买方拿到的信封能离线验签 (全程没有第二次付款)
    expect((await verifyEnvelope(env)).trust).toBe('self-attested');
  });

  it('已签过的待办再用 X-PAYMENT 来一次 → 仍然是新 receipt/新待办 (老信封靠 token 取, 不靠重放凭据)', async () => {
    const again = await payOnce(item);
    expect(again.status).toBe(202);
    expect(again.body.pendingId).not.toBe(pendingId);
    expect(again.body.payment.receiptHash).not.toBe(receiptHash);
    expect(again.body.retrieval.token).toBe(again.body.pendingId);
    // 老的那条仍然按老 token 取回
    const delivery = await resolvePendingDelivery({ itemId: item.id, pendingId }, HOME);
    expect(delivery?.kind).toBe('envelope');
  });
});

// ────────────────────────────────────────────── 拒签 / 拒收 (不许假交付)

describe('拒签与拒收 (不许假交付)', () => {
  it('本机没有内容 → 拒签, 服务器上仍是 awaiting_signature', async () => {
    const other = await publishInfo({
      id: 'info_test_no_content', title: '没有本机内容的条目', category: 'data', content: 'x'.repeat(20),
      price: PRICE, source: { kind: 'self', refs: [] }, provider: { did: sellerDid },
    }, { home: HOME });
    const r = await payOnce(other);
    expect(r.status).toBe(202);
    const itemFile = path.join(HOME, '.bolloon', 'x402-info', `${other.id}.json`);
    const backup = await fsp.readFile(itemFile, 'utf-8');
    await fsp.rm(itemFile);
    const cli = await runCli(['x402', 'pending', 'sign', r.body.pendingId, '--endpoint', url('')]);
    expect(cli.code).toBe(1);
    expect(cli.stderr).toContain('本机没有 item');
    await fsp.writeFile(itemFile, backup);
    expect((await readPending(r.body.pendingId, HOME))?.status).toBe('awaiting_signature');
    expect(await getStoredEnvelope(r.body.payment.receiptHash, HOME)).toBeNull();
  }, 180_000);

  it('本机内容被改过 (哈希对不上) → signPending 抛错拒签', async () => {
    const receipt = newReceipt('tamper');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    await expect(signPending({
      pending, item: item as any, content: `${CONTENT}!`,
      keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') },
    })).rejects.toThrow(/内容.*不一致/);
  });

  it('本机钥匙不是这条 item 的卖方 → 拒签', async () => {
    const receipt = newReceipt('wrongkey');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    await expect(signPending({
      pending, item: item as any, content: CONTENT,
      keypair: { did: 'did:key:z6MkSomeoneElse', publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') },
    })).rejects.toThrow(/拒签/);
  });

  it('别人签的信封 (公钥不匹配) → 服务器拒收 SELLER_KEY_MISMATCH, 待办不动', async () => {
    const receipt = newReceipt('rogue');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const rogue = KeyManager.generate();
    // ★ 私钥一律传 32 字节 (Uint8Array): buildSignedEnvelope 的 string 分支按 **base64** 解,
    //   传 hex 字符串会被解成 48 字节 → ed25519Sign 直接拒 (这个坑在本测试里真撞过一次)
    const env = await signPending({
      pending: { ...pending, providerDid: rogue.did },
      item: { ...(item as any), provider: { did: rogue.did } },
      content: CONTENT,
      keypair: { did: rogue.did, publicKey: Buffer.from(rogue.publicKey as any), privateKey: Buffer.from(rogue.privateKey as any) },
    });
    const res = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: env, sellerPublicKeyHex, sellerDid }, HOME);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SELLER_KEY_MISMATCH');
    expect((await readPending(pending.pendingId, HOME))?.status).toBe('awaiting_signature');
    expect(await getStoredEnvelope(pending.payment.receiptHash, HOME)).toBeNull();
  });

  it('服务器未钉住卖方公钥 → 拒收 SELLER_KEY_NOT_PINNED (不是"先信一次")', async () => {
    const receipt = newReceipt('unpinned');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    const env = await signPending({ pending, item: item as any, content: CONTENT, keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') } });
    const res = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: env }, HOME);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SELLER_KEY_NOT_PINNED');
    expect(await getStoredEnvelope(pending.payment.receiptHash, HOME)).toBeNull();
  });

  it('签名被换掉 → 拒收 SIGNATURE_INVALID', async () => {
    const receipt = newReceipt('badsig');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    const good = await signPending({ pending, item: item as any, content: CONTENT, keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') } });
    const bad = JSON.parse(JSON.stringify(good));
    bad.proof.signature = randomBytes(64).toString('base64');
    const res = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: bad, sellerPublicKeyHex }, HOME);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('SIGNATURE_INVALID');
    expect(await getStoredEnvelope(pending.payment.receiptHash, HOME)).toBeNull();
  });

  it('已经签过的待办: 同一信封再交 → 幂等 ok; 换一个信封 → 拒 (不改写已交付的事实)', async () => {
    const receipt = newReceipt('dup');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    const env = await signPending({ pending, item: item as any, content: CONTENT, keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') } });
    const first = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: env, sellerPublicKeyHex }, HOME);
    expect(first.ok).toBe(true);
    expect(first.envelopeHash).toMatch(/^sha256:/);
    const again = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: env, sellerPublicKeyHex }, HOME);
    expect(again.ok).toBe(true);
    expect(again.envelopeHash).toBe(first.envelopeHash);
    const other = await signPending({ pending, item: item as any, content: CONTENT, keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') } });
    other.proof.payload.issuedAt = new Date(Date.now() + 5000).toISOString();
    const third = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: other, sellerPublicKeyHex }, HOME);
    expect(third.ok).toBe(false);
    // 已交付的事实不许改写: 先撞"这单已经签过了", 而不是被当成一次新的签名请求
    expect(third.code).toBe('PENDING_ALREADY_SIGNED');
    // 盘上仍然是**第一个**信封 (没被后来的覆盖)
    expect((await readPending(pending.pendingId, HOME))?.envelopeHash).toBe(first.envelopeHash);
  });

  it('待办过期 → 拒签 (卖方长期不在线不许无限期可交付)', async () => {
    const receipt = newReceipt('expired');
    const { pending } = await enqueuePending({
      item: item as any,
      payment: { mode: 'local-dev', receipt, network: 'base-sepolia', amount: '0.012', currency: 'USDC' },
    }, HOME, Date.now() - 30 * 24 * 3600 * 1000);
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    const env = await signPending({ pending: { ...pending, expiresAt: new Date(Date.now() + 3600_000).toISOString() }, item: item as any, content: CONTENT, keypair: { did: key!.did, publicKey: key!.publicKeyHex, privateKey: Buffer.from(key!.privateKeyHex, 'hex') } });
    const res = await acceptSignedEnvelope({ pendingId: pending.pendingId, envelope: env, sellerPublicKeyHex }, HOME);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('PENDING_EXPIRED');
  });

  it('找不到的待办 → PENDING_NOT_FOUND', async () => {
    const res = await acceptSignedEnvelope({ pendingId: 'pnd_nope', envelope: { proof: { signature: 'x', publicKeyHex: sellerPublicKeyHex, payload: {} } }, sellerPublicKeyHex }, HOME);
    expect(res.code).toBe('PENDING_NOT_FOUND');
  });
});

// ────────────────────────────────────────────── 钥匙定位 (只用既有身份, 不新建)

describe('卖方钥匙定位 (只读既有身份)', () => {
  it('按 DID 命中 ~/.bolloon/identity.json', async () => {
    const key = await resolveSellerKey(sellerDid, { home: HOME });
    expect(key?.did).toBe(sellerDid);
    expect(key?.publicKeyHex).toBe(sellerPublicKeyHex);
    expect(key?.source).toBe('identity.json');
  });

  it('DID 不匹配 → null, 且**没有**偷偷建 agent key', async () => {
    expect(await resolveSellerKey('did:key:z6MkNotTheSeller', { home: HOME })).toBeNull();
    expect(await fsp.readdir(path.join(HOME, '.bolloon', 'agent-keys')).catch(() => [])).toEqual([]);
  });

  it('agent-keys 命中优先 (agentId 显式指定)', async () => {
    const kp = KeyManager.generate();
    const dir = path.join(HOME, '.bolloon', 'agent-keys');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'seller-agent.json'), JSON.stringify({
      did: kp.did, publicKey: Buffer.from(kp.publicKey as any).toString('hex'), privateKey: Buffer.from(kp.privateKey as any).toString('hex'),
    }), { mode: 0o600 });
    expect((await resolveSellerKey(kp.did, { agentId: 'seller-agent', home: HOME }))?.source).toBe('agent-keys/seller-agent.json');
  });

  it('★ 回归: agent-keys/ 里排序第一是**别人的钥匙**时, 默认仍必须认 identity.json', async () => {
    // 真机踩到过: 本机 agent-keys/ 下有 8 个历史测试 agent, 按文件名排序第一是 `agent-__.json`,
    // 旧实现"扫 agent-keys 优先"会抓它 ⇒ `bolloon x402 pending key` 打出的是别人的 DID/公钥。
    const KEYHOME = path.join(TMP, 'keyhome');
    await fsp.mkdir(path.join(KEYHOME, '.bolloon', 'agent-keys'), { recursive: true });
    const decoy = KeyManager.generate();
    await fsp.writeFile(path.join(KEYHOME, '.bolloon', 'agent-keys', 'agent-__.json'), JSON.stringify({
      did: decoy.did, publicKey: Buffer.from(decoy.publicKey as any).toString('hex'), privateKey: Buffer.from(decoy.privateKey as any).toString('hex'),
    }), { mode: 0o600 });
    const mine = KeyManager.generate();
    await fsp.writeFile(path.join(KEYHOME, '.bolloon', 'identity.json'), JSON.stringify({
      did: mine.did, publicKey: Buffer.from(mine.publicKey as any).toString('hex'), privateKey: Buffer.from(mine.privateKey as any).toString('hex'),
    }), { mode: 0o600 });

    const k = await resolveSellerKey('', { home: KEYHOME });
    expect(k?.source).toBe('identity.json');
    expect(k?.did).toBe(mine.did);
    // 传了 did (sign 时会传待办的 providerDid) 就必须匹配, 哪怕它在 agent-keys 里
    expect((await resolveSellerKey(decoy.did, { home: KEYHOME }))?.did).toBe(decoy.did);
  });
});

// ────────────────────────────────────────────── 服务器侧只有公钥

describe('服务器侧只有公钥 / 本机才有密钥', () => {
  it('队列文件里不含私钥与共享密钥; 钉住的 seller-key.json 只有公钥', async () => {
    const walk = async (dir: string): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as any)) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await walk(f));
        else if (e.name.endsWith('.json')) out.push(await fsp.readFile(f, 'utf-8'));
      }
      return out;
    };
    const blobs = await walk(sellerPendingDir(HOME));
    expect(blobs.length).toBeGreaterThan(0);
    for (const b of blobs) {
      expect(b).not.toContain(sellerPrivateKeyHex);
      expect(b).not.toContain(auth.secret);
    }
    await fsp.writeFile(sellerKeyPath(HOME), JSON.stringify({ protocol: 'bolloon-x402-seller/1', did: sellerDid, publicKeyHex: sellerPublicKeyHex }, null, 2), { mode: 0o644 });
    const pinned = await fsp.readFile(sellerKeyPath(HOME), 'utf-8');
    expect(pinned).toContain(sellerPublicKeyHex);
    expect(pinned).not.toContain(sellerPrivateKeyHex);
  });

  it('客户端签名头只有 keyId/ts/nonce/sig, 不含 secret 本身', () => {
    const h = signSellerRequest(auth, { method: 'GET', path: sellerApiPaths().list });
    expect(Object.values(h).join(' ')).not.toContain(auth.secret);
    expect(h['x-bolloon-seller-key']).toBe(auth.keyId);
    expect(h['x-bolloon-seller-nonce']).toMatch(/^[0-9a-f]{32}$/);
  });
});
