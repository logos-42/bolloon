/**
 * chain-config.test.ts — 链配置 / 确认数配置 / 密钥读取优先级 (P3)
 *
 * 覆盖:
 *   · 读取优先级: 环境变量 → 本地安全配置 → 报错 (绝不猜地址, 绝不硬编码密钥)
 *   · 确认数 confirmed=1 / finalized=12 是**配置** (可覆盖, 非法值不静默降级)
 *   · 拒绝读取别的 agent 的钱包目录 (~/.hermes/wallets)
 *   · 钱包私钥只能从 env 或 ~/.bolloon/wallet.json 来
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  loadChainConfig, ChainConfigError, DEFAULT_CONFIRMATIONS, DEFAULT_TOKEN_DECIMALS,
  meetsConfirmations, chainConfigPath, readWalletPrivateKey, walletAvailable, assertNotForeignWalletPath,
  LOCAL_DEV_CHAIN_ID,
} from '../agents/chain/chain-config.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chaincfg-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const ADDR = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const PK = '0x' + '11'.repeat(32);

const writeChainJson = (obj: any) => {
  fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
  fs.writeFileSync(chainConfigPath(HOME), JSON.stringify(obj), 'utf8');
};

describe('loadChainConfig — 读取优先级', () => {
  it('环境变量优先于本地配置文件', () => {
    writeChainJson({ rpcUrl: 'http://from-file:8545', chainId: 31337, escrowAddress: ADDR });
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://from-env:8545', BOLLOON_CHAIN_ID: '31337', BOLLOON_ESCROW_ADDRESS: ADDR } as any,
    });
    expect(cfg.rpcUrl).toBe('http://from-env:8545');
    expect(cfg.sources.rpcUrl).toContain('env');
  });

  it('没有 env 时用 ~/.bolloon/chain.json', () => {
    writeChainJson({ rpcUrl: 'http://from-file:8545', chainId: 31337, escrowAddress: ADDR, tokenAddress: TOKEN, networkName: 'localhost' });
    const cfg = loadChainConfig({ home: HOME, env: {} as any });
    expect(cfg.rpcUrl).toBe('http://from-file:8545');
    expect(cfg.escrowAddress).toBe(ADDR);
    expect(cfg.tokenAddress).toBe(TOKEN);
    expect(cfg.networkName).toBe('localhost');
    expect(cfg.sources.escrowAddress).toContain('chain.json');
  });

  it('都没有 → 抛错并列出缺什么 (不猜合约地址)', () => {
    let err: any = null;
    try { loadChainConfig({ home: HOME, env: {} as any }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChainConfigError);
    expect(err.missing).toEqual(expect.arrayContaining(['rpcUrl', 'chainId', 'escrowAddress']));
    expect(err.message).toContain('链配置缺失');
  });

  it('只缺 escrow 地址也要报错 (RPC 够但没合约 → 不能瞎连)', () => {
    let err: any = null;
    try {
      loadChainConfig({ home: HOME, env: { BOLLOON_CHAIN_RPC_URL: 'http://x:8545', BOLLOON_CHAIN_ID: '31337' } as any });
    } catch (e) { err = e; }
    expect(err?.missing).toEqual(['escrowAddress']);
  });

  it('env 里的 escrow 地址非法 → 直接报错 (不静默忽略)', () => {
    expect(() => loadChainConfig({
      home: HOME, env: { BOLLOON_CHAIN_RPC_URL: 'http://x:8545', BOLLOON_CHAIN_ID: '31337', BOLLOON_ESCROW_ADDRESS: '0xnothex' } as any,
    })).toThrow(/不是合法地址/);
  });

  it('token 未配置 → null + 明确来源说明 (不冒充有 token)', () => {
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR });
    const cfg = loadChainConfig({ home: HOME, env: {} as any });
    expect(cfg.tokenAddress).toBeNull();
    expect(cfg.sources.tokenAddress).toContain('未配置');
  });
});

describe('确认数配置 (confirmed=1 / finalized=12 写成配置)', () => {
  it('默认值就是 1 / 12', () => {
    expect(DEFAULT_CONFIRMATIONS).toEqual({ confirmed: 1, finalized: 12 });
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR });
    const cfg = loadChainConfig({ home: HOME, env: {} as any });
    expect(cfg.confirmations).toEqual({ confirmed: 1, finalized: 12 });
    expect(cfg.sources.confirmations).toContain('默认');
  });

  it('可用 env 覆盖 (不硬编码)', () => {
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR });
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CONFIRMATIONS_CONFIRMED: '3', BOLLOON_CONFIRMATIONS_FINALIZED: '20' } as any,
    });
    expect(cfg.confirmations).toEqual({ confirmed: 3, finalized: 20 });
    expect(cfg.sources.confirmations).toContain('env');
  });

  it('可用 chain.json 覆盖', () => {
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR, confirmations: { confirmed: 2, finalized: 8 } });
    const cfg = loadChainConfig({ home: HOME, env: {} as any });
    expect(cfg.confirmations).toEqual({ confirmed: 2, finalized: 8 });
  });

  it('确认数 0 / 负数 → 落到默认 (不变成"0 确认算结算")', () => {
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR });
    const cfg = loadChainConfig({ home: HOME, env: { BOLLOON_CONFIRMATIONS_CONFIRMED: '0' } as any });
    expect(cfg.confirmations.confirmed).toBe(1);
  });

  it('finalized < confirmed → 配置不自洽, 报错 (不静默修正)', () => {
    expect(() => loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_ESCROW_ADDRESS: ADDR, BOLLOON_CONFIRMATIONS_CONFIRMED: '5', BOLLOON_CONFIRMATIONS_FINALIZED: '2' } as any,
    })).toThrow(/不自洽/);
  });

  it('meetsConfirmations 是唯一门槛实现', () => {
    expect(meetsConfirmations(1, 'confirmed')).toBe(true);
    expect(meetsConfirmations(0, 'confirmed')).toBe(false);
    expect(meetsConfirmations(11, 'finalized')).toBe(false);
    expect(meetsConfirmations(12, 'finalized')).toBe(true);
    expect(meetsConfirmations(Number.NaN, 'confirmed')).toBe(false);
  });

  it('token decimals 默认 6 (USDC), 可覆盖', () => {
    expect(DEFAULT_TOKEN_DECIMALS).toBe(6);
    writeChainJson({ rpcUrl: 'http://f:1', chainId: 31337, escrowAddress: ADDR, tokenDecimals: 18 });
    expect(loadChainConfig({ home: HOME, env: {} as any }).tokenDecimals).toBe(18);
  });
});

describe('钱包私钥读取 (绝不硬编码 / 绝不读别的 agent 的钱包)', () => {
  it('env → 用 env', () => {
    const r = readWalletPrivateKey({ home: HOME, env: { BOLLOON_WALLET_PRIVATE_KEY: PK } as any });
    expect(r.privateKey).toBe(PK);
    expect(r.source).toContain('env');
  });

  it('env 格式不对 → 报错', () => {
    expect(() => readWalletPrivateKey({ home: HOME, env: { BOLLOON_WALLET_PRIVATE_KEY: 'not-a-key' } as any })).toThrow(/格式不对/);
  });

  it('没有 env → 读 ~/.bolloon/wallet.json', () => {
    fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.bolloon', 'wallet.json'), JSON.stringify({ privateKey: PK, address: '0xabc' }), { mode: 0o600 });
    const r = readWalletPrivateKey({ home: HOME, env: {} as any });
    expect(r.privateKey).toBe(PK);
    expect(r.source).toContain('wallet.json');
  });

  it('两处都没有 → 报错并说清优先级 (不生成、不猜)', () => {
    expect(() => readWalletPrivateKey({ home: HOME, env: {} as any })).toThrow(/本机没有可用钱包/);
  });

  it('wallet.json 里没有合法私钥 → 报错', () => {
    fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.bolloon', 'wallet.json'), JSON.stringify({ address: '0xabc' }), 'utf8');
    expect(() => readWalletPrivateKey({ home: HOME, env: {} as any })).toThrow(/没有可用的 privateKey/);
  });

  it('★ 拒绝读取 ~/.hermes/wallets (别的 agent 的钱包)', () => {
    expect(() => assertNotForeignWalletPath('/Users/x/.hermes/wallets/main.json')).toThrow(/拒绝读取其它 agent 的钱包目录/);
    expect(() => assertNotForeignWalletPath('/tmp/.bolloon/wallet.json')).not.toThrow();
  });

  it('walletAvailable 只报可用性, 不返回私钥', () => {
    const a = walletAvailable({ home: HOME, env: { BOLLOON_WALLET_PRIVATE_KEY: PK } as any });
    expect(a.available).toBe(true);
    expect(Object.keys(a)).not.toContain('privateKey');
    const b = walletAvailable({ home: HOME, env: {} as any });
    expect(b.available).toBe(false);
    expect(b.reason).toContain('没有可用钱包');
  });
});

describe('本地链常量', () => {
  it('LOCAL_DEV_CHAIN_ID = 31337', () => {
    expect(LOCAL_DEV_CHAIN_ID).toBe(31337);
  });
});
