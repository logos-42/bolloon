/**
 * paid-info-protocol.ts — 微支付信息服务的协议规范 (bolloon-x402-info/1)
 *
 * 目标: 让智能体把"特定信息"(数据 / 技能 / 商品信息 / 艺术作品 / 其它) 标价提供,
 *   另一个智能体走 x402 微支付买到, **并且买卖双方都能验证这条信息是不是真的**。
 *
 * 三层结构:
 *   ① item    —— 公开元数据 (标题/类别/价格/收款地址/内容哈希/来源声明) — 免费可见, 可被索引转发
 *   ② content —— 内容本体, 只在付款通过后随信封正文返回
 *   ③ proof   —— 提供方用 DIAP Ed25519 身份对 (itemId + 内容哈希 + 来源 + 支付凭据哈希) 签名
 *   ④ payment —— x402 支付凭据 (facilitator 结算结果原文 + 其哈希), 通过回执哈希被签名绑定
 *
 * 为什么这样签名: 支付凭据被纳入签名载荷 → 拿 A 内容的回执冒充 B 内容会直接破签名;
 *   内容哈希被纳入签名载荷 → 改一个字就验不过。
 *
 * 验真报告 (VerifyReport) 明确区分四档, 不把"能解出内容"说成"信息可信":
 *   verified      = 签名 + 内容哈希 + 支付绑定 + DID 公钥绑定 全部通过 (链上支付)
 *   self-attested = 签名/哈希/支付绑定通过, 但 DID 未能解析或支付是本地开发凭据
 *   content-only  = 只有内容哈希对得上 (没签名或签名缺公钥) — 只保证没被传输篡改
 *   unverified    = 内容哈希都对不上
 */

import * as crypto from 'node:crypto';

export const INFO_PROTOCOL = 'bolloon-x402-info/1';

/** 信息类别 (用户列举的场景) */
export type InfoCategory = 'data' | 'skill' | 'goods' | 'art' | 'other';

/** 来源声明 — "信息是真的" 的第一手依据 */
export interface InfoSource {
  /** self=提供方自述 measured=自己测量/计算 derived=由公开数据推导 quoted=引用他人 */
  kind: 'self' | 'measured' | 'derived' | 'quoted';
  /** 外部可核验引用: 网址 / CID / 论文 / 数据集 / 商品页 … */
  refs: string[];
  note?: string;
}

export interface InfoPrice {
  /** 人类可读金额, 如 '0.002' */
  amount: string;
  currency: 'USDC' | 'ETH';
  /** base | base-sepolia | sepolia | mainnet */
  network: string;
  /** 收款地址 (0x...) */
  payTo: string;
}

/** 公开元数据 (付款前就能看到, 用于发现与比价) */
export interface PaidInfoItem {
  protocol: string;
  id: string;
  title: string;
  category: InfoCategory;
  description?: string;
  price: InfoPrice;
  provider: { did: string; name?: string; agentId?: string; endpoint?: string };
  /** 'sha256:<hex>' — 内容本体摘要 */
  contentHash: string;
  /** 若内容已上 IPFS, 这里给 CID (可独立核验) */
  contentCid?: string;
  source: InfoSource;
  createdAt: string;
  updatedAt: string;
}

export interface InfoPayment {
  /**
   * facilitator = 第三方/自建 relayer 链上结算 (钱经中间人发交易)
   * direct      = **买方直付** (买方自己发 USDC 到 payTo, 卖方只读链核验; 无托管/无第三方)
   * local-dev   = 本机联调凭据, 明确标注非链上
   */
  mode: 'facilitator' | 'direct' | 'local-dev';
  /** 结算回执原文 (X-PAYMENT-RESPONSE) */
  receipt: string;
  receiptHash: string;
  txHash?: string;
  network: string;
  amount: string;
  currency: string;
  payer?: string;
  settledAt?: string;
}

/** 签名覆盖的载荷 (逐字段列出, 一个都不能少) */
export interface InfoSignedPayload {
  protocol: string;
  itemId: string;
  providerDid: string;
  contentHash: string;
  contentCid?: string;
  source: InfoSource;
  receiptHash: string;
  issuedAt: string;
}

export interface PaidInfoEnvelope {
  protocol: string;
  item: PaidInfoItem;
  content: string;
  proof: {
    alg: 'ed25519';
    did: string;
    publicKeyHex: string;
    signature: string;
    payload: InfoSignedPayload;
  };
  payment: InfoPayment;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** 软检查: 不通过只降信任档/给提示, 不判"信封不可用" (如 DID 未解析, 时效) */
  soft?: boolean;
}

export interface VerifyReport {
  ok: boolean;
  trust: 'verified' | 'self-attested' | 'content-only' | 'unverified';
  checks: VerifyCheck[];
  warnings: string[];
}

/** DID 公钥解析钩子 (给了才能升到 verified) */
export type DidKeyResolver = (did: string) => Promise<{ publicKeyHex: string } | null>;

// ------------------------------------------------------------------ 基础工具

/** 稳定序列化 (键递归排序) — 签名/哈希都在它之上做, 保证两端一致 */
export function canonicalize(value: unknown): string {
  const walk = (v: any): any => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) {
      if (v[k] === undefined) continue;
      out[k] = walk(v[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/** sha256 → hex */
export function sha256Hex(input: string | Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 内容摘要 (协议统一格式) */
export function computeContentHash(content: string): string {
  return `sha256:${sha256Hex(content)}`;
}

/** Ed25519 验签 (原始 32 字节公钥, Node WebCrypto 与浏览器同源实现) */
export async function ed25519Verify(publicKeyHex: string, data: string, signatureB64: string): Promise<boolean> {
  try {
    const pub = Buffer.from(publicKeyHex, 'hex');
    if (pub.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' } as any, true, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' } as any, key, Buffer.from(signatureB64, 'base64'), Buffer.from(data, 'utf-8'));
  } catch {
    return false;
  }
}

/** Ed25519 PKCS#8 包装前缀 (raw 32 字节种子 → DER), WebCrypto 导入私钥必须走 pkcs8 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Ed25519 签名 (私钥 = 32 字节种子)。
 * 注意: WebCrypto 的 raw 导入只认公钥, 私钥必须包成 PKCS#8 DER — 这里手工拼前缀。
 */
export async function ed25519Sign(privateKey: Uint8Array, data: string): Promise<string> {
  const seed = Buffer.from(privateKey);
  if (seed.length !== 32) throw new Error(`Ed25519 私钥长度应为 32 字节, 实际 ${seed.length}`);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' } as any, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' } as any, key, Buffer.from(data, 'utf-8'));
  return Buffer.from(sig).toString('base64');
}

// ------------------------------------------------------------------ 构造信封

export interface BuildEnvelopeInput {
  item: PaidInfoItem;
  content: string;
  /** 提供方 DIAP 身份 (KeyManager: { did, publicKey, privateKey }) */
  keypair: { did: string; publicKey: Uint8Array | string; privateKey: Uint8Array | string };
  payment: Omit<InfoPayment, 'receiptHash'>;
  issuedAt?: string;
}

/** 私有 keypair → 能被 WebCrypto 用的 32 字节私钥 */
function toBytes(v: Uint8Array | string): Uint8Array {
  return typeof v === 'string' ? Uint8Array.from(Buffer.from(v, 'base64')) : v;
}

/**
 * 构造已签名信封 (提供方在支付通过后调用)。
 * 内容哈希若不等于 item.contentHash 直接抛错 — 防止"挂 A 卖 B"。
 */
export async function buildSignedEnvelope(input: BuildEnvelopeInput): Promise<PaidInfoEnvelope> {
  const { item, content, keypair, payment } = input;
  const contentHash = computeContentHash(content);
  if (item.contentHash && item.contentHash !== contentHash) {
    throw new Error(`内容与 item.contentHash 不一致 (item=${item.contentHash} actual=${contentHash}) — 拒绝签发`);
  }
  const receiptHash = `sha256:${sha256Hex(payment.receipt)}`;
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  const payload: InfoSignedPayload = {
    protocol: INFO_PROTOCOL,
    itemId: item.id,
    providerDid: item.provider.did,
    contentHash,
    ...(item.contentCid ? { contentCid: item.contentCid } : {}),
    source: item.source,
    receiptHash,
    issuedAt,
  };
  const signature = await ed25519Sign(toBytes(keypair.privateKey), canonicalize(payload));
  return {
    protocol: INFO_PROTOCOL,
    item: { ...item, contentHash },
    content,
    proof: {
      alg: 'ed25519',
      did: keypair.did,
      publicKeyHex: typeof keypair.publicKey === 'string' ? keypair.publicKey : Buffer.from(keypair.publicKey).toString('hex'),
      signature,
      payload,
    },
    payment: { ...payment, receiptHash },
  };
}

// ------------------------------------------------------------------ 验真

export interface VerifyOptions {
  /** DID → 公钥 解析 (来自 IPFS/IPNS 的 DID 文档 / 本地 DID 目录) */
  resolveDid?: DidKeyResolver;
  /** 期望的 itemId (来自引用链接, 防掉包) */
  expectItemId?: string;
  /** 允许的最大签发时长 (ms); 超龄只告警不判死 */
  maxAgeMs?: number;
  now?: () => Date;
}

/**
 * 验证信封。**不抛异常**, 返回分档报告。
 */
export async function verifyEnvelope(env: PaidInfoEnvelope, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const checks: VerifyCheck[] = [];
  const warnings: string[] = [];
  const now = opts.now ?? (() => new Date());

  const push = (name: string, ok: boolean, detail: string, soft = false) => { checks.push({ name, ok, detail, ...(soft ? { soft: true } : {}) }); return ok; };

  // 1) 协议标识
  const protoOk = push('protocol', env?.protocol === INFO_PROTOCOL, `protocol=${env?.protocol ?? '缺失'} (期望 ${INFO_PROTOCOL})`);

  // 2) 内容完整性
  const actualHash = computeContentHash(String(env?.content ?? ''));
  const integrityOk = push('content-integrity', actualHash === env?.item?.contentHash,
    `${actualHash.slice(0, 24)}… vs item ${String(env?.item?.contentHash).slice(0, 24)}…`);

  // 3) 签名 (对 canonical(payload))
  let sigOk = false;
  if (env?.proof?.publicKeyHex && env?.proof?.signature && env?.proof?.payload) {
    sigOk = await ed25519Verify(env.proof.publicKeyHex, canonicalize(env.proof.payload), env.proof.signature);
    push('provider-signature', sigOk, sigOk ? `ed25519 ok (key ${env.proof.publicKeyHex.slice(0, 12)}…)` : '签名不匹配 (内容/来源/支付绑定被改动?)');
  } else {
    push('provider-signature', false, '缺少 proof (无签名 — 只能做到 content-only)');
  }

  // 4) 载荷自洽: 署名载荷必须绑定 itemId / did / 内容哈希 / 来源 / 支付回执
  //    (签名只覆盖 payload, 若不比对 item.* 就会出现"改信封外层、签名照样过"的漏洞)
  const payload = env?.proof?.payload;
  const sourceMatches = !!payload && canonicalize(payload.source) === canonicalize(env?.item?.source);
  const cidMatches = !!payload && (payload.contentCid || undefined) === (env?.item?.contentCid || undefined);
  const payloadOk = push('signed-payload-consistency',
    !!payload && payload.itemId === env?.item?.id && payload.providerDid === env?.item?.provider?.did
      && payload.contentHash === env?.item?.contentHash && payload.receiptHash === env?.payment?.receiptHash
      && sourceMatches && cidMatches,
    payload
      ? [
        `itemId/did/contentHash/receiptHash ${payload.itemId === env?.item?.id ? '一致' : '不一致'}`,
        `来源声明 ${sourceMatches ? '一致' : '被改过 (外层与签名载荷不符)'}`,
        `contentCid ${cidMatches ? '一致' : '不一致'}`,
      ].join(' · ')
      : '缺少 signed payload');

  // 5) 支付绑定: 回执哈希自洽 + 被签名覆盖
  const receiptHash = `sha256:${sha256Hex(String(env?.payment?.receipt ?? ''))}`;
  const paymentBoundOk = push('payment-binding',
    receiptHash === env?.payment?.receiptHash && !!payload && payload.receiptHash === receiptHash,
    receiptHash === env?.payment?.receiptHash ? '回执哈希自洽且被签名覆盖' : '回执哈希与 payment.receiptHash 不一致');
  if (env?.payment?.mode === 'local-dev') warnings.push('支付凭据为本机联调模式 (local-dev), 非链上结算');

  // 6) DID 公钥绑定 (可选, 决定能不能到 verified; 软检查 — 解析不到只降档)
  let didBound = false;
  if (opts.resolveDid && env?.proof?.did && env?.proof?.publicKeyHex) {
    const doc = await opts.resolveDid(env.proof.did).catch(() => null);
    didBound = !!doc && doc.publicKeyHex.toLowerCase() === env.proof.publicKeyHex.toLowerCase();
    push('did-binding', didBound, doc ? (didBound ? 'DID 文档公钥与签名公钥一致' : 'DID 文档公钥不一致') : 'DID 未能解析 (IPFS/IPNS 不可达或未发布)', true);
    if (!doc) warnings.push('DID 未解析 → 无法确认签名公钥属于该 DID');
  } else {
    push('did-binding', false, '未提供 DID 解析器 (跳过)', true);
    warnings.push('未做 DID 解析 → 只能认定为 self-attested');
  }

  // 7) 来源声明 (真实性依据; 硬检查 — 声明了可核验就必须给引用)
  const src = env?.item?.source;
  const srcRefs = Array.isArray(src?.refs) ? src!.refs.filter(Boolean) : [];
  let sourceOk = false;
  if (!src) {
    push('source-provenance', false, '缺少来源声明');
  } else if (src.kind === 'self') {
    sourceOk = push('source-provenance', true, '提供方自述 (self) — 无外部引用');
    warnings.push('来源为提供方自述, 无第三方可核验引用');
  } else {
    sourceOk = push('source-provenance', srcRefs.length > 0, srcRefs.length > 0 ? `${src.kind}, ${srcRefs.length} 条引用` : `${src.kind} 但没有任何引用`);
    if (srcRefs.length === 0) warnings.push('声明为可核验来源却没给引用');
  }

  // 8) 期望 itemId / 时效
  let expectedOk = true;
  if (opts.expectItemId) {
    expectedOk = push('expected-item', env?.item?.id === opts.expectItemId, `itemId=${env?.item?.id} (期望 ${opts.expectItemId})`);
  }
  if (opts.maxAgeMs && payload?.issuedAt) {
    const age = now().getTime() - new Date(payload.issuedAt).getTime();
    const fresh = Number.isFinite(age) && age <= opts.maxAgeMs;
    push('freshness', fresh, `签发于 ${payload.issuedAt} (${Math.round(age / 1000)}s 前)`, true);
    if (!fresh) warnings.push('签发时间超过允许时限');
  }

  const core = protoOk && integrityOk && sigOk && payloadOk && paymentBoundOk;
  // ok = 硬检查全过 (核心 + 来源声明 + 期望 itemId); 软检查 (DID 解析/时效) 只影响信任档
  const ok = core && sourceOk && expectedOk;
  let trust: VerifyReport['trust'];
  if (!integrityOk) {
    trust = 'unverified';
  } else if (!core) {
    trust = 'content-only';
  } else if (didBound && sourceOk && env.payment?.mode === 'facilitator') {
    trust = 'verified';
  } else {
    trust = 'self-attested';
  }
  return { ok, trust, checks, warnings };
}

/** 给人类看的一行摘要 */
export function summarizeVerify(report: VerifyReport): string {
  const label: Record<VerifyReport['trust'], string> = {
    verified: '✅ verified (签名+内容哈希+支付绑定+DID 全部通过)',
    'self-attested': '🟡 self-attested (签名与内容对得上, 但身份/支付未上链核实)',
    'content-only': '🟠 content-only (只保证传输未被篡改)',
    unverified: '❌ unverified (内容哈希都对不上)',
  };
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  return `${label[report.trust]}${failed.length ? ` · 未过: ${failed.join(', ')}` : ''}${report.warnings.length ? ` · 提示: ${report.warnings.join('; ')}` : ''}`;
}
