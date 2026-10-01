/**
 * 技能账本 + 单条回滚 + 写来源隔离 + 用量生命周期 (2026-10-01)。
 * 契约(照"账本而非闸门"的形态):
 *  ① 账本追加/读取 ✓ 且**吞错**(坏行跳过, 不炸 ✓)
 *  ② 单条回滚 **fail-closed**: 没有快照 ⇒ 拒绝(绝不半还原 ✗); 快照内容与哈希不符 ⇒ 拒绝 ✓
 *  ③ 写来源隔离: 自审只许动**自己创建**的技能 ✓; 用户点名要的 ⇒ 拒绝 ✓
 *  ④ 用量: 旁挂文件计数 ✓; pinned 退出自动流转 ✓; 45 天未用 ⇒ stale(且只报状态, 不自动删 ✗)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendLedger, readLedger, rollbackEntry, captureSkillBefore, runWithWriteOrigin, currentWriteOrigin, reviewMayTouch,
} from '../agents/skill-ledger.js';
import { bumpUsage, markCreatedBy, setPinned, lifecycleOf, usageSummary, STALE_AFTER_MS } from '../agents/skill-health.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'skl-'));

describe('技能账本 / 回滚 / 写来源 / 生命周期', () => {
  it('① 账本可追加可读回, 坏行不炸', () => {
    const home = tmp();
    appendLedger({ origin: 'foreground', tool: 'update_skill', skill: 'a', file: '/tmp/a/SKILL.md' }, home);
    fs.appendFileSync(path.join(home, '.bolloon', 'skills', '.skill-ledger.jsonl'), 'not-json\n');
    expect(readLedger(home).length).toBe(1);
  });
  it('② 回滚 fail-closed: 无快照 ⇒ 拒绝', () => {
    const home = tmp();
    const e = appendLedger({ origin: 'foreground', tool: 'update_skill', skill: 'a', file: '/tmp/a/SKILL.md' }, home);
    const r = rollbackEntry(e.id, home);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('没有变更前快照');
  });
  it('② 有快照 ⇒ 真能回滚(fail-closed 之外的正常路径)', () => {
    const home = tmp();
    const file = path.join(home, 'SKILL.md');
    fs.writeFileSync(file, '旧内容');
    const before = captureSkillBefore(file, home);
    fs.writeFileSync(file, '新内容');
    const e = appendLedger({ origin: 'foreground', tool: 'update_skill', skill: 'a', file, beforeSha: before.beforeSha }, home);
    const r = rollbackEntry(e.id, home);
    expect(r.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('旧内容');
  });
  it('③ 写来源: foreground 放行; review 对"非自审创建"的技能 ⇒ 拒绝', () => {
    const home = tmp();
    expect(currentWriteOrigin()).toBe('foreground');
    expect(reviewMayTouch('user-skill', home).ok).toBe(true);              // foreground ⇒ 放行
    const inReview = runWithWriteOrigin('review', () => reviewMayTouch('user-skill', home));
    expect(inReview.ok).toBe(false);                                       // review + 非自建 ⇒ 拒绝
    appendLedger({ origin: 'review', tool: 'create_skill', skill: 'auto-x', file: '/tmp/x/SKILL.md' }, home);
    expect(runWithWriteOrigin('review', () => reviewMayTouch('auto-x', home)).ok).toBe(true);   // 自审自建 ⇒ 放行
  });
  it('④ 用量: 计数 + pinned + stale(只报状态)', () => {
    const home = tmp();
    bumpUsage('s1', home); bumpUsage('s1', home);
    markCreatedBy('s1', 'review', home);
    expect(lifecycleOf('s1', home).count).toBe(2);
    expect(lifecycleOf('s1', home).state).toBe('active');
    setPinned('s1', true, home);
    expect(lifecycleOf('s1', home, Date.now() + STALE_AFTER_MS * 3).state).toBe('active');   // pinned 不流转
    setPinned('s1', false, home);
    expect(lifecycleOf('s1', home, Date.now() + STALE_AFTER_MS * 3).state).toBe('stale');
    expect(usageSummary(home).total).toBeGreaterThan(0);
  });
});
