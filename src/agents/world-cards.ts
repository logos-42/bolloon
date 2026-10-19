/**
 * world-cards.ts — 世界卡片信箱 (2026-10-19)
 *
 * 设计: 外部/对方智能体用 DIAP Ed25519 身份签名投递一张「世界卡片」到本机世界模式,
 *   验签通过才入库 (~/.bolloon/world/cards/<id>.json) 并进入世界流 (scanOpportunities, reason='card')。
 *   卡片内容格式不限: media 数组里每一项可是 text / audio / image / video (url + mime + name)。
 *
 * 协议: bolloon-world-card/1
 *   POST payload = { id?, title, summary, media[], provider:{did}, issuedAt }
 *   signature  = ed25519Sign(privateKey, canonicalCardPayload(payload))
 *   验证 = ed25519Verify(providerPublicKey, canonicalCardPayload(payload), signature)
 *
 * 未来: P2P world.card 广播 (mobile-core pushNearbyCard) 是卡片的另一条入站通道,
 *   需要第二个真实节点 (诚实边界, 单机未验)。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { worldDir } from './intent-store.js';
import { resolveDidPublicKey } from './opportunity-inbox.js';
import { canonicalize, ed25519Verify } from './x402/paid-info-protocol.js';

export const CARD_PROTOCOL = 'bolloon-world-card/1';

/** 卡片作用域: public = 公域 (广播给所有已连接节点, 任何节点可收) · private = 好友定向 (只发指定 DID) */
export type CardScope = 'public' | 'private';

export type CardMediaType = 'text' | 'audio' | 'image' | 'video';

export interface CardMedia {
  type: CardMediaType;
  url: string;
  mime: string;
  name: string;
}

export interface WorldCard {
  protocol: string;
  id: string;
  title: string;
  summary: string;
  media: CardMedia[];
  /** 公域 (public) 或好友定向 (private, 缺省) */
  scope: CardScope;
  provider: { did: string; name?: string };
  issuedAt: string;
  /** 验签结果: verified | signature-invalid | unverified */
  verification: 'verified' | 'signature-invalid' | 'unverified';
  receivedAt: number;
}

export interface CardPayload {
  protocol: string;
  id?: string;
  title: string;
  summary: string;
  media?: CardMedia[];
  /** public = 公域广播 (任何节点可收) · private/缺省 = 好友定向 */
  scope?: CardScope;
  provider: { did: string; name?: string };
  issuedAt: string;
}

export interface DeliverCardResult {
  ok: boolean;
  card?: WorldCard;
  error?: string;
}

const cardsDir = (): string => path.join(worldDir(), 'cards');

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** 把卡片载荷按签名标准序列化 (必须与签名时完全一致) */
export function canonicalCardPayload(p: CardPayload): string {
  return canonicalize({
    protocol: p.protocol,
    id: p.id,
    title: p.title,
    summary: p.summary,
    media: p.media ?? [],
    scope: p.scope,
    provider: p.provider,
    issuedAt: p.issuedAt,
  });
}

/** 投递世界卡片到信箱 (验签通过才入库) */
export async function deliverWorldCard(
  payload: CardPayload,
  signatureB64: string,
): Promise<DeliverCardResult> {
  if (payload.protocol !== CARD_PROTOCOL) {
    return { ok: false, error: `协议不匹配: ${payload.protocol}` };
  }
  const title = String(payload.title || '').trim();
  if (!title) return { ok: false, error: '缺 title' };
  const did = String(payload.provider?.did || '').trim();
  if (!did) return { ok: false, error: '缺 provider.did' };
  const scope: CardScope = payload.scope === 'public' ? 'public' : 'private';

  // 1. 验签 (能解析公钥才可能 verified)
  const pub = await resolveDidPublicKey(did);
  let verification: WorldCard['verification'];
  if (!pub) {
    verification = 'unverified'; // 公钥解析不了 → 不入库 (不可信来源不污染世界流)
    return { ok: false, error: '无法解析 provider DID 公钥 (拒绝不可信来源)' };
  }
  const okSig = await ed25519Verify(pub, canonicalCardPayload(payload), signatureB64);
  if (!okSig) {
    verification = 'signature-invalid';
    return { ok: false, error: '签名无效 (拒绝伪造投递)' };
  }
  verification = 'verified';

  // 2. 入库 (一卡片一文件)
  const id = `card_${safeId(crypto.createHash('sha256').update(canonicalCardPayload(payload)).digest('hex').slice(0, 16))}`;
  const card: WorldCard = {
    protocol: payload.protocol,
    id,
    title,
    summary: String(payload.summary || '').trim(),
    media: Array.isArray(payload.media)
      ? payload.media.filter((m): m is CardMedia => Boolean(m && m.type && m.url))
      : [],
    scope,
    provider: { did, name: payload.provider?.name },
    issuedAt: payload.issuedAt,
    verification,
    receivedAt: Date.now(),
  };
  try {
    await fs.mkdir(cardsDir(), { recursive: true });
    await fs.writeFile(path.join(cardsDir(), `${id}.json`), JSON.stringify(card, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `入库失败: ${err instanceof Error ? err.message : err}` };
  }
  return { ok: true, card };
}

/** 列出世界卡片 (verified 优先, 最近在前) */
export async function listWorldCards(): Promise<WorldCard[]> {
  try {
    const files = await fs.readdir(cardsDir());
    const out: WorldCard[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(cardsDir(), f), 'utf-8');
        const p = JSON.parse(raw) as WorldCard;
        if (p && p.id) out.push(p);
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  } catch { return []; }
}