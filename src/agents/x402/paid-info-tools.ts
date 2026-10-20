/**
 * paid-info-tools.ts — 微支付信息服务 的 agent 工具集
 *
 *   x402_info_publish    发布一条付费信息 (数据/技能/商品/艺术作品/其它) → 得到售卖 URL
 *   x402_info_list       列出本机已发布的信息
 *   x402_info_unpublish  下架
 *   x402_info_buy        走 x402 微支付买下别人的信息 → 返回内容 + 验真报告
 *   x402_info_verify     只验真 (不付款): 传 URL 或信封 JSON
 *
 * DID → 公钥 解析 (验真升到 verified 的前提):
 *   ① 本机身份 (identity.json / agent-keys / user.json)
 *   ② 本地 Kubo: key/list 里名为 did-<did> 的 IPNS key → name/resolve → cat DID 文档 (跨机器路径)
 * 两者都拿不到 → 验真报告降级为 self-attested 并写清原因 (不假装可信)。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ToolRegistryContext } from '../pi-sdk-tools.js';
import { kuboApi } from '../pi-sdk-tools.js';
import {
  verifyEnvelope, summarizeVerify, type DidKeyResolver, type InfoCategory,
} from './paid-info-protocol.js';
import { publishInfo, listInfo, removeInfo, getStoredInfo, buyInfo } from './paid-info-store.js';

const CATEGORIES: InfoCategory[] = ['data', 'skill', 'goods', 'art', 'other'];

/** 本地身份里的 did → 公钥 */
async function localDidKey(did: string): Promise<string | null> {
  const home = os.homedir();
  const files = [
    path.join(home, '.bolloon', 'identity.json'),
    path.join(home, '.bolloon', 'identity', 'user.json'),
  ];
  try {
    const keyDir = path.join(home, '.bolloon', 'agent-keys');
    for (const f of await fs.readdir(keyDir)) files.push(path.join(keyDir, f));
  } catch { /* 无 agent-keys 目录 */ }
  for (const f of files) {
    try {
      const raw = JSON.parse(await fs.readFile(f, 'utf-8'));
      if (raw?.did !== did) continue;
      // 身份文件里公钥有 hex / base64 两种历史格式, 都要认
      const pkVal = raw.publicKeyHex ?? raw.publicKey;
      if (typeof pkVal === 'string') {
        if (/^[0-9a-f]{64}$/i.test(pkVal)) return pkVal.toLowerCase();
        const buf = Buffer.from(pkVal, 'base64');
        if (buf.length === 32) return buf.toString('hex');
      } else if (pkVal) {
        const buf = Buffer.from(pkVal);
        if (buf.length === 32) return buf.toString('hex');
      }
    } catch { /* 跳过坏文件 */ }
  }
  return null;
}

/** 本地 Kubo: did-<did> 这个 IPNS key → 解析 → 读 DID 文档取公钥 (跨机器验真路径) */
async function ipfsDidKey(did: string): Promise<string | null> {
  try {
    const keyName = `did-${did}`;
    const keys = await kuboApi('/api/v0/key/list');
    const hit = (keys?.Keys || []).find((k: any) => k?.Name === keyName);
    if (!hit?.Id) return null;
    const resolved = await kuboApi(`/api/v0/name/resolve?arg=${encodeURIComponent(hit.Id)}&nocache=true`, undefined, 8000);
    const cid = String(resolved?.Path || '').replace(/^\/ipfs\//, '');
    if (!cid) return null;
    const doc = JSON.parse(String(await kuboApi(`/api/v0/cat?arg=${encodeURIComponent(cid)}`, undefined, 8000)));
    const vm = doc?.verificationMethod?.[0];
    const pkHex = vm?.publicKeyHex || vm?.publicKeyMultibase || doc?.publicKeyHex;
    if (typeof pkHex === 'string' && /^[0-9a-f]{64}$/i.test(pkHex)) return pkHex.toLowerCase();
    return null;
  } catch {
    return null;
  }
}

export function makeDidResolver(): DidKeyResolver {
  return async (did: string) => {
    const local = await localDidKey(did);
    if (local) return { publicKeyHex: local };
    const viaIpfs = await ipfsDidKey(did);
    return viaIpfs ? { publicKeyHex: viaIpfs } : null;
  };
}

export function registerPaidInfoTools(ctx: ToolRegistryContext): void {
  // ---- 发布 ----
  ctx.tools.set('x402_info_publish', {
    name: 'x402_info_publish',
    description: '发布一条"微支付信息": 数据 / 技能 / 商品信息 / 艺术作品 / 其它。发布后别的智能体访问 /api/x402/info/<id> 会收到 x402 402 付款要求, 付款通过才拿到内容, 且内容带签名信封 (可验真)。价格与收款地址来自参数或 channel 钱包。',
    parameters: {
      title: '信息标题 (必填)',
      category: `类别: ${CATEGORIES.join(' | ')} (默认 other)`,
      content: '要卖的信息本体 (必填, 文本/JSON 字符串)',
      price_amount: '单价 (如 0.002; 默认 0)',
      currency: '计价币种: USDC | ETH (默认 USDC)',
      network: '结算网络: base | base-sepolia | sepolia | mainnet (默认 base-sepolia)',
      pay_to: '收款地址 0x… (可选, 默认用 channel 钱包地址)',
      source_kind: '来源声明: self(自述) | measured(自测) | derived(公开数据推导) | quoted(引用他人)',
      source_refs: '来源引用, 分号分隔 (网址/CID/论文/商品页) — 真实性依据, 强烈建议给',
      source_note: '来源补充说明 (可选)',
      content_cid: '可选: 内容已上 IPFS 时的 CID (买方可独立核验)',
    },
    execute: async (args) => {
      try {
        const title = String(args.title || '').trim();
        const content = String(args.content ?? '');
        if (!title) return { success: false, error: 'title 必填' };
        if (!content) return { success: false, error: 'content 必填' };
        let payTo = String(args.pay_to || '').trim();
        if (!payTo && ctx.getChannelWallet) {
          const w = await ctx.getChannelWallet().catch(() => null);
          if (w?.walletAddress) payTo = w.walletAddress;
        }
        if (!payTo) {
          return { success: false, error: '缺少收款地址: 传 pay_to, 或先给当前 channel 绑定钱包 (wallet_create)' };
        }
        const category = (CATEGORIES.includes(String(args.category || '').toLowerCase() as InfoCategory)
          ? String(args.category).toLowerCase()
          : 'other') as InfoCategory;
        const refs = String(args.source_refs || '').split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
        const item = await publishInfo({
          title,
          category,
          content,
          description: String(args.description || '').trim() || undefined,
          price: {
            amount: String(args.price_amount ?? '0'),
            currency: String(args.currency || 'USDC').toUpperCase() === 'ETH' ? 'ETH' : 'USDC',
            network: String(args.network || 'base-sepolia'),
            payTo,
          },
          provider: { did: ctx.identity?.did || '', name: ctx.identity?.name, agentId: (ctx as any).agentId },
          source: {
            kind: (['self', 'measured', 'derived', 'quoted'].includes(String(args.source_kind))
              ? String(args.source_kind)
              : 'self') as any,
            refs,
            note: String(args.source_note || '').trim() || undefined,
          },
          contentCid: String(args.content_cid || '').trim() || undefined,
        });
        const port = process.env.PORT || '54188';
        return {
          success: true,
          output: `✅ 已发布付费信息\n  id: ${item.id}\n  标题: ${item.title} (${item.category})\n  价格: ${item.price.amount} ${item.price.currency} @ ${item.price.network}\n  收款: ${item.price.payTo}\n  内容哈希: ${item.contentHash}\n  售卖端点: http://127.0.0.1:${port}/api/x402/info/${item.id}\n  买方可直接: x402_info_buy(url="http://<你的地址>:${port}/api/x402/info/${item.id}")`,
        };
      } catch (e: any) {
        return { success: false, error: `发布失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // ---- 列出 / 下架 ----
  ctx.tools.set('x402_info_list', {
    name: 'x402_info_list',
    description: '列出本机已发布的微支付信息 (标题/类别/价格/哈希)。',
    parameters: { category: '可选: 只看某类别 (data|skill|goods|art|other)' },
    execute: async (args) => {
      const cat = String(args.category || '').toLowerCase();
      const items = (await listInfo()).filter((i) => !cat || i.category === cat);
      if (items.length === 0) return { success: true, output: '本机还没有发布任何付费信息 (用 x402_info_publish 发布)' };
      return {
        success: true,
        output: `已发布 ${items.length} 条:\n${items.map((i) => `  ${i.id}  [${i.category}] ${i.title} — ${i.price.amount} ${i.price.currency} · ${i.contentHash.slice(0, 18)}…`).join('\n')}`,
      };
    },
  });

  ctx.tools.set('x402_info_unpublish', {
    name: 'x402_info_unpublish',
    description: '下架一条已发布的付费信息 (按 id)。',
    parameters: { id: '信息 id (必填)' },
    execute: async (args) => {
      const id = String(args.id || '').trim();
      if (!id) return { success: false, error: 'id 必填' };
      const existed = await getStoredInfo(id);
      if (!existed) return { success: false, error: `没有 id=${id} 的信息` };
      await removeInfo(id);
      return { success: true, output: `✅ 已下架 ${id} (${existed.item.title})` };
    },
  });

  // ---- 购买 ----
  ctx.tools.set('x402_info_buy', {
    name: 'x402_info_buy',
    description: '走 x402 微支付买下另一智能体发布的信息: 先请求 → 收 402 → 用钱包签名付款 → 重试拿到内容 + 签名信封, 然后自动验真 (签名/内容哈希/支付绑定/DID/DID 来源)。付款能力优先用当前 channel 钱包。',
    parameters: {
      url: '信息售卖端点 (必填, 如 http://host:54188/api/x402/info/<id>)',
      max_payment: '可接受的最高单价 (如 0.01; 超过则拒付)',
      network: '可选: 限定网络',
      item_id: '可选: 期望的 itemId (防掉包), 从 402 的 extra.itemId 或分享链接拿',
      allow_local_dev: '可选: "true" 允许本机联调凭据 (仅同机测试, 不是链上支付)',
    },
    execute: async (args) => {
      const url = String(args.url || '').trim();
      if (!url) return { success: false, error: 'url 必填' };
      try {
        // 付款私钥: 优先当前 channel 钱包 (AES-GCM 解密)
        let privateKey = '';
        if (ctx.getChannelWallet) {
          const w = await ctx.getChannelWallet().catch(() => null);
          if (w?.encryptedPrivateKey) {
            try {
              const { decryptChannelWallet } = await import('./x402Pay.js');
              const dec = await decryptChannelWallet(
                {
                  encryptedPrivateKey: w.encryptedPrivateKey,
                  encryptedPrivateKeyIv: w.encryptedPrivateKeyIv,
                  walletAddress: w.walletAddress,
                },
                w.did,
              );
              privateKey = dec?.privateKey || '';
            } catch { /* 解密失败 → 走到无 key 分支 */ }
          }
        }
        const allowLocalDev = String(args.allow_local_dev ?? '').toLowerCase() === 'true';
        const result = await buyInfo({
          url,
          privateKey: privateKey || undefined,
          maxPaymentAmount: String(args.max_payment || '').trim() || undefined,
          network: String(args.network || '').trim() || undefined,
          allowLocalDev,
          resolveDid: makeDidResolver(),
          expectItemId: String(args.item_id || '').trim() || undefined,
        });
        if (!result.ok) return { success: false, error: result.error };
        const env = result.envelope;
        const report = result.verify;
        const content = String(env?.content ?? '');
        return {
          success: true,
          output: [
            `✅ 已购得: ${env?.item?.title ?? '(无标题)'} [${env?.item?.category ?? '?'}]`,
            `  提供方: ${env?.item?.provider?.name || ''} ${env?.item?.provider?.did || ''}`,
            `  付款: ${env?.payment?.amount ?? '?'} ${env?.payment?.currency ?? ''} (${env?.payment?.mode ?? '?'})${result.payment?.txHash ? ` tx=${String(result.payment.txHash).slice(0, 24)}…` : ''}`,
            `  验真: ${report ? summarizeVerify(report) : '(信封无签名, 无法验真)'}`,
            `  来源: ${env?.item?.source?.kind} ${(env?.item?.source?.refs || []).join(' ')}`,
            '',
            '内容:',
            content.slice(0, 4000),
          ].join('\n'),
        };
      } catch (e: any) {
        return { success: false, error: `购买失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // ---- 只验真 ----
  ctx.tools.set('x402_info_verify', {
    name: 'x402_info_verify',
    description: '验真一条已拿到的付费信息 (不付款): 传 URL 或信封 JSON (payment 之后的完整返回)。检查内容哈希、提供方 Ed25519 签名、支付回执绑定、DID 公钥绑定、来源引用, 给出 verified / self-attested / content-only / unverified 分档。',
    parameters: { ref: 'URL 或信封 JSON 字符串 (必填)', item_id: '可选: 期望 itemId (防掉包)' },
    execute: async (args) => {
      const ref = String(args.ref || '').trim();
      if (!ref) return { success: false, error: 'ref 必填' };
      try {
        let env: any;
        if (/^https?:\/\//i.test(ref)) {
          const res = await fetch(ref);
          const text = await res.text();
          if (res.status === 402) {
            const body = JSON.parse(text);
            return {
              success: true,
              output: `该资源需要付款 (402)。付款要求: ${JSON.stringify(body?.accepts?.[0] || {}, null, 1)}\n提示: 用 x402_info_buy 付款后拿到的信封再回本工具验真。`,
            };
          }
          env = JSON.parse(text);
        } else {
          env = JSON.parse(ref);
        }
        const report = await verifyEnvelope(env, {
          resolveDid: makeDidResolver(),
          expectItemId: String(args.item_id || '').trim() || undefined,
        });
        const lines = [
          `验真结论: ${summarizeVerify(report)}`,
          `提供方: ${env?.item?.provider?.name || ''} ${env?.item?.provider?.did || ''}`,
          `内容哈希: ${env?.item?.contentHash || '?'}${report.checks.find((c) => c.name === 'content-integrity')?.ok ? ' (与内容一致 ✅)' : ' (不一致 ❌)'}`,
          `来源: [${env?.item?.source?.kind}] ${(env?.item?.source?.refs || []).join(' ') || '(无引用)'}`,
          '',
          '逐项检查:',
          ...report.checks.map((c) => `  ${c.ok ? '✅' : '❌'} ${c.name}: ${c.detail}`),
        ];
        if (report.warnings.length) lines.push('', '提示:', ...report.warnings.map((w) => `  · ${w}`));
        return { success: true, output: lines.join('\n') };
      } catch (e: any) {
        return { success: false, error: `验真失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  // ---- 判断力资产 x402 化 (2026-10-20): 判断力资产可被外部节点付费调用 ----
  ctx.tools.set('x402_judgment_publish', {
    name: 'x402_judgment_publish',
    description: '发布一条本机判断力资产 (judgeness description) 为 x402 付费信息: 外部节点付费调用后拿到 5 维评分 + 依据 + 作用域。价格与收款地址来自参数或 channel 钱包。判断力资产 id 用 judgment_list 查。',
    parameters: {
      jd_id: '判断力资产 id (jd-xxx, 必填)',
      price_amount: '单价 (如 0.002; 默认 0)',
      currency: '计价币种: USDC | ETH (默认 USDC)',
      network: '结算网络: base | base-sepolia | sepolia | mainnet (默认 base-sepolia)',
      pay_to: '收款地址 0x… (可选, 默认用 channel 钱包地址)',
      title: '可选: 上架标题 (默认 "判断力资产 <jd-id>")',
    },
    execute: async (args) => {
      try {
        const jdId = String(args.jd_id || '').trim();
        if (!jdId) return { success: false, error: 'jd_id 必填 (用 judgment_list 查可用 id)' };
        let payTo = String(args.pay_to || '').trim();
        if (!payTo && ctx.getChannelWallet) {
          const w = await ctx.getChannelWallet().catch(() => null);
          if (w?.walletAddress) payTo = w.walletAddress;
        }
        if (!payTo) {
          return { success: false, error: '缺少收款地址: 传 pay_to, 或先给当前 channel 绑定钱包 (wallet_create)' };
        }
        const { publishJudgenessAsPaidInfo, sellingUrl } = await import('../../judgeness/paid-export.js');
        const { item } = await publishJudgenessAsPaidInfo(jdId, {
          amount: String(args.price_amount ?? '0'),
          currency: String(args.currency || 'USDC').toUpperCase() === 'ETH' ? 'ETH' : 'USDC',
          network: String(args.network || 'base-sepolia'),
          payTo,
          title: String(args.title || '').trim() || undefined,
        });
        return {
          success: true,
          output: `✅ 判断力资产已上架 (外部节点可付费调用)\n  jd: ${jdId}\n  信息 id: ${item.id}\n  价格: ${item.price.amount} ${item.price.currency} @ ${item.price.network}\n  收款: ${item.price.payTo}\n  内容哈希: ${item.contentHash}\n  售卖端点: ${sellingUrl(item.id)}\n  外部节点: x402_judgment_fetch(url="${sellingUrl(item.id)}")`,
        };
      } catch (e: any) {
        return { success: false, error: `发布失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });

  ctx.tools.set('x402_judgment_call', {
    name: 'x402_judgment_call',
    description: '付费调用外部节点的判断力资产 (x402, 像连 API 一样): 传问题/场景, 对方基于该判断力资产返回裁决 (verdict/confidence/reasoning)。付款走标准 x402 自动支付 (402 → 签名付款 → 重试)。',
    parameters: {
      url: '判断力资产售卖端点 (必填, 如 http://host:54188/api/x402/info/<id>)',
      question: '要判断的问题/场景 (必填)',
      context: '可选: 背景上下文',
      max_payment: '可接受的最高单价 (如 0.01; 超过则拒付)',
      network: '可选: 限定网络',
    },
    execute: async (args) => {
      const url = String(args.url || '').trim();
      const question = String(args.question || '').trim();
      if (!url) return { success: false, error: 'url 必填' };
      if (!question) return { success: false, error: 'question 必填 (要判断的问题/场景)' };
      try {
        let privateKey = '';
        if (ctx.getChannelWallet) {
          const w = await ctx.getChannelWallet().catch(() => null);
          if (w?.encryptedPrivateKey) {
            try {
              const { decryptChannelWallet } = await import('./x402Pay.js');
              const dec = await decryptChannelWallet(
                {
                  encryptedPrivateKey: w.encryptedPrivateKey,
                  encryptedPrivateKeyIv: w.encryptedPrivateKeyIv,
                  walletAddress: w.walletAddress,
                },
                w.did,
              );
              privateKey = dec?.privateKey || '';
            } catch { /* 解密失败 → 走到无 key 分支 */ }
          }
        }
        const callUrl = /\/call$/i.test(url) ? url : `${url.replace(/\/+$/, '')}/call`;
        const { x402Fetch } = await import('./x402Pay.js');
        const r = await x402Fetch({
          url: callUrl,
          method: 'POST',
          body: JSON.stringify({
            question,
            context: String(args.context || '').trim() || undefined,
          }),
          privateKey: privateKey || undefined,
          network: String(args.network || '').trim() || undefined,
          maxPaymentAmount: String(args.max_payment || '').trim() || undefined,
        });
        if (!r.success) {
          const data = r.data as any;
          const hint = data?.accepts?.[0] ? ` (需付款 ${data.accepts[0].amount} ${data.accepts[0].asset || ''})` : '';
          return { success: false, error: `${r.error || '调用失败'}${hint}` };
        }
        const body = r.data as any;
        const j = body?.judgment;
        const lines = [
          `✅ 判断力资产调用完成: ${body?.itemId || url}`,
          `  付款: ${body?.payment?.amount ?? '?'} ${body?.payment?.currency ?? ''} (${body?.payment?.mode ?? '?'})${body?.payment?.txHash ? ` tx=${String(body.payment.txHash).slice(0, 24)}…` : ''}`,
        ];
        if (j) {
          lines.push(
            `  裁决: ${j.verdict} (把握度 ${j.confidence})`,
            `  理由: ${j.reasoning}`,
          );
          if (j.values?.length) lines.push(`  价值: ${j.values.join(' · ')}`);
        } else {
          lines.push(`  判断服务不可用: ${body?.judgmentError || '未知'} (已付费用方拿到资产本体, 见下)`);
          lines.push('  资产本体:', String(body?.asset || '').slice(0, 1500));
        }
        return { success: true, output: lines.join('\n') };
      } catch (e: any) {
        return { success: false, error: `调用失败: ${String(e?.message || e).slice(0, 200)}` };
      }
    },
  });
}
