/**
 * contact-proactivity.test.ts — 联系工具主动性 (2026-10-19, leo: 「默认主动, web 和手机也是, 联系人的 agent 你也要主动维护关系」)
 *
 *  posture (默认主动): 用户表达意图就执行, 不等反复催; 只读动作想做就做;
 *   唯一例外 = 暴露用户自己的联系方式 (publish) 必须经用户确认 (隐私)。
 *  联系人的 agent 关系也要主动维护 (打招呼/同步/沉淀关系事实), 不是躺列。
 *
 * 判据分两面, 缺一不可:
 *   A. **行为指令在不在** — 真实 registerContactTools 注册后断 description (description 就是系统提示);
 *   B. **装配后真的进 prompt** — 走真实 assembleSystemPrompt (带 maxChars/TOTAL_BUDGET 截断) 断新层
 *      (2026-10-19 实测教训: 上轮把内容追加进 core.external-engagement, 该层 maxChars=400,
 *      追加节只进了文件没进 prompt = 假绿; 所以本轮独立成层 core.social-proactivity, 并在这里
 *      断**装配结果**而不是断文件);
 *   C. **手机端同文** — 手机自带 system (mobile-harness), 与桌面层同文, 钉住关键子串一致性。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { registerContactTools } from '../agents/contacts/tools.js';
import { ContactChain } from '../agents/contacts/chain.js';
import { assembleSystemPrompt } from '../llm/system-prompt/registry.js';

function registeredTools(): Map<string, any> {
  const tools = new Map<string, any>();
  registerContactTools({ tools } as any, new ContactChain({ home: '/tmp/never-existed', ownerDid: 'did:test', displayName: '测试' }));
  return tools;
}

describe('A. 工具行为指令 (默认主动)', () => {
  it('四个目录工具都注册', () => {
    const tools = registeredTools();
    for (const name of ['directory.lookup', 'directory.add_friend', 'directory.publish', 'directory.retract']) {
      expect(tools.has(name), `${name} 未注册`).toBe(true);
    }
  });

  it('lookup: 只读 ⇒ 主动调用 (不等明确要求)', () => {
    const d = registeredTools().get('directory.lookup').description as string;
    expect(d).toMatch(/可以主动调用/);
    expect(d).toMatch(/只读/);
  });

  it('add_friend: 默认主动发起 (表达意图即执行, 仅歧义才先问; consent 前不算好友)', () => {
    const d = registeredTools().get('directory.add_friend').description as string;
    expect(d).toMatch(/默认主动发起/);
    expect(d).toMatch(/歧义/);
    expect(d).toMatch(/consent/);
  });

  it('retract: 用户表露隐私顾虑时主动提议撤销', () => {
    const d = registeredTools().get('directory.retract').description as string;
    expect(d).toMatch(/主动提议/);
  });

  it('publish: 隐私唯一例外 — 可主动提议, 但未经确认绝不自主发布', () => {
    const d = registeredTools().get('directory.publish').description as string;
    expect(d).toMatch(/主动提议/);
    expect(d).toMatch(/先问用户确认/);
    expect(d).toMatch(/绝不自主发布/);
  });
});

describe('B. 装配后真的进 prompt (防 maxChars 截断假绿)', () => {
  it('core.social-proactivity 注册且 appliesTo all (CLI/web 同一装配)', async () => {
    const reg = fs.readFileSync(path.join(process.cwd(), 'src/llm/system-prompt/registry.ts'), 'utf8');
    expect(reg).toMatch(/'core\.social-proactivity'[^)]*appliesTo: \['all'\][^)]*maxChars: 800/);
    // 校验脚本的 maxChars 表与 registry 手同步 (两边都要有, 不许单边)
    const val = fs.readFileSync(path.join(process.cwd(), 'scripts/validate-system-prompt.ts'), 'utf8');
    expect(val).toMatch(/'core\/social-proactivity': 800/);
  });

  it('真实 assembleSystemPrompt(local) 的输出含主动性 posture + 关系维护, 且没被截断', async () => {
    const { text, truncated } = await assembleSystemPrompt({ channel: 'local' });
    expect(text).toMatch(/默认主动/);
    expect(text).toMatch(/维护联系人的 agent 关系/);
    expect(text).toMatch(/send_message/);
    expect(text).toMatch(/kind: relationship|relationship/);
    expect(truncated, '新层不许进 truncated 名单 (预算被吃光)').not.toContain('core.social-proactivity');
    // 截断标记: 新层正文必须完整 (结尾的关系维护句在)
    expect(text).toMatch(/上线接续/);
    expect(text).not.toMatch(/\[… 已截断\]\s*$/);
  });
});

describe('C. 手机端同文 (mobile-harness 自带 system)', () => {
  it('mobile ContextManager.build 的 system 含同一 posture 三句', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/web/mobile-harness.ts'), 'utf8');
    expect(src).toMatch(/默认主动: 用户表达意图就执行/);
    expect(src).toMatch(/维护联系人的 agent 关系 \(主动, 不等用户催\)/);
    expect(src).toMatch(/唯一例外: 暴露用户自己的联系方式/);
  });
});
