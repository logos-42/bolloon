/**
 * persona-loader.ts 单元测试
 * 覆盖: loadPersonaDocs / formatPersonaForSystemPrompt / sanitizeAgentId
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  loadPersonaDocs,
  formatPersonaForSystemPrompt,
  sanitizeAgentId,
  type PersonaDocs,
} from '../bootstrap/persona-loader.js';

const TEST_DIR = path.join(os.tmpdir(), `bolloon-persona-${Date.now()}`);
const AGENT = 'test_agent_001';

beforeAll(async () => {
  await fs.mkdir(path.join(TEST_DIR, '.bolloon', 'persona', AGENT), { recursive: true });
});

afterAll(async () => {
  try { await fs.rm(TEST_DIR, { recursive: true, force: true }); } catch {}
});

describe('sanitizeAgentId', () => {
  it('保留合法字符 [a-zA-Z0-9_-]', () => {
    expect(sanitizeAgentId('agent_33e1fa85')).toBe('agent_33e1fa85');
    expect(sanitizeAgentId('a-b-c')).toBe('a-b-c');
  });
  it('转非法字符为 _', () => {
    expect(sanitizeAgentId('agent/test')).toBe('agent_test');
    expect(sanitizeAgentId('agent.test')).toBe('agent_test');
    expect(sanitizeAgentId('a b c')).toBe('a_b_c');
    // . 也是非法 (按 [^a-zA-Z0-9_-] 排除), 转 _
    expect(sanitizeAgentId('../../etc/passwd')).not.toContain('/');
    expect(sanitizeAgentId('../../etc/passwd')).not.toContain('.');
  });
  it('限制长度 ≤ 64', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeAgentId(long).length).toBe(64);
  });
});

describe('loadPersonaDocs', () => {
  it('6 文件都存在 → 全部字段非空', async () => {
    const dir = path.join(TEST_DIR, '.bolloon', 'persona', AGENT);
    await fs.writeFile(path.join(dir, 'soul.md'), '# Soul\n本地优先\n');
    await fs.writeFile(path.join(dir, 'identity.md'), '# Identity\nDID: did:key:xxx\n');
    await fs.writeFile(path.join(dir, 'project.md'), '# Project\nbolloon\n');
    await fs.writeFile(path.join(dir, 'user.md'), '# User\n开发者\n');
    await fs.writeFile(path.join(dir, 'agent.md'), '# Agent\nmeta\n');
    await fs.writeFile(path.join(dir, 'wiki.md'), '# Wiki\n认知图\n');

    const docs = await loadPersonaDocs(AGENT, TEST_DIR);
    expect(docs.agentId).toBe(AGENT);
    expect(docs.soul).toContain('本地优先');
    expect(docs.identity).toContain('did:key:xxx');
    expect(docs.project).toContain('bolloon');
    expect(docs.user).toContain('开发者');
    expect(docs.agent).toContain('meta');
    expect(docs.wiki).toContain('认知图');
  });

  it('部分文件缺失 → 缺失字段空字符串, 不抛错', async () => {
    const subAgent = 'partial_agent';
    const dir = path.join(TEST_DIR, '.bolloon', 'persona', subAgent);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'identity.md'), '# Identity\nonly this\n');

    const docs = await loadPersonaDocs(subAgent, TEST_DIR);
    expect(docs.identity).toContain('only this');
    expect(docs.soul).toBe('');
    expect(docs.project).toBe('');
    expect(docs.user).toBe('');
    expect(docs.agent).toBe('');
    expect(docs.wiki).toBe('');
  });

  it('目录完全不存在 → 全部字段空字符串', async () => {
    const docs = await loadPersonaDocs('nonexistent_agent_xyz', TEST_DIR);
    expect(docs.agentId).toBe('nonexistent_agent_xyz');
    expect(docs.soul).toBe('');
    expect(docs.identity).toBe('');
    expect(docs.project).toBe('');
    expect(docs.user).toBe('');
    expect(docs.agent).toBe('');
    expect(docs.wiki).toBe('');
  });

  it('agentId 含路径穿越字符 → 安全处理', async () => {
    // agentId "agent/test/../etc" 应被 sanitize 成 "agent_test_.._etc"
    // 不会真的逃逸到 /etc 读文件
    const docs = await loadPersonaDocs('../../../etc/passwd', TEST_DIR);
    expect(docs.agentId).not.toContain('/');
    expect(docs.agentId).not.toContain('..');
    // 所有字段空 (实际没这路径)
    expect(docs.soul).toBe('');
  });
});

describe('formatPersonaForSystemPrompt', () => {
  const baseDocs: PersonaDocs = {
    agentId: 'test',
    soul: '本地优先 / 隐私优先',
    identity: 'DID: did:key:abc',
    project: 'bolloon project',
    user: '开发者',
    agent: 'meta info',
    wiki: '认知图',
  };

  it('6 段全部输出, 顺序 identity → soul → project → user → agent → wiki', () => {
    const out = formatPersonaForSystemPrompt(baseDocs);
    const idIdx = out.indexOf('## Identity');
    const soulIdx = out.indexOf('## Soul');
    const projectIdx = out.indexOf('## Project');
    const userIdx = out.indexOf('## User');
    const agentIdx = out.indexOf('## Agent');
    const wikiIdx = out.indexOf('## Wiki');
    expect(idIdx).toBeGreaterThan(0);
    expect(soulIdx).toBeGreaterThan(idIdx);
    expect(projectIdx).toBeGreaterThan(soulIdx);
    expect(userIdx).toBeGreaterThan(projectIdx);
    expect(agentIdx).toBeGreaterThan(userIdx);
    expect(wikiIdx).toBeGreaterThan(agentIdx);
    expect(out).toContain('Persona (agentId=test)');
  });

  it('空字段跳过, 不输出空段', () => {
    const docs: PersonaDocs = { ...baseDocs, soul: '', project: '' };
    const out = formatPersonaForSystemPrompt(docs);
    expect(out).not.toContain('## Soul');
    expect(out).not.toContain('## Project');
    expect(out).toContain('## Identity');
  });

  it('全部字段空 → 返回空字符串', () => {
    const empty: PersonaDocs = { agentId: 'x', soul: '', identity: '', project: '', user: '', agent: '', wiki: '' };
    expect(formatPersonaForSystemPrompt(empty)).toBe('');
  });

  it('maxChars 限制: 输出 ≤ maxChars 字符', () => {
    const out = formatPersonaForSystemPrompt(baseDocs, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out).toContain('截断');
  });

  it('maxChars 默认 4000', () => {
    const longDocs: PersonaDocs = { ...baseDocs, wiki: 'x'.repeat(10000) };
    const out = formatPersonaForSystemPrompt(longDocs);
    expect(out.length).toBeLessThanOrEqual(4000);
  });
});