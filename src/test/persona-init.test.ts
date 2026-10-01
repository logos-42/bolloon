/**
 * 每个 agent 名下必须有身份文档 (2026-10-01, a+b)。
 *
 * 用户报: 切换之后应该知道加载智能体初始化文档, 为什么目前是无, 所有回复都是一个智能体人格?
 * 真因: persona/<agentId>/ 一个文件都没有 ⇒ loadPersonaDocs 读回空 ⇒ 只剩共用的 INJECT 纪律。
 * 本门钉五件事:
 *   1 首次加载 ⇒ 6 份起步文档都建出来 (soul/identity/project/user/agent/wiki);
 *   2 正文里带该 agent 的名字与 agentId ⇒ 两个 agent 的内容必然不同;
 *   3 幂等: 第二次调用 created=0 / kept=6;
 *   4 用户改过的文档绝不被覆盖 (最关键的安全性质);
 *   5 源码侧: /channel 那行读真源 (loadPersonaDocs), 不再读内联 metadata。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensurePersonaDocs, PERSONA_DOC_FILES, personaDirOf } from '../bootstrap/persona-init.js';

let TMP = '';
beforeAll(() => { TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bolloon-persona-init-')); });
afterAll(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败不影响判定 */ } });

describe('ensurePersonaDocs', () => {
  it('1+2 全建出来, 且带名字与 agentId (两个 agent 内容不同)', async () => {
    const a = await ensurePersonaDocs('agent-233', { name: '233', home: TMP });
    expect(a.created.sort()).toEqual([...PERSONA_DOC_FILES].sort());
    const aSoul = fs.readFileSync(path.join(personaDirOf('agent-233', TMP), 'soul.md'), 'utf-8');
    expect(aSoul).toContain('233');
    expect(aSoul).toContain('agent-233');

    const b = await ensurePersonaDocs('agent-xiaomi', { name: 'xiaomi', home: TMP });
    expect(b.created.length).toBe(6);
    const bSoul = fs.readFileSync(path.join(personaDirOf('agent-xiaomi', TMP), 'soul.md'), 'utf-8');
    expect(bSoul).toContain('xiaomi');
    expect(bSoul).not.toBe(aSoul);
  });

  it('3 幂等: 再调一次 created=0 / kept=6', async () => {
    await ensurePersonaDocs('idem', { name: 'idem', home: TMP });
    const again = await ensurePersonaDocs('idem', { name: 'idem', home: TMP });
    expect(again.created).toEqual([]);
    expect(again.kept.sort()).toEqual([...PERSONA_DOC_FILES].sort());
  });

  it('4 用户改过的文档绝不被覆盖', async () => {
    await ensurePersonaDocs('edited', { name: 'edited', home: TMP });
    const f = path.join(personaDirOf('edited', TMP), 'soul.md');
    fs.writeFileSync(f, '我手写的 soul, 不许覆盖', 'utf-8');
    await ensurePersonaDocs('edited', { name: 'edited-改名了', home: TMP });
    expect(fs.readFileSync(f, 'utf-8')).toBe('我手写的 soul, 不许覆盖');
    fs.unlinkSync(f);
    const r = await ensurePersonaDocs('edited', { name: 'edited', home: TMP });
    expect(r.created).toEqual(['soul']);
  });

  it('空 agentId ⇒ 不建任何东西', async () => {
    const r = await ensurePersonaDocs('', { home: TMP });
    expect(r.created).toEqual([]);
  });

  it('5 源码侧: /channel 的 persona 行读真源', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');
    expect(src).not.toContain('r.channel.persona?.description || r.channel.persona?.personality');
    expect(src).toContain('loadPersonaDocs(agentId)');
  });
});
