/**
 * opportunity-inbox.ts — 机会信箱 (2026-10-05, leo: 别人主动投来的机会)
 *
 * 设计: 外部 agent 用 DIAP Ed25519 身份签名投递机会声明到本机信箱,
 *   验签通过才入库 (~/.bolloon/world/inbox/<id>.json) 并进入世界流。
 *   来源可验: 每条机会带 provider DID + 验签状态, 不再是「本机自产」的虚拟感。
 *
 * 协议: bolloon-opportunity-inbox/1
 *   POST payload = { title, summary, refs[], provider: {did}, issuedAt }
 *   signature  = ed25519Sign(privateKey, canonicalize(payload))
 *   验证 = ed25519Verify(providerPublicKey, canonicalize(payload), signature)
 *
 * 未来: 群复制 (OrbitDB 公共群 announce) 是信箱的另一条投递通道, 需要第二节点 (诚实边界)。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'node:crypto';
import { worldDir } from './intent-store.js';
import { canonicalize, ed25519Verify } from './x402/paid-info-protocol.js';

export const INBOX_PROTOCOL = 'bolloon-opportunity-inbox/1';

/** 信箱里的机会声明 (投递方签名的载荷) */
/** 多模态卡片内容 (2026-10-19, leo: 卡片内容格式不限 — 文本文档/音频/图片/视频) */
export interface CardMedia {
  kind: 'text' | 'document' | 'audio' | 'image' | 'video';
  /** 文件/标题名 (可选) */
  name?: string;
  /** 资源地址 (document/audio/image/video 用; 可为 URL 或内容寻址 CID) */
  url?: string;
  /** kind=text 时正文; 也用作 summary 之外的补充内容 */
  text?: string;
}

export interface InboxOpportunity {
  protocol: string;
  id: string;
  title: string;
  summary: string;
  refs: string[];
  media?: CardMedia[];
  provider: { did: string; name?: string };
  issuedAt: string;
  /** 验签结果: verified | signature-invalid | unverified */
  verification: 'verified' | 'signature-invalid' | 'unverified';
  receivedAt: number;
}

export interface InboxPayload {
  protocol: string;
  title: string;
  summary: string;
  refs: string[];
  media?: CardMedia[];
  provider: { did: string; name?: string };
  issuedAt: string;
}

export interface DeliverResult {
  ok: boolean;
  opportunity?: InboxOpportunity;
  error?: string;
}

const inboxDir = (): string => path.join(worldDir(), 'inbox');

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

/** 把投递载荷按签名标准序列化 (必须与签名时完全一致) */
export function canonicalPayload(p: InboxPayload): string {
  return canonicalize({
    protocol: p.protocol,
    title: p.title,
    summary: p.summary,
    refs: p.refs,
    media: p.media,
    provider: p.provider,
    issuedAt: p.issuedAt,
  });
}

/** 投递方 DID 的 Ed25519 公钥解析 (did:key 格式 → 32 字节 hex) */
export async function resolveDidPublicKey(did: string): Promise<string | null> {
  try {
    // did:key:z6Mk... — multibase base58btc 编码: [multicodec 0xed01(2B) + 32B 公钥] = 34 字节
    const m = String(did || '').match(/^did:key:z([1-9A-HJ-NP-Za-km-z]+)$/);
    if (!m) return null;
    const decoded = Buffer.from(importB58(m[1]));
    if (decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01) {
      return decoded.subarray(2).toString('hex'); // 剥 multicodec, 取 32 字节公钥
    }
    if (decoded.length === 32) return decoded.toString('hex'); // 裸 32 字节兜底
    return null;
  } catch { return null; }
}

/** base58btc 解码 (multibase 'z' 前缀 = base58btc) — 只依赖 Node crypto 的 b58 简易实现 */
function importB58(s: string): Uint8Array {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base = BigInt(58);
  let num = BigInt(0);
  for (const ch of s) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('bad base58 char');
    num = num * base + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) { bytes.unshift(Number(num & 0xffn)); num >>= 8n; }
  // 前导 '1' → 前导 0x00
  let leading = 0;
  for (const ch of s) { if (ch === '1') leading++; else break; }
  return Uint8Array.from([...new Array(leading).fill(0), ...bytes]);
}

/** 投递机会到信箱 (验签通过才入库) */
export async function deliverOpportunity(payload: InboxPayload, signatureB64: string): Promise<DeliverResult> {
  if (payload.protocol !== INBOX_PROTOCOL) return { ok: false, error: `协议不匹配: ${payload.protocol}` };
  const title = String(payload.title || '').trim();
  if (!title) return { ok: false, error: '缺 title' };
  const did = String(payload.provider?.did || '').trim();
  if (!did) return { ok: false, error: '缺 provider.did' };

  // 1. 验签 (能解析公钥才可能 verified)
  const pub = await resolveDidPublicKey(did);
  let verification: InboxOpportunity['verification'];
  if (!pub) {
    verification = 'unverified'; // 公钥解析不了 → 不入库 (不可信来源不污染世界流)
    return { ok: false, error: '无法解析 provider DID 公钥 (拒绝不可信来源)' };
  }
  const okSig = await ed25519Verify(pub, canonicalPayload(payload), signatureB64);
  if (!okSig) {
    verification = 'signature-invalid';
    return { ok: false, error: '签名无效 (拒绝伪造投递)' };
  }
  verification = 'verified';

  // 2. media 形状校验 (可选; 带上就必须是合法卡片媒体数组)
  const media = normalizeMedia(payload.media);

  // 3. 入库 (一机会一文件)
  const id = `inbox_${safeId(crypto.createHash('sha256').update(canonicalPayload(payload)).digest('hex').slice(0, 16))}`;
  const opp: InboxOpportunity = {
    protocol: payload.protocol,
    id,
    title,
    summary: String(payload.summary || '').trim(),
    refs: Array.isArray(payload.refs) ? payload.refs.map(String).filter(Boolean) : [],
    media: media.length ? media : undefined,
    provider: { did, name: payload.provider?.name },
    issuedAt: payload.issuedAt,
    verification,
    receivedAt: Date.now(),
  };
  try {
    await fs.mkdir(inboxDir(), { recursive: true });
    await fs.writeFile(path.join(inboxDir(), `${id}.json`), JSON.stringify(opp, null, 2) + '\n', { mode: 0o600 });
  } catch (err) {
    return { ok: false, error: `入库失败: ${err instanceof Error ? err.message : err}` };
  }
  return { ok: true, opportunity: opp };
}

/** 归一化媒体数组: 只保留合法项 (kind 必填且属于五类; text 用 text, 其余可带 url/name) */
export function normalizeMedia(media: unknown): CardMedia[] {
  if (!Array.isArray(media)) return [];
  const kinds = new Set(['text', 'document', 'audio', 'image', 'video']);
  const out: CardMedia[] = [];
  for (const m of media) {
    if (!m || typeof m !== 'object') continue;
    const kind = String((m as any).kind || '').trim();
    if (!kinds.has(kind)) continue;
    const item: CardMedia = { kind: kind as CardMedia['kind'] };
    if (typeof (m as any).name === 'string' && String((m as any).name).trim()) item.name = String((m as any).name).trim();
    if (typeof (m as any).url === 'string' && String((m as any).url).trim()) item.url = String((m as any).url).trim();
    if (typeof (m as any).text === 'string' && String((m as any).text).trim()) item.text = String((m as any).text).trim();
    if (kind === 'text' && !item.text) continue;        // text 卡必须带正文
    if (kind !== 'text' && !item.url) continue;          // 其它卡必须带资源地址
    out.push(item);
  }
  return out.slice(0, 12); // 一卡至多 12 个媒体 (防塞爆)
}

/** 列出信箱机会 (verified 优先, 最近在前) */
export async function listInboxOpportunities(): Promise<InboxOpportunity[]> {
  try {
    const files = await fs.readdir(inboxDir());
    const out: InboxOpportunity[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(inboxDir(), f), 'utf-8');
        const p = JSON.parse(raw) as InboxOpportunity;
        if (p && p.id) out.push(p);
      } catch { /* 坏文件跳过 */ }
    }
    return out.sort((a, b) => b.receivedAt - a.receivedAt);
  } catch { return []; }
}
