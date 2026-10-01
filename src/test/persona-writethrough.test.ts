/**
 * persona "写透"到身份文档 (2026-10-01)。
 *
 * 用户报: 「每一个 channel 的 persona 不一样, 为什么每次我要让智能体改, 都是同一个? 读的还是同一个」
 * 根因: 有身份文档的 agent 不再套用 persona.json ⇒ 身份由 6 份文档承担; 而 set_persona 原先只写
 *   persona.json ⇒ **agent 自己改的人格根本不进系统提示**; 各 agent 的文档还都是同一份模板
 *   ⇒ 看起来"读的还是同一个"。
 * 修法: setPersona 同步把 persona 写进该 agent 的 soul.md / identity.md —— **只重写
 *   `<!-- persona:auto -->` 标记之内**, 标记外是用户手写的, 一个字都不动。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPersonaToDocs, personaDirOf, PERSONA_AUTO_BEGIN } from '../bootstrap/persona-init.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-persona-writethrough-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('applyPersonaToDocs (写透)', () => {
  it('两个 agent 各写各的, 内容因 persona 不同而不同', async () => {
    const a = await applyPersonaToDocs('agent-a', { name: 'A', personality: '冷静' }, { home: TMP });
    const b = await applyPersonaToDocs('agent-b', { name: 'B', personality: '活泼' }, { home: TMP });
    expect(a).toEqual(['soul', 'identity']);
    expect(b).toEqual(['soul', 'identity']);
    const aSoul = fs.readFileSync(path.join(personaDirOf('agent-a', TMP), 'soul.md'), 'utf-8');
    const bSoul = fs.readFileSync(path.join(personaDirOf('agent-b', TMP), 'soul.md'), 'utf-8');
    expect(aSoul).toContain('冷静');
    expect(bSoul).toContain('活泼');
    expect(aSoul).not.toContain('活泼');
  });

  it('**标记外的手写内容一个字都不动** (关键安全性质)', async () => {
    const dir = personaDirOf('agent-c', TMP);
    fs.mkdirSync(dir, { recursive: true });
    const soul = path.join(dir, 'soul.md');
    fs.writeFileSync(soul, '我手写的开头\n\n<!-- persona:auto:begin -->\n老内容\n<!-- persona:auto:end -->\n\n我手写的结尾\n', 'utf-8');
    await applyPersonaToDocs('agent-c', { name: 'C', personality: '严谨' }, { home: TMP });
    const after = fs.readFileSync(soul, 'utf-8');
    expect(after).toContain('我手写的开头');
    expect(after).toContain('我手写的结尾');
    expect(after).toContain('严谨');
    expect(after).not.toContain('老内容'); // 标记区内被替换
  });

  it('幂等: 连续写两次不会堆叠出两个标记区', async () => {
    await applyPersonaToDocs('agent-d', { name: 'D' }, { home: TMP });
    await applyPersonaToDocs('agent-d', { name: 'D', personality: '稳' }, { home: TMP });
    const soul = fs.readFileSync(path.join(personaDirOf('agent-d', TMP), 'soul.md'), 'utf-8');
    expect(soul.split(PERSONA_AUTO_BEGIN).length - 1).toBe(1);
    expect(soul).toContain('稳');
  });

  it('空 agentId ⇒ 什么都不写', async () => {
    expect(await applyPersonaToDocs('', { name: 'x' }, { home: TMP })).toEqual([]);
  });
});
