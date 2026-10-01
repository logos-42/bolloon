/**
 * 后台委派的结果回灌 (2026-10-01, 用户: 「开展子智能体后，bolloon 没有回归」+「还是卡住了，学 hermes」)。
 * 契约: 只认**我起的**委派 · 跑完才提 · **同一条只提一次** · 没完成不提。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDelegateNotices, DELEGATE_ENV_MARK, pushNotice, drainNotices, renderNoticeBlock } from '../agents/background-notices.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir ? os.homedir() : os.homedir(), 'bn-'));
}

describe('后台委派回灌', () => {
  it('跑完的委派 ⇒ 一行提示; 重复收集**只提一次**', () => {
    const home = tmpHome();
    const s = [{ id: 'p1', cmd: `${DELEGATE_ENV_MARK} codex "x"`, status: 'exited', exitCode: 0 }];
    const first = collectDelegateNotices(home, s);
    expect(first.length).toBe(1);
    expect(first[0]).toContain('后台委派完成');
    expect(first[0]).toContain('process poll p1');
    expect(collectDelegateNotices(home, s).length).toBe(0);   // 提过 ⇒ 不再提
  });
  it('还没跑完 ⇒ 不提', () => {
    const home = tmpHome();
    expect(collectDelegateNotices(home, [{ id: 'r1', cmd: `${DELEGATE_ENV_MARK} codex "x"`, status: 'running', exitCode: null }]).length).toBe(0);
  });
  it('不是我起的委派(没标记) ⇒ 不提', () => {
    const home = tmpHome();
    expect(collectDelegateNotices(home, [{ id: 'o1', cmd: 'npm run dev', status: 'exited', exitCode: 0 }]).length).toBe(0);
  });
});


describe('回流队列 (用户: 「复盘任务能否触发 loop?」)', () => {
  it('投递 ⇒ 排空一次拿到 ⇒ 再排空为空(不重复浮现)', () => {
    const home = tmpHome();
    pushNotice('review', '教训X —— 说明Y', home);
    const first = drainNotices(home);
    expect(first.length).toBe(1);
    expect(first[0].kind).toBe('review');
    expect(drainNotices(home).length).toBe(0);
  });
  it('任务源块自包含: 说明来源 + 现在该做什么 + 不重复', () => {
    const home = tmpHome();
    pushNotice('review', '教训X —— 说明Y', home);
    const block = renderNoticeBlock(home);
    expect(block).toContain('这是新一轮');
    expect(block).toContain('复盘产出');
    expect(block).toContain('现在就');
  });
  it('坏行不炸 + 空队列返回空串', () => {
    const home = tmpHome();
    expect(renderNoticeBlock(home)).toBe('');
  });
});
