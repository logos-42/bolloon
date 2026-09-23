/**
 * task-group-bridge.test.ts — 2026-09-23
 *
 * C7 群聊通道桥接的**纯函数**单元测试 (不起 OrbitDB; 端到端真群走
 * `npx tsx scripts/verify-task-group-bridge.ts`):
 *   - 隐私守卫 PRIVACY_RULES / scanPublicText / requirePublicText (含"粘在 _/汉字后面"的回归锁)
 *   - 发送者标记 senderTag / maskSender (原 DID 永不外露)
 *   - 消息构造 buildAnnounceMessage / buildPostMessage + 交付哈希闸 normalizeContentHash
 *   - 过程痕迹解析/汇总 parseTrailLine / summarizeTrail (未交付不得出现"已交付")
 *
 * 这些断言只加不减: 出现"某种形态不该进群"的新认识时, 往上加用例, 不改弱已有用例。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  PRIVACY_RULES, TRAIL_TAG, TRAIL_VERSION, scanPublicText, requirePublicText,
  senderTag, maskSender, parseTrailLine, summarizeTrail, redactFields,
  normalizeContentHash, parseChecks, buildAnnounceMessage, buildPostMessage, isAnnouncementId,
  readBoardAnnouncement, boardDirOf,
} from '../agents/task-group';

const AID = 'ann-0123456789abcdef';
const WALLET = `0x${'11'.repeat(20)}`;
const KEY = `0x${'ab'.repeat(32)}`;
const DID = 'did:diap:fixture000000000000000000000000000000';

describe('隐私守卫: 群消息里不许出现的形态', () => {
  it('每条规则自己都能命中一个正样本 (规则不是摆设)', () => {
    const samples: Record<string, string> = {
      'wallet-address': `to=${WALLET}`,
      'private-key-hex': `k=${KEY}`,
      'hex-0x-blob': 'sig=0xdeadbeefcafe1234',
      did: `who=${DID}`,
      'peer-id': 'peer=12D3KooWFixturePeerId000000000000000000000000',
      multiaddr: 'addr=/ip4/127.0.0.1/tcp/4001',
      'orbitdb-link': 'g=orbitdb:///orbitdb/zdpuXx?type=group&name=x',
      ipv4: 'at=192.168.1.10',
      ipv6: 'net=2001:db8:0:0:0:0:0:1',
      pem: 'x=-----BEGIN PRIVATE KEY-----',
      'secret-words': 'payload=私钥材料',
      url: 'ref=https://example.invalid/spec',
      email: 'contact=buyer@example.invalid',
    };
    for (const r of PRIVACY_RULES) {
      expect(samples[r.rule], `规则 ${r.rule} 缺正样本`).toBeTruthy();
      expect(scanPublicText(samples[r.rule]).map((v) => v.rule), `规则 ${r.rule} 没命中`).toContain(r.rule);
    }
    expect(Object.keys(samples).sort()).toEqual(PRIVACY_RULES.map((r) => r.rule).sort());
  });

  it('回归锁: 标识符粘在 `_` 或汉字后面也必须命中 (2026-09-23 真实漏过: `\\b` 在 `_` 旁边判不出来)', () => {
    const glued: Array<[string, string]> = [
      ['wallet-address', `judge=判据见_${WALLET}`],
      ['wallet-address', `judge=判据见${WALLET}`],
      ['private-key-hex', `k_${KEY}`],
      ['hex-0x-blob', 'sig_0xdeadbeefcafe1234'],
      ['did', 'who_did:diap:fixture000000000000000000000000000000'],
      ['peer-id', 'peer_12D3KooWFixturePeerId000000000000000000000000'],
      ['multiaddr', 'addr_/ip4/127.0.0.1/tcp/4001'],
      ['ipv4', 'at_192.168.1.10'],
      ['ipv6', 'net_2001:db8:0:0:0:0:0:1'],
      ['ipv6', 'net_fe80::1'],
      ['ipv6', 'net_::1'],
      ['url', 'ref_https://example.invalid/x'],
    ];
    for (const [rule, text] of glued) {
      expect(scanPublicText(text).map((v) => v.rule), `粘住的 ${rule} 没命中: ${text}`).toContain(rule);
    }
  });

  it('回归锁: 黏连形态**过不了闸** (requirePublicText 拒绝并报出规则名)', () => {
    for (const [rule, text] of [
      ['wallet-address', `judge=判据见_${WALLET}`],
      ['did', 'who_did:diap:fixture000000000000000000000000000000'],
      ['multiaddr', 'addr_/ip4/127.0.0.1/tcp/4001'],
    ] as Array<[string, string]>) {
      const r = requirePublicText(`${TRAIL_TAG} v=${TRAIL_VERSION} kind=announce ${text}`);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.violations.some((v) => v.rule === rule)).toBe(true);
    }
  });

  it('误拦控制: 本模块自己的正常消息与中性事实必须过闸', () => {
    const ok = [
      `${TRAIL_TAG} v=${TRAIL_VERSION} kind=announce id=${AID} cap=market-research-jp budget=50000USDC@base-sepolia deadline=2026-09-24T09:50:12.345Z round=1 judge=unstated;sha256=abcdef0123456789`,
      `${TRAIL_TAG} kind=claim id=${AID} price=20000USDC`,
      `${TRAIL_TAG} kind=deliver id=${AID} hash=sha256:${'cd'.repeat(32)} bytes=5120`,
      `${TRAIL_TAG} kind=screen id=${AID} checks=渠道结构:pass,价格带:fail screened=2 pass=1 fail=1`,
      `${TRAIL_TAG} kind=announce id=${AID} judge=渠道结构/价格带/合规门槛 三条判据可判决`,
      '调研某类厨房用品的日本市场 (中性夹具)',
    ];
    for (const t of ok) expect(scanPublicText(t), `误杀: ${t}`).toEqual([]);
  });

  it('命中时不把完整标识符回显 (只给前 4 位 + 长度)', () => {
    const v = scanPublicText(`to=${WALLET}`);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].masked).not.toContain(WALLET);
    expect(v[0].masked.length).toBeLessThanOrEqual(5);
    expect(v[0].chars).toBe(WALLET.length);
  });
});

describe('发送者标记: 原 DID 永不进群', () => {
  it('senderTag 是稳定假名 agent-<8位>, 不含 DID 片段', () => {
    const t = senderTag(DID);
    expect(t).toMatch(/^agent-[0-9a-f]{8}$/);
    expect(senderTag(DID)).toBe(t);           // 稳定: 同一个人每次同一个标记
    expect(senderTag(`${DID}x`)).not.toBe(t); // 不同人不同标记
    expect(t).not.toContain('diap');
  });
  it('maskSender: 短显示名原样, 标识符形态一律打码', () => {
    expect(maskSender('委托方')).toBe('委托方');
    expect(maskSender('agent-1a2b3c4d')).toBe('agent-1a2b3c4d');
    expect(maskSender(DID)).toMatch(/^#[0-9a-f]{8}$/);
    expect(maskSender(WALLET)).toMatch(/^#[0-9a-f]{8}$/);
    expect(maskSender('')).toBe('unknown');
  });
});

describe('过程痕迹消息: 构造与解析', () => {
  it('公告消息只有极短事实 (期号/capability/预算/判据/公告 id), 正文不进群', () => {
    const text = buildAnnounceMessage(
      { announcementId: AID, capability: 'market-research-jp', budget: { maxAmount: '50000', currency: 'USDC', network: 'base-sepolia' }, deadline: 1790000000000, instructionDigest: 'abcdef0123456789aa' } as never,
      { round: '1', criteria: '渠道结构/价格带/合规门槛' },
    );
    expect(text).toContain(`id=${AID}`);
    expect(text).toContain('cap=market-research-jp');
    expect(text).toContain('budget=50000USDC@base-sepolia');
    expect(text).toContain('round=1');
    expect(text).toContain('judge=渠道结构/价格带/合规门槛');
    expect(text.split(' ').length).toBeLessThanOrEqual(9);
    expect(scanPublicText(text)).toEqual([]);
    // 没给判据 → 如实写 unstated + 任务书摘要, 不替它编判据
    const t2 = buildAnnounceMessage(
      { announcementId: AID, capability: 'c', budget: null, deadline: null, instructionDigest: 'abcdef0123456789aa' } as never, {},
    );
    expect(t2).toContain('judge=unstated;sha256=abcdef0123456789');
    expect(t2).toContain('budget=-');
  });

  it('parseTrailLine 只认本协议行; 字段按第一个 = 切 (值里可以带 =)', () => {
    const p = parseTrailLine(`${TRAIL_TAG} v=${TRAIL_VERSION} kind=deliver id=${AID} hash=sha256:${'cd'.repeat(32)}`);
    expect(p?.kind).toBe('deliver');
    expect(p?.fields.hash).toBe(`sha256:${'cd'.repeat(32)}`);
    expect(p?.fields.id).toBe(AID);
    expect(parseTrailLine('今天天气不错')).toBeNull();
    expect(parseTrailLine(`${TRAIL_TAG} kind=not-a-kind id=${AID}`)).toBeNull();
    // 缺 id 的行仍被认出来 (别人的变体也要能不炸), 但挂不到公告上 → summarize 里 announcementId 为 null
    const noId = parseTrailLine(`${TRAIL_TAG} kind=deliver hash=sha256:${'cd'.repeat(32)}`);
    expect(noId?.kind).toBe('deliver');
    const s = summarizeTrail([{ from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=deliver hash=sha256:${'cd'.repeat(32)}`, ts: 1 }] as never);
    expect(s.entries[0].announcementId).toBeNull();
    expect(s.announcements).toEqual([]);
  });

  it('summarizeTrail: 跨消息聚合 + 时间升序 + flags 如实', () => {
    const base = 1_700_000_000_000;
    const msgs = [
      { from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=announce id=${AID} cap=c`, ts: base },
      { from: 'agent-1a2b3c4d', text: '闲聊一句 (不进时间线)', ts: base + 1 },
      { from: 'agent-2b3c4d5e', text: `${TRAIL_TAG} kind=claim id=${AID} price=20000USDC`, ts: base + 2 },
      { from: 'agent-2b3c4d5e', text: `${TRAIL_TAG} kind=deliver id=${AID} hash=sha256:${'cd'.repeat(32)}`, ts: base + 3 },
      { from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=screen id=${AID} checks=渠道结构:pass screened=1 pass=1 fail=0`, ts: base + 4 },
      { from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=final id=${AID} verdict=accept`, ts: base + 5 },
    ];
    const s = summarizeTrail(msgs);
    expect(s.count).toBe(5);
    expect(s.byKind).toEqual({ announce: 1, claim: 1, deliver: 1, screen: 1, final: 1 });
    expect(s.entries.map((e) => e.at)).toEqual([base, base + 2, base + 3, base + 4, base + 5]);
    expect(s.ignoredMessages).toBe(1);
    expect(s.flags).toMatchObject({ announced: true, claimed: true, delivered: true, screened: true, finalized: true, accepted: true, rejected: false });
    expect(s.inconsistencies).toEqual([]);
    expect(s.announcements).toEqual([AID]);
    // 过滤: 只留指定公告
    expect(summarizeTrail(msgs, { announcementId: 'ann-ffffffffffffffff' }).count).toBe(0);
  });

  it('未交付的公告: 不凭空出现"已交付"条目, 且显式标矛盾', () => {
    const base = 1_700_000_000_000;
    const s = summarizeTrail([
      { from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=announce id=${AID} cap=c`, ts: base },
      { from: 'agent-1a2b3c4d', text: `${TRAIL_TAG} kind=final id=${AID} verdict=accept`, ts: base + 1 },
    ]);
    expect(s.byKind.deliver).toBe(0);
    expect(s.flags.delivered).toBe(false);
    expect(s.inconsistencies).toContain('final-accept-without-delivery');
  });

  it('读回侧遮蔽: 别人消息里的标识符字段被遮蔽 + 记账, 时间线不携带原文', () => {
    const s = summarizeTrail([
      { from: DID, text: `${TRAIL_TAG} kind=deliver id=${DID} hash=${WALLET}`, ts: 1 },
    ]);
    expect(s.count).toBe(1);
    expect(s.entries[0].sender).toMatch(/^#[0-9a-f]{8}$/);
    expect(s.entries[0].announcementId).toBeNull();          // 遮蔽过的 id 不当引用
    expect(JSON.stringify(s.entries[0].fields)).not.toContain(WALLET);
    expect(s.entries[0].fields.hash).toContain('[已遮蔽:');
    expect(s.redacted.length).toBeGreaterThan(0);
    expect(s.inconsistencies).toContain('group-message-hit-privacy-rule');
    expect(s.announcements).toEqual([]);
  });

  it('redactFields: 命中即遮蔽, 中性字段原样 (只加不减)', () => {
    const r = redactFields('claim', { price: '20000USDC', who: DID });
    expect(r.fields.price).toBe('20000USDC');
    expect(r.fields.who).toBe('[已遮蔽:did]');
    expect(r.redacted).toEqual(['did@claim']);
  });

  it('junk 群消息不炸 (null/空/数字条目只计入 ignoredMessages)', () => {
    const s = summarizeTrail([null, undefined, 1, { from: '', text: '', ts: 0 }, { from: 'a', text: '闲聊', ts: 1 }] as never);
    expect(s.count).toBe(0);
    expect(s.ignoredMessages).toBe(5);
    expect(s.entries).toEqual([]);
  });
});

describe('交付哈希闸: 只收内容哈希形状', () => {
  it('放行: sha256 前缀 / 裸 hex (标 hex:) / CIDv1', () => {
    expect(normalizeContentHash(`sha256:${'cd'.repeat(32)}`)).toMatchObject({ ok: true, token: `sha256:${'cd'.repeat(32)}` });
    expect(normalizeContentHash('ef'.repeat(32))).toMatchObject({ ok: true, token: `hex:${'ef'.repeat(32)}` });
    expect(normalizeContentHash('bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi')).toMatchObject({ ok: true, token: 'cid:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi' });
  });
  it('拒绝: 钱包地址 / 0x 私钥 / CIDv0(与 peerId 同形) / 短 hex / 文本 (都不假装是哈希)', () => {
    for (const bad of [WALLET, KEY, 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG', 'abcd', '交付报告', '']) {
      const r = normalizeContentHash(bad);
      expect(r.ok, `不该放行: ${bad}`).toBe(false);
      expect(r.ok === false && r.error.length).toBeGreaterThan(0);
    }
  });
  it('isAnnouncementId: 只认 ann- 开头的安全 id (与 task-board safeId 同形, 防目录穿越)', () => {
    expect(isAnnouncementId(AID)).toBe(true);
    expect(isAnnouncementId('ann-0123456789ABCDEF')).toBe(true);   // 大小写都收
    expect(isAnnouncementId('ann-../etc/passwd')).toBe(false);     // 带 / 直接拒
    expect(isAnnouncementId('did:diap:x')).toBe(false);
    expect(isAnnouncementId(DID)).toBe(false);
    expect(isAnnouncementId('ann-a')).toBe(false);
    expect(isAnnouncementId('')).toBe(false);
  });
});

describe('初筛逐条结果: 解析与诚实计数', () => {
  it('= 与 : 两种写法都认, 计数是数出来的', () => {
    const r = parseChecks('渠道结构=pass,价格带=fail,合规门槛=unknown');
    expect(r.ok).toBe(true);
    const c = r.ok ? r.checks : [];
    expect(c.map((x) => `${x.name}:${x.result}`)).toEqual(['渠道结构:pass', '价格带:fail', '合规门槛:unknown']);
    expect(c.filter((x) => x.result === 'pass').length).toBe(1);
  });
  it('结果必须在词表里 (不替你翻译成 pass)', () => {
    for (const bad of ['渠道结构=yes', '渠道结构', '=pass', '渠道结构=pass,价格带=maybe']) {
      const r = parseChecks(bad);
      expect(r.ok, `不该通过: ${bad}`).toBe(false);
    }
    // 空段被丢掉 (不进逐条列表, 也不假装有一条)
    const r2 = parseChecks('渠道结构=pass,,价格带=fail');
    expect(r2.ok).toBe(true);
    expect(r2.ok && r2.checks.length).toBe(2);
  });
  it('缺 --checks 时 buildPostMessage 拒绝 (不假装有逐条结果)', () => {
    const r = buildPostMessage({ kind: 'screen', announcementId: AID, checksRaw: null });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('INVALID_ARGUMENT');
  });
  it('终审结论必须在词表里', () => {
    expect(buildPostMessage({ kind: 'final', announcementId: AID, verdict: 'accept' }).ok).toBe(true);
    expect(buildPostMessage({ kind: 'final', announcementId: AID, verdict: 'unknown' }).ok).toBe(true);
    expect(buildPostMessage({ kind: 'final', announcementId: AID, verdict: 'looks-good' }).ok).toBe(false);
    expect(buildPostMessage({ kind: 'final', announcementId: AID, verdict: null }).ok).toBe(false);
  });
  it('过程痕迹消息一律带公告 id (挂不上公告的事实不进群)', () => {
    for (const kind of ['claim', 'deliver', 'screen', 'final'] as const) {
      const r = buildPostMessage({ kind, announcementId: null, hash: `sha256:${'cd'.repeat(32)}`, checksRaw: 'a=pass', verdict: 'accept' });
      expect(r.ok, `${kind} 缺 id 不该通过`).toBe(false);
    }
  });

  it('缺字段不许变成假事实: 没给 --bytes → `bytes=-`, **不许**写 0 (0 = 谎报零字节交付)', () => {
    const noBytes = buildPostMessage({ kind: 'deliver', announcementId: AID, hash: `sha256:${'cd'.repeat(32)}`, bytes: null });
    expect(noBytes.ok).toBe(true);
    expect(noBytes.ok && noBytes.text).toContain('bytes=-');
    expect(noBytes.ok && noBytes.text).not.toContain('bytes=0');
    const zero = buildPostMessage({ kind: 'deliver', announcementId: AID, hash: `sha256:${'cd'.repeat(32)}`, bytes: 0 });
    expect(zero.ok && zero.text).toContain('bytes=0');   // 真给了 0 才写 0
    const n = buildPostMessage({ kind: 'deliver', announcementId: AID, hash: `sha256:${'cd'.repeat(32)}`, bytes: 5120 });
    expect(n.ok && n.text).toContain('bytes=5120');
  });

  it('公告缺 deadline/createdAt 时如实为 null (不变成 0 = 1970 年)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-c7-facts-'));
    const dir = boardDirOf(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${AID}.json`), JSON.stringify({
      announcementId: AID, capability: 'c', status: 'open', budget: null,
      deadline: null, createdAt: undefined, instructionDigest: 'abcdef0123456789aa',
    }));
    const facts = readBoardAnnouncement(AID, home);
    expect(facts?.deadline).toBeNull();
    expect(facts?.createdAt).toBeNull();
    expect(facts?.budget).toBeNull();
    // 公告消息里 deadline 未声明 → `deadline=-`, 不写 1970 时间
    const text = buildAnnounceMessage(facts as never, {});
    expect(text).toContain('deadline=-');
    expect(text).not.toContain('1970-');
    // 不存在的公告 → null (不猜、不编)
    expect(readBoardAnnouncement('ann-ffffffffffffffff', home)).toBeNull();
    expect(readBoardAnnouncement('did:diap:x', home)).toBeNull();
    fs.rmSync(home, { recursive: true, force: true });
  });
});
