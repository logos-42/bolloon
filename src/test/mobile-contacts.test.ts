/**
 * mobile-contacts.test.ts — 手机端能力真互操作测试 (2026-09-19)
 *
 * 核心要证的**不是** UI, 而是这条链真的对得上:
 *   手机 (WebCrypto Ed25519) 签名 → 桌面 (Node crypto) 验签接受 / 篡改必拒。
 * 以及手机端的三条诚实纪律:
 *   ① 不支持 Ed25519 就明说 (绝不发未签名授权) ② 桌面离线只排队, 不假装已生效 ③ 本地只存 capability, 不含明文。
 *
 * 这里用真 express + 真 HTTP (不是 mock fetch), 因为"手机怎么跟桌面说话"本身就是被测对象。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import express from 'express';

import { GrantStore, canonicalGrantPayload as nodeCanonical, grantPayloadHash as nodeHash, verifyGrantSignature } from '../agents/contacts/grants.js';
import { canonicalGrantPayload as sharedCanonical, presetForChoice } from '../agents/contacts/grant-payload.js';
import {
  authorizeFromPhone, bindFromPhone, buildPhoneCard, decideApprovalFromPhone, ed25519Available,
  flushQueuedGrants, loadCapabilityCopy, loadFromDesktop, loadOrCreateDeviceKey, pendingQueue,
  revokeFromPhone, signGrantOnDevice, saveCapabilityCopy, verifyFromPhone, type StorageLike,
} from '../web/mobile-contacts.js';
import { ContactChain } from '../agents/contacts/chain.js';
import { registerContactRoutes } from '../web/routes-contacts.js';
import { createGoal } from '../agents/goal-store.js';

const OWNER = 'did:key:zPhoneOwner';
let tmp: string;
let prevHome: string | undefined;

function memStorage(): StorageLike & { raw: Map<string, string> } {
  const m = new Map<string, string>();
  return {
    raw: m,
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** 真 express + 真 HTTP: 手机与桌面的对话就是被测对象 */
async function startDesktop() {
  const app = express();
  app.use(express.json());
  registerContactRoutes(app, { home: tmp, ownerDid: OWNER });
  const srv = await new Promise<http.Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { base, close: () => { srv.close(); (srv as any).closeAllConnections?.(); } };
}

beforeEach(() => {
  prevHome = process.env.HOME;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-mobile-contacts-'));
  process.env.HOME = tmp;
});
afterEach(() => {
  if (prevHome !== undefined) process.env.HOME = prevHome;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

describe('签名规范与设备密钥', () => {
  it('手机端与桌面端对同一条 Grant 算出**同一个**规范载荷与 hash', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage);
    const grant = {
      grantId: 'gr-x', identityId: 'sid', ownerDid: OWNER, ...presetForChoice('persistent'),
      grantedAt: '2026-09-19T00:00:00.000Z', grantedBy: 'leo', grantedVia: 'mobile',
      deviceIds: [dev.deviceId], status: 'active' as const, grantVersion: 3,
    };
    const sig = await signGrantOnDevice(grant, storage);
    // 桌面用的规范函数 (经 grants.ts 走同一个纯模块)
    expect(nodeHash(grant as any)).toBe(sig.payloadHash);
    expect(nodeCanonical(grant as any)).toBe(sharedCanonical(grant as any));
  });

  it('Node 24 环境里 WebCrypto Ed25519 可用 (手机端签名能力前置条件)', () => {
    expect(ed25519Available()).toBe(true);
  });

  it('同一 storage 复用同一设备密钥 (不会每次授权都换设备)', async () => {
    const storage = memStorage();
    const a = await loadOrCreateDeviceKey(storage);
    const b = await loadOrCreateDeviceKey(storage);
    expect(b.deviceId).toBe(a.deviceId);
    expect(b.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });
});

describe('手机签名 → 桌面验签 (真密码学互操作)', () => {
  it('手机签的长期授权被桌面 GrantStore 接受', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage);
    const store = new GrantStore(path.join(tmp, '.bolloon', 'contacts'));
    await store.registerDevice(dev.deviceId, dev.publicKeyPem, '测试手机');
    const grant = {
      grantId: 'gr-mobile-1', identityId: 'sid-phone', ownerDid: OWNER, ...presetForChoice('full_contact_access'),
      grantedAt: new Date().toISOString(), grantedBy: 'leo', grantedVia: 'mobile' as const,
      deviceIds: [dev.deviceId], status: 'active' as const, grantVersion: 1,
    };
    const signature = await signGrantOnDevice(grant, storage);
    const r = await store.applySignedSync({ ...grant, signature } as any);
    expect(r.ok).toBe(true);
    expect((await store.activeFor(OWNER))?.grantId).toBe('gr-mobile-1');
    expect((await store.activeFor(OWNER))?.level).toBe('full_contact_access');
  });

  it('签名之后改任何一个被签字段 → 桌面拒绝', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage);
    const store = new GrantStore(path.join(tmp, '.bolloon', 'contacts'));
    await store.registerDevice(dev.deviceId, dev.publicKeyPem);
    const grant = {
      grantId: 'gr-mobile-2', identityId: 'sid', ownerDid: OWNER, ...presetForChoice('persistent'),
      grantedAt: new Date().toISOString(), grantedBy: 'leo', grantedVia: 'mobile' as const,
      deviceIds: [dev.deviceId], status: 'active' as const, grantVersion: 1,
    };
    const signature = await signGrantOnDevice(grant, storage);
    const r = await store.applySignedSync({ ...grant, contentScope: 'sensitive', autoSend: true, signature } as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('grant_device_untrusted');
    expect(verifyGrantSignature({ ...grant, contentScope: 'sensitive', signature } as any, store.getDevice(dev.deviceId)!).ok).toBe(false);
  });

  it('未登记设备的授权一律不收 (桌面不能自铸手机授权)', async () => {
    const storage = memStorage();
    const dev = await loadOrCreateDeviceKey(storage);
    const store = new GrantStore(path.join(tmp, '.bolloon', 'contacts'));   // 刻意不 registerDevice
    const grant = {
      grantId: 'gr-mobile-3', identityId: 'sid', ownerDid: OWNER, ...presetForChoice('persistent'),
      grantedAt: new Date().toISOString(), grantedBy: 'leo', grantedVia: 'mobile' as const,
      deviceIds: [dev.deviceId], status: 'active' as const, grantVersion: 1,
    };
    const r = await store.applySignedSync({ ...grant, signature: await signGrantOnDevice(grant, storage) } as any);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('grant_device_untrusted');
  });
});

describe('手机端动作 (真 HTTP 到桌面)', () => {
  it('桌面离线: 绑定/批准都不假装成功', async () => {
    const storage = memStorage();
    const b = await bindFromPhone(null, { kind: 'email', value: 'a@b.com' }, storage);
    expect(b.ok).toBe(false);
    expect(String(b.error)).toContain('desktop_offline');
    const ap = await decideApprovalFromPhone(null, { consentId: 'c1', action: 'approve' });
    expect(ap.ok).toBe(false);
    expect(String(ap.error)).toContain('desktop_offline');
  });

  it('桌面离线时授权进本地队列 (queued), 桌面回来后补同步成功', async () => {
    const storage = memStorage();
    // 先登记设备 (真的走一次 HTTP), 之后再用坏地址模拟离线
    const desktop = await startDesktop();
    const dev = await loadOrCreateDeviceKey(storage);
    await fetch(`${desktop.base}/api/contacts/devices`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem, label: '测试手机' }),
    });
    desktop.close();

    const offline = await authorizeFromPhone({ base: 'http://127.0.0.1:1', choice: 'persistent', ownerDid: OWNER, storage });
    expect(offline.ok).toBe(false);
    expect(offline.queued).toBe(true);
    expect(pendingQueue(storage)).toHaveLength(1);

    const desktop2 = await startDesktop();
    const flush = await flushQueuedGrants(desktop2.base, storage);
    expect(flush.sent).toBe(1);
    expect(pendingQueue(storage)).toHaveLength(0);
    const store = new GrantStore(path.join(tmp, '.bolloon', 'contacts'));
    expect((await store.activeFor(OWNER))?.grantId).toBe(offline.data!.grantId);
    desktop2.close();
  });

  it('手机授权 → 桌面接受 → 桌面真的按长期授权发送 (端到端真 HTTP)', async () => {
    const storage = memStorage();
    const desktop = await startDesktop();
    const r = await authorizeFromPhone({ base: desktop.base, choice: 'persistent', ownerDid: OWNER, storage });
    expect(r.ok).toBe(true);

    // 桌面侧准备联系人与任务
    const chain = new ContactChain({ home: tmp, ownerDid: OWNER });
    const b = await chain.bind({ kind: 'email', value: 'supplier@example.com' });
    await chain.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const goal = await createGoal({ objective: '手机授权后的任务' });
    const sent = await chain.send({ contactId: b.contact!.contactId, goalId: goal.goalId, body: '手机授权后不该再打断' });
    expect(sent.status === 'sent' || sent.status === 'awaiting_reply').toBe(true);
    expect(sent.consentId).toBeUndefined();      // 关键: 没有再创建待批准
    desktop.close();
  });

  it('手机撤销带签名 → 桌面立即失效; 篡改过的撤销被拒', async () => {
    const storage = memStorage();
    const desktop = await startDesktop();
    const auth = await authorizeFromPhone({ base: desktop.base, choice: 'persistent', ownerDid: OWNER, storage });
    expect(auth.ok).toBe(true);

    const rv = await revokeFromPhone({ base: desktop.base, grantId: auth.data!.grantId, storage, version: 5, reason: '测试收回' });
    expect(rv.ok).toBe(true);
    const store = new GrantStore(path.join(tmp, '.bolloon', 'contacts'));
    expect(await store.activeFor(OWNER)).toBeNull();
    expect((await store.get(auth.data!.grantId))?.status).toBe('revoked');

    // 篡改撤销 (签名与 payload 不匹配) → 桌面拒绝, 不会误撤
    const storage2 = memStorage();
    const desktop2 = await startDesktop();
    const auth2 = await authorizeFromPhone({ base: desktop2.base, choice: 'persistent', ownerDid: OWNER, storage: storage2 });
    expect(auth2.ok).toBe(true);
    const dev = await loadOrCreateDeviceKey(storage2);
    const bad = await fetch(`${desktop2.base}/api/contacts/grants/revoke-sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grantId: auth2.data!.grantId, by: 'mobile', version: 2, revokedAt: '2026-09-19T00:00:00.000Z',
        signature: { deviceId: dev.deviceId, alg: 'ed25519', payloadHash: 'deadbeef', sig: 'AAAA' },
      }),
    });
    const badJson: any = await bad.json();
    expect(bad.status).toBe(400);
    expect(badJson.ok).toBe(false);
    expect((await store.get(auth2.data!.grantId))?.status).toBe('active');
    desktop.close(); desktop2.close();
  });

  it('手机上批准/拒绝高风险联系 (真 HTTP)', async () => {
    const chain = new ContactChain({ home: tmp, ownerDid: OWNER });
    const b = await chain.bind({ kind: 'email', value: 'supplier@example.com' });
    await chain.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    const goal = await createGoal({ objective: '需要批准的任务' });
    await chain.authorizeForTask({ contactId: b.contact!.contactId, goalId: goal.goalId, by: 'leo' });
    const pending = await chain.send({ contactId: b.contact!.contactId, goalId: goal.goalId, body: '首次联系需要用户批准' });
    expect(pending.status).toBe('awaiting_approval');

    const desktop = await startDesktop();
    const ok = await decideApprovalFromPhone(desktop.base, { consentId: pending.consentId!, action: 'approve' });
    expect(ok.ok).toBe(true);
    const rec = (await chain.store.listSends()).find((s) => s.requestId === pending.requestId)!;
    expect(rec.status).toBe('sent');
    desktop.close();
  });

  it('绑定/验证走真 HTTP (验证码来自本地落盘通道)', async () => {
    const desktop = await startDesktop();
    const storage = memStorage();
    const b = await bindFromPhone(desktop.base, { kind: 'email', value: 'new@example.com' }, storage);
    expect(b.ok).toBe(true);
    expect(String(b.data.displayValue)).toContain('*');
    const v = await verifyFromPhone(desktop.base, { contactId: b.data.contactId, challengeId: b.data.challengeId, code: b.data.otpForLocalSink }, storage);
    expect(v.ok).toBe(true);
    desktop.close();
  });
});

describe('手机端诚实纪律', () => {
  it('不支持 Ed25519 的 WebView: 明确报 device_signing_unavailable, 绝不发未签名授权', async () => {
    const storage = memStorage();
    const fakeCrypto = {} as any;                       // 没有 subtle
    const r = await authorizeFromPhone({ base: 'http://127.0.0.1:1', choice: 'persistent', ownerDid: OWNER, storage, cryptoObj: fakeCrypto });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('device_signing_unavailable');
    expect(pendingQueue(storage)).toHaveLength(0);       // 没有偷偷排队
    expect(r.queued).toBeUndefined();
  });

  it('本地能力副本只有 capability, 不含明文联系方式/密钥', () => {
    const storage = memStorage();
    saveCapabilityCopy(storage, [
      { contactId: 'ct-1', kind: 'email', displayValue: 's****@example.com', verificationStatus: 'verified', capabilities: ['send'], provider: 'smtp' },
    ]);
    const raw = storage.getItem('bolloon.contacts.capabilities.v1') || '';
    expect(raw).toContain('s****@example.com');
    expect(raw).not.toContain('supplier@example.com');
    expect(raw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(raw).not.toContain('password');
    expect(loadCapabilityCopy(storage)).toHaveLength(1);
  });

  it('设备私钥只存在本机 storage (且是 JWK, 不上传)', async () => {
    const storage = memStorage();
    await loadOrCreateDeviceKey(storage);
    const raw = storage.getItem('bolloon.contacts.device.v1') || '';
    const parsed = JSON.parse(raw);
    expect(parsed.privateKeyJwk.d).toBeTruthy();       // 私钥在本机
    expect(raw).not.toContain('BEGIN PRIVATE KEY');     // 不是 PEM 明文形态
    // 上传的只有公钥 PEM
    const dev = await loadOrCreateDeviceKey(storage);
    expect(dev.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(JSON.stringify({ deviceId: dev.deviceId, publicKeyPem: dev.publicKeyPem })).not.toContain(parsed.privateKeyJwk.d);
  });

  it('从桌面读到的视图只含脱敏值, 且离线时退回本地副本并标注', async () => {
    const chain = new ContactChain({ home: tmp, ownerDid: OWNER });
    const b = await chain.bind({ kind: 'email', value: 'supplier@example.com' });
    await chain.verify({ contactId: b.contact!.contactId, challengeId: b.challengeId!, code: b.otpForLocalSink! });
    await chain.authorize({ choice: 'persistent', grantedBy: 'leo', grantedVia: 'mobile' });
    const desktop = await startDesktop();
    const storage = memStorage();
    const view = await loadFromDesktop(desktop.base, storage);
    expect(view.ok).toBe(true);
    expect(JSON.stringify(view.data)).not.toContain('supplier@example.com');
    const card = buildPhoneCard(view.data || null, { deviceSigning: true });
    expect(card.choices.map((c) => c.id)).toEqual(['task_once', 'persistent', 'full_contact_access']);
    expect(card.willNotGet.join(' ')).toContain('自动支付');
    desktop.close();

    const offline = await loadFromDesktop(null, storage);
    expect(offline.ok).toBe(false);
    expect(String(offline.note)).toContain('能力副本');
    expect(JSON.stringify(offline.data)).not.toContain('supplier@example.com');
  });
});

describe('验证码方向配对 (手机出码 → 电脑 /pair verify, 2026-10-17 反方向闭环)', () => {
  it('phone-code 需要 deviceDid (DID 主验证); 正常出码返回 6 位一次性码', async () => {
    const desktop = await startDesktop();
    // 缺 deviceDid → 400 (手机不带 DID 不许登记)
    const miss = await fetch(`${desktop.base}/api/contacts/pairing/phone-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(miss.status).toBe(400);
    // 带 deviceDid → 出码
    const ok = await fetch(`${desktop.base}/api/contacts/pairing/phone-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceDid: 'did:key:zPhoneX' }),
    }).then((r) => r.json());
    expect(ok.ok).toBe(true);
    expect(ok.code).toMatch(/^\d{6}$/);
    expect(ok.deviceDid).toBe('did:key:zPhoneX');
    desktop.close();
  });

  it('verify-code 确认手机出的码 → 成功并登记 DID; 一次性复用拒; 错码拒', async () => {
    const desktop = await startDesktop();
    const issued = await fetch(`${desktop.base}/api/contacts/pairing/phone-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceDid: 'did:key:zPhoneY' }),
    }).then((r) => r.json());
    // 电脑输码确认 → 成功, 带回手机 DID
    const v = await fetch(`${desktop.base}/api/contacts/pairing/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.code }),
    }).then((r) => r.json());
    expect(v.ok).toBe(true);
    expect(v.deviceDid).toBe('did:key:zPhoneY');
    // 一次性: 同码再验 → 拒
    const again = await fetch(`${desktop.base}/api/contacts/pairing/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: issued.code }),
    });
    expect(again.status).toBe(404);
    // 错码 → 拒
    const wrong = await fetch(`${desktop.base}/api/contacts/pairing/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: '999999' }),
    });
    expect(wrong.status).toBe(404);
    desktop.close();
  });

  it('方向隔离: 电脑 /pair 出的码 (phoneFirst 无) 不能被 verify-code 反向消费', async () => {
    const desktop = await startDesktop();
    // 电脑 /pair 的 challenge (手机输码方向, 无 phoneFirst 标记)
    const ch = await fetch(`${desktop.base}/api/contacts/pairing/challenge`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }).then((r) => r.json());
    expect(ch.ok).toBe(true);
    // 该码不能走「手机出码」的 verify-code 通道
    const v = await fetch(`${desktop.base}/api/contacts/pairing/verify-code`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: ch.code }),
    });
    expect(v.status).toBe(404);
    desktop.close();
  });
});
