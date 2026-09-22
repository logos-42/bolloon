/**
 * verify-facilitator-paths.ts — Phase 1 准备: facilitator 代码路径真跑 (2026-09-18)
 *
 * 真链上要等外部条件 (facilitator 地址 + 买方私钥 + 充值钱包)。但 facilitator 的**协议路径**
 * (verify / settle 的四种结果 + 失败分类 + txHash 有无) 现在就能用**本地 mock facilitator** 真跑,
 * 这样凭证到位后只剩"真钱那一步", 不会把没验过的代码带进真链。
 *
 * 覆盖 (leo 的真链上验收里可本地模拟的部分):
 *   ① verify 通过 + settle 成功 + 有 txHash  → chainSettled=true, 结算事实 payment_verified
 *   ② settle 成功但**没有 txHash**           → chainSettled=false (不能认定链上结算)
 *   ③ verify 被拒                            → attempted + verifyRejected, 不产生链上事实
 *   ④ settle 失败                            → attempted + settlementUncertain (先对账, 不许重付)
 *   ⑤ facilitator 不可达                      → settlementUncertain (同上)
 *   ⑥ 网络不匹配 / payTo 不匹配 / itemId 不匹配 → 报价自洽校验拒绝
 *
 * 用法: npx tsx scripts/verify-facilitator-paths.ts
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-facil-'));
const HOME = path.join(ROOT, 'home');
const BHOME = path.join(HOME, '.bolloon');
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
fs.mkdirSync(BHOME, { recursive: true });

const ST: any = await import('../src/agents/x402/paid-info-store.js');
const PROTO: any = await import('../src/agents/x402/transaction-protocol.js');

let passed = 0, failed = 0;
const check = (n: string, ok: boolean, d?: unknown) => {
  if (ok) { passed++; console.log(`  ✅ ${n}`); }
  else { failed++; console.log(`  ❌ ${n}${d !== undefined ? ` — ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 240)}` : ''}`); }
};
const section = (t: string) => console.log(`\n${t}`);

// ── 本地 mock facilitator (可配置行为; 真 HTTP, 不是打桩函数) ────────────────
type Mode = 'ok_with_hash' | 'ok_without_hash' | 'verify_rejected' | 'settle_failed';
let mode: Mode = 'ok_with_hash';
let hits: string[] = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    hits.push(`${req.method} ${req.url}`);
    const send = (code: number, obj: any) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url?.endsWith('/verify')) {
      if (mode === 'verify_rejected') return send(200, { isValid: false, invalidReason: 'insufficient_funds' });
      return send(200, { isValid: true, payer: '0xPayer' });
    }
    if (req.url?.endsWith('/settle')) {
      if (mode === 'settle_failed') return send(200, { success: false, errorReason: 'settle_reverted' });
      if (mode === 'ok_without_hash') return send(200, { success: true, payer: '0xPayer' });        // 注意: 无 transaction
      return send(200, { success: true, transaction: '0xabc123def4567890abc123def4567890abc123def4567890abc123def4567890', payer: '0xPayer' });
    }
    send(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const FACIL = `http://127.0.0.1:${(server.address() as any).port}`;
console.log(`mock facilitator: ${FACIL}`);

const PAY_TO = '0x1111111111111111111111111111111111111111';
const NETWORK = 'base-sepolia';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const req402 = { scheme: 'exact', network: NETWORK, asset: USDC, payTo: PAY_TO, amount: '1000', currency: 'USDC', maxTimeoutSeconds: 60, extra: { itemId: 'item-facil-1' } };
const requirements = { x402Version: 2, accepts: [req402] };
const header = (itemId = 'item-facil-1') => Buffer.from(JSON.stringify({
  x402Version: 2, accepted: { ...req402, extra: { itemId } }, payload: { sig: 'x' }, payer: '0xPayer',
})).toString('base64');

const settle = (m: Mode, hdr = header()) => {
  mode = m; hits = [];
  return ST.checkAndSettlePayment({ paymentHeader: hdr, requirements, facilitatorUrl: FACIL } as any);
};

// ── ① verify 通过 + settle 成功 + 有 txHash ────────────────────────────────
section('[1] verify 通过 + settle 成功 + 有 txHash → 链上事实成立');
{
  const r: any = await settle('ok_with_hash');
  check('两个端点都真被调用 (verify → settle)', hits.includes('POST /verify') && hits.includes('POST /settle'), hits);
  check('ok=true + mode=facilitator', r.ok === true && r.mode === 'facilitator', { ok: r.ok, mode: r.mode });
  check('拿到真 txHash (不是编的)', typeof r.txHash === 'string' && r.txHash.startsWith('0x') && r.txHash.length > 20, r.txHash);
  check('拿到回执原文 (可绑进信封)', typeof r.receipt === 'string' && r.receipt.length > 0, String(r.receipt).slice(0, 24));
  check('attempted 标记为真', r.attempted === true, r.attempted);
}

// ── ② settle 成功但没有 txHash ─────────────────────────────────────────────
section('[2] settle 成功但没有 txHash → 不能认定链上结算 (Phase 3 的硬规矩)');
{
  const r: any = await settle('ok_without_hash');
  check('ok=true 但 txHash 缺失 (如实返回, 不编一个)', r.ok === true && !r.txHash, { ok: r.ok, txHash: r.txHash });
  const src = fs.readFileSync(path.resolve('src/agents/x402/paid-info-store.ts'), 'utf8');
  // ★ F5 (2026-09-22 链桥): `chainSettled = !!txHash` 是漏洞本身; 现在由真链验证结论决定
  check('代码里 chainSettled 来自真链验证结论 (不再是 "有 txHash 就算结算")',
    !/chainSettled:\s*!!txHash/.test(src) && /verifyPaymentOnChain/.test(src) && /chainSettled:\s*verdict\.chainSettled/.test(src));
}

// ── ③ verify 被拒 ────────────────────────────────────────────────────────
section('[3] facilitator 校验拒绝 → 钱一定没动 (可安全重试)');
{
  const r: any = await settle('verify_rejected');
  check('ok=false + 原因带 invalidReason', r.ok === false && String(r.error).includes('insufficient_funds'), r.error);
  check('attempted=true (发出过凭据)', r.attempted === true);
  check('verifyRejected=true', r.verifyRejected === true);
  check('没有声称结算不确定 (明确没付成)', r.settlementUncertain === false, r.settlementUncertain);
  check('没有走到 settle (被 verify 挡住)', !hits.includes('POST /settle'), hits);
}

// ── ④ settle 失败 ────────────────────────────────────────────────────────
section('[4] settle 失败 → 结算事实不确定 (先对账, 不许重付)');
{
  const r: any = await settle('settle_failed');
  check('ok=false + 原因带 errorReason', r.ok === false && String(r.error).includes('settle_reverted'), r.error);
  check('settlementUncertain=true (链上可能已动钱)', r.settlementUncertain === true);
  check('没有把"不确定"当成"没付过"', r.verifyRejected !== true);
}

// ── ⑤ facilitator 不可达 ─────────────────────────────────────────────────
section('[5] facilitator 不可达 → 同样是不确定 (不许当没付过)');
{
  mode = 'ok_with_hash'; hits = [];
  const r: any = await ST.checkAndSettlePayment({ paymentHeader: header(), requirements, facilitatorUrl: 'http://127.0.0.1:9' } as any);
  check('ok=false + 原因带"不可达"', r.ok === false && String(r.error).includes('不可达'), r.error);
  check('settlementUncertain=true', r.settlementUncertain === true);
  check('attempted=true', r.attempted === true);
}

// ── ⑥ 报价自洽 (网络 / 收款地址 / itemId / 金额上限) ──────────────────────
section('[6] 报价自洽校验: 网络/收款地址/itemId/金额上限 都要对得上');
{
  const metadata = { itemId: 'item-facil-1', payTo: PAY_TO, network: NETWORK, currency: 'USDC', price: '0.001', contentHash: 'sha256:x', providerDid: 'did:key:zS', title: 't', category: 'data' };
  check('全对 → ok', PROTO.validatePaymentRequirements({ requirements: req402, metadata, expected: { itemId: 'item-facil-1', maxAmount: 0.01, networks: [NETWORK] } }).ok === true);
  check('网络不匹配 → 拒', PROTO.validatePaymentRequirements({ requirements: { ...req402, network: 'base-mainnet' }, metadata, expected: { networks: [NETWORK] } }).ok === false);
  check('收款地址不匹配 → 拒 (被篡改?)', PROTO.validatePaymentRequirements({ requirements: { ...req402, payTo: '0x9999999999999999999999999999999999999999' }, metadata }).ok === false);
  check('402 的 itemId 与预期不一致 → 拒', PROTO.validatePaymentRequirements({ requirements: { ...req402, itemId: 'other' }, metadata, expected: { itemId: 'item-facil-1' } }).ok === false);
  check('402 的 itemId 与 metadata 一致 → 通过', PROTO.validatePaymentRequirements({ requirements: { ...req402, itemId: 'item-facil-1' }, metadata, expected: { itemId: 'item-facil-1' } }).ok === true);
  check('金额超上限 → 拒', PROTO.validatePaymentRequirements({ requirements: { ...req402, amount: '50000' }, metadata, expected: { maxAmount: 0.01 } }).ok === false);

  // 凭据绑定: 拿 A 的回执去买 B 必须被拒
  const bound = await ST.checkAndSettlePayment({ paymentHeader: header('item-other'), requirements, facilitatorUrl: FACIL, expectedItemId: 'item-facil-1' } as any);
  check('facilitator 模式下: 回执绑定另一条 itemId → 拒 (回执不能跨资源复用)', bound.ok === false && String(bound.error).includes('不一致'), bound.error);
  const boundOk = await ST.checkAndSettlePayment({ paymentHeader: header('item-facil-1'), requirements, facilitatorUrl: FACIL, expectedItemId: 'item-facil-1' } as any);
  check('凭据绑定一致 → 放行 (不是一律拒)', boundOk.ok === true, boundOk.error);
}

// ── 汇总 ──────────────────────────────────────────────────────────────────
console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
console.log(`mock facilitator: ${FACIL} (真 HTTP, verify/settle 两种端点)`);
console.log('结论: facilitator 四条路径全部如实 (ok+txHash / ok 无 txHash / verify 拒 / settle 失败/不可达→不确定)');
console.log('未覆盖 (等真链): 余额不足 / gas 不足 / 真 RPC 对账 / 真 txHash 可查买卖双方与金额');
try { server.close(); } catch { /* ignore */ }
process.exit(failed === 0 ? 0 : 1);
