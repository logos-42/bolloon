/**
 * goal-flywheel-memory.test.ts — P1b Memory 分层 (`memory-layers.ts`) 单测 (2026-09-25)
 *
 * 验的是「分层约束真的被执行」, 不是"函数被调用过":
 *   ① 五层各自能落盘, 且真落在 `<home>/.bolloon/memory-layers/<layer>/<id>.json` (读回逐字比对)
 *   ② **负控制**: 每条分层规则都有一个"该被拒的用例真的被拒" (confirmed 无来源 / one_off lesson /
 *      decision 无 sourceRef / skill_signal 想直接转正 / 已过期 temporary …), 且被拒记录**不落地文件**
 *   ③ 幂等与不覆盖: 同 id 同内容 → 幂等; 同 id 不同内容 → 拒 (`duplicate_memory_id`), 原文件不动
 *   ④ `expireTemporary` 是纯函数 (保序 / 守恒 / 不改入参 / 非 temporary 永不归档)
 *   ⑤ 源级: 只 import `./types.js` + node 内置 (阶段间不靠 import 实现耦合, §13)
 *
 * 变异验证 (报告里给数字): 删掉 confirmed 的来源检查 / 把 `> now` 改成永不归档 → 本文件判红。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  writeMemoryRecords,
  expireTemporary,
  validateMemoryRecordForWrite,
  memoryFilePath,
  memoryFileName,
  MEMORY_REJECT_REASONS,
  MEMORY_LAYERS_ROOT,
} from '../agents/goal-flywheel/memory-layers.js';

import type {
  MemoryRecord,
  RunFactMemory,
  LessonMemory,
  DecisionMemory,
  SkillSignalMemory,
  TemporaryMemory,
  IsoTimestamp,
} from '../agents/goal-flywheel/types.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW: IsoTimestamp = '2026-09-25T10:00:00.000Z';
const LATER: IsoTimestamp = '2026-09-25T11:00:00.000Z';
const EARLIER: IsoTimestamp = '2026-09-25T09:00:00.000Z';

const base = {
  goalId: 'g-1',
  runId: 'r-1',
  evidenceRefs: ['step:3'],
  createdAt: NOW,
};

const runFact = (over: Partial<RunFactMemory> = {}): RunFactMemory => ({
  ...base,
  memoryId: 'm-fact-1',
  layer: 'run_fact',
  content: 'curl 探针返回 200',
  assertion: 'confirmed',
  confirmedRefs: ['step:3'],
  ...over,
});

const lesson = (over: Partial<LessonMemory> = {}): LessonMemory => ({
  ...base,
  memoryId: 'm-lesson-1',
  layer: 'lesson',
  content: '先打探针再改配置',
  reviewedBy: 'reviewer-a',
  reviewVerdict: 'reusable',
  methodEffective: '先探针',
  methodFailed: '直接改配置',
  nextTimeChange: '每次改前先探针',
  ...over,
});

const decision = (over: Partial<DecisionMemory> = {}): DecisionMemory => ({
  ...base,
  memoryId: 'm-dec-1',
  layer: 'decision',
  content: '选 A 方案而不是 B',
  sourceRef: 'user:chat-9',
  decidedBy: 'leo',
  userPreference: true,
  alternatives: ['B 方案'],
  ...over,
});

const skillSignal = (over: Partial<SkillSignalMemory> = {}): SkillSignalMemory => ({
  ...base,
  memoryId: 'm-sig-1',
  layer: 'skill_signal',
  content: '这个流程可能值得做成 skill',
  candidateId: 'cand-1',
  promotesDirectly: false,
  ...over,
});

const temporary = (expiresAt: IsoTimestamp, over: Partial<TemporaryMemory> = {}): TemporaryMemory => ({
  ...base,
  memoryId: 'm-tmp-1',
  layer: 'temporary',
  content: '本次会话的临时索引',
  expiresAt,
  archiveAtRunEnd: true,
  ...over,
});

/** 故意造出运行期非法值 (类型上是字面量, 用 `as unknown as` 绕过编译期) */
const asRecord = (r: unknown): MemoryRecord => r as unknown as MemoryRecord;

let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'bolloon-memlayer-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
});

const fileOf = (r: MemoryRecord): string => memoryFilePath(home, r);

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ① 真落盘
// ---------------------------------------------------------------------------

describe('① 五层落盘 (真写磁盘, 不是内存)', () => {
  it('五层各一条 → 全部 written, 且每条都能从约定路径读回逐字相同', async () => {
    const records: MemoryRecord[] = [
      runFact(),
      lesson(),
      decision(),
      skillSignal(),
      temporary(LATER),
    ];

    const res = await writeMemoryRecords(home, records, NOW);

    expect(res.rejected).toEqual([]);
    expect(res.written).toEqual(['m-fact-1', 'm-lesson-1', 'm-dec-1', 'm-sig-1', 'm-tmp-1']);

    for (const r of records) {
      const p = fileOf(r);
      expect(await exists(p)).toBe(true);
      expect(JSON.parse(await fs.readFile(p, 'utf8'))).toEqual(r);
    }
  });

  it('落盘布局就是 <home>/.bolloon/memory-layers/<layer>/<memoryId>.json', () => {
    const r = runFact();
    expect(MEMORY_LAYERS_ROOT).toBe('.bolloon/memory-layers');
    expect(fileOf(r)).toBe(path.join(home, '.bolloon', 'memory-layers', 'run_fact', 'm-fact-1.json'));
  });

  it('written + rejected 恰好等于输入条数 (不静默吞条)', async () => {
    const res = await writeMemoryRecords(
      home,
      [runFact(), lesson({ reviewVerdict: 'one_off' }), decision(), temporary(EARLIER)],
      NOW,
    );
    expect(res.written.length + res.rejected.length).toBe(4);
    expect(res.written.length).toBe(2);
    expect(res.rejected.map((r) => r.memoryId).sort()).toEqual(['m-lesson-1', 'm-tmp-1']);
  });

  it('被拒的记录不落地任何文件 (先写坏再回滚 = 不合格)', async () => {
    const res = await writeMemoryRecords(
      home,
      [asRecord({ ...runFact({ memoryId: 'm-bad-1' }), confirmedRefs: [] }), temporary(EARLIER, { memoryId: 'm-bad-2' })],
      NOW,
    );
    expect(res.written).toEqual([]);
    expect(res.rejected.length).toBe(2);
    expect(await exists(fileOf(runFact({ memoryId: 'm-bad-1' })))).toBe(false);
    expect(await exists(path.join(home, MEMORY_LAYERS_ROOT, 'temporary', 'm-bad-2.json'))).toBe(false);
    // 连目录都不该被创建 (全拒的批次不该留下垃圾目录)
    expect(await exists(path.join(home, MEMORY_LAYERS_ROOT))).toBe(false);
  });

  it('home 缺失 → 抛错 (依赖必须注入, 不许猜 homedir)', async () => {
    await expect(writeMemoryRecords('', [runFact()], NOW)).rejects.toThrow(/home/);
  });

  it('now 不是合法 ISO → 抛错 (时间一律注入且必须合法)', async () => {
    await expect(writeMemoryRecords(home, [runFact()], 'yesterday')).rejects.toThrow(/ISO/);
  });
});

// ---------------------------------------------------------------------------
// ② 幂等 / 不覆盖
// ---------------------------------------------------------------------------

describe('② 幂等与不覆盖', () => {
  it('同 id 同内容重写 → 幂等 (计入 written, 不重复落盘)', async () => {
    const first = await writeMemoryRecords(home, [runFact()], NOW);
    const second = await writeMemoryRecords(home, [runFact()], NOW);
    expect(first.written).toEqual(['m-fact-1']);
    expect(second.written).toEqual(['m-fact-1']);
    expect(second.rejected).toEqual([]);
    const entries = await fs.readdir(path.join(home, MEMORY_LAYERS_ROOT, 'run_fact'));
    expect(entries.filter((f) => f.endsWith('.json'))).toEqual(['m-fact-1.json']);
  });

  it('同 id 不同内容 → 拒 duplicate_memory_id, 且原文件逐字不动', async () => {
    await writeMemoryRecords(home, [runFact()], NOW);
    const before = await fs.readFile(fileOf(runFact()), 'utf8');
    const res = await writeMemoryRecords(
      home,
      [runFact({ content: '被偷改的内容', confirmedRefs: ['step:99'] })],
      NOW,
    );
    expect(res.written).toEqual([]);
    expect(res.rejected).toEqual([{ memoryId: 'm-fact-1', reason: 'duplicate_memory_id' }]);
    expect(await fs.readFile(fileOf(runFact()), 'utf8')).toBe(before);
  });

  it('同一批次里同 id 出现两次 → 后一条被拒 (批次内也去重)', async () => {
    const res = await writeMemoryRecords(home, [runFact(), runFact({ content: '另一条' })], NOW);
    expect(res.written).toEqual(['m-fact-1']);
    expect(res.rejected).toEqual([{ memoryId: 'm-fact-1', reason: 'duplicate_memory_id' }]);
  });
});

// ---------------------------------------------------------------------------
// ③ 负控制: 每条分层规则都真的拦得住
// ---------------------------------------------------------------------------

describe('③ 负控制 — 该被拒的必须真被拒', () => {
  it('run_fact: confirmed 但没有 confirmedRefs → 拒 (推测当证据)', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...runFact(), confirmedRefs: [] }), NOW)).toBe(
      'confirmed_fact_without_source',
    );
  });

  it('run_fact: confirmedRefs 全是空白串 → 同样拒 (空串不算来源)', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...runFact(), confirmedRefs: ['  '] }), NOW)).toBe(
      'confirmed_fact_without_source',
    );
  });

  it('run_fact: inferred 却带了 confirmedRefs → 拒 (确定性混淆)', () => {
    expect(
      validateMemoryRecordForWrite(asRecord({ ...runFact(), assertion: 'inferred', confirmedRefs: ['step:3'] }), NOW),
    ).toBe('inferred_fact_cannot_confirm');
  });

  it('run_fact: inferred 且没有来源 → 允许写 (推测本身可记录, 只是不当证据)', async () => {
    const res = await writeMemoryRecords(home, [asRecord({ ...runFact(), assertion: 'inferred', confirmedRefs: [] })], NOW);
    expect(res.written).toEqual(['m-fact-1']);
    expect(res.rejected).toEqual([]);
  });

  it('run_fact: assertion 取值非法 → 拒 unknown_assertion', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...runFact(), assertion: 'maybe' }), NOW)).toBe('unknown_assertion');
  });

  it('lesson: reviewVerdict=one_off → 拒 (不一次性的经验不许成 lesson)', () => {
    expect(validateMemoryRecordForWrite(lesson({ reviewVerdict: 'one_off' }), NOW)).toBe('lesson_not_reusable');
  });

  it('lesson: 没有 reviewedBy → 拒', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...lesson(), reviewedBy: '  ' }), NOW)).toBe('lesson_without_reviewer');
  });

  it('lesson: reusable + 有 reviewer → 通过', () => {
    expect(validateMemoryRecordForWrite(lesson(), NOW)).toBeNull();
  });

  it('decision: 没有 sourceRef → 拒 (涉用户偏好必须留来源)', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...decision(), sourceRef: '   ' }), NOW)).toBe('decision_without_source');
  });

  it('decision: 有 sourceRef → 通过', () => {
    expect(validateMemoryRecordForWrite(decision(), NOW)).toBeNull();
  });

  it('skill_signal: promotesDirectly=true → 拒 (类型级 false 在运行期也要拦)', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...skillSignal(), promotesDirectly: true }), NOW)).toBe(
      'skill_signal_cannot_promote',
    );
  });

  it('skill_signal: 没有 candidateId → 拒', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...skillSignal(), candidateId: '' }), NOW)).toBe(
      'skill_signal_without_candidate',
    );
  });

  it('skill_signal: 合规 → 通过', () => {
    expect(validateMemoryRecordForWrite(skillSignal(), NOW)).toBeNull();
  });

  it('temporary: 写入时已过期 → 拒 (写进去就是死数据)', () => {
    expect(validateMemoryRecordForWrite(temporary(EARLIER), NOW)).toBe('temporary_already_expired');
  });

  it('temporary: expiresAt 等于 now → 也拒 (到点即过期)', () => {
    expect(validateMemoryRecordForWrite(temporary(NOW), NOW)).toBe('temporary_already_expired');
  });

  it('temporary: archiveAtRunEnd 不是 true → 拒', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...temporary(LATER), archiveAtRunEnd: false }), NOW)).toBe(
      'temporary_without_valid_expiry',
    );
  });

  it('temporary: expiresAt 不是合法 ISO → 拒', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...temporary(LATER), expiresAt: '明天' }), NOW)).toBe(
      'temporary_without_valid_expiry',
    );
  });

  it('temporary: 未来到期 → 通过', () => {
    expect(validateMemoryRecordForWrite(temporary(LATER), NOW)).toBeNull();
  });

  it('公共: 空内容 → 拒 empty_content', () => {
    expect(validateMemoryRecordForWrite(runFact({ content: '   ' }), NOW)).toBe('empty_content');
  });

  it('公共: memoryId 为空 → 拒 invalid_memory_id', () => {
    expect(validateMemoryRecordForWrite(runFact({ memoryId: '  ' }), NOW)).toBe('invalid_memory_id');
  });

  it('公共: layer 不在 MEMORY_LAYERS 里 → 拒 unknown_layer', () => {
    expect(validateMemoryRecordForWrite(asRecord({ ...runFact(), layer: 'long_term' }), NOW)).toBe('unknown_layer');
  });

  it('门自身非空转: 拒因清单是 14 条 snake_case、无重复', () => {
    expect(MEMORY_REJECT_REASONS.length).toBe(14);
    expect(new Set(MEMORY_REJECT_REASONS).size).toBe(14);
    for (const r of MEMORY_REJECT_REASONS) expect(r).toMatch(/^[a-z][a-z0-9_]*$/);
  });
});

// ---------------------------------------------------------------------------
// ④ expireTemporary (纯函数)
// ---------------------------------------------------------------------------

describe('④ expireTemporary: 到点归档, 保序, 非 temporary 永不归档', () => {
  it('非 temporary 记录永不被归档 (哪怕看起来"过期")', () => {
    const old = runFact({ createdAt: EARLIER, evidenceRefs: [] });
    const { kept, archived } = expireTemporary([old], LATER);
    expect(kept).toEqual([old]);
    expect(archived).toEqual([]);
  });

  it('未来到期留下 / 过去到期归档 / 正好到点也归档', () => {
    const future = temporary(LATER, { memoryId: 'm-tmp-future' });
    const past = temporary(EARLIER, { memoryId: 'm-tmp-past' });
    const exactly = temporary(NOW, { memoryId: 'm-tmp-now' });
    const { kept, archived } = expireTemporary([future, past, exactly], NOW);
    expect(kept.map((r) => r.memoryId)).toEqual(['m-tmp-future']);
    expect(archived.map((r) => r.memoryId)).toEqual(['m-tmp-past', 'm-tmp-now']);
  });

  it('拿不出"未过期"证据的 temporary 也归档 (archiveAtRunEnd 非 true / expiresAt 非法)', () => {
    const badFlag = asRecord({ ...temporary(LATER, { memoryId: 'm-bad-flag' }), archiveAtRunEnd: false });
    const badDate = asRecord({ ...temporary(LATER, { memoryId: 'm-bad-date' }), expiresAt: 'soon' });
    const { kept, archived } = expireTemporary([badFlag, badDate], NOW);
    expect(kept).toEqual([]);
    expect(archived.map((r) => r.memoryId)).toEqual(['m-bad-flag', 'm-bad-date']);
  });

  it('归档的记录全都是 temporary 层 (archived ⊆ temporary)', () => {
    const input: MemoryRecord[] = [
      runFact(),
      lesson(),
      decision(),
      skillSignal(),
      temporary(LATER, { memoryId: 'm-keep' }),
      temporary(EARLIER, { memoryId: 'm-drop' }),
    ];
    const { kept, archived } = expireTemporary(input, NOW);
    expect(archived.every((r) => r.layer === 'temporary')).toBe(true);
    expect(kept.length + archived.length).toBe(input.length);
  });

  it('保序: kept 里保持原始相对顺序', () => {
    const input: MemoryRecord[] = [
      temporary(LATER, { memoryId: 'm-a' }),
      runFact({ memoryId: 'm-b' }),
      temporary(LATER, { memoryId: 'm-c' }),
      decision({ memoryId: 'm-d' }),
    ];
    const { kept } = expireTemporary(input, NOW);
    expect(kept.map((r) => r.memoryId)).toEqual(['m-a', 'm-b', 'm-c', 'm-d']);
  });

  it('纯函数: 不改入参 (长度/顺序/对象引用都不变)', () => {
    const input: MemoryRecord[] = [runFact(), temporary(EARLIER, { memoryId: 'm-drop' })];
    const snapshot = [...input];
    const { kept, archived } = expireTemporary(input, NOW);
    expect(input).toEqual(snapshot);
    expect(kept[0]).toBe(input[0]);
    expect(archived[0]).toBe(input[1]);
  });

  it('now 非法 → 抛错 (不许拿坏钟当过期依据)', () => {
    expect(() => expireTemporary([temporary(LATER)], 'not-a-date')).toThrow(/ISO/);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 源级: 阶段间不靠 import 实现耦合 + Windows 文件名
// ---------------------------------------------------------------------------

describe('⑤ 源级纯度与可移植性', () => {
  const src = (rel: string): string => readFileSync(path.join(process.cwd(), rel), 'utf8');

  it('memory-layers.ts 只 import ./types.js 与 node 内置 (不 import 别的阶段实现)', () => {
    const imports = [
      ...src('src/agents/goal-flywheel/memory-layers.ts').matchAll(/^import[\s\S]*?from '([^']+)';/gm),
    ].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec.startsWith('node:') || spec === './types.js').toBe(true);
    }
  });

  it('三件套里没有把实现写进 types.ts / index.ts (冻结面只读)', () => {
    const typesSrc = src('src/agents/goal-flywheel/types.ts');
    expect(typesSrc).not.toMatch(/^export function /m);
    expect(src('src/agents/goal-flywheel/index.ts')).toMatch(/export \* from '\.\/types\.js';/);
  });

  it('memoryFileName 去掉 Windows 非法字符 `:` (AGENTS.md §5.1)', () => {
    expect(memoryFileName('run:2026-09-25T10:00')).toBe('run_2026-09-25T10_00.json');
    expect(memoryFileName('a/b\\c')).toBe('a_b_c.json');
    expect(memoryFileName('')).toBe('unnamed.json');
  });
});
