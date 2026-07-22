/**
 * external-engines.test.ts — 外部编码智能体 发现/映射/委派 单元测试
 *
 * 重点测纯函数 + 注入 deps 的发现逻辑, 不真实碰 fs / 不真实 spawn.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveProvider,
  parseExperimentFile,
  mapEngineToProviderConfig,
  buildDelegateArgs,
  discoverEngines,
  type DiscoveryDeps,
} from '../external-engines/index.js';

describe('resolveProvider', () => {
  it('识别已知 provider', () => {
    expect(resolveProvider('anthropic', 'openai')).toBe('anthropic');
    expect(resolveProvider('openai-compatible', 'openai')).toBe('openai');
    expect(resolveProvider('moonshot', 'kimi')).toBe('kimi');
    expect(resolveProvider('azure', 'openai')).toBe('openai');
  });

  it('未知 provider 兜底到 hint', () => {
    expect(resolveProvider('some-unknown-llm', 'openai')).toBe('openai');
    expect(resolveProvider(undefined, 'anthropic')).toBe('anthropic');
  });
});

describe('parseExperimentFile', () => {
  it('顶层形态', () => {
    const r = parseExperimentFile(
      JSON.stringify({ name: 'expA', provider: 'deepseek', apiKey: 'sk-x', baseUrl: 'https://b', model: 'm' })
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'expA', provider: 'deepseek', apiKey: 'sk-x' });
  });

  it('数组形态 providers', () => {
    const r = parseExperimentFile(
      JSON.stringify({ providers: [{ name: 'p1', provider: 'gemini', apiKey: 'sk-g' }, { name: 'p2', apiKey: 'sk-o' }] })
    );
    expect(r).toHaveLength(2);
    expect(r[0].provider).toBe('gemini');
    expect(r[1].provider).toBe('openai');
  });

  it('无连接信息跳过 / 非法 JSON 返回空', () => {
    expect(parseExperimentFile('not json')).toEqual([]);
    expect(parseExperimentFile(JSON.stringify({ foo: 'bar' }))).toEqual([]);
    expect(parseExperimentFile(JSON.stringify({ name: 'x' }))).toEqual([]);
  });
});

describe('mapEngineToProviderConfig', () => {
  it('codex -> openai, 带 apiKey/baseUrl/model', () => {
    const patch = mapEngineToProviderConfig({
      id: 'codex', displayName: 'c', installed: true, configured: true, available: true,
      provider: 'openai', apiKey: 'sk-1234', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1',
      source: 'env',
    });
    expect(patch).toEqual({
      provider: 'openai',
      patch: { enabled: true, apiKey: 'sk-1234', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
    });
  });

  it('无 provider 抛错', () => {
    expect(() => mapEngineToProviderConfig({
      id: 'x', displayName: 'x', installed: true, configured: false, available: false,
      source: 'none',
    })).toThrow();
  });
});

describe('buildDelegateArgs', () => {
  it('各引擎模板 best-effort', () => {
    expect(buildDelegateArgs('codex', 'hi')).toEqual(['exec', '--full-auto', 'hi']);
    expect(buildDelegateArgs('claude-code', 'hi')).toEqual(['-p', 'hi', '--print']);
    expect(buildDelegateArgs('opencode', 'hi')).toEqual(['run', 'hi', '--format', 'json']);
    expect(buildDelegateArgs('openclaw', 'hi')).toEqual(['run', 'hi']);
    expect(buildDelegateArgs('hermes', 'hi')).toEqual(['prompt', 'hi']);
    expect(buildDelegateArgs('experiment:foo', 'hi')).toBeUndefined();
  });

  it('model 覆盖追加对应 flag', () => {
    expect(buildDelegateArgs('opencode', 'hi', 'deepseek/deepseek-v4-flash'))
      .toEqual(['run', 'hi', '--format', 'json', '-m', 'deepseek/deepseek-v4-flash']);
    expect(buildDelegateArgs('claude-code', 'hi', 'claude-opus-4'))
      .toEqual(['-p', 'hi', '--print', '--model', 'claude-opus-4']);
    // openclaw 无 modelFlag, 忽略 model
    expect(buildDelegateArgs('openclaw', 'hi', 'gpt-4o')).toEqual(['run', 'hi']);
  });
});

describe('discoverEngines (注入 deps)', () => {
  const fakeDeps = (overrides: Partial<DiscoveryDeps>): DiscoveryDeps => ({
    which: async () => undefined,
    readFile: async () => undefined,
    readdir: async () => undefined,
    env: {},
    home: '/home/test',
    ...overrides,
  });

  it('codex 安装 + 环境变量有 key → installed && configured', async () => {
    const deps = fakeDeps({
      which: async (name) => (name === 'codex' ? '/usr/bin/codex' : undefined),
      env: { OPENAI_API_KEY: 'sk-secret' },
    });
    const engines = await discoverEngines(deps);
    const codex = engines.find((e) => e.id === 'codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.configured).toBe(true);
    expect(codex.available).toBe(true);
    expect(codex.provider).toBe('openai');
    expect(codex.apiKey).toBe('sk-secret');
    expect(codex.source).toBe('env');
  });

  it('claude-code 未安装 → available=false', async () => {
    const deps = fakeDeps({ env: { ANTHROPIC_API_KEY: 'sk-a' } });
    const engines = await discoverEngines(deps);
    const cc = engines.find((e) => e.id === 'claude-code')!;
    expect(cc.installed).toBe(false);
    expect(cc.configured).toBe(true);
    expect(cc.available).toBe(false);
    expect(cc.provider).toBe('anthropic');
  });

  it('配置文件里有 apiKey 但无环境变量 → source=config', async () => {
    const cfg = JSON.stringify({ model: 'gpt-4o', apiKey: 'cfg-key' });
    const deps = fakeDeps({
      which: async () => '/bin/opencode',
      readFile: async (p) => (p.includes('opencode.json') ? cfg : undefined),
    });
    const engines = await discoverEngines(deps);
    const oc = engines.find((e) => e.id === 'opencode')!;
    expect(oc.installed).toBe(true);
    expect(oc.apiKey).toBe('cfg-key');
    expect(oc.source).toBe('config');
    expect(oc.model).toBe('gpt-4o');
  });

  it('experiment 目录扫描出声明的 API', async () => {
    const expJson = JSON.stringify({ providers: [{ name: 'exp1', provider: 'deepseek', apiKey: 'sk-d' }] });
    const deps = fakeDeps({
      readdir: async (dir) => (dir.endsWith('.bolloon/experiments') ? ['a.json'] : undefined),
      readFile: async (p) => (p.endsWith('a.json') ? expJson : undefined),
    });
    const engines = await discoverEngines(deps);
    const exp = engines.find((e) => e.id === 'experiment:exp1');
    expect(exp).toBeDefined();
    expect(exp!.provider).toBe('deepseek');
    expect(exp!.available).toBe(true);
  });

  it('experiment 目录不存在 → 不产生 experiment 引擎', async () => {
    const deps = fakeDeps({ readdir: async () => undefined });
    const engines = await discoverEngines(deps);
    expect(engines.filter((e) => e.id.startsWith('experiment:'))).toHaveLength(0);
  });

  it('opencode 发现时带可筛选的模型候选列表', async () => {
    const cfg = JSON.stringify({ provider: 'openai', apiKey: 'sk-o' });
    const deps = fakeDeps({
      which: async () => '/bin/opencode',
      readFile: async (p) => (p.includes('opencode.json') ? cfg : undefined),
    });
    const engines = await discoverEngines(deps);
    const oc = engines.find((e) => e.id === 'opencode')!;
    expect(Array.isArray(oc.models) && oc.models!.length).toBeGreaterThan(0);
    expect(oc.models).toContain('gpt-4.1');
    expect(oc.models).toContain('claude-sonnet-4-5-20250929');
  });

  it('配置文件声明 models 数组时优先于规格预置列表', async () => {
    const cfg = JSON.stringify({ apiKey: 'sk-x', models: ['my-custom-model-a', 'my-custom-model-b'] });
    const deps = fakeDeps({
      which: async () => '/bin/opencode',
      readFile: async (p) => (p.includes('opencode.json') ? cfg : undefined),
    });
    const engines = await discoverEngines(deps);
    const oc = engines.find((e) => e.id === 'opencode')!;
    expect(oc.models).toEqual(['my-custom-model-a', 'my-custom-model-b']);
  });

  it('导入时 model 覆盖生效 (mapEngineToProviderConfig 用 engine.model)', () => {
    const patch = mapEngineToProviderConfig({
      id: 'opencode', displayName: 'o', installed: true, configured: true, available: true,
      provider: 'openai', apiKey: 'sk-1', model: 'gpt-4o-mini', source: 'env',
    });
    expect(patch.patch.model).toBe('gpt-4o-mini');
  });
});
