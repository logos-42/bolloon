/**
 * 切智能体 (agentId/channelId 变化) 必须换身份文档 —— 5s 节流窗口内也不许返回空 persona。
 *
 * 用户报告 (2026-10-01): 「在 /channel 命令里面切换智能体后, 智能体没有切换身份文档」。
 *
 * 根因: src/bootstrap/lifecycle-hooks.ts 的 onSessionStart 有一个**模块级 5 秒节流**,
 * 被节流时直接 `return { systemAddition: '' }` —— 而 /channel 切换后重建 agent 只需几毫秒,
 * 几乎必然落在上一个 session 的 5s 窗口里 ⇒ 新 agent 拿到**空的身份文档** (persona 一个字都没有),
 * 看上去就是「切了智能体但身份文档没换」。
 *
 * 这个门钉两件事:
 *   ① 换了 agentId (或 channelId) ⇒ 必须重算, 且必须是**新身份**的文档 (旧身份的标记不许残留);
 *   ② 同一个身份连来两次 ⇒ 允许走节流 (原意: 防循环, 保留)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_HOME = os.homedir(); // 仓规: 覆盖 process.env.HOME 之前先取真值
let TMP = '';

function writePersona(agentId: string, marker: string): void {
  const dir = path.join(TMP, '.bolloon', 'persona', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'soul.md'), `# soul\n\n${marker}\n`, 'utf-8');
}

beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-lh-persona-'));
  process.env.HOME = TMP;
});

afterAll(() => {
  process.env.HOME = REAL_HOME;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ }
});

describe('onSessionStart 的身份文档随 agentId 切换', () => {
  it('5 秒窗口内换 agentId ⇒ 必须拿到新身份文档, 且旧身份标记不许残留', async () => {
    writePersona('alpha', 'ALPHA-身份标记');
    writePersona('beta', 'BETA-身份标记');
    const { onSessionStart } = await import('../bootstrap/lifecycle-hooks.js');

    const r1 = await onSessionStart({ agentId: 'alpha', channelId: 'ch-a', cwd: TMP, force: true });
    expect(r1.systemAddition).toContain('ALPHA-身份标记');
    expect(r1.systemAddition).toContain('agentId=alpha');

    // 紧接着切换 (实测 /channel 的间隔就是毫秒级)
    const r2 = await onSessionStart({ agentId: 'beta', channelId: 'ch-b', cwd: TMP, force: true });
    expect(r2.systemAddition).toContain('BETA-身份标记');
    expect(r2.systemAddition).toContain('agentId=beta');
    expect(r2.systemAddition).not.toContain('ALPHA-身份标记');
  });

  it('5 秒窗口内换 channelId (同一 agentId) 也要重算', async () => {
    const { onSessionStart } = await import('../bootstrap/lifecycle-hooks.js');
    const a = await onSessionStart({ agentId: 'alpha', channelId: 'ch-a', cwd: TMP, force: true });
    const b = await onSessionStart({ agentId: 'alpha', channelId: 'ch-b', cwd: TMP, force: true });
    expect(a.systemAddition).toContain('agentId=alpha');
    expect(b.systemAddition).toContain('agentId=alpha');
    expect(b.systemAddition).toContain('ch-b'); // channel 标识跟着换
  });

  it('同一身份连来两次 ⇒ 仍允许节流 (防循环原意保留)', async () => {
    const { onSessionStart } = await import('../bootstrap/lifecycle-hooks.js');
    const a = await onSessionStart({ agentId: 'alpha', channelId: 'ch-a', cwd: TMP, force: true });
    const b = await onSessionStart({ agentId: 'alpha', channelId: 'ch-a', cwd: TMP, force: true });
    expect(a.systemAddition).toContain('ALPHA-身份标记');
    // 第二次要么被节流 (空), 要么仍是同一个身份 —— 但**绝不能**是别的身份
    const ok = b.systemAddition === '' || b.systemAddition.includes('ALPHA-身份标记');
    expect(ok, `第二次返回了非本身份内容: ${b.systemAddition.slice(0, 120)}`).toBe(true);
    expect(b.systemAddition).not.toContain('BETA-身份标记');
  });
});
