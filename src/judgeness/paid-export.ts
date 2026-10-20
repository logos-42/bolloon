/**
 * paid-export.ts — 判断力资产 x402 化 (判断力资产被外部节点付费调用)
 *
 *   judgenessToPaidMarkdown(jd)        判断力描述 → 可售卖正文 (5 维 facets + basis + scope)
 *   publishJudgenessAsPaidInfo(jdId,…) 发布为 x402 付费信息 (复用 paid-info-store.publishInfo)
 *   parsePaidJudgeness(markdown)       调用侧解析: 买到的正文还原成结构化 5 维 ("调用"语义)
 *
 * 设计纪律: 连线不建新系统 — 发布/付款/验真全部复用既有 x402 链路,
 * 本模块只负责 "判断力 ↔ 售卖正文" 的互转与发布封装。
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { JudgenessDescription } from './types.js';
import { loadDescription } from './store.js';
import { publishInfo, type PublishInfoInput } from '../agents/x402/paid-info-store.js';

/** 判断力资产在 x402 里的类别 (挂在既有 InfoCategory 上, 不新造类别) */
export const JUDGENESS_INFO_CATEGORY = 'data' as const;

const FACET_KEYS = ['judgment', 'taste_aesthetic', 'novelty_score', 'imaginative_score', 'curiosity_vector'] as const;
const BASIS_KEYS = ['taste_basis', 'novelty_basis', 'imagination_basis'] as const;

function fmtNum(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a';
}

/**
 * 判断力描述 → 可售卖正文。
 * 买家拿到的是完整判断力资产: 5 维评分 + 依据 + 作用域 + 描述原文。
 * judgmentRef 是内部外键 (指向 HumanJudgment 库), 保留作资产来源标识。
 */
export function judgenessToPaidMarkdown(jd: JudgenessDescription): string {
  const lines: string[] = [];
  lines.push(`# 判断力资产 ${jd.descriptionId}`);
  lines.push('');
  lines.push(`- 来源判断: \`${jd.judgmentRef}\``);
  lines.push(`- 描述版本: ${jd.description_version}`);
  lines.push(`- 作用域: ${(jd.scope?.domains || []).join(' / ') || '未限定'} · 主题: ${(jd.scope?.topics || []).join(' / ') || '未限定'}`);
  lines.push('');
  lines.push('## 5 维评分 (0..1)');
  lines.push('');
  for (const k of FACET_KEYS) lines.push(`- ${k}: ${fmtNum(jd.facets?.[k])}`);
  lines.push('');
  lines.push('## 依据 (basis)');
  lines.push('');
  for (const k of BASIS_KEYS) {
    const v = jd.basis?.[k];
    lines.push(`- ${k}: ${v && v.trim() ? v.trim() : 'n/a'}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 调用侧解析: 把买到的正文还原成结构化判断力 (5 维 + 依据 + 作用域)。 */
export function parsePaidJudgeness(markdown: string): {
  descriptionId?: string;
  judgmentRef?: string;
  facets: Record<string, number | undefined>;
  basis: Record<string, string | undefined>;
  domains: string[];
  topics: string[];
} | null {
  if (!markdown || !markdown.includes('判断力资产')) return null;
  const facets: Record<string, number | undefined> = {};
  const basis: Record<string, string | undefined> = {};
  let domains: string[] = [];
  let topics: string[] = [];
  let descriptionId: string | undefined;
  let judgmentRef: string | undefined;

  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const facet = line.match(/^- (judgment|taste_aesthetic|novelty_score|imaginative_score|curiosity_vector): (.+)$/);
    if (facet) {
      const v = facet[2].trim();
      facets[facet[1]] = v === 'n/a' ? undefined : Number(v);
      continue;
    }
    const b = line.match(/^- (taste_basis|novelty_basis|imagination_basis): (.+)$/);
    if (b) {
      basis[b[1]] = b[2].trim() === 'n/a' ? undefined : b[2].trim();
      continue;
    }
    const idm = line.match(/^# 判断力资产 (\S+)$/);
    if (idm) { descriptionId = idm[1]; continue; }
    const refm = line.match(/^- 来源判断: `(\S+)`$/);
    if (refm) { judgmentRef = refm[1]; continue; }
    const scope = line.match(/^- 作用域: (.*)$/);
    if (scope) {
      const [d, t] = scope[1].split('·');
      domains = (d || '').replace('主题:', '').split('/').map((s) => s.trim()).filter((s) => s && s !== '未限定');
      topics = (t || '').replace('主题:', '').split('/').map((s) => s.trim()).filter((s) => s && s !== '未限定');
      continue;
    }
  }

  return {
    descriptionId,
    judgmentRef,
    facets,
    basis,
    domains,
    topics,
  };
}

/** 读取本机 DIAP 身份 (发布判断力资产时作 provider)。 */
export async function localProvider(): Promise<{ did: string; name?: string; agentId?: string } | null> {
  const home = os.homedir();
  for (const f of [
    path.join(home, '.bolloon', 'identity.json'),
    path.join(home, '.bolloon', 'identity', 'user.json'),
  ]) {
    try {
      const raw = JSON.parse(await fs.readFile(f, 'utf-8'));
      if (raw?.did) {
        return { did: String(raw.did), name: raw.name || raw.agentName || undefined, agentId: raw.agentId || undefined };
      }
    } catch { /* 跳过坏文件 */ }
  }
  return null;
}

export interface PublishJudgenessOptions {
  amount: string;
  currency?: 'USDC' | 'ETH';
  network?: string;
  payTo: string;
  title?: string;
  home?: string;
}

/**
 * 把一条判断力资产发布为 x402 付费信息。
 * 返回 item (含 id / contentHash / 售卖 URL 拼装所需的全部字段)。
 */
export async function publishJudgenessAsPaidInfo(
  jdId: string,
  opts: PublishJudgenessOptions,
): Promise<{ item: Awaited<ReturnType<typeof publishInfo>>; markdown: string; jd: JudgenessDescription }> {
  const home = opts.home ?? os.homedir();
  const jd = await loadDescription(jdId);
  if (!jd) throw new Error(`判断力资产不存在: ${jdId} (用 bolloon judgment list 查可用的 id)`);
  if (!opts.payTo) throw new Error('price.payTo 必填 (收款地址)');
  const provider = await localProvider();
  if (!provider?.did) throw new Error('缺少本机 DIAP 身份 (~/.bolloon/identity.json) — 先跑 bolloon setup');

  const markdown = judgenessToPaidMarkdown(jd);
  const input: PublishInfoInput = {
    title: opts.title?.trim() || `判断力资产 ${jdId}`,
    category: JUDGENESS_INFO_CATEGORY,
    content: markdown,
    description: '可付费调用的判断力资产: 5 维评分 + 依据 + 作用域, 外部节点付费取得后可注入自身判断.',
    price: {
      amount: String(opts.amount ?? '0'),
      currency: opts.currency || 'USDC',
      network: opts.network || 'base-sepolia',
      payTo: opts.payTo,
    },
    source: { kind: 'self', refs: [`judgeness:${jdId}`] },
    provider,
  };
  const item = await publishInfo(input, { home });
  return { item, markdown, jd };
}

/** 发布后拼售卖 URL (与 paid-info-tools 的 x402_info_publish 同一口径)。 */
export function sellingUrl(itemId: string, port = process.env.PORT || '54188'): string {
  return `http://127.0.0.1:${port}/api/x402/info/${itemId}`;
}
