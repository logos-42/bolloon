/**
 * mobile-task-actions.test.ts — 手机高风险任务动作的**授权载荷与验签** (2026-09-25)
 *
 * 要证的四件事:
 *   ① 规则表**单一来源**: 桌面 `task-group.ts` 与手机引用的隐私规则是**同一个函数对象** (不是抄了一份);
 *   ② 载荷**逐字节稳定**且对每个签名字段敏感 (改一个字 → 摘要变);
 *   ③ 桌面验签对**换类型 / 换内容 / 换设备 / 过期 / 篡改签名** 一律拒, 且理由可读;
 *   ④ 类型与请求字段的对应关系 (入群的签名不能被塞进发公告的字段里)。
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  MOBILE_TASK_ACTION_KINDS, TASK_ACTION_SIGNED_FIELDS, TASK_ACTION_TTL_MS,
  canonicalTaskActionPayload, taskActionContentText, checkTaskActionShape, checkTaskActionFreshness,
  actionKindAllowsRequest, isTaskActionId,
  type SignableTaskAction, type TaskActionRequest, type TaskActionSignature,
} from '../agents/mobile-task-actions.js';
import { verifyTaskAction, contentDigestOf, payloadHashOf } from '../agents/mobile-task-actions-verify.js';
import { generateDeviceKeyPair, type DeviceKey } from '../agents/contacts/grants.js';
import {
  scanPublicText as desktopScan, requirePublicText as desktopRequire,
  PRIVACY_RULES as desktopRules, NODE_IDENTITY_RULES as desktopNodeRules,
  scanNodeIdentity as desktopScanNode, mask as desktopMask,
  TRAIL_KIND_LABEL,
} from '../agents/task-group.js';
import {
  scanPublicText as sharedScan, requirePublicText as sharedRequire,
  PRIVACY_RULES as sharedRules, NODE_IDENTITY_RULES as sharedNodeRules,
  scanNodeIdentity as sharedScanNode, mask as sharedMask,
} from '../agents/task-public-text.js';
import { TRAIL_KIND_LABELS, INCONSISTENCY_LABELS } from '../agents/mobile-task-views.js';

function mkReq(kind: any, patch: Partial<TaskActionRequest> = {}): TaskActionRequest {
  return {
    kind, groupRef: null, announcementId: null, capability: null, instruction: null,
    budgetHuman: null, currency: null, deadline: null, criteria: null, round: null, price: null,
    hash: null, bytes: null, checks: null, verdict: null, trailKind: null,
    ...patch,
  } as TaskActionRequest;
}

const NOW = 1_800_000_000_000;

function mkAction(req: TaskActionRequest, patch: Partial<SignableTaskAction> = {}): SignableTaskAction {
  return {
    actionId: 'act-test-0001', kind: req.kind, deviceId: 'dev-abc123', ownerDid: 'did:bolln:local',
    targetRef: String(req.groupRef || req.announcementId || ''),
    contentDigest: contentDigestOf(req),
    createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    grantedBy: 'leo', via: 'mobile',
    ...patch,
  };
}

/** 桌面侧(等价)签名: 用真 ed25519 私钥签规范载荷 */
function signWithNodeKey(action: SignableTaskAction, privateKeyPem: string): TaskActionSignature {
  const payload = canonicalTaskActionPayload(action);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  return { deviceId: action.deviceId, alg: 'ed25519', payloadHash: payloadHashOf(action), sig };
}

function dev(pair: { deviceId: string; publicKeyPem: string }): DeviceKey {
  return { deviceId: pair.deviceId, publicKeyPem: pair.publicKeyPem, registeredAt: new Date(NOW).toISOString() };
}

describe('① 隐私规则单一来源 (桌面 task-group ≡ 手机 task-public-text)', () => {
  it('是同一个函数对象 (不是抄了一份)', () => {
    expect(desktopScan).toBe(sharedScan);
    expect(desktopRequire).toBe(sharedRequire);
    expect(desktopScanNode).toBe(sharedScanNode);
    expect(desktopMask).toBe(sharedMask);
    expect(desktopRules).toBe(sharedRules);
    expect(desktopNodeRules).toBe(sharedNodeRules);
  });

  it('规则表数量与既有口径一致 (13 条群消息红线 / 12 条节点身份线)', () => {
    expect(sharedRules.length).toBe(13);
    expect(sharedNodeRules.length).toBe(12);
  });

  it('红线仍然真的拦得住 (手机与桌面同一判据)', () => {
    expect(sharedScan('见 0x1111111111111111111111111111111111111111').map((v) => v.rule)).toContain('wallet-address');
    expect(sharedScan('did:key:z6Mkabcdefgh').map((v) => v.rule)).toContain('did');
    expect(sharedScan('走 /ip4/1.2.3.4/tcp/4001').length).toBeGreaterThan(0);
    expect(sharedRequire('干净的一行 kind=claim id=ann-abc').ok).toBe(true);
    // 群链接是群自己的公开标识 → 群消息里仍禁 (orbitdb-link 规则在群消息档里生效)
    expect(sharedScan('orbitdb:///orbitdb/fake-x?type=group&name=a').map((v) => v.rule)).toContain('orbitdb-link');
  });
});

describe('② 动作载荷: 稳定 + 对每个签名字段敏感', () => {
  it('形状固定的字段清单 (10 个)', () => {
    expect([...TASK_ACTION_SIGNED_FIELDS]).toEqual([
      'actionId', 'kind', 'deviceId', 'ownerDid', 'targetRef', 'contentDigest',
      'createdAt', 'expiresAt', 'grantedBy', 'via',
    ]);
  });

  it('同一个动作 → 同一字节串 (顺序稳定)', () => {
    const a = mkAction(mkReq('group_join', { groupRef: 'orbitdb:///orbitdb/fake-x?type=group&name=g' }));
    expect(canonicalTaskActionPayload(a)).toBe(canonicalTaskActionPayload({ ...a }));
  });

  it('改任何一个签名字段都会改字节串', () => {
    const base = mkAction(mkReq('group_leave', { groupRef: 'gid-1' }));
    const variants: Array<Partial<SignableTaskAction>> = [
      { actionId: 'act-other-0002' }, { kind: 'group_join' }, { deviceId: 'dev-zzz' },
      { ownerDid: 'did:other' }, { targetRef: 'gid-2' }, { contentDigest: 'f'.repeat(64) },
      { createdAt: new Date(NOW + 1).toISOString() }, { expiresAt: new Date(NOW + 6 * 60_000).toISOString() },
      { grantedBy: 'someone' }, { via: 'mobile' },
    ];
    for (const v of variants) {
      const changed = canonicalTaskActionPayload({ ...base, ...v });
      if (Object.keys(v)[0] === 'via') continue; // via 固定 mobile (形状闸只认这一个值)
      expect(changed).not.toBe(canonicalTaskActionPayload(base));
    }
  });

  it('内容文本按类型选取字段 (入群只看群, 发公告看能力+预算+正文, 留痕看痕迹字段)', () => {
    const join = taskActionContentText(mkReq('group_join', { groupRef: 'g1', capability: '不该出现的能力' }));
    expect(join).toContain('group=g1');
    expect(join).not.toContain('cap=');
    expect(join).not.toContain('不该出现的能力');

    const pub = taskActionContentText(mkReq('announce_publish', { capability: 'research', instruction: '调研', budgetHuman: '0.05', currency: 'USDC' }));
    expect(pub).toContain('cap=research');
    expect(pub).toContain('budget=0.05@USDC');
    expect(pub).toContain('instruction=调研');

    const post = taskActionContentText(mkReq('trail_post', { groupRef: 'g1', announcementId: 'ann-1', trailKind: 'screen', checks: '渠道结构=pass' }));
    expect(post).toContain('trail=screen');
    expect(post).toContain('checks=渠道结构=pass');
  });

  it('换行被折叠成字面 \\n (一行一字段, 摘要不会被换行切开)', () => {
    const t = taskActionContentText(mkReq('announce_publish', { instruction: '第一行\n第二行' }));
    expect(t).toContain('instruction=第一行\\n第二行');
    expect(t.split('\n').filter((l) => l.startsWith('instruction='))).toHaveLength(1);
  });

  it('内容一变, 摘要就变 (同一组字段顺序不同也算变)', () => {
    const a = contentDigestOf(mkReq('group_join', { groupRef: 'g1' }));
    const b = contentDigestOf(mkReq('group_join', { groupRef: 'g2' }));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('动作 id 形状闸', () => {
    expect(isTaskActionId('act-abc123')).toBe(true);
    expect(isTaskActionId('abc')).toBe(false);
    expect(isTaskActionId('act-')).toBe(false);
  });
});

describe('③ 形状 / 时效 / 类型-字段对应', () => {
  const okReq = mkReq('group_join', { groupRef: 'g1' });

  it('形状闸会逐项拒', () => {
    expect(checkTaskActionShape({ action: mkAction(okReq), signature: {} }).ok).toBe(true);
    expect(checkTaskActionShape({ action: mkAction(okReq, { actionId: 'x' }) })).toEqual({ ok: false, reason: 'bad_action_id' });
    expect(checkTaskActionShape({ action: mkAction(okReq, { kind: 'nope' as any }) })).toEqual({ ok: false, reason: 'unknown_kind' });
    expect(checkTaskActionShape({ action: mkAction(okReq, { deviceId: 'x' }) })).toEqual({ ok: false, reason: 'bad_device_id' });
    expect(checkTaskActionShape({ action: mkAction(okReq, { contentDigest: 'zz' }) })).toEqual({ ok: false, reason: 'bad_content_digest' });
    expect(checkTaskActionShape({ action: mkAction(okReq, { via: 'desktop' as any }) })).toEqual({ ok: false, reason: 'bad_via' });
    expect(checkTaskActionShape({ action: mkAction(okReq, { expiresAt: 'nope' }) })).toEqual({ ok: false, reason: 'bad_time' });
    expect(checkTaskActionShape({}).ok).toBe(false);
  });

  it('时效: 过期 / 超长假 / 未来时间 都拒, 正常窗口放行', () => {
    expect(checkTaskActionFreshness(mkAction(okReq), NOW).ok).toBe(true);
    // 窗口整体在过去 (created/expires 都早于 now) → expired
    expect(checkTaskActionFreshness(mkAction(okReq, {
      createdAt: new Date(NOW - 10 * 60_000).toISOString(), expiresAt: new Date(NOW - 5 * 60_000).toISOString(),
    }), NOW)).toEqual({ ok: false, reason: 'expired' });
    expect(checkTaskActionFreshness(mkAction(okReq, { expiresAt: new Date(NOW + TASK_ACTION_TTL_MS + 1).toISOString() }), NOW))
      .toEqual({ ok: false, reason: 'ttl_too_long' });
    expect(checkTaskActionFreshness(mkAction(okReq, { createdAt: new Date(NOW + 5 * 60_000).toISOString(), expiresAt: new Date(NOW + 9 * 60_000).toISOString() }), NOW))
      .toEqual({ ok: false, reason: 'not_yet_valid' });
  });

  it('类型与请求字段必须自洽 (入群签名塞不进发公告的字段)', () => {
    expect(actionKindAllowsRequest('group_join', mkReq('group_join', { groupRef: 'g' })).ok).toBe(true);
    expect(actionKindAllowsRequest('group_join', mkReq('group_join')).ok).toBe(false);
    // 发公告**不进群**: 带群就是拒 (这类动作必须分开签)
    expect(actionKindAllowsRequest('announce_publish', mkReq('announce_publish', { groupRef: 'g', capability: 'c', instruction: 'i' })).ok).toBe(false);
    expect(actionKindAllowsRequest('announce_publish', mkReq('announce_publish', { capability: 'c', instruction: 'i' })).ok).toBe(true);
    expect(actionKindAllowsRequest('announce_to_group', mkReq('announce_to_group', { groupRef: 'g' })).ok).toBe(false);
    expect(actionKindAllowsRequest('trail_post', mkReq('trail_post', { groupRef: 'g', announcementId: 'ann-1' })).ok).toBe(false);
    expect(actionKindAllowsRequest('trail_post', mkReq('trail_post', { groupRef: 'g', announcementId: 'ann-1', trailKind: 'claim' })).ok).toBe(true);
    expect(actionKindAllowsRequest('trail_post', mkReq('trail_post', { groupRef: 'g', announcementId: 'ann-1', trailKind: '乱填' as any })).ok).toBe(false);
    expect(actionKindAllowsRequest('group_create', mkReq('group_create')).ok).toBe(true);
  });

  it('动作类型是闭集 (6 项), 少一项要有人知道', () => {
    expect([...MOBILE_TASK_ACTION_KINDS]).toEqual([
      'group_join', 'group_leave', 'group_create', 'announce_publish', 'announce_to_group', 'trail_post',
    ]);
    expect(TASK_ACTION_TTL_MS).toBe(10 * 60_000);
  });
});

describe('④ 桌面验签: 放行真签名, 拒一切篡改', () => {
  const pair = generateDeviceKeyPair();
  const dkey = dev(pair);
  const req = mkReq('announce_to_group', { groupRef: 'gid-1', announcementId: 'ann-abcdef123456' });

  function signedOk() {
    const action = mkAction(req, { deviceId: pair.deviceId });
    return { action, signature: signWithNodeKey(action, pair.privateKeyPem) };
  }

  it('真签名 + 内容对得上 → 放行', () => {
    const r = verifyTaskAction(signedOk(), dkey, { req, now: NOW });
    expect(r.ok).toBe(true);
    expect(r.action?.kind).toBe('announce_to_group');
  });

  it('没有签名 → unsigned', () => {
    const r = verifyTaskAction({ action: mkAction(req, { deviceId: pair.deviceId }) } as any, dkey, { req, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('unsigned');
  });

  it('设备查不到 → unknown_device; 查到的公钥与载荷设备不一致 → device_mismatch', () => {
    expect(verifyTaskAction(signedOk(), null, { req, now: NOW }).reason).toBe('unknown_device');
    expect(verifyTaskAction(signedOk(), { ...dkey, deviceId: 'dev-other' }, { req, now: NOW }).reason).toBe('device_mismatch');
  });

  it('换内容 (换群/换公告号) → content_mismatch', () => {
    const s = signedOk();
    const r1 = verifyTaskAction(s, dkey, { req: { ...req, groupRef: 'gid-2' }, now: NOW });
    expect(r1.reason).toBe('content_mismatch');
    const r2 = verifyTaskAction(s, dkey, { req: { ...req, announcementId: 'ann-other000000' }, now: NOW });
    expect(r2.reason).toBe('content_mismatch');
  });

  it('换类型 (入群签名拿去发公告) → kind_mismatch', () => {
    const s = signedOk();
    const r = verifyTaskAction(s, dkey, { req: mkReq('announce_publish', { capability: 'c', instruction: 'i' }), now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('kind_mismatch');
  });

  it('签名被改 → bad_signature', () => {
    const s = signedOk();
    const bad = Buffer.from('00'.repeat(64), 'hex').toString('base64');
    const r = verifyTaskAction({ action: s.action, signature: { ...s.signature, sig: bad } }, dkey, { req, now: NOW });
    expect(r.reason).toBe('bad_signature');
  });

  it('载荷在签名后被改 (payloadHash 对不上) → payload_tampered', () => {
    const s = signedOk();
    const r = verifyTaskAction({ action: { ...s.action, targetRef: '偷改的引用' }, signature: s.signature }, dkey, { req, now: NOW });
    expect(r.reason).toBe('payload_tampered');
  });

  it('过期 → expired (哪怕签名完全合法)', () => {
    const action = mkAction(req, {
      deviceId: pair.deviceId,
      createdAt: new Date(NOW - 10 * 60_000).toISOString(), expiresAt: new Date(NOW - 5 * 60_000).toISOString(),
    });
    const r = verifyTaskAction({ action, signature: signWithNodeKey(action, pair.privateKeyPem) }, dkey, { req, now: NOW });
    expect(r.reason).toBe('expired');
  });

  it('不给 req 时不比对内容 (调用方明确知道自己在做什么), 但形状/签名/时效仍然全查', () => {
    const s = signedOk();
    expect(verifyTaskAction(s, dkey, { now: NOW }).ok).toBe(true);
    expect(verifyTaskAction(s, dkey, { now: NOW + 3_600_000 }).reason).toBe('expired');
  });
});

describe('⑤ 文案表不许漂移', () => {
  it('手机端的痕迹类型中文名与 task-group 的 TRAIL_KIND_LABEL 一致', () => {
    for (const [k, v] of Object.entries(TRAIL_KIND_LABEL)) {
      expect(TRAIL_KIND_LABELS[k]?.zh).toBe(v);
    }
    expect(Object.keys(TRAIL_KIND_LABELS).sort()).toEqual(Object.keys(TRAIL_KIND_LABEL).sort());
  });

  it('summarizeTrail 会用的 6 个矛盾码都有双语标签', () => {
    for (const code of [
      'final-accept-without-delivery', 'screen-without-delivery', 'claim-without-announce',
      'deliver-without-claim', 'both-accept-and-reject', 'group-message-hit-privacy-rule',
    ]) {
      expect(INCONSISTENCY_LABELS[code]?.zh, code).toBeTruthy();
      expect(INCONSISTENCY_LABELS[code]?.en, code).toBeTruthy();
    }
  });
});
