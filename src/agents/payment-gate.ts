/**
 * payment-gate.ts — YAML 驱动的支付验证门 (2026-08-13)
 *
 * 用户要求: 智能体支付不能全部交给 AI, 需要 YAML 验证流程.
 * 设计 (参考 Hermes write_approval 配置驱动 + arXiv:2605.30998):
 *   - payment-policy.yaml 声明式规则 (allow/confirm/deny)
 *   - 支付请求按规则链逐条匹配 → decision
 *   - deny 不可覆盖; confirm 返回 pending 等待人工审批 (不自动执行)
 *
 * 加载: ~/.bolloon/payment-policy.yaml (不存在则用内置默认 payment-policy.yaml)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export type PaymentDecision = 'allow' | 'confirm' | 'deny';

export interface PaymentIntent2 {
  service?: string;
  amount: number;
  recipient?: string;
}

export interface PaymentVerdict {
  decision: PaymentDecision;
  reason: string;
  ruleId?: string;
  /** confirm 时: 是否已有人工审批 (pending 则未批) */
  requiresApproval: boolean;
  limits?: { maxPerTransaction: number; maxDailyTotal: number };
}

interface YamlRule {
  id?: string;
  action: PaymentDecision;
  services?: string[];
  recipients?: string[];
  max_amount?: number;
  reason?: string;
  description?: string;
}

interface YamlPolicy {
  default_action?: PaymentDecision;
  default_reason?: string;
  limits?: { max_per_transaction?: number; max_daily_total?: number };
  rules?: YamlRule[];
  confirmation?: { timeout_minutes?: number; require_approver?: boolean };
}

/** 支付验证门: 加载 YAML 并评估 */
export class PaymentGate {
  private policy: YamlPolicy | null = null;
  private policyPath: string;

  constructor(policyPath: string = path.join(home(), '.bolloon', 'payment-policy.yaml')) {
    this.policyPath = policyPath;
  }

  /** 加载 YAML (本地文件优先, 否则内置默认) */
  load(): YamlPolicy {
    if (this.policy) return this.policy;
    const candidates = [
      this.policyPath,
      path.resolve(process.cwd(), 'src/agents/payment-policy.yaml'),
    ];
    for (const f of candidates) {
      try {
        if (fs.existsSync(f)) {
          this.policy = yaml.load(fs.readFileSync(f, 'utf-8')) as YamlPolicy;
          return this.policy;
        }
      } catch { /* 下一个 */ }
    }
    this.policy = { default_action: 'confirm', default_reason: '未命中任何支付规则, 需要人工确认' };
    return this.policy;
  }

  /**
   * 评估支付请求 (按规则链, 顺序匹配第一条命中).
   * 流程: 硬限制 (超限即 deny) → 规则链 (allow/confirm/deny) → 默认.
   */
  evaluate(intent: PaymentIntent2): PaymentVerdict {
    const p = this.load();
    const service = String(intent.service || '').toLowerCase();
    const recipient = String(intent.recipient || '').toLowerCase();
    const amount = Number(intent.amount) || 0;
    const limits = {
      maxPerTransaction: p.limits?.max_per_transaction ?? 1,
      maxDailyTotal: p.limits?.max_daily_total ?? 10,
    };

    // 0. 硬限制: 超单笔/日限 → deny (无论规则)
    if (amount > limits.maxPerTransaction) {
      return { decision: 'deny', reason: `单笔超限: ${amount} > ${limits.maxPerTransaction}`, requiresApproval: false, limits };
    }

    // 1. 规则链 (顺序匹配)
    for (const rule of p.rules ?? []) {
      const matchesService = !rule.services || rule.services.some((s) => s.toLowerCase() === service);
      const matchesRecipient = !rule.recipients || rule.recipients.some((r) => r.toLowerCase() === recipient);
      const matchesAmount = rule.max_amount === undefined || amount <= rule.max_amount;
      if (matchesService && matchesRecipient && matchesAmount) {
        return {
          decision: rule.action,
          reason: rule.reason || rule.description || `规则 ${rule.id} 命中`,
          ruleId: rule.id,
          requiresApproval: rule.action === 'confirm',
          limits,
        };
      }
    }

    // 2. 默认
    return {
      decision: p.default_action ?? 'confirm',
      reason: p.default_reason || '默认: 需人工确认',
      requiresApproval: (p.default_action ?? 'confirm') === 'confirm',
      limits,
    };
  }

  /** 快捷: 是否允许 (allow = true; confirm/deny = false 且不自动) */
  isAllowed(intent: PaymentIntent2): { allowed: boolean; verdict: PaymentVerdict } {
    const v = this.evaluate(intent);
    return { allowed: v.decision === 'allow', verdict: v };
  }
}

let _gate: PaymentGate | null = null;
/** 单例 */
export function getPaymentGate(): PaymentGate {
  if (!_gate) _gate = new PaymentGate();
  return _gate;
}
export function resetPaymentGate(): void {
  _gate = null;
}
