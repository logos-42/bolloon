/**
 * payment-approval.ts — 人工支付审批 (2026-08-13)
 *
 * YAML 支付验证门 (payment-gate) 判定 confirm 的支付请求 → 进入人工审批流程:
 *   - createApproval: 创建 pending 审批请求 (持久化)
 *   - approve(id): 人工批准 → 自动重试支付 (executor)
 *   - reject(id): 人工拒绝
 *   - list/pending: 查询
 *
 * 持久化: ~/.bolloon/payment-approvals.json
 * 审批后执行: 注入 executor (serviceCall 重试 / 链上支付), 由调用方提供.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface PaymentApproval {
  id: string;
  service: string;
  amount: number;
  recipient: string;
  reason: string;          // gate 的 reason
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  /** 批准后重试的载荷 (serviceCall 参数) */
  retryPayload?: Record<string, unknown>;
  result?: string;
}

export interface ApprovalExecutor {
  (approval: PaymentApproval): Promise<{ ok: boolean; result?: string; error?: string }>;
}

let _executor: ApprovalExecutor | null = null;

/** 注入批准后执行器 (serviceCall 重试 / 链上支付) */
export function setApprovalExecutor(fn: ApprovalExecutor): void {
  _executor = fn;
}

export class PaymentApprovalStore {
  private file: string;
  private approvals: PaymentApproval[] = [];

  constructor(file: string = path.join(home(), '.bolloon', 'payment-approvals.json')) {
    this.file = file;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      if (Array.isArray(raw)) this.approvals = raw;
    } catch { this.approvals = []; }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify(this.approvals, null, 2), 'utf-8');
    } catch { /* 静默 */ }
  }

  /** 创建审批请求 (pending) */
  async create(req: {
    service: string;
    amount: number;
    recipient: string;
    reason: string;
    retryPayload?: Record<string, unknown>;
  }): Promise<PaymentApproval> {
    await this.load();
    const approval: PaymentApproval = {
      id: `pay-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      service: req.service,
      amount: req.amount,
      recipient: req.recipient,
      reason: req.reason,
      status: 'pending',
      createdAt: Date.now(),
      retryPayload: req.retryPayload,
    };
    this.approvals.push(approval);
    await this.persist();
    return approval;
  }

  /** 待审批列表 */
  async pending(): Promise<PaymentApproval[]> {
    await this.load();
    return this.approvals.filter((a) => a.status === 'pending');
  }

  /** 全部 (含历史) */
  async list(): Promise<PaymentApproval[]> {
    await this.load();
    return [...this.approvals].reverse();
  }

  async get(id: string): Promise<PaymentApproval | null> {
    await this.load();
    return this.approvals.find((a) => a.id === id) ?? null;
  }

  /**
   * 人工批准 → 执行支付 (executor) → executed/failed.
   * 未注入 executor 时直接标记 approved (调用方自行处理).
   */
  async approve(id: string, approver = 'user'): Promise<{ ok: boolean; approval?: PaymentApproval; error?: string }> {
    await this.load();
    const a = this.approvals.find((x) => x.id === id);
    if (!a) return { ok: false, error: `审批 ${id} 不存在` };
    if (a.status !== 'pending') return { ok: false, error: `审批 ${id} 状态 ${a.status}, 不可批准` };
    a.status = 'approved';
    a.decidedAt = Date.now();
    await this.persist();

    // 批准后执行支付
    if (_executor) {
      const r = await _executor(a);
      a.status = r.ok ? 'executed' : 'failed';
      a.result = r.ok ? r.result : r.error;
      await this.persist();
      if (!r.ok) return { ok: false, approval: a, error: r.error };
    }
    return { ok: true, approval: a };
  }

  /** 人工拒绝 */
  async reject(id: string, approver = 'user'): Promise<{ ok: boolean; approval?: PaymentApproval; error?: string }> {
    await this.load();
    const a = this.approvals.find((x) => x.id === id);
    if (!a) return { ok: false, error: `审批 ${id} 不存在` };
    if (a.status !== 'pending') return { ok: false, error: `审批 ${id} 状态 ${a.status}, 不可拒绝` };
    a.status = 'rejected';
    a.decidedAt = Date.now();
    await this.persist();
    return { ok: true, approval: a };
  }

  /** 清理过期 pending (超时自动标记 rejected) */
  async expireStale(timeoutMs: number = 60 * 60 * 1000): Promise<number> {
    await this.load();
    const now = Date.now();
    let expired = 0;
    for (const a of this.approvals) {
      if (a.status === 'pending' && now - a.createdAt > timeoutMs) {
        a.status = 'rejected';
        a.decidedAt = now;
        a.result = '审批超时自动拒绝';
        expired++;
      }
    }
    if (expired > 0) await this.persist();
    return expired;
  }
}

let _store: PaymentApprovalStore | null = null;
/** 单例 */
export function getApprovalStore(): PaymentApprovalStore {
  if (!_store) _store = new PaymentApprovalStore();
  return _store;
}
export function resetApprovalStore(): void {
  _store = null;
  _executor = null;
}
