/**
 * memory-recall.test.ts — 2026-08-12 (TaskM1)
 *
 * 运行时记忆召回 (hermes prefetch_all 模式):
 *   - tokenizeQuery 提取查询关键词
 *   - scoreSummary 打分
 *   - recallMemory 按用户消息检索历史 memory 摘要, 注入 <memory-context> 围栏
 *   - 无相关记忆/失败 → 返回 ''
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { tokenizeQuery, scoreSummary, recallMemory } from '../agents/memory-recall.js';
import { getMemoryDir, sanitizeKey } from '../bootstrap/memory-compressor.js';

const tmpHome = path.join(os.tmpdir(), 'bolloon-recall-' + Date.now());
const AGENT = 'agent-alice';
const dir = getMemoryDir(AGENT, tmpHome) + '/sessions';

async function writeSummary(channel: string, session: string, content: string) {
  const key = `${sanitizeKey(channel)}__${sanitizeKey(session)}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${key}.summary.md`), content, 'utf-8');
}

describe('memory-recall (运行时记忆召回)', () => {
  beforeEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('tokenizeQuery 提取中英文关键词', () => {
    const t = tokenizeQuery('帮我写一个 orbitdb 数据库同步的代码');
    expect(t.length).toBeGreaterThan(0);
    expect(t).toContain('orbitdb');
  });

  it('scoreSummary 命中关键词得分', () => {
    const t = tokenizeQuery('orbitdb 数据库');
    expect(scoreSummary('实现 orbitdb 数据库同步', t)).toBeGreaterThan(0);
    expect(scoreSummary('无关内容', t)).toBe(0);
  });

  it('recallMemory 按消息召回相关摘要并注入围栏', async () => {
    await writeSummary('ch-a', 's1', '# Session 摘要\n用户问过 orbitdb 数据库怎么同步\n关键回答: 用 WAL 回放合并');
    await writeSummary('ch-b', 's2', '# Session 摘要\n用户聊了天气\n关键回答: 今天晴天');

    const block = await recallMemory({ query: 'orbitdb 数据库同步', agentId: AGENT, homeDir: tmpHome });
    expect(block).toContain('<memory-context>');
    expect(block).toContain('orbitdb');
    expect(block).not.toContain('天气'); // 无关摘要不召回
    expect(block).toContain('非新的用户输入'); // hermes 围栏语义
  });

  it('无相关记忆返回空串', async () => {
    await writeSummary('ch-a', 's1', '# Session 摘要\n聊了天气');
    const block = await recallMemory({ query: '区块链 智能合约 部署', agentId: AGENT, homeDir: tmpHome });
    expect(block).toBe('');
  });

  it('无摘要目录返回空串', async () => {
    const block = await recallMemory({ query: '任意查询', agentId: 'nonexistent', homeDir: tmpHome });
    expect(block).toBe('');
  });

  it('limit 限制召回条数', async () => {
    await writeSummary('a', '1', 'orbitdb 数据库');
    await writeSummary('b', '2', 'orbitdb 数据库 同步');
    await writeSummary('c', '3', 'orbitdb 数据库 同步 算法');
    const block = await recallMemory({ query: 'orbitdb 数据库', agentId: AGENT, homeDir: tmpHome, limit: 2 });
    const count = (block.match(/\[回忆:/g) || []).length;
    expect(count).toBeLessThanOrEqual(2);
  });
});
