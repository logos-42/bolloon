// ─── 数字资源资产化 (Stage 1 轻版) ──────────────────────────────────────────
//   "注册资源 → 运营(发现) → 交易(x402) → 清算(信誉)" 经济循环的资源层.
//   A 轻: content 内容寻址(CID) + 元数据存本地/网络索引, DID 签名身份;
//   预留 B: chain='evm' + tokenUriTemplate → 元数据可升级为 tokenURI (真资产合约).
//   统一 schema 四类: data | art_product | product_image | tx_link.
//   复用现有件: cid_database(内容寻址) / agent-registry(发现/定价) / x402(交易) / reputation(清算).

export type ResourceType = 'data' | 'art_product' | 'product_image' | 'tx_link';

export interface ResourcePrice {
  amount: string;
  currency: 'USDC' | 'token';   // 两者都支持: USDC 默认 + 可选 token
  token?: string;               // 当 currency='token' 时的代币名/合约
  per?: string;                 // 计价单位, 如 'access' / 'license'
}

export interface DigitalResource {
  resourceId: string;
  ownerDid: string;             // 所有权 = DID (自管身份)
  type: ResourceType;
  title: string;
  contentCid: string;           // 内容寻址 (cid_save)
  price?: ResourcePrice;
  license?: string;             // 授权条款 (如 'personal' / 'commercial')
  txLink?: string;              // 交易链接 (电商/市场)
  meta?: Record<string, unknown>;
  // 预留 B: 元数据可升级为 tokenURI
  chain?: 'none' | 'evm';       // none=内容寻址(A) / evm=真资产合约(B)
  tokenUriTemplate?: string;    // chain='evm' 时: `${base}/{resourceId}`
  createdAt?: string;
  updatedAt?: string;
}

export interface RegisterResourceOpts {
  ownerDid: string;
  type: ResourceType;
  title: string;
  content: string;              // 内容 (text/JSON; 图片可 base64 dataURL 或 ipfs cid)
  price?: ResourcePrice;
  license?: string;
  txLink?: string;
  meta?: Record<string, unknown>;
  chain?: 'none' | 'evm';
  tokenUriTemplate?: string;
}

export interface ResourceCid {
  save(content: string): Promise<string>;        // 内容寻址 → CID
  load(cid: string): Promise<string | null>;     // CID → 内容
}

export interface ResourceStore {
  get(): DigitalResource[];
  set(list: DigitalResource[]): void;
}

export interface ResourceServiceDeps {
  cid?: ResourceCid;
  store?: ResourceStore;        // 默认内存 (可注入文件/localStorage)
  now?: () => string;
  rid?: () => string;
  /** 可选: 注册后同步到网络 registry (Stage 2 运营用) */
  onRegister?: (r: DigitalResource) => void;
}

function memStore(): ResourceStore {
  let m: DigitalResource[] = [];
  return { get: () => m, set: (x) => { m = x; } };
}

export interface ResourceResult { ok: boolean; resource?: DigitalResource; error?: string }

/** 注册资源: 内容寻址存内容 → 建 DigitalResource → 入索引 */
export async function registerResource(opts: RegisterResourceOpts, deps: ResourceServiceDeps = {}): Promise<ResourceResult> {
  if (!opts.ownerDid || !opts.type || !opts.title || !opts.content) {
    return { ok: false, error: 'ownerDid/type/title/content 必填' };
  }
  const VALID: ResourceType[] = ['data', 'art_product', 'product_image', 'tx_link'];
  if (!VALID.includes(opts.type)) return { ok: false, error: `type 必须是 ${VALID.join('|')}` };
  try {
    const cid = deps.cid;
    if (!cid) return { ok: false, error: '缺 cid 依赖 (内容寻址不可用)' };
    const contentCid = await cid.save(opts.content);
    const now = deps.now ? deps.now() : new Date().toISOString();
    const rid = deps.rid ? deps.rid() : `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const resource: DigitalResource = {
      resourceId: rid,
      ownerDid: opts.ownerDid,
      type: opts.type,
      title: opts.title,
      contentCid,
      price: opts.price,
      license: opts.license,
      txLink: opts.txLink,
      meta: opts.meta,
      chain: opts.chain || 'none',
      tokenUriTemplate: opts.chain === 'evm' ? opts.tokenUriTemplate : undefined,
      createdAt: now,
      updatedAt: now,
    };
    const store = deps.store || memStore();
    store.set([...store.get(), resource]);
    deps.onRegister?.(resource);
    return { ok: true, resource };
  } catch (e: any) {
    return { ok: false, error: `注册失败: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** 运营/发现: 按 type/owner 过滤资源 (推理: 谁注册了什么资源) */
export function listResources(filter: { type?: ResourceType; owner?: string } = {}, deps: ResourceServiceDeps = {}): DigitalResource[] {
  const all = (deps.store || memStore()).get();
  return all.filter((r) =>
    (!filter.type || r.type === filter.type) &&
    (!filter.owner || r.ownerDid === filter.owner)
  );
}

export async function getResource(resourceId: string, deps: ResourceServiceDeps = {}): Promise<DigitalResource | null> {
  return (deps.store || memStore()).get().find((r) => r.resourceId === resourceId) ?? null;
}

/** 访问资源: 按 contentCid 取回内容 (付费档由上层 x402 授权后再调) */
export async function accessResource(resourceId: string, deps: ResourceServiceDeps = {}): Promise<{ ok: boolean; content?: string; error?: string; resource?: DigitalResource }> {
  const r = await getResource(resourceId, deps);
  if (!r) return { ok: false, error: `资源不存在: ${resourceId}` };
  if (!deps.cid) return { ok: false, error: '缺 cid 依赖', resource: r };
  const content = await deps.cid.load(r.contentCid);
  if (content === null) return { ok: false, error: '内容拉取失败 (CID 不可达)', resource: r };
  return { ok: true, content, resource: r };
}
