/**
 * 项目上下文里的 persona 必须按 agent 取 (2026-10-01, 用户实测)。
 *
 * 症状: 233 会话的 get_identity 已经是「小龙」✓, 但项目上下文里仍写 `## Persona: 小宝` ✗
 *   —— context-collector **无条件**读全局 ~/.bolloon/persona.json(8/10 的老文件) ⇒ 盖过该 agent 的身份。
 * 规矩: ① 该 agent 有自己的 persona.json ⇒ 用它; ② 有身份文档(*.md) ⇒ **不注入** (身份由文档承担);
 *   ③ 既没 scope 又什么都没有 ⇒ 才回落全局。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePersonaForScope } from '../bootstrap/context-collector.js';

let TMP = '';
const P = (...s: string[]) => path.join(TMP, '.bolloon', ...s);
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-ctx-persona-'));
  fs.mkdirSync(path.join(TMP, '.bolloon'), { recursive: true }); // 先建目录, 否则 writeFileSync ENOENT
  fs.writeFileSync(P('persona.json'), JSON.stringify({ name: '小宝', description: '全局老文件' }), 'utf-8');
  fs.mkdirSync(P('persona', 'agent-233'), { recursive: true });
  fs.writeFileSync(P('persona', 'agent-233', 'persona.json'), JSON.stringify({ name: '小龙' }), 'utf-8');
  fs.mkdirSync(P('persona', 'agent-withdocs'), { recursive: true });
  fs.writeFileSync(P('persona', 'agent-withdocs', 'soul.md'), '# 我是谁', 'utf-8');
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('resolvePersonaForScope', () => {
  it('① 该 agent 有自己的 persona.json ⇒ 用它 (用户那条: 应该是小龙, 不是小宝)', async () => {
    const r = await resolvePersonaForScope(TMP, 'agent-233');
    expect(r?.name).toBe('小龙');
    expect(r?.name).not.toBe('小宝');
  });
  it('② 只有身份文档 ⇒ **不注入 persona** (别把全局名漏进来)', async () => {
    expect(await resolvePersonaForScope(TMP, 'agent-withdocs')).toBeNull();
  });
  it('③ 没 scope 且无自己的文件 ⇒ 回落全局 (兼容老流程)', async () => {
    expect((await resolvePersonaForScope(TMP, undefined))?.name).toBe('小宝');
    expect((await resolvePersonaForScope(TMP, 'agent-unknown'))?.name).toBe('小宝');
  });
  it('agentId 里有奇怪字符也不炸 (走 safe 名)', async () => {
    expect((await resolvePersonaForScope(TMP, 'a/b:c')).name).toBe('小宝');
  });
});
