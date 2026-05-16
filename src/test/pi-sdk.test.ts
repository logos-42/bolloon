import { config } from 'dotenv';
import { describe, it, expect } from 'vitest';
import { createAgentSession } from '../agents/pi-sdk.js';
import { initMinimax } from '../constraints/index.js';
import * as path from 'path';

config();

describe('Pi SDK', () => {
  it('basic agent session', async () => {
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.prompt('简单问候');
    expect(result).toContain('我是一个文档处理智能体');
  });

  it('document analysis', async () => {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      return;
    }
    initMinimax({ apiKey });
    const testFile = path.join(process.cwd(), 'README.md');
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.summarizeDocument(testFile, '测试文档分析');
    expect(result.summary).toBeDefined();
    expect(result.qualityScore).toBeGreaterThan(0);
  });

  it('minimax LLM integration', async () => {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      return;
    }
    initMinimax({ apiKey });
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.prompt('总结: 这是一个测试文档，用于验证LLM摘要功能。人工智能技术正在快速发展，文档智能处理是一个重要的应用场景。');
    expect(result).toBeDefined();
  });
});
