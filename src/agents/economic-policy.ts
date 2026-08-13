/**
 * economic-policy.ts — Policy Engine (2026-08-13, Phase E3)
 *
 * Agent 支付授权安全核心 (参考 arXiv:2605.30998 free-riding 防护):
 *   LLM 只见 Payment Intent, 不见私钥; Policy Engine 是唯一签名入口.
 *
 * 规则:
 *   - amount < per_transaction_limit
 *   - recipient (payTo) in allowed
 *   - service in allowed
 *   - daily budget not exceeded (冻结)
 *   - 速率限制 (rate limit)
 *
 * 预算持久化: ~/.bolloon/economic-policy.json (daily spend 滚动).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';

const home = (): string => process.env.HOME || os.homedir() || '/tmp';

export interface PaymentIntent {
  /** 收款方地址 */
  payTo: string;
  /** 金额 (人类单位) */
  amount: number;
  /** 币种 (USDC/ETH) */
  currency?: string;
  /** 服务名 (research/coding/data...) */
  service?: string;
  /** 请求上下文 ID (防重放) */
  requestId?: string;
  /** 时间戳 */
  timestamp?: number;
}

export interface PolicyConfig {
  /** 单笔上限 */
  perTransactionLimit: number;
  /** 每日预算 */
  dailyLimit: number;
  /** 允许的收款方 (空 = 全部允许) */
  allowedRecipients: string[];
  /** 允许的服务 (空 = 全部允许) */
  allowedServices: string[];
  /** 每分钟最大支付次数 */
  rateLimitPerMinute: number;
}

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** 预算信息 */
  dailySpent?: number;
}

export interface EconomicPolicy {
  /** 配置 */
  config(): PolicyConfig;
  /** 更新配置 */
  updateConfig(patch: Partial<PolicyConfig>): void;
  /** 检查支付意图 (不签名, 只授权) */
  check(intent: PaymentIntent): Promise<PolicyDecision>;
  /** 记录一次已执行的支付 (更新日预算) */
  recordSpend(amount: number): Promise<void>;
  /** 今日已花费 */
  dailySpent(): Promise<number>;
  /** 重置日预算 (新的一天自动) */
  resetIfNewDay(): Promise<void>;
}

/** 默认策略 (保守) */
const DEFAULT_CONFIG: PolicyConfig = {
  perTransactionLimit: 1,       // 单笔 ≤ $1
  dailyLimit: 10,               // 每日 ≤ $10
  allowedRecipients: [],
  allowedServices: [],
  rateLimitPerMinute: 5,
};

export class LocalEconomicPolicy implements EconomicPolicy {
  private cfg: PolicyConfig = { ...DEFAULT_CONFIG };
  private file: string;

  /** 支付时间戳窗口 (速率限制) */
  private payTimestamps: number[] = [];
  /** 今日花费 */
  private _dailySpent = 0;
  private _dayKey = '';

  constructor(file: string = path.join(home(), '.bolloon', 'economic-policy.json')) {
    this.file = file;
  }

  config(): PolicyConfig { return { ...this.cfg }; }

  updateConfig(patch: Partial<PolicyConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
  }

  /** 加载持久化 (daily spend 跨重启) */
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, 'utf-8'));
      if (raw.dailySpent !== undefined) this._dailySpent = Number(raw.dailySpent) || 0;
      if (raw.dayKey) this._dayKey = raw.dayKey;
      if (raw.config) this.cfg = { ...DEFAULT_CONFIG, ...raw.config };
      await this.resetIfNewDay();
    } catch { /* 无持久化, 用默认 */ }
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify({
        dailySpent: this._dailySpent,
        dayKey: this._dayKey,
        config: this.cfg,
      }, null, 2), 'utf-8');
    } catch { /* 持久化失败静默 */ }
  }

  async dailySpent(): Promise<number> {
    await this.resetIfNewDay();
    return this._dailySpent;
  }

  async resetIfNewDay(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    if (this._dayKey !== today) {
      this._dayKey = today;
      this._dailySpent = 0;
      this.payTimestamps = [];
      await this.persist();
    }
  }

  async check(intent: PaymentIntent): Promise<PolicyDecision> {
    await this.resetIfNewDay();
    const amount = Number(intent.amount) || 0;
    const payTo = String(intent.payTo || '').toLowerCase();
    const service = String(intent.service || '').toLowerCase();

    // 1. 单笔上限
    if (amount > this.cfg.perTransactionLimit) {
      return { allowed: false, reason: `单笔超限: ${amount} > ${this.cfg.perTransactionLimit}`, dailySpent: this._dailySpent };
    }
    // 2. 收款方白名单
    if (this.cfg.allowedRecipients.length > 0 &&
        !this.cfg.allowedRecipients.some((r) => r.toLowerCase() === payTo)) {
      return { allowed: false, reason: `收款方不在白名单: ${payTo}`, dailySpent: this._dailySpent };
    }
    // 3. 服务白名单
    if (service && this.cfg.allowedServices.length > 0 &&
        !this.cfg.allowedServices.some((s) => s.toLowerCase() === service)) {
      return { allowed: false, reason: `服务不在白名单: ${service}`, dailySpent: this._dailySpent };
    }
    // 4. 每日预算
    if (this._dailySpent + amount > this.cfg.dailyLimit) {
      return { allowed: false, reason: `日预算超限: ${this._dailySpent} + ${amount} > ${this.cfg.dailyLimit}`, dailySpent: this._dailySpent };
    }
    // 5. 速率限制
    const now = Date.now();
    this.payTimestamps = this.payTimestamps.filter((t) => now - t < 60_000);
    if (this.payTimestamps.length >= this.cfg.rateLimitPerMinute) {
      return { allowed: false, reason: `速率超限 (${this.cfg.rateLimitPerMinute}/min)`, dailySpent: this._dailySpent };
    }

    return { allowed: true, dailySpent: this._dailySpent };
  }

  async recordSpend(amount: number): Promise<void> {
    await this.resetIfNewDay();
    this._dailySpent += Number(amount) || 0;
    this.payTimestamps.push(Date.now());
    await this.persist();
  }
}

let _instance: EconomicPolicy | null = null;

/** 获取 Policy Engine 单例 */
export function getEconomicPolicy(): EconomicPolicy {
  if (!_instance) {
    const p = new LocalEconomicPolicy();
    void p.load();
    _instance = p;
  }
  return _instance;
}

/** 重置单例 (测试用) */
export function resetEconomicPolicy(): void {
  _instance = null;
}
