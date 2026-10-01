/**
 * 建 session 必须把**按频道算好的身份**传进去 (2026-10-01)。
 *
 * 真事故: `createAgentSession({...})` 漏了 `identityDoc` ⇒ ① index.ts 里算好的频道身份被丢掉;
 *   ② session 工厂的更新路径以 `config.identityDoc?.did` 为条件 ⇒ 永不触发 ⇒ 切频道复用同一 session 时
 *   **身份不换**(实测"差一格": 233→智能体 显示 233, 智能体→233 显示 智能体)。
 * 这条门用**源级**核对把它钉住 —— 单元测试很难覆盖这条装配线, 而漏了它的后果是全套身份修复都白做。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf-8');

describe('createAgentSession 的身份装配', () => {
  it('调用必须传 identityDoc (漏了 ⇒ 身份不换, 且工厂的 updateIdentity 永不触发)', () => {
    const i = SRC.indexOf('createAgentSession({');
    expect(i, '没找到 createAgentSession 调用').toBeGreaterThan(-1);
    const call = SRC.slice(i, SRC.indexOf('});', i));
    expect(call, '调用里缺 identityDoc').toContain('identityDoc');
  });
  it('同时要传 agentId (persona/身份文档按 agent 加载) 和 loadSessionKey (历史回灌)', () => {
    const i = SRC.indexOf('createAgentSession({');
    const call = SRC.slice(i, SRC.indexOf('});', i));
    expect(call).toContain('agentId');
    expect(call).toContain('loadSessionKey');
  });
  it('identityDoc 必须是从 channel 解析出来的那个 (不是 undefined 变量名)', () => {
    const i = SRC.indexOf('createAgentSession({');
    const call = SRC.slice(i, SRC.indexOf('});', i));
    // 传的是裸标识符 identityDoc ⇒ 上面必须有它的赋值
    expect(call).toMatch(/^\s*identityDoc,\s*$/m);
    expect(SRC).toContain('let identityDoc: any;');
  });
});
