/**
 * user-questions.ts — 人机对话通道 (clarify)
 *
 * 让 agent 在运行中**停下来向人类提问并等回答**, 而不是自己猜。
 * 三个表面各自订阅:
 *   - CLI: index.ts onQuestion → 渲染问题框; 用户下一行输入即回答 (或 /answer)
 *   - Web/Mobile: server.ts onQuestion → SSE {type:'agent-question'} → 前端渲染选项按钮
 *   - 工具: pi-sdk-tools.ts 的 `clarify` 工具 → ask() 并 await
 *
 * 语义要点:
 *   - 问题落到 ~/.bolloon/user-questions.json, 重启后待处理问题仍在 (人类回来能看到)
 *   - 超时 (默认 600s) → 标记 expired 并如实返回, **不伪造答案**
 *   - 答过的问题不可再答 (幂等, 防 UI 重复点击)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { bolloonHome } from '../bootstrap/env-loader.js';

export type QuestionStatus = 'pending' | 'answered' | 'expired' | 'cancelled';

export interface UserQuestion {
  id: string;
  question: string;
  /** 可选选项 (UI 渲染成可点按钮; 留空表示自由文本回答) */
  choices?: string[];
  /** 允许多选 (choices 非空时有效) */
  multiSelect?: boolean;
  status: QuestionStatus;
  /** 人类回答 (原样保存) */
  answer?: string;
  askedAt: number;
  answeredAt?: number;
  /** 等待上限 (毫秒) */
  timeoutMs: number;
  /** 发起方标识 (cli / web / agent) */
  source?: string;
}

export interface AskOptions {
  question: string;
  choices?: string[];
  multiSelect?: boolean;
  timeoutMs?: number;
  source?: string;
}

export const DEFAULT_QUESTION_TIMEOUT_MS = 600_000;

/** 问题渲染成人类可读文本 (CLI / 日志共用) */
export function formatQuestion(q: UserQuestion): string {
  const opts = (q.choices || []).map((c, i) => `  ${i + 1}. ${c}`).join('\n');
  return `${q.question}${opts ? `\n${opts}` : ''}`;
}

/** 人类回答归一化: "2" → choices[1]; 多选 "1,3" → "a, c" */
export function normalizeAnswer(q: UserQuestion, raw: string): string {
  const text = String(raw ?? '').trim();
  const choices = q.choices || [];
  if (choices.length === 0 || !text) return text;
  const parts = text.split(/[,，、\s]+/).filter(Boolean);
  const allNumeric = parts.length > 0 && parts.every((p) => /^\d+$/.test(p));
  if (!allNumeric) return text;
  const picked = parts
    .map((p) => choices[Number(p) - 1])
    .filter((c): c is string => typeof c === 'string');
  if (picked.length === 0) return text;
  return q.multiSelect ? picked.join(', ') : picked[0];
}

export class UserQuestionStore {
  private items: UserQuestion[] = [];
  private waiters = new Map<string, (q: UserQuestion) => void>();
  private listeners = new Set<(q: UserQuestion) => void>();
  private loaded = false;

  constructor(private file: string = path.join(bolloonHome(), 'user-questions.json')) {}

  /** 延迟加载 (首次访问时读盘; 失败静默 → 空列表) */
  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) this.items = arr;
    } catch { /* 无文件 / 坏文件 → 空 */ }
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      // 只保留最近 50 条 (pending 优先保留)
      const pending = this.items.filter((i) => i.status === 'pending');
      const done = this.items.filter((i) => i.status !== 'pending').slice(-50);
      await fs.writeFile(this.file, JSON.stringify([...pending, ...done], null, 2), 'utf-8');
    } catch { /* 持久化失败不阻塞对话 */ }
  }

  /** 订阅"有新问题"事件 (CLI / Web 各自注册渲染). 返回取消订阅函数 */
  onQuestion(fn: (q: UserQuestion) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** 是否有任何人类界面在监听 (无非交互场景下可以据此提前拒绝提问) */
  hasHumanChannel(): boolean {
    return this.listeners.size > 0;
  }

  async pending(): Promise<UserQuestion[]> {
    await this.load();
    return this.items.filter((i) => i.status === 'pending');
  }

  async get(id: string): Promise<UserQuestion | null> {
    await this.load();
    return this.items.find((i) => i.id === id) ?? null;
  }

  async history(limit = 20): Promise<UserQuestion[]> {
    await this.load();
    return this.items.slice(-limit).reverse();
  }

  /**
   * 提问并等待回答。
   * 返回落定后的问题对象 (status: answered | expired)。**不会抛异常**。
   */
  async ask(opts: AskOptions): Promise<UserQuestion> {
    await this.load();
    const question = String(opts.question ?? '').trim();
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_QUESTION_TIMEOUT_MS;
    const q: UserQuestion = {
      id: `q_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
      question: question || '(空问题)',
      choices: Array.isArray(opts.choices) && opts.choices.length > 0 ? opts.choices.map(String) : undefined,
      multiSelect: !!opts.multiSelect,
      status: 'pending',
      askedAt: Date.now(),
      timeoutMs,
      source: opts.source,
    };
    this.items.push(q);
    await this.save();

    const wait = new Promise<UserQuestion>((resolve) => {
      const timer = setTimeout(async () => {
        // 定时器到点: 若仍在等 → 标记 expired (如实返回, 不伪造答案)
        if (this.waiters.delete(q.id) && q.status === 'pending') {
          q.status = 'expired';
          // 落盘要先于 resolve: 否则调用方 (或人类界面) 紧接着读盘时可能看不到这条记录
          await this.save();
        }
        resolve(q);
      }, timeoutMs);
      (timer as any).unref?.();  // 不拖住进程退出
      this.waiters.set(q.id, (settled) => { clearTimeout(timer); resolve(settled); });
    });

    for (const fn of this.listeners) {
      try { fn(q); } catch { /* 单个订阅者失败不影响其他 */ }
    }
    return wait;
  }

  /** 人类回答。id 可省略 (取最早 pending 的一个)。返回 { ok, question?, error? } */
  async answer(id: string | null, raw: string): Promise<{ ok: boolean; question?: UserQuestion; error?: string }> {
    await this.load();
    const q = id
      ? this.items.find((i) => i.id === id)
      : (await this.pending())[0];
    if (!q) return { ok: false, error: '没有待回答的问题' };
    if (q.status === 'answered') return { ok: false, question: q, error: '这个问题已经回答过了' };
    if (q.status !== 'pending') return { ok: false, question: q, error: `问题已 ${q.status}, 不再接受回答` };
    q.answer = normalizeAnswer(q, raw);
    q.status = 'answered';
    q.answeredAt = Date.now();
    await this.save();
    const waiter = this.waiters.get(q.id);
    if (waiter) {
      this.waiters.delete(q.id);
      waiter(q);
    }
    return { ok: true, question: q };
  }

  /** 取消一个待处理问题 (agent 决定不再等) */
  async cancel(id: string, reason = 'agent 取消'): Promise<boolean> {
    await this.load();
    const q = this.items.find((i) => i.id === id);
    if (!q || q.status !== 'pending') return false;
    q.status = 'cancelled';
    q.answer = q.answer ?? `(${reason})`;
    await this.save();
    const waiter = this.waiters.get(q.id);
    if (waiter) { this.waiters.delete(q.id); waiter(q); }
    return true;
  }

  /** 测试用: 清空内存状态 */
  __resetForTest(): void {
    this.items = [];
    this.waiters.clear();
    this.listeners.clear();
    this.loaded = false;
  }
}

export const userQuestions = new UserQuestionStore();
