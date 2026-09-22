/**
 * chain-config.test.ts — 链配置 / 确认数配置 / 密钥读取优先级 (P3)
 *
 * 覆盖:
 *   · 读取优先级: 环境变量 → 本地安全配置 → **仓库部署 manifest** → 报错 (绝不猜地址, 绝不硬编码密钥)
 *   · 第 ③ 层 manifest: 按锚 (chainId / networkName / rpcUrl / escrowAddress) 匹配 · 没有锚不选 ·
 *     多份匹配不选 · 跨 chainId 不取地址 · .token / .externalToken 两个字段都认 ·
 *     requireToken (真写拿不到 token → 可操作的报错)
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
  listDeploymentManifests, selectDeploymentManifest, deploymentsDir, DEPLOYMENTS_DIR_ENV,
  LOCAL_DEV_CHAIN_ID,
} from '../agents/chain/chain-config.js';

let HOME: string;
beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chaincfg-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

/** 一个**空**的 manifest 目录: 用来表达"三层都拿不到" (而不是靠"恰好匹配不上") */
const EMPTY_DEPLOYMENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-no-deployments-'));

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
    try { loadChainConfig({ home: HOME, env: { BOLLOON_DEPLOYMENTS_DIR: EMPTY_DEPLOYMENTS } as any }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChainConfigError);
    expect(err.missing).toEqual(expect.arrayContaining(['rpcUrl', 'chainId', 'escrowAddress']));
    expect(err.message).toContain('链配置缺失');
  });

  it('只缺 escrow 地址也要报错 (RPC 够但没合约 → 不能瞎连)', () => {
    let err: any = null;
    try {
      loadChainConfig({ home: HOME, env: { BOLLOON_CHAIN_RPC_URL: 'http://x:8545', BOLLOON_CHAIN_ID: '31337', BOLLOON_DEPLOYMENTS_DIR: EMPTY_DEPLOYMENTS } as any });
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
    const cfg = loadChainConfig({ home: HOME, env: { BOLLOON_DEPLOYMENTS_DIR: EMPTY_DEPLOYMENTS } as any });
    expect(cfg.tokenAddress).toBeNull();
    expect(cfg.sources.tokenAddress).toContain('未配置');
  });
});

describe('第 ③ 层: 仓库部署 manifest (env → chain.json → manifest → 报错)', () => {
  let DEPLOY_DIR: string;
  beforeEach(() => { DEPLOY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-deployments-')); });
  afterEach(() => { fs.rmSync(DEPLOY_DIR, { recursive: true, force: true }); });

  const mEscrow = '0x' + 'aa'.repeat(20);
  const mToken = '0x' + 'bb'.repeat(20);
  const writeManifest = (name: string, obj: any) => fs.writeFileSync(path.join(DEPLOY_DIR, name), JSON.stringify(obj));
  const localhostManifest = (over: any = {}) => ({
    chainId: 31337, networkName: 'localhost', rpcUrl: 'http://127.0.0.1:8545',
    contracts: [{ name: 'AgentEscrow', address: mEscrow, blockNumber: 2 }],
    token: { address: mToken, decimals: 6 },
    ...over,
  });

  it('目录口径: env BOLLOON_DEPLOYMENTS_DIR 优先, 其余从 cwd 往上找 contracts/deployments', () => {
    expect(deploymentsDir({ [DEPLOYMENTS_DIR_ENV]: DEPLOY_DIR } as any)).toBe(DEPLOY_DIR);
    expect(deploymentsDir({} as any)).toBe(path.resolve(process.cwd(), 'contracts', 'deployments'));
  });

  it('只给锚 (chainId + networkName) → escrow / token / decimals 从 manifest 解析, 并如实标来源', () => {
    writeManifest('localhost.json', localhostManifest());
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://127.0.0.1:8545', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.escrowAddress).toBe(mEscrow);
    expect(cfg.tokenAddress).toBe(mToken);
    expect(cfg.tokenDecimals).toBe(6);
    expect(cfg.chainId).toBe(31337);
    expect(cfg.sources.escrowAddress).toContain('manifest');
    expect(cfg.sources.tokenAddress).toContain('manifest');
    expect(cfg.sources.deploymentManifest).toContain('localhost.json');
  });

  it('★ .externalToken 回退: manifest 只记外部真 token 也认 (本地 mock 记 .token, 真链记 .externalToken)', () => {
    writeManifest('localhost.json', localhostManifest({ token: undefined, externalToken: { address: mToken, decimals: 6 }, tokenSource: 'external' }));
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.tokenAddress).toBe(mToken);
    expect(cfg.sources.tokenAddress).toContain('externalToken');
  });

  it('env 优先: env 给了 escrow / token → manifest 只补空位 (优先级不可颠倒)', () => {
    writeManifest('localhost.json', localhostManifest());
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_ESCROW_ADDRESS: ADDR, BOLLOON_TOKEN_ADDRESS: TOKEN, BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.escrowAddress).toBe(ADDR);
    expect(cfg.tokenAddress).toBe(TOKEN);
    expect(cfg.sources.escrowAddress).toContain('env');
    expect(cfg.escrowAddress).not.toBe(mEscrow);
  });

  it('★ token 来自 env 但没给精度 → 不拿 manifest 里**另一个** token 的 decimals (不张冠李戴)', () => {
    writeManifest('localhost.json', localhostManifest({ token: { address: mToken, decimals: 18 } }));
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_ESCROW_ADDRESS: ADDR, BOLLOON_TOKEN_ADDRESS: TOKEN, BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.tokenAddress).toBe(TOKEN);
    expect(cfg.tokenDecimals).toBe(DEFAULT_TOKEN_DECIMALS);
  });

  it('chainId 与 manifest 不符 → 拒绝跨链取地址 (报错, 不静默换链)', () => {
    writeManifest('localhost.json', localhostManifest());   // chainId 31337
    let err: any = null;
    try {
      loadChainConfig({ home: HOME, env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '84532', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChainConfigError);
    expect(err.missing).toContain('escrowAddress');
    expect(err.message).toContain('匹配不上');
  });

  it('★ 歧义: 两份同 chainId 的 manifest 且只给 chainId → 报错并列出候选 (不猜是哪份)', () => {
    writeManifest('localhost.json', localhostManifest());
    writeManifest('localhost-external.json', localhostManifest({ networkName: 'localhost-external', contracts: [{ name: 'AgentEscrow', address: '0x' + 'cc'.repeat(20), blockNumber: 134 }] }));
    let err: any = null;
    try {
      // 只给 chainId 一个锚 (不给 rpcUrl/networkName) → 两份 localhost 变体都匹配
      loadChainConfig({ home: HOME, env: { BOLLOON_CHAIN_ID: '31337', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any });
    } catch (e) { err = e; }
    expect(err?.message).toContain('歧义');
    expect(err?.message).toContain('localhost-external.json');
    expect(err?.missing).toContain('escrowAddress');
  });

  it('★ 没有锚 → 目录里只有一份 manifest 也不选 (说不出是哪条链的部署)', () => {
    writeManifest('localhost.json', localhostManifest());
    let err: any = null;
    try { loadChainConfig({ home: HOME, env: { BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any }); } catch (e) { err = e; }
    expect(err?.message).toContain('没有锚');
    expect(err?.missing).toEqual(expect.arrayContaining(['rpcUrl', 'chainId', 'escrowAddress']));
  });

  it('文件名 <networkName>.json 优先: 两份同 chainId 时按网络名选中正确的一份', () => {
    writeManifest('localhost.json', localhostManifest());
    writeManifest('localhost-external.json', localhostManifest({ networkName: 'localhost-external', contracts: [{ name: 'AgentEscrow', address: '0x' + 'cc'.repeat(20), blockNumber: 134 }] }));
    const cfg = loadChainConfig({
      home: HOME,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost-external', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.escrowAddress).toBe('0x' + 'cc'.repeat(20));
    expect(cfg.networkName).toBe('localhost-external');
  });

  it('★ requireToken: 真写而三层都拿不到 token → 抛可操作的错 (点名三层 + 怎么修)', () => {
    writeManifest('localhost.json', localhostManifest({ token: undefined }));
    let err: any = null;
    try {
      loadChainConfig({
        home: HOME, requireToken: true,
        env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ChainConfigError);
    expect(err.missing).toEqual(['tokenAddress']);
    expect(err.message).toContain('BOLLOON_TOKEN_ADDRESS');
    expect(err.message).toContain('chain.json');
    expect(err.message).toContain('manifest');
  });

  it('requireToken 而 token 拿得到 → 不抛 (只拦真缺的)', () => {
    writeManifest('localhost.json', localhostManifest());
    const cfg = loadChainConfig({
      home: HOME, requireToken: true,
      env: { BOLLOON_CHAIN_RPC_URL: 'http://x:1', BOLLOON_CHAIN_ID: '31337', BOLLOON_NETWORK_NAME: 'localhost', BOLLOON_DEPLOYMENTS_DIR: DEPLOY_DIR } as any,
    });
    expect(cfg.tokenAddress).toBe(mToken);
  });

  it('selectDeploymentManifest 直接调用也守规矩 (没锚 → null + 说明原因)', () => {
    writeManifest('localhost.json', localhostManifest());
    const sel = selectDeploymentManifest({ deploymentsDir: DEPLOY_DIR });
    expect(sel.manifest).toBeNull();
    expect(sel.reason).toContain('没有锚');
    expect(sel.candidates.length).toBe(1);
    const hit = selectDeploymentManifest({ chainId: 31337, escrowAddress: mEscrow, deploymentsDir: DEPLOY_DIR });
    expect(hit.manifest?.escrowAddress).toBe(mEscrow);
  });

  it('listDeploymentManifests 跳过坏文件 / 没有 AgentEscrow 的 manifest (不静默当空)', () => {
    writeManifest('localhost.json', localhostManifest());
    writeManifest('broken.json', { chainId: 31337, contracts: [] });
    fs.writeFileSync(path.join(DEPLOY_DIR, 'notjson.json'), '{oops');
    const list = listDeploymentManifests({ deploymentsDir: DEPLOY_DIR });
    expect(list.map((m) => path.basename(m.path))).toEqual(['localhost.json']);
    expect(list[0].tokenAddress).toBe(mToken);
    expect(list[0].escrowBlockNumber).toBe(2);
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
