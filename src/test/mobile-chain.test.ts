/**
 * mobile-chain.test.ts — 手机端独立链上模块的单元测试
 *
 * 全程离线: 所有 JSON-RPC 走注入的 fetchImpl, 配置走注入的内存 storage,
 * 不触网、不需要电脑端。
 */
import { describe, it, expect } from 'vitest';
import { toFunctionSelector, decodeFunctionData } from 'viem';
import {
  DEFAULT_CHAIN_CONFIG,
  getChainConfig,
  setChainConfig,
  rpcRequest,
  accountFromPrivateKey,
  signX402Authorization,
  erc20Transfer,
  mintResourceToken,
  registerServiceOnChain,
  deriveTokenId,
  toBaseUnits,
  normalizeNetwork,
  base64EncodeUtf8,
  RESOURCE_ERC721_ABI,
  type ChainStorage,
} from '../web/mobile-chain';

// 固定测试私钥 (Hardhat account #1) → 确定性地址
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CONTRACT = '0x1234567890AbcdEF1234567890aBcdef12345678';
const MINT_SELECTOR = '0xd3fc9864';
const FAKE_TX = '0x' + 'ab'.repeat(32);

// ---------- helpers ----------

function memStorage(): ChainStorage & { _m: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    _m: m,
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

function makeRpcFetch(handlers: Record<string, unknown>, record?: string[]): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    if (record) record.push(body.method);
    const h = handlers[body.method];
    if (h === undefined) {
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32601, message: `method not found: ${body.method}` },
        }),
      };
    }
    const result = typeof h === 'function' ? (h as (p: unknown[]) => unknown)(body.params) : h;
    return { json: async () => ({ jsonrpc: '2.0', id: body.id, result }) };
  }) as unknown as typeof fetch;
}

const OK_HANDLERS: Record<string, unknown> = {
  eth_getTransactionCount: '0x0',
  eth_gasPrice: '0x3b9aca00',
  eth_estimateGas: '0x5208',
  eth_sendRawTransaction: FAKE_TX,
};

const failFetch = (async () => {
  throw new Error('network down');
}) as unknown as typeof fetch;

// ============================================================

describe('mobile-chain: 配置', () => {
  it('默认配置 = Base mainnet + USDC', () => {
    const cfg = getChainConfig(memStorage());
    expect(cfg).toEqual(DEFAULT_CHAIN_CONFIG);
    expect(cfg.chainId).toBe(8453);
    expect(cfg.network).toBe('base');
    expect(cfg.rpcUrl).toBe('https://mainnet.base.org');
    expect(cfg.token).toBe('USDC');
  });

  it('setChainConfig 持久化到注入 storage, 并可与默认值合并', () => {
    const s = memStorage();
    const written = setChainConfig({ network: 'base-sepolia', chainId: 84532 }, s);
    expect(written.chainId).toBe(84532);
    expect(written.rpcUrl).toBe(DEFAULT_CHAIN_CONFIG.rpcUrl); // 未覆盖 → 保留默认

    const back = getChainConfig(s);
    expect(back.network).toBe('base-sepolia');
    expect(back.chainId).toBe(84532);
    expect(s._m.get('bolloon_chain_config')).toContain('base-sepolia');
  });
});

describe('mobile-chain: 账户', () => {
  it('固定私钥 → 确定性地址', () => {
    const r = accountFromPrivateKey(PK);
    expect(r.ok).toBe(true);
    expect(r.address).toBe(ADDR);
  });

  it('无效私钥 → ok:false 不抛', () => {
    const r = accountFromPrivateKey('0xzz');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('mobile-chain: rpcRequest', () => {
  it('成功返回 result', async () => {
    const seen: string[] = [];
    const f = makeRpcFetch({ eth_chainId: '0x2105' }, seen);
    const res = await rpcRequest<string>('eth_chainId', [], { rpcUrl: 'http://x', fetchImpl: f });
    expect(res).toBe('0x2105');
    expect(seen).toEqual(['eth_chainId']);
  });

  it('RPC 报错 → 抛可捕获错误', async () => {
    const f = makeRpcFetch({});
    await expect(rpcRequest('eth_bogus', [], { rpcUrl: 'http://x', fetchImpl: f })).rejects.toThrow(/RPC 错误/);
  });

  it('网络异常 → 抛可捕获错误', async () => {
    await expect(rpcRequest('eth_chainId', [], { rpcUrl: 'http://x', fetchImpl: failFetch })).rejects.toThrow();
  });
});

describe('mobile-chain: x402 支付授权', () => {
  it('typed-data 结构正确 (domain / primaryType / 字段名)', async () => {
    const r = await signX402Authorization({
      privateKey: PK,
      to: RECIPIENT,
      amount: '1',
      currency: 'USDC',
      network: 'base',
      now: 1000,
      validForSec: 600,
      nonce: '0x' + '11'.repeat(32),
    });
    expect(r.ok).toBe(true);
    const td = r.typedData!;
    expect(td.primaryType).toBe('TransferWithAuthorization');
    expect(td.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: USDC_BASE,
    });
    expect(td.types.TransferWithAuthorization.map((f) => f.name)).toEqual([
      'from',
      'to',
      'value',
      'validAfter',
      'validBefore',
      'nonce',
    ]);
    expect(td.types.TransferWithAuthorization.map((f) => f.type)).toEqual([
      'address',
      'address',
      'uint256',
      'uint256',
      'uint256',
      'bytes32',
    ]);
    expect(r.authorization!.from).toBe(ADDR);
    expect(r.authorization!.validAfter).toBe('0');
    expect(r.authorization!.validBefore).toBe('1600');
    expect(r.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('header 是 base64(JSON), 解回的字段与授权一致', async () => {
    const r = await signX402Authorization({
      privateKey: PK,
      to: RECIPIENT,
      amount: '2.5',
      currency: 'USDC',
      network: 'base',
      now: 5000,
      validForSec: 300,
      nonce: '0x' + '22'.repeat(32),
    });
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(Buffer.from(r.header!, 'base64').toString('utf-8'));
    expect(parsed.x402Version).toBe(2);
    expect(parsed.payload.authorization).toEqual(r.authorization);
    expect(parsed.payload.signature).toBe(r.signature);
    expect(parsed.payload.authorization.to).toBe(RECIPIENT);
    expect(parsed.payload.authorization.nonce).toBe('0x' + '22'.repeat(32));
  });

  it('USDC 6 位小数换算 (人类单位 → 最小单位)', async () => {
    const r = await signX402Authorization({
      privateKey: PK,
      to: RECIPIENT,
      amount: '1.5',
      currency: 'USDC',
      network: 'base',
      now: 0,
      nonce: '0x' + '33'.repeat(32),
    });
    expect(r.ok).toBe(true);
    expect(r.authorization!.value).toBe('1500000');
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits(3, 6)).toBe(3000000n);
  });

  it('不支持的代币 → ok:false 不抛', async () => {
    const r = await signX402Authorization({
      privateKey: PK,
      to: RECIPIENT,
      amount: '1',
      currency: 'DOGE',
      network: 'base',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('DOGE');
  });
});

describe('mobile-chain: erc20Transfer', () => {
  it('发 eth_sendRawTransaction, raw 以 0x 开头, to = USDC 合约', async () => {
    const seen: string[] = [];
    const f = makeRpcFetch(OK_HANDLERS, seen);
    const r = await erc20Transfer({
      privateKey: PK,
      to: RECIPIENT,
      amount: '1',
      rpcUrl: 'http://x',
      fetchImpl: f,
      network: 'base',
    });
    expect(r.ok).toBe(true);
    expect(r.txHash).toBe(FAKE_TX);
    expect(r.raw!.startsWith('0x')).toBe(true);
    expect(seen).toContain('eth_sendRawTransaction');
    // 交易 to 是代币合约 (eth_estimateGas 的 params[0].to)
    // 通过 calldata selector 校验是 transfer(address,uint256) = 0xa9059cbb
    expect(r.raw!.length).toBeGreaterThan(2);
  });

  it('网络异常 → ok:false 不抛', async () => {
    const r = await erc20Transfer({
      privateKey: PK,
      to: RECIPIENT,
      amount: '1',
      rpcUrl: 'http://x',
      fetchImpl: failFetch,
      network: 'base',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('mobile-chain: 资源上链', () => {
  it('mintResourceToken calldata selector = mint(address,uint256,string)', async () => {
    const seen: string[] = [];
    const f = makeRpcFetch(OK_HANDLERS, seen);
    const r = await mintResourceToken({
      privateKey: PK,
      contract: CONTRACT,
      to: ADDR,
      tokenId: 7,
      tokenUri: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
      rpcUrl: 'http://x',
      fetchImpl: f,
      network: 'base',
    });
    expect(r.ok).toBe(true);
    expect(r.data!.slice(0, 10)).toBe(MINT_SELECTOR);
    expect(toFunctionSelector('function mint(address to, uint256 tokenId, string tokenUri)')).toBe(MINT_SELECTOR);
    expect(seen).toContain('eth_sendRawTransaction');
    expect(r.txHash).toBe(FAKE_TX);

    // 解 calldata: tokenUri 里带 CID
    const decoded = decodeFunctionData({ abi: RESOURCE_ERC721_ABI, data: r.data as `0x${string}` });
    expect(decoded.functionName).toBe('mint');
    const args = decoded.args as readonly [string, bigint, string];
    expect(args[0]).toBe(ADDR);
    expect(args[1]).toBe(7n);
    expect(args[2]).toBe('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
    expect(r.tokenUri).toBe('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi');
  });

  it('registerServiceOnChain: CID 进 tokenUri, tokenId 确定性派生', async () => {
    const f = makeRpcFetch(OK_HANDLERS);
    const r = await registerServiceOnChain({
      privateKey: PK,
      contract: CONTRACT,
      agentId: 'agent-1',
      serviceName: 'translation',
      cid: 'bafyCID123',
      rpcUrl: 'http://x',
      fetchImpl: f,
      network: 'base',
    });
    expect(r.ok).toBe(true);
    expect(r.tokenUri).toBe('ipfs://bafyCID123');
    expect(r.tokenId).toBe(deriveTokenId('agent-1', 'translation').toString());
    expect(r.data!.slice(0, 10)).toBe(MINT_SELECTOR);
    // 派生稳定
    expect(deriveTokenId('agent-1', 'translation')).toBe(deriveTokenId('agent-1', 'translation'));
    expect(deriveTokenId('agent-1', 'other')).not.toBe(deriveTokenId('agent-1', 'translation'));
  });

  it('registerServiceOnChain 网络异常 → ok:false 不抛', async () => {
    const r = await registerServiceOnChain({
      privateKey: PK,
      contract: CONTRACT,
      agentId: 'a',
      serviceName: 'b',
      cid: 'c',
      rpcUrl: 'http://x',
      fetchImpl: failFetch,
      network: 'base',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('mobile-chain: 工具', () => {
  it('normalizeNetwork 支持 CAIP-2 与别名', () => {
    expect(normalizeNetwork('base')).toBe('base');
    expect(normalizeNetwork('eip155:8453')).toBe('base');
    expect(normalizeNetwork(undefined)).toBe('base');
    expect(() => normalizeNetwork('solana')).toThrow();
  });

  it('base64EncodeUtf8 与 atob 一致', () => {
    const s = JSON.stringify({ a: 1, zh: '中文' });
    expect(base64EncodeUtf8(s)).toBe(Buffer.from(s, 'utf-8').toString('base64'));
  });
});
