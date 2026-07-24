import { describe, expect, it } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { createX402PaymentFetch, x402CheckBalance, x402Fetch } from '../agents/x402/x402Pay.js';

const TEST_PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const TEST_PAY_TO = `0x${'2'.repeat(40)}`;
const USDC_SEPOLIA = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

describe('x402 fetch', () => {
  it('returns payment required details without a private key', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: 'Payment Required' }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });

    const result = await x402Fetch({
      url: 'https://example.test/paid',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe(402);
    expect(result.error).toContain('需要 x402 支付');
    expect(result.data).toEqual({ error: 'Payment Required' });
  });

  it('uses the official x402 payment wrapper to retry with a payment header', async () => {
    const paymentRequired = {
      x402Version: 2,
      resource: { url: 'https://example.test/paid', description: 'paid test' },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:84532',
        amount: '1',
        asset: USDC_SEPOLIA,
        payTo: TEST_PAY_TO,
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2', decimals: 6 },
      }],
    };
    const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired as any);
    const seenHeaders: Record<string, string>[] = [];

    const fetchImpl = async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      seenHeaders.push(Object.fromEntries(request.headers.entries()));
      if (seenHeaders.length === 1) {
        return new Response('', {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const paidFetch = await createX402PaymentFetch({
      privateKey: TEST_PRIVATE_KEY,
      network: 'base-sepolia',
      fetchImpl: fetchImpl as typeof fetch,
    });
    const response = await paidFetch('https://example.test/paid');

    expect(response.status).toBe(200);
    expect(seenHeaders).toHaveLength(2);
    expect(seenHeaders[0]['payment-signature']).toBeUndefined();
    expect(seenHeaders[1]['payment-signature']).toBeTruthy();
  });

  it('rejects unsupported balance networks before calling RPC', async () => {
    const result = await x402CheckBalance({
      address: TEST_PAY_TO,
      network: 'unsupported',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('不支持的网络');
  });
});
