/**
 * context-collector — 24h 缓存 + mtime 指纹自动失效 (2026-10-15)
 *
 * 对齐 Hermes invalidate_system_prompt: 文档在外改了 → 下一轮使用就是新的,
 * 不用等 24h TTL 或手动 force。核心 = contextFingerprint 对源文件 mtime+size 敏感。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { contextFingerprint } from '../bootstrap/context-collector.js';

let tmp: string;
let home: string;
const origHome = process.env.HOME;
const origAgent = process.env.BOLLOON_ACTIVE_AGENT_ID;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-coll-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-home-'));
  process.env.HOME = home;
  process.env.BOLLOON_ACTIVE_AGENT_ID = '';
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origAgent === undefined) delete process.env.BOLLOON_ACTIVE_AGENT_ID; else process.env.BOLLOON_ACTIVE_AGENT_ID = origAgent;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* 清理失败不影响 */ }
});

describe('contextFingerprint', () => {
  it('稳定: 文件没动 → 指纹不变 (缓存应命中)', async () => {
    const a = await contextFingerprint(tmp);
    const b = await contextFingerprint(tmp);
    expect(a).toBe(b);
  });

  it('项目 Bolloon.md 修改 → 指纹变化 (自动失效)', async () => {
    const f = path.join(tmp, 'Bolloon.md');
    fs.writeFileSync(f, 'v1');
    const a = await contextFingerprint(tmp);
    await new Promise((r) => setTimeout(r, 10)); // mtime 精度
    fs.writeFileSync(f, 'v2 changed');
    const b = await contextFingerprint(tmp);
    expect(b).not.toBe(a);
  });

  it('项目 AGENTS.md 新增 → 指纹变化', async () => {
    const before = await contextFingerprint(tmp);
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# rules');
    const after = await contextFingerprint(tmp);
    expect(after).not.toBe(before);
  });

  it('home 层 ~/.bolloon/Bolloon.md 修改 → 指纹变化', async () => {
    const p = path.join(home, '.bolloon', 'Bolloon.md');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'user rules v1');
    const a = await contextFingerprint(tmp);
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(p, 'user rules v2');
    const b = await contextFingerprint(tmp);
    expect(b).not.toBe(a);
  });

  it('当前 agent persona 文档修改 → 指纹变化 (身份文档自动刷新)', async () => {
    process.env.BOLLOON_ACTIVE_AGENT_ID = 'agent-x';
    const dir = path.join(home, '.bolloon', 'persona', 'agent-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'soul.md'), 'soul v1');
    const a = await contextFingerprint(tmp);
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(path.join(dir, 'soul.md'), 'soul v2');
    const b = await contextFingerprint(tmp);
    expect(b).not.toBe(a);
  });

  it('无任何文件 → 仍返回确定性指纹 (非 null, 防误缓存)', async () => {
    const fp = await contextFingerprint(tmp);
    expect(typeof fp).toBe('string');
    expect(fp.length).toBeGreaterThan(0);
  });
});