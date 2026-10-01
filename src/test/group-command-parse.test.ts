/**
 * /group 子命令解析 (2026-10-01 用户要求把 /group 做成 orbitdb 群聊指令)。
 * 只测**纯解析** —— 真正的群读写要 OrbitDB, 由既有 P0-P5 那套门覆盖。
 */
import { describe, it, expect } from 'vitest';
import { parseGroupSub } from '../index.js';

describe('parseGroupSub', () => {
  it('无参 ⇒ list', () => expect(parseGroupSub('/group')).toEqual({ sub: 'list', arg: '' }));
  it('新群/加入/发送/日志', () => {
    expect(parseGroupSub('/group new 测试群')).toEqual({ sub: 'new', arg: '测试群' });
    expect(parseGroupSub('/group join /orbitdb/abc')).toEqual({ sub: 'join', arg: '/orbitdb/abc' });
    expect(parseGroupSub('/group send 你好 世界')).toEqual({ sub: 'send', arg: '你好 世界' });
    expect(parseGroupSub('/group log 20')).toEqual({ sub: 'log', arg: '20' });
  });
  it('别名 (ls/n/add/msg/history)', () => {
    expect(parseGroupSub('/group ls').sub).toBe('list');
    expect(parseGroupSub('/group n 群').sub).toBe('new');
    expect(parseGroupSub('/group add 链接').sub).toBe('join');
    expect(parseGroupSub('/group msg hi').sub).toBe('send');
    expect(parseGroupSub('/group history 5').sub).toBe('log');
  });
  it('未知子命令 ⇒ help (并把原文留在 arg 里, 便于提示)', () => {
    const r = parseGroupSub('/group 乱写');
    expect(r.sub).toBe('help');
    expect(r.arg).toBe('乱写');
  });
  it('大小写不敏感', () => expect(parseGroupSub('/GROUP New X').sub).toBe('new'));
});
