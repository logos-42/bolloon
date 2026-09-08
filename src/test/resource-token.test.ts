import { describe, it, expect } from 'vitest';
// Stage 1-B: ERC-721 铸造/流转/查询 (注入 fake EVM executor 单测)
import { mintResourceToken, transferResourceToken, queryResourceToken, listResourceTokens } from '../agents/resource-token.js';
import type { TokenRecord, TokenServiceDeps } from '../agents/resource-token.js';

function mkDeps() {
  const ownerMap = new Map<string, string>();
  const uriMap = new Map<string, string>();
  let minted: string[] = [];
  let n = 0;
  const evm: any = {
    mint: async (to: string, uri: string) => { const id = String(++n); ownerMap.set(id, to); uriMap.set(id, uri); minted.push(id); return { tokenId: id, txHash: '0x' + id }; },
    transfer: async (id: string, to: string) => { if (!ownerMap.has(id)) return { error: 'not minted' }; ownerMap.set(id, to); return { txHash: '0x' + id }; },
    ownerOf: async (id: string) => ownerMap.get(id) ?? null,
    tokenURI: async (id: string) => uriMap.get(id) ?? null,
  };
  let records: TokenRecord[] = [];
  const store = { get: () => records, set: (x: TokenRecord[]) => { records = x; } };
  const deps: TokenServiceDeps = { evm, store };
  return { deps, ownerMap, uriMap, minted };
}

const res = { resourceId: 'res_1', ownerDid: 'did:leo', contentCid: 'cid-abc', wallet: '0xRecv', title: '画作' };

describe('resource-token (Stage 1-B ERC-721)', () => {
  it('mint: CID 作 tokenURI, 记 token 账本', async () => {
    const { deps, uriMap } = mkDeps();
    const m = await mintResourceToken(res, deps);
    expect(m.ok).toBe(true);
    expect(m.tokenId).toBe('1');
    expect(uriMap.get('1')).toBe('ipfs://cid-abc');       // 内容寻址 CID 作 tokenURI
    expect(listResourceTokens(deps).length).toBe(1);
  });

  it('mint: 无 EVM executor / 无 wallet → needConfig', async () => {
    const { deps } = mkDeps();
    expect((await mintResourceToken(res, {})).needConfig).toBe(true);
    expect((await mintResourceToken({ ...res, wallet: '' }, deps)).needConfig).toBe(true);
  });

  it('transfer: 成功转移 + 无 executor 报 needConfig', async () => {
    const { deps, ownerMap } = mkDeps();
    await mintResourceToken(res, deps);
    const t = await transferResourceToken('1', '0xNew', deps);
    expect(t.ok).toBe(true);
    expect(ownerMap.get('1')).toBe('0xNew');
    expect((await transferResourceToken('1', '0xNew', {})).needConfig).toBe(true);
  });

  it('query: owner + tokenURI; 未铸 → 查询为空', async () => {
    const { deps } = mkDeps();
    await mintResourceToken(res, deps);
    const q = await queryResourceToken('1', deps);
    expect(q.ok).toBe(true);
    expect(q.owner).toBe('0xRecv');
    expect(q.tokenUri).toBe('ipfs://cid-abc');
    const q2 = await queryResourceToken('999', deps);
    expect(q2.owner).toBeUndefined();
  });
});
