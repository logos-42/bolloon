/**
 * 工具调用遥测 (2026-10-01, 用户: 「开始吧, 把这些事儿做完」—— 优化方向 #3)。
 *
 * 问题: 我们要"让工具调用变好", 但**没有任何度量** ✗ ⇒ 全靠感觉。这条先把"浪费在哪"变成数字。
 * 记录 (每行一条 JSONL): 工具名 · 参数指纹 · 耗时 · 成功/失败 · 结果字符数 · **是否与上一次同签名**。
 * 由此可算: 每任务调用次数 · **重复率** · 结果体量分布 · 慢工具排行 —— 后面每一条优化的效果都可证伪 ✓。
 * 纪律: **fire-and-forget**(写失败绝不影响工具执行) · 只落本机数据目录 · 不记参数正文(只记指纹,
 *   免得把用户的密钥/正文写进日志 ✓)。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function telemetryDir(home = os.homedir()): string {
  return path.join(home, '.bolloon', 'logs');
}
export function telemetryPath(home = os.homedir()): string {
  return path.join(telemetryDir(home), 'tool-calls.jsonl');
}

/** 参数指纹: 只留结构, 不留值 (工具名 + 参数键名 + 值长度) —— 避免把秘密写进日志 */
export function argsFingerprint(args: unknown): string {
  try {
    const o = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const shape = Object.keys(o).sort().map((k) => {
      const v = (o as any)[k];
      const kind = Array.isArray(v) ? `arr${v.length}` : typeof v === 'string' ? `str${v.length}` : typeof v;
      return `${k}:${kind}`;
    }).join(',');
    return createHash('sha256').update(`${shape}`).digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

export interface ToolCallRecord {
  ts: string;
  tool: string;
  sig: string;
  ms: number;
  ok: boolean;
  resultChars: number;
  /** 与**上一次**调用是否完全同签名 (重复调用的第一手证据) */
  repeatOfPrev: boolean;
  /** 失败时的错误类别 (算"错工具率"用; 成功为空) */
  errorClass?: string;
}

/** 追加一条 (绝不影响调用方) */
export function recordToolCall(
  rec: Omit<ToolCallRecord, 'ts' | 'repeatOfPrev'> & { home?: string; prevSig?: string | null },
): ToolCallRecord | null {
  try {
    const home = rec.home || os.homedir();
    const dir = telemetryDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const row: ToolCallRecord = {
      ts: new Date().toISOString(),
      tool: String(rec.tool || '?'),
      sig: String(rec.sig || '?'),
      ms: Math.max(0, Math.round(Number(rec.ms) || 0)),
      ok: !!rec.ok,
      resultChars: Math.max(0, Math.round(Number(rec.resultChars) || 0)),
      repeatOfPrev: !!rec.prevSig && rec.prevSig === rec.sig,
      ...(rec.errorClass ? { errorClass: String(rec.errorClass).slice(0, 40) } : {}),
    };
    fs.appendFileSync(telemetryPath(home), JSON.stringify(row) + '\n', 'utf-8');
    return row;
  } catch {
    return null;
  }
}

export interface TelemetrySummary {
  calls: number;
  repeats: number;
  repeatRate: number;
  okRate: number;
  /** 失败按错误类别计数 ⇒ "错工具率"可从这类错误里看出来 */
  errorsByClass: Array<{ cls: string; n: number }>;
  resultChars: number;
  avgMs: number;
  topTools: Array<{ tool: string; n: number }>;
  slowest: Array<{ tool: string; ms: number }>;
  biggestResults: Array<{ tool: string; chars: number }>;
}

/** 汇总 (给"优化前/后"对比用): 读回 JSONL, 算重复率/体量/慢工具 */
export function summarizeTelemetry(home = os.homedir(), limit = 5000): TelemetrySummary {
  const empty: TelemetrySummary = { calls: 0, repeats: 0, repeatRate: 0, okRate: 0, resultChars: 0, avgMs: 0, errorsByClass: [], topTools: [], slowest: [], biggestResults: [] };
  try {
    const file = telemetryPath(home);
    if (!fs.existsSync(file)) return empty;
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).slice(-limit);
    const rows: ToolCallRecord[] = [];
    for (const l of lines) { try { rows.push(JSON.parse(l)); } catch { /* 跳过坏行 */ } }
    if (!rows.length) return empty;
    const byTool = new Map<string, number>();
    for (const r of rows) byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
    const sum = (f: (r: ToolCallRecord) => number) => rows.reduce((a, r) => a + f(r), 0);
    const calls = rows.length;
    const repeats = rows.filter((r) => r.repeatOfPrev).length;
    return {
      calls,
      repeats,
      repeatRate: Number((repeats / calls).toFixed(3)),
      okRate: Number((rows.filter((r) => r.ok).length / calls).toFixed(3)),
      errorsByClass: [...rows.filter((r) => !r.ok).reduce((m, r) => m.set(r.errorClass || '未分类', (m.get(r.errorClass || '未分类') || 0) + 1), new Map<string, number>()).entries()].map(([cls, n]) => ({ cls, n })).sort((a, b) => b.n - a.n).slice(0, 8),
      resultChars: sum((r) => r.resultChars),
      avgMs: Math.round(sum((r) => r.ms) / calls),
      topTools: [...byTool.entries()].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n).slice(0, 10),
      slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5).map((r) => ({ tool: r.tool, ms: r.ms })),
      biggestResults: [...rows].sort((a, b) => b.resultChars - a.resultChars).slice(0, 5).map((r) => ({ tool: r.tool, chars: r.resultChars })),
    };
  } catch {
    return empty;
  }
}
