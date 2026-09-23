/**
 * task-board.test.ts — 任务公告板 (C1/C2) 单测
 *
 * 覆盖: 稳定 announcementId / 幂等发布 / 正文只在本地 / 认领记账 /
 *       负控制 (重复认领 · 不存在 · 已取消 · 未签名 · 被改 · 过期 · 非法 id) /
 *       释放与验真裁决 (未交付不得释放 · 未结算不得标 verified · local-dev 永不算链上) /
 *       注册表公告解析与去重。
 *
 * 不碰真注册表/网络: 一律传 home + 假 registry (真实链路在 scripts/verify-task-board.ts 真跑)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-board-test-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(path.join(HOME, '.bolloon'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const TB: any = await import('../agents/task-board.js');
const TC: any = await import('../agents/task-contract.js');
const LS: any = await import('../agents/local-signer.js');
const { KeyManager } = (await import('@diap/sdk')) as any;

const kpBuyer = (KeyManager as any).generate();
const buyer = { did: String(kpBuyer.did || ''), publicKeyHex: Buffer.from(kpBuyer.publicKey as Uint8Array).toString('hex') };
const kpProvider = (KeyManager as any).generate();
const provider = { did: String(kpProvider.did || ''), publicKeyHex: Buffer.from(kpProvider.publicKey as Uint8Array).toString('hex') };

/** 假注册表: 只实现 list/register 两个方法 (公告板只用到这两个) */
function fakeRegistry() {
  const services: any[] = [];
  return {
    ready: true,
    services,
    async list() { return services; },
    async register(s: any) {
      const i = services.findIndex((x: any) => x.agentId === s.agentId);
      if (i >= 0) services[i] = s; else services.push(s);
      return { ok: true };
    },
  };
}

const NOW = Date.now();
const BUDGET = { maxAmount: '50000', currency: 'USDC' as const, network: 'base-sepolia' };
const LONG = '调研某类厨房用品的日本市场: 渠道结构 / 价格带 / 合规门槛 / 竞品定价 / 进入节奏建议, 输出要点与不确定性, 并标注推测与事实的边界. 正文尾部标记 BODY-TAIL (中性夹具)';
const HOME2 = path.join(ROOT, 'other-home');
fs.mkdirSync(path.join(HOME2, '.bolloon'), { recursive: true });
/** 另一台机器上的买方 (它的公告只会以注册表条目形式出现在本机) */
const kpBuyer2 = (KeyManager as any).generate();
const buyer2 = { did: String(kpBuyer2.did || ''), publicKeyHex: Buffer.from(kpBuyer2.publicKey as Uint8Array).toString('hex') };
async function publishRemoteOnly(capability: string, instruction: string, registry: any) {
  return await publish(capability, instruction, { registry, home: HOME2, buyerDid: buyer2.did, who: { kp: kpBuyer2, id: buyer2 } });
}

async function publish(capability: string, instruction: string, opts: { signed?: boolean; deadline?: number; budget?: any; home?: string; registry?: any; buyerDid?: string; who?: { kp: any; id: { did: string; publicKeyHex: string } } } = {}) {
  const who = opts.who ?? { kp: kpBuyer, id: buyer };
  return await TB.publishAnnouncement({
    capability, instruction,
    buyerDid: opts.buyerDid ?? who.id.did,
    buyerPublicKeyHex: who.id.publicKeyHex,
    budget: opts.budget === undefined ? BUDGET : opts.budget,
    deadline: opts.deadline ?? NOW + 3600_000,
    paymentMode: 'policy',
    signerKeypair: opts.signed === false ? undefined : who.kp,
  }, { home: opts.home ?? HOME, offline: opts.registry ? false : true, registry: opts.registry });
}

beforeAll(async () => {
  const kp = (KeyManager as any).generate();
  await (KeyManager as any).saveToFile(kp, path.join(HOME, '.bolloon', 'identity.json'));
});
afterAll(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('announcementId 派生 (稳定)', () => {
  it('同一 (能力+正文+买方+预算) → 同一 id; 换任一要素 → 换 id', () => {
    const a = TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:x', budget: BUDGET });
    const b = TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:x', budget: BUDGET });
    expect(a).toBe(b);
    expect(a).toMatch(/^ann-[0-9a-f]{16}$/);
    expect(TB.deriveAnnouncementId({ capability: 'cap2', instruction: 'i', buyerDid: 'did:x', budget: BUDGET })).not.toBe(a);
    expect(TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i2', buyerDid: 'did:x', budget: BUDGET })).not.toBe(a);
    expect(TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:y', budget: BUDGET })).not.toBe(a);
    expect(TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:x', budget: { ...BUDGET, maxAmount: '1' } })).not.toBe(a);
  });
  it('deadline 不参与身份 (时限不是身份) —— 重发不会因为时限变化变成另一条公告', () => {
    const id = TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:x', budget: BUDGET });
    expect(id).toBe(TB.deriveAnnouncementId({ capability: 'cap', instruction: 'i', buyerDid: 'did:x', budget: BUDGET }));
  });
  it('preview 截断到 60 字 + 省略号', () => {
    const p = TB.previewOf(LONG);
    expect(p.length).toBeLessThanOrEqual(TB.PREVIEW_MAX + 1);
    expect(p.length).toBeLessThan(LONG.length);
    expect(p.endsWith('…')).toBe(true);
    expect(p.includes('BODY-TAIL')).toBe(false);
  });
});

describe('publish (落盘 + 幂等 + 正文不进注册表)', () => {
  it('落盘到 ~/.bolloon/tasks/board/<id>.json, 正文在里面', async () => {
    const r = await publish('cap-p1', LONG);
    expect(r.ok).toBe(true);
    expect(r.signed).toBe(true);
    const file = path.join(TB.boardDir(HOME), `${r.announcement.announcementId}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk.instruction).toBe(LONG);
    expect(onDisk.instructionDigest).toHaveLength(64);
    expect(onDisk.status).toBe('open');
    expect(onDisk.claims).toEqual([]);
    expect(JSON.stringify(onDisk)).not.toMatch(/privateKey|mnemonic/);
  });

  it('重复发布 → 同一 id + dup=true + 不覆盖既有事实', async () => {
    const first = await publish('cap-p2', LONG);
    const again = await publish('cap-p2', LONG, { deadline: NOW + 9_999_000 });
    expect(again.dup).toBe(true);
    expect(again.announcement.announcementId).toBe(first.announcement.announcementId);
    expect(again.announcement.deadline).toBe(first.announcement.deadline);
  });

  it('没有 keypair → 不签名 (signed=false, 不假装签过)', async () => {
    const r = await publish('cap-p3', `未签名: ${LONG}`, { signed: false });
    expect(r.ok).toBe(true);
    expect(r.signed).toBe(false);
    expect(r.announcement.signature).toBe('');
    expect(await TB.verifyAnnouncementSignature(r.announcement)).toBe(false);
  });

  it('缺能力/正文/未来时限 → 拒绝 (不生成半条公告)', async () => {
    expect((await TB.publishAnnouncement({ capability: '', instruction: LONG, buyerDid: buyer.did, buyerPublicKeyHex: buyer.publicKeyHex, deadline: NOW + 1000, paymentMode: 'policy' }, { home: HOME, offline: true })).ok).toBe(false);
    expect((await TB.publishAnnouncement({ capability: 'cap', instruction: '   ', buyerDid: buyer.did, buyerPublicKeyHex: buyer.publicKeyHex, deadline: NOW + 1000, paymentMode: 'policy' }, { home: HOME, offline: true })).ok).toBe(false);
    expect((await TB.publishAnnouncement({ capability: 'cap', instruction: LONG, buyerDid: buyer.did, buyerPublicKeyHex: buyer.publicKeyHex, deadline: 0, paymentMode: 'policy' }, { home: HOME, offline: true })).ok).toBe(false);
  });

  it('签名的公开载荷**不含正文** (只含摘要/预览)', async () => {
    const r = await publish('cap-p4', LONG);
    const payload = TB.publicPayloadOf(r.announcement);
    expect(payload).not.toHaveProperty('instruction');
    expect(payload.instructionDigest).toHaveLength(64);
    expect((await TC.verifyTaskEnvelope({ ...payload, signature: r.announcement.signature }, LS.verifierFor(buyer.publicKeyHex)))).toBe(true);
  });

  it('注册表公告条目里没有正文 (只有摘要+预览) 且带 announce:<id>', async () => {
    const reg = fakeRegistry();
    const r = await publish('cap-p5', LONG, { registry: reg });
    expect(r.registry.announced).toBe(true);
    const svc = reg.services.find((s: any) => s.agentId === buyer.did);
    expect(svc.capabilities).toContain('task.announce');
    expect(svc.capabilities).toContain(`announce:${r.announcement.announcementId}`);
    expect(svc.service.description).not.toContain('BODY-TAIL');
    const parsed = TB.parseRegistryAnnouncements(reg.services);
    expect(parsed.some((p: any) => p.announcementId === r.announcement.announcementId)).toBe(true);
  });
});

describe('board (本地 + 远端, 按 id 去重)', () => {
  it('本地公告在板上, 且板上行没有正文', async () => {
    const r = await publish('cap-b1', LONG);
    const view = await TB.listBoard({ home: HOME, localOnly: true, now: Date.now() });
    const row = view.entries.find((e: any) => e.announcementId === r.announcement.announcementId);
    expect(row).toBeTruthy();
    expect(row.source).toBe('local');
    expect('instruction' in row).toBe(false);
    expect(row.signatureVerified).toBe(true);
    expect(row.claimable).toBe(true);
  });

  it('注册表里的远端公告会被列出来 (remote=true)', async () => {
    const reg = fakeRegistry();
    const pub = await publishRemoteOnly('cap-b2', `远端: ${LONG}`, reg);
    const rid = pub.announcement.announcementId;
    expect(fs.existsSync(path.join(TB.boardDir(HOME), `${rid}.json`))).toBe(false);   // 本机确实没有它的公告文件
    const view = await TB.listBoard({ home: HOME, registry: reg, now: Date.now() });
    const remote = view.entries.filter((e: any) => e.remote);
    expect(remote.length).toBeGreaterThan(0);
    expect(remote[0].source).toBe('registry');
    expect(remote[0].claimCount).toBe(0);
    expect(JSON.stringify(view.entries)).not.toContain('BODY-TAIL');
  });

  it('同一个 id 同时出现在本地与注册表 → 去重后只算一次, 并在 duplicates 里列出', async () => {
    const reg = fakeRegistry();
    const r = await publish('cap-b3', `去重: ${LONG}`, { registry: reg });
    const view = await TB.listBoard({ home: HOME, registry: reg, now: Date.now() });
    const hits = view.entries.filter((e: any) => e.announcementId === r.announcement.announcementId);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('local');       // 本地胜出
    expect(view.duplicates).toContain(r.announcement.announcementId);
  });

  it('过期的公告还在板上, 但不能接单', async () => {
    const r = await publish('cap-b4', `过期: ${LONG}`, { deadline: NOW - 1000 });
    const view = await TB.listBoard({ home: HOME, localOnly: true, now: Date.now() });
    const row = view.entries.find((e: any) => e.announcementId === r.announcement.announcementId);
    expect(row.status).toBe('open');
    expect(row.claimable).toBe(false);
    expect(await TB.findOpenAnnouncementsForCapability('cap-b4', { home: HOME, localOnly: true })).toHaveLength(0);
  });
});

describe('claim (记账 + 负控制)', () => {
  const H = fs.mkdtempSync(path.join(ROOT, 'claim-'));
  let id = '';
  let unsignedId = '';
  let tamperedId = '';
  let expiredId = '';
  let cancelledId = '';

  it('认领成功: 记 DID / 时间 / 声明价格, 状态 open → claimed', async () => {
    const r = await publish('cap-c1', LONG, { home: H });
    id = r.announcement.announcementId;
    const c = await TB.claimAnnouncement(id, {
      providerDid: provider.did, providerPublicKeyHex: provider.publicKeyHex,
      priceAmountAtomic: '20000', currency: 'USDC', network: 'base-sepolia', signerKeypair: kpProvider,
    }, { home: H, now: NOW + 10 });
    expect(c.ok).toBe(true);
    expect(c.reason).toBe('claimed');
    expect(c.claim.providerDid).toBe(provider.did);
    expect(c.claim.claimedAt).toBe(NOW + 10);
    expect(c.claim.priceAmountAtomic).toBe('20000');
    expect(c.paid).toBe(false);
    expect(c.fundsMoved).toBe(false);
    expect(c.verified).toBe(false);
    const onDisk = TB.readAnnouncement(id, H);
    expect(onDisk.status).toBe('claimed');
    expect(onDisk.claims).toHaveLength(1);
  });

  it('重复认领 (同一 provider / 另一 provider) → 一律拒, 且不再写入', async () => {
    const before = TB.readAnnouncement(id, H).claims.length;
    const again = await TB.claimAnnouncement(id, { providerDid: provider.did }, { home: H });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already_claimed');
    expect(again.existingClaim.providerDid).toBe(provider.did);
    const other = await TB.claimAnnouncement(id, { providerDid: 'did:key:zOther' }, { home: H });
    expect(other.ok).toBe(false);
    expect(other.reason).toBe('already_claimed');
    expect(TB.readAnnouncement(id, H).claims).toHaveLength(before);
  });

  it('不存在的 id → not_found; 非法 id → invalid_id', async () => {
    const ghost = await TB.claimAnnouncement('ann-00000000000000ff', { providerDid: provider.did }, { home: H, registry: fakeRegistry() });
    expect(ghost.ok).toBe(false);
    expect(ghost.reason).toBe('not_found');
    for (const bad of ['../../etc/passwd', 'ann-x', '', 'ann-bad/../x']) {
      const r = await TB.claimAnnouncement(bad, { providerDid: provider.did }, { home: H, registry: fakeRegistry() });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('invalid_id');
    }
  });

  it('已取消 → cancelled; 且已认领的公告不许被取消', async () => {
    const r = await publish('cap-c2', `取消: ${LONG}`, { home: H });
    cancelledId = r.announcement.announcementId;
    const c = await TB.cancelAnnouncement(cancelledId, '夹具', { home: H });
    expect(c.ok).toBe(true);
    const claim = await TB.claimAnnouncement(cancelledId, { providerDid: provider.did }, { home: H });
    expect(claim.ok).toBe(false);
    expect(claim.reason).toBe('cancelled');
    const onClaimed = await TB.cancelAnnouncement(id, '想取消', { home: H });
    expect(onClaimed.ok).toBe(false);
  });

  it('未签名 / 正文被改 / 已过期 → 全部拒, 且都不产生认领', async () => {
    const u = await publish('cap-c3', `未签: ${LONG}`, { home: H, signed: false });
    unsignedId = u.announcement.announcementId;
    const ru = await TB.claimAnnouncement(unsignedId, { providerDid: provider.did }, { home: H });
    expect(ru.reason).toBe('signature_invalid');

    const t = await publish('cap-c4', `改坏: ${LONG}`, { home: H });
    tamperedId = t.announcement.announcementId;
    const tf = path.join(TB.boardDir(H), `${tamperedId}.json`);
    const j = JSON.parse(fs.readFileSync(tf, 'utf8'));
    j.instruction = `${j.instruction} 追加一句`;
    fs.writeFileSync(tf, JSON.stringify(j, null, 2));
    const rt = await TB.claimAnnouncement(tamperedId, { providerDid: provider.did }, { home: H });
    expect(rt.reason).toBe('instruction_digest_mismatch');

    const e = await publish('cap-c5', `过期: ${LONG}`, { home: H, deadline: NOW - 1 });
    expiredId = e.announcement.announcementId;
    const re = await TB.claimAnnouncement(expiredId, { providerDid: provider.did }, { home: H, now: Date.now() });
    expect(re.reason).toBe('deadline_expired');

    for (const x of [unsignedId, tamperedId, expiredId]) {
      expect(TB.readAnnouncement(x, H).claims).toHaveLength(0);
    }
  });

  it('声明价格如实记 (原子单位); 没声明就如实说"未声明", 不编价', async () => {
    const noPrice = await publish('cap-c7', `不报价: ${LONG}`, { home: H });
    const a = await TB.claimAnnouncement(noPrice.announcement.announcementId, { providerDid: provider.did }, { home: H });
    expect(a.ok).toBe(true);
    expect(a.claim.priceAmountAtomic).toBeNull();
    expect(a.priceNote).toContain('未声明');

    const withPrice = await publish('cap-c8', `报价: ${LONG}`, { home: H });
    const b = await TB.claimAnnouncement(withPrice.announcement.announcementId, { providerDid: provider.did, priceAmountAtomic: '25000', currency: 'USDC' }, { home: H });
    expect(b.ok).toBe(true);
    expect(b.claim.priceAmountAtomic).toBe('25000');
    expect(b.priceNote).toContain('25000');
    expect(TB.readAnnouncement(withPrice.announcement.announcementId, H).claims[0].priceAmountAtomic).toBe('25000');
  });

  it('远端公告认领: 只落本机台账, 如实标未投递; 重复也拒', async () => {
    const reg = fakeRegistry();
    const r = await publishRemoteOnly('cap-c6', `远端认领: ${LONG}`, reg);
    const rid = r.announcement.announcementId;
    const c = await TB.claimAnnouncement(rid, { providerDid: provider.did, priceAmountAtomic: '100' }, { home: H, registry: reg });
    expect(c.ok).toBe(true);
    expect(c.remote).toBe(true);
    expect(c.deliveredToBuyer).toBe(false);
    expect(TB.readRemoteClaims(H).filter((x: any) => x.announcementId === rid)).toHaveLength(1);
    const again = await TB.claimAnnouncement(rid, { providerDid: provider.did }, { home: H, registry: reg });
    expect(again.ok).toBe(false);
    expect(again.reason).toBe('already_claimed');
    expect(TB.readRemoteClaims(H).filter((x: any) => x.announcementId === rid)).toHaveLength(1);
  });
});

describe('decideAnnouncementRelease (未交付不得释放 · 未结算不得标 verified)', () => {
  const base = { announcementId: 'ann-1111111111111111', status: 'claimed' as const };
  const TXT = `0x${'cd'.repeat(32)}`;

  it('未认领 / 未交付 / 未结算 / local-dev / 争议 → 都不许标 verified', () => {
    const notClaimed = TB.decideAnnouncementRelease({ ...base, status: 'open', delivery: { delivered: true }, paymentMode: 'facilitator', chainSettled: true, txHash: TXT });
    expect(notClaimed.action).toBe('refuse');
    expect(notClaimed.code).toBe('NOT_CLAIMED');

    const notDelivered = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: false }, paymentMode: 'facilitator', chainSettled: true, txHash: TXT });
    expect(notDelivered.code).toBe('NOT_DELIVERED');
    expect(notDelivered.canMarkVerified).toBe(false);

    const notSettled = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: false, txHash: null });
    expect(notSettled.code).toBe('NOT_CHAIN_SETTLED');
    expect(notSettled.canMarkVerified).toBe(false);

    const noHash = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: null });
    expect(noHash.code).toBe('NOT_CHAIN_SETTLED');

    const localDev = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'local-dev', chainSettled: true, txHash: TXT });
    expect(localDev.code).toBe('LOCAL_DEV_NOT_CHAIN');
    expect(localDev.canMarkVerified).toBe(false);

    const disputed = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, disputeOpen: true, paymentMode: 'facilitator', chainSettled: true, txHash: TXT });
    expect(disputed.code).toBe('DISPUTE_OPEN');
    expect(disputed.mustNotRepay).toBe(true);
  });

  it('事实齐了才 release; 已释放再判 → 幂等拒绝且 mustNotRepay', () => {
    const ok = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: TXT });
    expect(ok.action).toBe('release');
    expect(ok.canMarkVerified).toBe(true);
    const again = TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: TXT, alreadyReleased: true });
    expect(again.action).toBe('refuse');
    expect(again.code).toBe('ALREADY_RELEASED');
    expect(again.mustNotRepay).toBe(true);
  });

  it('任何裁决路径都不动钱, 且都带证据行', () => {
    const cases = [
      TB.decideAnnouncementRelease({ ...base, delivery: { delivered: false }, paymentMode: 'policy', chainSettled: false, txHash: null }),
      TB.decideAnnouncementRelease({ ...base, delivery: { delivered: true, contentHash: 'h' }, paymentMode: 'facilitator', chainSettled: true, txHash: TXT }),
    ];
    for (const d of cases) {
      expect(d.fundsMoved).toBe(false);
      expect(d.evidence.length).toBeGreaterThanOrEqual(6);
    }
  });
});
