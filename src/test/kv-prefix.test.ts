/**
 * kv-prefix.test.ts — 「前缀 KV 可命中」链路的聚焦单测 (2026-09-28)
 *
 * 这里测的是**纯函数**那一层 (规范化 / 注入 / 幂等 / 预算 / 分流 / 指纹 / 日志格式).
 * 整链的字节级前缀断言在 scripts/verify-kv-prefix.ts (带假 transport 的离线门), 不在单测里.
 */

import { describe, it, expect } from 'vitest';
import {
  CURRENT_TURN_MARKER,
  CURRENT_TURN_BUDGET_CHARS,
  SYSTEM_PROMPT_CACHE_TTL_MS,
  LIGHTWEIGHT_SYSTEM_MAX_CHARS,
  MAIN_AGENT_PURPOSE,
  assembleCurrentTurn,
  buildLightweightSystem,
  canonicalizeJson,
  canonicalizeTools,
  extractUsage,
  formatKvServerLine,
  injectCurrentTurn,
  isLightweightPurpose,
  isLocalEndpoint,
  modelFingerprint,
  prefixHashes,
  shouldUseCachePrompt,
  splitLayerBlocks,
  toolsHashOf,
} from '../llm/pi-ai.js';
import { writeBackCurrentTurnInto } from '../agents/pi-sdk.js';

describe('canonicalizeJson / canonicalizeTools', () => {
  it('递归排对象 key', () => {
    expect(JSON.stringify(canonicalizeJson({ b: 1, a: { d: 2, c: [3] } }))).toBe('{"a":{"c":[3],"d":2},"b":1}');
  });

  it('数组保序 (只排对象的 key, 不动数组顺序)', () => {
    const out = canonicalizeJson({ list: [{ z: 1, a: 2 }, { y: 3, b: 4 }] });
    expect(JSON.stringify(out)).toBe('{"list":[{"a":2,"z":1},{"b":4,"y":3}]}');
  });

  it('tools 按 function.name 升序 (调用方给的顺序不影响出网字节)', () => {
    const t = (name: string) => ({ type: 'function', function: { name, parameters: { type: 'object' } } });
    const a = canonicalizeTools([t('write'), t('grep'), t('read')]);
    const b = canonicalizeTools([t('read'), t('write'), t('grep')]);
    expect(a.map((x) => x.function.name)).toEqual(['grep', 'read', 'write']);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('嵌套 key 顺序抖动也归一', () => {
    const mk = (props: Record<string, any>) => [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: props } } }];
    const a = canonicalizeTools(mk({ a: { type: 'string' }, b: { type: 'number' } }));
    const b = canonicalizeTools(mk({ b: { type: 'number' }, a: { type: 'string' } }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('非 function 形态的工具原样返回 (顺序也不动)', () => {
    expect(canonicalizeTools(['b', 'a'] as any)).toEqual(['b', 'a']);
  });
});

describe('injectCurrentTurn (注入 + 幂等)', () => {
  it('注入到最后一条 user 消息前部, 带标记', () => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U1' }];
    const r = injectCurrentTurn(msgs, 'D1');
    expect(r).toMatchObject({ injected: true, index: 1, reason: 'injected' });
    expect(msgs[1].content.startsWith(CURRENT_TURN_MARKER)).toBe(true);
    expect(msgs[1].content.endsWith('U1')).toBe(true);
    expect(msgs[1].content).toContain('D1');
  });

  it('二次注入跳过 (多 iteration / 重试不重复)', () => {
    const msgs = [{ role: 'user', content: 'U1' }];
    injectCurrentTurn(msgs, 'D1');
    const once = msgs[0].content;
    const r2 = injectCurrentTurn(msgs, 'D2');
    expect(r2.reason).toBe('already');
    expect(msgs[0].content).toBe(once);
    expect((msgs[0].content.match(/current-turn: runtime/g) || []).length).toBe(1);
  });

  it('没有 user 消息 → 不硬塞 (交给 chat() 明确追加)', () => {
    const msgs = [{ role: 'system', content: 'S' }];
    expect(injectCurrentTurn(msgs as any, 'D').reason).toBe('no-user-message');
    expect(msgs[0].content).toBe('S');
  });

  it('动态文本为空 → 无动作', () => {
    const msgs = [{ role: 'user', content: 'U' }];
    expect(injectCurrentTurn(msgs, '   ').reason).toBe('no-dynamic-text');
  });
});

describe('assembleCurrentTurn (预算: 从后往前保住更可操作的段)', () => {
  it('不超预算时原样拼 (顺序 = 装配顺序)', () => {
    expect(assembleCurrentTurn(['A', 'B'], 100)).toBe('A\n\nB');
  });

  it('超预算先压前面的段, 保住最后一段 (调用方易变段)', () => {
    const out = assembleCurrentTurn(['X'.repeat(500), 'KEEP-ME'], 200);
    expect(out).toContain('KEEP-ME');
    expect(out.startsWith('X')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200 + 40);
  });

  it('最后一段自己就超预算 → 截断它并留标注', () => {
    const out = assembleCurrentTurn(['X'.repeat(50), 'Y'.repeat(500)], 100);
    expect(out).toContain('超预算截断');
    expect(out.length).toBeLessThanOrEqual(200);
  });

  it('预算是个有限值 (不是无限放行)', () => {
    expect(CURRENT_TURN_BUDGET_CHARS).toBeGreaterThan(500);
    expect(CURRENT_TURN_BUDGET_CHARS).toBeLessThan(8000);
  });
});

describe('purpose 分流 (重 / 轻) 与 cache_prompt', () => {
  it('只有 main-agent 是重路径', () => {
    expect(isLightweightPurpose('main-agent')).toBe(false);
    for (const p of ['summarize', 'improve', 'auto-compact', 'social', 'health', 'p2p', 'cron', 'judgment', 'probe', 'chat']) {
      expect(isLightweightPurpose(p)).toBe(true);
    }
  });

  it('缺省 purpose (老调用方) 按轻量处理', () => {
    expect(isLightweightPurpose(undefined)).toBe(true);
  });

  it('cache_prompt 只给 main-agent', () => {
    expect(shouldUseCachePrompt('main-agent')).toBe(true);
    for (const p of ['summarize', 'improve', 'auto-compact', 'social', 'health', 'p2p', 'cron', 'judgment', 'probe', 'chat', undefined]) {
      expect(shouldUseCachePrompt(p as any)).toBe(false);
    }
    expect(MAIN_AGENT_PURPOSE).toBe('main-agent');
  });

  it('BOLLOON_DISABLE_CACHE_PROMPT=1 彻底关', () => {
    expect(shouldUseCachePrompt('main-agent', { BOLLOON_DISABLE_CACHE_PROMPT: '1' } as any)).toBe(false);
    expect(shouldUseCachePrompt('main-agent', {} as any)).toBe(true);
  });

  it('cache_prompt 只对本机 endpoint 有语义', () => {
    expect(isLocalEndpoint('http://localhost:8080/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false);
  });
});

describe('buildLightweightSystem (轻量提示)', () => {
  it('短 system + 带上调用方自己那截 (不静默丢)', () => {
    const s = buildLightweightSystem('health', 'heartbeat', '你是探针');
    expect(s.length).toBeLessThan(400);
    expect(s).toContain('健康探针');
    expect(s).toContain('你是探针');
    expect(s).not.toContain('bolloon-runtime');
  });

  it('调用方 system 超上限 → 截断 + 标注 (有界)', () => {
    const s = buildLightweightSystem('chat', 'x', 'A'.repeat(LIGHTWEIGHT_SYSTEM_MAX_CHARS + 500));
    expect(s).toContain('超上限截断');
    expect(s.length).toBeLessThan(LIGHTWEIGHT_SYSTEM_MAX_CHARS + 400);
  });

  it('没有调用方 system 也能用', () => {
    expect(buildLightweightSystem('probe').length).toBeGreaterThan(10);
  });
});

describe('splitLayerBlocks (stable / dynamic 拆分)', () => {
  const text = [
    '<!-- core.identity@1.0.0 -->',
    '身份层',
    '<!-- core.tools.thin@1.0.0 -->',
    '工具层',
    '<!-- dynamic.project-context@1.0.0 -->',
    '项目上下文 (会变)',
  ].join('\n');

  it('按 source=function 的层 id 切出动态段, 稳定段保持原顺序', () => {
    const { stableText, dynamicText } = splitLayerBlocks(text, new Set(['dynamic.project-context']));
    expect(stableText).toBe('身份层\n\n工具层');
    expect(dynamicText).toBe('项目上下文 (会变)');
    expect(stableText).not.toContain('dynamic.project-context');
  });

  it('动态层空内容 → 不产出动态段 (空标记不进 CURRENT TURN)', () => {
    const t = '<!-- core.identity@1.0.0 -->\n身份\n<!-- dynamic.project-context@1.0.0 -->\n';
    const { stableText, dynamicText } = splitLayerBlocks(t, new Set(['dynamic.project-context']));
    expect(dynamicText).toBe('');
    expect(stableText).toBe('身份');
  });

  it('没有标记 → 全归稳定段 (降级安全)', () => {
    expect(splitLayerBlocks('纯文本', new Set(['x']))).toEqual({ stableText: '纯文本', dynamicText: '' });
  });
});

describe('诊断 (只打数字与 hash)', () => {
  it('逐消息前缀 hash: 单调前缀 + 变了就变', () => {
    const h1 = prefixHashes([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
    const h2 = prefixHashes([{ role: 'system', content: 'S' }, { role: 'user', content: 'U!' }]);
    expect(h1).toHaveLength(2);
    expect(h1[0]).toMatch(/^[0-9a-f]{12}$/);
    expect(h1[0]).toBe(h2[0]);          // 前一条没变 → 前缀 hash 不变
    expect(h1[1]).not.toBe(h2[1]);      // 自己变了 → 变
  });

  it('tools hash: 顺序无关 / 内容相关 / 空集给 "-"', () => {
    const t = (name: string) => ({ type: 'function', function: { name } });
    expect(toolsHashOf([t('a'), t('b')])).toBe(toolsHashOf([t('b'), t('a')]));
    expect(toolsHashOf([t('a')])).not.toBe(toolsHashOf([t('a'), t('b')]));
    expect(toolsHashOf(undefined)).toBe('-');
    expect(toolsHashOf([])).toBe('-');
  });

  it('usage 解析: OpenAI details / deepseek cache / llama.cpp timings 都认', () => {
    expect(extractUsage({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } }))
      .toMatchObject({ promptTokens: 100, cachedTokens: 80 });
    expect(extractUsage({ usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 60 } }))
      .toMatchObject({ promptTokens: 100, cachedTokens: 60 });
    expect(extractUsage({ timings: { prompt_n: 500, cache_n: 400, predicted_n: 3 } }))
      .toMatchObject({ promptTokens: 500, cachedTokens: 400 });
    expect(extractUsage({})).toMatchObject({ promptTokens: 0, cachedTokens: 0 });
  });

  it('kv 行只含数字 (无内容)', () => {
    const line = formatKvServerLine('main-agent', { promptTokens: 400, cachedTokens: 300, completionTokens: 5 });
    expect(line).toBe('[kv-server] purpose=main-agent cached=300 prompt=400 hit=75.0%');
    expect(formatKvServerLine('health', { promptTokens: 0, cachedTokens: 0, completionTokens: 0 })).toContain('hit=?');
    expect(formatKvServerLine('main-agent', { promptTokens: 10, cachedTokens: 1, completionTokens: 1 }, { stream: true })).toContain('stream');
  });

  it('装配缓存 TTL 是个有限窗口 (10 分钟)', () => {
    expect(SYSTEM_PROMPT_CACHE_TTL_MS).toBe(600000);
  });
});

describe('modelFingerprint (指纹: 稳定 / 敏感 / 不含明文)', () => {
  const base = { provider: 'openai', model: 'm', baseUrl: 'http://x', apiKey: 'sk-secret-value' };

  it('同参稳定, 出网只出 hex', () => {
    const fp = modelFingerprint(base);
    expect(fp).toBe(modelFingerprint({ ...base }));
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('sk-secret-value');
  });

  it('key / model / baseUrl / providerId 任一变化 → 指纹变', () => {
    const fp = modelFingerprint(base);
    expect(modelFingerprint({ ...base, apiKey: 'sk-other' })).not.toBe(fp);
    expect(modelFingerprint({ ...base, model: 'm2' })).not.toBe(fp);
    expect(modelFingerprint({ ...base, baseUrl: 'http://y' })).not.toBe(fp);
    expect(modelFingerprint({ ...base, providerId: 'custom-x' })).not.toBe(fp);
  });
});

describe('writeBackCurrentTurnInto (回写调用方 history)', () => {
  const wire = (content: string) => [{ role: 'system', content: 'S' }, { role: 'user', content }];
  const injectedWith = (inner: string) => `${CURRENT_TURN_MARKER}\nD1\n\n---\n\n${inner}`;

  it('user 条目: 注入是"前部加了一段" → 整段写回', () => {
    const history = [{ role: 'user', content: 'U1' }];
    expect(writeBackCurrentTurnInto(history, wire(injectedWith('U1')))).toBe(1);
    expect(history[0].content).toBe(injectedWith('U1'));
  });

  it('tool 条目: 写回的是含 [工具结果] 前缀的整段 (下轮原样回带)', () => {
    const history = [{ role: 'user', content: 'U1' }, { role: 'tool', content: 'TR1' }];
    expect(writeBackCurrentTurnInto(history, wire(injectedWith('[工具结果]\nTR1')))).toBe(1);
    expect(history[1].content).toBe(injectedWith('[工具结果]\nTR1'));
  });

  it('幂等: 第二次写回 0 条', () => {
    const history = [{ role: 'user', content: 'U1' }];
    writeBackCurrentTurnInto(history, wire(injectedWith('U1')));
    expect(writeBackCurrentTurnInto(history, wire(injectedWith('U1')))).toBe(0);
  });

  it('没注入过的 wire → 不动 history', () => {
    const history = [{ role: 'user', content: 'U1' }];
    expect(writeBackCurrentTurnInto(history, wire('U1'))).toBe(0);
    expect(history[0].content).toBe('U1');
  });

  it('匹配不上 → 不动 (绝不乱改历史)', () => {
    const history = [{ role: 'user', content: '完全不相干的文本' }];
    expect(writeBackCurrentTurnInto(history, wire(injectedWith('U1')))).toBe(0);
    expect(history[0].content).toBe('完全不相干的文本');
  });

  it('空/坏输入不炸', () => {
    expect(writeBackCurrentTurnInto([], wire('x'))).toBe(0);
    expect(writeBackCurrentTurnInto([{ role: 'user', content: 'u' }], undefined)).toBe(0);
  });
});
