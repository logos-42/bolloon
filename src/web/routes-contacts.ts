/**
 * routes-contacts.ts — 联系方式 / 授权 / 配对 的桌面端 API (2026-09-19, Phase 5/6)
 *
 * 全部返回**脱敏**数据: 完整手机号/邮箱永不出现在响应里。
 * 与手机端的分工 (leo 冻结):
 *   手机负责 输入 + OTP 确认 + 生物识别授权 + 展示待发内容 + 批准高风险联系
 *   桌面负责 长期 Goal/Run、执行、恢复、持久化状态、证据
 * 同步只传: identityId / contactId / verificationStatus / capability / consentScope / provider /
 *          secretRef 的关联状态 —— **不传**明文、不传密钥。
 */

import type { Express } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContactChain } from '../agents/contacts/chain.js';
import { type ContactKind } from '../agents/contacts/types.js';
import type { ContactGrant } from '../agents/contacts/grants.js';

/** 配对挑战 (一次性, 桌面生成 / 手机确认) */
interface Pairing { pairingId: string; code: string; createdAt: number; expiresAt: number; usedAt?: number; deviceDid?: string }

const PAIRING_TTL_MS = 5 * 60_000;

/** 明显的明文联系方式/密钥 —— 同步载荷里出现就直接拒绝 (防止"顺手同步了明文") */
export function looksLikePlaintextSecret(value: unknown): string | null {
  const walk = (v: unknown, pathStr: string): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') {
      const s = v.trim();
      if (/\b(sk-[A-Za-z0-9]{12,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})\b/.test(s)) return `${pathStr}: 疑似密钥明文`;
      if (/\b(password|passwd|smtp_pass|api_secret|refresh_token|client_secret)\b/i.test(pathStr) && s.length > 0) return `${pathStr}: 疑似秘密字段`;
      // 明文邮箱/手机号: 只有在 key 明确表示"值"时才拦 (displayValue 是脱敏的, 不会匹配)
      if (/[^@\s]+@[^@\s]+\.[^@\s]+/.test(s) && !/^\*|@\*/.test(s) && s.includes('*') === false) return `${pathStr}: 疑似邮箱明文`;
      if (/^\+?\d{8,15}$/.test(s.replace(/[^\d+]/g, '')) && /value|phone|number|to$/i.test(pathStr)) return `${pathStr}: 疑似手机号明文`;
      return null;
    }
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = walk(v[i], `${pathStr}[${i}]`); if (r) return r; } return null; }
    if (typeof v === 'object') { for (const [k, vv] of Object.entries(v as Record<string, unknown>)) { const r = walk(vv, pathStr ? `${pathStr}.${k}` : k); if (r) return r; } return null; }
    return null;
  };
  return walk(value, '');
}

export function registerContactRoutes(
  app: Express,
  opts: { chain?: ContactChain; home?: string; ownerDid?: string; pairs?: Map<string, Pairing> } = {},
): void {
  const pairs = opts.pairs || new Map<string, Pairing>();
  const ownerDidFromDisk = (): string => {
    try {
      const f = path.join(process.env.HOME || os.homedir(), '.bolloon', 'identity', 'user.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j?.did) return String(j.did);
    } catch { /* 还没有用户身份 → 用本地占位 */ }
    return (globalThis as any).__bolloonUserDid || 'did:bolln:local';
  };
  const chainFor = (ownerDid?: string) => opts.chain || new ContactChain({
    home: opts.home,
    ownerDid: ownerDid || opts.ownerDid || ownerDidFromDisk(),
    displayName: '本机用户',
  });

  const chainOf = (req: any) => chainFor(String(req?.body?.ownerDid || opts.ownerDid || ''));

  // ── 列表 (脱敏) ────────────────────────────────────────────────────────────
  app.get('/api/contacts', async (req, res) => {
    try {
      const c = chainOf(req);
      res.json({
        ok: true,
        contacts: await c.listAuthorized(),
        channels: c.channels(),
        approvals: (await c.consents.list('pending')).map((a) => ({
          consentId: a.consentId, contactId: a.contactId, contactName: a.contactName, channel: a.channel,
          provider: a.provider, reallySent: a.reallySent, subject: a.subject, bodyPreview: a.bodyPreview,
          goalId: a.goalId, reason: a.reason, createdAt: a.createdAt, expiresAt: a.expiresAt,
        })),
        waiting: (await c.store.readLedger({ limit: 200 })).filter((l) => l.activity === 'contact.sent').slice(-10),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 绑定 (Phase 2/3): 输入 → 规范化 → 隐私说明 → 发验证码 → pending ─────────
  app.post('/api/contacts/bind', async (req, res) => {
    try {
      const c = chainOf(req);
      const kind = String(req.body?.kind || '') as ContactKind;
      if (kind !== 'phone' && kind !== 'email') return res.status(400).json({ ok: false, error: 'kind 必须是 phone 或 email' });
      const r = await c.bind({
        kind,
        value: String(req.body?.value || ''),
        region: req.body?.region ? String(req.body.region) : undefined,
        provider: req.body?.provider ? String(req.body.provider) : undefined,
        secretRef: req.body?.secretRef ? String(req.body.secretRef) : undefined,
        aliases: Array.isArray(req.body?.aliases) ? req.body.aliases.map(String) : undefined,
        note: req.body?.note ? String(req.body.note) : undefined,
        source: req.body?.source === 'agent_card' ? 'agent_card' : 'user_input',
      });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      res.json({
        ok: true,
        contactId: r.contact!.contactId,
        displayValue: r.contact!.displayValue,
        verificationStatus: r.contact!.verificationStatus,
        channelLabel: r.channelLabel,
        challengeId: r.challengeId,
        // 只有本地落盘通道才回显验证码 (真外发通道不回显, 也不会出现在响应里)
        otpForLocalSink: r.otpForLocalSink,
        privacy: '完整手机号/邮箱不会进入 prompt / Run / Git; 外部只看到 已验证/可联系/不可联系/需要重新授权',
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/verify', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.verify({ contactId: String(req.body?.contactId || ''), challengeId: String(req.body?.challengeId || ''), code: String(req.body?.code || '') });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      res.json({ ok: true, contactId: r.contact!.contactId, displayValue: r.contact!.displayValue, verificationStatus: r.contact!.verificationStatus, capabilities: r.contact!.capabilities });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/:id/revoke', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.revoke({ contactId: String(req.params.id), by: String(req.body?.by || 'user'), reason: req.body?.reason ? String(req.body.reason) : undefined });
      if (!r.ok) return res.status(404).json({ ok: false, error: r.error });
      res.json({ ok: true, evidenceRef: r.evidenceRef, affectedGoals: r.affectedGoals });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 任务级授权 (把联系方式绑定到某个长期任务) ───────────────────────────────
  app.post('/api/contacts/:id/authorize', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.authorizeForTask({ contactId: String(req.params.id), goalId: String(req.body?.goalId || ''), by: String(req.body?.by || 'user') });
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error });
      res.json({ ok: true, contactId: r.contact!.contactId, consentScope: r.contact!.consentScope });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 预览 (不发送) ──────────────────────────────────────────────────────────
  app.post('/api/contacts/preview', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.preview({ contactId: String(req.body?.contactId || ''), goalId: req.body?.goalId ? String(req.body.goalId) : undefined, subject: req.body?.subject ? String(req.body.subject) : undefined, body: String(req.body?.body || '') });
      res.json({ ok: true, allowed: r.decision.allowed, requiresApproval: r.decision.requiresApproval, blockKind: r.decision.blockKind, reallySent: r.decision.reallySent, preview: r.text });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 发送 (走 policy; 需要批准就返回 awaiting_approval) ───────────────────────
  app.post('/api/contacts/send', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.send({
        contactId: String(req.body?.contactId || ''),
        goalId: req.body?.goalId ? String(req.body.goalId) : undefined,
        runId: req.body?.runId ? String(req.body.runId) : undefined,
        subject: req.body?.subject ? String(req.body.subject) : undefined,
        body: String(req.body?.body || ''),
        requestId: req.body?.requestId ? String(req.body.requestId) : undefined,
        replyExpected: req.body?.replyExpected !== false,
      });
      const code = r.status === 'denied' ? 409 : r.status === 'failed' ? 502 : 200;
      res.status(code).json({ ok: r.status === 'sent' || r.status === 'awaiting_reply', ...r });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 批准 / 拒绝 (人工授权) ─────────────────────────────────────────────────
  app.post('/api/contacts/approvals/:id/approve', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.approveAndSend(String(req.params.id), { by: String(req.body?.by || 'user'), via: 'web', body: req.body?.body ? String(req.body.body) : undefined });
      const code = r.ok ? 200 : (String(r.error || '').includes('not_found') ? 404 : 400);
      res.status(code).json({ ok: r.ok, error: r.error, status: r.status, requestId: r.requestId });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/approvals/:id/reject', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.consents.reject(String(req.params.id), { by: String(req.body?.by || 'user'), reason: req.body?.reason ? String(req.body.reason) : undefined });
      const code = r.ok ? 200 : (String(r.error || '').includes('not_found') ? 404 : 400);
      const cons = r.consent;
      if (cons) {
        await c.store.appendLedger({
          ts: new Date().toISOString(), activity: 'contact.rejected', contactId: cons.contactId, goalId: cons.goalId,
          detail: `人工拒绝 (by ${String(req.body?.by || 'user')}${req.body?.reason ? `, ${req.body.reason}` : ''}) · consent=${cons.consentId}`,
        });
      }
      res.status(code).json({ ok: r.ok, error: r.error });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 回复入口 (通道回调 / 手机转投): 来源校验不过就不唤醒、不入证据 ──────────────
  app.post('/api/contacts/reply', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.reply({
        requestId: req.body?.requestId ? String(req.body.requestId) : undefined,
        threadToken: req.body?.threadToken ? String(req.body.threadToken) : undefined,
        from: String(req.body?.from || ''),
        body: String(req.body?.body || ''),
        eventId: req.body?.eventId ? String(req.body.eventId) : undefined,
      });
      const code = r.ok ? 200 : (r.reason === 'source_untrusted' ? 403 : 404);
      res.status(code).json({ ok: r.ok, woke: r.woke, goalId: r.goalId, reason: r.reason, evidenceRef: r.evidenceRef });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 手机—桌面配对 (Phase 5): 只同步 capability, 不同步明文/密钥 ───────────────
  app.post('/api/contacts/pairing/challenge', async (_req, res) => {
    const now = Date.now();
    const pairingId = `pair-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const p: Pairing = { pairingId, code: String(crypto.randomInt(0, 1_000_000)).padStart(6, '0'), createdAt: now, expiresAt: now + PAIRING_TTL_MS };
    pairs.set(pairingId, p);
    res.json({ ok: true, pairingId, code: p.code, expiresAt: p.expiresAt, note: '手机扫码/深链确认后调 /confirm; 挑战 5 分钟有效且一次性' });
  });

  app.post('/api/contacts/pairing/confirm', async (req, res) => {
    try {
      const pairingId = String(req.body?.pairingId || '');
      const p = pairs.get(pairingId);
      if (!p) return res.status(404).json({ ok: false, error: 'pairing_not_found' });
      if (p.usedAt) return res.status(409).json({ ok: false, error: 'pairing_already_used' });
      if (p.expiresAt < Date.now()) return res.status(410).json({ ok: false, error: 'pairing_expired' });
      if (String(req.body?.code || '') !== p.code) return res.status(401).json({ ok: false, error: 'pairing_code_mismatch' });

      // 明文字段直接拒绝 —— 同步只允许传 capability 视图
      const incoming = req.body?.contacts;
      const leak = looksLikePlaintextSecret(incoming);
      if (leak) return res.status(400).json({ ok: false, error: `同步载荷含明文/秘密, 已拒绝: ${leak}` });

      p.usedAt = Date.now();
      p.deviceDid = req.body?.deviceDid ? String(req.body.deviceDid) : undefined;
      pairs.set(pairingId, p);

      const accepted: any[] = [];
      const rejected: any[] = [];
      const c = chainOf(req);
      const allowedKeys = ['contactId', 'kind', 'displayValue', 'verificationStatus', 'capabilities', 'consentScope', 'provider', 'secretRef', 'state'];
      for (const item of Array.isArray(incoming) ? incoming : []) {
        const clean: Record<string, unknown> = {};
        for (const k of allowedKeys) if (item && k in item) clean[k] = (item as any)[k];
        const known = clean.contactId ? await c.store.getContact(String(clean.contactId)) : null;
        if (!known) rejected.push({ contactId: clean.contactId, reason: '桌面端不认识这个 contactId (需要在桌面端绑定/接收能力)' });
        else accepted.push({ contactId: known.contactId, displayValue: known.displayValue, verificationStatus: known.verificationStatus, parity: 'capability-only' });
      }
      res.json({
        ok: true, deviceDid: p.deviceDid, accepted, rejected,
        note: '两端只对齐 contactId/状态/capability; 明文与密钥各自留在本机',
        evidence: await c.store.appendLedger({
          ts: new Date().toISOString(), activity: 'contact.discovered',
          detail: `手机—桌面配对完成 (deviceDid=${p.deviceDid || '未提供'}), 接受 ${accepted.length} 项能力, 拒绝 ${rejected.length} 项`,
        }),
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 持久能力授权 (Phase 3/4/8/10): CLI / Web / 手机 读同一份 Grant 事实 ──────
  app.get('/api/contacts/grants', async (req, res) => {
    try {
      const c = chainOf(req);
      const summary = await c.grantsSummary();
      res.json({
        ok: true,
        ...summary,
        choices: [
          { id: 'task_once', label: '仅本次任务' },
          { id: 'persistent', label: '长期使用 (推荐)' },
          { id: 'full_contact_access', label: '完全授权联系方式能力' },
        ],
        willNotGet: ['读取全部邮箱', '读取通讯录', '群发消息', '自动支付/转账', '代表你签署合同', '拿到手机号/邮箱明文'],
        forbiddenAlways: ['凭证 (密钥/密码)', '银行账号', '支付/转账指令', '合同承诺'],
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/grants', async (req, res) => {
    try {
      const c = chainOf(req);
      const choice = ['task_once', 'persistent', 'full_contact_access'].includes(String(req.body?.choice)) ? String(req.body.choice) as any : 'persistent';
      const r = await c.authorize({
        choice,
        grantedBy: String(req.body?.by || 'user'),
        grantedVia: req.body?.via === 'mobile' ? 'mobile' : req.body?.via === 'onboard' ? 'onboard' : 'web',
      });
      res.json({ ok: r.ok, userLabel: r.userLabel, grant: r.grant });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/grants/:id/:action', async (req, res) => {
    try {
      const c = chainOf(req);
      const id = String(req.params.id);
      const action = String(req.params.action);
      const by = String(req.body?.by || 'user');
      if (action === 'pause') { const r = await c.pauseGrant(id, { by }); return res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error, grant: r.grant }); }
      if (action === 'resume') { const r = await c.resumeGrant(id, { by }); return res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error, grant: r.grant }); }
      if (action === 'revoke') {
        const r = await c.revokeGrant(id, { by, reason: req.body?.reason ? String(req.body.reason) : undefined });
        return res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error, affectedGoals: r.affectedGoals });
      }
      res.status(400).json({ ok: false, error: `未知动作 ${action}` });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  app.post('/api/contacts/grants/revoke-all', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.revokeAllGrants({ by: String(req.body?.by || 'user'), reason: req.body?.reason ? String(req.body.reason) : undefined });
      res.json({ ok: true, ...r });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** 登记手机设备公钥 (配对阶段; 之后只接受它签名的授权) */
  app.post('/api/contacts/devices', async (req, res) => {
    try {
      const c = chainOf(req);
      const deviceId = String(req.body?.deviceId || '');
      const publicKeyPem = String(req.body?.publicKeyPem || '');
      if (!deviceId || !/BEGIN PUBLIC KEY/.test(publicKeyPem)) return res.status(400).json({ ok: false, error: 'deviceId/publicKeyPem 必填 (PEM 公钥)' });
      const d = await c.registerDevice(deviceId, publicKeyPem, req.body?.label ? String(req.body.label) : undefined);
      res.json({ ok: true, device: { deviceId: d.deviceId, label: d.label, registeredAt: d.registeredAt } });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** 手机同步签名 Grant (Phase 4): 验签 → 版本冲突 → 撤销优先 */
  app.post('/api/contacts/grants/sync', async (req, res) => {
    try {
      const c = chainOf(req);
      const incoming = req.body?.grant as ContactGrant;
      if (!incoming?.grantId || !incoming?.signature) return res.status(400).json({ ok: false, error: '需要带签名的 grant (grantId + signature)' });
      const r = await c.syncGrant(incoming);
      return res.status(r.ok ? 200 : 409).json({ ok: r.ok, code: r.code, reason: r.reason, grantId: r.grant?.grantId, grantVersion: r.grant?.grantVersion });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  /** 手机撤销 → 桌面立即失效 */
  app.post('/api/contacts/grants/revoke-sync', async (req, res) => {
    try {
      const c = chainOf(req);
      const r = await c.syncRevocation(String(req.body?.grantId || ''), {
        by: String(req.body?.by || 'mobile'),
        reason: req.body?.reason ? String(req.body.reason) : undefined,
        version: Number(req.body?.version) || undefined,
        revokedAt: req.body?.revokedAt ? String(req.body.revokedAt) : undefined,
        signature: req.body?.signature,      // 手机签名 (有则验签, 未登记设备一律拒)
      });
      res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.reason, grant: r.grant });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: String(err?.message || err) });
    }
  });

  // ── 手机号目录 (2026-10-11, phone-account-lookup-design 落点 A) ────────────
    // 隐私: 请求/响应全程只过「盲化哈希」, 明文手机号只在请求体出现一次 (发布/查询),
    //       永不出现在响应里 (与 contacts 既有红线一致)。
    const dirHome = (): string | undefined => opts.home || undefined;

    /** 发布手机号 → DID 指针 (opt-in; 用户显式调用) */
    app.post('/api/contacts/directory/publish', async (req, res) => {
      try {
        const { publishEntry, isPlausiblePhone } = await import('../agents/contacts/human-directory.js');
        const phone = String(req.body?.phone || '');
        const did = String(req.body?.did || ownerDidFromDisk());
        if (!isPlausiblePhone(phone)) return res.status(400).json({ ok: false, error: '手机号格式不正确' });
        const e = await publishEntry(phone, did, {
          displayName: req.body?.displayName ? String(req.body.displayName) : undefined,
          homeDir: dirHome(),
        });
        res.json({ ok: true, phoneHash: e.phoneHash.slice(0, 8) + '…', did: e.did, publishedAt: e.publishedAt });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 撤销目录条目 (软删) */
    app.post('/api/contacts/directory/retract', async (req, res) => {
      try {
        const { retractEntry } = await import('../agents/contacts/human-directory.js');
        const did = String(req.body?.did || ownerDidFromDisk());
        const ok = await retractEntry(did, dirHome());
        res.json({ ok, revoked: ok });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 按手机号查账号 (在本机目录内找; 响应只回 DID/昵称, 绝不回手机号) */
    app.post('/api/contacts/directory/lookup', async (req, res) => {
      try {
        const { lookupPhone, isPlausiblePhone } = await import('../agents/contacts/human-directory.js');
        const phone = String(req.body?.phone || '');
        if (!isPlausiblePhone(phone)) return res.status(400).json({ ok: false, error: '手机号格式不正确' });
        const r = await lookupPhone(phone, dirHome());
        if (!r.found) return res.json({ ok: true, found: false, note: '未找到 (未注册或未公开)' });
        res.json({ ok: true, found: true, did: r.did, displayName: r.displayName || null });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    });

    /** 列出已发布条目 (本机审计; 只回脱敏哈希) */
    app.get('/api/contacts/directory/list', async (_req, res) => {
      try {
        const { readDirectory, summarizeEntries } = await import('../agents/contacts/human-directory.js');
        const entries = await readDirectory(dirHome());
        res.json({ ok: true, entries: summarizeEntries(entries) });
      } catch (err: any) {
        res.status(500).json({ ok: false, error: String(err?.message || err) });
      }
    });

    // ── 隐藏守卫自检 (验收/测试直接用) ──────────────────────────────────────────
    app.get('/api/contacts/_selfcheck', (_req, res) => {
      res.json({ ok: true, plaintextGuard: looksLikePlaintextSecret({ contacts: [{ value: '+861****5678' }] }) });
    });
  }
