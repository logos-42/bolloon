/**
 * persona 按 agent 分流 (2026-10-01)。
 *
 * 用户报: 「切换的智能体为什么回复内容还是身份人格对不上?」—— 真因是每个 session 都读**全局**
 * ~/.bolloon/persona.json (用户那份是 2026-08-10 老 set persona 留下的 {name: 小宝}) ⇒ 换谁都是小宝,
 * 把按 agent 的 6 份身份文档盖住了。
 *
 * 本门钉三条优先级 (改坏必红):
 *   1 该 agent 自己的 persona/<agentId>/persona.json ⇒ 用它;
 *   2 该 agent 有身份文档目录 (persona/<agentId>/*.md) ⇒ 必须报 docs (调用方据此返回 null,
 *     不再套全局那份) ← 用户的情况;
 *   3 没有 scope 或该 agent 什么都没有 ⇒ 回落全局 persona.json (老默认路径保持兼容)。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePersonaSource, personaPathFor, hasAgentIdentityDocs } from '../agents/pi-sdk-session-manager.js';

const REAL_HOME = os.homedir();
let TMP = '';
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-persona-scope-'));
  process.env.HOME = TMP;
  fs.mkdirSync(path.join(TMP, '.bolloon'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.bolloon', 'persona.json'), JSON.stringify({ name: '小宝' }), 'utf-8');
});
afterAll(() => { process.env.HOME = REAL_HOME; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('resolvePersonaSource', () => {
  it('2 有身份文档的 agent ⇒ docs (不套全局那份「小宝」)', async () => {
    const dir = path.join(TMP, '.bolloon', 'persona', 'agent-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'soul.md'), '# soul', 'utf-8');
    expect(await hasAgentIdentityDocs('agent-x')).toBe(true);
    const src = await resolvePersonaSource('agent-x');
    expect(src.kind).toBe('docs');
  });

  it('1 该 agent 自己的 persona.json 优先于 docs', async () => {
    const dir = path.join(TMP, '.bolloon', 'persona', 'agent-y');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'soul.md'), '# soul', 'utf-8');
    fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ name: 'Y' }), 'utf-8');
    const src = await resolvePersonaSource('agent-y');
    expect(src.kind).toBe('scoped');
    expect(src.path).toBe(personaPathFor('agent-y'));
  });

  it('3 没有 scope / 什么都没有的 agent ⇒ 回落全局 (兼容老路径)', async () => {
    expect((await resolvePersonaSource()).kind).toBe('global');
    expect((await resolvePersonaSource('agent-nothing')).kind).toBe('global');
  });

  it('路径口径: 会做安全化, 不越权到别的目录', () => {
    const pth = personaPathFor('../../etc');
    expect(pth.includes('..')).toBe(false);
    // 真正的性质: 无论传什么, 解析出来的 agent 目录必须**落在 persona/ 之内** (不写到别处去)
    const agentDir = path.dirname(pth);
    expect(agentDir.startsWith(path.join(TMP, '.bolloon', 'persona'))).toBe(true);
    expect(path.dirname(agentDir)).toBe(path.join(TMP, '.bolloon', 'persona'));
    expect(path.basename(agentDir)).not.toContain('/');
  });
});
