/**
 * contact-proactivity.test.ts — 联系工具主动性三档 (2026-10-19, leo: 「需要给到 AI 主动性来做」)
 *
 * 背景: 手机号目录四工具原先是**纯被动** —— description 写死"用于用户明确说"。本轮放开主动性,
 *   但按仓库既有边界分层 (contact policy / Harness fail-closed 同款口径):
 *     ① lookup 只读无外发            ⇒ **主动做**, 不等明确要求;
 *     ② add_friend / retract 外发/改状态 ⇒ **主动提议, 用户确认后才做**;
 *     ③ publish 暴露用户自己的手机号指针  ⇒ **永不自主**, 先问用户确认 (隐私门不许放松)。
 *
 * 判据走**真实注册** (registerContactTools + fake ctx) 后断 description ——
 * description 就是 AI 的行为指令, 比 grep 源码文本更接近事实。
 * 提示词层 (system-prompt .../core/external-engagement.md 的同名节) 一并钉住, 防回归。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerContactTools } from '../agents/contacts/tools.js';
import { ContactChain } from '../agents/contacts/chain.js';

function registeredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  registerContactTools({ tools } as any, new ContactChain({ home: '/tmp/never-existed', ownerDid: 'did:test', displayName: '测试' }));
  return tools;
}

describe('联系工具主动性 (2026-10-19)', () => {
  it('四个目录工具都注册 (含三档各自的行为指令)', () => {
    const tools = registeredTools();
    for (const name of ['directory.lookup', 'directory.add_friend', 'directory.publish', 'directory.retract']) {
      expect(tools.has(name), `${name} 未注册`).toBe(true);
    }
  });

  it('① lookup: 只读 ⇒ 授权主动调用 (不等明确要求)', () => {
    const d = registeredTools().get('directory.lookup').description as string;
    expect(d).toMatch(/可以主动调用/);
    expect(d).toMatch(/只读/);
    expect(d, '旧被动措辞必须去掉').not.toMatch(/用于.*用户说/);
  });

  it('② add_friend: 表达意图即主动发起, 但发送前确认目标+附言 (对外通信动作不放飞)', () => {
    const d = registeredTools().get('directory.add_friend').description as string;
    expect(d).toMatch(/主动发起/);
    expect(d).toMatch(/确认目标手机号与申请附言/);
    expect(d).toMatch(/consent/);                       // 对方同意前不算好友
  });

  it('② retract: 用户表露隐私顾虑时主动提议撤销', () => {
    const d = registeredTools().get('directory.retract').description as string;
    expect(d).toMatch(/主动提议/);
  });

  it('③ publish: 隐私门不许放松 — 可以主动提议, 但未经确认绝不自主发布', () => {
    const d = registeredTools().get('directory.publish').description as string;
    expect(d).toMatch(/主动提议/);                       // 主动性: 该提议时要提议
    expect(d).toMatch(/先问用户确认/);                   // 隐私: 确认门一字不让
    expect(d).toMatch(/绝不自主发布/);
  });

  it('提示词层钉住三档规则 (external-engagement.md 社交主动性节, 防回归)', () => {
    const p = path.join(process.cwd(), 'src/llm/system-prompt/layers/core/external-engagement.md');
    const md = fs.readFileSync(p, 'utf8');
    expect(md).toMatch(/对人类联系 proactive/);
    expect(md).toMatch(/主动做.*只读/);
    expect(md).toMatch(/主动提议, 确认后才做/);
    expect(md).toMatch(/永不自主/);
    expect(md).toMatch(/2026-10-19/);                    // 日期戳: 后续改动可溯源
  });
});
