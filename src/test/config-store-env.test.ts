/**
 * config-store-env.test.ts — 2026-10-23: 磁盘 config + .env 覆盖 (密钥分离)
 *
 * 验证: initialize() 读盘后, provider API key 优先取环境变量 (env-key 覆盖文件值),
 * 使 `~/.bolloon/.env` 成为密钥真源, `bolloon-config.json` 不必明文存 key。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { llmConfigStore } from '../llm/config-store.js';

// 拼接构造 key 字面量, 避免工具显示层的 apiKey 脱敏把 `sk-***` 真写进源文件
const K1 = 'sk-glm' + '-from-env';
const K2 = 'sk-file' + '-old';
const K3 = 'sk-glm' + '-new';

let TEST_HOME: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  TEST_HOME = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bolloon-cfgenv-'));
  process.env.BOLLOON_HOME = TEST_HOME;
  for (const k of Object.keys(process.env)) saved[k] = process.env[k];
  // 清掉可能干扰的 provider env
  for (const k of Object.keys(process.env)) {
    if (k.endsWith('_API_KEY')) delete process.env[k];
  }
  // 写一份最小 config: glm enabled + 空 apiKey
  const cfg = {
    activeProvider: 'glm',
    updatedAt: new Date().toISOString(),
    providers: {
      glm: { enabled: true, apiKey: '', baseUrl: 'https://llm.example.com/v1', model: 'glm-x', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
      deepseek: { enabled: false, apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'm', temperature: 0.7, maxTokens: 4096, requiresApiKey: true },
    },
    customProviders: {},
  };
  await fs.promises.mkdir(TEST_HOME, { recursive: true });
  await fs.promises.writeFile(path.join(TEST_HOME, 'bolloon-config.json'), JSON.stringify(cfg));
  // 单例按 (dir + 文件签名) 缓存 —— 用例间必须作废, 否则第二个用例读到第一个用例的 config
  llmConfigStore.invalidate();
});
afterEach(async () => {
  llmConfigStore.invalidate();
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  await fs.promises.rm(TEST_HOME, { recursive: true, force: true });
});

describe('config-store env-key 覆盖 (secrets in .env)', () => {
  it('env 有 GLM_API_KEY → 覆盖文件里空 key', async () => {
    process.env.GLM_API_KEY = K1;
    await llmConfigStore.initialize();
    const cfg = await llmConfigStore.getActiveProviderConfig();
    expect(cfg?.apiKey).toBe(K1);
  });

  it('env 无 key → 保留文件里的值 (无覆盖, 不丢)', async () => {
    // 重写文件: glm 带旧 key
    const p = path.join(TEST_HOME, 'bolloon-config.json');
    const d = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    d.providers.glm.apiKey = K2;
    await fs.promises.writeFile(p, JSON.stringify(d));
    await llmConfigStore.initialize();
    const cfg = await llmConfigStore.getActiveProviderConfig();
    expect(cfg?.apiKey).toBe(K2);
  });

  it('env key 优先于文件里的旧值 (env 是新真源)', async () => {
    const p = path.join(TEST_HOME, 'bolloon-config.json');
    const d = JSON.parse(await fs.promises.readFile(p, 'utf8'));
    d.providers.glm.apiKey = K3 + '-stale';
    await fs.promises.writeFile(p, JSON.stringify(d));
    process.env.GLM_API_KEY = K3;
    await llmConfigStore.initialize();
    const cfg = await llmConfigStore.getActiveProviderConfig();
    expect(cfg?.apiKey).toBe(K3);
  });
});