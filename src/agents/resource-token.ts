// ─── 数字资源资产化 Stage 1-B: EVM 资产合约 (ERC-721) 铸造/流转/查询 ─────────
//   合约: contracts/ResourceERC721.sol (mint(to,id,tokenUri), safeTransferFrom).
//   内容寻址 CID 作 tokenURI (不可变, 随 token 流转); 铸造/转移/查询全部走注入的
//   EVM executor (默认接 ethers/viem 或节点; 未配置明确提示), 单测用 fake.
//   复用: cid_database(内容寻址) / agent-registry(注册) / gateway(跨机可见) — Stage1 已有.

export interface EvmExecutor {
  /** 铸造 ERC-721: to=接收地址, tokenUri=CID 指针; 返回 tokenId */
  mint(to: string, tokenUri: string, memo?: string): Promise<{ tokenId: string; txHash?: string }>;
  /** 转移所有权 (safeTransferFrom) */
  transfer(tokenId: string, to: string): Promise<{ txHash?: string; error?: string }>;
  /** 查询 owner */
  ownerOf(tokenId: string): Promise<string | null>;
  /** 查询 tokenURI */
  tokenURI(tokenId: string): Promise<string | null>;
}

export interface EvmConfig {
  rpcUrl: string;
  contractAddress: string;
  chainId: number;
}

export interface TokenRecord {
  tokenId: string;
  resourceId: string;
  ownerDid: string;
  contract: string;
  mintedAt: string;
}

export interface TokenServiceDeps {
  evm?: EvmExecutor;
  store?: { get(): TokenRecord[]; set(l: TokenRecord[]): void };
  now?: () => string;
}

export interface TokenResult { ok: boolean; tokenId?: string; error?: string; needConfig?: boolean; record?: TokenRecord }

function memStore(): { get(): TokenRecord[]; set(l: TokenRecord[]): void } {
  let m: TokenRecord[] = [];
  return { get: () => m, set: (x) => { m = x; } };
}

/** 从 ~/.bolloon/evm-config.json 或 env 读 EVM 配置 (合约地址/RPC/chainId). */
export async function loadEvmConfig(src?: string): Promise<EvmConfig | null> {
  try {
    if (src) return JSON.parse(src) as EvmConfig;
    const home = (globalThis as any).process?.env?.HOME || '';
    const { readFile } = await import('fs/promises');
    const raw = await readFile(`${home}/.bolloon/evm-config.json`, 'utf-8').catch(() => null);
    if (raw) return JSON.parse(raw) as EvmConfig;
    return null;
  } catch { return null; }
}

/** 铸造: 内容 CID 作 tokenURI 铸 ERC-721, 记 token 账本 */
export async function mintResourceToken(
  resource: { resourceId: string; ownerDid: string; contentCid: string; wallet?: string; title?: string },
  deps: TokenServiceDeps = {},
): Promise<TokenResult> {
  if (!deps.evm) return { ok: false, needConfig: true, error: '需配置 EVM executor (ethers/viem 或注入) 才能铸造' };
  if (!resource.wallet) return { ok: false, needConfig: true, error: '资源缺收款钱包地址 (EVM 接收地址)' };
  if (!resource.contentCid) return { ok: false, error: '资源缺 contentCid (内容寻址)' };
  try {
    const tokenUri = `ipfs://${resource.contentCid}`;  // CID 作 tokenURI (内容寻址, 不可变)
    const r = await deps.evm.mint(resource.wallet, tokenUri, `mint ${resource.resourceId}`);
    const now = deps.now ? deps.now() : new Date().toISOString();
    const record: TokenRecord = { tokenId: r.tokenId, resourceId: resource.resourceId, ownerDid: resource.ownerDid, contract: (deps as any).config?.contractAddress || '', mintedAt: now };
    const st = deps.store || memStore();
    st.set([...st.get(), record]);
    return { ok: true, tokenId: r.tokenId, record };
  } catch (e: any) {
    return { ok: false, error: `铸造失败: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** 流转: safeTransferFrom 转移所有权 */
export async function transferResourceToken(tokenId: string, to: string, deps: TokenServiceDeps = {}): Promise<TokenResult> {
  if (!deps.evm) return { ok: false, needConfig: true, error: '需配置 EVM executor 才能流转' };
  try {
    const r = await deps.evm.transfer(tokenId, to);
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, tokenId };
  } catch (e: any) {
    return { ok: false, error: `流转失败: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** 查询: owner + tokenURI */
export async function queryResourceToken(tokenId: string, deps: TokenServiceDeps = {}): Promise<{ ok: boolean; owner?: string; tokenUri?: string; error?: string }> {
  if (!deps.evm) return { ok: false, error: '需配置 EVM executor 才能查询' };
  try {
    const owner = await deps.evm.ownerOf(tokenId);
    const uri = await deps.evm.tokenURI(tokenId);
    return { ok: true, owner: owner ?? undefined, tokenUri: uri ?? undefined };
  } catch (e: any) {
    return { ok: false, error: `查询失败: ${String(e?.message || e).slice(0, 140)}` };
  }
}

/** 列出本机已铸 token */
export function listResourceTokens(deps: TokenServiceDeps = {}): TokenRecord[] {
  return (deps.store || memStore()).get();
}
