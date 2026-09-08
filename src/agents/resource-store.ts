// ─── 数字资源资产化 (Stage 1-4) ────────────────────────────────────────────
//   经济循环: 注册资源 → 运营(发现/自动分配) → 交易(x402 付费) → 清算(信誉).
//   A 轻版: content 内容寻址(CID) + 元数据(可同步网络 registry) + DID 签名身份;
//   预留 B: chain='evm' + tokenUriTemplate → 元数据可升级为 tokenURI.
//   四类统一 schema: data | art_product | product_image | tx_link.
//   复用现有件: cid_database(内容寻址) / agent-registry(跨机发现/定价/信誉) / x402(交易) / reputation(清算).

export type ResourceType = 'data' | 'art_product' | 'product_image' | 'tx_link';

export interface ResourcePrice {
  amount: string;
  currency: 'USDC' | 'token';   // USDC 默认 + 可选 token
  token?: string;
  per?: string;                 // 'access' / 'license'
}

export interface DigitalResource {
  resourceId: string;
  ownerDid: string;
  type: ResourceType;
  title: string;
  contentCid: string;
  wallet?: string;              // 收款钱包 (Stage 3 交易用)
  price?: ResourcePrice;
  license?: string;
  txLink?: string;
  meta?: Record<string, unknown>;
  chain?: 'none' | 'evm';
  tokenUriTemplate?: string;    // chain='evm' 时 tokenURI 模板
  createdAt?: string;
  updatedAt?: string;
}

export interface RegisterResourceOpts {
  ownerDid: string;
  type: ResourceType;
  title: string;
  content: string;
  wallet?: string;
  price?: ResourcePrice;
  license?: string;
  txLink?: string;
  meta?: Record<string, unknown>;
  chain?: 'none' | 'evm';
  tokenUriTemplate?: string;
}

export interface ResourceCid {
  save(content: string): Promise<string>;
  load(cid: string): Promise<string | null>;
}
export interface ResourceStore {
  get(): DigitalResource[];
  set(list: DigitalResource[]): void;
}

/** Stage 3 支付执行器 (注入真实 x402; 单测用 fake) */
export interface ResourcePaySpec { recipient: string; amount: string; currency: string; token?: string; memo?: string; }
export interface ResourcePayResult { success: boolean; txHash?: string; error?: string; }

/** Stage 2 网络 registry 依赖 (agent-registry) */
export interface ResourceRegistry {
  register(s: any): Promise<{ ok: boolean; error?: string }>;
  discover(q?: string): Promise<any[]>;
}

export interface ResourceServiceDeps {
  cid?: ResourceCid;
  store?: ResourceStore;
  now?: () => string;
  rid?: () => string;
  onRegister?: (r: DigitalResource) => void;
  // Stage 2 运营
  registry?: ResourceRegistry;
  // Stage 3 交易
  pay?: (spec: ResourcePaySpec) => Promise<ResourcePayResult>;
  // Stage 4 清算
  onSettle?: (outcome: 'success' | 'failed', resource: DigitalResource) => void;
  repQuery?: (owner: string, type?: string) => Promise<{ score: number; tasks: number; success: number; failed: number }>;
}

function memStore(): ResourceStore {
  let m: DigitalResource[] = [];
  return { get: () => m, set: (x) => { m = x; } };
}

export interface ResourceResult { ok: boolean; resource?: DigitalResource; error?: string }

/** Stage2: 把资源元数据同步成网络 registry 可发现条目 (AgentService 包装) */
export function serializeForRegistry(r: DigitalResource): any {
  return {
    agentId: r.ownerDid,
    name: r.title,
    wallet: r.wallet || '0x0',
    service: {
      name: `resource:${r.type}`,
      description: `数字资源 ${r.type} — ${r.title} (CID ${r.contentCid})`,
      price: r.price ? { amount: r.price.amount, currency: r.price.currency, per: r.price.per || 'access' } : { amount: '0', currency: 'USDC', per: 'access' },
    },
    capabilities: [`resource:${r.type}`, r.resourceId],
  };
}

/** Stage2: 跨机可见 — 注册资源时同步到网络 registry (尽力而为) */
export async function syncResourceToRegistry(r: DigitalResource, deps: ResourceServiceDeps): Promise<void> {
  if (!deps.registry) return;
  try { await deps.registry.register(serializeForRegistry(r)); } catch { /* 同步失败不致命 */ }
}

export async function registerResource(opts: RegisterResourceOpts, deps: ResourceServiceDeps = {}): Promise<ResourceResult> {
  if (!opts.ownerDid || !opts.type || !opts.title || !opts.content) return { ok: false, error: 'ownerDid/type/title/content 必填' };
  const VALID: ResourceType[] = ['data', 'art_product', 'product_image', 'tx_link'];
  if (!VALID.includes(opts.type)) return { ok: false, error: `type 必须是 ${VALID.join('|')}` };
  try {
    const cid = deps.cid;
    if (!cid) return { ok: false, error: '缺 cid 依赖 (内容寻址不可用)' };
    const contentCid = await cid.save(opts.content);
    const now = deps.now ? deps.now() : new Date().toISOString();
    const rid = deps.rid ? deps.rid() : `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const resource: DigitalResource = {
      resourceId: rid, ownerDid: opts.ownerDid, type: opts.type, title: opts.title, contentCid,
      wallet: opts.wallet, price: opts.price, license: opts.license, txLink: opts.txLink, meta: opts.meta,
      chain: opts.chain || 'none', tokenUriTemplate: opts.chain === 'evm' ? opts.tokenUriTemplate : undefined,
      createdAt: now, updatedAt: now,
    };
    (deps.store || memStore()).set([...(deps.store || memStore()).get(), resource]);
    deps.onRegister?.(resource);
    await syncResourceToRegistry(resource, deps); // Stage2 跨机可见
    return { ok: true, resource };
  } catch (e: any) {
    return { ok: false, error: `注册失败: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** Stage2 运营: 按 type/owner 过滤 (本机索引 + 网络 registry 合并) */
export async function listResources(filter: { type?: ResourceType; owner?: string } = {}, deps: ResourceServiceDeps = {}): Promise<DigitalResource[]> {
  const local = (deps.store || memStore()).get()
    .filter((r) => (!filter.type || r.type === filter.type) && (!filter.owner || r.ownerDid === filter.owner));
  // 合并网络 registry (跨机资源), 按 resourceId 去重
  if (deps.registry) {
    try {
      const remote = await deps.registry.discover(filter.type ? `resource:${filter.type}` : 'resource:');
      const known = new Set(local.map((r) => r.resourceId));
      for (const r of remote) {
        const rid = r?.capabilities?.find((c: string) => String(c).startsWith('res_'));
        if (!rid || known.has(rid)) continue;
        const price = r?.service?.price;
        local.push({
          resourceId: rid, ownerDid: r?.agentId || 'unknown', type: (String(r?.service?.name).replace('resource:', '') as ResourceType) || 'data',
          title: r?.name || rid, contentCid: '', wallet: r?.wallet, price: price ? { amount: String(price.amount), currency: price.currency || 'USDC', per: price.per } : undefined,
          chain: 'none', meta: { remote: true },
        });
      }
    } catch { /* 网络合并失败忽略 */ }
  }
  return local;
}

export async function getResource(resourceId: string, deps: ResourceServiceDeps = {}): Promise<DigitalResource | null> {
  return (deps.store || memStore()).get().find((r) => r.resourceId === resourceId) ?? null;
}

/** 免费/预览访问: 直接按 contentCid 取回内容 (付费资源应走 purchaseResource) */
export async function accessResource(resourceId: string, deps: ResourceServiceDeps = {}): Promise<{ ok: boolean; content?: string; error?: string; resource?: DigitalResource }> {
  const r = await getResource(resourceId, deps);
  if (!r) return { ok: false, error: `资源不存在: ${resourceId}` };
  if (!deps.cid) return { ok: false, error: '缺 cid 依赖', resource: r };
  const content = await deps.cid.load(r.contentCid);
  if (content === null) return { ok: false, error: '内容拉取失败 (CID 不可达)', resource: r };
  return { ok: true, content, resource: r };
}

/** Stage2 自动分配匹配器: 关键词打分 + 信誉加权, 返回排序资源 */
export async function matchResources(query: string, deps: ResourceServiceDeps = {}): Promise<Array<{ resource: DigitalResource; score: number }>> {
  const all = await listResources({}, deps);
  const q = String(query || '').trim().toLowerCase();
  const scored: Array<{ resource: DigitalResource; score: number }> = [];
  for (const r of all) {
    let s = 0;
    if (q) {
      if (r.title?.toLowerCase().includes(q)) s += 3;
      if (r.type.toLowerCase().includes(q)) s += 2;
      if (r.license?.toLowerCase().includes(q)) s += 1;
      if (String(r.ownerDid).toLowerCase().includes(q)) s += 1;
    } else s = 1;
    if (deps.repQuery) {
      try { const rep = await deps.repQuery(r.ownerDid, r.type); s += rep.score * 5; } catch { /* 无信誉 */ }
    }
    scored.push({ resource: r, score: s });
  }
  return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
}

/** Stage3 交易 + Stage4 清算: 付费档走注入 pay(x402), 免费直接 access; 结果 onSettle(reputation) */
export async function purchaseResource(resourceId: string, deps: ResourceServiceDeps = {}): Promise<{ ok: boolean; content?: string; txHash?: string; needPay?: boolean; error?: string; resource?: DigitalResource }> {
  const r = await getResource(resourceId, deps);
  if (!r) return { ok: false, error: `资源不存在: ${resourceId}` };
  const amount = r.price ? Number(r.price.amount) : 0;
  if (amount > 0) {
    if (!deps.pay) return { ok: false, needPay: true, error: '付费资源需要注入 pay (x402)', resource: r };
    if (!r.wallet) return { ok: false, needPay: true, error: '资源缺收款钱包 (wallet)', resource: r };
    const p = await deps.pay({ recipient: r.wallet, amount: String(amount), currency: r.price!.currency, token: r.price!.token, memo: `purchase ${r.resourceId}` });
    if (!p.success) {
      deps.onSettle?.('failed', r);
      return { ok: false, needPay: true, error: p.error || '支付失败', resource: r };
    }
    deps.onSettle?.('success', r);
    // 付费后解锁访问 (内容寻址)
    const content = deps.cid ? await deps.cid.load(r.contentCid) : null;
    return { ok: true, content: content ?? undefined, txHash: p.txHash, resource: r };
  }
  // 免费资源直接访问
  const content = deps.cid ? await deps.cid.load(r.contentCid) : null;
  return { ok: true, content: content ?? undefined, resource: r };
}

/** Stage4 清算: 查资源提供者信誉 */
export async function resourceReputation(ownerDid: string, deps: ResourceServiceDeps = {}): Promise<{ ok: boolean; reputation?: { score: number; tasks: number; success: number; failed: number }; error?: string }> {
  if (!deps.repQuery) return { ok: false, error: '缺 repQuery 依赖' };
  try {
    const rep = await deps.repQuery(ownerDid);
    return { ok: true, reputation: rep };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}
