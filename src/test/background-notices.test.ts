/**
 * 后台委派的结果回灌 (2026-10-01, 用户: 「开展子智能体后，bolloon 没有回归」+「还是卡住了，学 hermes」)。
 * 契约: 只认**我起的**委派 · 跑完才提 · **同一条只提一次** · 没完成不提。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDelegateNotices, DELEGATE_ENV_MARK } from '../agents/background-notices.js';

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
