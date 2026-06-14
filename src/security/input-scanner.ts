/**
 * input-scanner.ts — P-Action 3 Untrusted-input scanner
 *
 * 4 仓库共识 (deusyu / walkinglabs / 马书 / AHE):
 *   - deusyu: 7+ 层防 prompt injection, 上游有 Unicode NFKC / 显式字符范围
 *   - walkinglabs bootstrap stage 4: 安全敏感代码只在信任边界后才加载
 *   - 马书 ch17b: 7 层防注入 (Unicode NFKC + \\p{Cf}/\\p{Co}/\\p{Cn} + 显式字符范围 +
 *     迭代 10 轮上限 + XML 转义 + 29 个来源标签)
 *   - AHE: E2B sandbox + input scanner 拦截跨机器不可信输入
 *
 * bolloon 定位 (cross-check 选边):
 *   - **library 函数**, 不做 middleware (跟 tool-gate.ts 8 kinds 一致)
 *   - 默认 silence-on-fail + log-only; BOLLOON_INPUT_SCAN=block 才 hard-reject
 *   - 保守 PII: P2P 跳 PII+prompt-injection; judgment 摄入只跳 prompt-injection
 *     (judgment 决策文本含人话是合法的)
 *
 * 4 层 verdict (你已选 "四层 + fail-open 隐式"):
 *   - pass     — 无威胁
 *   - low      — 可疑特征 (whitespace 异常等), 静默
 *   - warn     — PII 2 个以上 / 提示注入模式但需验证, log + tag (默认)
 *   - fail-safe — 扫描器内部异常, log (隐式, 失败时安全侧)
 *   - block    — CVE-级 prompt injection / 明显密钥, 阻断 (需 BOLLOON_INPUT_SCAN=block)
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type Verdict = 'pass' | 'low' | 'warn' | 'fail-safe' | 'block';

export type ThreatKind =
  | 'prompt-injection-classic'      // "ignore previous instructions" / "system: ..." 等
  | 'prompt-injection-unicode'     // Unicode 隐藏字符 (\\p{Cf}/\\p{Co}/\\p{Cn} 异常密度)
  | 'prompt-injection-jailbreak'    // "DAN" / role-play override 等
  | 'pii-email'                     // 含邮箱
  | 'pii-phone'                     // 含手机号
  | 'pii-creditcard'                // 含信用卡 (Luhn 校验)
  | 'pii-privatekey'                // 含 RSA / EC 私钥头
  | 'secret-aws'                    // AWS access key
  | 'secret-github'                 // GitHub PAT
  | 'whitespace-anomaly'           // 大量零宽字符 / 多空格
  | 'oversize';                     // 输入超长

export interface ThreatHit {
  kind: ThreatKind;
  /** 命中位置 (字节 offset) */
  offset?: number;
  /** 简短证据 (前 60 字符) */
  evidence?: string;
}

export interface ScanResult {
  verdict: Verdict;
  threats: ThreatHit[];
  /** 输入源 (供 audit log 归因) */
  source: 'p2p' | 'judgment' | 'other';
  /** 扫描耗时 ms */
  durationMs: number;
  /** 扫描器是否自身异常 (true = 静默 pass, 写 audit 'fail-safe') */
  scannerFailed: boolean;
}

export interface ScanOptions {
  source: 'p2p' | 'judgment' | 'other';
  /** 是否扫描 PII (默认: p2p=true, judgment=false) */
  scanPii?: boolean;
  /** 输入字节上限 (超过直接 verdict=block, threats=oversize) */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1_000_000;  // 1MB

// ============================================================
// 规则
// ============================================================

const PI_PATTERNS: Array<{ kind: ThreatKind; re: RegExp }> = [
  { kind: 'pii-email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { kind: 'pii-phone', re: /(?<!\d)(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g },
];

const SECRET_PATTERNS: Array<{ kind: ThreatKind; re: RegExp }> = [
  { kind: 'pii-privatekey', re: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP) PRIVATE KEY-----/g },
  { kind: 'secret-aws', re: /AKIA[0-9A-Z]{16}/g },
  { kind: 'secret-github', re: /ghp_[A-Za-z0-9]{36}/g },
];

// 经典 prompt injection 模式 (高确信度 → block)
const INJECTION_CLASSIC: RegExp[] = [
  /ignore\s+(?:all\s+)?previous\s+instructions/i,
  /disregard\s+(?:all\s+)?(?:prior|previous)\s+(?:instructions|rules)/i,
  /forget\s+(?:everything|all)\s+(?:above|before)/i,
  /you\s+are\s+now\s+(?:a|an)\s+(?:unrestricted|jailbroken|DAN)/i,
  /new\s+system\s*:\s*you\s+are/i,
];

// 软提示注入 (需结合上下文验证 → warn, 不直接 block)
const INJECTION_SOFT: RegExp[] = [
  /\bact\s+as\s+(?:a|an)\s+(?:developer\s+mode|root\s+admin)/i,
  /\boverride\s+(?:safety|content)\s+(?:filter|policy)/i,
  /\bDAN\s+mode\b/i,
];

// Unicode 隐藏字符密度检测 (\\p{Cf}=Format, \\p{Co}=Private Use, \\p{Cn}=Unassigned)
const HIDDEN_CHAR_RE = /[\p{Cf}\p{Co}\p{Cn}]/gu;
const WHITESPACE_ANOMALY_RE = /[​-‏﻿]{5,}/g;

// 信用卡 (Luhn 简化)
function luhnValid(num: string): boolean {
  const digits = num.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ============================================================
// 主入口
// ============================================================

export function scanInput(input: string | Buffer, opts: ScanOptions): ScanResult {
  const start = Date.now();
  const source = opts.source;
  const scanPii = opts.scanPii ?? (source === 'p2p');  // 默认 P2P=true, judgment=false
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;

  try {
    // 0. 长度超限 → 直接 block
    if (buf.length > maxBytes) {
      return {
        verdict: 'block',
        threats: [{ kind: 'oversize', evidence: `${buf.length} > ${maxBytes}` }],
        source,
        durationMs: Date.now() - start,
        scannerFailed: false,
      };
    }

    const text = buf.toString('utf-8');
    const threats: ThreatHit[] = [];

    // 1. 经典 prompt injection → block
    for (const re of INJECTION_CLASSIC) {
      const m = text.match(re);
      if (m) {
        threats.push({ kind: 'prompt-injection-classic', offset: m.index, evidence: m[0].substring(0, 60) });
      }
    }

    // 2. 软注入 → warn
    for (const re of INJECTION_SOFT) {
      const m = text.match(re);
      if (m) {
        threats.push({ kind: 'prompt-injection-jailbreak', offset: m.index, evidence: m[0].substring(0, 60) });
      }
    }

    // 3. Unicode 隐藏字符 → warn (高密度时)
    const hiddenMatches = [...text.matchAll(HIDDEN_CHAR_RE)];
    if (hiddenMatches.length > 5) {
      threats.push({ kind: 'prompt-injection-unicode', evidence: `${hiddenMatches.length} hidden chars` });
    }

    // 4. whitespace 异常 (5+ 连续零宽) → low
    if (WHITESPACE_ANOMALY_RE.test(text)) {
      threats.push({ kind: 'whitespace-anomaly' });
    }

    // 5. PII (仅 p2p / other, judgment 跳过)
    if (scanPii) {
      for (const { kind, re } of PI_PATTERNS) {
        const matches = [...text.matchAll(re)];
        for (const m of matches) {
          threats.push({ kind, offset: m.index, evidence: m[0].substring(0, 60) });
        }
      }
      // 信用卡需要 Luhn
      const ccRe = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
      const ccMatches = [...text.matchAll(ccRe)];
      for (const m of ccMatches) {
        if (luhnValid(m[0])) {
          threats.push({ kind: 'pii-creditcard', offset: m.index, evidence: m[0].substring(0, 60) });
        }
      }
    }

    // 6. 密钥 (无论 source)
    for (const { kind, re } of SECRET_PATTERNS) {
      const matches = [...text.matchAll(re)];
      for (const m of matches) {
        threats.push({ kind, offset: m.index, evidence: m[0].substring(0, 60) });
      }
    }

    // 聚合 verdict
    const verdict = aggregateVerdict(threats);
    return {
      verdict,
      threats,
      source,
      durationMs: Date.now() - start,
      scannerFailed: false,
    };
  } catch (err) {
    // 扫描器自身异常 → fail-safe (隐式)
    console.warn('[input-scanner] scanInput failed (silent, fail-safe):', err);
    return {
      verdict: 'pass',  // 失败时安全侧 (不阻断)
      threats: [],
      source,
      durationMs: Date.now() - start,
      scannerFailed: true,
    };
  }
}

function aggregateVerdict(threats: ThreatHit[]): Verdict {
  if (threats.length === 0) return 'pass';
  if (threats.some((t) => t.kind === 'prompt-injection-classic' || t.kind === 'pii-privatekey' || t.kind === 'secret-aws' || t.kind === 'secret-github' || t.kind === 'pii-creditcard' || t.kind === 'oversize')) {
    return 'block';
  }
  // prompt-injection-unicode + jailbreak + pii 多数 → warn
  const warnCount = threats.filter((t) =>
    t.kind === 'prompt-injection-unicode' ||
    t.kind === 'prompt-injection-jailbreak' ||
    t.kind.startsWith('pii-') ||
    t.kind.startsWith('secret-')
  ).length;
  if (warnCount >= 2) return 'warn';
  if (warnCount >= 1) return 'warn';
  return 'low';
}

// ============================================================
// Audit log
// ============================================================

const AUDIT_PATH = () => path.join(
  process.env.HOME || os.homedir() || '/tmp',
  '.bolloon', 'sessions', 'input-scan-audit.jsonl'
);

export async function writeScanAudit(result: ScanResult, context?: Record<string, unknown>): Promise<void> {
  // 只记 verdict 异常 + 失败, 减少噪音
  if (result.verdict === 'pass' && !result.scannerFailed) return;
  try {
    await fs.mkdir(path.dirname(AUDIT_PATH()), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      source: result.source,
      verdict: result.verdict,
      threatCount: result.threats.length,
      threatKinds: [...new Set(result.threats.map((t) => t.kind))],
      scannerFailed: result.scannerFailed,
      durationMs: result.durationMs,
      context: context ?? null,
    };
    await fs.appendFile(AUDIT_PATH(), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn('[input-scanner] writeScanAudit failed (silent):', err);
  }
}

/** BOLLOON_INPUT_SCAN=block 时, block 才是真阻断; 否则全默认 pass */
export function shouldHardBlock(result: ScanResult): boolean {
  if (result.scannerFailed) return false;  // 失败永不禁
  if (result.verdict !== 'block') return false;
  return process.env.BOLLOON_INPUT_SCAN === 'block';
}

// ============================================================
// 测试钩子
// ============================================================

export function _resetScannerForTest(): void {
  // scanner 是 pure, 保留 API 一致
}
