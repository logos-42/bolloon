/**
 * env-loader.test.ts — 集中环境变量解析 (.env/config 分离)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  bolloonHome,
  envStr,
  parseDotEnvLine,
  loadDotEnvSync,
  __resetDotEnvLoaded,
} from '../bootstrap/env-loader.js';

let TEST_DIR: string;
let saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  TEST_DIR = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bolloon-env-'));
  __resetDotEnvLoaded();
  saved = {};
  for (const k of Object.keys(process.env)) saved[k] = process.env[k];
});
afterEach(async () => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  await fs.promises.rm(TEST_DIR, { recursive: true, force: true });
  __resetDotEnvLoaded();
});

describe('bolloonHome — home 解析', () => {
  it('BOLLOON_HOME 优先', () => {
    expect(bolloonHome({ BOLLOON_HOME: '/x', HOME: '/home/u' })).toBe('/x');
  });
  it('无 BOLLOON_HOME → HOME/.bolloon', () => {
    expect(bolloonHome({ HOME: '/home/u' })).toBe(path.join('/home/u', '.bolloon'));
  });
});

describe('envStr — 类型安全读取', () => {
  it('未定义 → 默认值', () => {
    expect(envStr('NOPE', 'd', {})).toBe('d');
  });
  it('空串 → 默认值; 有值去空白', () => {
    expect(envStr('A', 'd', { A: '  ' })).toBe('d');
    expect(envStr('A', 'd', { A: ' v ' })).toBe('v');
  });
});

describe('parseDotEnvLine', () => {
  it('解析 KEY=VALUE', () => {
    expect(parseDotEnvLine('FOO=bar')).toEqual({ key: 'FOO', value: 'bar' });
  });
  it('注释/空行/无等号 → null', () => {
    expect(parseDotEnvLine('# c')).toBeNull();
    expect(parseDotEnvLine('   ')).toBeNull();
    expect(parseDotEnvLine('NOEQ')).toBeNull();
  });
  it('引号包裹', () => {
    expect(parseDotEnvLine("KEY='v a l'")).toEqual({ key: 'KEY', value: 'v a l' });
    expect(parseDotEnvLine('KEY="va l"')).toEqual({ key: 'KEY', value: 'va l' });
  });
});

describe('loadDotEnvSync', () => {
  it('读取 <home>/.env 灌入 process.env', async () => {
    await fs.promises.writeFile(path.join(TEST_DIR, '.env'),
      '# comment\nMINIMAX_API_KEY=sk-test-123\nGLM_API_KEY="sk-glm-456"\n');
    const n = loadDotEnvSync(TEST_DIR);
    expect(n).toBe(2);
    expect(process.env.MINIMAX_API_KEY).toBe('sk-test-123');
    expect(process.env.GLM_API_KEY).toBe('sk-glm-456');
  });
  it('不覆盖已存在的 env (真实 shell 优先)', async () => {
    process.env.MINIMAX_API_KEY = 'from-shell';
    await fs.promises.writeFile(path.join(TEST_DIR, '.env'), 'MINIMAX_API_KEY=from-file\n');
    loadDotEnvSync(TEST_DIR);
    expect(process.env.MINIMAX_API_KEY).toBe('from-shell');
  });
  it('无 .env → 静默 0', () => {
    expect(loadDotEnvSync(TEST_DIR)).toBe(0);
  });
  it('幂等: 二次调用不重载', async () => {
    await fs.promises.writeFile(path.join(TEST_DIR, '.env'), 'A=1\n');
    loadDotEnvSync(TEST_DIR);
    process.env.A = 'changed';
    expect(loadDotEnvSync(TEST_DIR)).toBe(0); // 已被幂等闸拦下
    expect(process.env.A).toBe('changed');
  });
});