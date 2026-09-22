/**
 * chain-wallet-authorization.test.ts — 链上签名放行闸 + 审计 (P3, ③)
 *
 * 硬规则 (题干): 链上交易签名必须走 `authorizeWalletSignature` 唯一放行闸 (fail-closed)
 * + 写 `~/.bolloon/wallet-signatures.jsonl` 审计 (不记私钥、不记任务正文); 未授权一律拒。
 *
 * 覆盖:
 *   · 未授权 → 拒绝, 且**不造 signer / 不发交易 / 不写审计**
 *   · 授权但钱包不可用 → 拒绝
 *   · 授权 + 钱包可用 → 放行, 交易执行一次, 审计写一条
 *   · 同一个 requestId 重复 → 拒绝 (幂等)
 *   · 超额 → 拒绝 (预算门)
 *   · 审计条目不含私钥/任务正文
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  authorizeChainTransaction, sendChainTxGuarded, chainRequestIdOf, readChainSigningPolicy,
  CHAIN_SIGN_CAPABILITY, chainSigningPolicyPath,
} from '../agents/chain/chain-wallet.js';
import { assertAuditSafe, AUDIT_FORBIDDEN_KEYS } from '../agents/task-contract.js';
import { EscrowClient } from '../agents/chain/escrow-client.js';
import { fakeProvider, clientWith, ESCROW_ADDR, TASK_KEY } from './chain-test-helpers.js';

let HOME: string;
const PK = '0x' + '22'.repeat(32);
const bhome = () => path.join(HOME, '.bolloon');

beforeEach(() => { HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-chainsign-')); });
afterEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

const putWallet = () => {
  fs.mkdirSync(bhome(), { recursive: true });
  fs.writeFileSync(path.join(bhome(), 'wallet.json'), JSON.stringify({ privateKey: PK }), { mode: 0o600 });
};
const putPolicy = (obj: any) => {
  fs.mkdirSync(bhome(), { recursive: true });
  fs.writeFileSync(chainSigningPolicyPath(HOME), JSON.stringify(obj), 'utf8');
};

const INTENT = { method: 'releaseV2' as const, taskKey: TASK_KEY, amountAtomic: '0', network: 'localhost' };

describe('authorizeChainTransaction — 放行闸 (fail-closed)', () => {
  it('未授权 (无 policy / 无 env) → 拒绝, 原因是 agentAuthorized', async () => {
    const auth = await authorizeChainTransaction(INTENT, { home: HOME, env: {} as any, auditReader: async () => [] });
    expect(auth.allowed).toBe(false);
    expect(auth.checks.agentAuthorized).toBe(false);
    expect(auth.reason).toContain('拒绝签名');
    expect(auth.privateKeyTouched).toBe(false);
  });

  it('只有 policy 文件 agentAuthorized=true 才授权 (命令参数不能授予)', async () => {
    const p0 = readChainSigningPolicy({ home: HOME, env: {} as any });
    expect(p0.agentAuthorized).toBe(false);
    expect(p0.source).toContain('未授权');
    putPolicy({ agentAuthorized: true, allowedNetworks: ['localhost'], allowedCapabilities: [CHAIN_SIGN_CAPABILITY] });
    const p1 = readChainSigningPolicy({ home: HOME, env: {} as any });
    expect(p1.agentAuthorized).toBe(true);
    expect(p1.source).toContain('agentAuthorized=true');
  });

  it('env BOLLOON_AGENT_AUTHORIZED=1 也能授权', async () => {
    const auth = await authorizeChainTransaction(INTENT, {
      home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, auditReader: async () => [],
    });
    // 授权了但钱包不可用 → 仍然拒
    expect(auth.allowed).toBe(false);
    expect(auth.checks.agentAuthorized).toBe(true);
    expect(auth.checks.walletAvailable).toBe(false);
  });

  it('授权 + 钱包可用 → 放行', async () => {
    putWallet();
    const auth = await authorizeChainTransaction(INTENT, {
      home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, auditReader: async () => [],
    });
    expect(auth.allowed).toBe(true);
    expect(auth.requestId).toContain('chaintx-releaseV2');
    expect(auth.walletSource).toContain('wallet.json');
  });

  it('同一个 requestId 已签过 → 拒绝 (幂等: 同一意图不重复签)', async () => {
    putWallet();
    const rid = chainRequestIdOf(INTENT, 31337);
    const auth = await authorizeChainTransaction(INTENT, {
      home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, chainId: 31337,
      auditReader: async () => [{ at: Date.now(), requestId: rid, amountAtomic: '0' }],
    });
    expect(auth.allowed).toBe(false);
    expect(auth.checks.notDuplicate).toBe(false);
    expect(auth.reason).toContain('notDuplicate');
  });

  it('金额超过单笔上限 → 拒绝 (预算门)', async () => {
    putWallet();
    const auth = await authorizeChainTransaction(
      { ...INTENT, method: 'createEscrowV2', amountAtomic: '5000000' },
      { home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, auditReader: async () => [], } as any,
    );
    expect(auth.allowed).toBe(true);
    // 收紧到 1000000 → 必须拒
    const r2 = await authorizeChainTransaction(
      { ...INTENT, method: 'createEscrowV2', amountAtomic: '5000000', maxPerTxAtomic: '1000000' },
      { home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, auditReader: async () => [] },
    );
    expect(r2.allowed).toBe(false);
    expect(r2.checks.underPerTx).toBe(false);
  });

  it('网络不在白名单 → 拒绝', async () => {
    putWallet();
    putPolicy({ agentAuthorized: true, allowedNetworks: ['base-sepolia'] });
    const auth = await authorizeChainTransaction(INTENT, { home: HOME, env: {} as any, auditReader: async () => [] });
    expect(auth.allowed).toBe(false);
    expect(auth.checks.networkAllowed).toBe(false);
  });
});

describe('sendChainTxGuarded — 拒绝时不动手', () => {
  it('★ 未授权: execute 一次都不许被调用, 也不写审计', async () => {
    const executed = vi.fn(async () => 'should-not-run');
    const audited = vi.fn(async () => {});
    const res = await sendChainTxGuarded({
      client: clientWith(fakeProvider({})),
      intent: INTENT,
      execute: executed,
      home: HOME, env: {} as any, auditReader: async () => [], recordAudit: audited as any,
    });
    expect(res.allowed).toBe(false);
    expect(executed).not.toHaveBeenCalled();
    expect(audited).not.toHaveBeenCalled();
    expect(res.auditWritten).toBe(false);
  });

  it('★ 授权 + 钱包装好: 执行一次, 审计写一条, 条目里没有私钥/任务正文', async () => {
    putWallet();
    const executed = vi.fn(async () => 'tx-sent');
    const audited = vi.fn(async () => {});
    const res = await sendChainTxGuarded({
      client: clientWith(fakeProvider({})),
      intent: { ...INTENT, taskId: 'task-1' },
      execute: executed,
      signer: { getAddress: async () => '0x' + 'a0'.repeat(20) } as any,
      home: HOME, env: { BOLLOON_AGENT_AUTHORIZED: '1' } as any, auditReader: async () => [],
      recordAudit: audited as any,
    });
    expect(res.allowed).toBe(true);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(res.outcome).toBe('tx-sent');
    expect(audited).toHaveBeenCalledTimes(1);
    expect(res.auditWritten).toBe(true);

    const entry: any = audited.mock.calls[0][0];
    // 不记私钥 / 不记任务正文
    expect(JSON.stringify(entry)).not.toContain(PK);
    expect(entry.privateKey).toBeUndefined();
    expect(assertAuditSafe(entry)).toEqual([]);
    expect(Object.keys(entry).some((k) => AUDIT_FORBIDDEN_KEYS.includes(k))).toBe(false);
    // 审计里该有的东西
    expect(entry.requestId).toContain('chaintx-releaseV2');
    expect(entry.kind).toBe('task_payment');
    expect(entry.capability).toBe(CHAIN_SIGN_CAPABILITY);
    expect(typeof entry.payloadDigest).toBe('string');
  });

  it('放行闸过了但钱包读不出来 → 明确报错, 不假装发过', async () => {
    // 有 policy 授权但没有 wallet.json
    putPolicy({ agentAuthorized: true });
    const executed = vi.fn(async () => 'nope');
    const res = await sendChainTxGuarded({
      client: clientWith(fakeProvider({})),
      intent: INTENT, execute: executed,
      home: HOME, env: {} as any, auditReader: async () => [], recordAudit: (async () => {}) as any,
    });
    expect(res.allowed).toBe(false);
    expect(executed).not.toHaveBeenCalled();
  });
});

describe('requestId 幂等键', () => {
  it('同一 method+taskKey+金额+链 → 同一个 id; 换一档就变', () => {
    const a = chainRequestIdOf(INTENT, 31337);
    const b = chainRequestIdOf(INTENT, 31337);
    const c = chainRequestIdOf({ ...INTENT, method: 'submitProofV2' }, 31337);
    const d = chainRequestIdOf(INTENT, 31337);
    expect(a).toBe(b);
    expect(a).toBe(d);
    expect(a).not.toBe(c);
  });
});

describe('EscrowClient.localSigner 只从本机钱包取钥', () => {
  it('没有钱包 → 抛错 (不静默造随机钱包)', () => {
    const c = new EscrowClient({ escrowAddress: ESCROW_ADDR, provider: fakeProvider({}) });
    expect(() => c.localSigner({ home: HOME })).toThrow(/没有可用钱包/);
  });
});

describe('审计真写到 ~/.bolloon/wallet-signatures.jsonl', () => {
  it('recordSignatureAudit 的落盘位置就是 <home>/.bolloon/wallet-signatures.jsonl (jsonl, 只记摘要)', async () => {
    const { recordSignatureAudit, readSignatureAudit } = await import('../agents/task-contract.js');
    await recordSignatureAudit({
      kind: 'task_payment', mode: 'agent-authorized', requestId: 'chaintx-test-1',
      taskId: 'task-1', amountAtomic: '100', currency: 'USDC', network: 'localhost',
      capability: CHAIN_SIGN_CAPABILITY, signerFingerprint: 'sha256:abc', payloadDigest: 'deadbeef',
    }, HOME);
    const p = path.join(HOME, '.bolloon', 'wallet-signatures.jsonl');
    expect(fs.existsSync(p)).toBe(true);
    const raw = fs.readFileSync(p, 'utf8').trim();
    expect(raw.split('\n').length).toBe(1);
    const row = JSON.parse(raw);
    expect(row.requestId).toBe('chaintx-test-1');
    expect(row.kind).toBe('task_payment');
    // 只记摘要: 没有私钥、没有任务正文
    expect(raw).not.toContain(PK);
    expect(assertAuditSafe(row)).toEqual([]);
    expect((await readSignatureAudit(HOME, 10)).length).toBe(1);
  });
});
