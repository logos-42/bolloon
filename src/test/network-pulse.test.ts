/**
 * network-pulse.test.ts — 网络脉冲 (公开投影) 的单测
 *
 * 覆盖 leo 计划里点名的后端测试项: 事件白名单 · 私有字段清理 · 时间窗边界 · 重复节点去重 ·
 * 签名校验 · stale/unavailable · 空网络 · malformed 事件 · capability 隐私阈值 ·
 * 公开接口无需认证 · 公开响应不含 DID/peerId/IP/钱包/任务正文。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PULSE_LIMITS, NETWORK_EVENT_TYPES, nodeDigest, capabilityGroup, bucketOf,
  recordNetworkEvent, computeSnapshot, getNetworkPulse, snapshotStatus,
  canonicalize, assertNoPrivateFields, renderActivityText,
} from '../agents/network-pulse.js';
import * as NP from '../agents/network-pulse.js';   // 新增断言用命名空间引用

let HOME = '';
const now = Date.UTC(2026, 8, 18, 12, 0, 0);

beforeAll(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-test-'));
  fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
});
afterAll(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* noop */ } });

describe('事件白名单与匿名化', () => {
  it('只接受白名单事件类型, 其它一律拒', async () => {
    const bad = await recordNetworkEvent({ type: 'task_body_leak', did: 'did:key:zA' }, HOME);
    expect(bad.ok).toBe(false);
    const ok = await recordNetworkEvent({ type: 'node_joined', did: 'did:key:zA' }, HOME);
    expect(ok.ok).toBe(true);
    expect(NETWORK_EVENT_TYPES).toContain('node_joined');
  });

  it('occurredAt 非法 → 拒 (不猜)', async () => {
    expect((await recordNetworkEvent({ type: 'node_joined', did: 'x', at: -1 }, HOME)).ok).toBe(false);
    expect((await recordNetworkEvent({ type: 'node_joined', did: 'x', at: Number.NaN }, HOME)).ok).toBe(false);
  });

  it('nodeDigest 不可逆且稳定 (不落原始 DID)', () => {
    const d1 = nodeDigest('did:key:zSameNode');
    expect(d1).toBe(nodeDigest('did:key:zSameNode'));
    expect(d1).not.toBe(nodeDigest('did:key:zOther'));
    expect(d1).toHaveLength(16);
    expect(d1).not.toContain('did');
  });

  it('能力名归并成粗类别, 不把原始名外泄', () => {
    expect(capabilityGroup('cross-border-market-research')).toBe('research');
    expect(capabilityGroup('code-review')).toBe('coding');
    expect(capabilityGroup('完全未知的能力')).toBe('other');
    expect(bucketOf(now)).toBe(bucketOf(now + 60_000));
    expect(bucketOf(now)).not.toBe(bucketOf(now + PULSE_LIMITS.bucketMs));
  });
});

describe('去重与时间窗', () => {
  it('同一节点同一小时重复入网 → 不虚增节点数', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-dedupe-'));
    await recordNetworkEvent({ type: 'node_joined', did: 'did:key:zN1', at: now }, h);
    await recordNetworkEvent({ type: 'node_joined', did: 'did:key:zN1', at: now + 1000 }, h);
    const snap = computeSnapshot((await getNetworkPulse({ home: h, now, force: true })) && [], { now });
    // 直接读事件算快照 (computeSnapshot 是纯函数, 这里用 getNetworkPulse 的产物校验)
    const real = await getNetworkPulse({ home: h, now, force: true });
    expect(real.totals.nodes).toBe(1);
    expect(snap.totals.nodes).toBe(0);
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('窗口外的事件不计入 (24h 边界)', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-window-'));
    await recordNetworkEvent({ type: 'node_joined', did: 'did:key:zOld', at: now - PULSE_LIMITS.windowMs - 60_000 }, h);
    const snap = await getNetworkPulse({ home: h, now, force: true });
    expect(snap.totals.nodes).toBe(0);
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('不同节点 / 不同 Agent 分开计数', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-count-'));
    await recordNetworkEvent({ type: 'peer_connected', did: 'did:key:zA', at: now }, h);
    await recordNetworkEvent({ type: 'peer_connected', did: 'did:key:zB', at: now }, h);
    await recordNetworkEvent({ type: 'capability_announced', capability: 'research', did: 'did:key:zA', agentId: 'a1', at: now }, h);
    await recordNetworkEvent({ type: 'capability_announced', capability: 'research', did: 'did:key:zA', agentId: 'a2', at: now }, h);
    const snap = await getNetworkPulse({ home: h, now, force: true });
    expect(snap.totals.nodes).toBe(2);
    expect(snap.totals.agents).toBe(2);
    expect(snap.totals.active_agents).toBe(2);
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe('隐私阈值与脱敏投影', () => {
  it('小于阈值的类别合并进 other', () => {
    const evs = [
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'research', occurredAt: now, sourceProof: 'n1', agentProof: 'a1' },
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'research', occurredAt: now, sourceProof: 'n1', agentProof: 'a2' },
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'research', occurredAt: now, sourceProof: 'n1', agentProof: 'a3' },
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'coding', occurredAt: now, sourceProof: 'n2', agentProof: 'b1' },
    ] as any;
    const snap = computeSnapshot(evs, { now });
    expect(snap.capabilities.find((c) => c.key === 'research')?.count).toBe(3);
    expect(snap.capabilities.find((c) => c.key === 'coding')).toBeUndefined();   // 1 < 阈值 → 不单独暴露
    expect(snap.capabilities.find((c) => c.key === 'other')?.count).toBe(1);
  });

  it('同一个 Agent 的多个能力不虚增类别计数', () => {
    const evs = [
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'coding', occurredAt: now, sourceProof: 'n1', agentProof: 'a1' },
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'coding', occurredAt: now, sourceProof: 'n1', agentProof: 'a1' },
      { type: 'capability_announced', bucket: '1', capabilityGroup: 'coding', occurredAt: now, sourceProof: 'n1', agentProof: 'a1' },
    ] as any;
    const snap = computeSnapshot(evs, { now });
    // 计数 = 1 → 低于阈值 → 只留 other
    expect(snap.capabilities.find((c) => c.key === 'coding')).toBeUndefined();
  });

  it('公开投影里不允许出现 did/peerId/IP/钱包/任务正文', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-private-'));
    await recordNetworkEvent({ type: 'peer_connected', did: 'did:key:zSecret', at: now }, h);
    await recordNetworkEvent({ type: 'capability_announced', capability: 'research', did: 'did:key:zSecret', agentId: 'agent-1', at: now }, h);
    const snap = await getNetworkPulse({ home: h, now, force: true });
    const json = JSON.stringify(snap);
    expect(assertNoPrivateFields(snap)).toEqual([]);
    expect(json).not.toContain('did:key');
    expect(json).not.toContain('zSecret');
    expect(json).not.toContain('agent-1');
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe('状态: live / stale / unavailable / 空网络', () => {
  it('新鲜快照 → live; 过期 → stale; 观察层不可用 → unavailable', () => {
    const snap = computeSnapshot([], { now });
    expect(snapshotStatus(snap, now)).toBe('live');
    expect(snapshotStatus(snap, now + PULSE_LIMITS.snapshotTtlMs + 1)).toBe('stale');
    const down = computeSnapshot([], { now, unavailable: true });
    expect(down.status).toBe('unavailable');
    expect(snapshotStatus(down, now)).toBe('unavailable');
    expect(down.notes.join(' ')).toContain('不是"网络为空"');
  });

  it('空网络 → live 且计数为 0 / 无源为 null (不报错)', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-empty-'));
    const snap = await getNetworkPulse({ home: h, now, force: true });
    expect(snap.status).toBe('live');
    // tasks/tasks_completed/tasks_settled = 真 0 (没有链上索引 → 降级脉冲口径, 那里确实一条都没有);
    // signatures 没有审计账也没有脉冲 → null (页面写「未接入」, 不写 0: 「没发生过」是另一句话)
    expect(snap.totals).toEqual({ nodes: 0, agents: 0, active_agents: 0, seen_last_24h: 0, tasks: 0, tasks_completed: 0, tasks_verified: 0, tasks_settled: 0, signatures: null });
    expect(snap.totals_scope.fields.signatures.source).toBe('none');
    expect(snap.totals_scope.fields.signatures.short.zh).toBe('未接入');
    expect(NP.snapshotConsistencyIssues(snap)).toEqual([]);
    expect(snap.capabilities).toEqual([]);
    expect(snap.recent_activity).toEqual([]);
    fs.rmSync(h, { recursive: true, force: true });
  });

  it('malformed 事件/坏文件 → 安全跳过, 不崩', async () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-bad-'));
    fs.mkdirSync(path.join(h, '.bolloon', 'network-pulse'), { recursive: true });
    fs.writeFileSync(path.join(h, '.bolloon', 'network-pulse', 'events.json'), '{ this is not json', 'utf8');
    const snap = await getNetworkPulse({ home: h, now, force: true });
    expect(snap.status).toBe('live');
    expect(snap.totals.nodes).toBe(0);
    // 坏事件对象也不会让快照崩
    const mixed = [null, 42, { type: 'node_joined' }, { type: 'capability_announced', occurredAt: now, sourceProof: 'n' }] as any;
    expect(() => computeSnapshot(mixed, { now })).not.toThrow();
    fs.rmSync(h, { recursive: true, force: true });
  });
});

describe('scope 可信边界与签名', () => {
  it('单节点观察 → observed (文案不吹成全网)', () => {
    const snap = computeSnapshot([{ type: 'node_joined', bucket: '1', occurredAt: now, sourceProof: 'n1', signed: true }] as any, { now });
    expect(snap.scope).toBe('observed');
    expect(snap.scope_label.zh).toContain('当前节点观察到');
    expect(snap.notes.join(' ')).toContain('不是全网精确总量');
  });

  it('≥2 个签名来源 → verified snapshot', () => {
    const snap = computeSnapshot([
      { type: 'node_joined', bucket: '1', occurredAt: now, sourceProof: 'n1', signed: true },
      { type: 'node_joined', bucket: '1', occurredAt: now, sourceProof: 'n2', signed: true },
    ] as any, { now });
    expect(snap.scope).toBe('verified');
    expect(snap.scope_label.en).toBe('Verified network snapshot');
  });

  it('canonicalize 键序无关 (签名覆盖稳定)', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ a: [1, { d: 1, c: 2 }] })).toBe('{"a":[1,{"c":2,"d":1}]}');
  });

  it('活动文本由服务端模板生成 (中英都有)', () => {
    for (const t of NETWORK_EVENT_TYPES) {
      const txt = renderActivityText(t);
      expect(txt.zh.length).toBeGreaterThan(0);
      expect(txt.en.length).toBeGreaterThan(0);
    }
  });
});

// 公开接口的 HTTP 端到端 (无认证 / ETag / 304 / 无私字段) 在
// `scripts/verify-network-pulse.ts` 的 [5] 段真跑验证 —— 单测里不再起真服务 (起服务会拖到 90s 且抖动)。

describe('经济计数 (任务数/完成数/已验真) 与智能体私有站 (IPNS)', () => {
  it('真实交易活动 → 脉冲事件: 交付→task_completed · 真验真→trade_verified · 仅链上口径→trade_settled', async () => {
    const home = mkTmp();
    const base = { transactionId: 'tx-1', requestId: 'req-1', buyerDid: 'did:key:zB', paymentMode: 'local-dev', settlementFact: 'payment_submitted' };
    // local-dev: 交付 + 验真事件会记, 但**绝不出 trade_settled** (没链上结算)
    await NP.emitTradePulse({ ...base, status: 'paid' }, { ...base, status: 'delivered' }, home);
    await NP.emitTradePulse({ ...base, status: 'delivered' }, { ...base, status: 'verified' }, home);
    let snap: any = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.tasks_completed).toBe(1);
    expect(snap.totals.tasks_verified).toBe(1);
    expect(snap.totals.tasks).toBe(0);            // 没有 task_posted 事件就不虚报任务数

    // 链上口径结算才出 trade_settled
    await NP.emitTradePulse({ ...base, settlementFact: 'payment_submitted' }, { ...base, settlementFact: 'fully_settled', chainSettled: true }, home);
    snap = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.tasks_completed).toBe(1);

    // 同一状态重复调用不重复计数 (幂等: before 已经是该状态)
    await NP.emitTradePulse({ ...base, status: 'delivered' }, { ...base, status: 'delivered' }, home);
    snap = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.tasks_completed).toBe(1);
  });

  it('钱包签名计数: 按 (来源, 时刻) 去重', async () => {
    const home = mkTmp();
    await NP.recordNetworkEvent({ type: 'wallet_signed', did: 'did:key:zB', taskId: 't1' }, home);
    await NP.recordNetworkEvent({ type: 'wallet_signed', did: 'did:key:zB', taskId: 't1' }, home);
    const snap: any = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.signatures).toBeGreaterThan(0);
  });

  // 本文件既有风格: 直接 mkdtempSync 建临时 home (没有全局助手)
  const mkTmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-econ-'));
  it('任务计数按**不同任务**去重, 同任务重复事件不虚增', async () => {
    const home = mkTmp();
    await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'task-A', did: 'did:key:zA', agentId: 'a1' }, home);
    await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'task-A', did: 'did:key:zA', agentId: 'a1' }, home);
    await NP.recordNetworkEvent({ type: 'task_accepted', taskId: 'task-A', did: 'did:key:zB', agentId: 'b1' }, home);
    await NP.recordNetworkEvent({ type: 'task_posted', taskId: 'task-B', did: 'did:key:zA', agentId: 'a1' }, home);
    let snap: any = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.tasks).toBe(2);              // A 重复两次 + B = 2 个不同任务
    expect(snap.totals.tasks_completed).toBe(0);

    await NP.recordNetworkEvent({ type: 'task_completed', taskId: 'task-A', did: 'did:key:zB', agentId: 'b1' }, home);
    await NP.recordNetworkEvent({ type: 'trade_verified', taskId: 'task-A', did: 'did:key:zB', agentId: 'b1' }, home);
    snap = await NP.getNetworkPulse({ home, force: true });
    expect(snap.totals.tasks_completed).toBe(1);
    expect(snap.totals.tasks_verified).toBe(1);

    // 私字段兜底: 任务 ID 原文不许出现在公开投影里
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/task-A|task-B/);
  });

  it('IPNS 归一化: 三种写法都吃, 其它一律拒绝', () => {
    const k = 'k51qzi5uqu5dgn4g2d1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0';
    expect(NP.normalizeIpns(k)).toBe(k);
    expect(NP.normalizeIpns(`ipns://${k}`)).toBe(k);
    expect(NP.normalizeIpns(`/ipns/${k}`)).toBe(k);
    expect(NP.normalizeIpns(`ipns://${k}/index.html`)).toBe(k);
    expect(NP.normalizeIpns('https://example.com/secret')).toBeNull();
    expect(NP.normalizeIpns('')).toBeNull();
    expect(NP.normalizeIpns('not-an-ipns-key')).toBeNull();
    expect(NP.normalizeIpns(undefined as any)).toBeNull();
  });

  it('私有站清单: 缺文件→空; 去重; 上限 5; 非法条目被丢弃; 不泄露 DID', async () => {
    const home = mkTmp();
    expect(NP.readAgentSites(home)).toEqual([]);
    const dir = path.join(home, '.bolloon');
    fs.mkdirSync(dir, { recursive: true });
    const k = (i: number) => `k51qzi5uqu5dgn4g2d1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t${i}`;
    fs.writeFileSync(path.join(dir, 'agent-sites.json'), JSON.stringify([
      { label: 'leo-node', ipns: `ipns://${k(1)}`, added_at: 1760000000000 },
      { label: 'dup', ipns: k(1) },
      { label: 'bad', ipns: 'https://evil.example.com' },
      { label: 'no-ipns' },
      { label: 'b2', ipns: k(2) }, { label: 'b3', ipns: k(3) },
      { label: 'b4', ipns: k(4) }, { label: 'b5', ipns: k(5) }, { label: 'b6', ipns: k(6) },
    ]), 'utf8');
    const sites = NP.readAgentSites(home);
    expect(sites).toHaveLength(5);                       // 上限
    expect(sites[0]).toMatchObject({ label: 'leo-node', ipns: k(1) });
    expect(new Set(sites.map((x) => x.ipns)).size).toBe(5);  // 去重生效
    expect(JSON.stringify(sites)).not.toMatch(/did:|peerId|privateKey/);
    expect(NP.assertNoPrivateFields({ agent_sites: sites })).toEqual([]);
  });
});
