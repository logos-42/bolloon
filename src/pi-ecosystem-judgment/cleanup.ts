/**
 * Judgment Cleanup — 检测并清理测试/灌水数据
 *
 * 垃圾来源:
 *   1. 早期 test 文件直接调 storeHumanJudgment() 写 test fixture
 *   2. 用户在 UI 「记录」时随手输的测试文本
 *   3. D-hook (AI 自动蒸馏) 在 LLM 抽风时存了无意义内容
 *
 * 设计原则:
 *   - 启发式检测, 不依赖外部 LLM (避免循环依赖)
 *   - 删除 = 软删除 (status='rejected'), 保留审计追溯
 *   - 写入时拦截 (storeHumanJudgment) + 读取时过滤 (getRelevantValues) 双保险
 */

import type { HumanJudgment } from './human-value-store.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * 命中任一即视为垃圾
 * 注: 都是精确短语, 不会误伤含 "测试" 但有实质内容的判断力
 */
export const JUNK_DECISION_PATTERNS: RegExp[] = [
  /^loadAll\s*测试[你您\s:：/_-]*$/i,
  /^Bolloon\s*bootstrap\s*测试[你您原则]*$/i,
  /^[涨升]?\s*(rising|stale|cache|unused|健康|稳定|rising|上升|下降)\s*原则$/i,
  /^(测试|test|example|示例)\s*$/i,
  /^[测试tT]+$/,
  /^(foo|bar|baz|hello world)\s*$/i,
];

/**
 * 综合启发式: 内容是否像测试灌水?
 */
export function isJunkJudgment(j: HumanJudgment | null | undefined): boolean {
  if (!j || typeof j !== 'object') return true;
  const decision = String(j.decision ?? '').trim();
  if (!decision) return true;  // 完全空 = 必定垃圾

  // 启发式 1: 决策文本命中已知垃圾 pattern
  if (JUNK_DECISION_PATTERNS.some((re) => re.test(decision))) return true;

  // 启发式 2: 短决策 + 无 values + 无 reasons (实质内容缺失)
  const hasValues = Array.isArray(j.values_derived) && j.values_derived.length > 0;
  const hasReasons = Array.isArray(j.reasons) && j.reasons.length > 0 &&
    j.reasons.some((r) => r && String(r).trim().length > 0);
  if (!hasValues && !hasReasons && decision.length < 12) return true;

  // 启发式 3: data corruption — 无 timestamp, 无 domain, decision 短
  const hasTs = !!j.timestamp;
  const domain = j.context?.domain;
  if (!hasTs && (!domain || domain === 'general') && decision.length < 12) return true;

  // 启发式 4: decision 全是 whitespace / 标点 / 重复字符
  if (/^[.\s,。、，\-_=:;!?]{0,8}$/.test(decision)) return true;
  if (/^(.)\1{3,}$/.test(decision)) return true;  // "aaaa"

  return false;
}

/**
 * 把判断力分桶: kept (可保留) + removed (应清理)
 */
export function classifyJudgments(
  judgments: HumanJudgment[],
  opts: { softDelete?: boolean } = {}
): { kept: HumanJudgment[]; removed: HumanJudgment[] } {
  const kept: HumanJudgment[] = [];
  const removed: HumanJudgment[] = [];
  const softDelete = opts.softDelete !== false;  // 默认软删除
  for (const j of judgments) {
    if (isJunkJudgment(j)) {
      // 软删除: 标记 status='rejected' 而非真正移除, 保留审计追溯
      if (softDelete) {
        removed.push({ ...j, status: 'rejected' as any });
      } else {
        removed.push(j);
      }
    } else {
      kept.push(j);
    }
  }
  return { kept, removed };
}

const VALUE_STORE_DIR = path.join(os.homedir(), '.bolloon', 'human-values');
const JUDGMENTS_FILE = path.join(VALUE_STORE_DIR, 'judgments.json');

async function ensureDir(): Promise<void> {
  await fs.mkdir(VALUE_STORE_DIR, { recursive: true });
}

async function readJudgmentsFile(): Promise<HumanJudgment[]> {
  await ensureDir();
  try {
    const raw = await fs.readFile(JUDGMENTS_FILE, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * 干跑 (推荐先跑这个看会清除多少):
 *   返回报告, 不写盘
 */
export async function dryCleanup(): Promise<{
  totalBefore: number;
  totalAfter: number;
  removed: number;
  sample: Array<{ id: string; decision: string }>;
}> {
  const judgments = await readJudgmentsFile();
  const { kept, removed } = classifyJudgments(judgments, { softDelete: false });
  return {
    totalBefore: judgments.length,
    totalAfter: kept.length,
    removed: removed.length,
    sample: removed.slice(0, 10).map((j) => ({ id: j.id, decision: j.decision })),
  };
}

/**
 * 实际清理: 软删除 + 写回磁盘
 * 保留 status='rejected' 的记录在盘上 (审计追溯)
 */
export async function runCleanup(): Promise<{
  totalBefore: number;
  totalAfter: number;
  removed: number;
}> {
  const judgments = await readJudgmentsFile();
  const { kept, removed } = classifyJudgments(judgments, { softDelete: true });
  const finalized = [...kept, ...removed];
  await fs.writeFile(JUDGMENTS_FILE, JSON.stringify(finalized, null, 2), 'utf-8');
  return {
    totalBefore: judgments.length,
    totalAfter: kept.length,
    removed: removed.length,
  };
}
