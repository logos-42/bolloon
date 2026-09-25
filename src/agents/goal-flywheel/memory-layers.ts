/**
 * memory-layers.ts — P1b: Memory 分层 (落盘 + 过期归档) (2026-09-25)
 *
 * 归属: `docs/wiki/goal-continuation-flywheel.md` §13「P1b Memory/Skill」独占文件。
 * 本文件**只**实现 §14 冻结签名里的 `writeMemoryRecords` / `expireTemporary`, 不碰任何现有调用方,
 * 也不 import 其它阶段的实现 (§13: 阶段之间只通过 `types.ts` 的类型耦合)。
 *
 * 分层语义 (types.ts §3 的类型在**写入时**也要被真的执行, 不能只写在类型上):
 *
 * | 层 | 落盘规则 |
 * | --- | --- |
 * | `run_fact` | `assertion='confirmed'` 必须有 `confirmedRefs` (推测永不当证据); `assertion='inferred'` 不许带 `confirmedRefs` |
 * | `lesson` | 必须有 `reviewedBy`, 且 `reviewVerdict='reusable'` —— `one_off` **不落盘** |
 * | `decision` | `sourceRef` 必填 (涉用户偏好/重要取舍必须保留来源) |
 * | `skill_signal` | `promotesDirectly` 必须为 `false` (类型级陈述在运行期也要拦) |
 * | `temporary` | `expiresAt` 合法且 **晚于 now**; 已过期/不合法 → 拒绝 (不许写入即死数据) |
 *
 * 落盘布局 (与 `goal-store.ts` 同一手法: 每条例行一个 JSON, 原子写 tmp+rename):
 *   `<home>/.bolloon/memory-layers/<layer>/<memoryId 转义>.json`
 *   —— `home` 由调用方注入 (便于测试), 不读真实 `os.homedir()`。
 *
 * 幂等: 同一 `memoryId` 且内容逐字相同 → 视为已写入 (不重复落盘, 计入 `written`);
 *       同一 `memoryId` 但内容不同 → 拒绝 (`duplicate_memory_id`), **绝不覆盖**已有记忆。
 *
 * 阴性对照 (怎么知道这些门不是空转): 把 `assertion='confirmed'` 的来源检查删掉 →
 * 「confirmed 无来源必须被拒」立刻判红; 把 `expireTemporary` 的 `> now` 改成「永不归档」→
 * 「到期必须归档」立刻判红。见 `src/test/goal-flywheel-memory.test.ts`。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { MEMORY_LAYERS } from './types.js';
import type { IsoTimestamp, MemoryRecord, TemporaryMemory } from './types.js';

// ---------------------------------------------------------------------------
// 对外常量 (结构化原因 / 布局)
// ---------------------------------------------------------------------------

/** 记忆落盘根 (相对注入的 `home`) */
export const MEMORY_LAYERS_ROOT = '.bolloon/memory-layers';

/** 写入被拒的结构化原因 (不许只返回 boolean) */
export const MEMORY_REJECT_REASONS = [
  'invalid_memory_id',                 // memoryId 为空
  'unknown_layer',                     // layer 不在 MEMORY_LAYERS 里
  'empty_content',                     // 内容为空 (空记忆没有意义)
  'unknown_assertion',                 // assertion 不是 confirmed/inferred
  'confirmed_fact_without_source',     // confirmed 事实没有来源 (推测当证据)
  'inferred_fact_cannot_confirm',      // inferred 事实带了 confirmedRefs (混淆确定性)
  'lesson_without_reviewer',           // lesson 没有 reviewedBy
  'lesson_not_reusable',               // lesson 的 reviewVerdict 不是 reusable (one_off)
  'decision_without_source',           // decision 没有 sourceRef
  'skill_signal_cannot_promote',       // skill_signal.promotesDirectly 不是 false
  'skill_signal_without_candidate',    // skill_signal 没有 candidateId
  'temporary_without_valid_expiry',    // temporary 的 expiresAt 不合法 / archiveAtRunEnd 不是 true
  'temporary_already_expired',         // 写入时已经过期 (写进去就是死数据)
  'duplicate_memory_id',               // 同 id 已存在且内容不同 (不许覆盖)
] as const;
export type MemoryRejectReason = (typeof MEMORY_REJECT_REASONS)[number];

/** `writeMemoryRecords` 的返回 (与 §14 冻结签名一致) */
export interface MemoryWriteResult {
  written: string[];
  rejected: { memoryId: string; reason: string }[];
}

// ---------------------------------------------------------------------------
// 小工具 (纯)
// ---------------------------------------------------------------------------

const NON_EMPTY = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** 是否是合法 ISO 时间戳 (本仓时间一律注入, 且必须是能解析的 ISO) */
function isValidIso(v: unknown): v is string {
  if (typeof v !== 'string' || v.trim().length === 0) return false;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(v)) return false;
  return Number.isFinite(Date.parse(v));
}

function assertNow(now: IsoTimestamp, who: string): number {
  if (!isValidIso(now)) {
    throw new Error(`${who}: now 必须是合法 ISO 时间戳 (收到 ${JSON.stringify(now)})`);
  }
  return Date.parse(now);
}

/** memoryId → 文件名 (Windows 文件名不含 `:`; 见 AGENTS.md §5.1) */
export function memoryFileName(memoryId: string): string {
  const safe = String(memoryId).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe.length > 0 ? safe : 'unnamed'}.json`;
}

/** 一条记忆的落盘路径 (导出给调用方/测试核对, 避免两处各手抄一份布局) */
export function memoryFilePath(home: string, record: Pick<MemoryRecord, 'layer' | 'memoryId'>): string {
  return path.join(home, MEMORY_LAYERS_ROOT, record.layer, memoryFileName(record.memoryId));
}

// ---------------------------------------------------------------------------
// 写入时的分层校验
// ---------------------------------------------------------------------------

/** 校验一条记忆能不能落盘; 通过返回 null, 否则返回结构化原因 */
export function validateMemoryRecordForWrite(record: MemoryRecord, now: IsoTimestamp): MemoryRejectReason | null {
  const nowMs = assertNow(now, 'validateMemoryRecordForWrite');

  if (!NON_EMPTY(record.memoryId)) return 'invalid_memory_id';
  if (!(MEMORY_LAYERS as readonly string[]).includes(record.layer)) return 'unknown_layer';
  if (!NON_EMPTY(record.content)) return 'empty_content';

  switch (record.layer) {
    case 'run_fact': {
      const confirmed = (record.confirmedRefs ?? []).filter(NON_EMPTY);
      if (record.assertion === 'confirmed') {
        if (confirmed.length === 0) return 'confirmed_fact_without_source';
        return null;
      }
      if (record.assertion === 'inferred') {
        // 推测永远不允许携带"已确认来源" (两者互斥)
        if (confirmed.length > 0) return 'inferred_fact_cannot_confirm';
        return null;
      }
      return 'unknown_assertion';
    }
    case 'lesson': {
      if (!NON_EMPTY(record.reviewedBy)) return 'lesson_without_reviewer';
      if (record.reviewVerdict !== 'reusable') return 'lesson_not_reusable';
      return null;
    }
    case 'decision': {
      if (!NON_EMPTY(record.sourceRef)) return 'decision_without_source';
      return null;
    }
    case 'skill_signal': {
      // 类型上是字面量 false; 运行期也要拦 (别让 `as any` 把转正权带进来)
      if (record.promotesDirectly !== false) return 'skill_signal_cannot_promote';
      if (!NON_EMPTY(record.candidateId)) return 'skill_signal_without_candidate';
      return null;
    }
    case 'temporary': {
      if (record.archiveAtRunEnd !== true) return 'temporary_without_valid_expiry';
      if (!isValidIso(record.expiresAt)) return 'temporary_without_valid_expiry';
      if (Date.parse(record.expiresAt) <= nowMs) return 'temporary_already_expired';
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// §14 冻结签名 ①: writeMemoryRecords
// ---------------------------------------------------------------------------

/**
 * 把一批分层记忆写入 `<home>/.bolloon/memory-layers/`。
 *
 * 逐条独立判定: 一条被拒不影响同批其它条 (返回里 `written` + `rejected` 恰好等于输入条数)。
 * 被拒的记录**不落地任何文件** (不许"先写坏再回滚")。
 */
export async function writeMemoryRecords(
  home: string,
  records: MemoryRecord[],
  now: IsoTimestamp,
): Promise<MemoryWriteResult> {
  if (!NON_EMPTY(home)) throw new Error('writeMemoryRecords: home 必填 (调用方注入, 不许猜)');
  assertNow(now, 'writeMemoryRecords');

  const written: string[] = [];
  const rejected: { memoryId: string; reason: string }[] = [];
  const inBatch = new Set<string>();

  for (const record of records) {
    const id = typeof record?.memoryId === 'string' ? record.memoryId : '';

    const reason = validateMemoryRecordForWrite(record, now);
    if (reason !== null) {
      rejected.push({ memoryId: id, reason });
      continue;
    }

    if (inBatch.has(id)) {
      rejected.push({ memoryId: id, reason: 'duplicate_memory_id' });
      continue;
    }

    const filePath = memoryFilePath(home, record);
    const payload = JSON.stringify(record, null, 2);

    let existing: string | null = null;
    try {
      existing = await fs.readFile(filePath, 'utf8');
    } catch {
      existing = null;
    }

    if (existing !== null) {
      // 同 id 且逐字相同 → 幂等 (不重复落盘); 内容不同 → 拒绝, 绝不覆盖
      if (existing.trim() === payload.trim()) {
        inBatch.add(id);
        written.push(id);
      } else {
        rejected.push({ memoryId: id, reason: 'duplicate_memory_id' });
      }
      continue;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, filePath);

    inBatch.add(id);
    written.push(id);
  }

  return { written, rejected };
}

// ---------------------------------------------------------------------------
// §14 冻结签名 ②: expireTemporary (纯函数, 不碰 I/O)
// ---------------------------------------------------------------------------

/**
 * 按时间把 `temporary` 层分成"留"与"归档"。**纯函数** (零 I/O, 不改入参, 保序)。
 *
 * 只有同时满足三条的 temporary 才留:
 *   ① `archiveAtRunEnd === true` (类型级陈述在运行期复核)
 *   ② `expiresAt` 是合法 ISO
 *   ③ `expiresAt > now` (**到点即归档**, 边界取等号算过期)
 * 其余 temporary 一律归档 —— 拿不出"未过期"证据的临时记忆不许长期留着。
 * 非 temporary 的记录**永不**被归档 (哪怕字段看起来过期)。
 */
export function expireTemporary(
  records: MemoryRecord[],
  now: IsoTimestamp,
): { kept: MemoryRecord[]; archived: TemporaryMemory[] } {
  const nowMs = assertNow(now, 'expireTemporary');

  const kept: MemoryRecord[] = [];
  const archived: TemporaryMemory[] = [];

  for (const record of records) {
    if (record.layer !== 'temporary') {
      kept.push(record);
      continue;
    }
    const live =
      record.archiveAtRunEnd === true &&
      isValidIso(record.expiresAt) &&
      Date.parse(record.expiresAt) > nowMs;
    if (live) kept.push(record);
    else archived.push(record);
  }

  return { kept, archived };
}
