/**
 * x402-judgment-command.ts — 判断力资产 x402 化 CLI
 *
 *   bolloon x402 judgment publish --jd <id> [--amount 0.01] [--currency USDC]
 *                                  [--network base] [--pay-to 0x…] [--title …]
 *      发布本机判断力资产 → 得到售卖端点 (外部节点可付费调用)
 *   bolloon x402 judgment call <url> --question "…" [--context …] [--max-payment …]
 *                                  [--key-file <私钥文件>] [--network …]
 *      外部节点付费调用判断力资产 (像连 API 一样: 传问题 → 拿裁决)
 *   bolloon x402 judgment try <jd-id> --question "…" [--context …]
 *      本地试试调用 (不付款): 直接基于该判断力资产对问题做判断
 *
 * 私钥红线 (与 x402-buyer-command 同款): 私钥只从文件/env 读, 只打印地址, 永不进输出。
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

function fail(msg: string): never {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('--'));
}

/** 从 --key-file / env 读私钥 (0x 前缀可省)。只打印地址。 */
async function readPrivateKey(args: string[]): Promise<string | undefined> {
  const file = opt(args, '--key-file') || process.env.X402_PRIVATE_KEY_FILE;
  if (file) {
    const raw = (await fs.readFile(path.resolve(file), 'utf-8')).trim();
    return raw;
  }
  if (process.env.X402_PRIVATE_KEY) return process.env.X402_PRIVATE_KEY;
  return undefined;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

async function cmdPublish(rest: string[]): Promise<number> {
  const jdId = opt(rest, '--jd') || opt(rest, '--id');
  if (!jdId) fail('--jd <jd-id> 必填 (判断力资产 id)');
  const payTo = opt(rest, '--pay-to');
  if (!payTo) fail('--pay-to <0x…> 必填 (收款地址; 判断力资产卖的钱进这个地址)');
  const amount = opt(rest, '--amount') || '0.01';
  const currency = opt(rest, '--currency') || 'USDC';
  const network = opt(rest, '--network') || 'base-sepolia';
  const title = opt(rest, '--title');

  const { publishJudgenessAsPaidInfo, sellingUrl } = await import('../judgeness/paid-export.js');
  const { item } = await publishJudgenessAsPaidInfo(jdId, {
    amount,
    currency: currency.toUpperCase() === 'ETH' ? 'ETH' : 'USDC',
    network,
    payTo,
    title,
  });
  const url = sellingUrl(item.id);
  console.log(`✅ 判断力资产已上架 (外部节点可付费调用)`);
  console.log(`  jd: ${jdId}`);
  console.log(`  信息 id: ${item.id}`);
  console.log(`  价格: ${item.price.amount} ${item.price.currency} @ ${item.price.network}`);
  console.log(`  收款: ${item.price.payTo}`);
  console.log(`  内容哈希: ${item.contentHash}`);
  console.log(`  售卖端点: ${url}`);
  console.log(`  外部节点调用: bolloon x402 judgment call ${url} --question "要判断的问题"`);
  console.log(`  本地试调用:   bolloon x402 judgment try ${jdId} --question "要判断的问题"`);
  return 0;
}

// ---------------------------------------------------------------------------
// call (外部节点付费调用, 像连 API 一样)
// ---------------------------------------------------------------------------

async function cmdCall(rest: string[]): Promise<number> {
  const url = positional(rest);
  if (!url) fail('用法: bolloon x402 judgment call <url> --question "…" [--key-file <私钥文件>]');
  const question = opt(rest, '--question');
  if (!question) fail('--question 必填 (要判断的问题/场景)');
  const privateKey = await readPrivateKey(rest).catch(() => undefined);
  if (!privateKey) {
    fail('需要付款私钥: --key-file <私钥文件> 或 X402_PRIVATE_KEY (外部节点用自己的钱包付费)');
  }
  const callUrl = /\/call$/i.test(url) ? url : `${url.replace(/\/+$/, '')}/call`;

  const { x402Fetch } = await import('../agents/x402/x402Pay.js');
  const r = await x402Fetch({
    url: callUrl,
    method: 'POST',
    body: JSON.stringify({
      question,
      context: opt(rest, '--context') || undefined,
    }),
    privateKey,
    network: opt(rest, '--network') || undefined,
    maxPaymentAmount: opt(rest, '--max-payment') || undefined,
  });
  if (!r.success) {
    const data = r.data as any;
    const hint = data?.accepts?.[0]
      ? ` (需付款 ${data.accepts[0].amount} ${data.accepts[0].asset?.slice(0, 10) || ''}…)`
      : '';
    fail(`${r.error || '调用失败'}${hint}`);
  }
  const body = r.data as any;
  const j = body?.judgment;
  console.log(`✅ 判断力资产调用完成: ${body?.itemId || url}`);
  console.log(
    `  付款: ${body?.payment?.amount ?? '?'} ${body?.payment?.currency ?? ''} (${body?.payment?.mode ?? '?'})` +
    (body?.payment?.txHash ? ` tx=${String(body.payment.txHash).slice(0, 24)}…` : ''),
  );
  if (j) {
    console.log(`  裁决: ${j.verdict} (把握度 ${j.confidence})`);
    console.log(`  理由: ${j.reasoning}`);
    if (j.values?.length) console.log(`  价值: ${j.values.join(' · ')}`);
  } else {
    console.log(`  判断服务不可用: ${body?.judgmentError || '未知'} (已付款, 拿到资产本体见下)`);
    console.log('  资产本体:', String(body?.asset || '').slice(0, 1500));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// try (本地试试调用 — 卖家发布前先试判断效果, 不付款)
// ---------------------------------------------------------------------------

async function cmdTry(rest: string[]): Promise<number> {
  const jdId = positional(rest);
  if (!jdId) fail('用法: bolloon x402 judgment try <jd-id> --question "…"');
  const question = opt(rest, '--question');
  if (!question) fail('--question 必填 (要判断的问题/场景)');

  const { loadDescription } = await import('../judgeness/store.js');
  const { judgenessToPaidMarkdown } = await import('../judgeness/paid-export.js');
  const { judgeWithAsset } = await import('../judgeness/call-service.js');
  const jd = await loadDescription(jdId);
  if (!jd) fail(`判断力资产不存在: ${jdId}`);

  let llm: any = null;
  try {
    const { initMinimax, getMinimax } = await import('../constraints/index.js');
    initMinimax();
    llm = getMinimax();
  } catch (e: any) {
    fail(`本地 LLM 不可用: ${String(e?.message || e).slice(0, 160)} (先跑 bolloon setup 配好模型)`);
  }

  const assetText = judgenessToPaidMarkdown(jd);
  console.log(`🔮 基于判断力资产 ${jdId} 试判断: ${question}`);
  const result = await judgeWithAsset({
    assetText,
    question,
    context: opt(rest, '--context') || undefined,
    llm: async (system, user) => {
      try {
        const r = await llm.chat(user, system);
        return r?.reply ? String(r.reply) : null;
      } catch (e: any) {
        console.error(`  LLM 调用失败: ${String(e?.message || e).slice(0, 120)}`);
        return null;
      }
    },
  });
  if (!result) {
    fail('判断生成失败 (LLM 输出无法解析) — 可重试, 或先发布后再让外部节点调用');
  }
  console.log(`  裁决: ${result.verdict} (把握度 ${result.confidence})`);
  console.log(`  理由: ${result.reasoning}`);
  if (result.values?.length) console.log(`  价值: ${result.values.join(' · ')}`);
  return 0;
}

export async function x402JudgmentCommand(rest: string[]): Promise<number> {
  const sub = rest[0];
  const inner = rest.slice(1);
  switch (sub) {
    case 'publish': return cmdPublish(inner);
    case 'call': return cmdCall(inner);
    case 'try': return cmdTry(inner);
    case 'list': {
      const { listInfo } = await import('../agents/x402/paid-info-store.js');
      const items = (await listInfo()).filter((i) => String(i.title || '').includes('判断力资产'));
      if (!items.length) {
        console.log('本机还没有上架任何判断力资产 (用 bolloon x402 judgment publish --jd <id> --pay-to 0x… 发布)');
        return 0;
      }
      console.log(`已上架 ${items.length} 条判断力资产:`);
      for (const i of items) {
        console.log(`  ${i.id}  ${i.title} — ${i.price.amount} ${i.price.currency} @ ${i.price.network} · ${i.contentHash.slice(0, 16)}…`);
      }
      return 0;
    }
    default:
      console.log('用法: bolloon x402 judgment <publish|call|try|list>');
      console.log('  publish --jd <jd-id> [--amount 0.01] [--currency USDC] [--network base-sepolia] --pay-to 0x…');
      console.log('    发布本机判断力资产 → 外部节点可付费调用');
      console.log('  call <url> --question "…" [--context …] [--max-payment …] [--key-file <私钥>]');
      console.log('    外部节点付费调用 (像连 API 一样: 传问题 → 拿裁决)');
      console.log('  try <jd-id> --question "…" [--context …]');
      console.log('    本地试试调用 (不付款, 卖家发布前自测)');
      console.log('  list — 列出本机已上架的判断力资产');
      return sub ? 1 : 0;
  }
}
