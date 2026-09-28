/**
 * routes-x402-info.ts — 微支付信息服务 (x402) 的 HTTP 接口
 *
 *   免费可读 (用于发现/索引/比价):
 *     GET  /api/x402/info              本机已发布的信息列表 (只有元数据)
 *     GET  /api/x402/info/:id/meta     单条元数据
 *   付费才给内容 (x402 标准 402 流程):
 *     GET  /api/x402/info/:id          无 X-PAYMENT → 402 (accepts …); 付款通过 → 200 带签名信封
 *   管理:
 *     POST   /api/x402/info            发布 (body: title/category/content/price/source)
 *     DELETE /api/x402/info/:id        下架
 *   买方辅助 (电脑端及手机端代理调用):
 *     POST /api/x402/info/buy          服务端代付并验真 (url, max_payment, allow_local_dev)
 *     POST /api/x402/info/verify       验真一个信封 (信封 JSON 或 URL)
 *
 * 手机端: 通过 desktopBaseUrl 转发这四个接口即可完成"浏览 → 购买 → 验真"。
 */

import * as path from 'path';
import * as os from 'os';
import {
  listInfo, getStoredInfo, publishInfo, removeInfo,
  buildPaymentRequired, checkAndSettlePayment, buyInfo,
} from '../agents/x402/paid-info-store.js';
import { buildSignedEnvelope, verifyEnvelope, summarizeVerify } from '../agents/x402/paid-info-protocol.js';
import { makeDidResolver } from '../agents/x402/paid-info-tools.js';
import { handleDirectPayment, directHealth, directPaymentPath, directPaymentEnabled } from '../agents/x402/direct-payment.js';

/** 本机 DIAP 身份 (签发信封用) — 缺失时明确报错, 不静默造一个 */
async function loadProviderKeypair(): Promise<{ did: string; publicKey: any; privateKey: any } | null> {
  try {
    const { KeyManager } = await import('@diap/sdk');
    const file = path.join(os.homedir(), '.bolloon', 'identity.json');
    return await KeyManager.fromFile(file) as any;
  } catch {
    return null;
  }
}

export function registerX402InfoRoutes(app: any): void {
  // ---- 列表 / 元数据 (免费) ----
  app.get('/api/x402/info', async (req: any, res: any) => {
    try {
      const cat = String(req.query?.category || '').toLowerCase();
      const items = (await listInfo()).filter((i) => !cat || i.category === cat);
      res.json({ count: items.length, items });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.get('/api/x402/info/:id/meta', async (req: any, res: any) => {
    const stored = await getStoredInfo(String(req.params.id));
    if (!stored) return res.status(404).json({ error: '信息不存在' });
    res.json({ item: stored.item });
  });

  // ---- 发布 / 下架 ----
  app.post('/api/x402/info', async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const kp = await loadProviderKeypair();
      if (!kp?.did) {
        return res.status(400).json({ error: '缺少本机 DIAP 身份 (~/.bolloon/identity.json) — 先 publish_did 或跑 bolloon setup' });
      }
      const item = await publishInfo({
        title: String(b.title || ''),
        category: b.category,
        content: String(b.content ?? ''),
        description: b.description,
        price: {
          amount: String(b.price?.amount ?? '0'),
          currency: b.price?.currency === 'ETH' ? 'ETH' : 'USDC',
          network: String(b.price?.network || 'base-sepolia'),
          payTo: String(b.price?.payTo || ''),
        },
        source: {
          kind: b.source?.kind || 'self',
          refs: Array.isArray(b.source?.refs) ? b.source.refs.map(String) : [],
          note: b.source?.note,
        },
        provider: { did: kp.did, name: b.providerName || undefined, agentId: b.agentId || undefined },
        contentCid: b.contentCid,
      });
      res.json({ ok: true, item });
    } catch (e: any) {
      res.status(400).json({ error: e?.message });
    }
  });

  app.delete('/api/x402/info/:id', async (req: any, res: any) => {
    const ok = await removeInfo(String(req.params.id));
    res.json({ ok });
  });

  // ---- 付费取内容 (x402 核心路径) ----
  app.get('/api/x402/info/:id', async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const stored = await getStoredInfo(id);
      if (!stored) return res.status(404).json({ error: '信息不存在' });

      const baseUrl = `${req.protocol || 'http'}://${req.headers?.host || `127.0.0.1:${process.env.PORT || 54188}`}`;
      const resourceUrl = `${baseUrl}/api/x402/info/${id}`;
      const requirements = buildPaymentRequired(stored.item, resourceUrl);
      const paymentHeader = req.headers?.['x-payment'] || req.headers?.['X-PAYMENT'];

      // 未付款 → 标准 402
      if (!paymentHeader) {
        return res.status(402)
          .set('X-PAYMENT-REQUIRED', JSON.stringify(requirements.accepts))
          .json({ ...requirements, error: '需要 x402 微支付' });
      }

      // 付款校验 + 结算
      const pay = await checkAndSettlePayment({
        paymentHeader: String(paymentHeader),
        requirements,
        expectedItemId: stored.item.id,   // 凭据必须绑定这条资源 (防跨资源复用)
      });
      if (!pay.ok) {
        return res.status(402).json({ ...requirements, error: pay.error });
      }

      // 签发信封 (内容 + DIAP Ed25519 签名 + 支付凭据绑定)
      const kp = await loadProviderKeypair();
      if (!kp) {
        return res.status(500).json({ error: '缺少本机 DIAP 身份, 无法签发信封 (已收到的付款请人工处理)' });
      }
      const envelope = await buildSignedEnvelope({
        item: stored.item,
        content: stored.content,
        keypair: kp as any,
        payment: {
          mode: pay.mode === 'facilitator' ? 'facilitator' : pay.mode === 'direct' ? 'direct' : 'local-dev',
          receipt: String(pay.receipt || ''),
          txHash: pay.txHash,
          network: pay.network || stored.item.price.network,
          amount: stored.item.price.amount,
          currency: stored.item.price.currency,
          payer: pay.payer,
          settledAt: new Date().toISOString(),
        },
      });
      res.set('X-PAYMENT-RESPONSE', pay.receipt || '');
      res.json(envelope);
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // ---- 去中心化直付 (mode = 'direct'): 买方自己发 USDC, 把 txHash 交回来 ----
  //   POST /api/x402/info/:id/payment   body: { "txHash": "0x…" }
  //   服务器**只读链**: receipt.status=1 + USDC Transfer → payTo + value >= accepts.amount
  //   + 两条不同 RPC 交叉一致 + 确认数够 → 落待办 + 给取件 token (202); 未过 → 402 (accepts 逐字)
  app.post('/api/x402/info/:id/payment', async (req: any, res: any) => {
    try {
      const id = String(req.params.id);
      const stored = await getStoredInfo(id);
      if (!stored) return res.status(404).json({ error: '信息不存在' });
      const baseUrl = `${req.protocol || 'http'}://${req.headers?.host || `127.0.0.1:${process.env.PORT || 54188}`}`;
      const out = await handleDirectPayment({
        item: stored.item,
        bodyText: typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}),
        resourceUrl: `${baseUrl}${directPaymentPath(stored.item.id)}`,
      });
      return res.status(out.status).set(out.headers).send(out.body);
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  // ---- 直付模式自述 (health 用: 开关与口径必须能从机器读到) ----
  app.get('/api/x402/direct', async (_req: any, res: any) => {
    res.json({ enabled: directPaymentEnabled(), paymentPath: directPaymentPath(':id'), ...directHealth() });
  });

  // ---- 买方辅助: 代付 + 验真 ----
  app.post('/api/x402/info/buy', async (req: any, res: any) => {
    try {
      const b = req.body || {};
      const url = String(b.url || '');
      if (!url) return res.status(400).json({ error: 'url 必填' });
      const privateKey = String(b.walletPrivateKey || process.env.X402_PRIVATE_KEY || '');
      const r = await buyInfo({
        url,
        privateKey: privateKey || undefined,
        maxPaymentAmount: b.maxPayment ? String(b.maxPayment) : undefined,
        network: b.network ? String(b.network) : undefined,
        allowLocalDev: b.allowLocalDev === true || process.env.BOLLOON_X402_LOCAL_VERIFY === '1',
        resolveDid: makeDidResolver(),
        expectItemId: b.itemId ? String(b.itemId) : undefined,
      });
      if (!r.ok) return res.status(400).json({ error: r.error, status: r.status });
      res.json({
        ok: true,
        item: r.envelope?.item,
        content: r.envelope?.content,
        envelope: r.envelope,
        verify: r.verify,
        verifySummary: r.verify ? summarizeVerify(r.verify) : null,
        payment: r.payment,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });

  app.post('/api/x402/info/verify', async (req: any, res: any) => {
    try {
      const b = req.body || {};
      let env: any = b.envelope;
      if (!env && b.url) {
        const r = await fetch(String(b.url));
        env = await r.json();
      }
      if (!env) return res.status(400).json({ error: '需要 envelope 或 url' });
      const report = await verifyEnvelope(env, {
        resolveDid: makeDidResolver(),
        expectItemId: b.itemId ? String(b.itemId) : undefined,
      });
      res.json({ ok: report.ok, report, summary: summarizeVerify(report) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message });
    }
  });
}
