/**
 * 身份文档标题行要与该 agent 自己的 persona.json 一致 (2026-10-01)。
 * 症状: soul.md 写「我是 **233**」(渠道名) 而 persona.json 写「小龙」⇒ 用户看到"身份没匹配上" ✗。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPersonaNameSync } from '../bootstrap/persona-init.js';

let TMP = '';
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-title-line-'));
  const dir = path.join(TMP, '.bolloon', 'persona', 'agent-233');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'persona.json'), JSON.stringify({ name: '小龙' }), 'utf-8');
});
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ } });

describe('readPersonaNameSync', () => {
  it('读到该 agent 自己的名字 (用户那条: 应该是小龙, 不是渠道名 233)', () => {
    expect(readPersonaNameSync('agent-233', TMP)).toBe('小龙');
  });
  it('没有 persona.json ⇒ undefined (调用方回落渠道名)', () => {
    expect(readPersonaNameSync('agent-nope', TMP)).toBeUndefined();
  });
  it('怪字符 agentId 不炸', () => {
    expect(readPersonaNameSync('a/b:c', TMP)).toBeUndefined();
  });
});
