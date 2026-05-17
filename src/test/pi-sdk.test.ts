import { config } from 'dotenv';
import { describe, it, expect } from 'vitest';
import { createAgentSession } from '../agents/pi-sdk.js';
import { initMinimax, getMinimax } from '../constraints/index.js';
import * as path from 'path';

config();

async function isMinimaxAvailable(): Promise<boolean> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) return false;
  try {
    initMinimax({ apiKey });
    const model = getMinimax();
    await model.chat('test');
    return true;
  } catch {
    return false;
  }
}

const skipIfNoLLM = it.skip;

describe('Pi SDK', () => {
  it('basic agent session', async () => {
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.prompt('简单问候');
    expect(result).toContain('我是一个文档处理智能体');
  });

  it('document analysis', async () => {
    const available = await isMinimaxAvailable();
    if (!available) {
      return;
    }
    const testFile = path.join(process.cwd(), 'README.md');
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.summarizeDocument(testFile, '测试文档分析');
    expect(result.summary).toBeDefined();
  });

  it('minimax LLM integration', async () => {
    const available = await isMinimaxAvailable();
    if (!available) {
      return;
    }
    const session = await createAgentSession({ cwd: process.cwd() });
    const result = await session.prompt('总结: 这是一个测试文档，用于验证LLM摘要功能。');
    expect(result).toBeDefined();
  });
});