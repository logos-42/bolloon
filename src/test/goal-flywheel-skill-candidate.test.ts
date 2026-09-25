/**
 * goal-flywheel-skill-candidate.test.ts — P1b Skill 改进候选 (`skill-candidate.ts`) 单测 (2026-09-25)
 *
 * 验的是「防 Skill 垃圾」这道门真的存在, 不是"函数被调用过":
 *   ① 健康候选: junkReasons 为空 + promotable + 与现有 Skill 的关系 (new / duplicate / version_bump)
 *   ② **负控制**: 7 条 `SkillJunkReason` 每条都能被单独触发, 且命中即 `promotable === false`
 *      —— 特别是 P5 强负例 8「只有一次偶然成功 → 不得晋升」
 *   ③ `draftPromotion`: 正式变更记录的字段/版本推进/approval, 以及**该抛错就抛错**
 *      (签名无法表达失败 → 缺 contentHash / 缺批准人 / 缺变更原因 / 命中垃圾理由 一律抛错,
 *       调用方把 `junkReasons` 清空也绕不过: 函数自己会重算)
 *   ④ 源级: 纯函数 (不 import `fs`), 只 import `./types.js`, 不导出与 skill-writer 撞名的 `SkillCandidate`
 *
 * 变异验证 (报告里给数字): 删掉 `single_success` 判定 → 「单次成功不得晋升」判红;
 * 删掉 `draftPromotion` 的 contentHash 检查 → 「无哈希不许写正式变更记录」判红。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  assessCandidate,
  draftPromotion,
  deriveJunkReasons,
  bumpSkillVersion,
  looksLikeTempPath,
  TEMP_PATH_HINTS,
} from '../agents/goal-flywheel/skill-candidate.js';

import type { ExistingSkillIdentity } from '../agents/goal-flywheel/skill-candidate.js';
import type { SkillImprovementCandidate, SkillJunkReason, IsoTimestamp } from '../agents/goal-flywheel/types.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const NOW: IsoTimestamp = '2026-09-25T10:00:00.000Z';

/** 一个**健康**候选: 过得了全部垃圾门 (逐条对应 deriveJunkReasons 的检查) */
const healthy = (over: Partial<SkillImprovementCandidate> = {}): SkillImprovementCandidate => ({
  candidateId: 'cand-1',
  name: 'probe-before-config-change',
  purpose: '改配置前先打一次只读探针, 确认当前行为再动手',
  sourceRunIds: ['run-7', 'run-9', 'run-12'],
  evidenceRefs: ['step:3', 'sha256:abc123', 'run-9/step:5'],
  failureCases: ['目标进程不提供只读探针端点时无法使用', '探针本身有副作用时禁用'],
  inputSchema: 'bolloon-probe-input/1',
  outputSchema: 'bolloon-probe-output/1',
  guarantees: ['在改动前拿到当前行为基线'],
  doesNotGuarantee: ['不保证探针能覆盖全部配置项', '不保证目标进程一定可探'],
  contentHash: 'sha256:cafe0001',
  approval: { state: 'pending', approvedBy: null, approvedAt: null, changeReason: null },
  status: 'pending_review',
  occurrences: 3,
  boundaryClear: true,
  junkReasons: [],
  proposedAt: NOW,
  proposedByRunId: 'run-12',
  ...over,
});

const registry: ExistingSkillIdentity[] = [
  { name: 'probe-before-config-change', contentHash: 'sha256:older', version: '1.2.3' },
  { name: 'unrelated-skill', contentHash: 'sha256:other', version: '0.1.0' },
];

// ---------------------------------------------------------------------------
// ① 健康候选
// ---------------------------------------------------------------------------

describe('① 健康候选: 无垃圾理由 / 可晋升 / 关系判定', () => {
  it('全部字段齐 → junkReasons 为空且 promotable', () => {
    const a = assessCandidate(healthy(), registry);
    expect(a.junkReasons).toEqual([]);
    expect(a.promotable).toBe(true);
    expect(a.comparison).toBe('version_bump'); // 同名但 contentHash 不同 → 版本推进
  });

  it('注册表里没有这个名字 → comparison=new', () => {
    const a = assessCandidate(healthy({ name: 'brand-new-skill' }), registry);
    expect(a.comparison).toBe('new');
    expect(a.junkReasons).toEqual([]);
  });

  it('同名 + 同 contentHash → comparison=duplicate 且带 duplicate_of_existing', () => {
    const a = assessCandidate(healthy({ contentHash: 'sha256:older' }), registry);
    expect(a.comparison).toBe('duplicate');
    expect(a.junkReasons).toContain('duplicate_of_existing');
    expect(a.promotable).toBe(false);
  });

  it('注册表为空 → 永远 comparison=new 且查不出重复', () => {
    const a = assessCandidate(healthy(), []);
    expect(a.comparison).toBe('new');
    expect(a.junkReasons).not.toContain('duplicate_of_existing');
  });

  it('不变量 (类型级 derive 的镜像): promotable === (junkReasons 空 && boundaryClear)', () => {
    const cases: SkillImprovementCandidate[] = [
      healthy(),
      healthy({ occurrences: 1 }),
      healthy({ boundaryClear: false }),
      healthy({ failureCases: [] }),
      healthy({ name: 'probe-before-config-change', contentHash: 'sha256:older' }),
    ];
    for (const c of cases) {
      const a = assessCandidate(c, registry);
      expect(a.promotable).toBe(a.junkReasons.length === 0 && c.boundaryClear === true);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 负控制: 7 条垃圾理由逐条可触发
// ---------------------------------------------------------------------------

describe('② 负控制 — 每条 SkillJunkReason 都真的拦得住', () => {
  it('强负例 8: 只成功一次 (occurrences=1) → single_success, promotable=false', () => {
    const a = assessCandidate(healthy({ occurrences: 1 }), registry);
    expect(a.junkReasons).toContain('single_success');
    expect(a.promotable).toBe(false);
  });

  it('occurrences=0 → 同样 single_success', () => {
    expect(assessCandidate(healthy({ occurrences: 0 }), registry).junkReasons).toContain('single_success');
  });

  it('occurrences=2 → 不触发 single_success (边界)', () => {
    expect(deriveJunkReasons(healthy({ occurrences: 2 }), [])).not.toContain('single_success');
  });

  it('输入 schema 为空 → no_io_schema', () => {
    expect(deriveJunkReasons(healthy({ inputSchema: '  ' }), [])).toContain('no_io_schema');
  });

  it('输出 schema 为空 → no_io_schema', () => {
    expect(deriveJunkReasons(healthy({ outputSchema: '' }), [])).toContain('no_io_schema');
  });

  it('没有失败边界 (failureCases=[]) → no_failure_boundary', () => {
    const a = assessCandidate(healthy({ failureCases: [] }), registry);
    expect(a.junkReasons).toContain('no_failure_boundary');
    expect(a.promotable).toBe(false);
  });

  it('证据引用里出现 /tmp/ → temp_path_dependency', () => {
    expect(deriveJunkReasons(healthy({ evidenceRefs: ['/tmp/probe-out.txt'] }), [])).toContain('temp_path_dependency');
  });

  it('sourceRunIds 里出现 /var/folders/ (macOS 临时目录) → temp_path_dependency', () => {
    expect(deriveJunkReasons(healthy({ sourceRunIds: ['/var/folders/ab/123/run-7'] }), [])).toContain(
      'temp_path_dependency',
    );
  });

  it('没有证据引用 → unverifiable_result', () => {
    expect(deriveJunkReasons(healthy({ evidenceRefs: [] }), [])).toContain('unverifiable_result');
  });

  it('没有草案哈希 (contentHash=null) → unverifiable_result, 不得晋升', () => {
    const a = assessCandidate(healthy({ contentHash: null }), registry);
    expect(a.junkReasons).toContain('unverifiable_result');
    expect(a.promotable).toBe(false);
  });

  it('只声明 guarantees 不声明 doesNotGuarantee → unverifiable_result (越权承诺)', () => {
    expect(deriveJunkReasons(healthy({ doesNotGuarantee: [] }), [])).toContain('unverifiable_result');
  });

  it('什么都不保证 (guarantees=[]) → unverifiable_result', () => {
    expect(deriveJunkReasons(healthy({ guarantees: [] }), [])).toContain('unverifiable_result');
  });

  it('只是一句经验 (无 schema + 无失败边界 + 无保证) → one_line_experience', () => {
    const oneLiner = healthy({
      inputSchema: '',
      outputSchema: '',
      failureCases: [],
      guarantees: [],
      doesNotGuarantee: [],
    });
    const junk = deriveJunkReasons(oneLiner, []);
    expect(junk).toContain('one_line_experience');
    expect(junk).toContain('no_io_schema');
    expect(junk).toContain('no_failure_boundary');
  });

  it('边界不清 (boundaryClear=false) → 即使没有垃圾理由也不 promotable', () => {
    const a = assessCandidate(healthy({ boundaryClear: false }), registry);
    expect(a.junkReasons).toEqual([]);
    expect(a.promotable).toBe(false);
  });

  it('多料混合时理由去重且不漏 (no_io_schema + single_success 同时命中)', () => {
    const junk = deriveJunkReasons(healthy({ occurrences: 1, outputSchema: '' }), []);
    expect(new Set(junk).size).toBe(junk.length);
    expect(junk).toContain('single_success');
    expect(junk).toContain('no_io_schema');
  });

  it('每条理由都是类型里的合法取值 (不凭空造词)', () => {
    const all: SkillJunkReason[] = deriveJunkReasons(
      healthy({
        occurrences: 1,
        inputSchema: '',
        outputSchema: '',
        failureCases: [],
        evidenceRefs: ['/tmp/x'],
        guarantees: [],
        doesNotGuarantee: [],
        contentHash: null,
        name: 'probe-before-config-change',
      }),
      [{ name: 'probe-before-config-change', contentHash: 'sha256:older', version: '1.2.3' }],
    );
    const allowed = [
      'single_success',
      'no_io_schema',
      'temp_path_dependency',
      'no_failure_boundary',
      'unverifiable_result',
      'one_line_experience',
      'duplicate_of_existing',
    ];
    for (const r of all) expect(allowed).toContain(r);
  });

  it('looksLikeTempPath 自己有阴性对照 (正常路径不许被当成临时路径)', () => {
    expect(looksLikeTempPath('/tmp/x')).toBe(true);
    expect(looksLikeTempPath('C:\\Temp\\x.txt')).toBe(true);
    expect(looksLikeTempPath('/var/folders/ab/x')).toBe(true);
    expect(looksLikeTempPath('src/agents/skill-candidate.ts')).toBe(false);
    expect(looksLikeTempPath('sha256:deadbeef')).toBe(false);
    expect(looksLikeTempPath('')).toBe(false);
    expect(TEMP_PATH_HINTS.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// ③ draftPromotion
// ---------------------------------------------------------------------------

describe('③ draftPromotion: 正式变更记录 + 该抛错就抛错', () => {
  const approvedBy = 'leo';
  const changeReason = '第三次 run 复现同一手法, 补上失败边界后转正';

  it('健康候选 + 已有版本 1.2.3 → 记录字段完整, toVersion=1.3.0, snapshotScope=next_run_only', () => {
    const rec = draftPromotion(healthy(), '1.2.3', changeReason, approvedBy, NOW);

    expect(rec.skillName).toBe('probe-before-config-change');
    expect(rec.fromVersion).toBe('1.2.3');
    expect(rec.toVersion).toBe('1.3.0');
    expect(rec.contentHash).toBe('sha256:cafe0001');
    expect(rec.changeReason).toBe(changeReason);
    expect(rec.sourceRunIds).toEqual(['run-7', 'run-9', 'run-12']);
    expect(rec.evidenceRefs).toEqual(['step:3', 'sha256:abc123', 'run-9/step:5']);
    expect(rec.failureCases.length).toBe(2);
    expect(rec.inputSchema).toBe('bolloon-probe-input/1');
    expect(rec.outputSchema).toBe('bolloon-probe-output/1');
    expect(rec.guarantees.length).toBe(1);
    expect(rec.doesNotGuarantee.length).toBe(2);
    expect(rec.snapshotScope).toBe('next_run_only');
    expect(rec.promotedAt).toBe(NOW);
    expect(rec.approval).toEqual({ state: 'approved', approvedBy, approvedAt: NOW, changeReason });
  });

  it('全新 Skill (existingVersion=null) → fromVersion=null, toVersion=1.0.0', () => {
    const rec = draftPromotion(healthy(), null, changeReason, approvedBy, NOW);
    expect(rec.fromVersion).toBeNull();
    expect(rec.toVersion).toBe('1.0.0');
  });

  it('版本推进表: null→1.0.0 · 0.0.0→0.1.0 · 2.9.9→2.10.0 · 非 semver→1.0.0', () => {
    expect(bumpSkillVersion(null)).toBe('1.0.0');
    expect(bumpSkillVersion('0.0.0')).toBe('0.1.0');
    expect(bumpSkillVersion('2.9.9')).toBe('2.10.0');
    expect(bumpSkillVersion('1.2')).toBe('1.0.0');
    expect(bumpSkillVersion('v1')).toBe('1.0.0');
    expect(bumpSkillVersion('')).toBe('1.0.0');
  });

  it('强负例 8 第二道门: 调用方把 junkReasons 清空也拦得住 (自己重算 occurrences=1)', () => {
    const forged = healthy({ occurrences: 1, junkReasons: [] });
    expect(() => draftPromotion(forged, '1.0.0', changeReason, approvedBy, NOW)).toThrow(/single_success/);
  });

  it('命中垃圾理由 (没有失败边界) → 抛错, 不返回假记录', () => {
    expect(() => draftPromotion(healthy({ failureCases: [] }), '1.0.0', changeReason, approvedBy, NOW)).toThrow(
      /no_failure_boundary/,
    );
  });

  it('没有 contentHash → 抛错 (正式变更必须有草案哈希)', () => {
    expect(() => draftPromotion(healthy({ contentHash: null }), '1.0.0', changeReason, approvedBy, NOW)).toThrow(
      /contentHash/,
    );
  });

  it('没有批准人 approvedBy → 抛错', () => {
    expect(() => draftPromotion(healthy(), '1.0.0', changeReason, '   ', NOW)).toThrow(/approvedBy/);
  });

  it('没有变更原因 changeReason → 抛错', () => {
    expect(() => draftPromotion(healthy(), '1.0.0', '', approvedBy, NOW)).toThrow(/changeReason/);
  });

  it('now 不是合法 ISO → 抛错', () => {
    expect(() => draftPromotion(healthy(), '1.0.0', changeReason, approvedBy, 'now')).toThrow(/ISO/);
  });

  it('边界不清 (boundaryClear=false) → 抛错', () => {
    expect(() => draftPromotion(healthy({ boundaryClear: false }), '1.0.0', changeReason, approvedBy, NOW)).toThrow(
      /boundaryClear/,
    );
  });

  it('返回的是数组副本: 改记录不影响候选 (候选可继续被别的流程读)', () => {
    const c = healthy();
    const rec = draftPromotion(c, null, changeReason, approvedBy, NOW);
    rec.evidenceRefs.push('stepped-on');
    rec.failureCases.length = 0;
    expect(c.evidenceRefs.length).toBe(3);
    expect(c.failureCases.length).toBe(2);
  });

  it('反复调用不会互相污染 (每次都是新对象)', () => {
    const a = draftPromotion(healthy(), null, changeReason, approvedBy, NOW);
    const b = draftPromotion(healthy(), null, changeReason, approvedBy, NOW);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// ④ 源级纯度
// ---------------------------------------------------------------------------

describe('④ 源级: 纯函数 + 命名不撞车 + 冻结签名都在', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/agents/goal-flywheel/skill-candidate.ts'), 'utf8');
  const importsOf = (s: string): string[] =>
    [...s.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1]);

  it('不 import fs / path / 任何 I/O (不做 I/O 的函数不许 import fs)', () => {
    const specs = importsOf(src);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.some((s) => /fs|path|os|child_process/.test(s))).toBe(false);
  });

  it('只 import ./types.js 与 node 内置 (不靠 import 别的阶段实现, §13)', () => {
    for (const spec of importsOf(src)) {
      expect(spec.startsWith('node:') || spec === './types.js').toBe(true);
    }
  });

  it('不导出与 skill-writer 撞名的 SkillCandidate (本模块只导出 SkillImprovementCandidate 一系)', () => {
    expect(src).not.toMatch(/export (interface|type) SkillCandidate\b/);
    expect(src).not.toMatch(/export (async )?function \w*SkillCandidate\b/);
  });

  it('§14 冻结签名两个函数都真导出', () => {
    expect(src).toMatch(/export function assessCandidate\(/);
    expect(src).toMatch(/export function draftPromotion\(/);
  });
});
